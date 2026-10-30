/**
 * Staff alerts via Resend or Brevo (HTTPS). Optional WhatsApp Cloud API.
 * Never throws into the chat path — all errors are logged only.
 */
const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

function ratePath() {
  const d = dataDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'alert_rate.json');
}

function loadRate() {
  try {
    return JSON.parse(fs.readFileSync(ratePath(), 'utf8'));
  } catch {
    return { chats: {}, hourBucket: '', hourCount: 0, summarySentAt: 0 };
  }
}

function saveRate(r) {
  try {
    fs.writeFileSync(ratePath(), JSON.stringify(r));
  } catch (_) {}
}

function enabled() {
  return !!(process.env.EMAIL_API_KEY && process.env.ALERT_EMAILS);
}

function recipientList() {
  return String(process.env.ALERT_EMAILS || '')
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function dashboardBase() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
}

async function sendEmail({ subject, html, text }) {
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const key = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM || 'Hama Support <onboarding@resend.dev>';
  const to = recipientList();
  if (!key || !to.length) return { ok: false, error: 'EMAIL_API_KEY or ALERT_EMAILS not set' };

  try {
    if (provider === 'brevo' || provider === 'sendinblue') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': key,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'Hama Support', email: from.includes('<') ? from.replace(/.*<([^>]+)>.*/, '$1') : from },
          to: to.map(email => ({ email })),
          subject,
          htmlContent: html,
          textContent: text
        })
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: 'Brevo error: ' + body.slice(0, 200) };
      }
      return { ok: true };
    }

    // Default: Resend
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html, text })
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: 'Resend error: ' + body.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Email send failed' };
  }
}

async function sendWhatsApp(text) {
  const token = process.env.WHATSAPP_TOKEN;
  const to = process.env.WHATSAPP_TO;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !to || !phoneId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(to).replace(/\D/g, ''),
        type: 'text',
        text: { body: text.slice(0, 1000) }
      })
    });
    if (!res.ok) return { ok: false, error: 'WhatsApp API failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * @param {{ type: string, chatId?: string, name?: string, contact?: string, message?: string, reason?: string }}
 */
async function notifyStaff(payload) {
  try {
    if (!enabled() && !(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_TO)) {
      return { ok: false, error: 'Alerts not configured' };
    }

    const rate = loadRate();
    const now = Date.now();
    const chatKey = payload.chatId || payload.type + ':' + (payload.contact || '');

    // Per-chat: max 1 email / 10 minutes
    if (payload.chatId && rate.chats[chatKey] && now - rate.chats[chatKey] < 10 * 60 * 1000) {
      return { ok: false, rateLimited: true, error: 'Alert already sent for this chat in the last 10 minutes' };
    }

    // Hourly summary throttle when many arrive
    const hour = new Date().toISOString().slice(0, 13);
    if (rate.hourBucket !== hour) {
      rate.hourBucket = hour;
      rate.hourCount = 0;
    }
    rate.hourCount += 1;
    if (rate.hourCount > 20 && now - (rate.summarySentAt || 0) < 60 * 60 * 1000) {
      // Still allow first of hour burst; after 20, only one summary-style per hour
      if (rate.summarySentAt && now - rate.summarySentAt < 60 * 60 * 1000) {
        return { ok: false, rateLimited: true, error: 'Hourly alert limit reached' };
      }
      rate.summarySentAt = now;
    }

    const link = payload.chatId
      ? `${dashboardBase()}/dashboard?chat=${encodeURIComponent(payload.chatId)}`
      : `${dashboardBase()}/dashboard`;

    const subject = `[Hama] ${payload.type}: ${payload.name || 'Visitor'}`;
    const text = [
      `Type: ${payload.type}`,
      `Name: ${payload.name || '-'}`,
      `Contact: ${payload.contact || '-'}`,
      `Reason: ${payload.reason || '-'}`,
      `Message: ${payload.message || '-'}`,
      `Time: ${new Date().toISOString()}`,
      `Open: ${link}`
    ].join('\n');

    const html = `<p><strong>${escapeHtml(payload.type)}</strong></p>
      <p>Name: ${escapeHtml(payload.name || '-')}<br/>
      Contact: ${escapeHtml(payload.contact || '-')}<br/>
      Reason: ${escapeHtml(payload.reason || '-')}<br/>
      Time: ${new Date().toISOString()}</p>
      <p>Message:<br/>${escapeHtml(payload.message || '-')}</p>
      <p><a href="${link}">Open in dashboard</a></p>`;

    const emailResult = await sendEmail({ subject, html, text });
    await sendWhatsApp(text).catch(() => {});

    if (emailResult.ok && payload.chatId) {
      rate.chats[chatKey] = now;
      // prune old
      for (const k of Object.keys(rate.chats)) {
        if (now - rate.chats[k] > 24 * 60 * 60 * 1000) delete rate.chats[k];
      }
      saveRate(rate);
    }

    return emailResult;
  } catch (err) {
    console.error('notifyStaff failed', err.message);
    return { ok: false, error: 'Alert failed' };
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTestAlert() {
  return notifyStaff({
    type: 'Test alert',
    name: 'Admin',
    contact: 'test@hama',
    message: 'This is a test alert from Hama Support settings.',
    reason: 'manual_test'
  });
}

module.exports = {
  enabled,
  notifyStaff,
  sendTestAlert,
  sendEmail,
  recipientList
};
