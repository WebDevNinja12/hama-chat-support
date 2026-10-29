const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const docsPath = path.join(dataDir, 'documents');
if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });

const dbPath = path.join(dataDir, 'hama_chat.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON;');

function isLive() {
  return process.env.NODE_ENV === 'production' || !!process.env.RENDER;
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',
      online INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      customer_name TEXT,
      customer_contact TEXT,
      contact_type TEXT,
      status TEXT DEFAULT 'bot',
      agent_id INTEGER,
      agent_name TEXT,
      is_complaint INTEGER DEFAULT 0,
      complaint_preview TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_name TEXT,
      content TEXT NOT NULL,
      is_internal INTEGER DEFAULT 0,
      source_label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      keywords TEXT NOT NULL,
      question TEXT,
      answer TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS offline_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      customer_name TEXT,
      contact TEXT,
      message TEXT,
      notified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file',
      filename TEXT,
      stored_path TEXT,
      text_content TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      word_count INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      visitor_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      service TEXT NOT NULL,
      property_type TEXT NOT NULL,
      location TEXT NOT NULL,
      project_size TEXT,
      preferred_date TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      owner_id INTEGER,
      staff_notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS callback_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      visitor_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      best_time TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      handled_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message_id INTEGER,
      rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS unanswered_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      normalized TEXT NOT NULL UNIQUE,
      count INTEGER NOT NULL DEFAULT 1,
      ignored INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      last_asked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS canned_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner_id INTEGER,
      personal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_visitors (
      visitor_key TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      kind TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_callbacks_created ON callback_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_ratings_created ON ratings(created_at);
    CREATE INDEX IF NOT EXISTS idx_unanswered_count ON unanswered_questions(count DESC, last_asked_at DESC);
  `);

  const alters = [
    'ALTER TABLE messages ADD COLUMN source_label TEXT',
    'ALTER TABLE chats ADD COLUMN is_complaint INTEGER DEFAULT 0',
    'ALTER TABLE chats ADD COLUMN complaint_preview TEXT'
  ];
  for (const sql of alters) {
    try { db.exec(sql); } catch (_) {}
  }

  const greeting = db.prepare('SELECT value FROM settings WHERE key = ?').get('greeting');
  if (!greeting) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'greeting',
      'Welcome to Hama Enterprise Ng Support! How can we help you with your painting, interior or exterior design needs today?'
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('company_name', 'Hama Enterprise Ng');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('working_hours', 'Monday - Saturday: 8:00 AM - 6:00 PM WAT');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('contact_email', 'support@hamaenterprise.ng');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('contact_phone', '+234 XXX XXX XXXX');
  }

  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    console.log('No users found — creating first admin...');
    const adminPassword = process.env.ADMIN_PASSWORD || 'hama123';
    if (isLive() && !process.env.ADMIN_PASSWORD) {
      console.log('Admin password: hama123 (set ADMIN_PASSWORD to override)');
    }
    const adminHash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
    ).run('admin', adminHash, 'System Admin', 'admin');

    if (!isLive()) {
      const agentHash = bcrypt.hashSync('agent123', 10);
      db.prepare(
        'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
      ).run('agent1', agentHash, 'Support Agent 1', 'agent');
    }

    const kbCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get().c;
    if (kbCount === 0) {
      const kbEntries = [
        ['services', 'services,painting,what do you do,offer,paint,interior,exterior,design', 'What services do you offer?', 'Hama Enterprise Ng (RC 8827959) offers professional painting, interior design, and exterior design services for residential, commercial, and industrial clients across Nigeria.', 10],
        ['services', 'painting,paint,house paint,wall,ceiling', 'Do you do painting?', 'Yes! We specialize in high-quality interior and exterior painting for homes, offices, factories and commercial buildings.', 9],
        ['quote', 'quote,price,cost,estimate,how much,pricing,quotation', 'How can I get a quote?', 'To request a free quote, please share: 1) Type of project, 2) Approximate size, 3) Location, 4) Preferred contact. An agent will follow up shortly.', 10],
        ['hours', 'hours,working hours,open,time,when,schedule', 'What are your working hours?', 'We are available Monday to Saturday, 8:00 AM – 6:00 PM WAT.', 8],
        ['areas', 'location,area,serve,where,city,lagos,abuja,port harcourt,nigeria', 'Which areas do you serve?', 'We primarily serve Lagos, Abuja, Port Harcourt and surrounding areas.', 10],
        ['contact', 'contact,phone,email,call,reach,number', 'How can I contact you?', 'Leave your phone number here and an agent will call you back.', 9]
      ];
      const insertKb = db.prepare(
        'INSERT INTO knowledge_base (category, keywords, question, answer, priority) VALUES (?, ?, ?, ?, ?)'
      );
      for (const row of kbEntries) insertKb.run(...row);
    }
    console.log('Admin ready. Username: admin');
  }
}

initDb();
module.exports = db;
