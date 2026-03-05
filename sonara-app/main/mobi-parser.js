'use strict';
/**
 * mobi-parser.js — Node.js MOBI / AZW3 (Kindle) text extractor
 *
 * Supports:
 *   - MOBI 6 (PalmDOC LZ77 compression, or uncompressed)
 *   - Hybrid MOBI6 + KF8 (modern Kindle exports from Calibre etc.)
 *   - KF8 / AZW3 — extracts and strips embedded HTML
 *
 * DRM-protected files (encryption type ≠ 0) are detected and an
 * explanatory error is thrown instead of garbled output.
 *
 * Returns: { title, chunks }
 *   chunks: [{ title, text, page, source }]  ← matches Sonara's format
 */

// ── PalmDOC LZ77 decompressor ─────────────────────────────────────────────────
function decompressPalmDOC(input) {
  const out = [];
  let i = 0;
  const len = input.length;
  while (i < len) {
    const c = input[i++];
    if (c === 0x00) {
      out.push(0x20);                               // null byte → space
    } else if (c <= 0x08) {
      for (let j = 0; j < c && i < len; j++) out.push(input[i++]);
    } else if (c <= 0x7f) {
      out.push(c);                                  // ASCII literal
    } else if (c <= 0xbf) {
      if (i >= len) break;
      const next = input[i++];
      const dist = ((c & 0x3f) << 8) | next;       // encoded distance+length
      const copyLen = (dist & 0x07) + 3;
      const pos = out.length - (dist >> 3);
      for (let j = 0; j < copyLen; j++) {
        out.push(pos + j >= 0 && pos + j < out.length ? out[pos + j] : 0x20);
      }
    } else {
      out.push(0x20);                               // 0xc0–0xff: space + char
      out.push(c ^ 0x80);
    }
  }
  return Buffer.from(out);
}

// ── HTML → plain text ─────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]{2,6};/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Split plain text into reader chunks (~4 000–6 000 chars each) ─────────────
function textToChunks(text, sourceFormat) {
  const MAX_CHARS = 5500;
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let buf = '';
  let chNum = 0;

  const flush = () => {
    const t = buf.trim();
    if (t.length < 30) return;
    chNum++;
    const firstLine = t.split('\n')[0].trim();
    const isHeadingLike = firstLine.length < 80;
    const title = isHeadingLike ? firstLine.slice(0, 60) : 'Section ' + chNum;
    chunks.push({ title, text: t, page: chNum, source: sourceFormat });
    buf = '';
  };

  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;
    const isChapterHeading =
      p.length < 80 &&
      /^(chapter|part|section|prologue|epilogue|introduction|preface|\d+[\.\)]\s)/i.test(p);

    if (buf.length + p.length > MAX_CHARS || (isChapterHeading && buf.length > 400)) {
      flush();
    }
    buf += (buf ? '\n\n' : '') + p;
  }
  flush();

  return chunks;
}

// ── Core PalmDB record reader ─────────────────────────────────────────────────
function readPalmDB(buf) {
  if (buf.length < 78) throw new Error('Too small to be a valid MOBI file.');

  const numRecords = buf.readUInt16BE(76);
  if (numRecords === 0) throw new Error('MOBI file has no records.');

  const offsets = [];
  for (let i = 0; i < numRecords; i++) {
    offsets.push(buf.readUInt32BE(78 + i * 8));
  }

  return {
    numRecords,
    getRecord(n) {
      if (n >= numRecords) return Buffer.alloc(0);
      const s = offsets[n];
      const e = n + 1 < numRecords ? offsets[n + 1] : buf.length;
      return buf.slice(s, Math.min(e, buf.length));
    }
  };
}

// ── Main parse entry point ────────────────────────────────────────────────────
function parseMobi(buffer) {
  const db  = readPalmDB(buffer);
  const r0  = db.getRecord(0);

  if (r0.length < 16) throw new Error('Invalid MOBI header record.');

  // PalmDOC sub-header (first 16 bytes of record 0)
  const compression    = r0.readUInt16BE(0);  // 1=none, 2=PalmDOC, 17480=Huffman
  const encryptionType = r0.readUInt16BE(12); // 0=none, 1=old, 2=MobiPocket
  const numTextRecs    = r0.readUInt16BE(8);

  if (encryptionType !== 0) {
    throw new Error(
      'This Kindle book is DRM-protected and cannot be opened in Sonara.\n\n' +
      'To read it here, export a DRM-free copy using Calibre or your e-reader.'
    );
  }

  // --- MOBI extension header (starts at byte 16 of record 0) ---
  let encoding  = 'utf8';
  let fileTitle = '';

  if (r0.length >= 20 && r0.toString('ascii', 16, 20) === 'MOBI') {
    // encoding: offset 16+12 = 28
    const enc = r0.readUInt32BE(28);
    encoding = enc === 1252 ? 'latin1' : 'utf8';

    // fullNameOffset / fullNameLength: offsets 96, 100 from start of record 0
    if (r0.length >= 104) {
      const nameOff = r0.readUInt32BE(96);
      const nameLen = r0.readUInt32BE(100);
      if (nameOff + nameLen <= r0.length && nameLen > 0) {
        fileTitle = r0.toString(encoding, nameOff, nameOff + nameLen).trim();
      }
    }
  }

  // --- Detect hybrid MOBI6 + KF8 (BOUNDARY record) ---
  let kf8Start = -1;
  for (let i = 1; i < db.numRecords; i++) {
    const rec = db.getRecord(i);
    if (rec.length >= 8 && rec.toString('ascii', 0, 8) === 'BOUNDARY') {
      kf8Start = i + 1;
      break;
    }
  }

  let rawText = '';

  // --- Strategy A: Extract KF8 HTML (hybrid or pure KF8) ---
  if (kf8Start > 0 && kf8Start < db.numRecords) {
    try {
      const kf8r0     = db.getRecord(kf8Start);
      const kf8NumTxt = kf8r0.readUInt16BE(8);
      let html = '';
      for (let i = kf8Start + 1; i <= kf8Start + kf8NumTxt && i < db.numRecords; i++) {
        html += db.getRecord(i).toString('utf8');
      }
      if (html.length > 100) {
        rawText = stripHtml(html);
      }
    } catch (_) {}
  }

  // --- Strategy B: MOBI6 PalmDOC text records ---
  if (!rawText) {
    let combined = '';
    for (let i = 1; i <= numTextRecs && i < db.numRecords; i++) {
      const rec = db.getRecord(i);
      let decoded;
      if (compression === 2) {
        decoded = decompressPalmDOC(rec).toString(encoding);
      } else if (compression === 1) {
        decoded = rec.toString(encoding);
      } else {
        // Huffman (17480) — complex codec; try raw UTF-8 as fallback
        decoded = rec.toString('utf8');
      }
      combined += decoded;
    }

    // MOBI6 text often embeds HTML markup — strip it
    if (combined.includes('<') && combined.includes('>')) {
      rawText = stripHtml(combined);
    } else {
      rawText = combined;
    }
  }

  // --- Strategy C: Scan entire buffer for embedded HTML/XHTML ---
  if (!rawText || rawText.trim().length < 100) {
    const full = buffer.toString('utf8');
    const htmlStart = full.indexOf('<html');
    const htmlEnd   = full.lastIndexOf('</html>');
    if (htmlStart !== -1 && htmlEnd !== -1) {
      rawText = stripHtml(full.slice(htmlStart, htmlEnd + 7));
    }
  }

  if (!rawText || rawText.trim().length < 50) {
    throw new Error(
      'No readable text could be extracted from this MOBI/AZW3 file.\n' +
      'It may be DRM-encrypted, image-only, or in an unsupported format.'
    );
  }

  const chunks = textToChunks(rawText.trim(), 'mobi');
  return { title: fileTitle, chunks };
}

module.exports = { parseMobi };
