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
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
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

// Admin resets an agent's password (cannot view old password — it is hashed)
router.post('/agents/:id/reset-password', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Agent not found' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.json({ success: true, message: `Password for ${target.username} has been reset` });
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

// ---- Seed ----
router.post('/seed', adminRequired, (req, res) => {
  try {
    const results = [];
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

    const agentHash = bcrypt.hashSync('agent123', 10);
    const existingAgent = db.prepare('SELECT id FROM users WHERE username = ?').get('agent1');
    if (!existingAgent) {
      db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run('agent1', agentHash, 'Support Agent 1', 'agent');
      results.push('Sample agent created (agent1 / agent123)');
    } else {
      results.push('Sample agent already exists');
    }

    const existingKb = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get();
    if (existingKb.c === 0) {
      results.push('Knowledge base empty — use Auto-seed on server start or add entries manually');
    } else {
      results.push(`Knowledge base has ${existingKb.c} entries`);
    }

    res.json({ success: true, messages: results });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Seed failed: ' + err.message });
  }
});

module.exports = router;
