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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', company: 'Hama Enterprise Ng', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
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

    // Load open chats + recent resolved so refresh does not look empty
    const openChats = db.prepare(`
      SELECT * FROM chats
      WHERE status IN ('bot', 'needs_attention', 'with_agent')
         OR datetime(updated_at) >= datetime('now', '-14 days')
      ORDER BY CASE status
        WHEN 'needs_attention' THEN 0
        WHEN 'with_agent' THEN 1
        WHEN 'bot' THEN 2
        ELSE 3 END,
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

      // Keep chat editable: reopen if resolved when someone replies
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

      const result = db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content, is_internal) VALUES (?, ?, ?, ?, ?)`)
        .run(chatId, senderType, senderName, content.trim(), internal);

      db.prepare(`UPDATE chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);

      const message = {
        id: result.lastInsertRowid,
        chat_id: chatId,
        sender_type: senderType,
        sender_name: senderName,
        content: content.trim(),
        is_internal: internal,
        created_at: new Date().toISOString()
      };

      if (internal) {
        io.to('agents').emit('message:new', { ...message, chatId });
      } else {
        io.to(`chat:${chatId}`).emit('message:new', message);
        io.to('agents').emit('message:new', { ...message, chatId });
      }

      // Bot only while status is still bot
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

async function handleBotReply(chatId, userMessage) {
  const history = db.prepare('SELECT sender_type, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10').all(chatId).reverse();
  const reply = await bot.getBotReply(userMessage, history);

  const sourceLabel = reply.source
    ? (reply.sourceType === 'qa' ? `Q&A: ${reply.source}` : reply.source)
    : null;

  if (reply.type === 'escalate') {
    db.prepare(`UPDATE chats SET status = 'needs_attention', updated_at = datetime('now') WHERE id = ?`).run(chatId);

    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content, source_label) VALUES (?, 'bot', 'Hama Support Bot', ?, ?)`) 
      .run(chatId, reply.message, sourceLabel);

    const message = {
      chat_id: chatId, sender_type: 'bot', sender_name: 'Hama Support Bot',
      content: reply.message, source_label: sourceLabel, created_at: new Date().toISOString()
    };
    io.to(`chat:${chatId}`).emit('message:new', message);
    io.to('agents').emit('message:new', { ...message, chatId });

    const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    io.to('agents').emit('chat:updated', updated);
    io.to('agents').emit('chat:escalated', updated);

    const onlineAgents = db.prepare('SELECT COUNT(*) as c FROM users WHERE online = 1 AND role IN ("admin","agent")').get().c;
    if (onlineAgents === 0) {
      const offlineMsg = 'No agents are currently online. Please leave your phone or email and we will get back to you as soon as possible.';
      db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content) VALUES (?, 'bot', 'Hama Support Bot', ?)`).run(chatId, offlineMsg);
      io.to(`chat:${chatId}`).emit('message:new', {
        chat_id: chatId, sender_type: 'bot', sender_name: 'Hama Support Bot', content: offlineMsg, created_at: new Date().toISOString()
      });
      io.to(`chat:${chatId}`).emit('show:offline-form');
    }
  } else {
    db.prepare(`INSERT INTO messages (chat_id, sender_type, sender_name, content, source_label) VALUES (?, 'bot', 'Hama Support Bot', ?, ?)`) 
      .run(chatId, reply.message, sourceLabel);

    const message = {
      chat_id: chatId, sender_type: 'bot', sender_name: 'Hama Support Bot',
      content: reply.message, source_label: sourceLabel,
      created_at: new Date().toISOString(), quickReplies: reply.quickReplies
    };
    io.to(`chat:${chatId}`).emit('message:new', { ...message, source_label: undefined });
    io.to('agents').emit('message:new', { ...message, chatId });
  }
}

server.listen(PORT, () => {
  console.log(`\nHama Enterprise Ng Chat Support on port ${PORT}`);
  console.log(`DATA_DIR: ${process.env.DATA_DIR || './data'}`);
});
