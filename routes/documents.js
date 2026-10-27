const express = require('express');
const db = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const documents = require('../utils/documents');
const bot = require('../utils/bot');

const router = express.Router();

router.use(authRequired);
router.use(adminRequired);

// List documents
router.get('/', (req, res) => {
  const list = documents.listDocuments();
  res.json({
    documents: list,
    aiEnabled: documents.aiEnabled(),
    aiHint: documents.aiEnabled()
      ? 'AI-written replies are ON (ANTHROPIC_API_KEY is set).'
      : 'AI-written replies are OFF. Set ANTHROPIC_API_KEY on the server to turn them on.',
    limits: { maxDocs: documents.MAX_DOCS, maxChars: 400000, maxFileMb: 20 }
  });
});

// View extracted text
router.get('/:id', (req, res) => {
  const doc = documents.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const passages = documents.getPassages(doc.id);
  res.json({
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    filename: doc.filename,
    word_count: doc.word_count,
    char_count: doc.char_count,
    created_at: doc.created_at,
    text_content: doc.text_content,
    passages: passages.map(p => ({ idx: p.idx, text: p.text }))
  });
});

// Write / paste a note
router.post('/note', express.json({ limit: '500kb' }), (req, res) => {
  const { title, content } = req.body || {};
  const result = documents.saveNote({ title, content, adminId: req.user.id });
  if (result.error) return res.status(400).json({ error: result.error });
  documents.invalidateCache();
  res.status(201).json(result);
});

// Upload file as raw body; filename in X-File-Name header
router.post('/upload', express.raw({ type: '*/*', limit: '21mb' }), async (req, res) => {
  try {
    const filename = req.headers['x-file-name']
      ? decodeURIComponent(String(req.headers['x-file-name']))
      : 'upload.bin';
    const title = req.headers['x-file-title']
      ? decodeURIComponent(String(req.headers['x-file-title']))
      : '';
    const mime = req.headers['content-type'] || '';
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

    const result = await documents.saveUpload({
      buffer,
      filename,
      mime,
      title,
      adminId: req.user.id
    });
    if (result.error) return res.status(400).json({ error: result.error });
    documents.invalidateCache();
    res.status(201).json(result);
  } catch (err) {
    console.error('Upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Delete (client does two-step confirmation)
router.delete('/:id', (req, res) => {
  const result = documents.deleteDocument(req.params.id);
  if (result.error) return res.status(404).json({ error: result.error });
  documents.invalidateCache();
  res.json({ success: true });
});

// Test the bot without creating a chat
router.post('/test', express.json(), async (req, res) => {
  const question = (req.body && req.body.question) || '';
  if (!question.trim()) return res.status(400).json({ error: 'question required' });
  try {
    const result = await bot.testQuestion(question.trim());
    res.json(result);
  } catch (err) {
    console.error('Test error', err);
    res.status(500).json({ error: 'Test failed' });
  }
});

module.exports = router;
