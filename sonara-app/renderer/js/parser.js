/* ══════════════════════════════════════════════════════════
   PARSER.JS — PDF + EPUB text extraction
   Loaded as CDN scripts on demand, called from app.js
══════════════════════════════════════════════════════════ */
'use strict';

const Parser = (() => {

  // ── STATE ───────────────────────────────────────────────
  let _pdfDoc = null;      // cached pdf.js document for page rendering
  let _pdfPageCount = 0;

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
    await loadPDFScript();

    const binary   = atob(base64Data);
    const bytes    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

    // Cache the document for visual page rendering
    _pdfDoc = pdf;
    _pdfPageCount = pdf.numPages;

    const total = pdf.numPages;
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

    // Improve chapter titles from first sentence
    return raw.map(c => {
      const firstSentence = c.text.split('.')[0].trim();
      if (firstSentence.length > 3 && firstSentence.length < 60) {
        return { ...c, title: firstSentence.slice(0, 48) };
      }
      return c;
    });
  }

  // ── PDF PAGE RENDERING ─────────────────────────────────
  // Renders a PDF page to a canvas element at the given scale
  async function renderPDFPage(pageNum, canvas, maxWidth) {
    if (!_pdfDoc) return null;
    if (pageNum < 1 || pageNum > _pdfDoc.numPages) return null;

    const page = await _pdfDoc.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });

    // Scale to fit within maxWidth while maintaining aspect ratio
    const scale = maxWidth ? Math.min((maxWidth * 2) / baseViewport.width, 3.0) : 2.0;
    const viewport = page.getViewport({ scale });

    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    // White background for pages
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return { width: viewport.width, height: viewport.height };
  }

  // Creates a text overlay layer for on-page highlighting
  async function createPDFTextLayer(pageNum, layerDiv, displayWidth) {
    if (!_pdfDoc) return null;
    if (pageNum < 1 || pageNum > _pdfDoc.numPages) return null;

    const page = await _pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const baseVP = page.getViewport({ scale: 1.0 });
    const scale = displayWidth / baseVP.width;
    const viewport = page.getViewport({ scale });

    layerDiv.innerHTML = '';

    const spans = [];
    const offsetMap = [];

    // Build the cleaned page text the same way parsePDF does so that offsets
    // here match the charIndex values delivered by TTS boundary events (which
    // are relative to the cleaned chunk text, not the raw item join).
    const cleanedPageText = cleanText(textContent.items.map(x => x.str).join(' '));
    let searchPos = 0;

    textContent.items.forEach((item) => {
      if (!item.str) return;

      const span = document.createElement('span');
      span.textContent = item.str;

      // Font size from transform matrix
      const tx = item.transform;
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * scale;

      // Convert PDF coords (origin bottom-left) to viewport coords (origin top-left)
      const [vx, vy] = viewport.convertToViewportPoint(tx[4], tx[5]);

      span.style.fontSize = fontSize + 'px';
      span.style.left = vx + 'px';
      span.style.top = (vy - fontSize) + 'px';

      // Match the PDF text width
      if (item.width > 0) {
        span.style.width = (item.width * scale) + 'px';
        span.style.display = 'inline-block';
        span.style.transformOrigin = '0 0';
      }

      layerDiv.appendChild(span);

      if (item.str.trim()) {
        // Locate this item's cleaned text within the cleaned page string so that
        // start/end offsets are in the same coordinate space as TTS charIndex values.
        const cleanedItem = cleanText(item.str);
        if (cleanedItem) {
          const idx = cleanedPageText.indexOf(cleanedItem, searchPos);
          const start = idx !== -1 ? idx : searchPos;
          offsetMap.push({ start, end: start + cleanedItem.length, span });
          if (idx !== -1) searchPos = start + cleanedItem.length;
        }
        spans.push(span);
      }
    });

    return { spans, offsetMap };
  }

  function getPDFDoc() { return _pdfDoc; }
  function getPDFPageCount() { return _pdfPageCount; }
  function hasPDFDoc() { return !!_pdfDoc; }

  // ── EPUB ─────────────────────────────────────────────────
  async function loadJSZipScript() {
    if (window.JSZip) return;
    // Try local bundle first (works offline / avoids CSP issues)
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/jszip.min.js';
      s.onload = res;
      s.onerror = () => {
        // Fallback to CDN
        const s2 = document.createElement('script');
        s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s2.onload = res; s2.onerror = rej;
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    });
  }

  async function parseEPUB(base64Data, onProgress) {
    await loadJSZipScript();

    const binary = atob(base64Data);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const zip = await JSZip.loadAsync(bytes.buffer);

    // 1. container.xml → OPF path
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    if (!containerXml) throw new Error('Invalid EPUB: missing container.xml');
    const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/i)?.[1];
    if (!opfPath) throw new Error('Could not locate OPF file');

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

    if (!raw.length) throw new Error('No readable text found. EPUB may be image-based.');
    return raw;
  }

  // ── COVER EXTRACTION ────────────────────────────────────

  async function extractEPUBCover(base64Data) {
    try {
      await loadJSZipScript();
      const binary = atob(base64Data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const zip = await JSZip.loadAsync(bytes.buffer);

      // 1. Read container.xml -> OPF
      const containerXml = await zip.file('META-INF/container.xml')?.async('text');
      if (!containerXml) return null;
      const opfPath = containerXml.match(/full-path="([^"]+\.opf)"/i)?.[1];
      if (!opfPath) return null;

      const opfText = await zip.file(opfPath)?.async('text');
      if (!opfText) return null;
      const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
      const parser = new DOMParser();
      const opfDoc = parser.parseFromString(opfText, 'application/xml');

      // 2. Look for cover in metadata -> meta[@name="cover"]
      let coverId = null;
      const coverMeta = opfDoc.querySelector('meta[name="cover"]');
      if (coverMeta) coverId = coverMeta.getAttribute('content');

      // 3. Check for item with properties="cover-image" (EPUB3)
      if (!coverId) {
        const coverItem = opfDoc.querySelector('manifest item[properties~="cover-image"]');
        if (coverItem) coverId = coverItem.getAttribute('id');
      }

      // 4. Fallback: look for manifest items with "cover" in id or href
      if (!coverId) {
        const items = opfDoc.querySelectorAll('manifest item');
        for (const item of items) {
          const id   = item.getAttribute('id') || '';
          const href = item.getAttribute('href') || '';
          const type = item.getAttribute('media-type') || '';
          if (type.startsWith('image/') && (id.toLowerCase().includes('cover') || href.toLowerCase().includes('cover'))) {
            coverId = id;
            break;
          }
        }
      }

      if (!coverId) return null;

      // 5. Resolve to file path and extract
      const item = opfDoc.querySelector('manifest item[id="' + coverId + '"]');
      if (!item) return null;
      const href      = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type') || 'image/jpeg';
      const fullPath  = href.startsWith('/') ? href.slice(1) : opfDir + href;

      const imgData = await zip.file(fullPath)?.async('base64')
                   || await zip.file(decodeURIComponent(fullPath))?.async('base64');
      if (!imgData) return null;

      return { base64: imgData, mediaType };
    } catch (err) {
      return null;
    }
  }

  async function extractPDFCover(base64Data) {
    try {
      await loadPDFScript();
      const binary = atob(base64Data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const pdf  = await pdfjsLib.getDocument({ data: bytes }).promise;
      const page = await pdf.getPage(1);

      // Render at reasonable size for a cover thumbnail (max 300px wide)
      const viewport = page.getViewport({ scale: 1.0 });
      const scale    = Math.min(300 / viewport.width, 450 / viewport.height);
      const scaled   = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width  = scaled.width;
      canvas.height = scaled.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport: scaled }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64  = dataUrl.split(',')[1];
      return { base64, mediaType: 'image/jpeg' };
    } catch (err) {
      return null;
    }
  }

  // ── MOBI / AZW3 (Kindle) ─────────────────────────────────
  /**
   * Parse a MOBI or AZW3 file. Parsing is done in the main process via IPC
   * (Node.js Buffer access required). Progress is reported in three steps
   * since parsing is synchronous on the main side.
   */
  async function parseMOBI(filePath, onProgress) {
    onProgress && onProgress(10);
    const result = await window.sonara.books.parseMOBI(filePath);
    onProgress && onProgress(80);
    if (!result || !result.chunks || !result.chunks.length) {
      throw new Error('No readable text found in MOBI/AZW3 file.');
    }
    onProgress && onProgress(100);
    return result.chunks; // [{ title, text, page, source }]
  }

  // ── PUBLIC ───────────────────────────────────────────────
  return { parsePDF, parseEPUB, parseMOBI, extractEPUBCover, extractPDFCover, renderPDFPage, createPDFTextLayer, getPDFDoc, getPDFPageCount, hasPDFDoc };
})();
