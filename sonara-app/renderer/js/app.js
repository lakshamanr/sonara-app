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

  function closeTopModal() {
    const openModals = [...document.querySelectorAll('.modal-overlay.open')];
    if (!openModals.length) return false;
    const topModal = openModals[openModals.length - 1];
    if (topModal.id) topModal.classList.remove('open');
    else topModal.remove();
    return true;
  }

  function openShortcutsModal() {
    openModal('modalShortcuts');
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
    // Load unified data folder path
    try {
      const dataPath = await window.sonara.data.getDir();
      const el = document.getElementById('dataFolderPath');
      if (el) { el.textContent = dataPath || ''; el.title = dataPath || ''; }
    } catch {}
    // Load TTS skip chars
    try {
      const skipChars = await window.sonara.settings.get('ttsSkipChars', '*_~#');
      const el = document.getElementById('settingTtsSkipChars');
      if (el) el.value = skipChars || '';
    } catch {}
    // Load TTS skip words
    try {
      const skipWords = await window.sonara.settings.get('ttsSkipWords', '');
      const el = document.getElementById('settingTtsSkipWords');
      if (el) el.value = skipWords || '';
    } catch {}
    // Load Turso config
    try {
      const { url, token } = await window.sonara.db.getTursoConfig();
      const urlEl   = document.getElementById('tursoUrl');
      const tokenEl = document.getElementById('tursoToken');
      if (urlEl)   urlEl.value   = url   || '';
      if (tokenEl) tokenEl.value = token || '';
    } catch {}

    // Load Google Drive config/status
    try {
      const cfg = await window.sonara.drive.getConfig();
      const status = await window.sonara.drive.getStatus();
      const cId = document.getElementById('driveClientId');
      const cSecret = document.getElementById('driveClientSecret');
      const rToken = document.getElementById('driveRefreshToken');
      const autoSync = document.getElementById('driveAutoSync');
      if (cId) cId.value = cfg.clientId || '';
      if (cSecret) cSecret.value = cfg.clientSecret || '';
      if (rToken) rToken.value = cfg.refreshToken || '';
      if (autoSync) autoSync.checked = !!cfg.autoSync;
      _setDriveConnectedUi(!!status.configured);
      _driveStatus(status.lastSyncAt
        ? `Ready. Last sync: ${new Date(status.lastSyncAt).toLocaleString()}`
        : 'Configure credentials to enable sync',
      status.configured ? 'ok' : '');
      if (status.lastError) _driveStatus('Last error: ' + status.lastError, 'err');
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

  async function openDataFolder() {
    try {
      await window.sonara.data.openDir();
    } catch (err) { toast('Could not open data folder: ' + err.message, 'error'); }
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

  function _driveStatus(msg, type) {
    const el = document.getElementById('driveStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sync-status ' + (type || '');
  }

  function _setDriveConnectedUi(isConnected) {
    const connectBtn = document.getElementById('btnDriveConnect');
    const disconnectBtn = document.getElementById('btnDriveDisconnect');
    if (connectBtn) connectBtn.disabled = !!isConnected;
    if (disconnectBtn) disconnectBtn.disabled = !isConnected;
  }

  async function _driveReadConfigFromForm() {
    return {
      clientId: (document.getElementById('driveClientId')?.value || '').trim(),
      clientSecret: (document.getElementById('driveClientSecret')?.value || '').trim(),
      refreshToken: (document.getElementById('driveRefreshToken')?.value || '').trim(),
      autoSync: !!document.getElementById('driveAutoSync')?.checked,
    };
  }

  async function saveDriveConfig() {
    const cfg = await _driveReadConfigFromForm();
    await window.sonara.drive.saveConfig(cfg);
    _driveStatus('✔ Google Drive credentials saved', 'ok');
    setTimeout(() => _driveStatus(''), 2500);
  }

  async function connectDrive() {
    const btn = document.getElementById('btnDriveConnect');
    if (btn) btn.disabled = true;
    _driveStatus('Opening Google sign-in…', '');
    try {
      const cfg = await _driveReadConfigFromForm();
      await window.sonara.drive.saveConfig(cfg);
      await window.sonara.drive.connect();
      const status = await window.sonara.drive.getStatus();
      _setDriveConnectedUi(status.configured);
      _driveStatus('✔ Google Drive connected', 'ok');
      toast('Google Drive connected successfully', 'success', 2600);
    } catch (err) {
      _driveStatus('✘ ' + err.message, 'err');
      toast('Google connect failed: ' + err.message, 'error', 3800);
    } finally {
      const status = await window.sonara.drive.getStatus().catch(() => ({ configured: false }));
      _setDriveConnectedUi(status.configured);
      if (btn) btn.disabled = !!status.configured;
    }
  }

  async function disconnectDrive() {
    try {
      await window.sonara.drive.disconnect();
      _setDriveConnectedUi(false);
      _driveStatus('Disconnected from Google Drive', '');
      toast('Google Drive disconnected', 'success', 2500);
    } catch (err) {
      _driveStatus('✘ ' + err.message, 'err');
      toast('Disconnect failed: ' + err.message, 'error', 3200);
    }
  }

  async function testDriveConnection() {
    const cfg = await _driveReadConfigFromForm();
    _driveStatus('Testing…', '');
    try {
      await window.sonara.drive.saveConfig(cfg);
      await window.sonara.drive.testConnection();
      _driveStatus('✔ Connected to Google Drive', 'ok');
      _setDriveConnectedUi(true);
    } catch (err) {
      _driveStatus('✘ ' + err.message, 'err');
      _setDriveConnectedUi(false);
    }
  }

  async function syncDriveNow() {
    const cfg = await _driveReadConfigFromForm();
    const btn = document.getElementById('btnSyncDrive');
    if (btn) btn.disabled = true;
    _driveStatus('Syncing files + metadata…', '');
    try {
      await window.sonara.drive.saveConfig(cfg);
      const result = await window.sonara.drive.syncNow();
      _driveStatus(
        `✔ Uploaded ${result.pushed.mediaFiles} files, pulled ${result.pulled.downloadedMedia} files`,
        'ok'
      );
      toast('Google Drive sync complete', 'success', 3000);
      await Library.load();
    } catch (err) {
      _driveStatus('✘ ' + err.message, 'err');
      toast('Google Drive sync failed: ' + err.message, 'error', 4000);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveSettings() {
    const fontSize  = document.getElementById('settingFontSize').value;
    const autoSave  = document.getElementById('settingAutoSave').value;
    const skipChars = (document.getElementById('settingTtsSkipChars')?.value || '').trim();
    const skipWords = (document.getElementById('settingTtsSkipWords')?.value || '').trim();
    document.documentElement.style.setProperty('--font-reader', fontSize + 'px');
    await window.sonara.settings.set('fontSize',       fontSize);
    await window.sonara.settings.set('autoSave',       autoSave);
    await window.sonara.settings.set('theme',          currentTheme);
    await window.sonara.settings.set('ttsSkipChars',   skipChars);
    await window.sonara.settings.set('ttsSkipWords',   skipWords);
    if (typeof Reader !== 'undefined') { Reader.setSkipChars(skipChars); Reader.setSkipWords(skipWords); }
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
        'You were at ' + pct + '% — ' + (['epub', 'mobi', 'azw3'].includes(book.format) ? 'Chapter' : 'Page') + ' ' + (chunkIdx + 1);
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

  // ── BACKUP ────────────────────────────────────────────────

  function _bkFmtBytes(n) {
    if (!n || n < 1024)    return (n || 0) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function _bkFmtDate(iso) {
    if (!iso) return 'never';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function _bkSetMsg(msg, type) {
    const el = document.getElementById('bkMsg');
    if (!el) return;
    el.textContent  = msg;
    el.className    = 'bk-msg' + (type ? ' bk-msg--' + type : '');
  }

  async function openBackupModal() {
    const res = await window.sonara.backup.getSettings();
    document.getElementById('bkLocation').value    = res.location  || '';
    document.getElementById('bkFrequency').value   = res.frequency || 'daily';
    document.getElementById('bkMaxKeep').value     = String(res.maxKeep ?? 10);
    document.getElementById('bkLastAt').textContent = 'Last backup: ' + _bkFmtDate(res.lastBackupAt);
    _bkSetMsg('');
    await _bkRefreshList();
    openModal('modalBackup');
  }

  async function _bkRefreshList() {
    const listEl = document.getElementById('bkList');
    if (!listEl) return;
    try {
      const items = await window.sonara.backup.list({});
      if (!items || !items.length) {
        listEl.innerHTML = '<div class="bk-empty">No backups found in this folder.</div>';
        return;
      }
      listEl.innerHTML = items.map(b => {
        const fp   = encodeURIComponent(b.backupDir);
        const date = _bkFmtDate(b.manifest?.createdAt || b.modifiedAt);
        const size = _bkFmtBytes(b.totalSize);
        const cnt  = b.manifest ? `${b.manifest.booksCount} books · ${b.manifest.bookFilesCount} files` : '';
        return `<div class="bk-item">
          <div class="bk-item-info">
            <div class="bk-item-date">${date}</div>
            <div class="bk-item-meta">${cnt ? cnt + ' · ' : ''}${size}</div>
          </div>
          <button class="bk-item-restore" data-bkrestore="${fp}" title="Restore">Restore</button>
          <button class="bk-item-del" data-bkdelete="${fp}" title="Delete">&#x2715;</button>
        </div>`;
      }).join('');
    } catch (err) {
      listEl.innerHTML = '<div class="bk-empty">Could not load backups.</div>';
    }
  }

  async function _bkSaveSettings() {
    await window.sonara.backup.setSettings({
      location:  document.getElementById('bkLocation').value,
      frequency: document.getElementById('bkFrequency').value,
      maxKeep:   parseInt(document.getElementById('bkMaxKeep').value, 10) || 0,
    });
  }

  async function _bkRestoreFrom(backupDir) {
    if (!confirm(
      'Restore from this backup?\n\n' +
      'This will replace ALL current books, progress, notes and settings.\n' +
      'The app will reload automatically.'
    )) return;
    _bkSetMsg('Restoring…', '');
    try {
      await window.sonara.backup.restore({ backupDir });
      location.reload();
    } catch (err) {
      _bkSetMsg('Restore failed: ' + err.message, 'err');
    }
  }

  function _bkWireModal() {
    // Browse folder
    document.getElementById('bkBrowseBtn').addEventListener('click', async () => {
      const loc = await window.sonara.backup.chooseLocation();
      if (!loc) return;
      document.getElementById('bkLocation').value = loc;
      await _bkSaveSettings();
      await _bkRefreshList();
    });

    // Frequency / maxKeep autosave
    document.getElementById('bkFrequency').addEventListener('change', _bkSaveSettings);
    document.getElementById('bkMaxKeep').addEventListener('change',   _bkSaveSettings);

    // Backup Now
    document.getElementById('bkNowBtn').addEventListener('click', async () => {
      const btn = document.getElementById('bkNowBtn');
      btn.disabled = true;
      _bkSetMsg('Creating backup…', '');
      try {
        const r = await window.sonara.backup.create({});
        _bkSetMsg('Backup created — ' + _bkFmtBytes(r.totalSize), 'ok');
        const res = await window.sonara.backup.getSettings();
        document.getElementById('bkLastAt').textContent = 'Last backup: ' + _bkFmtDate(res.lastBackupAt);
        await _bkRefreshList();
      } catch (err) {
        _bkSetMsg('Backup failed: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    // Restore from folder dialog
    document.getElementById('bkRestoreFileBtn').addEventListener('click', async () => {
      // Prompt to pick a backup folder via the folder picker
      const loc = await window.sonara.backup.chooseLocation();
      if (!loc) return;
      // If user picked a sonara-backup-* folder directly, restore from it;
      // otherwise treat as the backup location and let them pick from the list.
      if (loc.includes('sonara-backup-')) {
        await _bkRestoreFrom(loc);
      } else {
        document.getElementById('bkLocation').value = loc;
        await _bkSaveSettings();
        await _bkRefreshList();
        _bkSetMsg('Select a backup from the list below to restore.', '');
      }
    });

    // Event delegation for list buttons
    document.getElementById('bkList').addEventListener('click', async e => {
      const rBtn = e.target.closest('[data-bkrestore]');
      if (rBtn) { await _bkRestoreFrom(decodeURIComponent(rBtn.dataset.bkrestore)); return; }

      const dBtn = e.target.closest('[data-bkdelete]');
      if (dBtn) {
        if (!confirm('Delete this backup? This cannot be undone.')) return;
        try {
          await window.sonara.backup.deleteBackup({ backupDir: decodeURIComponent(dBtn.dataset.bkdelete) });
          await _bkRefreshList();
        } catch (err) {
          _bkSetMsg('Delete failed: ' + err.message, 'err');
        }
      }
    });

    // Auto-backup done event
    window.sonara.backup.onDone(data => {
      if (data && !data.success) console.warn('[autoBackup] failed:', data.error);
      if (document.getElementById('modalBackup').classList.contains('open')) {
        window.sonara.backup.getSettings().then(res => {
          document.getElementById('bkLastAt').textContent = 'Last backup: ' + _bkFmtDate(res.lastBackupAt);
        });
        _bkRefreshList();
      }
    });
  }

  return {
    toast, openModal, closeModal,
    closeTopModal, openShortcutsModal,
    openClaudeModal, saveClaudeKey, getClaudeKey, _updateClaudeUI,
    openSettingsModal, saveSettings,
    chooseDbPath, resetDbPath, openDataFolder, exportDb, importDb, saveTursoConfig, testTurso, syncTurso,
    saveDriveConfig, testDriveConnection, syncDriveNow,
    connectDrive, disconnectDrive,
    openBackupModal,
    ttsAddPreset: (chars) => {
      const el = document.getElementById('settingTtsSkipChars');
      if (!el) return;
      const current = el.value;
      let added = '';
      for (const c of chars) { if (!current.includes(c)) added += c; }
      el.value = current + added;
    },
    ttsClearPreset: () => {
      const el = document.getElementById('settingTtsSkipChars');
      if (el) el.value = '';
    },
    ttsAddWords: (words) => {
      const el = document.getElementById('settingTtsSkipWords');
      if (!el) return;
      const existing = el.value.split(',').map(w => w.trim()).filter(Boolean);
      const toAdd    = words.split(',').map(w => w.trim()).filter(Boolean);
      const merged   = [...existing];
      for (const w of toAdd) {
        if (!merged.some(e => e.toLowerCase() === w.toLowerCase())) merged.push(w);
      }
      el.value = merged.join(', ');
    },
    setTheme: applyTheme, _applyThemeVisual: setTheme,
    showResumeDialog, resumeBook, startFromBeginning,
    _bkWireModal,
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
      model:      'claude-sonnet-4-5',
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
  let _isFullscreen   = false;

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
    _initKeyboardShortcuts();

    // Wire buttons
    document.getElementById('btnAddBook').addEventListener('click',    addBook);
    document.getElementById('btnSettings').addEventListener('click',   UI.openSettingsModal);
    document.getElementById('btnShortcuts')?.addEventListener('click', UI.openShortcutsModal);
    document.getElementById('btnFullscreen')?.addEventListener('click', () => toggleFullscreen());
    document.getElementById('btnBackup').addEventListener('click',     UI.openBackupModal);
    UI._bkWireModal();
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

    window.addEventListener('sonara:playback-state', (e) => {
      const detail = e?.detail || {};
      Library.setPlaybackState(detail.bookId || null, !!detail.isPlaying);
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

    // Restore fullscreen indicator state
    await _syncFullscreenState();

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
      const files = await window.sonara.dialog.openFile(); // returns array
      if (!files || !files.length) return;
      await _importFiles(files, true);
    } catch (err) {
      UI.toast('Failed to add book: ' + err.message, 'error');
    }
  }

  async function addDroppedFiles(rawFiles) {
    const files = _normalizeDroppedFiles(rawFiles);
    if (!files.length) {
      UI.toast('No supported files detected. Drop PDF, EPUB, MOBI, AZW3, MP3, M4B, M4A, or OGG.', 'error', 3200);
      return;
    }
    await _importFiles(files, false);
  }

  function _normalizeDroppedFiles(rawFiles) {
    if (!Array.isArray(rawFiles)) return [];

    const allowed = new Set(['pdf', 'epub', 'mobi', 'azw3', 'azw', 'mp3', 'm4b', 'm4a', 'ogg']);
    const normalized = [];

    for (const file of rawFiles) {
      const filePath = (file && (file.path || file.filePath || file.fullPath)) || '';
      const fileName = (file && file.name) || (filePath ? filePath.split(/[/\\]/).pop() : '');
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      if (!filePath || !allowed.has(ext)) continue;

      normalized.push({
        path: filePath,
        name: fileName,
        size: Number(file.size) || 0,
        format: ext === 'azw' ? 'azw3' : ext,
      });
    }

    return normalized;
  }

  async function _importFiles(files, openSingle) {
    if (files.length === 1 && openSingle) {
      await _addSingleBook(files[0], true);
      return;
    }

    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      const fileInfo = files[i];
      UI.toast('Adding ' + (i + 1) + ' of ' + files.length + ': ' +
        fileInfo.name.replace(/\.[^.]+$/, ''), 'success', 2000);

      const result = await _addSingleBook(fileInfo, false);
      if (result === 'added') added++;
      else if (result === 'exists') skipped++;
      else failed++;
    }

    await Library.load();

    const parts = [];
    if (added) parts.push(added + ' book' + (added !== 1 ? 's' : '') + ' added');
    if (skipped) parts.push(skipped + ' already in library');
    if (failed) parts.push(failed + ' failed');

    UI.toast(parts.join(', '), added > 0 ? 'success' : 'error', 3500);
  }

  // ── ADD SINGLE BOOK (shared by single and batch) ──────────
  async function _addSingleBook(fileInfo, openAfter) {
    // Generate stable ID — include format explicitly so ".pdf" and ".mp3"
    // of the same title never collide (btoa prefix was shared for long titles)
    const rawId = fileInfo.format + '_' + fileInfo.name + '_' + fileInfo.size;
    const id    = btoa(unescape(encodeURIComponent(rawId))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

    // Already in library?
    const exists = await window.sonara.library.bookExists(id);
    if (exists) {
      if (openAfter) {
        UI.toast('This book is already in your library', 'error');
        await openBook(id);
      }
      return 'exists';
    }

    pendingBookData = {
      id,
      title:      fileInfo.name.replace(/\.(pdf|epub|mobi|azw3?|mp3|m4b|m4a|ogg)$/i, '').replace(/[-_]/g, ' '),
      format:     fileInfo.format,
      sourcePath: fileInfo.path,
      fileName:   fileInfo.name,
      fileSize:   fileInfo.size
    };

    const bookTitle = pendingBookData.title; // capture before process clears it
    const silent = !openAfter;
    if (AUDIO_FORMATS.includes(fileInfo.format)) {
      await _processAudioFile(id, fileInfo, silent);
    } else {
      await _processFile(id, fileInfo, silent);
    }
    // Fire-and-forget genre classification (non-blocking)
    _autoClassifyBook(id, bookTitle);
    return 'added';
  }

  // ── AUTO-CLASSIFY INTO COLLECTIONS ────────────────────────────
  const _GENRE_COLORS = {
    'Science Fiction': '#6366f1', 'Fantasy':   '#8b5cf6', 'Mystery':  '#1e40af',
    'Thriller':        '#dc2626', 'Horror':    '#312e81', 'Romance':  '#ec4899',
    'Historical':      '#92400e', 'Biography': '#0891b2', 'History':  '#7c2d12',
    'Science':         '#059669', 'Technology':'#0ea5e9', 'Self-Help':'#f59e0b',
    'Psychology':      '#a855f7', 'Philosophy':'#6b7280', 'Business': '#16a34a',
    'Politics':        '#1d4ed8', 'Religion':  '#c2410c', 'Children': '#f97316',
    'Poetry':          '#be185d', 'Drama':     '#7c3aed', 'Fiction':  '#64748b',
  };

  async function _autoClassifyBook(bookId, hintTitle) {
    try {
      // Use the saved DB title (user may have edited it), fall back to hint
      let title = hintTitle;
      try {
        const saved = await window.sonara.library.getBook(bookId);
        if (saved?.title) title = saved.title;
      } catch {}

      const genres = await window.sonara.books.classify(title);
      if (!genres || !genres.length) return;
      const allCols = await window.sonara.collections.getAll();
      for (const genre of genres) {
        let col = allCols.find(c => c.name.toLowerCase() === genre.toLowerCase());
        if (!col) {
          col = await window.sonara.collections.create(genre, _GENRE_COLORS[genre] || '#64748b');
          allCols.push(col);
        }
        await window.sonara.collections.addBook(bookId, col.id);
      }
      Library.load();
      UI.toast('Auto-categorised → ' + genres.join(', '), 'success', 3000);
    } catch (e) {
      console.log('[autoClassify] skipped:', e.message);
    }
  }

  async function classifyAll() {
    let books;
    try { books = await window.sonara.library.getAll(); } catch { return; }
    if (!books || !books.length) { UI.toast('No books to classify', 'success', 2000); return; }

    const btn = document.getElementById('libClassifyAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Classifying…'; }

    let done = 0;
    for (const book of books) {
      await _autoClassifyBook(book.id, book.title);
      done++;
      if (btn) btn.textContent = `Classifying… (${done}/${books.length})`;
      // small delay to avoid hammering the IPC channel
      await new Promise(r => setTimeout(r, 120));
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Classify All';
    }
    Library.load();
    UI.toast(`✨ Classified ${done} book${done !== 1 ? 's' : ''}`, 'success', 3500);
  }

  // ── OPEN BOOK FROM LIBRARY ───────────────────────────────
  async function openBook(id) {
    try {
      const book = await window.sonara.library.getBook(id);
      if (!book) { UI.toast('Book not found in library', 'error'); return; }

      // Check file still exists
      const exists = await window.sonara.file.exists(book.file_path);
      if (!exists) {
        const relink = confirm(
          '"' + book.title + '"\n\n' +
          'The file is missing from its saved location.\n\n' +
          'Would you like to locate the file now?'
        );
        if (relink) {
          const updated = await window.sonara.library.relinkFile(id);
          if (updated) {
            UI.toast('File re-linked — opening…', 'success');
            await openBook(id);
          } else {
            UI.toast('Re-link cancelled', 'error');
          }
        } else {
          UI.toast('File missing — please re-add "' + book.title + '"', 'error');
        }
        return;
      }

      // If same book already parsed, just jump
      if (id === currentBookId) {
        Reader.setBookCoverPath(book.cover_path || '');
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
    Reader.setBookCoverPath(book.cover_path || '');
    Reader.loadAudioBook(book, progress);
    await window.sonara.settings.set('lastBookId', book.id);
    Library.setActiveCard(book.id);
    _updateNavPanel(book.id);
    Notes.load(book.id);
    showReader();
    pendingBookData = null;
  }

  // ── PROCESS FILE ─────────────────────────────────────────
  // silent=true: batch mode — no overlay, no reader switch, caller handles library refresh
  async function _processFile(id, fileInfo, silent = false) {
    if (isGenerating) {
      UI.toast('Please wait, a book is already being processed…', 'error');
      return;
    }
    isGenerating = true;

    const overlay = document.getElementById('generatingOverlay');
    if (!silent) {
      // Switch to reader view so the generating overlay is visible
      showReader();
      overlay.style.display = 'flex';
      document.getElementById('readerWelcome').style.display   = 'none';
      document.getElementById('chapterTitlebar').style.display = 'none';
      document.getElementById('readerTextWrap').style.display  = 'none';
      document.getElementById('readerPdfWrap').style.display   = 'none';
    }

    if (!silent) { _setGenStep('extract','active'); _setGenProgress(5, 'Reading file…', fileInfo.name); }

    try {
      // 1. Read file as base64
      const base64 = await window.sonara.file.read(fileInfo.path);
      if (!base64) throw new Error('Could not read file');

      if (!silent) { _setGenStep('extract','done'); _setGenStep('clean','active');
        _setGenProgress(20, 'Extracting text…', 'Parsing ' + fileInfo.format.toUpperCase()); }

      // 2. Parse
      let chunks;
      if (fileInfo.format === 'epub') {
        chunks = await Parser.parseEPUB(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting chapters…', p + '%'));
      } else if (fileInfo.format === 'mobi' || fileInfo.format === 'azw3') {
        // MOBI/AZW3 parsing happens in the main process (needs Node.js Buffer)
        chunks = await Parser.parseMOBI(fileInfo.path, p => _setGenProgress(20 + p * 0.3, 'Extracting Kindle content…', p + '%'));
      } else {
        chunks = await Parser.parsePDF(base64, p => _setGenProgress(20 + p * 0.3, 'Extracting pages…', p + '%'));
      }

      if (!chunks || !chunks.length) throw new Error('No readable text found in file');

      if (!silent) { _setGenStep('clean','done'); _setGenStep('ai','active');
        _setGenProgress(52, 'Cleaning text…', chunks.length + ' sections');
        await _sleep(200); }

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

      if (!silent) { _setGenStep('ai','done'); _setGenStep('tts','active');
        _setGenProgress(78, 'Setting up voice…', '');
        await _sleep(200); }

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

      if (!silent) {
        // 7. Load into reader
        currentBookId = id;
        Reader.loadBook(chunks, id, resumeData);
        const _book = await window.sonara.library.getBook(id);
        const _coverPath = _book?.cover_path || '';
        Reader.setBookCoverPath(_coverPath);
        const _pmTitle  = document.getElementById('pbMetaTitle');
        const _pmAuthor = document.getElementById('pbMetaAuthor');
        if (_pmTitle)  _pmTitle.textContent  = pendingBookData.title  || '';
        if (_pmAuthor) _pmAuthor.textContent = pendingBookData.author || '';
        // Sync mini player / tray with the newly loaded book title
        window.sonara?.player?.updateState({
          title: pendingBookData.title || '',
          isPlaying: false,
          percent: 0,
          coverPath: _coverPath
        });
        _updateNavPanel(id);
        Notes.load(id);
        await window.sonara.settings.set('lastBookId', id);
        await Library.load();
        await _sleep(100);
        Library.setActiveCard(id);
        overlay.style.display = 'none';
        showReader();
        UI.toast(pendingBookData.title + ' — press play to listen!', 'success');
      }

    } catch (err) {
      if (!silent && overlay) overlay.style.display = 'none';
      if (!silent) document.getElementById('readerWelcome').style.display = 'flex';
      UI.toast('Error: ' + err.message, 'error');
    } finally {
      isGenerating   = false;
      pendingBookData = null;
    }
  }

  // ── PROCESS AUDIO FILE ────────────────────────────────────
  // silent=true: batch mode — no overlay, caller handles library refresh
  async function _processAudioFile(id, fileInfo, silent = false) {
    if (isGenerating) {
      UI.toast('Please wait, a book is already being processed…', 'error');
      return;
    }
    isGenerating = true;

    const overlay = document.getElementById('generatingOverlay');
    if (!silent) {
      showReader();
      overlay.style.display = 'flex';
      document.getElementById('readerWelcome').style.display = 'none';
    }

    if (!silent) { _setGenStep('extract', 'active'); _setGenProgress(10, 'Importing audiobook...', fileInfo.name); }

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
      if (!silent) _setGenProgress(40, 'Reading audio metadata...', '');

      // 2. Extract embedded cover art from ID3/MP4 tags
      try {
        await window.sonara.audio.extractCover({
          bookId: id,
          filePath: saved.file_path,
          format: fileInfo.format
        });
      } catch { /* no cover — not critical */ }

      // 3. Get duration from the copied file
      const duration = await _getAudioDuration(saved.file_path);
      await window.sonara.library.updateBook(id, {
        duration_seconds: duration,
        total_seconds: Math.round(duration)
      });

      if (!silent) {
        _setGenStep('extract', 'done'); _setGenStep('done', 'active');
        _setGenProgress(100, 'Ready!', '');
        await _sleep(200);
        currentBookId = id;
        overlay.style.display = 'none';
        await Library.load();
        showLibrary();
        UI.toast(pendingBookData.title + ' added to library!', 'success');
      }

    } catch (err) {
      if (!silent && overlay) overlay.style.display = 'none';
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
    Reader.setBookCoverPath('');
    Reader.stop();
    document.getElementById('readerWelcome').style.display   = 'flex';
    document.getElementById('chapterTitlebar').style.display = 'none';
    document.getElementById('readerTextWrap').style.display  = 'none';
    document.getElementById('readerPdfWrap').style.display   = 'none';
    document.getElementById('tbCenter').textContent = '';
    window.sonara?.player?.updateState({
      isPlaying: false,
      title: '',
      chapterTitle: '',
      percent: 0,
      coverPath: ''
    });
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
      const pbCoverClear = document.getElementById('pbCoverPlaceholder');
      if (pbCoverClear) { pbCoverClear.style.backgroundImage = ''; pbCoverClear.classList.remove('has-cover'); }
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
    const pbCover  = document.getElementById('pbCoverPlaceholder');
    try {
      const coverPath = await window.sonara.cover.getPath(bookId);
      if (coverPath) {
        const fileUrl = 'file:///' + coverPath.replace(/\\/g, '/');
        coverImg.src           = fileUrl;
        coverImg.style.display = 'block';
        coverPlc.style.display = 'none';
        if (pbCover) {
          pbCover.style.backgroundImage    = 'url("' + fileUrl + '")';
          pbCover.style.backgroundSize     = 'cover';
          pbCover.style.backgroundPosition = 'center';
          pbCover.classList.add('has-cover');
        }
      } else {
        coverImg.style.display = 'none';
        coverPlc.style.display = 'flex';
        if (pbCover) { pbCover.style.backgroundImage = ''; pbCover.classList.remove('has-cover'); }
      }
    } catch (_) {
      coverImg.style.display = 'none';
      coverPlc.style.display = 'flex';
      if (pbCover) { pbCover.style.backgroundImage = ''; pbCover.classList.remove('has-cover'); }
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

    // Copy and sync voice list content from desktop panel
    const sourceList = document.getElementById('voiceList');
    const targetList = document.getElementById('mobileVoiceList');
    const syncVoiceList = () => {
      const refreshed = document.getElementById('voiceList');
      if (refreshed && targetList) {
        targetList.innerHTML = refreshed.innerHTML;
      }
    };

    if (sourceList && targetList) {
      syncVoiceList();

      targetList.addEventListener('click', (e) => {
        const favBtn = e.target.closest('.vi-fbtn');
        if (favBtn) {
          e.stopPropagation();
          const voiceId = favBtn.getAttribute('data-favorite-voice');
          if (voiceId) {
            Reader.toggleFavoriteVoice(voiceId);
            syncVoiceList();
          }
          return;
        }

        const previewBtn = e.target.closest('.vi-pbtn');
        if (previewBtn) {
          e.stopPropagation();
          const voiceId = previewBtn.getAttribute('data-preview-voice');
          if (voiceId) {
            Reader.previewVoice(voiceId);
          }
          return;
        }

        const item = e.target.closest('.voice-item');
        if (item) {
          const voiceId = item.getAttribute('data-voice-id') || item.getAttribute('data-voice-name');
          if (voiceId) {
            Reader.selectVoice(voiceId);
            modal.remove();
          }
        }
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
      searchInput.addEventListener('input', () => {
        sourceSearch.value = searchInput.value;
        Reader.filterVoices();
        syncVoiceList();
      });
    }

    if (sourceLang && targetLang) {
      targetLang.value = sourceLang.value;
      targetLang.addEventListener('change', () => {
        sourceLang.value = targetLang.value;
        Reader.filterVoices();
        syncVoiceList();
      });
    }

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  function _isEditableTarget(target) {
    return !!(target && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    ));
  }

  function _stepSpeed(delta) {
    const slider = document.getElementById('speedSlider');
    if (!slider) return;

    const step = parseFloat(slider.step) || 0.05;
    const min = parseFloat(slider.min) || 0.5;
    const max = parseFloat(slider.max) || 2.5;
    const current = parseFloat(slider.value) || 1.0;
    const next = Math.max(min, Math.min(max, current + (delta * step)));

    slider.value = next.toFixed(2);
    Reader.onSpeedChange(slider.value);
  }

  function _initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const key = e.key;

      if (key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      if (key === 'Escape') {
        if (UI.closeTopModal()) {
          e.preventDefault();
          return;
        }
        if (_isFullscreen) {
          e.preventDefault();
          toggleFullscreen(false);
        }
        return;
      }

      if (_isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === ' ') {
        e.preventDefault();
        Reader.togglePlay();
        return;
      }

      if (key === 'ArrowLeft') {
        e.preventDefault();
        Reader.skipChunk(-1);
        return;
      }

      if (key === 'ArrowRight') {
        e.preventDefault();
        Reader.skipChunk(1);
        return;
      }

      if (key === '+' || key === '=') {
        e.preventDefault();
        _stepSpeed(1);
        return;
      }

      if (key === '-' || key === '_') {
        e.preventDefault();
        _stepSpeed(-1);
        return;
      }

      if (key === 'l' || key === 'L') {
        e.preventDefault();
        if (document.body.classList.contains('mode-library') && currentBookId) showReader();
        else showLibrary();
        return;
      }

      if (key === 'n' || key === 'N') {
        e.preventDefault();
        Notes.switchTab('notes');
        document.getElementById('noteTextarea')?.focus();
      }
    });
  }

  // ── PIN / ALWAYS ON TOP ───────────────────────────────────────────────────
  let _pinned = false;
  async function togglePin() {
    _pinned = !_pinned;
    await window.sonara?.win?.alwaysOnTop(_pinned);
    const btn = document.getElementById('pbPinBtn');
    if (btn) btn.classList.toggle('active', _pinned);
    if (typeof UI !== 'undefined') {
      UI.toast(_pinned ? 'Window pinned on top' : 'Window unpinned', '');
    }
  }

  async function _syncFullscreenState() {
    try {
      _isFullscreen = !!(await window.sonara?.win?.isFullscreen?.());
    } catch {
      _isFullscreen = false;
    }

    document.body.classList.toggle('is-fullscreen', _isFullscreen);
    document.getElementById('btnFullscreen')?.classList.toggle('active', _isFullscreen);
  }

  async function toggleFullscreen(forceValue) {
    const next = typeof forceValue === 'boolean' ? forceValue : !_isFullscreen;
    try {
      _isFullscreen = !!(await window.sonara?.win?.setFullscreen?.(next));
      document.body.classList.toggle('is-fullscreen', _isFullscreen);
      document.getElementById('btnFullscreen')?.classList.toggle('active', _isFullscreen);
      UI.toast(_isFullscreen ? 'Entered full screen' : 'Exited full screen', '');
    } catch (err) {
      UI.toast('Could not toggle full screen: ' + err.message, 'error');
    }
  }

  return {
    init, addBook, addDroppedFiles, openBook, clearCurrentBook,
    showLibrary, showReader,
    toggleFullscreen,
    togglePin,
    classifyAll,
    _classifyExisting: _autoClassifyBook,
    get currentBookId() { return currentBookId; }
  };
})();

// ── BOOT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(() => {});
});
