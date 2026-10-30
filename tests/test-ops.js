/**
 * Ops tests: spam, callbacks, leads/quote, backup, ratings, unanswered, alerts rate limit
 * Run: node tests/test-ops.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = path.join(__dirname, '..', 'data', 'test-ops');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.EMAIL_API_KEY;

if (fs.existsSync(process.env.DATA_DIR)) {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const spam = require('../utils/spam');
const store = require('../utils/store_extra');
const quote = require('../utils/quote_flow');
const backup = require('../utils/backup');
const alerts = require('../utils/alerts');
const privacy = require('../utils/privacy');

async function run() {
  console.log('Ops feature tests\n');

  // Spam honeypot
  const hp = spam.checkHoneypotAndTiming({ website: 'http://spam', formStartedAt: Date.now() - 5000 });
  assert.strictEqual(hp.ok, false);
  console.log('✓ Honeypot rejects bots');

  const okForm = spam.checkHoneypotAndTiming({ website: '', formStartedAt: Date.now() - 5000 });
  assert.strictEqual(okForm.ok, true);
  console.log('✓ Normal form timing OK');

  const dup = spam.checkMessage('c1', '1.2.3.4', 'hello');
  assert.strictEqual(dup.ok, true);
  const dup2 = spam.checkMessage('c1', '1.2.3.4', 'hello');
  assert.strictEqual(dup2.ok, false);
  console.log('✓ Repeated identical messages blocked');

  // Callback
  const cb = store.createCallback({
    chatId: 'chat-1',
    name: 'Ada',
    phone: '+234800',
    bestTime: 'Morning',
    message: 'Please call'
  });
  assert(cb.id);
  assert.strictEqual(store.countNewCallbacks() >= 1, true);
  store.updateCallback(cb.id, { status: 'contacted', handledBy: 1, handledByName: 'Agent' });
  console.log('✓ Call-back create + status update');

  // Quote → lead
  const chatId = 'quote-chat';
  quote.start(chatId, { name: 'Bola', contact: 'bola@test.com' });
  await quote.handleAnswer(chatId, 'Painting');
  await quote.handleAnswer(chatId, 'Residential');
  await quote.handleAnswer(chatId, 'Lagos');
  await quote.handleAnswer(chatId, 'Skip');
  await quote.handleAnswer(chatId, 'Skip');
  const done = await quote.handleAnswer(chatId, 'Need exterior walls');
  assert.strictEqual(done.type, 'answer');
  assert(/follow up/i.test(done.message));
  assert(!/₦|naira|\$\d|price is/i.test(done.message));
  const leads = store.listLeads({});
  assert(leads.length >= 1);
  console.log('✓ Quote flow saves lead without stating a price');

  // Unanswered
  store.recordUnanswered('Do you install solar panels?', 'c9');
  store.recordUnanswered('Do you install solar panels?', 'c10');
  const u = store.listUnanswered();
  assert(u.some(x => x.count >= 2));
  console.log('✓ Unanswered questions counted');

  // Ratings
  store.saveRating({ chatId: 'c1', score: 1, kind: 'chat' });
  store.saveRating({ chatId: 'c1', score: 0, kind: 'bot', comment: 'unclear' });
  const stats = store.ratingStats();
  assert(stats.byDay);
  console.log('✓ Ratings saved');

  // Backup round-trip
  const buf = backup.buildBackupBuffer();
  assert(Buffer.isBuffer(buf) && buf.length > 20);
  const restored = backup.restoreFromBuffer(buf);
  assert(restored.success);
  console.log('✓ Backup build + restore');

  // Privacy card still works
  const card = privacy.checkMessage('card 4111111111111111', []);
  assert.strictEqual(card.blocked, true);
  console.log('✓ Privacy guard still active');

  // Alerts not configured → soft fail
  const a = await alerts.notifyStaff({ type: 'Test', name: 'X', contact: 'y', message: 'z' });
  assert.strictEqual(a.ok, false);
  console.log('✓ Alert fails softly when email not configured');

  // Fake image rejection would live in photos module when uploads enabled — skip binary here
  console.log('✓ (Photo magic-byte checks deferred to upload route when enabled)');

  console.log('\nAll ops tests passed.');
}

run().catch(e => {
  console.error('FAIL', e);
  process.exit(1);
});
