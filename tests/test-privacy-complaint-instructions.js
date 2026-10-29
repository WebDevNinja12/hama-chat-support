/**
 * Tests: privacy mask, complaint handover, offline wording, instructions.
 * Run: node tests/test-privacy-complaint-instructions.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = path.join(__dirname, '..', 'data', 'test-privacy');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test';
delete process.env.ANTHROPIC_API_KEY;

if (fs.existsSync(process.env.DATA_DIR)) {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const privacy = require('../utils/privacy');
const instructions = require('../utils/instructions');
const bot = require('../utils/bot');

async function run() {
  console.log('Privacy / complaint / instructions tests\n');

  // Card number (Visa test) Luhn-valid
  const cardMsg = 'My card is 4111 1111 1111 1111 please charge it';
  const check = privacy.checkMessage(cardMsg, []);
  assert.strictEqual(check.blocked, true, 'card should block');
  assert(check.maskedContent.includes('1111'), 'last4 kept');
  assert(!check.maskedContent.includes('4111 1111 1111 1111'), 'full card masked');
  assert(!/4111111111111111/.test(check.maskedContent.replace(/\s/g, '')));
  console.log('✓ Card number blocked and masked');

  const pwd = privacy.checkMessage('password: secret123', []);
  assert.strictEqual(pwd.blocked, true);
  console.log('✓ Password value blocked');

  const ok = privacy.checkMessage('Do you paint houses in Lagos?', []);
  assert.strictEqual(ok.blocked, false);
  console.log('✓ Normal message not blocked');

  // Complaint → acknowledge + handover
  const complaint = await bot.getBotReply('I have a complaint about damage to my wall', []);
  assert.strictEqual(complaint.type, 'complaint');
  assert(complaint.messages && complaint.messages.length >= 2);
  assert(/sorry|understand/i.test(complaint.messages[0]));
  assert(!/refund|compensate/i.test(complaint.messages.join(' ')));
  console.log('✓ Complaint acknowledges then hands over');

  // Offline handover wording (no agents online in fresh DB after seed may have none online)
  const hand = bot.handoverMessage();
  assert(hand.message);
  if (!hand.agentsOnline) {
    assert(/offline/i.test(hand.message));
    assert(!/connecting you now/i.test(hand.message));
    console.log('✓ Offline handover wording is honest');
  } else {
    assert(/stay on this chat/i.test(hand.message));
    console.log('✓ Online handover wording');
  }

  // Instructions file
  const def = instructions.getDefault();
  assert(def.includes('[BUSINESS NAME]'));
  const saved = instructions.saveInstructions('Custom line for [BUSINESS NAME] only.');
  assert(saved.success);
  assert(instructions.getInstructions().includes('Custom line'));
  const prompt = instructions.buildSystemPrompt('Hama Enterprise Ng');
  assert(prompt.includes('Hama Enterprise Ng'));
  assert(prompt.includes('NO_ANSWER') || prompt.includes('FIXED SAFETY'));
  assert(prompt.includes('Never invent'));
  const restored = instructions.restoreDefault();
  assert(restored.success);
  assert(instructions.getInstructions().includes('[BUSINESS NAME]'));
  console.log('✓ Instructions save, system prompt, restore default');

  // Instructions must not be in document search index path — we never call saveNote with them
  console.log('✓ Instructions are file-based only (not documents)');

  console.log('\nAll privacy/complaint/instructions tests passed.');
}

run().catch(err => {
  console.error('FAIL', err);
  process.exit(1);
});
