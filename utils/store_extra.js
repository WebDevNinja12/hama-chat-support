/**
 * Extra tables on top of existing SQLite db: callbacks, leads, ratings,
 * unanswered questions, canned replies. Optional DATABASE_URL uses same
 * schema via a thin note — primary path remains SQLite in DATA_DIR.
 */
const db = require('../db');

function initExtraTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS callbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      name TEXT,
      phone TEXT,
      best_time TEXT,
      message TEXT,
      status TEXT DEFAULT 'new',
      handled_by INTEGER,
      handled_by_name TEXT,
      last_messages TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      name TEXT,
      contact TEXT,
      service TEXT,
      property_type TEXT,
      location TEXT,
      size_info TEXT,
      preferred_date TEXT,
      notes TEXT,
      status TEXT DEFAULT 'new',
      owner_id INTEGER,
      owner_name TEXT,
      agent_notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message_id INTEGER,
      score INTEGER NOT NULL,
      comment TEXT,
      kind TEXT DEFAULT 'chat',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS unanswered (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      normalized TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      last_asked TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'open',
      sample_chat_id TEXT
    );

    CREATE TABLE IF NOT EXISTS canned_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner_id INTEGER,
      is_shared INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      lead_id INTEGER,
      filename TEXT,
      mime TEXT,
      size INTEGER,
      path TEXT,
      thumb_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_callbacks_status ON callbacks(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_unanswered_norm ON unanswered(normalized)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at)');
  } catch (_) {}
}

initExtraTables();

function normalizeQ(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ---- Callbacks ----
function createCallback(row) {
  const r = db.prepare(`
    INSERT INTO callbacks (chat_id, name, phone, best_time, message, last_messages, status)
    VALUES (?, ?, ?, ?, ?, ?, 'new')
  `).run(
    row.chatId || null,
    row.name || null,
    row.phone || null,
    row.bestTime || null,
    row.message || null,
    row.lastMessages || null
  );
  return db.prepare('SELECT * FROM callbacks WHERE id = ?').get(r.lastInsertRowid);
}

function listCallbacks(status) {
  if (status) {
    return db.prepare('SELECT * FROM callbacks WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
  }
  return db.prepare('SELECT * FROM callbacks ORDER BY created_at DESC LIMIT 200').all();
}

function countNewCallbacks() {
  return db.prepare(`SELECT COUNT(*) as c FROM callbacks WHERE status = 'new'`).get().c;
}

function updateCallback(id, fields) {
  const cur = db.prepare('SELECT * FROM callbacks WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare(`
    UPDATE callbacks SET
      status = COALESCE(?, status),
      handled_by = COALESCE(?, handled_by),
      handled_by_name = COALESCE(?, handled_by_name),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(fields.status || null, fields.handledBy || null, fields.handledByName || null, id);
  return db.prepare('SELECT * FROM callbacks WHERE id = ?').get(id);
}

// ---- Leads ----
function createLead(row) {
  const r = db.prepare(`
    INSERT INTO leads (chat_id, name, contact, service, property_type, location, size_info, preferred_date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(
    row.chatId || null,
    row.name || null,
    row.contact || null,
    row.service || null,
    row.propertyType || null,
    row.location || null,
    row.sizeInfo || null,
    row.preferredDate || null,
    row.notes || null
  );
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(r.lastInsertRowid);
}

function listLeads({ status, q } = {}) {
  let rows = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 300').all();
  if (status) rows = rows.filter(r => r.status === status);
  if (q) {
    const n = q.toLowerCase();
    rows = rows.filter(r =>
      [r.name, r.contact, r.location, r.service, r.notes].some(x => (x || '').toLowerCase().includes(n))
    );
  }
  return rows;
}

function updateLead(id, fields) {
  const cur = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare(`
    UPDATE leads SET
      status = COALESCE(?, status),
      owner_id = COALESCE(?, owner_id),
      owner_name = COALESCE(?, owner_name),
      agent_notes = COALESCE(?, agent_notes),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    fields.status || null,
    fields.ownerId || null,
    fields.ownerName || null,
    fields.agentNotes || null,
    id
  );
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

// ---- Unanswered ----
function recordUnanswered(question, chatId) {
  const norm = normalizeQ(question);
  if (!norm || norm.length < 3) return null;
  const existing = db.prepare('SELECT * FROM unanswered WHERE normalized = ?').get(norm);
  if (existing) {
    db.prepare(`UPDATE unanswered SET count = count + 1, last_asked = datetime('now'), sample_chat_id = COALESCE(?, sample_chat_id) WHERE id = ?`)
      .run(chatId || null, existing.id);
    return db.prepare('SELECT * FROM unanswered WHERE id = ?').get(existing.id);
  }
  const r = db.prepare(
    `INSERT INTO unanswered (question, normalized, count, sample_chat_id) VALUES (?, ?, 1, ?)`
  ).run(String(question).slice(0, 500), norm, chatId || null);
  return db.prepare('SELECT * FROM unanswered WHERE id = ?').get(r.lastInsertRowid);
}

function listUnanswered() {
  return db.prepare(`SELECT * FROM unanswered WHERE status = 'open' ORDER BY count DESC, last_asked DESC LIMIT 100`).all();
}

function ignoreUnanswered(id) {
  db.prepare(`UPDATE unanswered SET status = 'ignored' WHERE id = ?`).run(id);
}

function resolveUnansweredMatching(question) {
  const norm = normalizeQ(question);
  if (!norm) return;
  db.prepare(`UPDATE unanswered SET status = 'resolved' WHERE normalized = ? OR normalized LIKE ?`).run(norm, '%' + norm.slice(0, 40) + '%');
}

// ---- Ratings ----
function saveRating({ chatId, messageId, score, comment, kind }) {
  const s = score >= 1 ? 1 : 0;
  const r = db.prepare(
    `INSERT INTO ratings (chat_id, message_id, score, comment, kind) VALUES (?, ?, ?, ?, ?)`
  ).run(chatId || null, messageId || null, s, comment || null, kind || 'chat');
  return db.prepare('SELECT * FROM ratings WHERE id = ?').get(r.lastInsertRowid);
}

function ratingStats() {
  const byDay = db.prepare(`
    SELECT date(created_at) as day,
      SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) as up,
      SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) as down
    FROM ratings GROUP BY date(created_at) ORDER BY day DESC LIMIT 30
  `).all();
  const lowBot = db.prepare(`
    SELECT * FROM ratings WHERE kind = 'bot' AND score = 0 ORDER BY created_at DESC LIMIT 20
  `).all();
  return { byDay, lowBot };
}

// ---- Canned ----
function listCanned(userId) {
  return db.prepare(`
    SELECT * FROM canned_replies
    WHERE is_shared = 1 OR owner_id = ?
    ORDER BY title
  `).all(userId || 0);
}

function saveCanned({ title, body, ownerId, isShared }) {
  const r = db.prepare(
    `INSERT INTO canned_replies (title, body, owner_id, is_shared) VALUES (?, ?, ?, ?)`
  ).run(title, body, ownerId || null, isShared === false ? 0 : 1);
  return db.prepare('SELECT * FROM canned_replies WHERE id = ?').get(r.lastInsertRowid);
}

function deleteCanned(id) {
  db.prepare('DELETE FROM canned_replies WHERE id = ?').run(id);
}

function expandCanned(body, vars) {
  return String(body || '')
    .replace(/\{\{visitor_name\}\}/gi, vars.visitorName || '')
    .replace(/\{\{company\}\}/gi, vars.company || 'Hama Enterprise Ng');
}

// ---- Retention ----
function runRetention() {
  const days = parseInt(process.env.CHAT_RETENTION_DAYS || '0', 10);
  if (!days || days < 1) return { deleted: 0 };
  const old = db.prepare(`SELECT id FROM chats WHERE datetime(created_at) < datetime('now', ?)`).all(`-${days} days`);
  for (const c of old) {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(c.id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(c.id);
  }
  return { deleted: old.length };
}

function deleteVisitorData(contact) {
  if (!contact) return { error: 'Contact required' };
  const chats = db.prepare('SELECT id FROM chats WHERE customer_contact = ?').all(contact);
  for (const c of chats) {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(c.id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(c.id);
  }
  db.prepare('DELETE FROM leads WHERE contact = ?').run(contact);
  db.prepare('DELETE FROM callbacks WHERE phone = ?').run(contact);
  return { success: true, chatsRemoved: chats.length };
}

module.exports = {
  initExtraTables,
  createCallback,
  listCallbacks,
  countNewCallbacks,
  updateCallback,
  createLead,
  listLeads,
  updateLead,
  recordUnanswered,
  listUnanswered,
  ignoreUnanswered,
  resolveUnansweredMatching,
  saveRating,
  ratingStats,
  listCanned,
  saveCanned,
  deleteCanned,
  expandCanned,
  runRetention,
  deleteVisitorData,
  normalizeQ
};
