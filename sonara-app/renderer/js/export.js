/* ══════════════════════════════════════════════════════════
   EXPORT.JS — Export book as MP3 or M4B audiobook
   - Synthesizes via Edge Neural TTS (main process IPC)
   - Builds chapter timeline from MP3 frame durations
   - MP3 mode: writes .mp3 + .chapters.txt sidecar
   - M4B mode: writes temp .mp3, ffmeta.txt, then muxes to .m4b
     with embedded chapters + cover via bundled ffmpeg
══════════════════════════════════════════════════════════ */
'use strict';

const ExportMP3 = (() => {

  let _cancelled     = false;
  let _inProgress    = false;
  let _options       = null;      // set by confirmOptions()
  let _customCover   = null;      // absolute path from dialog picker

  const MAX_SEGMENT = 3000;

  function _splitText(text) {
    if (!text || !text.trim()) return [];
    if (text.length <= MAX_SEGMENT) return [text.trim()];

    const parts = [];
    let remaining = text.trim();

    while (remaining.length > MAX_SEGMENT) {
      let splitAt = MAX_SEGMENT;
      const sentMarks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let bestBreak = -1;

      // Smart paragraph split first
      const parIdx = remaining.lastIndexOf('\n\n', MAX_SEGMENT - 1);
      if (parIdx > MAX_SEGMENT * 0.4) {
        bestBreak = parIdx + 2;
      } else {
        for (const mark of sentMarks) {
          let idx = remaining.lastIndexOf(mark, MAX_SEGMENT - 1);
          
          // Ignore splits on common abbreviations
          while (idx > 0 && mark.startsWith('.')) {
            const pre = remaining.slice(Math.max(0, idx - 6), idx);
            if (/(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\s*$/i.test(pre)) {
              idx = remaining.lastIndexOf(mark, idx - 1);
            } else {
              break;
            }
          }

          if (idx > bestBreak && idx > MAX_SEGMENT * 0.4) {
            bestBreak = idx + mark.length;
          }
        }
      }

      if (bestBreak > 0) splitAt = bestBreak;
      parts.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.length > 0) parts.push(remaining);
    return parts;
  }

  function _cleanupText(text, skipChars, skipWordsStr) {
    let t = text;
    if (skipChars) {
      const escaped = skipChars.split('').map(c => '\\\\' + c).join('');
      try {
        t = t.replace(new RegExp(`[${escaped}]`, 'g'), '');
      } catch (e) { /* ignore invalid regex */ }
    }
    if (skipWordsStr) {
      const words = skipWordsStr.split(',').map(w => w.trim()).filter(Boolean);
      if (words.length > 0) {
        try {
          const pattern = '\\\\b(' + words.join('|') + ')\\\\b';
          t = t.replace(new RegExp(pattern, 'gi'), '');
        } catch (e) { /* ignore invalid regex */ }
      }
    }
    return t;
  }

  // ── OPTIONS FLOW ──────────────────────────────────────────
  async function start() {
    if (_inProgress) {
      UI.toast('Export already in progress — please wait or cancel it', 'error');
      return;
    }
    const chunks = Reader.getChunks?.();
    if (!chunks || !chunks.length) {
      UI.toast('No book is open — open a PDF or EPUB first', 'error');
      return;
    }
    _options = {
      format:      _selectedFormat(),
      useCover:    document.getElementById('exportUseCover')?.checked !== false,
      customCover: _customCover,
    };
    await _run();
  }

  function onFormatChange() {
    const fmt = _selectedFormat();
    const row = document.getElementById('exportCoverRow');
    if (row) row.style.display = (fmt === 'm4b') ? 'block' : 'none';
    const label = document.getElementById('exportBtnLabel');
    if (label) label.textContent = (fmt === 'm4b') ? 'Export to M4B' : 'Export to MP3';
  }

  function _selectedFormat() {
    const sel = document.querySelector('input[name="exportFormat"]:checked');
    return sel?.value === 'm4b' ? 'm4b' : 'mp3';
  }

  async function pickCover() {
    try {
      const p = await window.sonara.dialog.openImage();
      if (p) {
        _customCover = p;
        const name = p.split(/[\\/]/).pop();
        const el = document.getElementById('exportCoverName');
        if (el) el.textContent = name;
      }
    } catch (e) {
      UI.toast('Could not open image: ' + e.message, 'error');
    }
  }

  // ── MAIN RUN ──────────────────────────────────────────────
  async function _run() {
    const state  = Reader.getState();
    const chunks = Reader.getChunks();
    const format = _options.format;

    const edgeVoice = state.chosenVoice?._edgeVoice || 'en-US-AriaNeural';
    const isCloud   = state.chosenVoice?._cloudVoice;
    if (!isCloud) {
      UI.toast('Note: System voices can\'t export. Using Microsoft Aria Neural.', 'info', 4000);
    }

    // Book metadata
    let bookTitle = 'Sonara Audiobook';
    let bookAuthor = '';
    let bookCoverPath = '';
    try {
      if (App.currentBookId) {
        const book = await window.sonara.library.getBook(App.currentBookId);
        if (book?.title)      bookTitle     = book.title;
        if (book?.author)     bookAuthor    = book.author;
        if (book?.cover_path) bookCoverPath = book.cover_path;
      }
    } catch (_) {}

    const skipChars = await window.sonara.settings.get('ttsSkipChars', '*_~#');
    const skipWordsStr = await window.sonara.settings.get('ttsSkipWords', '');

    // Save dialog
    const savePath = await window.sonara.export.saveDialog({ title: bookTitle, format });
    if (!savePath) return;

    // Build segment list grouped by chapter
    const segments = [];
    chunks.forEach((chunk, chunkIndex) => {
      const parts = _splitText(chunk.text || '');
      for (const part of parts) {
        segments.push({
          text: part,
          chunkIndex,
          chunkTitle: chunk.title || `Chapter ${chunkIndex + 1}`,
        });
      }
    });
    if (!segments.length) {
      UI.toast('No text found to export', 'error');
      return;
    }

    _showModal(bookTitle, segments.length, edgeVoice, format);
    _cancelled  = false;
    _inProgress = true;

    const audioBase64Chunks = [];
    const chapters = [];              // {title, startMs, endMs}
    let   cursorMs = 0;
    let   curChapter = null;
    let   failCount = 0;

    for (let i = 0; i < segments.length; i++) {
      if (_cancelled) break;
      const seg = segments[i];
      _updateProgress(i, segments.length, seg.chunkTitle || `Part ${i + 1}`);

      try {
        const cleanText = _cleanupText(seg.text, skipChars, skipWordsStr);
        if (!cleanText.trim()) continue;

        const result = await window.sonara.tts.synthesize({
          text:  cleanText,
          voice: edgeVoice,
          speed: state.speed || 1.0,
          pitch: state.pitch || 1.0
        });
        if (!result?.audio) { failCount++; continue; }
        audioBase64Chunks.push(result.audio);

        // Open/continue chapter
        if (!curChapter || curChapter.chunkIndex !== seg.chunkIndex) {
          if (curChapter) { curChapter.endMs = cursorMs; chapters.push(curChapter); }
          curChapter = { chunkIndex: seg.chunkIndex, title: seg.chunkTitle, startMs: cursorMs, endMs: cursorMs };
        }
        cursorMs += (result.durationMs || 0);
        curChapter.endMs = cursorMs;
      } catch (err) {
        failCount++;
        console.warn('[Export] Segment', i, 'failed:', err.message);
      }
    }
    if (curChapter) chapters.push(curChapter);

    _inProgress = false;

    if (_cancelled) {
      _hideModal();
      UI.toast('Export cancelled', 'error');
      return;
    }
    if (!audioBase64Chunks.length) {
      _hideModal();
      UI.toast('Export failed — no audio was generated. Check your internet connection.', 'error', 6000);
      return;
    }

    try {
      if (format === 'm4b') {
        await _finalizeM4B({ savePath, audioBase64Chunks, chapters, bookTitle, bookAuthor, edgeVoice, bookCoverPath });
      } else {
        await _finalizeMP3({ savePath, audioBase64Chunks, chapters });
      }
      _hideModal();
      const fname = savePath.split(/[\\/]/).pop();
      const warnMsg = failCount ? ` (${failCount} section(s) skipped)` : '';
      UI.toast(`✓ Saved: ${fname}${warnMsg}`, 'success', 6000);
    } catch (err) {
      _hideModal();
      UI.toast('Failed to save: ' + err.message, 'error', 6000);
    }
  }

  // ── FINALIZE: MP3 + chapter sidecar ───────────────────────
  async function _finalizeMP3({ savePath, audioBase64Chunks, chapters }) {
    _updateProgress(null, null, 'Writing MP3 file…');
    await window.sonara.export.writeFile({ path: savePath, chunks: audioBase64Chunks });

    if (chapters.length) {
      const sidecarPath = savePath.replace(/\.mp3$/i, '') + '.chapters.txt';
      const content = _buildChapterListText(chapters);
      try { await window.sonara.export.writeSidecar({ path: sidecarPath, content }); }
      catch (e) { console.warn('[Export] Failed to write chapter sidecar:', e.message); }
    }
  }

  // ── FINALIZE: M4B (temp mp3 → ffmpeg mux) ─────────────────
  async function _finalizeM4B({ savePath, audioBase64Chunks, chapters, bookTitle, bookAuthor, edgeVoice, bookCoverPath }) {
    const mp3Temp    = savePath.replace(/\.m4b$/i, '') + '.tmp.mp3';
    const ffmetaTemp = savePath.replace(/\.m4b$/i, '') + '.ffmeta.txt';

    _updateProgress(null, null, 'Writing temporary audio…');
    await window.sonara.export.writeFile({ path: mp3Temp, chunks: audioBase64Chunks });

    _updateProgress(null, null, 'Writing chapter metadata…');
    const ffmeta = _buildFfmeta(chapters, { title: bookTitle, author: bookAuthor });
    await window.sonara.export.writeSidecar({ path: ffmetaTemp, content: ffmeta });

    // Cover resolution
    let coverPath = '';
    if (_options.useCover) {
      if (_options.customCover) coverPath = _options.customCover;
      else if (bookCoverPath)   coverPath = bookCoverPath;
    }

    _updateProgress(null, null, 'Packaging audiobook (ffmpeg)…');
    try {
      await window.sonara.export.packageM4B({
        mp3Path:    mp3Temp,
        ffmetaPath: ffmetaTemp,
        coverPath,
        outPath:    savePath,
        metadata: {
          title:    bookTitle,
          author:   bookAuthor,
          narrator: _friendlyVoice(edgeVoice),
          year:     new Date().getFullYear(),
        },
      });
    } finally {
      // Cleanup temp files regardless of outcome
      try { await window.sonara.export.deleteTemp(mp3Temp); } catch (_) {}
      try { await window.sonara.export.deleteTemp(ffmetaTemp); } catch (_) {}
    }
  }

  // ── SIDECAR BUILDERS ──────────────────────────────────────
  function _fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => n.toString().padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  function _buildChapterListText(chapters) {
    const lines = ['# Sonara Audiobook — Chapter List', ''];
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const dur = c.endMs - c.startMs;
      lines.push(`${_fmtTime(c.startMs)}  ${c.title}  (${_fmtTime(dur)})`);
    }
    lines.push('');
    lines.push(`Total: ${_fmtTime(chapters[chapters.length - 1].endMs)}`);
    return lines.join('\r\n');
  }

  function _escFfmeta(s) {
    // FFMETADATA requires escaping of = ; # \ and newlines
    return String(s).replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/\n/g, '\\n');
  }

  function _buildFfmeta(chapters, meta) {
    const lines = [';FFMETADATA1'];
    if (meta?.title)  lines.push(`title=${_escFfmeta(meta.title)}`);
    if (meta?.author) lines.push(`artist=${_escFfmeta(meta.author)}`);
    for (const c of chapters) {
      lines.push('');
      lines.push('[CHAPTER]');
      lines.push('TIMEBASE=1/1000');
      lines.push(`START=${Math.max(0, Math.round(c.startMs))}`);
      lines.push(`END=${Math.max(Math.round(c.startMs) + 1, Math.round(c.endMs))}`);
      lines.push(`title=${_escFfmeta(c.title)}`);
    }
    return lines.join('\n');
  }

  // ── CANCEL ────────────────────────────────────────────────
  function cancel() {
    if (_inProgress) {
      _cancelled = true;
      const btn = document.getElementById('exportCancelBtn');
      btn.disabled = true;
      btn.title    = 'Cancelling…';
    } else {
      _hideModal();
    }
  }

  // ── PROGRESS MODAL ────────────────────────────────────────
  function _showModal(title, total, voice, format) {
    document.getElementById('exportModalTitle').textContent = title;
    document.getElementById('exportVoiceName').textContent  = _friendlyVoice(voice);
    document.getElementById('exportDone').textContent       = '0';
    document.getElementById('exportTotal').textContent      = total;
    document.getElementById('exportStatus').textContent     = 'Starting…';
    document.getElementById('exportPct').textContent        = '0%';
    document.getElementById('exportProgFill').style.width   = '0%';
    const titleEl = document.getElementById('exportBadgeTitle');
    if (titleEl) titleEl.textContent = format === 'm4b' ? 'Exporting M4B' : 'Exporting MP3';
    const btn = document.getElementById('exportCancelBtn');
    btn.disabled = false;
    btn.title    = 'Cancel export';
    document.getElementById('exportBadge').style.display = 'flex';
  }

  function _hideModal() {
    document.getElementById('exportBadge').style.display = 'none';
  }

  function _updateProgress(done, total, label) {
    if (done != null && total != null) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      document.getElementById('exportDone').textContent      = done;
      document.getElementById('exportTotal').textContent     = total;
      document.getElementById('exportPct').textContent       = pct + '%';
      document.getElementById('exportProgFill').style.width  = pct + '%';
    }
    document.getElementById('exportStatus').textContent    = label;
  }

  function _friendlyVoice(voiceId) {
    const m = voiceId.match(/^([a-z]{2}-[A-Z]{2})-([A-Za-z]+)Neural$/);
    if (m) return `${m[2]} (Neural) · ${m[1]}`;
    return voiceId;
  }

  return { start, cancel, pickCover, onFormatChange };
})();
