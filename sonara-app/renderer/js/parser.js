/* ══════════════════════════════════════════════════════════
   PARSER.JS — PDF + EPUB text extraction
   Loaded as CDN scripts on demand, called from app.js
══════════════════════════════════════════════════════════ */
'use strict';

const Parser = (() => {

  // ── HELPERS ──────────────────────────────────────────────
  function cleanText(raw) {
    return raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')   // fix runTogether words
      .replace(/\s+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // ── PDF ──────────────────────────────────────────────────
  async function loadPDFScript() {
    if (window.pdfjsLib) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  async function parsePDF(base64Data, onProgress) {
    console.log('[Parser] Starting PDF parse...');
    await loadPDFScript();

    console.log('[Parser] Decoding base64, length:', base64Data.length);
    const binary   = atob(base64Data);
    const bytes    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    console.log('[Parser] Loading PDF document...');
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const total = pdf.numPages;
    console.log('[Parser] PDF loaded, pages:', total);
    const raw = [];

    for (let i = 1; i <= total; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text    = cleanText(content.items.map(x => x.str).join(' '));
      if (text.length > 30) {
        raw.push({ title: 'Page ' + i, text, page: i, source: 'pdf' });
      }
      onProgress && onProgress(Math.round((i / total) * 100));
    }

    console.log('[Parser] PDF parsing complete, chunks:', raw.length);
    // Improve chapter titles from first sentence
    return raw.map(c => {
      const firstSentence = c.text.split('.')[0].trim();
      if (firstSentence.length > 3 && firstSentence.length < 60) {
        return { ...c, title: firstSentence.slice(0, 48) };
      }
      return c;
    });
  }

  // ── EPUB ─────────────────────────────────────────────────
  async function loadJSZipScript() {
    if (window.JSZip) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function parseEPUB(base64Data, onProgress) {
    console.log('[Parser] Starting EPUB parse...');
    await loadJSZipScript();

    console.log('[Parser] Decoding base64, length:', base64Data.length);
    const binary = atob(base64Data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    console.log('[Parser] Loading ZIP...');
    const zip = await JSZip.loadAsync(bytes.buffer);

    // 1. container.xml → OPF path
    console.log('[Parser] Reading container.xml...');
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) throw new Error('Invalid EPUB: missing container.xml');
    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/i)?.[1];
    if (!opfPath) throw new Error('Could not locate OPF file');
    console.log('[Parser] OPF path:', opfPath);

    // 2. OPF manifest + spine
    const opfText = await zip.file(opfPath)?.async('text');
    if (!opfText) throw new Error('Could not read OPF');
    const opfDir   = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
    const parser   = new DOMParser();
    const opfDoc   = parser.parseFromString(opfText, 'application/xml');

    const manifest = {};
    opfDoc.querySelectorAll('manifest item').forEach(item => {
      manifest[item.getAttribute('id')] = {
        href: item.getAttribute('href'),
        type: item.getAttribute('media-type')
      };
    });

    const spineIds = [...opfDoc.querySelectorAll('spine itemref')]
      .map(r => r.getAttribute('idref'))
      .filter(id => manifest[id]?.type?.includes('html'));

    if (!spineIds.length) throw new Error('No readable content in EPUB');
    console.log('[Parser] Found', spineIds.length, 'spine items');

    // 3. Extract text from each spine item
    const raw     = [];
    let chapterNum = 0;

    for (let i = 0; i < spineIds.length; i++) {
      const id       = spineIds[i];
      const href     = manifest[id].href;
      const fullPath = href.startsWith('/') ? href.slice(1) : opfDir + href;
      const html     = await zip.file(fullPath)?.async('text')
                    || await zip.file(decodeURIComponent(fullPath))?.async('text');
      if (!html) continue;

      const doc = parser.parseFromString(html, 'text/html');
      doc.querySelectorAll('script,style,nav,aside,[role="doc-toc"]').forEach(el => el.remove());

      const heading = doc.querySelector('h1,h2,h3');
      const title   = (heading?.textContent?.trim() || 'Chapter ' + (++chapterNum)).slice(0, 50);
      const text    = cleanText(doc.body?.innerText || doc.body?.textContent || '');

      if (text.length > 50) {
        raw.push({ title, text, page: raw.length + 1, source: 'epub' });
      }
      onProgress && onProgress(Math.round(((i + 1) / spineIds.length) * 100));
    }

    console.log('[Parser] EPUB parsing complete, chapters:', raw.length);
    if (!raw.length) throw new Error('No readable text found. EPUB may be image-based.');
    return raw;
  }

  // ── PUBLIC ───────────────────────────────────────────────
  return { parsePDF, parseEPUB };
})();
