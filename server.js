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
const { socketAuth } = require('./middleware/auth');
const bot = require('./utils/bot');
const privacy = require('./utils/privacy');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const documentRoutes = require('./routes/documents');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/documents', documentRoutes);

const alertCooldown = new Map();
async function sendStaffAlert(kind, record) {
  try {
    const recipients = String(process.env.ALERT_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
    const key = record.chat_id || record.chatId || record.id || kind;
    const now = Date.now();
    if (alertCooldown.has(String(key)) && now - alertCooldown.get(String(key)) < 10 * 60 * 1000) return { skipped: true };
    if (!recipients.length || !process.env.EMAIL_API_KEY) return { skipped: true, reason: 'Email alerts are not configured.' };
    const provider = String(process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
    const subject = 'Hama support: ' + kind;
    const text = ['Visitor: ' + (record.visitor_name || record.customer_name || 'Unknown'), 'Contact: ' + (record.contact || record.phone || record.customer_contact || 'Not provided'), 'First message: ' + (record.message || record.first_message || 'Not provided'), 'Reason: ' + kind, 'Time: ' + new Date().toISOString(), 'Dashboard: ' + (process.env.DASHBOARD_URL || '')].join('\\n');
    let response;
    if (provider === 'resend') {
      response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.EMAIL_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Hama Support <onboarding@resend.dev>', to: recipients, subject, text }) });
    } else if (provider === 'brevo') {
      response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.EMAIL_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: { email: process.env.EMAIL_FROM }, to: recipients.map(email => ({ email })), subject, textContent: text }) });
    } else return { error: 'EMAIL_PROVIDER must be resend or brevo.' };
    if (!response.ok) return { error: 'Email provider rejected the alert.' };
    alertCooldown.set(String(key), now);
    return { sent: true };
  } catch (_) { return { error: 'Email alert failed; chat service remains available.' }; }
}

app.post('/api/callbacks', async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  const phone = typeof b.phone === 'string' ? b.phone.trim().slice(0, 40) : '';
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2000) : '';
  if (!name || !phone || !/^[+0-9()\\- \\t]{7,40}$/.test(phone)) return res.status(400).json({ error: 'Enter your name and a valid phone number.' });
  const chat = b.chatId ? db.prepare('SELECT id, customer_name, customer_contact FROM chats WHERE id = ?').get(String(b.chatId)) : null;
  const result = db.prepare('INSERT INTO callback_requests (chat_id, visitor_name, phone, best_time, message) VALUES (?, ?, ?, ?, ?)').run(chat ? chat.id : null, name, phone, String(b.bestTime || '').slice(0, 120), message || null);
  await sendStaffAlert('Call-back requested', { id: result.lastInsertRowid, chat_id: chat && chat.id, visitor_name: name, phone, message });
  res.status(201).json({ success: true, id: result.lastInsertRowid, message: 'Your call-back request has been saved.' });
});

app.post('/api/leads', async (req, res) => {
  const b = req.body || {};
  const allowedServices = ['painting', 'interior design', 'exterior design'];
  const allowedTypes = ['residential', 'commercial', 'industrial'];
  const name = typeof b.visitor_name === 'string' ? b.visitor_name.trim().slice(0, 120) : '';
  const contact = typeof b.contact === 'string' ? b.contact.trim().slice(0, 120) : '';
  const service = String(b.service || '').toLowerCase();
  const propertyType = String(b.property_type || '').toLowerCase();
  const location = typeof b.location === 'string' ? b.location.trim().slice(0, 200) : '';
  if (!name || !contact || !allowedServices.includes(service) || !allowedTypes.includes(propertyType) || !location) return res.status(400).json({ error: 'Complete the required quote request fields.' });
  const chat = b.chat_id ? db.prepare('SELECT id FROM chats WHERE id = ?').get(String(b.chat_id)) : null;
  const result = db.prepare('INSERT INTO leads (chat_id, visitor_name, contact, service, property_type, location, project_size, preferred_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(chat ? chat.id : null, name, contact, service, propertyType, location, String(b.project_size || '').slice(0, 200), String(b.preferred_date || '').slice(0, 80), String(b.notes || '').slice(0, 2000));
  await sendStaffAlert('New quote lead', { id: result.lastInsertRowid, chat_id: chat && chat.id, visitor_name: name, contact, message: service + ' / ' + propertyType + ' / ' + location });
  res.status(201).json({ success: true, id: result.lastInsertRowid, status: 'New', message: 'Your request has been saved. Our team will follow up. No price is estimated in this form.' });
});

app.post('/api/ratings', (req, res) => {
  const b = req.body || {};
  if (!b.chat_id || ![-1, 1].includes(Number(b.rating))) return res.status(400).json({ error: 'A chat and thumbs-up or thumbs-down rating are required.' });
  const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(String(b.chat_id));
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  const result = db.prepare('INSERT INTO ratings (chat_id, message_id, rating, comment) VALUES (?, ?, ?, ?)').run(chat.id, b.message_id ? Number(b.message_id) : null, Number(b.rating), String(b.comment || '').slice(0, 1000));
  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', company: 'Hama Enterprise Ng', time: new Date().toISOString() });
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

app.get('/widget.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

const agentSockets = new Map();

io.use(socketAuth);

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id} user=${socket.user?.username || 'customer'}`);

  if (socket.user) {
    agentSockets.set(socket.user.id, socket.id);
    socket.join('agents');
    db.prepare('UPDATE users SET online = 1 WHERE id = ?').run(socket.user.id);
    io.to('agents').emit('agent:status', { userId: socket.user.id, online: true, name: socket.user.name });

    const openChats = db.prepare(`
      SELECT * FROM chats
      WHERE status IN ('bot', 'needs_attention', 'with_agent')
         OR datetime(updated_at) >= datetime('now', '-14 days')
      ORDER BY CASE
        WHEN is_complaint = 1 AND status = 'needs_attention' THEN 0
        WHEN status = 'needs_attention' THEN 1
        WHEN status = 'with_agent' THEN 2
        WHEN status = 'bot' THEN 3
        ELSE 4 END,
        updated_at DESC
      LIMIT 150
    `).all();
    socket.emit('chats:list', openChats);
  }

  socket.on('customer:start', (data, cb) => {
    try {
      const { name, contact, contactType } = data || {};
      if (!name || !contact) return cb?.({ error: 'Name and contact required' });

      const chatId = uuidv4();
      db.prepare(`INSERT INTO chats (id, customer_name, customer_contact, contact_type, status) VALUES (?, ?, ?, ?, 'bot')`)
        .run(chatId, name.trim(), contact.trim(), contactType === 'email' ? 'email' : 'phone');

      const greeting = bot.getGreeting();
      db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'bot', 'Hama Support Bot', ?)`)
        .run(chatId, greeting);

      socket.join(`chat:${chatId}`);
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at').all(chatId);
      io.to('agents').emit('chat:new', chat);
      cb?.({ chatId, messages, quickReplies: bot.getQuickReplies() });
    } catch (err) {
      console.error('customer:start error', err);
      cb?.({ error: 'Failed to start chat' });
    }
  });

  socket.on('message:send', (data, cb) => {
    try {
      const { chatId, content, isInternal } = data || {};
      if (!chatId || !content || !content.trim()) return cb?.({ error: 'chatId and content required' });

      let chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat) return cb?.({ error: 'Chat not found' });

      const isAgent = !!socket.user;
      const senderType = isAgent ? (isInternal ? 'system' : 'agent') : 'customer';
      const senderName = isAgent ? socket.user.name : chat.customer_name;
      const internal = isAgent && isInternal ? 1 : 0;

      let textToStore = content.trim();
      let privacyBlocked = false;

      // Privacy guard for visitor messages
      if (!isAgent && !internal) {
        const history = db.prepare(
          'SELECT sender_type, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 8'
        ).all(chatId).reverse();
        const check = privacy.checkMessage(textToStore, history);
        textToStore = check.maskedContent;
        if (check.blocked) {
          privacyBlocked = true;
        }
      }

      if (!internal && chat.status === 'resolved') {
        if (isAgent) {
          db.prepare(`UPDATE chats SET status = 'with_agent', agent_id = ?, agent_name = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(socket.user.id, socket.user.name, chatId);
        } else {
          db.prepare(`UPDATE chats SET status = 'needs_attention', updated_at = datetime('now') WHERE id = ?`).run(chatId);
        }
        chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
        io.to('agents').emit('chat:updated', chat);
        io.to(`chat:${chatId}`).emit('chat:updated', chat);
      }

      const result = db.prepare(
        `INSERT INTO messages (chat_id, sender_type, sender_name, content, is_internal) VALUES (?, ?, ?, ?, ?)`
      ).run(chatId, senderType, senderName, textToStore, internal);

      db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);

      const message = {
        id: result.lastInsertRowid,
        chat_id: chatId,
        sender_type: senderType,
        sender_name: senderName,
        content: textToStore,
        is_internal: internal,
        created_at: new Date().toISOString()
      };

      if (internal) {
        io.to('agents').emit('message:new', { ...message, chatId });
      } else {
        io.to(`chat:${chatId}`).emit('message:new', message);
        io.to('agents').emit('message:new', { ...message, chatId });
      }

      if (privacyBlocked) {
        emitBotMessages(chatId, [privacy.SAFETY_REPLY], null);
        cb?.({ success: true, message, privacyBlocked: true });
        return;
      }

      const latest = db.prepare('SELECT status FROM chats WHERE id = ?').get(chatId);
      if (!isAgent && latest && latest.status === 'bot') {
        handleBotReply(chatId, content.trim()).catch(err => console.error('bot reply error', err));
      }

      cb?.({ success: true, message });
    } catch (err) {
      console.error('message:send error', err);
      cb?.({ error: 'Failed to send message' });
    }
  });

  socket.on('typing:start', ({ chatId }) => {
    if (!chatId) return;
    const isAgent = !!socket.user;
    socket.to(`chat:${chatId}`).emit('typing', { chatId, who: isAgent ? (socket.user.name || 'Agent') : 'customer', isAgent });
    if (!isAgent) io.to('agents').emit('typing', { chatId, who: 'customer', isAgent: false });
  });

  socket.on('typing:stop', ({ chatId }) => {
    if (!chatId) return;
    socket.to(`chat:${chatId}`).emit('typing:stop', { chatId });
    io.to('agents').emit('typing:stop', { chatId });
  });

  socket.on('chat:join', ({ chatId }) => {
    if (!socket.user || !chatId) return;
    socket.join(`chat:${chatId}`);
  });

  socket.on('chat:takeover', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return cb?.({ error: 'Chat not found' });

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
    const sysMsg = 'Chat returned to automated support.';
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'system', 'System', ?)`).run(chatId, sysMsg);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
    io.to('agents').emit('chat:updated', updated);
    cb?.({ success: true });
  });

  socket.on('chat:transfer', ({ chatId, toAgentId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(toAgentId);
    if (!target) return cb?.({ error: 'Target agent not found' });
    db.prepare(`UPDATE chats SET agent_id = ?, agent_name = ?, status = 'with_agent', updated_at = datetime('now') WHERE id = ?`)
      .run(target.id, target.name, chatId);
    const sysMsg = `Chat transferred to ${target.name}.`;
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'system', 'System', ?)`).run(chatId, sysMsg);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
    io.to('agents').emit('chat:updated', updated);
    const targetSocketId = agentSockets.get(target.id);
    if (targetSocketId) io.to(targetSocketId).emit('chat:assigned', updated);
    cb?.({ success: true });
  });

  socket.on('chat:resolve', ({ chatId }, cb) => {
    if (!socket.user) return cb?.({ error: 'Unauthorized' });
    db.prepare(`UPDATE chats SET status = 'resolved', updated_at = datetime('now') WHERE id = ?`).run(chatId);
    const sysMsg = 'This chat was marked resolved. You can still send a message if needed.';
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'system', 'System', ?)`).run(chatId, sysMsg);
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to(`chat:${chatId}`).emit('chat:updated', updated);
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

  socket.on('customer:offline-contact', (data, cb) => {
    const { chatId, name, contact, message } = data || {};
    db.prepare(`INSERT INTO offline_requests (chat_id, customer_name, contact, message) VALUES (?, ?, ?, ?)`)
      .run(chatId || null, name || null, contact || null, message || null);
    io.to('agents').emit('offline:request', { name, contact, message, created_at: new Date().toISOString() });
    sendStaffAlert('Call-back requested', { chat_id: chatId || null, visitor_name: name, contact, message }).catch(() => {});
    cb?.({ success: true, message: 'Thank you. Our team will contact you soon.' });
  });

  socket.on('disconnect', () => {
    if (socket.user) {
      agentSockets.delete(socket.user.id);
      db.prepare('UPDATE users SET online = 0 WHERE id = ?').run(socket.user.id);
      io.to('agents').emit('agent:status', { userId: socket.user.id, online: false, name: socket.user.name });
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
      chat_id: chatId,
      sender_type: 'bot',
      sender_name: 'Hama Support Bot',
      content: text,
      source_label: sourceLabel,
      created_at: new Date().toISOString(),
      quickReplies: meta.quickReplies
    };
    io.to(`chat:${chatId}`).emit('message:new', { ...message, source_label: undefined });
    io.to('agents').emit('message:new', { ...message, chatId });
  }
  if (meta.widgetStatus) {
    io.to(`chat:${chatId}`).emit('widget:status', { status: meta.widgetStatus });
  }
  if (meta.agentsOnline === false) {
    io.to(`chat:${chatId}`).emit('show:offline-form');
  }
}

async function handleBotReply(chatId, userMessage) {
  const history = db
    .prepare('SELECT sender_type, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(chatId)
    .reverse();

  const reply = await bot.getBotReply(userMessage, history);

  if (reply.type === 'complaint') {
    db.prepare(`
      UPDATE chats SET status = 'needs_attention', is_complaint = 1,
        complaint_preview = ?, updated_at = datetime('now') WHERE id = ?
    `).run((userMessage || '').slice(0, 500), chatId);

    emitBotMessages(chatId, reply.messages || [reply.message], {
      widgetStatus: reply.widgetStatus,
      agentsOnline: reply.agentsOnline
    });

    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to('agents').emit('chat:updated', updated);
    io.to('agents').emit('chat:escalated', updated);
    sendStaffAlert('Customer complaint', { chat_id: chatId, visitor_name: updated.customer_name, contact: updated.customer_contact, message: userMessage }).catch(() => {});
    return;
  }

  if (reply.type === 'escalate') {
    db.prepare(`UPDATE chats SET status = 'needs_attention', updated_at = datetime('now') WHERE id = ?`).run(chatId);
    emitBotMessages(chatId, [reply.message], {
      widgetStatus: reply.widgetStatus,
      agentsOnline: reply.agentsOnline
    });
    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to('agents').emit('chat:updated', updated);
    io.to('agents').emit('chat:escalated', updated);
    sendStaffAlert('Chat needs a person', { chat_id: chatId, visitor_name: updated.customer_name, contact: updated.customer_contact, message: userMessage }).catch(() => {});
    return;
  }

  // Record low-confidence questions so the admin can improve the knowledge base.
  if (reply.type === 'miss' || reply.type === 'clarify' || reply.type === 'escalate') {
    const normalized = String(userMessage || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (normalized) db.prepare("INSERT INTO unanswered_questions (question, normalized) VALUES (?, ?) ON CONFLICT(normalized) DO UPDATE SET count = count + 1, last_asked_at = datetime('now')").run(String(userMessage).slice(0, 500), normalized);
  }

  // answer, clarify, miss
  emitBotMessages(chatId, [reply.message], {
    source: reply.source,
    sourceType: reply.sourceType,
    quickReplies: reply.quickReplies
  });
}

server.listen(PORT, () => {
  console.log(`\nHama Enterprise Ng Chat Support on port ${PORT}`);
  console.log(`DATA_DIR: ${process.env.DATA_DIR || './data'}`);
});
