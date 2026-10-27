const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Ensure documents folder exists under DATA_DIR
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

    CREATE TABLE IF NOT EXISTS document_passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);

  // Migrate older DBs that lack source_label
  try {
    db.exec('ALTER TABLE messages ADD COLUMN source_label TEXT');
  } catch (_) {}

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

    let adminPassword;
    if (isLive()) {
      adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
      if (!process.env.ADMIN_PASSWORD) {
        console.log('================================================');
        console.log('FIRST ADMIN PASSWORD (save this, shown once):');
        console.log(adminPassword);
        console.log('================================================');
      }
    } else {
      adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
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
        ['services', 'interior design,interior,decoration,decor', 'Do you offer interior design?', 'Absolutely. Our interior design team helps you create beautiful, functional spaces — colour consultation, material selection, and full project coordination.', 9],
        ['services', 'exterior design,exterior,facade,outdoor', 'Do you do exterior design?', 'Yes, we provide exterior design and painting services including facade treatments, protective coatings and aesthetic upgrades.', 8],
        ['areas', 'location,area,serve,where,city,lagos,abuja,port harcourt,nigeria', 'Which areas do you serve?', 'We primarily serve Lagos, Abuja, Port Harcourt and surrounding areas. Contact us for projects outside these locations.', 10],
        ['quote', 'quote,price,cost,estimate,how much,pricing,quotation', 'How can I get a quote?', 'To request a free quote, please share: 1) Type of project, 2) Approximate size, 3) Location, 4) Preferred contact. An agent will follow up shortly. You can also say "Talk to a person".', 10],
        ['hours', 'hours,working hours,open,time,when,schedule', 'What are your working hours?', 'We are available Monday to Saturday, 8:00 AM – 6:00 PM WAT.', 8],
        ['contact', 'contact,phone,email,call,reach,number', 'How can I contact you?', 'You can leave your phone number here and an agent will call you back. Office hours: Mon–Sat 8am–6pm WAT.', 9],
        ['faq', 'rc,registration,company,about,who are you', 'What is your company registration?', 'Hama Enterprise Ng is a registered company with RC 8827959.', 5],
        ['faq', 'payment,pay,deposit,invoice', 'How do payments work?', 'Payment terms are discussed after a site assessment or detailed quote. Please speak with an agent for payment arrangements.', 7],
        ['faq', 'inspection,site visit,survey,measure', 'Do you do site inspections?', 'Yes, free site inspections can be arranged within our service areas. Please provide your location and preferred dates.', 8],
        ['faq', 'complaint,problem,issue,unhappy,bad job', 'How do I make a complaint?', 'We take every concern seriously. Please describe the issue and an agent will take over this chat immediately to assist you.', 10]
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
