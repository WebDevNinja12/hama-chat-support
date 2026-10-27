/**
 * Offline tests for document extraction and bot answering.
 * Run: npm run test:docs
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');

// Use a temp data dir so we don't touch production data
process.env.DATA_DIR = path.join(__dirname, '..', 'data', 'test-run');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

// Clean slate
const dataDir = process.env.DATA_DIR;
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
fs.mkdirSync(dataDir, { recursive: true });

const { extractFromBuffer } = require('../utils/extract');
const { splitPassages, saveNote, searchDocuments, deleteDocument, listDocuments } = require('../utils/documents');
const bot = require('../utils/bot');
const { buildIndex, scoreQuery, tokenize } = require('../utils/bm25');

function buildMinimalDocx(paragraphs) {
  // Minimal valid DOCX (zip with [Content_Types], _rels, word/document.xml)
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.map(p => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('\n')}
  </w:body>
</w:document>`;

  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  function zipStore(files) {
    // Simple store-method ZIP
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, 'utf8');
      const data = Buffer.from(f.data);
      const crc = crc32(data);
      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8); // store
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      name.copy(local, 30);
      parts.push(local, data);

      const cen = Buffer.alloc(46 + name.length);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(0, 12);
      cen.writeUInt16LE(0, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(data.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt16LE(0, 30);
      cen.writeUInt16LE(0, 32);
      cen.writeUInt16LE(0, 34);
      cen.writeUInt16LE(0, 36);
      cen.writeUInt32LE(0, 38);
      cen.writeUInt32LE(offset, 42);
      name.copy(cen, 46);
      central.push(cen);
      offset += local.length + data.length;
    }
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, centralBuf, end]);
  }

  return zipStore([
    { name: '[Content_Types].xml', data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: docXml }
  ]);
}

async function run() {
  console.log('Running document & bot tests...\n');

  // 1. TXT extract
  {
    const buf = Buffer.from('Hama paints residential and commercial buildings in Lagos.');
    const r = await extractFromBuffer(buf, 'info.txt', 'text/plain');
    assert(!r.error, r.error);
    assert(r.text.includes('Lagos'));
    console.log('✓ TXT extraction');
  }

  // 2. DOCX extract
  {
    const buf = buildMinimalDocx([
      'Company Profile',
      'Hama Enterprise Ng provides professional painting services.',
      'We serve residential, commercial and industrial clients.'
    ]);
    const r = await extractFromBuffer(buf, 'profile.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert(!r.error, r.error);
    assert(/painting/i.test(r.text), 'DOCX should contain painting');
    console.log('✓ DOCX extraction');
  }

  // 3. Old .doc rejected
  {
    const r = await extractFromBuffer(Buffer.from('x'), 'old.doc', '');
    assert(r.error && /docx/i.test(r.error));
    console.log('✓ .doc rejected with helpful message');
  }

  // 4. Save note + BM25 match on covered topic
  {
    const saved = saveNote({
      title: 'Painting services guide',
      content: 'Hama Enterprise Ng offers interior and exterior painting for homes and offices. We use premium paints. Working hours are Monday to Saturday 8am to 6pm WAT. We do not offer roofing or solar panel installation.',
      adminId: 1
    });
    assert(!saved.error, saved.error);

    const hit = searchDocuments('Do you offer interior painting for homes?');
    assert(hit.confident, 'Should confidently match painting question');
    assert(hit.best && /painting/i.test(hit.best.text));
    console.log('✓ Document match for covered topic');
  }

  // 5. Unrelated topic should NOT confidently match
  {
    const miss = searchDocuments('Do you install solar panels on my roof?');
    // May get low coverage because solar/roofing not in doc
    assert(!miss.confident, 'Should not confidently answer solar/roofing from painting doc');
    console.log('✓ Unrelated topic (solar/roofing) not answered from painting doc');
  }

  // 6. Bot: complaint escalates
  {
    const reply = await bot.getBotReply('I have a complaint about damaged walls after your work', []);
    assert.strictEqual(reply.type, 'escalate');
    console.log('✓ Complaint escalates to person');
  }

  // 7. Bot: covered question answers from document or Q&A
  {
    const reply = await bot.getBotReply('What services do you offer?', []);
    assert(reply.type === 'answer', 'Expected answer, got ' + reply.type);
    assert(reply.message && reply.message.length > 10);
    console.log('✓ Covered question answered (source: ' + (reply.source || reply.sourceType) + ')');
  }

  // 8. Stemming / synonyms
  {
    const tokens = tokenize('colour cost payment');
    assert(tokens.includes('color') || tokens.includes('colour'));
    assert(tokens.includes('cost'));
    assert(tokens.includes('pay'));
    console.log('✓ Stemming and synonym groups');
  }

  // Cleanup test docs
  for (const d of listDocuments()) deleteDocument(d.id);

  console.log('\nAll tests passed.');
}

run().catch(err => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
