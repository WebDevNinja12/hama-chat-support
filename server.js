require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
require('./utils/store_extra');
const { socketAuth } = require('./middleware/auth');
const bot = require('./utils/bot');
const privacy = require('./utils/privacy');
const spam = require('./utils/spam');
const alerts = require('./utils/alerts');
const store = require('./utils/store_extra');
const quoteFlow = require('./utils/quote_flow');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');
const opsRoutes = require('./routes/ops');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/ops', opsRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', company: 'Hama Enterprise Ng', time: new Date().toISOString() });
});

app.get('/api/public-config', (req, res) => {
  const get = (k, d) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return row ? row.value : d;
  };
  res.json({
    privacyText: get('privacy_text', 'We use your details only to answer your enquiry.'),
    privacyUrl: get('privacy_url', ''),
    whatsappNumber: get('whatsapp_number', ''),
    whatsappPrefill: get('whatsapp_prefill', 'Hello Hama Enterprise Ng, I need help with painting/design.'),
    uploadsEnabled: get('uploads_enabled', '0') === '1',
    companyName: get('company_name', 'Hama Enterprise Ng')
  });
});

// Public rating from widget
app.post('/api/rate', (req, res) => {
  try {
    const { chatId, messageId, score, comment, kind } = req.body || {};
    if (!chatId || score === undefined) return res.status(400).json({ error: 'chatId and score required' });
    const row = store.saveRating({
      chatId,
      messageId,
      score: Number(score) ? 1 : 0,
      comment: spam.sanitizeMessage(comment || '').slice(0, 500),
      kind: kind === 'bot' ? 'bot' : 'chat'
    });
    res.json({ success: true, id: row.id });
  } catch (err) {
    res.status(500).json({ error: 'Could not save rating' });
  }
});

// Public callback form
app.post('/api/callbacks', async (req, res) => {
  try {
    const hp = spam.checkHoneypotAndTiming(req.body || {});
    if (!hp.ok) return res.status(400).json({ error: hp.error });
    const name = spam.sanitizeMessage(req.body.name || '').slice(0, 120);
    const phone = spam.sanitizeMessage(req.body.phone || '').slice(0, 80);
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
    const row = store.createCallback({
      chatId: req.body.chatId,
      name,
      phone,
      bestTime: spam.sanitizeMessage(req.body.bestTime || '').slice(0, 120),
      message: spam.sanitizeMessage(req.body.message || '').slice(0, 1000),
      lastMessages: req.body.lastMessages || null
    });
    alerts.notifyStaff({
      type: 'Call-back request',
      chatId: req.body.chatId,
      name,
      contact: phone,
      message: row.message,
      reason: 'callback'
    }).catch(() => {});
    res.status(201).json({ success: true, id: row.id });
  } catch (err) {
    res.status(500).json({ error: 'Could not save call-back' });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hama Enterprise Ng</title>
<style>body{font-family:system-ui;margin:0;background:#f8fafc;color:#1e293b}header{background:#0D7377;color:#fff;padding:28px 20px;text-align:center}main{max-width:560px;margin:32px auto;padding:0 16px}.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 4px 16px rgba(0,0,0,.06)}a.btn{display:inline-block;background:#E85D04;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px}a.staff{color:#0D7377;font-size:14px}</style></head>
<body><header><h1>Hama Enterprise Ng</h1><p>Live chat · RC 8827959</p></header>
<main><div class="card"><p>Painting, interior &amp; exterior design support.</p>
<a class="btn" href="/widget-demo.html">Try the chat</a>
<p style="margin-top:20px"><a class="staff" href="/dashboard">Staff login</a></p></div></main>
<script src="/widget.js"></script></body></html>`);
});

app.get(['/dashboard', '/dashboard/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const agentSockets = new Map();

function clientIp(socket) {
  const xf = socket.handshake.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return socket.handshake.address || '';
}

io.use(socketAuth);

io.on('connection', (socket) => {
  if (socket.user) {
    agentSockets.set(socket.user.id, socket.id);
    socket.join('agents');
    db.prepare('UPDATE users SET online = 1 WHERE id = ?').run(socket.user.id);
    const openChats = db.prepare(`
      SELECT * FROM chats
      WHERE status IN ('bot', 'needs_attention', 'with_agent')
         OR datetime(updated_at) >= datetime('now', '-14 days')
      ORDER BY CASE
        WHEN is_complaint = 1 AND status = 'needs_attention' THEN 0
        WHEN status = 'needs_attention' THEN 1
        WHEN status = 'with_agent' THEN 2
        WHEN status = 'bot' THEN 3 ELSE 4 END,
        updated_at DESC LIMIT 150
    `).all();
    socket.emit('chats:list', openChats);
    socket.emit('callbacks:badge', { newCount: store.countNewCallbacks() });
  }

  socket.on('customer:start', (data, cb) => {
    try {
      const hp = spam.checkHoneypotAndTiming(data || {});
      if (!hp.ok) return cb?.({ error: hp.error });

      const ip = clientIp(socket);
      const chatLimit = spam.checkNewChat(ip);
      if (!chatLimit.ok) return cb?.({ error: chatLimit.error });

      const name = spam.sanitizeMessage(data.name || '').slice(0, 120);
      const contact = spam.sanitizeMessage(data.contact || '').slice(0, 120);
      if (!name || !contact) return cb?.({ error: 'Name and contact required' });
      if (!data.privacyAccepted) return cb?.({ error: 'Please accept the privacy notice to continue.' });

      const chatId = uuidv4();
      db.prepare(`INSERT INTO chats (id, customer_name, customer_contact, contact_type, status) VALUES (?, ?, ?, ?, 'bot')`)
        .run(chatId, name, contact, data.contactType === 'email' ? 'email' : 'phone');

      const greeting = bot.getGreeting();
      db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'bot', 'Hama Support Bot', ?)`) 
        .run(chatId, greeting);

      socket.join(`chat:${chatId}`);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at').all(chatId);
      io.to('agents').emit('chat:new', chat);
      cb?.({ chatId, messages, quickReplies: bot.getQuickReplies() });
    } catch (err) {
      console.error('customer:start', err.message);
      cb?.({ error: 'Failed to start chat' });
    }
  });

  socket.on('message:send', (data, cb) => {
    try {
      const { chatId, content, isInternal } = data || {};
      if (!chatId || !content) return cb?.({ error: 'chatId and content required' });

      let chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) return cb?.({ error: 'Chat not found' });

      const isAgent = !!socket.user;
      const ip = clientIp(socket);

      let textToStore = content;
      if (!isAgent) {
        const chk = spam.checkMessage(chatId, ip, content);
        if (!chk.ok) return cb?.({ error: chk.error });
        textToStore = chk.content;

        const history = db.prepare(
          'SELECT sender_type, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 8'
        ).all(chatId).reverse();
        const priv = privacy.checkMessage(textToStore, history);
        textToStore = priv.maskedContent;
        if (priv.blocked) {
          const result = db.prepare(
            `INSERT INTO messages (chat_id, sender_type, sender_name, content, is_internal) VALUES (?, 'customer', ?, ?, 0)`
          ).run(chatId, chat.customer_name, textToStore);
          const message = {
            id: result.lastInsertRowid, chat_id: chatId, sender_type: 'customer',
            sender_name: chat.customer_name, content: textToStore, created_at: new Date().toISOString()
          };
          io.to(`chat:${chatId}`).emit('message:new', message);
          io.to('agents').emit('message:new', { ...message, chatId });
          emitBotMessages(chatId, [privacy.SAFETY_REPLY], {});
          return cb?.({ success: true, message, privacyBlocked: true });
        }
      } else {
        textToStore = spam.sanitizeMessage(content);
      }

      const senderType = isAgent ? (isInternal ? 'system' : 'agent') : 'customer';
      const senderName = isAgent ? socket.user.name : chat.customer_name;
      const internal = isAgent && isInternal ? 1 : 0;

      if (!internal && chat.status === 'resolved') {
        if (isAgent) {
          db.prepare(`UPDATE chats SET status = 'with_agent', agent_id = ?, agent_name = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(socket.user.id, socket.user.name, chatId);
        } else {
          db.prepare(`UPDATE chats SET status = 'needs_attention', updated_at = datetime('now') WHERE id = ?`).run(chatId);
        }
        chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
        io.to('agents').emit('chat:updated', chat);
      }

      const result = db.prepare(
        `INSERT INTO messages (chat_id, sender_type, sender_name, content, is_internal) VALUES (?, ?, ?, ?, ?)`
      ).run(chatId, senderType, senderName, textToStore, internal);
      db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);

      const message = {
        id: result.lastInsertRowid, chat_id: chatId, sender_type: senderType,
        sender_name: senderName, content: textToStore, is_internal: internal,
        created_at: new Date().toISOString()
      };

      if (internal) io.to('agents').emit('message:new', { ...message, chatId });
      else {
        io.to(`chat:${chatId}`).emit('message:new', message);
        io.to('agents').emit('message:new', { ...message, chatId });
      }

      const latest = db.prepare('SELECT status FROM chats WHERE id = ?').get(chatId);
      if (!isAgent && latest && latest.status === 'bot') {
        handleBotReply(chatId, textToStore, chat).catch(err => console.error('bot', err.message));
      }
      cb?.({ success: true, message });
    } catch (err) {
      console.error('message:send', err.message);
      cb?.({ error: 'Failed to send message' });
    }
  });

  socket.on('typing:start', ({ chatId }) => {
    if (!chatId) return;
    const isAgent = !!socket.user;
    socket.to(`chat:${chatId}`).emit('typing', { chatId, isAgent, who: isAgent ? socket.user.name : 'customer' });
  });
  socket.on('typing:stop', ({ chatId }) => {
    if (chatId) {
      socket.to(`chat:${chatId}`).emit('typing:stop', { chatId });
      io.to('agents').emit('typing:stop', { chatId });
    }
  });

  socket.on('chat:join', ({ chatId }) => {
    if (socket.user && chatId) socket.join(`chat:${chatId}`);
  });

  socket.on('chat:takeover', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    db.prepare(`UPDATE chats SET status = 'with_agent', agent_id = ?, agent_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(socket.user.id, socket.user.name, chatId);
    const sysMsg = `Agent ${socket.user.name} has joined the chat.`;
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'system', 'System', ?)`).run(chatId, sysMsg);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
    io.to(`chat:${chatId}`).emit('widget:status', { status: '' });
    io.to('agents').emit('chat:updated', updated);
    io.to(`chat:${chatId}`).emit('message:new', {
      chat_id: chatId, sender_type: 'system', sender_name: 'System', content: sysMsg, created_at: new Date().toISOString()
    });
    cb?.({ success: true, chat: updated });
  });

  socket.on('chat:to-bot', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    db.prepare(`UPDATE chats SET status = 'bot', agent_id = NULL, agent_name = NULL, updated_at = datetime('now') WHERE id = ?`).run(chatId);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
    io.to('agents').emit('chat:updated', updated);
    cb?.({ success: true });
  });

  socket.on('chat:resolve', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    db.prepare(`UPDATE chats SET status = 'resolved', updated_at = datetime('now') WHERE id = ?`).run(chatId);
    const sysMsg = 'This chat was marked resolved.';
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'system', 'System', ?)`).run(chatId, sysMsg);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
    io.to(`chat:${chatId}`).emit('chat:ask-rating', { chatId });
    io.to('agents').emit('chat:updated', updated);
    io.to(`chat:${chatId}`).emit('message:new', {
      chat_id: chatId, sender_type: 'system', sender_name: 'System', content: sysMsg, created_at: new Date().toISOString()
    });
    cb?.({ success: true });
  });

  socket.on('chat:history', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatId);
    cb?.({ chat, messages });
  });

  socket.on('customer:offline-contact', async (data, cb) => {
    const name = spam.sanitizeMessage(data?.name || '').slice(0, 120);
    const contact = spam.sanitizeMessage(data?.contact || '').slice(0, 120);
    const message = spam.sanitizeMessage(data?.message || '').slice(0, 1000);
    db.prepare(`INSERT INTO offline_requests (chat_id, customer_name, contact, message) VALUES (?, ?, ?, ?)`)
      .run(data?.chatId || null, name, contact, message);
    store.createCallback({
      chatId: data?.chatId,
      name,
      phone: contact,
      message,
      bestTime: data?.bestTime || null
    });
    alerts.notifyStaff({
      type: 'Call-back request',
      chatId: data?.chatId,
      name,
      contact,
      message,
      reason: 'offline'
    }).catch(() => {});
    io.to('agents').emit('callbacks:badge', { newCount: store.countNewCallbacks() });
    cb?.({ success: true, message: 'Thank you. Our team will contact you soon.' });
  });

  socket.on('disconnect', () => {
    if (socket.user) {
      agentSockets.delete(socket.user.id);
      db.prepare('UPDATE users SET online = 0 WHERE id = ?').run(socket.user.id);
    }
  });
});

function emitBotMessages(chatId, texts, meta = {}) {
  for (const text of texts) {
    if (!text) continue;
    const sourceLabel = meta.source
      ? (meta.sourceType === 'qa' ? `Q&A: ${meta.source}` : meta.source)
      : null;
    db.prepare(
      `INSERT INTO messages (chat_id, sender_type, sender_name, content, source_label) VALUES (?, 'bot', 'Hama Support Bot', ?, ?)`
    ).run(chatId, text, sourceLabel);
    const message = {
      chat_id: chatId, sender_type: 'bot', sender_name: 'Hama Support Bot',
      content: text, source_label: sourceLabel, created_at: new Date().toISOString(),
      quickReplies: meta.quickReplies
    };
    io.to(`chat:${chatId}`).emit('message:new', { ...message, source_label: undefined });
    io.to('agents').emit('message:new', { ...message, chatId });
  }
  if (meta.widgetStatus) io.to(`chat:${chatId}`).emit('widget:status', { status: meta.widgetStatus });
  if (meta.agentsOnline === false) io.to(`chat:${chatId}`).emit('show:offline-form');
}

async function handleBotReply(chatId, userMessage, chat) {
  // Quote flow continuation
  if (quoteFlow.getSession(chatId)) {
    const step = await quoteFlow.handleAnswer(chatId, userMessage, {
      name: chat.customer_name,
      contact: chat.customer_contact
    });
    if (step) {
      emitBotMessages(chatId, [step.message], { quickReplies: step.quickReplies });
      return;
    }
  }

  if (quoteFlow.isQuoteTrigger(userMessage) && !quoteFlow.getSession(chatId)) {
    const start = quoteFlow.start(chatId, {
      name: chat.customer_name,
      contact: chat.customer_contact
    });
    emitBotMessages(chatId, [start.message], { quickReplies: start.quickReplies });
    return;
  }

  const history = db
    .prepare('SELECT sender_type, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(chatId)
    .reverse();

  const reply = await bot.getBotReply(userMessage, history);

  if (reply.type === 'complaint' || reply.type === 'escalate') {
    if (reply.type === 'complaint') {
      db.prepare(`UPDATE chats SET status = 'needs_attention', is_complaint = 1, complaint_preview = ?, updated_at = datetime('now') WHERE id = ?`)
        .run((userMessage || '').slice(0, 500), chatId);
    } else {
      db.prepare(`UPDATE chats SET status = 'needs_attention', updated_at = datetime('now') WHERE id = ?`).run(chatId);
    }

    const texts = reply.messages || [reply.message];
    emitBotMessages(chatId, texts, {
      widgetStatus: reply.widgetStatus,
      agentsOnline: reply.agentsOnline
    });

    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to('agents').emit('chat:updated', updated);
    io.to('agents').emit('chat:escalated', updated);

    alerts.notifyStaff({
      type: reply.type === 'complaint' ? 'Complaint' : 'Needs attention',
      chatId,
      name: chat.customer_name,
      contact: chat.customer_contact,
      message: userMessage,
      reason: reply.reason || reply.type
    }).catch(() => {});

    if (reply.agentsOnline === false) {
      // offline form already emitted
    }
    return;
  }

  if (reply.type === 'miss' || reply.type === 'clarify') {
    if (reply.type === 'miss') {
      store.recordUnanswered(userMessage, chatId);
    }
  }

  emitBotMessages(chatId, [reply.message], {
    source: reply.source,
    sourceType: reply.sourceType,
    quickReplies: reply.quickReplies
  });
}

// Retention once per hour
setInterval(() => {
  try {
    const r = store.runRetention();
    if (r.deleted) console.log('Retention deleted chats:', r.deleted);
  } catch (_) {}
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Hama Enterprise Ng Chat Support on port ${PORT}`);
  console.log(`DATA_DIR: ${process.env.DATA_DIR || './data'}`);
  if (process.env.DATABASE_URL) {
    console.log('DATABASE_URL is set — use external Postgres for long-term durability (see README).');
  }
});
