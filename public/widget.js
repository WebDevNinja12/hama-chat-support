/**
 * Hama Enterprise Ng - Embeddable Live Chat Widget
 */
(function () {
  'use strict';

  const SCRIPT = document.currentScript;
  const SERVER = (SCRIPT && SCRIPT.src) ? SCRIPT.src.replace(/\/widget\.js.*$/, '') : window.location.origin;
  const BRAND = {
    primary: '#0D7377', primaryDark: '#095456', accent: '#E85D04',
    bg: '#FFFFFF', text: '#1A1A2E', muted: '#6B7280',
    botBg: '#F0FDFA', customerBg: '#0D7377', border: '#E5E7EB'
  };

  if (window.__HAMA_CHAT_LOADED) return;
  window.__HAMA_CHAT_LOADED = true;

  const style = document.createElement('style');
  style.textContent = `
    #hama-chat-root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #hama-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99998;
      width: 60px; height: 60px; border-radius: 50%;
      background: ${BRAND.primary}; color: white; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(13,115,119,0.4);
      display: flex; align-items: center; justify-content: center;
    }
    #hama-chat-btn svg { width: 28px; height: 28px; }
    #hama-chat-window {
      position: fixed; bottom: 100px; right: 24px; z-index: 99999;
      width: 380px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 120px);
      background: ${BRAND.bg}; border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.18);
      display: none; flex-direction: column; overflow: hidden;
      border: 1px solid ${BRAND.border};
    }
    #hama-chat-window.open { display: flex; }
    .hama-header {
      background: linear-gradient(135deg, ${BRAND.primary}, ${BRAND.primaryDark});
      color: white; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
    }
    .hama-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .hama-header p { margin: 2px 0 0; font-size: 12px; opacity: 0.85; }
    .hama-status {
      display: none; font-size: 12px; padding: 6px 12px; background: #FFF7ED; color: #9A3412;
      border-bottom: 1px solid #FED7AA; text-align: center;
    }
    .hama-status.show { display: block; }
    .hama-close { background: transparent; border: none; color: white; font-size: 22px; cursor: pointer; }
    .hama-body { flex: 1; overflow-y: auto; padding: 16px; background: #F9FAFB; }
    .hama-msg { margin-bottom: 12px; max-width: 85%; }
    .hama-msg.bot, .hama-msg.system { margin-right: auto; }
    .hama-msg.customer { margin-left: auto; }
    .hama-bubble {
      padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5;
      word-wrap: break-word; white-space: pre-wrap;
    }
    .hama-msg.bot .hama-bubble { background: ${BRAND.botBg}; color: ${BRAND.text}; border-bottom-left-radius: 4px; }
    .hama-msg.customer .hama-bubble { background: ${BRAND.customerBg}; color: white; border-bottom-right-radius: 4px; }
    .hama-msg.system .hama-bubble { background: #FEF3C7; color: #92400E; font-size: 13px; text-align: center; }
    .hama-meta { font-size: 11px; color: ${BRAND.muted}; margin-top: 4px; }
    .hama-msg.customer .hama-meta { text-align: right; }
    .hama-typing { font-size: 13px; color: ${BRAND.muted}; padding: 4px 8px; display: none; }
    .hama-typing.show { display: block; }
    .hama-quick { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
    .hama-quick button {
      background: white; border: 1px solid ${BRAND.primary}; color: ${BRAND.primary};
      border-radius: 20px; padding: 6px 12px; font-size: 12px; cursor: pointer;
    }
    .hama-footer { padding: 12px; border-top: 1px solid ${BRAND.border}; background: white; }
    .hama-input-row { display: flex; gap: 8px; }
    .hama-input-row input {
      flex: 1; border: 1px solid ${BRAND.border}; border-radius: 24px;
      padding: 10px 16px; font-size: 14px; outline: none;
    }
    .hama-send {
      width: 42px; height: 42px; border-radius: 50%; border: none;
      background: ${BRAND.primary}; color: white; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .hama-preform { padding: 20px 16px; }
    .hama-preform h4 { margin: 0 0 8px; }
    .hama-preform p { margin: 0 0 16px; font-size: 13px; color: ${BRAND.muted}; }
    .hama-preform label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
    .hama-preform input, .hama-preform select {
      width: 100%; padding: 10px 12px; border: 1px solid ${BRAND.border};
      border-radius: 8px; margin-bottom: 12px; font-size: 14px;
    }
    .hama-preform button {
      width: 100%; padding: 12px; background: ${BRAND.primary}; color: white;
      border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    .hama-offline-form { padding: 12px; background: #FEF3C7; border-radius: 8px; margin-top: 8px; display: none; }
    .hama-offline-form.show { display: block; }
    .hama-offline-form input { width: 100%; margin-bottom: 8px; padding: 8px; border-radius: 6px; border: 1px solid #FCD34D; }
    .hama-offline-form button { background: ${BRAND.accent}; color: white; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
    @media (max-width: 480px) {
      #hama-chat-window { bottom: 0; right: 0; width: 100%; height: 100%; max-height: 100%; border-radius: 0; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hama-chat-root';
  root.innerHTML = `
    <button id="hama-chat-btn" aria-label="Open support chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>
    <div id="hama-chat-window">
      <div class="hama-header">
        <div>
          <h3>Hama Enterprise Ng</h3>
          <p>Painting • Interior • Exterior</p>
        </div>
        <button class="hama-close" aria-label="Close">×</button>
      </div>
      <div class="hama-status" id="hama-status"></div>
      <div class="hama-body" id="hama-body">
        <div class="hama-preform" id="hama-preform">
          <h4>Welcome</h4>
          <p>Please introduce yourself so we can help you.</p>
          <label>Your name *</label>
          <input type="text" id="hama-name" placeholder="Full name" autocomplete="name" />
          <label>Contact *</label>
          <select id="hama-contact-type">
            <option value="phone">Phone number</option>
            <option value="email">Email address</option>
          </select>
          <input type="text" id="hama-contact" placeholder="Phone or email" autocomplete="tel" />
          <button id="hama-start-btn" type="button">Start Chat</button>
        </div>
      </div>
      <div class="hama-typing" id="hama-typing">Support is typing…</div>
      <div class="hama-footer" id="hama-footer" style="display:none;">
        <div class="hama-input-row">
          <input type="text" id="hama-input" placeholder="Type your message…" autocomplete="off" />
          <button class="hama-send" id="hama-send" type="button" aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  let socket = null;
  let chatId = null;
  const bodyEl = document.getElementById('hama-body');
  const typingEl = document.getElementById('hama-typing');
  const footerEl = document.getElementById('hama-footer');
  const inputEl = document.getElementById('hama-input');
  const windowEl = document.getElementById('hama-chat-window');
  const statusEl = document.getElementById('hama-status');

  function setStatus(text) {
    if (!text) {
      statusEl.classList.remove('show');
      statusEl.textContent = '';
      return;
    }
    statusEl.textContent = text;
    statusEl.classList.add('show');
  }

  function loadSocketIO(cb) {
    if (window.io) return cb();
    const s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function appendMessage(msg) {
    const div = document.createElement('div');
    div.className = 'hama-msg ' + (msg.sender_type === 'customer' ? 'customer' : msg.sender_type === 'system' ? 'system' : 'bot');
    let extra = '';
    if (msg.quickReplies && msg.quickReplies.length) {
      extra = '<div class="hama-quick">' +
        msg.quickReplies.map(q => '<button type="button" data-qr="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('') +
        '</div>';
    }
    div.innerHTML =
      '<div class="hama-bubble">' + escapeHtml(msg.content || '') + '</div>' +
      '<div class="hama-meta">' +
      (msg.sender_type !== 'system' ? escapeHtml(msg.sender_name || '') + ' · ' : '') +
      formatTime(msg.created_at) + '</div>' + extra;
    bodyEl.appendChild(div);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    div.querySelectorAll('[data-qr]').forEach(btn => {
      btn.addEventListener('click', () => {
        inputEl.value = btn.getAttribute('data-qr');
        sendMessage();
      });
    });
  }

  function showOfflineForm() {
    let form = document.getElementById('hama-offline');
    if (form) { form.classList.add('show'); return; }
    form = document.createElement('div');
    form.id = 'hama-offline';
    form.className = 'hama-offline-form show';
    form.innerHTML =
      '<p style="margin:0 0 8px;font-size:13px;"><strong>Leave your contact</strong> and we will get back to you.</p>' +
      '<input type="text" id="hama-off-contact" placeholder="Phone or email" />' +
      '<button type="button" id="hama-off-submit">Submit</button>';
    bodyEl.appendChild(form);
    document.getElementById('hama-off-submit').onclick = () => {
      const contact = document.getElementById('hama-off-contact').value.trim();
      if (!contact) return alert('Please enter a contact');
      socket.emit('customer:offline-contact', {
        chatId,
        name: document.getElementById('hama-name').value,
        contact,
        message: 'Callback requested – team offline'
      }, (res) => {
        form.innerHTML = '<p style="margin:0;font-size:13px;">' + escapeHtml(res.message || 'Thank you!') + '</p>';
      });
    };
  }

  function connectAndStart() {
    const name = document.getElementById('hama-name').value.trim();
    const contact = document.getElementById('hama-contact').value.trim();
    const contactType = document.getElementById('hama-contact-type').value;
    if (!name || !contact) {
      alert('Please fill in your name and contact.');
      return;
    }

    loadSocketIO(() => {
      socket = io(SERVER, { transports: ['websocket', 'polling'] });

      socket.on('connect', () => {
        socket.emit('customer:start', { name, contact, contactType }, (res) => {
          if (res.error) { alert(res.error); return; }
          chatId = res.chatId;
          document.getElementById('hama-preform').style.display = 'none';
          footerEl.style.display = 'block';
          (res.messages || []).forEach(appendMessage);
        });
      });

      socket.on('message:new', (msg) => {
        if (msg.chat_id !== chatId && msg.chatId !== chatId) return;
        if (msg.sender_type === 'customer') return;
        appendMessage(msg);
      });

      socket.on('typing', (data) => {
        if (data.chatId === chatId && data.isAgent) typingEl.classList.add('show');
      });
      socket.on('typing:stop', (data) => {
        if (data.chatId === chatId) typingEl.classList.remove('show');
      });

      socket.on('show:offline-form', showOfflineForm);
      socket.on('widget:status', (data) => setStatus(data && data.status));

      socket.on('chat:updated', (chat) => {
        if (chat.id !== chatId) return;
        if (chat.status === 'with_agent') setStatus('');
        if (chat.status === 'resolved') {
          inputEl.disabled = true;
          document.getElementById('hama-send').disabled = true;
        }
      });
    });
  }

  function sendMessage() {
    const content = inputEl.value.trim();
    if (!content || !chatId || !socket) return;
    appendMessage({
      sender_type: 'customer',
      sender_name: 'You',
      content,
      created_at: new Date().toISOString()
    });
    inputEl.value = '';
    socket.emit('message:send', { chatId, content });
    socket.emit('typing:stop', { chatId });
  }

  document.getElementById('hama-chat-btn').addEventListener('click', () => {
    windowEl.classList.toggle('open');
  });
  document.querySelector('.hama-close').addEventListener('click', () => {
    windowEl.classList.remove('open');
  });
  document.getElementById('hama-start-btn').addEventListener('click', connectAndStart);
  document.getElementById('hama-send').addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  inputEl.addEventListener('input', () => {
    if (chatId && socket) socket.emit('typing:start', { chatId });
  });
})();
