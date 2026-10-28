/**
 * Seed script for Hama Enterprise Ng Chat Support
 * Creates admin account and sample knowledge base entries.
 * Run: npm run seed
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

console.log('Seeding database for Hama Enterprise Ng...\n');

const adminPassword = process.env.ADMIN_PASSWORD || 'hama123';
const hash = bcrypt.hashSync(adminPassword, 10);

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  db.prepare(
    'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run('admin', hash, 'System Admin', 'admin');
  console.log('✅ Admin user created');
  console.log('   Username: admin');
  console.log('   Password: ' + adminPassword);
  console.log('   ⚠️  Change this password after first login!\n');
} else {
  // Optionally update password if FORCE_ADMIN_PASSWORD=1
  if (process.env.FORCE_ADMIN_PASSWORD === '1') {
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
    console.log('✅ Admin password reset to: ' + adminPassword + '\n');
  } else {
    console.log('ℹ️  Admin user already exists (set FORCE_ADMIN_PASSWORD=1 to reset)\n');
  }
}

const agentHash = bcrypt.hashSync('agent123', 10);
const existingAgent = db.prepare('SELECT id FROM users WHERE username = ?').get('agent1');
if (!existingAgent) {
  db.prepare(
    'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run('agent1', agentHash, 'Support Agent 1', 'agent');
  console.log('✅ Sample agent created (username: agent1 / password: agent123)\n');
}

const kbEntries = [
  { category: 'services', keywords: 'services,painting,what do you do,offer,paint,interior,exterior,design', question: 'What services do you offer?', answer: 'Hama Enterprise Ng (RC 8827959) offers professional painting, interior design, and exterior design services for residential, commercial, and industrial clients across Nigeria.', priority: 10 },
  { category: 'services', keywords: 'painting,paint,house paint,wall,ceiling', question: 'Do you do painting?', answer: 'Yes! We specialize in high-quality interior and exterior painting for homes, offices, factories and commercial buildings.', priority: 9 },
  { category: 'services', keywords: 'interior design,interior,decoration,decor', question: 'Do you offer interior design?', answer: 'Absolutely. Our interior design team helps you create beautiful, functional spaces — colour consultation, material selection, and full project coordination.', priority: 9 },
  { category: 'services', keywords: 'exterior design,exterior,facade,outdoor', question: 'Do you do exterior design?', answer: 'Yes, we provide exterior design and painting services including facade treatments, protective coatings and aesthetic upgrades.', priority: 8 },
  { category: 'areas', keywords: 'location,area,serve,where,city,lagos,abuja,port harcourt,nigeria', question: 'Which areas do you serve?', answer: 'We primarily serve Lagos, Abuja, Port Harcourt and surrounding areas. Contact us for projects outside these locations.', priority: 10 },
  { category: 'quote', keywords: 'quote,price,cost,estimate,how much,pricing,quotation', question: 'How can I get a quote?', answer: 'To request a free quote, please share: 1) Type of project, 2) Approximate size, 3) Location, 4) Preferred contact. An agent will follow up shortly.', priority: 10 },
  { category: 'hours', keywords: 'hours,working hours,open,time,when,schedule', question: 'What are your working hours?', answer: 'We are available Monday to Saturday, 8:00 AM – 6:00 PM WAT.', priority: 8 },
  { category: 'contact', keywords: 'contact,phone,email,call,reach,number', question: 'How can I contact you?', answer: 'Leave your phone number here and an agent will call you back. Office hours: Mon–Sat 8am–6pm WAT.', priority: 9 },
  { category: 'faq', keywords: 'rc,registration,company,about,who are you', question: 'What is your company registration?', answer: 'Hama Enterprise Ng is a registered company with RC 8827959.', priority: 5 },
  { category: 'faq', keywords: 'payment,pay,deposit,invoice', question: 'How do payments work?', answer: 'Payment terms are discussed after a site assessment or detailed quote. Please speak with an agent for payment arrangements.', priority: 7 },
  { category: 'faq', keywords: 'inspection,site visit,survey,measure', question: 'Do you do site inspections?', answer: 'Yes, free site inspections can be arranged within our service areas.', priority: 8 },
  { category: 'faq', keywords: 'complaint,problem,issue,unhappy,bad job', question: 'How do I make a complaint?', answer: 'We take every concern seriously. Please describe the issue and an agent will take over this chat to assist you.', priority: 10 }
];

const insertKb = db.prepare(`INSERT INTO knowledge_base (category, keywords, question, answer, priority) VALUES (?, ?, ?, ?, ?)`);
const existingKb = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get();
if (existingKb.c === 0) {
  for (const entry of kbEntries) {
    insertKb.run(entry.category, entry.keywords, entry.question, entry.answer, entry.priority);
  }
  console.log(`✅ Inserted ${kbEntries.length} knowledge base entries\n`);
} else {
  console.log(`ℹ️  Knowledge base already has ${existingKb.c} entries\n`);
}

console.log('Seed complete!');
