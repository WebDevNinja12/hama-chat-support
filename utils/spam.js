/**
 * Spam / abuse protection: honeypot, timing, rate limits, blocks.
 */
const fs = require('fs');
const path = require('path');

const MAX_MSG_LEN = parseInt(process.env.MAX_MESSAGE_LENGTH || '2000', 10);
const MAX_CHATS_PER_IP_HOUR = parseInt(process.env.MAX_CHATS_PER_IP_HOUR || '10', 10);
const MAX_MSGS_PER_CHAT_MIN = parseInt(process.env.MAX_MSGS_PER_CHAT_MIN || '30', 10);
const MIN_FORM_MS = parseInt(process.env.MIN_FORM_MS || '2500', 10);

function dataDir() {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

function storePath() {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'spam_state.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return { ipChats: {}, ipMsgs: {}, chatMsgs: {}, lastMsg: {}, blocks: {} };
  }
}

function save(s) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(s));
  } catch (_) {}
}

function stripControl(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function sanitizeMessage(text) {
  let t = stripControl(text);
  if (t.length > MAX_MSG_LEN) t = t.slice(0, MAX_MSG_LEN);
  return t;
}

function isBlocked(key) {
  const s = load();
  const until = s.blocks[key];
  if (!until) return false;
  if (Date.now() > until) {
    delete s.blocks[key];
    save(s);
    return false;
  }
  return true;
}

function blockVisitor(key, hours = 24) {
  const s = load();
  s.blocks[key] = Date.now() + hours * 60 * 60 * 1000;
  save(s);
  return { until: s.blocks[key] };
}

function checkHoneypotAndTiming(data) {
  // Hidden field must be empty
  if (data && data.website) {
    return { ok: false, error: 'Submission rejected.' };
  }
  const started = parseInt(data && data.formStartedAt, 10);
  if (started && Date.now() - started < MIN_FORM_MS) {
    return { ok: false, error: 'Please wait a moment and try again.' };
  }
  return { ok: true };
}

function checkNewChat(ip) {
  if (!ip) return { ok: true };
  if (isBlocked(ip)) return { ok: false, error: 'Access temporarily limited. Please try later.' };
  const s = load();
  const hour = new Date().toISOString().slice(0, 13);
  const key = ip + ':' + hour;
  s.ipChats[key] = (s.ipChats[key] || 0) + 1;
  // prune
  for (const k of Object.keys(s.ipChats)) {
    if (!k.endsWith(hour)) delete s.ipChats[k];
  }
  save(s);
  if (s.ipChats[key] > MAX_CHATS_PER_IP_HOUR) {
    return { ok: false, error: 'Too many chats from your network. Please try again later.' };
  }
  return { ok: true };
}

function checkMessage(chatId, ip, content) {
  const cleaned = sanitizeMessage(content);
  if (!cleaned) return { ok: false, error: 'Message is empty.', content: cleaned };

  const blockKey = ip || chatId;
  if (isBlocked(blockKey) || (chatId && isBlocked(chatId))) {
    return { ok: false, error: 'Messaging is temporarily limited.', content: cleaned };
  }

  const s = load();
  const minKey = chatId + ':' + Math.floor(Date.now() / 60000);
  s.chatMsgs[minKey] = (s.chatMsgs[minKey] || 0) + 1;
  if (s.chatMsgs[minKey] > MAX_MSGS_PER_CHAT_MIN) {
    save(s);
    return { ok: false, error: 'You are sending messages too quickly. Please slow down.', content: cleaned };
  }

  const last = s.lastMsg[chatId];
  if (last && last === cleaned) {
    return { ok: false, error: 'Please avoid sending the same message repeatedly.', content: cleaned, duplicate: true };
  }
  s.lastMsg[chatId] = cleaned;
  save(s);
  return { ok: true, content: cleaned };
}

module.exports = {
  checkHoneypotAndTiming,
  checkNewChat,
  checkMessage,
  sanitizeMessage,
  stripControl,
  isBlocked,
  blockVisitor,
  MAX_MSG_LEN,
  MIN_FORM_MS
};
