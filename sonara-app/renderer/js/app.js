/* ══════════════════════════════════════════════════════════
   APP.JS — Main orchestrator, UI helpers, Claude, init
══════════════════════════════════════════════════════════ */
'use strict';

// ── UI HELPERS ────────────────────────────────────────────
const UI = (() => {
  let toastTimer = {};
  let resumeResolve = null;

  function toast(msg, type = '', duration = 3500) {
    const wrap = document.getElementById('toastWrap');
    const el   = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    wrap.appendChild(el);

    const id = setTimeout(() => {
      el.classList.add('exit');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
  }

  // Claude key
  function openClaudeModal() {
    const saved = sessionStorage.getItem('sonara_claude_key') || '';
    document.getElementById('claudeKeyInput').value = saved;
    openModal('modalClaude');
  }

  async function saveClaudeKey() {
    const v = document.getElementById('claudeKeyInput').value.trim();
    if (v && !v.startsWith('sk-ant')) {
      toast('Invalid key format — should start with sk-ant', 'error');
      return;
    }
    if (v) {
      sessionStorage.setItem('sonara_claude_key', v);
      await window.sonara.settings.set('claude_key', v);
      _updateClaudeUI(true);
      toast('Claude AI enabled ✓', 'success');
    } else {
      sessionStorage.removeItem('sonara_claude_key');
      await window.sonara.settings.set('claude_key', '');
      _updateClaudeUI(false);
      toast('API key cleared', '');
    }
    closeModal('modalClaude');
  }

  function _updateClaudeUI(on) {
    document.getElementById('cpDot').classList.toggle('ok', on);
    document.getElementById('cpLabel').textContent = on ? 'Claude ON' : 'Claude AI';
  }

  function getClaudeKey() {
    return sessionStorage.getItem('sonara_claude_key') || '';
  }

  // Theme
  let currentTheme = 'black';

  function setTheme(name) {
    currentTheme = name;
    document.body.classList.add('theme-transition');
    document.documentElement.setAttribute('data-theme', name);
    // Update swatch active states
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === name);
    });
    setTimeout(() => document.body.classList.remove('theme-transition'), 350);
  }

  async function applyTheme(name) {
    setTheme(name);
    await window.sonara.settings.set('theme', name);
  }

  // Settings modal
  async function openSettingsModal() {
    const version = await window.sonara.meta.version();
    document.getElementById('settingVersion').textContent = version;
    // Sync swatch to current theme
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === currentTheme);
    });
    // Load DB path
    try {
      const dbPath = await window.sonara.db.getPath();
      const el = document.getElementById('syncDbPath');
      if (el) { el.textContent = dbPath || '(default)'; el.title = dbPath || ''; }
    } catch {}
    // Load Books folder path
    try {
      const booksDir = await window.sonara.books.getDir();
      const el = document.getElementById('syncBooksDir');
      if (el) { el.textContent = booksDir || '(default)'; el.title = booksDir || ''; }
    } catch {}
    // Load TTS skip chars
    try {
      const skipChars = await window.sonara.settings.get('ttsSkipChars', '*_~#');
      const el = document.getElementById('settingTtsSkipChars');
      if (el) el.value = skipChars || '';
    } catch {}
    // Load Turso config
    try {
      const { url, token } = await window.sonara.db.getTursoConfig();
      const urlEl   = document.getElementById('tursoUrl');
      const tokenEl = document.getElementById('tursoToken');
      if (urlEl)   urlEl.value   = url   || '';
      if (tokenEl) tokenEl.value = token || '';
    } catch {}
    openModal('modalSettings');
  }

  // ── DB SYNC FUNCTIONS ─────────────────────────────────────

  async function chooseDbPath() {
    try {
      const newPath = await window.sonara.db.choosePath();
      if (!newPath) return;
      const el = document.getElementById('syncDbPath');
      if (el) { el.textContent = newPath; el.title = newPath; }
      toast('Database moved — sync by placing this file in your cloud folder', 'success', 4000);
    } catch (err) { toast('Could not move database: ' + err.message, 'error'); }
  }

  async function resetDbPath() {
    if (!confirm('Reset database location to default (app data folder)?')) return;
    try {
      const def = await window.sonara.db.resetPath();
      const el  = document.getElementById('syncDbPath');
      if (el) { el.textContent = def; el.title = def; }
      toast('Database reset to default location', 'success');
    } catch (err) { toast('Reset failed: ' + err.message, 'error'); }
  }

  // ── BOOKS FOLDER FUNCTIONS ────────────────────────────────────────

  async function chooseBooksDir() {
    try {
      const newDir = await window.sonara.books.chooseDir();
      if (!newDir) return;
      const el = document.getElementById('syncBooksDir');
      if (el) { el.textContent = newDir; el.title = newDir; }
      toast('Books folder moved — place this folder in your cloud sync to access books across devices', 'success', 5000);
    } catch (err) { toast('Could not move books folder: ' + err.message, 'error'); }
  }

  async function resetBooksDir() {
    if (!confirm('Move all books back to the default app data folder?')) return;
    try {
      const def = await window.sonara.books.resetDir();
      const el  = document.getElementById('syncBooksDir');
      if (el) { el.textContent = def; el.title = def; }
      toast('Books folder reset to default location', 'success');
    } catch (err) { toast('Reset failed: ' + err.message, 'error'); }
  }

  async function openBooksDir() {
    try { await window.sonara.books.openDir(); }
    catch (err) { toast('Could not open folder: ' + err.message, 'error'); }
  }

  async function exportDb() {
    try {
      const result = await window.sonara.db.export();
      if (!result) return;
      toast(`Exported: ${result.books} books, ${result.notes} notes → JSON`, 'success', 3000);
    } catch (err) { toast('Export failed: ' + err.message, 'error'); }
  }

  async function importDb() {
    if (!confirm('Import backup? New records will be merged in (existing data is NOT overwritten).')) return;
    try {
      const stats = await window.sonara.db.import();
      if (!stats) return;
      toast(`Imported: ${stats.books} books, ${stats.notes} notes, ${stats.collections} collections`, 'success', 3500);
    } catch (err) { toast('Import failed: ' + err.message, 'error'); }
  }

  function _tursoStatus(msg, type) {
    const el = document.getElementById('tursoStatus');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'sync-status ' + (type || '');
  }

  async function saveTursoConfig() {
    const url   = (document.getElementById('tursoUrl')?.value   || '').trim();
    const token = (document.getElementById('tursoToken')?.value || '').trim();
    await window.sonara.db.saveTursoConfig({ url, token });
    _tursoStatus('✔ Credentials saved', 'ok');
    setTimeout(() => _tursoStatus(''), 2500);
  }

  async function testTurso() {
    const url   = (document.getElementById('tursoUrl')?.value   || '').trim();
    const token = (document.getElementById('tursoToken')?.value || '').trim();
    _tursoStatus('Testing…', '');
    try {
      await window.sonara.db.testTurso({ url, token });
      _tursoStatus('✔ Connected successfully', 'ok');
    } catch (err) { _tursoStatus('✘ ' + err.message, 'err'); }
  }

  async function syncTurso() {
    const url   = (document.getElementById('tursoUrl')?.value   || '').trim();
    const token = (document.getElementById('tursoToken')?.value || '').trim();
    const btn   = document.getElementById('btnSyncTurso');
    if (btn) btn.disabled = true;
    _tursoStatus('Syncing…', '');
    try {
      await window.sonara.db.saveTursoConfig({ url, token });
      const result = await window.sonara.db.syncTurso({ url, token });
      _tursoStatus(`✔ Pushed ${result.pushed.books}b/${result.pushed.notes}n — Pulled ${result.pulled.books}b/${result.pulled.notes}n`, 'ok');
      toast('Turso sync complete', 'success', 3000);
    } catch (err) {
      _tursoStatus('✘ ' + err.message, 'err');
      toast('Turso sync failed: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveSettings() {
    const fontSize  = document.getElementById('settingFontSize').value;
    const autoSave  = document.getElementById('settingAutoSave').value;
    const skipChars = (document.getElementById('settingTtsSkipChars')?.value || '').trim();
    document.documentElement.style.setProperty('--font-reader', fontSize + 'px');
    await window.sonara.settings.set('fontSize',       fontSize);
    await window.sonara.settings.set('autoSave',       autoSave);
    await window.sonara.settings.set('theme',          currentTheme);
    await window.sonara.settings.set('ttsSkipChars',   skipChars);
    if (typeof Reader !== 'undefined') Reader.setSkipChars(skipChars);
    closeModal('modalSettings');
    toast('Settings saved', 'success');
  }

  // Resume dialog
  function showResumeDialog(book, progress) {
    return new Promise(resolve => {
      resumeResolve = resolve;
      const pct = progress?.percent || 0;
      const chunkIdx = progress?.chunk_index || 0;
      document.getElementById('resumeTitle').textContent = 'Resume "' + book.title + '"?';
      document.getElementById('resumeSub').textContent =
        'You were at ' + pct + '% — ' + (book.format === 'epub' ? 'Chapter' : 'Page') + ' ' + (chunkIdx + 1);
      document.getElementById('resumeBarFill').style.width = pct + '%';
      document.getElementById('resumePct').textContent = pct + '%';
      openModal('modalResume');
    });
  }

  function resumeBook() {
    closeModal('modalResume');
    if (resumeResolve) { resumeResolve('resume'); resumeResolve = null; }
  }

  function startFromBeginning() {
    closeModal('modalResume');
    if (resumeResolve) { resumeResolve('restart'); resumeResolve = null; }
  }

  return {
    toast, openModal, closeModal,
    openClaudeModal, saveClaudeKey, getClaudeKey, _updateClaudeUI,
    openSettingsModal, saveSettings,
    chooseDbPath, resetDbPath, exportDb, importDb, saveTursoConfig, testTurso, syncTurso,
    chooseBooksDir, resetBooksDir, openBooksDir,
    ttsAddPreset: (chars) => {
      const el = document.getElementById('settingTtsSkipChars');
      if (!el) return;
      const current = el.value;
      // Add only chars not already present
      let added = '';
      for (const c of chars) { if (!current.includes(c)) added += c; }
      el.value = current + added;
    },
    ttsClearPreset: () => {
      const el = document.getElementById('settingTtsSkipChars');
      if (el) el.value = '';
    },
    setTheme: applyTheme, _applyThemeVisual: setTheme,
    showResumeDialog, resumeBook, startFromBeginning
  };
})();

// ── CLAUDE ENHANCEMENT ────────────────────────────────────
async function enhanceWithClaude(text, key) {
  const style = document.getElementById('narrateStyle').value;
  const prompts = {
    natural:  'Rewrite for smooth natural spoken narration. Remove headers and formatting artifacts. Keep close to original meaning.',
    dramatic: 'Adapt for dramatic engaging audiobook narration. Keep all content.',
    academic: 'Format for precise academic narration. Spell out all abbreviations.',
    casual:   'Make conversational and friendly for listening.'
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{
        role:    'user',
        content: (prompts[style] || prompts.natural) + '\n\nText:\n' + text.slice(0, 2000)
      }]
    })
  });
  if (!r.ok) throw new Error('API ' + r.status);
  const d = await r.json();
  return d.content?.[0]?.text || text;
}

// ── GENERATION ────────────────────────────────────────────
function _setGenStep(id, state) {
  const el = document.getElementById('gs-' + id);
  if (el) el.className = 'gs ' + state;
}
function _setGenProgress(pct, label, sub) {
  document.getElementById('genProgFill').style.width = pct + '%';
  if (label) document.getElementById('genLabel').textContent = label;
  if (sub)   document.getElementById('genSub').textContent   = sub;
}

// ── APP ───────────────────────────────────────────────────
const AUDIO_FORMATS = ['mp3', 'm4b', 'm4a', 'ogg'];

const App = (() => {
  let currentBookId   = null;
  let pendingBookData = null;   // file metadata before save
  let isGenerating    = false;

  // ── NAVIGATION ─────────────────────────────────────────────
  function showLibrary() {
    document.body.classList.add('mode-library');
    document.body.classList.remove('mode-reader');
    document.getElementById('btnLibraryToggle').innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>' +
      '<rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Library';
    Library.onShow();
  }

  function showReader() {
    document.body.classList.remove('mode-library');
    document.body.classList.add('mode-reader');
    document.getElementById('btnLibraryToggle').innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>' +
      '<rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Library';
  }

  async function init() {
    // Start in library mode
    document.body.classList.add('mode-library');

    // Ensure overlay is hidden on startup
    const overlay = document.getElementById('generatingOverlay');
    if (overlay) {
      overlay.style.display = 'none';
    }

    // Ensure welcome screen is visible
    const welcome = document.getElementById('readerWelcome');
    if (welcome) {
      welcome.style.display = 'flex';
    }

    // Initialize responsive helpers
    _initResponsiveHelpers();

    // Wire buttons
    document.getElementById('btnAddBook').addEventListener('click',    addBook);
    document.getElementById('btnSettings').addEventListener('click',   UI.openSettingsModal);
    document.getElementById('claudePill').addEventListener('click',    UI.openClaudeModal);
    document.getElementById('btnResume').addEventListener('click',     UI.resumeBook);
    document.getElementById('btnStartOver').addEventListener('click',  UI.startFromBeginning);
    document.getElementById('btnLibraryToggle').addEventListener('click', () => {
      if (document.body.classList.contains('mode-library') && currentBookId) {
        showReader();
      } else {
        showLibrary();
      }
    });

    // Load saved settings
    const fontSize = await window.sonara.settings.get('fontSize', '17');
    document.documentElement.style.setProperty('--font-reader', fontSize + 'px');
    document.getElementById('settingFontSize').value = fontSize;

    const autoSave = await window.sonara.settings.get('autoSave', 10);
    document.getElementById('settingAutoSave').value = autoSave;

    // Load saved theme
    const savedTheme = await window.sonara.settings.get('theme', 'black');
    UI._applyThemeVisual(savedTheme);

    // Claude key
    const savedKey = await window.sonara.settings.get('claude_key', '');
    if (savedKey) {
      sessionStorage.setItem('sonara_claude_key', savedKey);
      UI._updateClaudeUI(true);
    }

    // Load library
    await Library.load();

    // Init voices
    Reader.initVoices();
    await Reader.applySettings();

    // Save progress on window close
    window.addEventListener('beforeunload', () => {
      Reader.saveProgress();
    });

    // Listen for visibility change (background tab / minimize)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        Reader.saveProgress();
      }
    });

    // Auto-load last opened book
    const lastBookId = await window.sonara.settings.get('lastBookId', null);
    if (lastBookId) {
      try {
        const book = await window.sonara.library.getBook(lastBookId);
        if (book) {
          const fileExists = await window.sonara.file.exists(book.file_path);
          if (fileExists) {
            setTimeout(() => {
              openBook(lastBookId).catch(err => {
                UI.toast('Could not auto-load last book', 'error');
              });
            }, 100);
          } else {
            await window.sonara.settings.set('lastBookId', '');
          }
        } else {
          await window.sonara.settings.set('lastBookId', '');
        }
      } catch (err) {
      }
    }

    UI.toast('Welcome to Sonara', 'success', 2500);
  }

  // ── ADD BOOK ─────────────────────────────────────────────
  async function addBook() {
    try {
      const fileInfo = await window.sonara.dialog.openFile();
      if (!fileInfo) return;

      // Check file size (warn if > 50MB, reject if > 200MB)
      const sizeMB = fileInfo.size / (1024 * 1024);

      if (sizeMB > 200) {
        UI.toast('File too large (' + sizeMB.toFixed(0) + 'MB). Maximum size is 200MB.', 'error');
        return;
      }
      
      if (sizeMB > 50) {
        const proceed = confirm(
          'This file is quite large (' + sizeMB.toFixed(1) + 'MB).\\n\\n' +
          'Processing may take several minutes and use significant memory.\\n\\n' +
          'Consider using a smaller file if possible.\\n\\n' +
          'Continue anyway?'
        );
        if (!proceed) return;
      }

      // Generate stable ID from name + size
      const rawId = fileInfo.name + '_' + fileInfo.size;
      const id    = btoa(rawId).replace(/[^a-zA-Z0-9]/g,'').slice(0, 20);

      // Check if book already exists
      const exists = await window.sonara.library.bookExists(id);
      if (exists) {
        UI.toast('This book is already in your library', 'error');
        await openBook(id); // Just open it instead
        return;
      }

      pendingBookData = {
        id,
        title:      fileInfo.name.replace(/\.(pdf|epub|mp3|m4b|m4a|ogg)$/i, '').replace(/[-_]/g, ' '),
        format:     fileInfo.format,
        sourcePath: fileInfo.path,
        fileName:   fileInfo.name,
        fileSize:   fileInfo.size
      };

      if (AUDIO_FORMATS.includes(fileInfo.format)) {
        await _processAudioFile(id, fileInfo);
      } else {
        await _processFile(id, fileInfo);
      }
    } catch (err) {
      UI.toast('Failed to add book: ' + err.message, 'error');
    }
  }

  // ── OPEN BOOK FROM LIBRARY ───────────────────────────────
  async function openBook(id) {
    try {
      const book = await window.sonara.library.getBook(id);
      if (!book) { UI.toast('Book not found in library', 'error'); return; }

      // Check file still exists
      const exists = await window.sonara.file.exists(book.file_path);
      if (!exists) {
        UI.toast('File missing — please re-add "' + book.title + '"', 'error');
        return;
      }

      // If same book already parsed, just jump
      if (id === currentBookId) {
        const progress = await window.sonara.progress.get(id);
        if (progress?.chunk_index > 0) {
          Reader.jumpToChunk(progress.chunk_index);
        }
        _updateNavPanel(id).catch(() => {});
        Notes.load(id);
        showReader();
        return;
      }

      // Load file & parse
      pendingBookData = {
        id,
        title:      book.title,
        format:     book.format,
        sourcePath: book.file_path,
        fileName:   book.file_name,
        fileSize:   book.file_size
      };

      if (AUDIO_FORMATS.includes(book.format)) {
        await _openAudioBook(book);
      } else {
        await _processFile(id, { path: book.file_path, name: book.file_name, size: book.file_size, format: book.format });
      }
    } catch (err) {
      UI.toast('Could not open book: ' + err.message, 'error');
    }
  }

  // ── OPEN AUDIOBOOK (already in library) ────────────────────
  async function _openAudioBook(book) {
    currentBookId = book.id;
    const progress = await window.sonara.progress.get(book.id);
    Reader.loadAudioBook(book, progress);
    await window.sonara.settings.set('lastBookId', book.id);
    Library.setActiveCard(book.id);
    _updateNavPanel(book.id);
    Notes.load(book.id);
    showReader();
    pendingBookData = null;
  }

  // ── PROCESS FILE ─────────────────────────────────────────
  async function _processFile(id, fileInfo) {
    if (isGenerating) {
      UI.toast('Please wait, a book is already being processed…', 'error');
      return;
    }
    isGenerating = true;

    // Switch to reader view first so the generating overlay is visible
    showReader();

    // Show generating overlay
    const overlay = document.getElementById('generatingOverlay');
    overlay.style.display = 'flex';
    document.getElementById('readerWelcome').style.display   = 'none';
    document.getElementById('chapterTitlebar').style.display = 'none';
    document.getElementById('readerTextWrap').style.display  = 'none';
    document.getElementById('readerPdfWrap').style.display   = 'none';

    _setGenStep('extract','active'); _setGenProgress(5, 'Reading file…', fileInfo.name);

    try {
      // 1. Read file as base64
      const base64 = await window.sonara.file.read(fileInfo.path);
      if (!base64) throw new Error('Could not read file');

      _setGenStep('extract','done'); _setGenStep('clean','active');
      _setGenProgress(20, 'Extracting text…', 'Parsing ' + fileInfo.format.toUpperCase());

      // 2. Parse
      let chunks;
      if (fileInfo.format === 'epub') {
        chunks = await Parser.parseEPUB(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting chapters…', p + '%'));
      } else {
        chunks = await Parser.parsePDF(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting pages…', p + '%'));
      }

      if (!chunks || !chunks.length) throw new Error('No readable text found in file');

      _setGenStep('clean','done'); _setGenStep('ai','active');
      _setGenProgress(52, 'Cleaning text…', chunks.length + ' sections');
      await _sleep(200);

      // 3. Claude enhancement (optional, first 3 chunks only)
      const claudeKey = UI.getClaudeKey();
      if (claudeKey) {
        const n = Math.min(3, chunks.length);
        for (let i = 0; i < n; i++) {
          _setGenProgress(52 + ((i / n) * 25), 'Claude AI: section ' + (i+1) + '…', '');
          try {
            chunks[i].text = await enhanceWithClaude(chunks[i].text, claudeKey);
          } catch(e) {
            UI.toast('Claude unavailable — using raw text', 'error');
            break;
          }
        }
      }

      _setGenStep('ai','done'); _setGenStep('tts','active');
      _setGenProgress(78, 'Setting up voice…', '');
      await _sleep(200);

      // 4. Estimate duration
      const words       = chunks.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
      const speed       = parseFloat(document.getElementById('speedSlider').value) || 1.0;
      const totalSecs   = Math.round((words / (150 * speed)) * 60);

      // 5. Save to library DB (only insert new books; update existing to preserve progress)
      const bookExists = await window.sonara.library.bookExists(id);
      if (!bookExists) {
        const bookRecord = {
          id,
          title:       pendingBookData.title,
          format:      fileInfo.format,
          sourcePath:  fileInfo.path,
          fileName:    fileInfo.name,
          fileSize:    fileInfo.size,
          totalChunks: chunks.length,
          totalSeconds: totalSecs
        };
        await window.sonara.library.addBook(bookRecord);
      } else {
        await window.sonara.library.updateBook(id, { total_chunks: chunks.length, total_seconds: totalSecs });
      }

      _setGenStep('tts','done'); _setGenStep('done','active');
      _setGenProgress(94, 'Almost ready…', '');
      await _sleep(200);

      // 6. Check for saved progress
      let resumeData = null;
      const savedProgress = await window.sonara.progress.get(id);

      if (savedProgress && savedProgress.chunk_index > 0 && savedProgress.percent < 98) {
        const action = await UI.showResumeDialog({ title: pendingBookData.title, format: fileInfo.format }, savedProgress);
        if (action === 'resume') {
          resumeData = savedProgress;
          UI.toast('Resuming from ' + savedProgress.percent + '%', 'success');
        } else {
          await window.sonara.progress.reset(id);
          resumeData = null;
        }
      }

      _setGenStep('done','done');
      _setGenProgress(100, 'Ready!', '');
      await _sleep(150);

      // 6b. Extract cover image
      try {
        let coverData = null;
        if (fileInfo.format === 'epub') {
          coverData = await Parser.extractEPUBCover(base64);
        } else if (fileInfo.format === 'pdf') {
          coverData = await Parser.extractPDFCover(base64);
        }
        if (coverData) {
          await window.sonara.cover.save({ bookId: id, base64: coverData.base64, mediaType: coverData.mediaType });
        }
      } catch (coverErr) {
      }

      // 7. Load into reader
      currentBookId = id;
      Reader.loadBook(chunks, id, resumeData);
      // Update player bar book info
      const _pmTitle = document.getElementById('pbMetaTitle');
      const _pmAuthor = document.getElementById('pbMetaAuthor');
      if (_pmTitle) _pmTitle.textContent = pendingBookData.title || '';
      if (_pmAuthor) _pmAuthor.textContent = pendingBookData.author || '';
      _updateNavPanel(id); // update left panel cover + nav
      Notes.load(id);      // load notes for this book

      // Save as last-opened book for auto-load on next startup
      await window.sonara.settings.set('lastBookId', id);

      // Refresh library - ensure it updates
      await Library.load();
      await _sleep(100); // Give time for DOM to update
      Library.setActiveCard(id);

      // Hide overlay, show reader
      overlay.style.display = 'none';
      showReader();

      UI.toast(pendingBookData.title + ' — press play to listen!', 'success');

    } catch (err) {
      overlay.style.display = 'none';
      document.getElementById('readerWelcome').style.display = 'flex';
      UI.toast('Error: ' + err.message, 'error');
    } finally {
      isGenerating   = false;
      pendingBookData = null;
    }
  }

  // ── PROCESS AUDIO FILE ────────────────────────────────────
  async function _processAudioFile(id, fileInfo) {
    if (isGenerating) {
      UI.toast('Please wait, a book is already being processed…', 'error');
      return;
    }
    isGenerating = true;

    // Switch to reader view first so the generating overlay is visible
    showReader();

    const overlay = document.getElementById('generatingOverlay');
    overlay.style.display = 'flex';
    document.getElementById('readerWelcome').style.display = 'none';

    _setGenStep('extract', 'active'); _setGenProgress(10, 'Importing audiobook...', fileInfo.name);

    try {
      // 1. Save to library (copies the file)
      const bookRecord = {
        id,
        title:       pendingBookData.title,
        format:      fileInfo.format,
        sourcePath:  fileInfo.path,
        fileName:    fileInfo.name,
        fileSize:    fileInfo.size,
        totalChunks: 1,
        totalSeconds: 0
      };
      const saved = await window.sonara.library.addBook(bookRecord);
      _setGenProgress(40, 'Reading audio metadata...', '');

      // 2. Get duration from the copied file
      const duration = await _getAudioDuration(saved.file_path);
      await window.sonara.library.updateBook(id, {
        duration_seconds: duration,
        total_seconds: Math.round(duration)
      });

      _setGenStep('extract', 'done'); _setGenStep('done', 'active');
      _setGenProgress(100, 'Ready!', '');
      await _sleep(200);

      // 3. Update library and stay in library view
      currentBookId = id;
      overlay.style.display = 'none';
      await Library.load();
      showLibrary();
      UI.toast(pendingBookData.title + ' added to library!', 'success');

    } catch (err) {
      overlay.style.display = 'none';
      UI.toast('Error: ' + err.message, 'error');
    } finally {
      isGenerating = false;
      pendingBookData = null;
    }
  }

  function _getAudioDuration(filePath) {
    return new Promise((resolve) => {
      const audio = new Audio('file:///' + filePath.replace(/\\/g, '/'));
      audio.addEventListener('loadedmetadata', () => {
        resolve(audio.duration || 0);
        audio.src = '';
      });
      audio.addEventListener('error', () => resolve(0));
      // Timeout fallback
      setTimeout(() => resolve(0), 5000);
    });
  }

  function clearCurrentBook() {
    currentBookId = null;
    window.sonara.settings.set('lastBookId', '');
    Reader.stop();
    document.getElementById('readerWelcome').style.display   = 'flex';
    document.getElementById('chapterTitlebar').style.display = 'none';
    document.getElementById('readerTextWrap').style.display  = 'none';
    document.getElementById('readerPdfWrap').style.display   = 'none';
    document.getElementById('tbCenter').textContent = '';
    Library.setActiveCard(null);
    _updateNavPanel(null); // clear nav panel
    Notes.clear();         // clear notes panel
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── NAV PANEL (left panel cover + chapter list) ──────────
  async function _updateNavPanel(bookId) {
    const navEmpty = document.getElementById('navEmpty');
    const navBook  = document.getElementById('navBook');
    if (!navEmpty || !navBook) return;

    if (!bookId) {
      navEmpty.style.display = 'flex';
      navBook.style.display  = 'none';
      return;
    }

    navEmpty.style.display = 'none';
    navBook.style.display  = 'flex';

    // Populate title / author
    try {
      const book = await window.sonara.library.getBook(bookId);
      if (book) {
        document.getElementById('navBookTitle').textContent  = book.title  || '—';
        document.getElementById('navBookAuthor').textContent = book.author || '';
      }
    } catch (_) {}

    // Load cover art
    const coverImg = document.getElementById('navCoverImg');
    const coverPlc = document.getElementById('navCoverPlaceholder');
    try {
      const coverPath = await window.sonara.cover.getPath(bookId);
      if (coverPath) {
        coverImg.src           = 'file:///' + coverPath.replace(/\\/g, '/');
        coverImg.style.display = 'block';
        coverPlc.style.display = 'none';
      } else {
        coverImg.style.display = 'none';
        coverPlc.style.display = 'flex';
      }
    } catch (_) {
      coverImg.style.display = 'none';
      coverPlc.style.display = 'flex';
    }
  }

  // ── RESPONSIVE HELPERS ───────────────────────────────────
  function _initResponsiveHelpers() {
    let lastWidth = window.innerWidth;

    // Handle window resize
    window.addEventListener('resize', () => {
      const currentWidth = window.innerWidth;

      // If crossing mobile threshold, adjust UI
      if ((lastWidth > 768 && currentWidth <= 768) || (lastWidth <= 768 && currentWidth > 768)) {
        _handleBreakpointChange(currentWidth);
      }

      lastWidth = currentWidth;
    });

    // Initialize based on current size
    _handleBreakpointChange(window.innerWidth);

    // Add mobile-specific touch event handling
    if ('ontouchstart' in window) {
      document.body.classList.add('touch-device');

      // Prevent double-tap zoom on buttons
      document.querySelectorAll('button, .clickable').forEach(el => {
        el.addEventListener('touchend', (e) => {
          e.preventDefault();
          el.click();
        }, { passive: false });
      });
    }

    // Add viewport height CSS variable for mobile browsers
    const setVH = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setVH();
    window.addEventListener('resize', setVH);
    window.addEventListener('orientationchange', () => {
      setTimeout(setVH, 100);
    });

    // Handle mobile voice selection - show in modal on mobile
    if (window.innerWidth <= 768) {
      const voiceBar = document.getElementById('voiceSelBar');
      if (voiceBar) {
        voiceBar.style.cursor = 'pointer';
        voiceBar.addEventListener('click', () => {
          _showMobileVoiceModal();
        });
      }
    }

    // Init panel resize and right-panel toggle
    _initPanelResize();
    _initRightPanelToggle();
  }

  // ── PANEL DRAG-TO-RESIZE ──────────────────────────────────
  function _initPanelResize() {
    const root = document.documentElement;

    // Load saved panel widths from settings
    async function _loadSavedWidths() {
      const lw = await window.sonara.settings.get('panelLeftW',  null);
      const rw = await window.sonara.settings.get('panelRightW', null);
      if (lw  && lw  > 0) root.style.setProperty('--left-w',  lw  + 'px');
      if (rw  && rw  > 0) root.style.setProperty('--right-w', rw  + 'px');
    }

    function _makeDragger(handleEl, side) {
      handleEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        handleEl.classList.add('dragging');
        document.body.style.cursor     = 'col-resize';
        document.body.style.userSelect = 'none';

        const startX = e.clientX;
        const cs     = getComputedStyle(root);
        const initLW = parseInt(cs.getPropertyValue('--left-w'))  || 240;
        const initRW = parseInt(cs.getPropertyValue('--right-w')) || 260;

        const MIN_LEFT  = 160, MAX_LEFT  = 400;
        const MIN_RIGHT = 180, MAX_RIGHT = 420;
        const MIN_CENTER = 380; // always keep center readable

        function _onMove(ev) {
          const dx = ev.clientX - startX;
          const totalW = window.innerWidth;

          if (side === 'left') {
            const rw = parseInt(getComputedStyle(root).getPropertyValue('--right-w')) || initRW;
            const maxAllowed = Math.min(MAX_LEFT, totalW - rw - MIN_CENTER - 12);
            const nw = Math.max(MIN_LEFT, Math.min(maxAllowed, initLW + dx));
            root.style.setProperty('--left-w', nw + 'px');
          } else {
            const lw = parseInt(getComputedStyle(root).getPropertyValue('--left-w')) || initLW;
            const maxAllowed = Math.min(MAX_RIGHT, totalW - lw - MIN_CENTER - 12);
            // dragging right handle: moving right makes panel smaller
            const nw = Math.max(MIN_RIGHT, Math.min(maxAllowed, initRW - dx));
            root.style.setProperty('--right-w', nw + 'px');
          }
        }

        function _onUp() {
          handleEl.classList.remove('dragging');
          document.body.style.cursor     = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', _onMove);
          document.removeEventListener('mouseup',   _onUp);
          // Persist widths
          const cs2 = getComputedStyle(root);
          const lw2 = parseInt(cs2.getPropertyValue('--left-w'));
          const rw2 = parseInt(cs2.getPropertyValue('--right-w'));
          window.sonara.settings.set('panelLeftW',  lw2);
          window.sonara.settings.set('panelRightW', rw2);
        }

        document.addEventListener('mousemove', _onMove);
        document.addEventListener('mouseup',   _onUp);
      });
    }

    const hLeft  = document.getElementById('resizeLeft');
    const hRight = document.getElementById('resizeRight');
    if (hLeft)  _makeDragger(hLeft,  'left');
    if (hRight) _makeDragger(hRight, 'right');

    _loadSavedWidths();
  }

  // ── RIGHT PANEL COLLAPSE TOGGLE ───────────────────────────
  function _initRightPanelToggle() {
    const btn    = document.getElementById('btnToggleRight');
    const layout = document.querySelector('.layout');
    if (!btn || !layout) return;

    let collapsed = false;

    // Restore saved state
    window.sonara.settings.get('rpCollapsed', false).then(saved => {
      if (saved) {
        collapsed = true;
        layout.classList.add('rp-collapsed');
        btn.classList.add('active');
      }
    });

    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      layout.classList.toggle('rp-collapsed', collapsed);
      btn.classList.toggle('active', collapsed);
      window.sonara.settings.set('rpCollapsed', collapsed);
    });
  }

  function _handleBreakpointChange(width) {
    if (width <= 768) {
      // Mobile mode
      document.body.classList.add('mobile-layout');

      // Auto-collapse panels when in reader mode
      const panelLeft = document.getElementById('panelLeft');
      const panelRight = document.getElementById('panelRight');

      if (panelLeft) {
        panelLeft.style.transition = 'max-height 0.3s ease';
      }
      if (panelRight) {
        panelRight.style.transition = 'max-height 0.3s ease';
      }
    } else {
      // Desktop mode
      document.body.classList.remove('mobile-layout');
    }

    // Adjust modals for screen size
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
      if (width <= 480) {
        modal.style.maxWidth = '95%';
      } else if (width <= 768) {
        modal.style.maxWidth = '90%';
      } else {
        modal.style.maxWidth = '';
      }
    });
  }

  function _showMobileVoiceModal() {
    // On mobile, show voice list in a full modal instead of inline
    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.innerHTML = `
      <div class="modal" style="max-width: 95%; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;">
        <div class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</div>
        <h2 class="modal-title">Select Voice</h2>
        <p class="modal-sub">Choose a voice for narration</p>
        <div class="voice-search-row" style="margin-bottom: 10px;">
          <input type="text" class="voice-srch" id="mobileVoiceSearch" placeholder="Search voices…"
            oninput="Reader.filterVoices()" style="flex: 1;" />
          <select class="voice-lang" id="mobileLangFilter" onchange="Reader.filterVoices()" style="width: auto;">
            <option value="">All</option>
          </select>
        </div>
        <div style="flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px;">
          <div id="mobileVoiceList"></div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn-primary" onclick="this.closest('.modal-overlay').remove()">Done</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Copy voice list content
    const sourceList = document.getElementById('voiceList');
    const targetList = document.getElementById('mobileVoiceList');
    if (sourceList && targetList) {
      targetList.innerHTML = sourceList.innerHTML;

      // Re-attach event listeners
      targetList.querySelectorAll('.voice-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (!e.target.closest('.vi-pbtn')) {
            const voiceName = item.getAttribute('data-voice-name');
            if (voiceName) {
              Reader.selectVoice(voiceName);
              modal.remove();
            }
          }
        });
      });

      targetList.querySelectorAll('.vi-pbtn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const voiceName = btn.getAttribute('data-preview-voice');
          if (voiceName) {
            Reader.previewVoice(voiceName);
          }
        });
      });
    }

    // Copy language options
    const sourceLang = document.getElementById('langFilter');
    const targetLang = document.getElementById('mobileLangFilter');
    if (sourceLang && targetLang) {
      targetLang.innerHTML = sourceLang.innerHTML;
    }

    // Wire search
    const searchInput = document.getElementById('mobileVoiceSearch');
    const sourceSearch = document.getElementById('voiceSearch');
    if (searchInput && sourceSearch) {
      searchInput.value = sourceSearch.value;
    }

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  return {
    init, addBook, openBook, clearCurrentBook,
    showLibrary, showReader,
    get currentBookId() { return currentBookId; }
  };
})();

// ── BOOT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(() => {});
});
