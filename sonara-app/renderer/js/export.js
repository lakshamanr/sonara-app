/* ══════════════════════════════════════════════════════════
   EXPORT.JS — Export book as MP3 audiobook / Convert to M4B
   Uses Microsoft Edge Neural TTS (via main process IPC).
   Splits chunks → synthesizes → concatenates → saves .mp3
   Also supports MP3 → M4B audiobook conversion via ffmpeg.
══════════════════════════════════════════════════════════ */
'use strict';

const ExportMP3 = (() => {

  let _cancelled   = false;
  let _inProgress  = false;

  // Max chars per TTS request (Edge TTS safe limit ~4000, use 3000 for safety)
  const MAX_SEGMENT = 3000;

  // ── TEXT SPLITTER ─────────────────────────────────────────
  // Split long text into ≤ MAX_SEGMENT char blocks at sentence boundaries
  function _splitText(text) {
    if (!text || !text.trim()) return [];
    if (text.length <= MAX_SEGMENT) return [text.trim()];

    const parts = [];
    let remaining = text.trim();

    while (remaining.length > MAX_SEGMENT) {
      // Try to break at sentence end (. ! ?) within limit
      let splitAt = MAX_SEGMENT;
      const sentMarks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let bestBreak = -1;

      for (const mark of sentMarks) {
        const idx = remaining.lastIndexOf(mark, MAX_SEGMENT - 1);
        if (idx > bestBreak && idx > MAX_SEGMENT * 0.4) {
          bestBreak = idx + mark.length;
        }
      }

      if (bestBreak > 0) splitAt = bestBreak;

      parts.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining.length > 0) parts.push(remaining);
    return parts;
  }

  // ── START EXPORT (MP3) ────────────────────────────────────
  async function start() {
    if (_inProgress) {
      UI.toast('Export already in progress — please wait or cancel it', 'error');
      return;
    }

    const state  = Reader.getState();
    const chunks = Reader.getChunks();

    if (!chunks || !chunks.length) {
      UI.toast('No book is open — open a PDF or EPUB first', 'error');
      return;
    }

    // Determine Edge TTS voice
    const edgeVoice = state.chosenVoice?._edgeVoice || 'en-US-AriaNeural';
    const isCloud   = state.chosenVoice?._cloudVoice;
    if (!isCloud) {
      UI.toast('Note: System voices can\'t export. Using Microsoft Aria Neural.', 'info', 4000);
    }

    // Get book title for save dialog default name
    let bookTitle = 'Sonara Audiobook';
    try {
      if (App.currentBookId) {
        const book = await window.sonara.library.getBook(App.currentBookId);
        if (book?.title) bookTitle = book.title;
      }
    } catch (_) {}

    // Show native save dialog FIRST so user can cancel before we start
    const savePath = await window.sonara.export.saveDialog(bookTitle);
    if (!savePath) return; // user cancelled dialog

    // Build flat segment list (splitting long chapters)
    const segments = [];
    for (const chunk of chunks) {
      const parts = _splitText(chunk.text || '');
      for (const part of parts) {
        segments.push({ text: part, label: chunk.title || '' });
      }
    }

    if (!segments.length) {
      UI.toast('No text found to export', 'error');
      return;
    }

    // Show progress modal
    _showModal(bookTitle, segments.length, edgeVoice);
    _cancelled  = false;
    _inProgress = true;

    const audioBase64Chunks = [];
    let   failCount = 0;

    for (let i = 0; i < segments.length; i++) {
      if (_cancelled) break;

      _updateProgress(i, segments.length, segments[i].label || `Part ${i + 1} of ${segments.length}`);

      try {
        const result = await window.sonara.tts.synthesize({
          text:  segments[i].text,
          voice: edgeVoice,
          speed: state.speed || 1.0,
          pitch: state.pitch || 1.0
        });
        if (result?.audio) {
          audioBase64Chunks.push(result.audio);
        }
      } catch (err) {
        failCount++;
        console.warn('[Export] Segment', i, 'failed:', err.message);
        // Continue — skip failed segment rather than aborting
      }
    }

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

    // Write file
    _updateProgress(segments.length, segments.length, 'Writing MP3 file…');
    try {
      await window.sonara.export.writeFile({ path: savePath, chunks: audioBase64Chunks });
      _hideModal();
      const fname = savePath.split('\\').pop().split('/').pop();
      const warnMsg = failCount ? ` (${failCount} section(s) skipped)` : '';
      UI.toast(`✓ Saved: ${fname}${warnMsg}`, 'success', 6000);
    } catch (err) {
      _hideModal();
      UI.toast('Failed to save file: ' + err.message, 'error');
    }
  }

  // ── CONVERT TO AUDIOBOOK (M4B) ────────────────────────────
  async function convertToAudiobook() {
    if (_inProgress) {
      UI.toast('Export already in progress — please wait or cancel it', 'error');
      return;
    }

    // Get current book info
    let bookTitle = 'Sonara Audiobook';
    let bookAuthor = '';
    let bookCoverPath = null;
    let bookFilePath = null;
    let bookFormat = null;

    try {
      if (App.currentBookId) {
        const book = await window.sonara.library.getBook(App.currentBookId);
        if (book) {
          bookTitle = book.title || bookTitle;
          bookAuthor = book.author || '';
          bookFilePath = book.file_path;
          bookFormat = book.format;
        }
        // Try to get cover image path
        try {
          bookCoverPath = await window.sonara.cover.getPath(App.currentBookId);
        } catch (_) {}
      }
    } catch (_) {}

    // Validate: need an MP3 source file for conversion
    if (!bookFilePath) {
      UI.toast('No book is open — open a book first', 'error');
      return;
    }

    // Check if the source is an audio file (mp3, m4a, etc.)
    const audioExts = ['mp3', 'm4a', 'ogg'];
    const isAudioFile = audioExts.includes(bookFormat);

    if (!isAudioFile) {
      // For non-audio books, we first need to export as MP3, then convert
      UI.toast('First export the book as MP3, then use Convert to Audiobook on the exported file', 'error', 6000);
      return;
    }

    // Step 1: Ensure ffmpeg is available (download if needed)
    _showModal(bookTitle, 0, 'ffmpeg');
    _cancelled = false;
    _inProgress = true;

    _updateProgress(0, 100, 'Checking ffmpeg…');

    try {
      const ffmpegReady = await window.sonara.ffmpeg.isAvailable();

      if (!ffmpegReady) {
        _updateProgress(0, 100, 'Downloading ffmpeg (first time only)…');

        // Listen for download progress
        const progressHandler = (data) => {
          _updateProgress(data.percent, 100, data.status || 'Downloading ffmpeg…');
        };
        window.sonara.ffmpeg.onProgress(progressHandler);

        try {
          await window.sonara.ffmpeg.ensureAvailable();
        } catch (err) {
          _inProgress = false;
          _hideModal();
          UI.toast('Failed to download ffmpeg: ' + err.message, 'error', 6000);
          return;
        }
      }

      // Step 2: Show save dialog for M4B
      _hideModal();
      const savePath = await window.sonara.export.saveDialogM4B(bookTitle);
      if (!savePath) {
        _inProgress = false;
        return; // user cancelled
      }

      // Step 3: Convert
      _showModal(bookTitle, 0, 'M4B Converter');
      _updateProgress(5, 100, 'Converting to audiobook…');

      // Listen for conversion progress
      const m4bProgressHandler = (data) => {
        _updateProgress(data.percent, 100, data.status || 'Converting…');
      };
      window.sonara.export.onM4BProgress(m4bProgressHandler);

      await window.sonara.export.convertToM4B({
        inputPath:  bookFilePath,
        outputPath: savePath,
        coverPath:  bookCoverPath,
        title:      bookTitle,
        artist:     bookAuthor,
        album:      bookTitle,
        genre:      'Audiobook'
      });

      _inProgress = false;
      _hideModal();
      const fname = savePath.split('\\').pop().split('/').pop();
      UI.toast(`✓ Audiobook saved: ${fname}`, 'success', 6000);

    } catch (err) {
      _inProgress = false;
      _hideModal();
      UI.toast('Conversion failed: ' + err.message, 'error', 6000);
    }
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

  // ── MODAL HELPERS ─────────────────────────────────────────
  function _showModal(title, total, voice) {
    document.getElementById('exportModalTitle').textContent = title;
    document.getElementById('exportVoiceName').textContent  = _friendlyVoice(voice);
    document.getElementById('exportDone').textContent       = '0';
    document.getElementById('exportTotal').textContent      = total;
    document.getElementById('exportStatus').textContent     = 'Starting…';
    document.getElementById('exportPct').textContent        = '0%';
    document.getElementById('exportProgFill').style.width   = '0%';
    const btn = document.getElementById('exportCancelBtn');
    btn.disabled = false;
    btn.title    = 'Cancel export';
    document.getElementById('exportBadge').style.display = 'flex';
  }

  function _hideModal() {
    document.getElementById('exportBadge').style.display = 'none';
  }

  function _updateProgress(done, total, label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('exportDone').textContent      = done;
    document.getElementById('exportTotal').textContent     = total;
    document.getElementById('exportStatus').textContent    = label;
    document.getElementById('exportPct').textContent       = pct + '%';
    document.getElementById('exportProgFill').style.width  = pct + '%';
  }

  function _friendlyVoice(voiceId) {
    // e.g. "en-US-AriaNeural" → "Aria (Neural) · en-US"
    const m = voiceId.match(/^([a-z]{2}-[A-Z]{2})-([A-Za-z]+)Neural$/);
    if (m) return `${m[2]} (Neural) · ${m[1]}`;
    return voiceId;
  }

  return { start, cancel, convertToAudiobook };
})();
