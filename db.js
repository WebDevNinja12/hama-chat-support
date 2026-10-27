const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'hama_chat.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA foreign_keys = ON;');

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
  `);

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
}

initDb();

module.exports = db;
