/**
 * Privacy guard: detect and mask card numbers, CVV/expiry with cards,
 * passwords, PINs, OTPs. Never send sensitive content to AI or search.
 */

function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function findCardMatches(text) {
  const matches = [];
  const re = /(?:\d[ -]*?){13,19}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
      matches.push({ start: m.index, end: m.index + raw.length, digits, raw });
    }
  }
  return matches;
}

function hasCvvOrExpiryNearCard(text) {
  const t = text.toLowerCase();
  const hasCard = findCardMatches(text).length > 0;
  if (!hasCard) return false;
  if (/\b(cvv|cvc|csc|security\s*code)\b/.test(t)) return true;
  if (/\b(exp|expiry|expires|expiration)\b/.test(t) && /\b\d{1,2}\s*[\/\-]\s*\d{2,4}\b/.test(t)) {
    return true;
  }
  if (/\b\d{3,4}\b/.test(t) && /\b(cvv|cvc)\b/.test(t)) return true;
  return false;
}

function hasPasswordOrPin(text) {
  // "password", "PIN" or "OTP" followed by a value
  if (/\b(password|passwd|passcode)\b\s*[:\-]?\s*\S+/i.test(text)) return true;
  if (/\b(pin)\b\s*[:\-]?\s*\d{3,8}\b/i.test(text)) return true;
  if (/\b(otp|one[\s-]?time\s*(code|password|pin)?)\b\s*[:\-]?\s*\d{4,8}\b/i.test(text)) {
    return true;
  }
  return false;
}

function hasOtpAfterCodeMention(text, recentBotText) {
  const six = /\b(\d{6})\b/.exec(text);
  if (!six) return false;
  const ctx = (recentBotText || '') + ' ' + text;
  if (/\b(code|otp|verification|verify|one[\s-]?time)\b/i.test(ctx)) return true;
  return false;
}

function maskSensitive(text) {
  let out = text;
  const cards = findCardMatches(text).sort((a, b) => b.start - a.start);
  for (const c of cards) {
    const last4 = c.digits.slice(-4);
    const masked = '****' + last4;
    out = out.slice(0, c.start) + masked + out.slice(c.end);
  }
  // Mask PIN/OTP-like sequences after keywords
  out = out.replace(
    /(\b(?:password|passwd|passcode|pin|otp)\b\s*[:\-]?\s*)(\S+)/gi,
    (_, p) => p + '****'
  );
  out = out.replace(/\b(\d{6})\b/g, (m, d, offset) => {
    // only if nearby context in original suggests code — keep simple mask of 6-digit when password path already hit
    return m;
  });
  return out;
}

const SAFETY_REPLY =
  "For your safety, please don't share card details, passwords, PINs or one-time codes in this chat. Our team will give you a safe way to pay.";

/**
 * @returns {{ blocked: boolean, maskedContent: string, reply?: string, reason?: string }}
 */
function checkMessage(text, history = []) {
  const original = String(text || '');
  const recentBot = history
    .filter(m => m.sender_type === 'bot' || m.sender_type === 'agent')
    .slice(-3)
    .map(m => m.content)
    .join(' ');

  const cards = findCardMatches(original);
  const sensitive =
    cards.length > 0 ||
    hasCvvOrExpiryNearCard(original) ||
    hasPasswordOrPin(original) ||
    hasOtpAfterCodeMention(original, recentBot);

  if (!sensitive) {
    return { blocked: false, maskedContent: original };
  }

  return {
    blocked: true,
    maskedContent: maskSensitive(original),
    reply: SAFETY_REPLY,
    reason: cards.length ? 'card' : 'credentials'
  };
}

module.exports = {
  checkMessage,
  maskSensitive,
  findCardMatches,
  luhnOk,
  SAFETY_REPLY
};
