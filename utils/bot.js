const db = require('../db');

/**
 * Simple keyword/intent matching bot.
 * Only answers from knowledge base. Never invents prices or promises.
 */

const ESCALATION_KEYWORDS = [
  'human', 'agent', 'person', 'talk to', 'speak to', 'real person', 'operator',
  'manager', 'complaint', 'complain', 'angry', 'frustrated', 'terrible',
  'contract', 'payment', 'pay', 'invoice', 'refund', 'inspection', 'site visit',
  'custom price', 'negotiate', 'discount', 'urgent', 'asap', 'immediately'
];

const FRUSTRATION_PATTERNS = [
  /not helping/i, /useless/i, /stupid/i, /don't understand/i, /wrong answer/i,
  /again/i, /already told/i, /repeat/i, /same thing/i
];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function normalize(text) {
  return (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findBestMatch(userMessage) {
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
      if (msg.includes(kw)) {
        score += kw.length > 4 ? 3 : 2;
      }
      const words = msg.split(' ');
      for (const w of words) {
        if (w.length > 3 && kw.includes(w)) score += 1;
      }
    }

    if (entry.question) {
      const qWords = normalize(entry.question).split(' ');
      for (const qw of qWords) {
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
    if (msg.includes(kw)) return { escalate: true, reason: 'customer_requested_human' };
  }

  for (const pat of FRUSTRATION_PATTERNS) {
    if (pat.test(userMessage)) return { escalate: true, reason: 'frustration_detected' };
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

function getBotReply(userMessage, chatHistory = []) {
  const escalation = shouldEscalate(userMessage, chatHistory);
  if (escalation.escalate) {
    return {
      type: 'escalate',
      reason: escalation.reason,
      message: 'A support agent will join shortly. Please hold on...'
    };
  }

  const match = findBestMatch(userMessage);
  if (match) {
    return {
      type: 'answer',
      message: match.answer,
      matchedCategory: match.category,
      quickReplies: ['Get a quote', 'Our services', 'Talk to a person']
    };
  }

  return {
    type: 'escalate',
    reason: 'no_confident_answer',
    message: "I'm not sure I have the right information for that. A support agent will join shortly to help you better."
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
  findBestMatch,
  shouldEscalate
};
