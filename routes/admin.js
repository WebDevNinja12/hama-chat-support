const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const instructions = require('../utils/instructions');
const documents = require('../utils/documents');

const router = express.Router();

router.use(authRequired);

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
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw err;
  }
});

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
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Agent not found' });
  res.json({ success: true });
});

router.get('/knowledge', (req, res) => {
  res.json(db.prepare('SELECT * FROM knowledge_base ORDER BY priority DESC, category, id').all());
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

router.delete('/knowledge/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

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
    if (updates[key] !== undefined) stmt.run(key, String(updates[key]));
  }
  res.json({ success: true });
});

// ---- Assistant instructions (AI mode only) ----
router.get('/instructions', adminRequired, (req, res) => {
  res.json({
    text: instructions.getInstructions(),
    defaultText: instructions.getDefault(),
    aiEnabled: documents.aiEnabled(),
    note: documents.aiEnabled()
      ? 'These instructions are sent to the AI with every AI reply. Fixed safety rules are always appended in code.'
      : 'Instructions only apply when AI replies are ON (set ANTHROPIC_API_KEY). Rule-based mode quotes documents without these instructions.'
  });
});

router.put('/instructions', adminRequired, (req, res) => {
  const result = instructions.saveInstructions(req.body && req.body.text);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

router.post('/instructions/restore', adminRequired, (req, res) => {
  const result = instructions.restoreDefault();
  res.json({ success: true, text: result.text });
});

router.get('/stats', (req, res) => {
  const chatsToday = db.prepare(`SELECT COUNT(*) as c FROM chats WHERE date(created_at) = date('now')`).get().c;
  const totalChats = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
  const escalated = db.prepare(`SELECT COUNT(*) as c FROM chats WHERE status IN ('needs_attention', 'with_agent', 'resolved')`).get().c;
  const resolved = db.prepare(`SELECT COUNT(*) as c FROM chats WHERE status = 'resolved'`).get().c;
  res.json({
    chatsToday,
    totalChats,
    escalated,
    resolved,
    escalationRate: totalChats ? Math.round((escalated / totalChats) * 100) : 0
  });
});

router.get('/chats', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const chats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  res.json(chats);
});

router.get('/chats/:id/messages', (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.id));
});

router.delete('/chats/:id', adminRequired, (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id);
  const result = db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Chat not found' });
  res.json({ success: true });
});

router.post('/chats/clear', adminRequired, (req, res) => {
  const chatCount = db.prepare('SELECT COUNT(*) as c FROM chats').get().c;
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM chats').run();
  db.prepare('DELETE FROM offline_requests').run();
  res.json({ success: true, message: `Cleared ${chatCount} chats and ${msgCount} messages` });
});

router.post('/seed', adminRequired, (req, res) => {
  try {
    const results = [];
    const adminPassword = process.env.ADMIN_PASSWORD || 'hama123';
    const hash = bcrypt.hashSync(adminPassword, 10);
    const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existingAdmin) {
      db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run('admin', hash, 'System Admin', 'admin');
      results.push('Admin created');
    } else if (req.body && req.body.resetAdminPassword) {
      db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
      results.push('Admin password reset');
    } else {
      results.push('Admin already exists');
    }
    res.json({ success: true, messages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Staff can inspect and update call-back requests.
router.get('/callbacks', (req, res) => {
  const rows = db.prepare("SELECT * FROM callback_requests ORDER BY created_at DESC").all();
  res.json({ callbacks: rows, newCount: rows.filter(row => row.status === 'New').length });
});

router.patch('/callbacks/:id', (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['New', 'Contacted', 'Done'].includes(status)) return res.status(400).json({ error: 'Choose New, Contacted, or Done.' });
  const result = db.prepare("UPDATE callback_requests SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.user.id, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Call-back not found.' });
  res.json({ success: true });
});

module.exports = router;
