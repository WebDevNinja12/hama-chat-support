const express = require('express');
const db = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const store = require('../utils/store_extra');
const alerts = require('../utils/alerts');
const backup = require('../utils/backup');
const spam = require('../utils/spam');

const router = express.Router();

router.use(authRequired);

// ---- Callbacks ----
router.get('/callbacks', (req, res) => {
  const list = store.listCallbacks(req.query.status || null);
  res.json({ items: list, newCount: store.countNewCallbacks() });
});

router.patch('/callbacks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = store.updateCallback(id, {
    status: req.body.status,
    handledBy: req.user.id,
    handledByName: req.user.name
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

// ---- Leads ----
router.get('/leads', (req, res) => {
  res.json(store.listLeads({ status: req.query.status, q: req.query.q }));
});

router.patch('/leads/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = store.updateLead(id, {
    status: req.body.status,
    ownerId: req.body.ownerId || req.user.id,
    ownerName: req.body.ownerName || req.user.name,
    agentNotes: req.body.agentNotes
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

router.get('/leads/export.csv', adminRequired, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(backup.leadsCsv());
});

// ---- Unanswered ----
router.get('/unanswered', adminRequired, (req, res) => {
  res.json(store.listUnanswered());
});

router.post('/unanswered/:id/ignore', adminRequired, (req, res) => {
  store.ignoreUnanswered(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ---- Ratings ----
router.get('/ratings/stats', adminRequired, (req, res) => {
  res.json(store.ratingStats());
});

// ---- Canned replies ----
router.get('/canned', (req, res) => {
  res.json(store.listCanned(req.user.id));
});

router.post('/canned', (req, res) => {
  const { title, body, isShared } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  const row = store.saveCanned({
    title: String(title).slice(0, 120),
    body: String(body).slice(0, 4000),
    ownerId: req.user.id,
    isShared: isShared !== false
  });
  res.status(201).json(row);
});

router.delete('/canned/:id', (req, res) => {
  store.deleteCanned(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// ---- Alerts ----
router.post('/alerts/test', adminRequired, async (req, res) => {
  const result = await alerts.sendTestAlert();
  if (!result.ok) {
    return res.status(400).json({
      error: result.error || 'Could not send alert. Check EMAIL_API_KEY, EMAIL_PROVIDER and ALERT_EMAILS.'
    });
  }
  res.json({ success: true, message: 'Test alert sent' });
});

// ---- Backup ----
router.get('/backup', adminRequired, (req, res) => {
  const buf = backup.buildBackupBuffer();
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="hama-backup.json.gz"');
  res.send(buf);
});

router.get('/export/chats.csv', adminRequired, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="chats.csv"');
  res.send(backup.chatsCsv());
});

router.post('/backup/restore', adminRequired, express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty file' });
  const result = backup.restoreFromBuffer(Buffer.from(req.body));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ---- Privacy delete ----
router.post('/visitor/delete', adminRequired, (req, res) => {
  const contact = (req.body && req.body.contact || '').trim();
  const result = store.deleteVisitorData(contact);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ---- Block visitor ----
router.post('/block', (req, res) => {
  const key = (req.body && (req.body.contact || req.body.chatId || req.body.ip) || '').trim();
  if (!key) return res.status(400).json({ error: 'contact, chatId or ip required' });
  const result = spam.blockVisitor(key, 24);
  res.json({ success: true, until: result.until });
});

// ---- Settings extras (privacy, whatsapp) ----
router.get('/public-settings', (req, res) => {
  // used by widget too via server route without auth — this one is auth
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json(s);
});

module.exports = router;
