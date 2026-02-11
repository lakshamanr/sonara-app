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
    const version = await window.sonara.app.getVersion();
    document.getElementById('settingVersion').textContent = version;
    // Sync swatch to current theme
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === currentTheme);
    });
    openModal('modalSettings');
  }

  async function saveSettings() {
    const fontSize = document.getElementById('settingFontSize').value;
    const autoSave = document.getElementById('settingAutoSave').value;
    document.documentElement.style.setProperty('--font-reader', fontSize + 'px');
    await window.sonara.settings.set('fontSize', fontSize);
    await window.sonara.settings.set('autoSave', autoSave);
    await window.sonara.settings.set('theme', currentTheme);
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
    console.log('[UI] Resume button clicked');
    closeModal('modalResume');
    if (resumeResolve) { resumeResolve('resume'); resumeResolve = null; }
  }

  function startFromBeginning() {
    console.log('[UI] Start Over button clicked');
    closeModal('modalResume');
    if (resumeResolve) { resumeResolve('restart'); resumeResolve = null; }
  }

  return {
    toast, openModal, closeModal,
    openClaudeModal, saveClaudeKey, getClaudeKey, _updateClaudeUI,
    openSettingsModal, saveSettings,
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
const App = (() => {
  let currentBookId   = null;
  let pendingBookData = null;   // file metadata before save
  let isGenerating    = false;

  async function init() {
    console.log('[App] Initializing...');
    
    // Ensure overlay is hidden on startup
    const overlay = document.getElementById('generatingOverlay');
    if (overlay) {
      overlay.style.display = 'none';
      console.log('[App] Overlay hidden on init');
    }
    
    // Ensure welcome screen is visible
    const welcome = document.getElementById('readerWelcome');
    if (welcome) {
      welcome.style.display = 'flex';
      console.log('[App] Welcome screen visible');
    }
    
    // Wire buttons
    document.getElementById('btnAddBook').addEventListener('click',    addBook);
    document.getElementById('btnSettings').addEventListener('click',   UI.openSettingsModal);
    document.getElementById('claudePill').addEventListener('click',    UI.openClaudeModal);
    document.getElementById('btnResume').addEventListener('click',     UI.resumeBook);
    document.getElementById('btnStartOver').addEventListener('click',  UI.startFromBeginning);

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
    console.log('[App] Loading library...');
    await Library.load();

    // Init voices
    console.log('[App] Initializing voices...');
    Reader.initVoices();
    await Reader.applySettings();

    // Save progress on window close
    window.addEventListener('beforeunload', () => {
      console.log('[App] Window closing - saving progress');
      Reader.saveProgress();
    });

    // Listen for visibility change (background tab / minimize)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        Reader.saveProgress();
      }
    });

    console.log('[App] Initialization complete');

    // Auto-load last opened book
    const lastBookId = await window.sonara.settings.get('lastBookId', null);
    if (lastBookId) {
      console.log('[App] Auto-loading last book:', lastBookId);
      try {
        const book = await window.sonara.library.getBook(lastBookId);
        if (book) {
          const fileExists = await window.sonara.file.exists(book.file_path);
          if (fileExists) {
            setTimeout(() => {
              openBook(lastBookId).catch(err => {
                console.error('[App] Auto-load failed:', err);
                UI.toast('Could not auto-load last book', 'error');
              });
            }, 100);
          } else {
            console.log('[App] Last book file missing, clearing lastBookId');
            await window.sonara.settings.set('lastBookId', '');
          }
        } else {
          console.log('[App] Last book not in library, clearing lastBookId');
          await window.sonara.settings.set('lastBookId', '');
        }
      } catch (err) {
        console.error('[App] Error checking last book:', err);
      }
    }

    UI.toast('Welcome to Sonara 🎧', 'success', 2500);
  }

  // ── ADD BOOK ─────────────────────────────────────────────
  async function addBook() {
    try {
      const fileInfo = await window.sonara.dialog.openFile();
      if (!fileInfo) return;

      // Check file size (warn if > 50MB, reject if > 200MB)
      const sizeMB = fileInfo.size / (1024 * 1024);
      console.log('[App] File size:', sizeMB.toFixed(2), 'MB');
      
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
        title:      fileInfo.name.replace(/\.(pdf|epub)$/i, ''),
        format:     fileInfo.format,
        sourcePath: fileInfo.path,
        fileName:   fileInfo.name,
        fileSize:   fileInfo.size
      };

      await _processFile(id, fileInfo);
    } catch (err) {
      console.error('[App] Error in addBook:', err);
      UI.toast('Failed to add book: ' + err.message, 'error');
    }
  }

  // ── OPEN BOOK FROM LIBRARY ───────────────────────────────
  async function openBook(id) {
    console.log('[App] ============ OPEN BOOK CLICKED ============');
    console.log('[App] openBook called with id:', id);
    console.log('[App] currentBookId:', currentBookId);
    
    const book = await window.sonara.library.getBook(id);
    console.log('[App] Book retrieved from DB:', book);
    if (!book) { UI.toast('Book not found in library', 'error'); return; }

    // Check file still exists
    const exists = await window.sonara.file.exists(book.file_path);
    console.log('[App] File exists:', exists, 'path:', book.file_path);
    if (!exists) {
      UI.toast('File missing — please re-add "' + book.title + '"', 'error');
      return;
    }

    // If same book already parsed, just jump
    if (id === currentBookId) {
      console.log('[App] Same book already loaded, checking progress');
      const progress = await window.sonara.progress.get(id);
      console.log('[App] Current progress:', progress);
      if (progress?.chunk_index > 0) {
        console.log('[App] Jumping to saved chunk:', progress.chunk_index);
        Reader.jumpToChunk(progress.chunk_index);
      }
      return;
    }

    console.log('[App] Different book, will re-parse. Starting _processFile...');
    
    // Load file & parse
    pendingBookData = {
      id,
      title:      book.title,
      format:     book.format,
      sourcePath: book.file_path,
      fileName:   book.file_name,
      fileSize:   book.file_size
    };

    await _processFile(id, { path: book.file_path, name: book.file_name, size: book.file_size, format: book.format });
  }

  // ── PROCESS FILE ─────────────────────────────────────────
  async function _processFile(id, fileInfo) {
    console.log('[App] Processing file:', fileInfo.name, 'ID:', id);
    if (isGenerating) {
      console.log('[App] Already generating, skipping');
      return;
    }
    isGenerating = true;

    // Show generating overlay
    const overlay = document.getElementById('generatingOverlay');
    console.log('[App] Showing overlay');
    overlay.style.display = 'flex';
    document.getElementById('readerWelcome').style.display   = 'none';
    document.getElementById('chapterTitlebar').style.display = 'none';
    document.getElementById('readerTextWrap').style.display  = 'none';

    _setGenStep('extract','active'); _setGenProgress(5, 'Reading file…', fileInfo.name);

    try {
      // 1. Read file as base64
      console.log('[App] Reading file from:', fileInfo.path);
      const base64 = await window.sonara.file.read(fileInfo.path);
      console.log('[App] File read, base64 length:', base64 ? base64.length : 'null');
      if (!base64) throw new Error('Could not read file');

      _setGenStep('extract','done'); _setGenStep('clean','active');
      _setGenProgress(20, 'Extracting text…', 'Parsing ' + fileInfo.format.toUpperCase());

      // 2. Parse
      console.log('[App] Parsing', fileInfo.format, 'file');
      let chunks;
      if (fileInfo.format === 'epub') {
        chunks = await Parser.parseEPUB(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting chapters…', p + '%'));
      } else {
        chunks = await Parser.parsePDF(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting pages…', p + '%'));
      }

      console.log('[App] Parsed chunks:', chunks ? chunks.length : 'null');
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
        console.log('[App] New book, saving to library:', bookRecord);
        await window.sonara.library.addBook(bookRecord);
      } else {
        console.log('[App] Book already exists, updating metadata only');
        await window.sonara.library.updateBook(id, { total_chunks: chunks.length, total_seconds: totalSecs });
      }

      _setGenStep('tts','done'); _setGenStep('done','active');
      _setGenProgress(94, 'Almost ready…', '');
      await _sleep(200);

      // 6. Check for saved progress
      let resumeData = null;
      const savedProgress = await window.sonara.progress.get(id);
      console.log('[App] ========== PROGRESS CHECK ==========');
      console.log('[App] Checking saved progress for id:', id);
      console.log('[App] savedProgress:', savedProgress);
      console.log('[App] chunk_index:', savedProgress?.chunk_index);
      console.log('[App] percent:', savedProgress?.percent);
      console.log('[App] Condition check: chunk_index > 0?', savedProgress?.chunk_index > 0);
      console.log('[App] Condition check: percent < 98?', savedProgress?.percent < 98);
      
      if (savedProgress && savedProgress.chunk_index > 0 && savedProgress.percent < 98) {
        console.log('[App] ✓ Progress exists! Showing resume dialog at', savedProgress.percent + '%');
        const action = await UI.showResumeDialog({ title: pendingBookData.title, format: fileInfo.format }, savedProgress);
        console.log('[App] Resume dialog action:', action);
        if (action === 'resume') {
          resumeData = savedProgress;
          console.log('[App] ✓ User chose RESUME, resumeData set:', resumeData);
          UI.toast('Resuming from ' + savedProgress.percent + '%', 'success');
        } else {
          console.log('[App] ✗ User chose START OVER, resetting progress');
          await window.sonara.progress.reset(id);
          resumeData = null;
        }
      } else {
        console.log('[App] ✗ No valid progress found. Starting from beginning.');
        console.log('[App] Reason: ', !savedProgress ? 'No progress record' : savedProgress.chunk_index <= 0 ? 'chunk_index <= 0' : 'percent >= 98');
      }
      console.log('[App] ========================================');

      _setGenStep('done','done');
      _setGenProgress(100, 'Ready!', '');
      await _sleep(150);

      // 7. Load into reader
      console.log('[App] ========== LOADING INTO READER ==========');
      console.log('[App] bookId:', id);
      console.log('[App] chunks count:', chunks.length);
      console.log('[App] resumeData:', resumeData);
      if (resumeData) {
        console.log('[App] ✓ Will resume at chunk:', resumeData.chunk_index, '(' + resumeData.percent + '%)');
      } else {
        console.log('[App] ✗ No resumeData - starting from beginning');
      }
      console.log('[App] =============================================');
      
      currentBookId = id;
      Reader.loadBook(chunks, id, resumeData);

      // Save as last-opened book for auto-load on next startup
      await window.sonara.settings.set('lastBookId', id);

      // Refresh library - ensure it updates
      console.log('[App] Refreshing library');
      await Library.load();
      await _sleep(100); // Give time for DOM to update
      Library.setActiveCard(id);

      // Hide overlay, show reader
      console.log('[App] Hiding overlay');
      overlay.style.display = 'none';

      console.log('[App] Processing complete!');
      UI.toast('🎧 ' + pendingBookData.title + ' — press ▶ to listen!', 'success');

    } catch (err) {
      console.error('[App] Error processing file:', err);
      overlay.style.display = 'none';
      document.getElementById('readerWelcome').style.display = 'flex';
      UI.toast('Error: ' + err.message, 'error');
      console.error('[App] Full error:', err);
    } finally {
      isGenerating   = false;
      pendingBookData = null;
      console.log('[App] Process complete, isGenerating:', isGenerating);
    }
  }

  function clearCurrentBook() {
    currentBookId = null;
    window.sonara.settings.set('lastBookId', '');
    Reader.stop();
    document.getElementById('readerWelcome').style.display   = 'flex';
    document.getElementById('chapterTitlebar').style.display = 'none';
    document.getElementById('readerTextWrap').style.display  = 'none';
    document.getElementById('tbCenter').textContent = '';
    document.getElementById('chaptersList').innerHTML = '<div class="chapters-empty">Open a book to see chapters</div>';
    Library.setActiveCard(null);
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return {
    init, addBook, openBook, clearCurrentBook,
    get currentBookId() { return currentBookId; }
  };
})();

// ── BOOT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(console.error);
});
