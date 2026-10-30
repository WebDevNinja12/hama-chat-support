/**
 * Backup / restore / CSV export using zlib zip (no native deps).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../db');
const store = require('./store_extra');

function dataDir() {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

function snapshot() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    chats: db.prepare('SELECT * FROM chats').all(),
    messages: db.prepare('SELECT * FROM messages').all(),
    knowledge_base: db.prepare('SELECT * FROM knowledge_base').all(),
    settings: db.prepare('SELECT * FROM settings').all(),
    documents: db.prepare('SELECT id, title, kind, filename, text_content, char_count, word_count, created_at FROM documents').all(),
    leads: store.listLeads({}),
    callbacks: store.listCallbacks(),
    canned_replies: db.prepare('SELECT * FROM canned_replies').all(),
    unanswered: db.prepare('SELECT * FROM unanswered').all(),
    ratings: db.prepare('SELECT * FROM ratings').all()
  };
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) {
    lines.push(columns.map(c => esc(r[c])).join(','));
  }
  return lines.join('\n');
}

function chatsCsv() {
  const rows = db.prepare('SELECT * FROM chats ORDER BY created_at DESC').all().map(c => ({
    name: c.customer_name,
    contact: c.customer_contact,
    date: c.created_at,
    status: c.status,
    summary: c.complaint_preview || c.agent_name || ''
  }));
  return toCsv(rows, ['name', 'contact', 'date', 'status', 'summary']);
}

function leadsCsv() {
  const rows = store.listLeads({}).map(l => ({
    name: l.name,
    contact: l.contact,
    date: l.created_at,
    status: l.status,
    summary: [l.service, l.property_type, l.location].filter(Boolean).join(' / ')
  }));
  return toCsv(rows, ['name', 'contact', 'date', 'status', 'summary']);
}

/** Minimal zip: store one file as gzip-json with .hama-backup.json.gz extension handled by caller */
function buildBackupBuffer() {
  const json = JSON.stringify(snapshot(), null, 2);
  return zlib.gzipSync(Buffer.from(json, 'utf8'));
}

function restoreFromBuffer(buf) {
  let json;
  try {
    json = zlib.gunzipSync(buf).toString('utf8');
  } catch {
    json = buf.toString('utf8');
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { error: 'Invalid backup file' };
  }
  if (!data || data.version !== 1 || !Array.isArray(data.chats)) {
    return { error: 'Backup format not recognised' };
  }

  // Replace core data carefully
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM chats');
  db.exec('DELETE FROM knowledge_base');
  try { db.exec('DELETE FROM leads'); } catch (_) {}
  try { db.exec('DELETE FROM callbacks'); } catch (_) {}

  const insChat = db.prepare(`INSERT OR REPLACE INTO chats (id, customer_name, customer_contact, contact_type, status, agent_id, agent_name, is_complaint, complaint_preview, created_at, updated_at)
    VALUES (@id, @customer_name, @customer_contact, @contact_type, @status, @agent_id, @agent_name, @is_complaint, @complaint_preview, @created_at, @updated_at)`);
  for (const c of data.chats) {
    try {
      insChat.run({
        id: c.id,
        customer_name: c.customer_name,
        customer_contact: c.customer_contact,
        contact_type: c.contact_type,
        status: c.status,
        agent_id: c.agent_id,
        agent_name: c.agent_name,
        is_complaint: c.is_complaint || 0,
        complaint_preview: c.complaint_preview || null,
        created_at: c.created_at,
        updated_at: c.updated_at
      });
    } catch (_) {}
  }

  const insMsg = db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content, is_internal, source_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const m of data.messages || []) {
    try {
      insMsg.run(m.chat_id, m.sender_type, m.sender_name, m.content, m.is_internal || 0, m.source_label || null, m.created_at);
    } catch (_) {}
  }

  if (Array.isArray(data.knowledge_base)) {
    const insKb = db.prepare(`INSERT INTO knowledge_base (category, keywords, question, answer, priority, active) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const k of data.knowledge_base) {
      try {
        insKb.run(k.category, k.keywords, k.question, k.answer, k.priority || 0, k.active == null ? 1 : k.active);
      } catch (_) {}
    }
  }

  if (Array.isArray(data.settings)) {
    const insS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const s of data.settings) {
      try { insS.run(s.key, s.value); } catch (_) {}
    }
  }

  return { success: true, chats: data.chats.length, messages: (data.messages || []).length };
}

module.exports = {
  snapshot,
  buildBackupBuffer,
  restoreFromBuffer,
  chatsCsv,
  leadsCsv,
  toCsv,
  dataDir
};
