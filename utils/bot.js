const db = require('../db');
const documents = require('./documents');

/**
 * Answer order:
 * 1) Clear request for a human / serious complaint → escalate
 * 2) Admin Q&A knowledge base
 * 3) Uploaded documents / notes
 * 4) Ask to rephrase; after 2 misses → escalate
 * Never invent prices or promises.
 */

// Only escalate when the visitor clearly wants a person or reports a serious problem.
// Do NOT escalate normal questions about quotes, painting, inspection, hours, payment process.
const ESCALATION_PHRASES = [
  'talk to a person', 'talk to person', 'speak to a person', 'speak to someone',
  'real person', 'human agent', 'human please', 'customer please',
  'talk to agent', 'speak to agent', 'talk to human', 'speak to human',
  'complaint', 'complain', 'i am not satisfied', 'not satisfied',
  'refund', 'damaged', 'damage to', 'lawsuit', 'legal action',
  'payment dispute', 'wrong charge', 'scam'
];

const ESCALATION_WORDS = [
  'human', 'operator', 'manager', 'frustrated', 'terrible', 'useless'
];

const FRUSTRATION_PATTERNS = [
  /not helping/i, /don't understand/i, /wrong answer/i,
  /already told you/i, /same thing again/i
];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text) {
  return new Set(
    normalize(text)
      .split(' ')
      .filter(w => w.length > 2)
  );
}

/**
 * Match admin Q&A entries more generously:
 * - full keyword phrases in the message
 * - individual keyword words
 * - overlap with the stored question
 */
function findBestKbMatch(userMessage) {
  const msg = normalize(userMessage);
  if (!msg || msg.length < 2) return null;

  const msgWords = wordSet(msg);
  const entries = db.prepare(
    'SELECT * FROM knowledge_base WHERE active = 1 ORDER BY priority DESC'
  ).all();

  let best = null;
  let bestScore = 0;

  for (const entry of entries) {
    let score = 0;
    const keywords = (entry.keywords || '')
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    for (const kw of keywords) {
      if (!kw) continue;
      // Full phrase match (strong)
      if (msg.includes(kw)) {
        score += kw.length > 6 ? 5 : kw.length > 3 ? 4 : 3;
        continue;
      }
      // Each word in multi-word keyword
      const parts = kw.split(/\s+/).filter(p => p.length > 2);
      let partHits = 0;
      for (const p of parts) {
        if (msgWords.has(p) || msg.includes(p)) partHits++;
      }
      if (parts.length && partHits === parts.length) score += 3;
      else if (partHits > 0) score += partHits;
    }

    if (entry.question) {
      const qWords = [...wordSet(entry.question)];
      let qHits = 0;
      for (const qw of qWords) {
        if (msgWords.has(qw) || msg.includes(qw)) qHits++;
      }
      if (qWords.length) {
        const ratio = qHits / qWords.length;
        score += ratio * 4;
      }
    }

    // Light boost from priority
    score += (entry.priority || 0) * 0.05;

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  // Lower threshold so common questions like "services", "hours", "quote" match
  if (bestScore < 1.5) return null;
  return best;
}

function shouldEscalate(userMessage, chatHistory = []) {
  const msg = normalize(userMessage);

  for (const phrase of ESCALATION_PHRASES) {
    if (msg.includes(phrase)) {
      return { escalate: true, reason: 'requested_human_or_serious' };
    }
  }
  for (const w of ESCALATION_WORDS) {
    // whole word-ish check
    if (new RegExp('\\b' + w + '\\b').test(msg)) {
      return { escalate: true, reason: 'requested_human_or_serious' };
    }
  }
  for (const pat of FRUSTRATION_PATTERNS) {
    if (pat.test(userMessage)) {
      return { escalate: true, reason: 'frustration' };
    }
  }

  // Same message repeated twice in a row
  const recentCustomer = chatHistory
    .filter(m => m.sender_type === 'customer')
    .slice(-3)
    .map(m => normalize(m.content));
  if (recentCustomer.length >= 2) {
    const last = recentCustomer[recentCustomer.length - 1];
    const prev = recentCustomer[recentCustomer.length - 2];
    if (last && prev && last === prev) {
      return { escalate: true, reason: 'repeated_message' };
    }
  }
  return { escalate: false };
}

function countRecentMisses(chatHistory) {
  let misses = 0;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (
      m.sender_type === 'bot' &&
      /rephrase|not sure|don't have|do not have|could you clarify|no confident answer/i.test(m.content || '')
    ) {
      misses++;
    } else if (m.sender_type === 'customer') {
      continue;
    } else {
      break;
    }
  }
  return misses;
}

function companyFacts() {
  const name = getSetting('company_name') || 'Hama Enterprise Ng';
  const hours = getSetting('working_hours') || '';
  const email = getSetting('contact_email') || '';
  const phone = getSetting('contact_phone') || '';
  return [name + ' (RC 8827959)', hours, email, phone].filter(Boolean).join('. ');
}

async function answerFromDocuments(userMessage, chatHistory = []) {
  let searchQ = userMessage;
  // Lower coverage so short questions can still match notes/docs
  let result = documents.searchDocuments(searchQ, { minCoverage: 0.35, topK: 4 });

  if (!result.confident && userMessage.trim().split(/\s+/).length <= 10) {
    const prev = [...chatHistory]
      .reverse()
      .find(m => m.sender_type === 'customer' && m.content !== userMessage);
    if (prev) {
      searchQ = prev.content + ' ' + userMessage;
      result = documents.searchDocuments(searchQ, { minCoverage: 0.3, topK: 4 });
    }
  }

  // Also accept a strong top score even if coverage is a bit lower
  if (!result.confident && result.debug && result.debug[0] && result.debug[0].matchPercent >= 40) {
    const soft = documents.searchDocuments(searchQ, { minCoverage: 0.25, topK: 4 });
    if (soft.hits && soft.hits.length) {
      result = soft;
      result.confident = true;
    }
  }

  if (!result.confident || !result.hits || !result.hits.length) {
    return { type: 'miss', debug: result.debug };
  }

  const topPassages = result.hits.slice(0, 4).map(h => ({
    title: h.title,
    text: h.text,
    docId: h.docId,
    coverage: h.coverage
  }));

  const ai = await documents.aiAnswer({
    question: userMessage,
    history: chatHistory,
    passages: topPassages,
    companyFacts: companyFacts()
  });

  if (ai && ai.noAnswer) {
    // Still quote the document instead of giving up
  } else if (ai && ai.text) {
    return {
      type: 'answer',
      message: ai.text,
      source: topPassages[0].title,
      sourceType: 'document',
      usedAi: true,
      quickReplies: getQuickReplies()
    };
  }

  const quotes = topPassages
    .slice(0, 2)
    .map(p => documents.quotePassage(p.text, 3))
    .filter(Boolean);
  const message = quotes.join(' ') || topPassages[0].text.slice(0, 500);

  return {
    type: 'answer',
    message,
    source: topPassages[0].title,
    sourceType: 'document',
    usedAi: false,
    quickReplies: getQuickReplies()
  };
}

async function getBotReply(userMessage, chatHistory = []) {
  try {
    // 1) Escalate only for clear human / serious issues
    const escalation = shouldEscalate(userMessage, chatHistory);
    if (escalation.escalate) {
      return {
        type: 'escalate',
        reason: escalation.reason,
        message: 'A support agent will join shortly. Please hold on...'
      };
    }

    // 2) Q&A you added in Admin
    const kb = findBestKbMatch(userMessage);
    if (kb) {
      return {
        type: 'answer',
        message: kb.answer,
        source: kb.question || kb.category || 'Q&A',
        sourceType: 'qa',
        matchedCategory: kb.category,
        usedAi: false,
        quickReplies: getQuickReplies()
      };
    }

    // 3) Documents / notes you uploaded
    const docAnswer = await answerFromDocuments(userMessage, chatHistory);
    if (docAnswer.type === 'answer') return docAnswer;

    // 4) Soft fallback: if any KB entry shares at least one strong keyword word, use it
    const soft = findSoftKbMatch(userMessage);
    if (soft) {
      return {
        type: 'answer',
        message: soft.answer,
        source: soft.question || soft.category || 'Q&A',
        sourceType: 'qa',
        usedAi: false,
        quickReplies: getQuickReplies()
      };
    }

    const misses = countRecentMisses(chatHistory);
    if (misses >= 1) {
      return {
        type: 'escalate',
        reason: 'two_misses',
        message:
          "I'm still not finding the right information. A support agent will join shortly to help you."
      };
    }

    return {
      type: 'miss',
      message:
        "I don't have a clear answer for that yet. You can ask about our services, areas we serve, working hours, or how to get a quote — or say \"Talk to a person\" to reach an agent.",
      quickReplies: getQuickReplies()
    };
  } catch (err) {
    console.error('getBotReply error', err);
    return {
      type: 'miss',
      message:
        'Sorry, something went wrong on my side. Please try again or say "Talk to a person".',
      quickReplies: ['Talk to a person', 'Our services']
    };
  }
}

/** Last-resort KB match: any single meaningful keyword word */
function findSoftKbMatch(userMessage) {
  const msg = normalize(userMessage);
  const msgWords = wordSet(msg);
  const entries = db.prepare(
    'SELECT * FROM knowledge_base WHERE active = 1 ORDER BY priority DESC'
  ).all();

  for (const entry of entries) {
    const keywords = (entry.keywords || '').split(',').map(k => k.trim().toLowerCase());
    for (const kw of keywords) {
      const parts = kw.split(/\s+/).filter(p => p.length > 3);
      for (const p of parts) {
        if (msgWords.has(p) || msg.includes(p)) {
          return entry;
        }
      }
      if (kw.length > 3 && msg.includes(kw)) return entry;
    }
  }
  return null;
}

async function testQuestion(question) {
  const reply = await getBotReply(question, []);
  let verdict = 'would ask to rephrase';
  if (reply.type === 'escalate') verdict = 'would hand to a person';
  else if (reply.type === 'answer') verdict = 'would answer';

  const search = documents.searchDocuments(question, { minCoverage: 0.35 });
  return {
    verdict,
    answer: reply.message || null,
    source: reply.source || null,
    sourceType: reply.sourceType || null,
    usedAi: !!reply.usedAi,
    reason: reply.reason || null,
    topPassages: (search.debug || []).map(d => ({
      title: d.title,
      matchPercent: d.coverage,
      snippet: d.snippet
    })),
    hint: reply.type === 'answer' ? null : 'Add a Q&A entry or document that covers this topic.'
  };
}

function getGreeting() {
  return (
    getSetting('greeting') ||
    'Welcome to Hama Enterprise Ng Support! Ask about painting, interior or exterior design, quotes, or our working hours.'
  );
}

function getQuickReplies() {
  return ['Get a quote', 'Our services', 'Working hours', 'Talk to a person'];
}

module.exports = {
  getBotReply,
  getGreeting,
  getQuickReplies,
  getSetting,
  findBestKbMatch,
  shouldEscalate,
  testQuestion,
  companyFacts
};
