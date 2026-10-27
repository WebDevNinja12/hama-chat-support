const db = require('../db');
const documents = require('./documents');

/**
 * Bot answering order:
 * a) Escalate on human request / serious topics / frustration
 * b) Match admin Q&A knowledge_base (exact-ish answers)
 * c) Search uploaded documents (BM25 + optional AI)
 * d) Ask to rephrase; after 2 misses escalate
 *
 * Never invents prices or promises.
 */

const ESCALATION_KEYWORDS = [
  'human', 'agent', 'person', 'talk to', 'speak to', 'real person', 'operator',
  'manager', 'complaint', 'complain', 'angry', 'frustrated', 'terrible',
  'contract', 'refund', 'damage', 'damaged', 'payment dispute', 'dispute',
  'inspection', 'site visit', 'negotiate', 'negotiation', 'discount',
  'urgent', 'asap', 'immediately', 'lawsuit', 'legal'
];

const FRUSTRATION_PATTERNS = [
  /not helping/i, /useless/i, /stupid/i, /don't understand/i, /wrong answer/i,
  /already told/i, /same thing/i
];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findBestKbMatch(userMessage) {
  const msg = normalize(userMessage);
  if (!msg || msg.length < 2) return null;

  const entries = db.prepare(
    'SELECT * FROM knowledge_base WHERE active = 1 ORDER BY priority DESC'
  ).all();

  let best = null;
  let bestScore = 0;

  for (const entry of entries) {
    const keywords = entry.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    let score = 0;
    for (const kw of keywords) {
      if (msg.includes(kw)) score += kw.length > 4 ? 3 : 2;
    }
    if (entry.question) {
      for (const qw of normalize(entry.question).split(' ')) {
        if (qw.length > 3 && msg.includes(qw)) score += 1;
      }
    }
    score += (entry.priority || 0) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (bestScore < 2) return null;
  return best;
}

function shouldEscalate(userMessage, chatHistory = []) {
  const msg = normalize(userMessage);

  for (const kw of ESCALATION_KEYWORDS) {
    if (msg.includes(kw)) return { escalate: true, reason: 'serious_or_human' };
  }
  for (const pat of FRUSTRATION_PATTERNS) {
    if (pat.test(userMessage)) return { escalate: true, reason: 'frustration' };
  }

  const recentCustomer = chatHistory
    .filter(m => m.sender_type === 'customer')
    .slice(-3)
    .map(m => normalize(m.content));
  if (recentCustomer.length >= 2) {
    const last = recentCustomer[recentCustomer.length - 1];
    const prev = recentCustomer[recentCustomer.length - 2];
    if (last && prev && (last === prev || last.includes(prev) || prev.includes(last))) {
      return { escalate: true, reason: 'repeated_message' };
    }
  }
  return { escalate: false };
}

function countRecentMisses(chatHistory) {
  // Count consecutive bot "rephrase" style messages at the end
  let misses = 0;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (m.sender_type === 'bot' && /rephrase|not sure|don't have|do not have|could you clarify/i.test(m.content || '')) {
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
  let result = documents.searchDocuments(searchQ);

  // Short follow-up: borrow previous customer question if this alone fails
  if (!result.confident && userMessage.trim().split(/\s+/).length <= 8) {
    const prev = [...chatHistory].reverse().find(m => m.sender_type === 'customer' && m.content !== userMessage);
    if (prev) {
      searchQ = prev.content + ' ' + userMessage;
      result = documents.searchDocuments(searchQ);
    }
  }

  if (!result.confident) {
    return { type: 'miss', debug: result.debug };
  }

  const topPassages = result.hits.slice(0, 4).map(h => ({
    title: h.title,
    text: h.text,
    docId: h.docId,
    coverage: h.coverage
  }));

  // Optional AI
  const ai = await documents.aiAnswer({
    question: userMessage,
    history: chatHistory,
    passages: topPassages,
    companyFacts: companyFacts()
  });

  if (ai && ai.noAnswer) {
    return { type: 'miss', debug: result.debug };
  }

  if (ai && ai.text) {
    return {
      type: 'answer',
      message: ai.text,
      source: topPassages[0].title,
      sourceType: 'document',
      usedAi: true,
      quickReplies: ['Get a quote', 'Our services', 'Talk to a person']
    };
  }

  // Quote 1–3 sentences from best passage(s)
  const quotes = topPassages.slice(0, 2).map(p => documents.quotePassage(p.text, 2)).filter(Boolean);
  const message = quotes.join(' ');
  return {
    type: 'answer',
    message: message || topPassages[0].text.slice(0, 400),
    source: topPassages[0].title,
    sourceType: 'document',
    usedAi: false,
    quickReplies: ['Get a quote', 'Our services', 'Talk to a person']
  };
}

async function getBotReply(userMessage, chatHistory = []) {
  // a) Escalate
  const escalation = shouldEscalate(userMessage, chatHistory);
  if (escalation.escalate) {
    return {
      type: 'escalate',
      reason: escalation.reason,
      message: 'A support agent will join shortly. Please hold on...'
    };
  }

  // b) Q&A knowledge base
  const kb = findBestKbMatch(userMessage);
  if (kb) {
    return {
      type: 'answer',
      message: kb.answer,
      source: kb.question || kb.category || 'Q&A',
      sourceType: 'qa',
      matchedCategory: kb.category,
      usedAi: false,
      quickReplies: ['Get a quote', 'Our services', 'Talk to a person']
    };
  }

  // c) Documents
  const docAnswer = await answerFromDocuments(userMessage, chatHistory);
  if (docAnswer.type === 'answer') return docAnswer;

  // d) Rephrase / escalate after 2 misses
  const misses = countRecentMisses(chatHistory);
  if (misses >= 1) {
    return {
      type: 'escalate',
      reason: 'two_misses',
      message: "I'm still not finding the right information. A support agent will join shortly to help you."
    };
  }

  return {
    type: 'miss',
    message: "I don't have a confident answer for that in our documents. Could you rephrase your question, or say \"Talk to a person\" to reach an agent?",
    quickReplies: ['Talk to a person', 'Our services', 'Get a quote']
  };
}

/** Test harness used by admin Documents UI — does not create a chat */
async function testQuestion(question) {
  const history = [];
  const reply = await getBotReply(question, history);

  let verdict = 'would ask to rephrase';
  if (reply.type === 'escalate') verdict = 'would hand to a person';
  else if (reply.type === 'answer') verdict = 'would answer';

  const search = documents.searchDocuments(question);
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
    hint: search.confident ? null : 'Add a document that covers it.'
  };
}

function getGreeting() {
  return getSetting('greeting') || 'Hello! How can we help you today?';
}

function getQuickReplies() {
  return ['Get a quote', 'Our services', 'Talk to a person', 'Working hours'];
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
