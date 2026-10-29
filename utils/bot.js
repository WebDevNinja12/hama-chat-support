const db = require('../db');
const documents = require('./documents');
const instructions = require('./instructions');

const COMPLAINT_PHRASES = [
  'complaint', 'complain', 'damage', 'damaged', 'poor work', 'bad job',
  'unhappy', 'not happy', 'disappointed', 'refund', 'dispute',
  'ruined', 'messed up', 'terrible service', 'awful', 'scam'
];

const HUMAN_PHRASES = [
  'talk to a person', 'talk to person', 'speak to a person', 'speak to someone',
  'real person', 'human agent', 'human please', 'agent please',
  'talk to agent', 'speak to agent', 'talk to human', 'speak to human',
  'operator', 'manager'
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
  return new Set(normalize(text).split(' ').filter(w => w.length > 2));
}

function isComplaint(msg) {
  const m = normalize(msg);
  return COMPLAINT_PHRASES.some(p => m.includes(p));
}

function wantsHuman(msg) {
  const m = normalize(msg);
  if (HUMAN_PHRASES.some(p => m.includes(p))) return true;
  if (/\b(human|operator|manager)\b/.test(m)) return true;
  return false;
}

function onlineAgentCount() {
  return db.prepare(
    `SELECT COUNT(*) as c FROM users WHERE online = 1 AND role IN ('admin','agent')`
  ).get().c;
}

function workingHoursText() {
  return getSetting('working_hours') || 'Monday - Saturday: 8:00 AM - 6:00 PM WAT';
}

/** Honest handover copy based on whether an agent is signed in */
function handoverMessage() {
  const n = onlineAgentCount();
  if (n > 0) {
    return {
      message: "I'm passing you to our customer service team. Please stay on this chat.",
      agentsOnline: true,
      widgetStatus: 'Waiting for an agent'
    };
  }
  return {
    message: `Our team is offline right now. We have your details and will reply as soon as we're back (working hours: ${workingHoursText()}).`,
    agentsOnline: false,
    widgetStatus: 'Team offline — we will reply later'
  };
}

function findBestKbMatch(userMessage) {
  const msg = normalize(userMessage);
  if (!msg || msg.length < 2) return null;

  const msgWords = wordSet(msg);
  const entries = db.prepare(
    'SELECT * FROM knowledge_base WHERE active = 1 ORDER BY priority DESC'
  ).all();

  let best = null;
  let bestScore = 0;
  const scored = [];

  for (const entry of entries) {
    let score = 0;
    const keywords = (entry.keywords || '')
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    for (const kw of keywords) {
      if (msg.includes(kw)) {
        score += kw.length > 6 ? 5 : kw.length > 3 ? 4 : 3;
        continue;
      }
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
      if (qWords.length) score += (qHits / qWords.length) * 4;
    }

    score += (entry.priority || 0) * 0.05;
    scored.push({ entry, score });
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { best: bestScore >= 1.5 ? best : null, bestScore, scored };
}

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
        if (msgWords.has(p) || msg.includes(p)) return entry;
      }
      if (kw.length > 3 && msg.includes(kw)) return entry;
    }
  }
  return null;
}

/** Two close topics → clarifying quick replies */
function clarifyingFromScores(scored, msg) {
  const short = msg.trim().split(/\s+/).length <= 4;
  if (!scored || scored.length < 2) return null;
  const a = scored[0];
  const b = scored[1];
  if (a.score < 1.2 || b.score < 1.0) return null;
  // Nearly equal scores, or very short question with two decent matches
  if (a.score - b.score > 1.5 && !short) return null;
  if (a.score < 1.5 && !short) return null;

  const label = (e) =>
    (e.question && e.question.replace(/\?$/, '').slice(0, 40)) ||
    e.category ||
    'Option';

  return {
    type: 'clarify',
    message: `Did you mean: ${label(a.entry)} or ${label(b.entry)}?`,
    quickReplies: [label(a.entry), label(b.entry)],
    source: null
  };
}

function countRecentMisses(chatHistory) {
  let misses = 0;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (
      m.sender_type === 'bot' &&
      /rephrase|not sure|don't have|do not have|could you clarify|Did you mean/i.test(m.content || '')
    ) {
      misses++;
    } else if (m.sender_type === 'customer') {
      continue;
    } else break;
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
    companyFacts: companyFacts(),
    companyName: getSetting('company_name') || 'Hama Enterprise Ng'
  });

  if (ai && ai.text && !ai.noAnswer) {
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
    // Complaints: acknowledge, then handover (no argument, no refund promise)
    if (isComplaint(userMessage)) {
      const hand = handoverMessage();
      return {
        type: 'complaint',
        isComplaint: true,
        complaintMessage: userMessage,
        messages: [
          "I'm sorry about this. I understand your concern and I want it handled properly.",
          hand.message
        ],
        agentsOnline: hand.agentsOnline,
        widgetStatus: hand.widgetStatus,
        reason: 'complaint'
      };
    }

    if (wantsHuman(userMessage)) {
      const hand = handoverMessage();
      return {
        type: 'escalate',
        message: hand.message,
        agentsOnline: hand.agentsOnline,
        widgetStatus: hand.widgetStatus,
        reason: 'requested_human'
      };
    }

    const kbResult = findBestKbMatch(userMessage);
    const clarify = clarifyingFromScores(kbResult.scored, userMessage);
    // Only clarify when no clear single winner
    if (clarify && !kbResult.best) {
      return clarify;
    }
    if (clarify && kbResult.scored[0] && kbResult.scored[1] &&
        Math.abs(kbResult.scored[0].score - kbResult.scored[1].score) < 0.8) {
      return clarify;
    }

    if (kbResult.best) {
      return {
        type: 'answer',
        message: kbResult.best.answer,
        source: kbResult.best.question || kbResult.best.category || 'Q&A',
        sourceType: 'qa',
        usedAi: false,
        quickReplies: getQuickReplies()
      };
    }

    const docAnswer = await answerFromDocuments(userMessage, chatHistory);
    if (docAnswer.type === 'answer') return docAnswer;

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
      const hand = handoverMessage();
      return {
        type: 'escalate',
        message: hand.message,
        agentsOnline: hand.agentsOnline,
        widgetStatus: hand.widgetStatus,
        reason: 'two_misses'
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
      message: 'Sorry, something went wrong. Please try again or say "Talk to a person".',
      quickReplies: ['Talk to a person', 'Our services']
    };
  }
}

async function testQuestion(question) {
  const reply = await getBotReply(question, []);
  let verdict = 'would ask to rephrase';
  if (reply.type === 'escalate' || reply.type === 'complaint') verdict = 'would hand to a person';
  else if (reply.type === 'answer') verdict = 'would answer';
  else if (reply.type === 'clarify') verdict = 'would ask to clarify';

  const search = documents.searchDocuments(question, { minCoverage: 0.35 });
  return {
    verdict,
    answer: reply.message || (reply.messages && reply.messages.join(' ')) || null,
    source: reply.source || null,
    sourceType: reply.sourceType || null,
    usedAi: !!reply.usedAi,
    reason: reply.reason || null,
    agentsOnline: reply.agentsOnline,
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
  testQuestion,
  companyFacts,
  handoverMessage,
  isComplaint,
  wantsHuman,
  onlineAgentCount,
  instructions
};
