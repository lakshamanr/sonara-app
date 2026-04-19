/* ══════════════════════════════════════════════════════════
   BULK-EXPORT.JS — Parallel M4B export for multiple books
   ────────────────────────────────────────────────────────
   Two modules in this file:
     BulkExport    — queue engine (no DOM dependency)
     BulkExportUI  — modal wiring, voice list, settings
   Supports:
     • Text books (PDF / EPUB / MOBI) → TTS → M4B
     • Audio books (MP3 / M4A / OGG / M4B) → ffmpeg re-encode
   Workers run concurrently up to a configurable pool size (1–5).
   TTS synthesis within each book is sequential to preserve order.
══════════════════════════════════════════════════════════ */
'use strict';

const BulkExport = (() => {

  // ── CONSTANTS ────────────────────────────────────────────
  const MAX_SEGMENT  = 3000;
  const AUDIO_FMTS   = new Set(['mp3', 'm4a', 'ogg', 'm4b', 'aac']);

  // ── STATE ────────────────────────────────────────────────
  let _queue        = [];    // Array of job objects
  let _cancelFlags  = {};    // { jobId: boolean }
  let _running      = false;
  let _onJobUpdate  = null;  // callback(job) fired on status/progress changes
  let _onAllDone    = null;  // callback() fired when the whole batch completes

  // A single ffmpeg-progress handler shared for all running audio jobs.
  // Maps outputPath → jobId for routing progress events.
  let _ffmpegPathToJob = {};
  let _ffmpegListener  = null;

  // ── TEXT SPLITTER (identical to export.js) ────────────────
  function _splitText(text) {
    if (!text || !text.trim()) return [];
    if (text.length <= MAX_SEGMENT) return [text.trim()];
    const parts = [];
    let remaining = text.trim();
    while (remaining.length > MAX_SEGMENT) {
      let splitAt = MAX_SEGMENT;
      const sentMarks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let bestBreak = -1;
      for (const mark of sentMarks) {
        const idx = remaining.lastIndexOf(mark, MAX_SEGMENT - 1);
        if (idx > bestBreak && idx > MAX_SEGMENT * 0.4) bestBreak = idx + mark.length;
      }
      if (bestBreak > 0) splitAt = bestBreak;
      parts.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.length > 0) parts.push(remaining);
    return parts;
  }

  function _escFfmeta(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/\n/g, '\\n');
  }

  function _buildFfmeta(chapters, meta) {
    const lines = [';FFMETADATA1'];
    if (meta?.title)  lines.push('title=' + _escFfmeta(meta.title));
    if (meta?.author) lines.push('artist=' + _escFfmeta(meta.author));
    for (const c of chapters) {
      lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000',
        'START=' + Math.max(0, Math.round(c.startMs)),
        'END='   + Math.max(Math.round(c.startMs) + 1, Math.round(c.endMs)),
        'title=' + _escFfmeta(c.title));
    }
    return lines.join('\n');
  }

  function _friendlyVoice(voiceId) {
    const m = String(voiceId || '').match(/^([a-z]{2}-[A-Z]{2})-([A-Za-z]+)Neural$/);
    if (m) return m[2] + ' (Neural)';
    return voiceId || 'Aria';
  }

  // ── JOB UPDATE HELPER ────────────────────────────────────
  function _update(job, patch) {
    Object.assign(job, patch);
    try { if (_onJobUpdate) _onJobUpdate({ ...job }); } catch (_) {}
  }

  // ── PROCESS A SINGLE TEXT BOOK ───────────────────────────
  async function _processTextBook(job) {
    const { book, voiceSettings } = job;
    const edgeVoice = voiceSettings?.voice  || 'en-US-AriaNeural';
    const speed     = voiceSettings?.speed  || 1.0;
    const pitch     = voiceSettings?.pitch  || 1.0;

    _update(job, { status: 'parsing', pct: 0, statusLabel: 'Parsing book…' });

    // 1. Load file as base64
    let base64;
    try {
      base64 = await window.sonara.file.read(book.file_path);
    } catch (err) {
      throw new Error('Could not read file: ' + err.message);
    }
    if (!base64) throw new Error('File could not be read (empty response)');

    // 2. Parse into chunks using Parser module
    let chunks = [];
    const fmt = (book.format || '').toLowerCase();

    if (fmt === 'pdf') {
      chunks = await Parser.parsePDF(base64, () => {});
    } else if (fmt === 'epub') {
      chunks = await Parser.parseEPUB(base64, () => {});
    } else if (fmt === 'mobi' || fmt === 'azw3') {
      const result = await window.sonara.books.parseMOBI(book.file_path);
      chunks = result?.chunks || [];
    } else {
      throw new Error('Unsupported text format: ' + fmt);
    }

    if (!chunks || !chunks.length) throw new Error('No text found in book');

    // 3. Build flat segment list grouped by chunk/chapter
    const segments = [];
    chunks.forEach((chunk, chunkIndex) => {
      const parts = _splitText(chunk.text || '');
      for (const part of parts) {
        segments.push({ text: part, chunkIndex, chunkTitle: chunk.title || ('Chapter ' + (chunkIndex + 1)) });
      }
    });
    if (!segments.length) throw new Error('No text segments generated');

    // 4. Compute output path
    const outputPath = await window.sonara.export.getAutoSavePath({
      filePath: book.file_path,
      title:    book.title,
    });

    const mp3Temp    = outputPath.replace(/\.m4b$/i, '') + '.tmp.mp3';
    const ffmetaTemp = outputPath.replace(/\.m4b$/i, '') + '.ffmeta.txt';

    // 5. TTS loop
    _update(job, { status: 'converting', pct: 0, statusLabel: 'Synthesising audio…' });

    const audioBase64Chunks = [];
    const chapters          = [];
    let cursorMs   = 0;
    let curChapter = null;
    let failCount  = 0;

    for (let i = 0; i < segments.length; i++) {
      if (_cancelFlags[job.id]) throw new Error('cancelled');

      const seg = segments[i];
      _update(job, {
        pct:         Math.round((i / segments.length) * 85),
        statusLabel: 'Synthesising (' + (i + 1) + ' / ' + segments.length + ')…',
      });

      try {
        const result = await window.sonara.tts.synthesize({
          text:  seg.text,
          voice: edgeVoice,
          speed,
          pitch,
        });
        if (!result?.audio) { failCount++; continue; }
        audioBase64Chunks.push(result.audio);

        if (!curChapter || curChapter.chunkIndex !== seg.chunkIndex) {
          if (curChapter) { curChapter.endMs = cursorMs; chapters.push(curChapter); }
          curChapter = { chunkIndex: seg.chunkIndex, title: seg.chunkTitle, startMs: cursorMs, endMs: cursorMs };
        }
        cursorMs += (result.durationMs || 0);
        curChapter.endMs = cursorMs;
      } catch (err) {
        if (_cancelFlags[job.id]) throw new Error('cancelled');
        failCount++;
      }
    }
    if (curChapter) chapters.push(curChapter);

    if (_cancelFlags[job.id]) throw new Error('cancelled');
    if (!audioBase64Chunks.length) throw new Error('No audio was generated — check internet connection');

    // 6. Write temp MP3 + ffmeta
    _update(job, { pct: 87, statusLabel: 'Writing audio…' });
    await window.sonara.export.writeFile({ path: mp3Temp, chunks: audioBase64Chunks });

    _update(job, { pct: 90, statusLabel: 'Writing chapter metadata…' });
    const ffmeta = _buildFfmeta(chapters, { title: book.title, author: book.author || '' });
    await window.sonara.export.writeSidecar({ path: ffmetaTemp, content: ffmeta });

    // 7. ffmpeg mux
    _update(job, { pct: 92, statusLabel: 'Packaging M4B…' });
    const coverPath = book.cover_path || '';
    try {
      await window.sonara.export.packageM4B({
        mp3Path:    mp3Temp,
        ffmetaPath: ffmetaTemp,
        coverPath,
        outPath:    outputPath,
        metadata: {
          title:    book.title,
          author:   book.author || '',
          narrator: _friendlyVoice(edgeVoice),
          year:     new Date().getFullYear(),
        },
      });
    } finally {
      try { await window.sonara.export.deleteTemp(mp3Temp);    } catch (_) {}
      try { await window.sonara.export.deleteTemp(ffmetaTemp); } catch (_) {}
    }

    job.outputPath = outputPath;
    if (failCount) job.warnMsg = failCount + ' section(s) skipped due to TTS errors';
  }

  // ── PROCESS A SINGLE AUDIO BOOK ──────────────────────────
  async function _processAudioBook(job) {
    const { book } = job;

    _update(job, { status: 'converting', pct: 0, statusLabel: 'Computing output path…' });

    const outputPath = await window.sonara.export.getAutoSavePath({
      filePath: book.file_path,
      title:    book.title,
    });

    // Register mapping so progress events can be routed to this job
    _ffmpegPathToJob[outputPath] = job.id;

    _update(job, { pct: 1, statusLabel: 'Re-encoding with ffmpeg…', outputPath });

    try {
      await window.sonara.export.reencodeToM4B({
        inputPath:  book.file_path,
        outputPath,
        coverPath:  book.cover_path || '',
        metadata: {
          title:  book.title,
          author: book.author || '',
          year:   new Date().getFullYear(),
        },
      });
    } finally {
      delete _ffmpegPathToJob[outputPath];
    }

    job.outputPath = outputPath;
  }

  // ── MAIN WORKER ──────────────────────────────────────────
  async function _processJob(job) {
    _update(job, { status: 'converting', pct: 0, statusLabel: 'Starting…' });

    const fmt = (job.book.format || '').toLowerCase();
    const isAudio = AUDIO_FMTS.has(fmt);

    try {
      if (isAudio) {
        await _processAudioBook(job);
      } else {
        await _processTextBook(job);
      }
      _update(job, { status: 'done', pct: 100, statusLabel: 'Done' });
    } catch (err) {
      if (err.message === 'cancelled') {
        _update(job, { status: 'cancelled', pct: 0, statusLabel: 'Cancelled' });
      } else {
        _update(job, { status: 'error', pct: 0, statusLabel: 'Error: ' + (err.message || 'Unknown error') });
        console.error('[BulkExport] Job failed for book "' + job.book.title + '":', err);
      }
    }
  }

  // ── CONCURRENCY POOL ─────────────────────────────────────
  async function _runPool(concurrency) {
    let idx = 0;

    async function worker() {
      while (idx < _queue.length) {
        const job = _queue[idx++];
        if (!job) break;
        // Skip jobs that were cancelled while queued (before a worker reached them)
        if (_cancelFlags[job.id]) {
          _update(job, { status: 'cancelled', statusLabel: 'Cancelled' });
          try { if (_onJobUpdate) _onJobUpdate({ ...job }); } catch (_) {}
          continue;
        }
        _update(job, { status: 'converting' });
        await _processJob(job);
        try { if (_onJobUpdate) _onJobUpdate({ ...job }); } catch (_) {}
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, _queue.length); i++) {
      workers.push(worker());
    }
    await Promise.allSettled(workers);
  }

  // ── PUBLIC: START ─────────────────────────────────────────
  /**
   * Start a bulk export batch.
   * @param {Array<{book, voiceSettings}>} jobs
   * @param {number} concurrency  1–5
   * @param {{ onJobUpdate: Function, onAllDone: Function }} callbacks
   */
  async function start(jobs, concurrency, { onJobUpdate, onAllDone } = {}) {
    if (_running) {
      UI.toast('Bulk export already in progress', 'error');
      return;
    }
    if (!jobs || !jobs.length) return;

    _running     = true;
    _cancelFlags = {};
    _onJobUpdate = onJobUpdate || null;
    _onAllDone   = onAllDone  || null;
    _ffmpegPathToJob = {};

    // Build queue with unique IDs and initial state
    _queue = jobs.map((j, i) => ({
      id:          i,
      book:        j.book,
      voiceSettings: j.voiceSettings || {},
      status:      'queued',   // queued | converting | done | error | cancelled
      pct:         0,
      statusLabel: 'Queued',
      outputPath:  null,
      warnMsg:     null,
    }));

    // Fire initial state so UI can render all rows immediately
    for (const job of _queue) {
      try { if (_onJobUpdate) _onJobUpdate({ ...job }); } catch (_) {}
    }

    // Attach ffmpeg progress listener
    const _ffmpegCb = (data) => {
      const { outputPath, pct } = data || {};
      const jobId = _ffmpegPathToJob[outputPath];
      if (jobId == null) return;
      const job = _queue[jobId];
      if (job && job.status === 'converting') {
        _update(job, { pct, statusLabel: 'Re-encoding… ' + pct + '%' });
      }
    };
    window.sonara.export.onFfmpegProgress(_ffmpegCb);
    _ffmpegListener = _ffmpegCb;

    try {
      await _runPool(Math.max(1, Math.min(5, concurrency || 3)));
    } finally {
      _running = false;
      if (_ffmpegListener) {
        try { window.sonara.export.offFfmpegProgress(_ffmpegListener); } catch (_) {}
        _ffmpegListener = null;
      }
      try { if (_onAllDone) _onAllDone(_queue.map(j => ({ ...j }))); } catch (_) {}
    }
  }

  // ── PUBLIC: CANCEL ────────────────────────────────────────
  /**
   * Request cancellation of all running/queued jobs.
   * Currently-executing TTS segments will complete; new ones won't start.
   */
  function cancel() {
    if (!_running) return;
    for (const job of _queue) {
      if (job.status === 'queued' || job.status === 'converting') {
        _cancelFlags[job.id] = true;
        if (job.status === 'queued') {
          _update(job, { status: 'cancelled', statusLabel: 'Cancelled' });
        } else {
          _update(job, { statusLabel: 'Cancelling…' });
        }
      }
    }
  }

  // ── PUBLIC: QUERY ─────────────────────────────────────────
  function isRunning() { return _running; }
  function getJobs()   { return _queue.map(j => ({ ...j })); }

  return { start, cancel, isRunning, getJobs };
})();

/* ══════════════════════════════════════════════════════════
   BULK EXPORT UI — modal wiring, voice list, settings sync
══════════════════════════════════════════════════════════ */
const BulkExportUI = (() => {

  let _selectedBooks  = [];  // populated when config modal opens
  let _voiceOverrides = {};  // { bookId: { speed, pitch } }

  // ── HELPERS ───────────────────────────────────────────────
  function _escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _defaultVoice() {
    // Get the voice ID from Reader's chosen voice
    try {
      const state = Reader?.getState?.();
      const chosenVoice = state?.chosenVoice;
      
      // Try to extract the voice identifier in order of likelihood
      if (chosenVoice?.shortName) return chosenVoice.shortName;
      if (chosenVoice?._edgeVoice) return chosenVoice._edgeVoice;
      if (chosenVoice?.Name) return chosenVoice.Name;
      if (chosenVoice?.name) return chosenVoice.name;
      if (chosenVoice?.voiceURI) return chosenVoice.voiceURI;
    } catch (_) {}
    
    return 'en-US-AriaNeural'; // Ultimate fallback
  }

  // ── OPEN CONFIG ───────────────────────────────────────────
  async function openConfig() {
    _selectedBooks = Library.getSelectedBooks();
    if (!_selectedBooks.length) {
      UI.toast('Select at least one book first', 'error');
      return;
    }

    UI.openModal('modalBulkConfig');

    // Load saved concurrency preference
    let savedConcurrency = 3;
    try {
      savedConcurrency = parseInt(await window.sonara.settings.get('bulkExportConcurrency', '3'), 10) || 3;
    } catch (_) {}

    const slider = document.getElementById('bulkConcurrency');
    const valEl  = document.getElementById('bulkConcurrencyVal');
    if (slider) { slider.value = savedConcurrency; }
    if (valEl)  { valEl.textContent = savedConcurrency; }

    const sub = document.getElementById('bulkConfigSub');
    if (sub) sub.textContent = 'Export ' + _selectedBooks.length + ' book' + (_selectedBooks.length !== 1 ? 's' : '') + ' to M4B.';

    _renderConfigTable();
  }

  function _renderConfigTable() {
    const tbody = document.getElementById('bulkCfgTableBody');
    if (!tbody) return;

    tbody.innerHTML = _selectedBooks.map(book => {
      const bookId = String(book.id);
      const ov    = _voiceOverrides[bookId] || {};
      const speed = ov.speed != null ? ov.speed : 1.0;
      const pitch = ov.pitch != null ? ov.pitch : 1.0;

      const isAudio = ['mp3', 'm4a', 'ogg', 'm4b', 'aac'].includes((book.format || '').toLowerCase());

      let speedPitchCells;
      if (isAudio) {
        speedPitchCells = '<td colspan="2" style="color:var(--text-muted);font-size:11px;font-style:italic">Re-encode audio only</td>';
      } else {
        speedPitchCells =
          '<td style="min-width:130px"><input type="range" class="bulk-cfg-mini-slider" min="0.5" max="2" step="0.1" value="' + speed + '" data-book-id="' + bookId + '" data-field="speed" oninput="BulkExportUI._onSliderChange(this)"/><span class="bulk-cfg-mini-val" id="bcs-speed-' + bookId + '">' + speed.toFixed(1) + 'x</span></td>' +
          '<td style="min-width:130px"><input type="range" class="bulk-cfg-mini-slider" min="0.5" max="2" step="0.1" value="' + pitch + '" data-book-id="' + bookId + '" data-field="pitch" oninput="BulkExportUI._onSliderChange(this)"/><span class="bulk-cfg-mini-val" id="bcs-pitch-' + bookId + '">' + pitch.toFixed(1) + 'x</span></td>';
      }

      return '<tr>' +
        '<td style="min-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + _escHtml(book.title) + '">' + _escHtml(book.title) + '</td>' +
        speedPitchCells +
      '</tr>';
    }).join('');
  }

  // Called inline from oninput on range sliders in the table
  function _onSliderChange(input) {
    const id    = input.dataset.bookId;
    const field = input.dataset.field;
    const val   = parseFloat(input.value);
    if (!_voiceOverrides[id]) _voiceOverrides[id] = {};
    _voiceOverrides[id][field] = val;
    const label = document.getElementById('bcs-' + field + '-' + id);
    if (label) label.textContent = val.toFixed(1) + 'x';
  }

  // ── START EXPORT ──────────────────────────────────────────
  async function startExport() {
    const concurrency = parseInt(document.getElementById('bulkConcurrency')?.value, 10) || 3;
    try { await window.sonara.settings.set('bulkExportConcurrency', String(concurrency)); } catch (_) {}

    // Always use the reader's currently active voice for all books
    const activeVoice = _defaultVoice();

    const jobs = _selectedBooks.map(book => ({
      book,
      voiceSettings: {
        voice: activeVoice,
        ...(_voiceOverrides[String(book.id)] || {}),
      },
    }));

    UI.closeModal('modalBulkConfig');
    _openProgressModal(jobs.length);

    BulkExport.start(jobs, concurrency, {
      onJobUpdate: _onJobUpdate,
      onAllDone:   _onAllDone,
    });
  }

  // ── PROGRESS MODAL ────────────────────────────────────────
  function _openProgressModal(total) {
    _resetProgressModal(total);
    UI.openModal('modalBulkProgress');
    const closeBtn = document.getElementById('bulkProgressClose');
    const doneBtn  = document.getElementById('btnCloseBulkDone');
    const cancelBtn = document.getElementById('btnCancelBulk');
    if (closeBtn) closeBtn.style.display = 'none';
    if (doneBtn)  doneBtn.style.display  = 'none';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  }

  function _resetProgressModal(total) {
    const overall = document.getElementById('bulkProgOverall');
    if (overall) overall.textContent = '— 0 / ' + total;
    const list = document.getElementById('bulkProgList');
    if (list) list.innerHTML = '';
  }

  function _onJobUpdate(job) {
    const list = document.getElementById('bulkProgList');
    if (!list) return;

    let row = list.querySelector('[data-job-id="' + job.id + '"]');
    if (!row) {
      row = document.createElement('div');
      row.className = 'bulk-prog-row';
      row.dataset.jobId = job.id;
      row.innerHTML =
        '<div class="bpr-icon"></div>' +
        '<div class="bpr-info">' +
          '<div class="bpr-title">' + _escHtml(job.book.title) + '</div>' +
          '<div class="bpr-status"></div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
          '<div class="bpr-bar-wrap"><div class="bpr-bar-fill"></div></div>' +
          '<span class="bpr-pct"></span>' +
        '</div>';
      list.appendChild(row);
    }

    const iconEl   = row.querySelector('.bpr-icon');
    const statusEl = row.querySelector('.bpr-status');
    const barFill  = row.querySelector('.bpr-bar-fill');
    const pctEl    = row.querySelector('.bpr-pct');

    row.className = 'bulk-prog-row' +
      (job.status === 'done'      ? ' bpr-done'      : '') +
      (job.status === 'error'     ? ' bpr-error'     : '') +
      (job.status === 'cancelled' ? ' bpr-cancelled' : '');

    const icons = {
      queued:     '⏳',
      converting: '<span class="bpr-spinner"></span>',
      done:       '✓',
      error:      '✗',
      cancelled:  '—',
    };
    iconEl.innerHTML  = icons[job.status] || '⏳';
    statusEl.textContent = job.statusLabel || job.status;
    barFill.style.width  = (job.pct || 0) + '%';
    pctEl.textContent    = (job.pct || 0) + '%';

    // Update overall counter
    const jobs   = BulkExport.getJobs();
    const done   = jobs.filter(j => j.status === 'done' || j.status === 'error' || j.status === 'cancelled').length;
    const overall = document.getElementById('bulkProgOverall');
    if (overall) overall.textContent = '— ' + done + ' / ' + jobs.length;
  }

  function _onAllDone(jobs) {
    const closeBtn  = document.getElementById('bulkProgressClose');
    const doneBtn   = document.getElementById('btnCloseBulkDone');
    const cancelBtn = document.getElementById('btnCancelBulk');
    if (closeBtn) closeBtn.style.display = 'flex';
    if (doneBtn)  doneBtn.style.display  = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'none';

    const successCount = jobs.filter(j => j.status === 'done').length;
    const failCount    = jobs.filter(j => j.status === 'error').length;

    if (successCount && !failCount) {
      UI.toast('✓ Bulk export complete — ' + successCount + ' M4B file' + (successCount !== 1 ? 's' : '') + ' saved', 'success', 5000);
    } else if (successCount && failCount) {
      UI.toast(successCount + ' exported, ' + failCount + ' failed. Check progress for details.', 'error', 6000);
    } else {
      UI.toast('Bulk export failed for all books', 'error', 5000);
    }
  }

  function cancel() {
    BulkExport.cancel();
  }

  function closProgress() {
    UI.closeModal('modalBulkProgress');
    // Exit bulk select mode after a completed export
    if (Library.isBulkSelectMode()) Library.toggleBulkSelectMode();
  }

  return { openConfig, startExport, cancel, closProgress, _onSliderChange };
})();
