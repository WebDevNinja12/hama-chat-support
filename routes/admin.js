const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');

const router = express.Router();

router.use(authRequired);

// ---- Users / Agents ----
router.get('/agents', adminRequired, (req, res) => {
  const agents = db.prepare(
    'SELECT id, username, name, role, online, created_at FROM users ORDER BY role DESC, name'
  ).all();
  res.json(agents);
});

router.post('/agents', adminRequired, (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password || !name) {
    return res.status(400).json({ error: 'username, password and name required' });
  }
  if (role && !['admin', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or agent' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
    ).run(username.trim(), hash, name.trim(), role || 'agent');
    res.status(201).json({ id: result.lastInsertRowid, username, name, role: role || 'agent' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

router.delete('/agents/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Agent not found' });
  res.json({ success: true });
});

// ---- Knowledge Base ----
router.get('/knowledge', (req, res) => {
  const entries = db.prepare(
    'SELECT * FROM knowledge_base ORDER BY priority DESC, category, id'
  ).all();
  res.json(entries);
});

router.post('/knowledge', adminRequired, (req, res) => {
  const { category, keywords, question, answer, priority } = req.body || {};
  if (!category || !keywords || !answer) {
    return res.status(400).json({ error: 'category, keywords and answer required' });
  }
  const result = db.prepare(`
    INSERT INTO knowledge_base (category, keywords, question, answer, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(category, keywords, question || null, answer, priority || 0);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/knowledge/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { category, keywords, question, answer, priority, active } = req.body || {};
  const existing = db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE knowledge_base SET
      category = COALESCE(?, category),
      keywords = COALESCE(?, keywords),
      question = COALESCE(?, question),
      answer = COALESCE(?, answer),
      priority = COALESCE(?, priority),
      active = COALESCE(?, active),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    category ?? null,
    keywords ?? null,
    question ?? null,
    answer ?? null,
    priority ?? null,
    active !== undefined ? (active ? 1 : 0) : null,
    id
  );
  res.json({ success: true });
});

router.delete('/knowledge/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ---- Settings ----
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

router.put('/settings', adminRequired, (req, res) => {
  const allowed = ['greeting', 'company_name', 'working_hours', 'contact_email', 'contact_phone'];
  const updates = req.body || {};
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      stmt.run(key, String(updates[key]));
    }
  }
  res.json({ success: true });
});

// ---- Stats ----
router.get('/stats', (req, res) => {
  const chatsToday = db.prepare(
    `SELECT COUNT(*) as c FROM chats WHERE date(created_at) = date('now')`
  ).get().c;
  const totalChats = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
  const escalated = db.prepare(
    `SELECT COUNT(*) as c FROM chats WHERE status IN ('needs_attention', 'with_agent', 'resolved')`
  ).get().c;
  const resolved = db.prepare(
    `SELECT COUNT(*) as c FROM chats WHERE status = 'resolved'`
  ).get().c;
  const byStatus = db.prepare(
    `SELECT status, COUNT(*) as c FROM chats GROUP BY status`
  ).all();

  res.json({
    chatsToday,
    totalChats,
    escalated,
    resolved,
    escalationRate: totalChats ? Math.round((escalated / totalChats) * 100) : 0,
    byStatus
  });
});

// ---- Chat history ----
router.get('/chats', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const status = req.query.status;

  let sql = 'SELECT * FROM chats';
  const params = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const chats = db.prepare(sql).all(...params);
  res.json(chats);
});

router.get('/chats/:id/messages', (req, res) => {
  const messages = db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(messages);
});

// ---- Seed Database (Admin only) ----
router.post('/seed', adminRequired, (req, res) => {
  try {
    const results = [];

    // Admin user
    const adminPassword = 'admin123';
    const hash = bcrypt.hashSync(adminPassword, 10);
    const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existingAdmin) {
      db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run('admin', hash, 'System Admin', 'admin');
      results.push('Admin user created (admin / admin123)');
    } else {
      results.push('Admin user already exists');
    }

    // Sample agent
    const agentHash = bcrypt.hashSync('agent123', 10);
    const existingAgent = db.prepare('SELECT id FROM users WHERE username = ?').get('agent1');
    if (!existingAgent) {
      db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run('agent1', agentHash, 'Support Agent 1', 'agent');
      results.push('Sample agent created (agent1 / agent123)');
    } else {
      results.push('Sample agent already exists');
    }

    // Knowledge base
    const kbEntries = [
      { category: 'services', keywords: 'services,painting,what do you do,offer,paint,interior,exterior,design', question: 'What services do you offer?', answer: 'Hama Enterprise Ng (RC 8827959) offers professional painting, interior design, and exterior design services for residential, commercial, and industrial clients across Nigeria. We handle everything from single-room repaints to full building projects.', priority: 10 },
      { category: 'services', keywords: 'painting,paint,house paint,wall,ceiling', question: 'Do you do painting?', answer: 'Yes! We specialize in high-quality interior and exterior painting for homes, offices, factories and commercial buildings. We use premium paints and skilled craftsmen.', priority: 9 },
      { category: 'services', keywords: 'interior design,interior,decoration,decor', question: 'Do you offer interior design?', answer: 'Absolutely. Our interior design team helps you create beautiful, functional spaces — colour consultation, material selection, and full project coordination.', priority: 9 },
      { category: 'services', keywords: 'exterior design,exterior,facade,outdoor', question: 'Do you do exterior design?', answer: 'Yes, we provide exterior design and painting services including facade treatments, protective coatings and aesthetic upgrades for residential and commercial properties.', priority: 8 },
      { category: 'areas', keywords: 'location,area,serve,where,city,lagos,abuja,port harcourt,nigeria', question: 'Which areas do you serve?', answer: 'We primarily serve Lagos, Abuja, Port Harcourt and surrounding areas. For projects outside these locations, please contact us so we can assess feasibility.', priority: 10 },
      { category: 'quote', keywords: 'quote,price,cost,estimate,how much,pricing,quotation', question: 'How can I get a quote?', answer: 'To request a free quote, please share: 1) Type of project (residential/commercial/industrial), 2) Approximate size or number of rooms, 3) Location, 4) Preferred contact. One of our agents will follow up shortly. You can also say "Talk to a person".', priority: 10 },
      { category: 'hours', keywords: 'hours,working hours,open,time,when,schedule', question: 'What are your working hours?', answer: 'We are available Monday to Saturday, 8:00 AM – 6:00 PM WAT. For urgent site inspections outside these hours, leave your contact and we will arrange a suitable time.', priority: 8 },
      { category: 'contact', keywords: 'contact,phone,email,call,reach,number', question: 'How can I contact you?', answer: 'You can reach Hama Enterprise Ng at support@hamaenterprise.ng or leave your phone number here and an agent will call you back. Our office hours are Mon–Sat 8am–6pm WAT.', priority: 9 },
      { category: 'faq', keywords: 'rc,registration,company,about,who are you', question: 'What is your company registration?', answer: 'Hama Enterprise Ng is a registered company with RC 8827959. We proudly serve residential, commercial and industrial clients with professional painting and design services.', priority: 5 },
      { category: 'faq', keywords: 'payment,pay,deposit,invoice', question: 'How do payments work?', answer: 'Payment terms are discussed after a site assessment or detailed quote. We typically require a deposit to schedule work. For payment arrangements please speak with an agent.', priority: 7 },
      { category: 'faq', keywords: 'inspection,site visit,survey,measure', question: 'Do you do site inspections?', answer: 'Yes, free site inspections can be arranged for most projects within our service areas. Please provide your location and preferred dates so an agent can schedule it.', priority: 8 },
      { category: 'faq', keywords: 'complaint,problem,issue,unhappy,bad job', question: 'How do I make a complaint?', answer: 'We take every concern seriously. Please describe the issue and share your contact details. An agent will take over this chat immediately to assist you.', priority: 10 }
    ];

    const existingKb = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get();
    if (existingKb.c === 0) {
      const insertKb = db.prepare('INSERT INTO knowledge_base (category, keywords, question, answer, priority) VALUES (?, ?, ?, ?, ?)');
      for (const entry of kbEntries) {
        insertKb.run(entry.category, entry.keywords, entry.question, entry.answer, entry.priority);
      }
      results.push(`Inserted ${kbEntries.length} knowledge base entries`);
    } else {
      results.push(`Knowledge base already has ${existingKb.c} entries`);
    }

    res.json({ success: true, messages: results });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Seed failed: ' + err.message });
  }
});

module.exports = router;
