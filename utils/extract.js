/**
 * Extract readable text from uploaded documents.
 * Supports: PDF (pdfjs-dist legacy), DOCX (zip/xml), TXT, MD, CSV.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const MAX_CHARS = 400000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXT = new Set(['.pdf', '.docx', '.txt', '.md', '.csv']);

function sanitizeFilename(name) {
  return String(name || 'document')
    .replace(/[^a-zA-Z0-9._\- ()\[\]]+/g, '_')
    .slice(0, 180);
}

function detectType(filename, mime) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.doc') {
    return { error: 'Old .doc files are not supported. Please open the file in Word and Save As .docx, then upload again.' };
  }
  if (!ALLOWED_EXT.has(ext)) {
    return { error: `Unsupported file type "${ext || 'unknown'}". Allowed: PDF, DOCX, TXT, MD, CSV.` };
  }
  return { ext, mime: mime || '' };
}

/** Minimal ZIP reader for DOCX (no external deps) */
function readZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buffer.slice(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else content = null;
    entries.push({ name, content });
    offset = dataStart + compSize;
  }
  return entries;
}

function extractDocx(buffer) {
  try {
    const entries = readZipEntries(buffer);
    const doc = entries.find(e => e.name === 'word/document.xml');
    if (!doc || !doc.content) {
      return { error: 'Could not read this DOCX file. It may be damaged or password-protected.' };
    }
    let xml = doc.content.toString('utf8');
    // Keep paragraph breaks, line breaks, tabs, table cells
    xml = xml
      .replace(/<w:tab[^/]*\/>/g, '\t')
      .replace(/<w:br[^/]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!xml || xml.length < 10) {
      return { error: 'This DOCX appears empty or has no readable text.' };
    }
    return { text: xml.slice(0, MAX_CHARS) };
  } catch (err) {
    return { error: 'Failed to read DOCX: ' + (err.message || 'unknown error') };
  }
}

async function extractPdf(buffer) {
  try {
    // pdfjs-dist legacy build for Node
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const data = new Uint8Array(buffer);
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true
    });
    const pdf = await loadingTask.promise;
    const parts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map(it => it.str).join(' ');
      if (line.trim()) parts.push(line.trim());
    }
    const text = parts.join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || text.length < 20) {
      return {
        error: 'This PDF has no readable text (it may be a scan or photograph). Please paste the text as a note instead, or use an OCR tool first.'
      };
    }
    return { text: text.slice(0, MAX_CHARS) };
  } catch (err) {
    const msg = (err && err.message) || '';
    if (/password|encrypted/i.test(msg)) {
      return { error: 'This PDF is password-protected. Remove the password and upload again.' };
    }
    return { error: 'Could not read this PDF. It may be damaged or password-protected.' };
  }
}

function extractPlain(buffer, ext) {
  let text = buffer.toString('utf8');
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) return { error: 'This file is empty.' };
  return { text: text.slice(0, MAX_CHARS) };
}

async function extractFromBuffer(buffer, filename, mime) {
  if (!buffer || buffer.length === 0) return { error: 'Empty file.' };
  if (buffer.length > MAX_FILE_BYTES) {
    return { error: 'File is larger than 20 MB. Please upload a smaller file.' };
  }
  const type = detectType(filename, mime);
  if (type.error) return type;

  if (type.ext === '.pdf') return extractPdf(buffer);
  if (type.ext === '.docx') return extractDocx(buffer);
  return extractPlain(buffer, type.ext);
}

module.exports = {
  extractFromBuffer,
  sanitizeFilename,
  detectType,
  MAX_CHARS,
  MAX_FILE_BYTES,
  ALLOWED_EXT
};
