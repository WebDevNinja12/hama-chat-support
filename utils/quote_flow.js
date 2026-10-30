/**
 * Guided quote request inside chat — never invents prices.
 */
const store = require('./store_extra');
const alerts = require('./alerts');

const SESSIONS = new Map(); // chatId -> state

const STEPS = [
  { key: 'service', prompt: 'Which service do you need?', options: ['Painting', 'Interior design', 'Exterior design'] },
  { key: 'propertyType', prompt: 'What type of property is it?', options: ['Residential', 'Commercial', 'Industrial'] },
  { key: 'location', prompt: 'Where is the property located? (city / area)' },
  { key: 'sizeInfo', prompt: 'Approximate size or number of rooms? (or type Skip)', optional: true },
  { key: 'preferredDate', prompt: 'Preferred start date? (or type Skip)', optional: true },
  { key: 'notes', prompt: 'Any extra notes? (or type Skip)', optional: true }
];

function isQuoteTrigger(text) {
  const t = String(text || '').toLowerCase();
  return /\b(quote|quotation|price|pricing|estimate|how much|cost)\b/.test(t) ||
    t === 'get a quote';
}

function getSession(chatId) {
  return SESSIONS.get(chatId) || null;
}

function start(chatId, customer) {
  const state = {
    step: 0,
    data: {},
    name: customer?.name || null,
    contact: customer?.contact || null
  };
  SESSIONS.set(chatId, state);
  const s = STEPS[0];
  return {
    type: 'quote_step',
    message: "I'll collect a few details for a free quote. You can type Cancel anytime.\n\n" + s.prompt,
    quickReplies: s.options || ['Cancel']
  };
}

function cancel(chatId) {
  SESSIONS.delete(chatId);
  return {
    type: 'answer',
    message: 'Quote request cancelled. How else can I help?',
    quickReplies: ['Get a quote', 'Our services', 'Talk to a person']
  };
}

async function handleAnswer(chatId, text, customer) {
  const state = SESSIONS.get(chatId);
  if (!state) return null;

  const raw = String(text || '').trim();
  if (/^cancel$/i.test(raw)) return cancel(chatId);

  const step = STEPS[state.step];
  if (!step) return cancel(chatId);

  if (step.optional && /^skip$/i.test(raw)) {
    state.data[step.key] = null;
  } else {
    state.data[step.key] = raw.slice(0, 500);
  }

  state.step += 1;
  if (state.step >= STEPS.length) {
    SESSIONS.delete(chatId);
    const lead = store.createLead({
      chatId,
      name: state.name || customer?.name,
      contact: state.contact || customer?.contact,
      service: state.data.service,
      propertyType: state.data.propertyType,
      location: state.data.location,
      sizeInfo: state.data.sizeInfo,
      preferredDate: state.data.preferredDate,
      notes: state.data.notes
    });

    alerts.notifyStaff({
      type: 'New quote lead',
      chatId,
      name: lead.name,
      contact: lead.contact,
      message: [lead.service, lead.property_type, lead.location].filter(Boolean).join(' · '),
      reason: 'quote_request'
    }).catch(() => {});

    const summary = [
      'Thank you. Here is what we recorded:',
      `• Service: ${lead.service || '-'}`,
      `• Property: ${lead.property_type || '-'}`,
      `• Location: ${lead.location || '-'}`,
      lead.size_info ? `• Size: ${lead.size_info}` : null,
      lead.preferred_date ? `• Preferred date: ${lead.preferred_date}` : null,
      lead.notes ? `• Notes: ${lead.notes}` : null,
      '',
      'Our team will follow up with a quote. We never give prices in this chat — an agent will confirm details first.'
    ].filter(Boolean).join('\n');

    return {
      type: 'answer',
      message: summary,
      quickReplies: ['Talk to a person', 'Our services'],
      leadId: lead.id
    };
  }

  const next = STEPS[state.step];
  const replies = next.options ? next.options.concat(['Cancel']) : (next.optional ? ['Skip', 'Cancel'] : ['Cancel']);
  return {
    type: 'quote_step',
    message: next.prompt,
    quickReplies: replies
  };
}

module.exports = {
  isQuoteTrigger,
  getSession,
  start,
  handleAnswer,
  cancel,
  STEPS
};
