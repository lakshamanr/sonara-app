'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, globalShortcut } = require('electron');

const path  = require('path');
const fs    = require('fs');
const db    = require('../database/db');

// ═══════════════════════════════════════════════════════════
//  ENABLE CLOUD VOICES - Set command line switches early
// ═══════════════════════════════════════════════════════════
if (app && app.commandLine) {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
  app.commandLine.appendSwitch('enable-features', 'SpeechSynthesis,NetworkService,NetworkServiceInProcess');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('enable-speech-input');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

  // Suppress cache permission errors on Windows
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disk-cache-size', '1');
}

// Lazy-load edge-tts to avoid initialization issues
let edgeTTS = null;
function getEdgeTTS() {
  if (!edgeTTS) edgeTTS = require('./edge-tts');
  return edgeTTS;
}

let mainWindow;
let booksDir;       // where we copy user files
let coversDir;      // where we save extracted cover images
let sonaraDataDir;  // single unified data folder for everything

// ─── TRAY & MINI PLAYER ────────────────────────────────────
let tray       = null;
let miniPlayer = null;
let _playerState = { isPlaying: false, title: '', chapterTitle: '', percent: 0, coverPath: '' };

function createTray() {
  const iconPath = path.join(__dirname, 'logo', 'logo.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('Sonara');
  tray.setContextMenu(_buildTrayMenu());
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
  tray.on('double-click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

function _buildTrayMenu() {
  const playing = _playerState.isPlaying;
  const bookLabel = _playerState.title ? `« ${_playerState.title.slice(0, 30)}${_playerState.title.length > 30 ? '…' : ''} »` : 'No book playing';
  return Menu.buildFromTemplate([
    { label: 'Sonara', enabled: false },
    { type: 'separator' },
    { label: playing ? '⏸  Pause' : '▶  Play',
      click: () => mainWindow?.webContents.send('player:command', 'toggle') },
    { label: '⏮  Previous',
      click: () => mainWindow?.webContents.send('player:command', 'prev') },
    { label: '⏭  Next',
      click: () => mainWindow?.webContents.send('player:command', 'next') },
    { type: 'separator' },
    { label: bookLabel, enabled: false },
    { type: 'separator' },
    { label: 'Show / Hide',
      click: () => {
        if (!mainWindow) return;
        mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus());
      }
    },
    { label: '🎵  Mini Player', click: () => _toggleMiniPlayer() },
    { type: 'separator' },
    { label: 'Quit Sonara', click: () => { if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; } app.quit(); } }
  ]);
}

function createMiniPlayer() {
  // Position bottom-right of primary display
  const { width: sw, height: sh } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const w = 340, h = 100;

  miniPlayer = new BrowserWindow({
    width: w, height: 100,
    x: sw - w - 16, y: sh - 100 - 16,
    frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, maximizable: false,
    show: false,
    backgroundColor: '#111118',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  // Register ready-to-show BEFORE loadFile to avoid race condition
  miniPlayer.once('ready-to-show', () => {
    miniPlayer.show();
    // Push current state into the mini player
    miniPlayer.webContents.send('player:state', _playerState);
    // Also ask renderer for a fresh state push (title may have changed)
    mainWindow?.webContents.send('player:command', '__pushState');
  });

  miniPlayer.loadFile(path.join(__dirname, 'mini-player.html'));
  miniPlayer.on('closed', () => { miniPlayer = null; });
}

function _toggleMiniPlayer() {
  if (!miniPlayer || miniPlayer.isDestroyed()) {
    createMiniPlayer(); // ready-to-show + show handled inside createMiniPlayer
    return;
  }
  if (miniPlayer.isVisible()) {
    miniPlayer.hide();
  } else {
    miniPlayer.show();
    miniPlayer.webContents.send('player:state', _playerState);
    mainWindow?.webContents.send('player:command', '__pushState');
  }
}

// ─────────────────────────────────────────────────────────────
//  IPC STANDARD RESPONSE WRAPPER
//  All handlers should use ipcHandler() to guarantee consistent
//  error logging and structured error propagation to the renderer.
//  Success: return any value
//  Failure: throw an Error — ipcHandler adds .code and logs it
// ─────────────────────────────────────────────────────────────
function ipcHandler(fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      const code = err.code || 'ERR_IPC';
      const msg  = err.message || String(err);
      console.error(`[IPC] ${code}: ${msg}`);
      const e    = new Error(msg);
      e.code     = code;
      throw e;
    }
  };
}

// ─────────────────────────────────────────────────────────────
//  SINGLE INSTANCE LOCK
// ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // A second instance was launched — focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  CONFIG FILE (stored separately from the DB so we can read before init)
// ─────────────────────────────────────────────────────────────
let _userData = '';
let _configPath = '';

function _readConfig() {
  try {
    if (fs.existsSync(_configPath)) return JSON.parse(fs.readFileSync(_configPath, 'utf8'));
  } catch {}
  return {};
}

function _writeConfig(updates) {
  const data = { ..._readConfig(), ...updates };
  fs.writeFileSync(_configPath, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────
//  APP BOOTSTRAP
// ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  try {
    const userData = app.getPath('userData');
    _userData = userData;

    // ── UNIFIED DATA FOLDER ──────────────────────────────────
    // All app data lives under a single "Sonara-Data" folder so
    // the user can back up or move everything in one step.
    sonaraDataDir = path.join(userData, 'Sonara-Data');
    fs.mkdirSync(sonaraDataDir, { recursive: true });

    // ── ONE-TIME MIGRATION: move existing scattered data files
    //    into the unified Sonara-Data folder (runs once silently).
    const _migrateFile = (src, dest) => {
      try {
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          fs.unlinkSync(src);
          console.log(`[migrate] ${path.basename(src)} → Sonara-Data/`);
        }
      } catch (e) { console.error('[migrate]', e.message); }
    };
    const _migrateDir = (srcDir, destDir) => {
      try {
        if (!fs.existsSync(srcDir)) return;
        fs.mkdirSync(destDir, { recursive: true });
        for (const entry of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, entry);
          if (!fs.statSync(src).isFile()) continue;
          const dest = path.join(destDir, entry);
          if (!fs.existsSync(dest)) {
            try { fs.copyFileSync(src, dest); fs.unlinkSync(src); } catch {}
          }
        }
      } catch (e) { console.error('[migrateDir]', e.message); }
    };

    // Config: migrate old userData/sonara-config.json first (before reading it)
    _migrateFile(
      path.join(userData, 'sonara-config.json'),
      path.join(sonaraDataDir, 'sonara-config.json')
    );
    _configPath = path.join(sonaraDataDir, 'sonara-config.json');

    // Covers: migrate userData/covers/* → Sonara-Data/covers/
    const newCoversDir = path.join(sonaraDataDir, 'covers');
    _migrateDir(path.join(userData, 'covers'), newCoversDir);
    coversDir = newCoversDir;
    fs.mkdirSync(coversDir, { recursive: true });

    // Books: migrate userData/books/* → Sonara-Data/books/
    const newBooksDir = path.join(sonaraDataDir, 'books');
    _migrateDir(path.join(userData, 'books'), newBooksDir);
    booksDir = newBooksDir;
    fs.mkdirSync(booksDir, { recursive: true });

    // Read config (already migrated above)
    const cfg = _readConfig();

    // ONE-TIME MIGRATION: if a customBooksDir was previously configured,
    // copy any book files from there into the unified books folder, then clear the key.
    try {
      if (cfg.customBooksDir && fs.existsSync(cfg.customBooksDir)) {
        const oldDir = cfg.customBooksDir;
        console.log(`[migrate] Moving books from ${oldDir} → ${booksDir}`);
        const entries = fs.readdirSync(oldDir);
        for (const entry of entries) {
          const src = path.join(oldDir, entry);
          if (!fs.statSync(src).isFile()) continue;
          const dest = path.join(booksDir, entry);
          if (!fs.existsSync(dest)) {
            try { fs.copyFileSync(src, dest); } catch (e) { console.error('[migrate] copy failed:', e.message); }
          }
        }
        _writeConfig({ customBooksDir: null });
        console.log('[migrate] customBooksDir cleared from config');
      }
    } catch (migrErr) {
      console.error('[migrate] Migration error:', migrErr.message);
    }

    // DB: migrate userData/sonara.db → Sonara-Data/sonara.db
    _migrateFile(
      path.join(userData, 'sonara.db'),
      path.join(sonaraDataDir, 'sonara.db')
    );

    // Determine DB location — custom cloud folder or unified Sonara-Data folder
    const dbPath = (cfg.customDbPath && fs.existsSync(cfg.customDbPath))
      ? cfg.customDbPath
      : path.join(sonaraDataDir, 'sonara.db');
    db.init(dbPath);

    // ── AUTO-HEAL: relink stale file_path entries to booksDir (local) ──
    try {
      const allBooks = db.getAllBooks();
      for (const book of allBooks) {
        if (book.file_path && fs.existsSync(book.file_path)) continue; // already OK
        const baseName  = path.basename(book.file_path || '');
        if (!baseName) continue;
        const candidate = path.join(booksDir, baseName);
        if (fs.existsSync(candidate)) {
          db.updateBook(book.id, { file_path: candidate });
          console.log(`[autoHeal] Relinked "${book.title}" → ${candidate}`);
        } else {
          const ext = path.extname(baseName);
          if (ext) {
            const byId = path.join(booksDir, book.id + ext);
            if (fs.existsSync(byId)) {
              db.updateBook(book.id, { file_path: byId });
              console.log(`[autoHeal] Relinked by ID "${book.title}" → ${byId}`);
            }
          }
        }
      }
    } catch (healErr) {
      console.error('[autoHeal] Failed:', healErr.message);
    }

    createWindow();
    createTray();
    scheduleAutoBackup();

    globalShortcut.register('F12', () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win) win.webContents.toggleDevTools();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error('Error initializing app:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // With a system tray we keep the app alive when all windows are closed.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

// ─────────────────────────────────────────────────────────────
//  WINDOW
// ─────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width:  Math.min(1400, width  - 40),
    height: Math.min(900,  height - 40),
    minWidth:  900,
    minHeight: 600,
    icon: path.join(__dirname, 'logo', 'logo.png'),
    frame:         isMac,                  // Mac keeps native frame; Windows goes frameless
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    backgroundColor: '#0c0c0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable web APIs including full speechSynthesis
      webviewTag: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Remove default menu for production
  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Restore window bounds
  const savedBounds = db.getSetting('windowBounds');
  if (savedBounds) {
    try { mainWindow.setBounds(savedBounds); } catch {}
  }

  mainWindow.on('close', (e) => {
    db.setSetting('windowBounds', mainWindow.getBounds());
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  IPC — WINDOW CONTROLS (custom title bar on Windows)
// ─────────────────────────────────────────────────────────────
ipcMain.handle('win:minimize',  () => mainWindow && mainWindow.minimize());
ipcMain.handle('win:maximize',  () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('win:close',     () => mainWindow && mainWindow.close());
ipcMain.handle('win:isMaximized',  () => mainWindow ? mainWindow.isMaximized() : false);
ipcMain.handle('win:alwaysOnTop', (_, val) => { mainWindow?.setAlwaysOnTop(!!val); return !!val; });
ipcMain.handle('win:isFullscreen', () => mainWindow ? mainWindow.isFullScreen() : false);
ipcMain.handle('win:setFullscreen', (_, val) => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!!val);
  return mainWindow.isFullScreen();
});

// ─── PLAYER STATE (from renderer → tray & mini player update) ─
ipcMain.on('player:updateState', (_, state) => {
  _playerState = { ..._playerState, ...state };
  if (tray && !tray.isDestroyed()) tray.setContextMenu(_buildTrayMenu());
  if (miniPlayer && !miniPlayer.isDestroyed() && miniPlayer.isVisible()) {
    miniPlayer.webContents.send('player:state', _playerState);
  }
});

// Mini player toggle from renderer
ipcMain.on('miniPlayer:toggle', () => _toggleMiniPlayer());

// Commands from mini player buttons → forward to renderer
ipcMain.on('mini:play',  () => mainWindow?.webContents.send('player:command', 'toggle'));
ipcMain.on('mini:prev',  () => mainWindow?.webContents.send('player:command', 'prev'));
ipcMain.on('mini:next',  () => mainWindow?.webContents.send('player:command', 'next'));
ipcMain.on('mini:close', () => miniPlayer?.hide());
ipcMain.on('mini:open',  () => { mainWindow?.show(); mainWindow?.focus(); });

// ─────────────────────────────────────────────────────────────
//  IPC — LIBRARY
// ─────────────────────────────────────────────────────────────
ipcMain.handle('library:getAll',    ipcHandler(() => db.getAllBooks()));
ipcMain.handle('library:getBook',   ipcHandler((_, id) => db.getBook(id)));
ipcMain.handle('library:bookExists',ipcHandler((_, id) => db.bookExists(id)));

ipcMain.handle('library:addBook', async (_, bookData) => {
  try {
    // bookData: { id, title, format, sourcePath, fileName, fileSize }
    const destPath = path.join(booksDir, bookData.id + path.extname(bookData.fileName));

    // Copy file to our managed folder if not already there
    if (bookData.sourcePath && fs.existsSync(bookData.sourcePath) && bookData.sourcePath !== destPath) {
      fs.copyFileSync(bookData.sourcePath, destPath);
    }

    const book = {
      id:               bookData.id,
      title:            bookData.title,
      author:           bookData.author || null,
      format:           bookData.format,
      file_path:        destPath,
      file_name:        bookData.fileName,
      file_size:        bookData.fileSize,
      cover_path:       bookData.coverPath || null,
      total_chunks:     bookData.totalChunks  || 0,
      total_seconds:    bookData.totalSeconds || 0,
      duration_seconds: bookData.durationSeconds || 0,
      status:           'unstarted',
      added_at:         Date.now(),
      last_read:        null
    };

    db.addBook(book);
    const savedBook = db.getBook(book.id);
    return savedBook;
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('library:updateBook', ipcHandler((_, id, fields) => {
  db.updateBook(id, fields);
  return db.getBook(id);
}));

ipcMain.handle('library:deleteBook', ipcHandler(async (_, id) => {
  const book = db.getBook(id);
  if (book && book.file_path && fs.existsSync(book.file_path)) {
    try { fs.unlinkSync(book.file_path); } catch {}
  }
  db.deleteBook(id);
  return { success: true };
}));

// ── RE-LINK: pick a new file path for a book whose file moved ─
ipcMain.handle('library:relinkFile', ipcHandler(async (_, bookId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate missing book file',
    properties: ['openFile'],
    filters: [
      { name: 'Books', extensions: ['pdf', 'epub', 'mobi', 'azw3', 'mp3', 'm4b', 'm4a', 'ogg'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const newPath = result.filePaths[0];
  db.updateBook(bookId, { file_path: newPath });
  return db.getBook(bookId);
}));

// library:bookExists is already handled above via ipcHandler

// ─────────────────────────────────────────────────────────────
//  IPC — PROGRESS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('progress:get',   ipcHandler((_, bookId) => db.getProgress(bookId)));
ipcMain.handle('progress:save',  ipcHandler((_, data)   => { db.saveProgress(data);   return { success: true }; }));
ipcMain.handle('progress:reset', ipcHandler((_, bookId) => { db.resetProgress(bookId); return { success: true }; }));

// ─────────────────────────────────────────────────────────────
//  IPC — SETTINGS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('settings:get',    ipcHandler((_, key, def) => db.getSetting(key, def)));
ipcMain.handle('settings:set',    ipcHandler((_, key, val) => { db.setSetting(key, val); return { success: true }; }));
ipcMain.handle('settings:getAll', ipcHandler(() => db.getAllSettings()));

// ─────────────────────────────────────────────────────────────
//  IPC — FILE DIALOG & READING
// ─────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select book or audiobook files',
      filters: [
        { name: 'All Supported', extensions: ['pdf', 'epub', 'mobi', 'azw3', 'mp3', 'm4b', 'm4a', 'ogg'] },
        { name: 'Books',         extensions: ['pdf', 'epub', 'mobi', 'azw3'] },
        { name: 'Kindle Books',  extensions: ['mobi', 'azw3'] },
        { name: 'Audiobooks',    extensions: ['mp3', 'm4b', 'm4a', 'ogg'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths.map(filePath => {
      const stat = fs.statSync(filePath);
      return {
        path:   filePath,
        name:   path.basename(filePath),
        size:   stat.size,
        format: path.extname(filePath).toLowerCase().slice(1)
      };
    });
  } catch (err) {
    return null;
  }
});

ipcMain.handle('dialog:openImage', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Cover Image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  } catch { return null; }
});

ipcMain.handle('cover:saveFromFile', async (_, { bookId, imagePath }) => {
  try {
    const ext = path.extname(imagePath).toLowerCase();
    const safeExt = ['.jpg','.jpeg','.png','.webp','.gif'].includes(ext) ? ext : '.jpg';
    const coverPath = path.join(coversDir, bookId + safeExt);
    fs.copyFileSync(imagePath, coverPath);
    db.updateBook(bookId, { cover_path: coverPath });
    return coverPath;
  } catch (err) { throw err; }
});

ipcMain.handle('file:read', (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  } catch (err) {
    return null;
  }
});

ipcMain.handle('file:exists', (_, filePath) => {
  return fs.existsSync(filePath);
});

// ─────────────────────────────────────────────────────────────
//  IPC — APP META
// ─────────────────────────────────────────────────────────────
ipcMain.handle('app:getVersion',     ipcHandler(() => app.getVersion()));
ipcMain.handle('app:getUserDataPath',ipcHandler(() => app.getPath('userData')));
ipcMain.handle('app:getMeta',        ipcHandler(() => ({
  version:  app.getVersion(),
  platform: process.platform,
  arch:     process.arch,
  name:     app.getName(),
  userData: app.getPath('userData'),
})));
ipcMain.handle('shell:openExternal', ipcHandler((_, url) => shell.openExternal(url)));

// ─────────────────────────────────────────────────────────────
//  IPC — EDGE TTS (Natural Neural Voices)
// ─────────────────────────────────────────────────────────────
ipcMain.handle('tts:getVoices', async () => {
  try {
    return await getEdgeTTS().getVoices();
  } catch (err) {
    console.error('[TTS] Failed to load natural voices:', err?.message || err);
    return [];
  }
});

// ─────────────────────────────────────────────────────────────
//  IPC — COLLECTIONS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('collections:getAll',  ipcHandler(() => db.getAllCollections()));
ipcMain.handle('collections:get',     ipcHandler((_, id) => db.getCollection(id)));
ipcMain.handle('collections:create',  ipcHandler((_, name, color, parentId) => db.createCollectionWithParent(name, color, parentId)));
ipcMain.handle('collections:update',  ipcHandler((_, id, fields) => { db.updateCollection(id, fields); return db.getCollection(id); }));
ipcMain.handle('collections:delete',  ipcHandler((_, id) => { db.deleteCollection(id); return { success: true }; }));
ipcMain.handle('collections:addBook', ipcHandler((_, bId, cId) => { db.addBookToCollection(bId, cId); return { success: true }; }));
ipcMain.handle('collections:removeBook', ipcHandler((_, bId, cId) => { db.removeBookFromCollection(bId, cId); return { success: true }; }));
ipcMain.handle('collections:getBookCollections', ipcHandler((_, bId) => db.getBookCollections(bId)));
ipcMain.handle('collections:getBooks', ipcHandler((_, cId) => db.getCollectionBooks(cId)));

// ─────────────────────────────────────────────────────────────//  IPC — NOTES
// ────────────────────────────────────────────────────────────
ipcMain.handle('notes:add',    ipcHandler((_, data)          => db.addNote(data)));
ipcMain.handle('notes:getAll', ipcHandler((_, bookId)        => db.getNotes(bookId)));
ipcMain.handle('notes:update', ipcHandler((_, id, content, tag) => { db.updateNote(id, { content, tag }); return { success: true }; }));
ipcMain.handle('notes:delete', ipcHandler((_, id)            => { db.deleteNote(id); return { success: true }; }));

// ────────────────────────────────────────────────────────────//  IPC — COVERS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('cover:save', async (_, { bookId, base64, mediaType }) => {
  const ext = mediaType.includes('png') ? '.png' : '.jpg';
  const coverPath = path.join(coversDir, bookId + ext);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(coverPath, buffer);
  db.updateBook(bookId, { cover_path: coverPath });
  return coverPath;
});

ipcMain.handle('cover:getPath', (_, bookId) => {
  const book = db.getBook(bookId);
  if (book?.cover_path && fs.existsSync(book.cover_path)) return book.cover_path;
  return null;
});

// ─────────────────────────────────────────────────────────────
//  IPC — AUDIO COVER EXTRACTION (ID3v2 / MP4)
// ─────────────────────────────────────────────────────────────
ipcMain.handle('audio:extractCover', async (_, { bookId, filePath, format }) => {
  try {
    let result = null;
    if (format === 'mp3') {
      result = _extractMp3Cover(filePath);
    } else if (format === 'm4a' || format === 'm4b') {
      result = _extractMp4Cover(filePath);
    }
    if (!result || !result.data || result.data.length < 100) return null;

    const ext = result.mediaType.includes('png') ? '.png' : '.jpg';
    const coverPath = path.join(coversDir, bookId + ext);
    fs.writeFileSync(coverPath, result.data);
    db.updateBook(bookId, { cover_path: coverPath });
    return coverPath;
  } catch (err) {
    return null;
  }
});

// Parse ID3v2 tags from an MP3 file and return the embedded cover image
function _extractMp3Cover(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);
    if (header.slice(0, 3).toString('ascii') !== 'ID3') { fs.closeSync(fd); return null; }

    const version = header[3];
    // ID3v2 tag size stored as syncsafe integer
    const tagSize = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) |
                    ((header[8] & 0x7f) << 7)  | (header[9] & 0x7f);

    const readSize = Math.min(tagSize + 10, 15 * 1024 * 1024);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    let offset = 10;
    const tagEnd = Math.min(tagSize + 10, buf.length);
    while (offset + 10 <= tagEnd) {
      const frameId = buf.slice(offset, offset + 4).toString('ascii');
      if (frameId === '\0\0\0\0') break;

      let frameSize;
      if (version >= 4) {
        frameSize = ((buf[offset+4] & 0x7f) << 21) | ((buf[offset+5] & 0x7f) << 14) |
                    ((buf[offset+6] & 0x7f) << 7)  | (buf[offset+7] & 0x7f);
      } else {
        frameSize = buf.readUInt32BE(offset + 4);
      }
      offset += 10;

      if (frameId === 'APIC' && frameSize > 4) {
        let pos = offset;
        const encoding = buf[pos++];
        // MIME type (null-terminated ASCII)
        const mimeEnd = buf.indexOf(0, pos);
        const mimeType = buf.slice(pos, mimeEnd).toString('ascii');
        pos = mimeEnd + 1;
        pos++; // skip picture type byte
        // Description: null-terminated, UTF-16 uses double-null
        if (encoding === 1 || encoding === 2) {
          while (pos + 1 < offset + frameSize && !(buf[pos] === 0 && buf[pos + 1] === 0)) pos++;
          pos += 2;
        } else {
          while (pos < offset + frameSize && buf[pos] !== 0) pos++;
          pos++;
        }
        const data = buf.slice(pos, offset + frameSize);
        const mt = mimeType && mimeType !== 'image/' ? mimeType
                   : (data[0] === 0x89 ? 'image/png' : 'image/jpeg');
        return { data, mediaType: mt };
      }
      offset += frameSize;
    }
    return null;
  } catch { return null; }
}

// Parse MP4/M4A/M4B container and return the embedded cover image (covr atom)
function _extractMp4Cover(filePath) {
  try {
    const READ_SIZE = 20 * 1024 * 1024;
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(stat.size, READ_SIZE);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);

    function findBox(start, end, name) {
      let off = start;
      while (off + 8 <= end && off + 8 <= buf.length) {
        const size = buf.readUInt32BE(off);
        if (size < 8) break;
        const type = buf.slice(off + 4, off + 8).toString('ascii');
        const boxEnd = Math.min(off + size, buf.length);
        if (type === name) return { start: off, end: boxEnd };
        off += size;
      }
      return null;
    }

    const moov = findBox(0, buf.length, 'moov');
    if (!moov) return null;
    const udta = findBox(moov.start + 8, moov.end, 'udta');
    if (!udta) return null;
    const meta = findBox(udta.start + 8, udta.end, 'meta');
    if (!meta) return null;
    // meta has a 4-byte version+flags before child boxes
    const ilst = findBox(meta.start + 12, meta.end, 'ilst');
    if (!ilst) return null;
    const covr = findBox(ilst.start + 8, ilst.end, 'covr');
    if (!covr) return null;
    const data = findBox(covr.start + 8, covr.end, 'data');
    if (!data) return null;

    // data box layout: 4-byte type indicator, 4-byte locale, then image bytes
    const typeIndicator = buf.readUInt32BE(data.start + 8);
    const imageData = buf.slice(data.start + 16, data.end);
    if (imageData.length < 100) return null;
    // type 14 = PNG; 13 or others = JPEG
    const mediaType = typeIndicator === 14 ? 'image/png' : 'image/jpeg';
    return { data: imageData, mediaType };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
//  IPC — EDGE TTS (Natural Neural Voices)
// ─────────────────────────────────────────────────────────────
ipcMain.handle('tts:synthesize', async (_, { text, voice, speed, pitch }) => {
  try {
    const tts = getEdgeTTS();
    const rate = tts.speedToRate(speed || 1.0);
    const pitchHz = tts.pitchToHz(pitch || 1.0);
    const result = await tts.synthesize(text, voice, { rate, pitch: pitchHz });
    return {
      audio: result.audio.toString('base64'),
      wordBoundaries: result.wordBoundaries
    };
  } catch (err) {
    throw err;
  }
});

// ────────────────────────────────────────────────────────────
//  IPC — EXPORT TO MP3
// ────────────────────────────────────────────────────────────
ipcMain.handle('export:saveDialog', async (_, defaultName) => {
  const safe = (defaultName || 'Sonara Audiobook').replace(/[<>:"/\\|?*]/g, '_');
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Audiobook as MP3',
    defaultPath: path.join(app.getPath('downloads'), safe + '.mp3'),
    filters:     [{ name: 'MP3 Audio', extensions: ['mp3'] }]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('export:writeFile', (_, { path: filePath, chunks }) => {
  try {
    const buffers = chunks.map(b64 => Buffer.from(b64, 'base64'));
    fs.writeFileSync(filePath, Buffer.concat(buffers));
    return { success: true };
  } catch (err) {
    throw err;
  }
});

// ────────────────────────────────────────────────────────────
//  IPC — EXPORT NOTES (TXT / PDF)
// ────────────────────────────────────────────────────────────
ipcMain.handle('notes:saveDialog', async (_, { defaultName, type }) => {
  const safe   = (defaultName || 'My Notes').replace(/[<>:"/\\|?*]/g, '_');
  const isPdf  = type === 'pdf';
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       isPdf ? 'Export Notes as PDF' : 'Export Notes as Text',
    defaultPath: path.join(app.getPath('documents'), safe + (isPdf ? '.pdf' : '.txt')),
    filters:     isPdf
      ? [{ name: 'PDF Document', extensions: ['pdf'] }]
      : [{ name: 'Text File',    extensions: ['txt'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('notes:writeText', (_, { path: filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf8');
  return { success: true };
});

ipcMain.handle('notes:writePdf', async (_, { path: filePath, html }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = new BW({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdfData = await win.webContents.printToPDF({
    printBackground: true,
    pageSize:        'A4',
    margins:         { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
  });
  win.close();
  fs.writeFileSync(filePath, pdfData);
  return { success: true };
});

// ─────────────────────────────────────────────────────────────
//  IPC — DATABASE SYNC (custom path / export / import / Turso)
// ─────────────────────────────────────────────────────────────

/** Return current on-disk DB file path */
ipcMain.handle('db:getPath', () => db.getPath());

/** Get / set Turso credentials from config file */
ipcMain.handle('db:getTursoConfig', () => {
  const cfg = _readConfig();
  return { url: cfg.tursoUrl || '', token: cfg.tursoToken || '' };
});
ipcMain.handle('db:saveTursoConfig', (_, { url, token }) => {
  _writeConfig({ tursoUrl: url.trim(), tursoToken: token.trim() });
  return { success: true };
});

/** Let user pick a folder — copy DB there, save in config, reopen */
ipcMain.handle('db:choosePath', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Choose Database Folder (e.g. OneDrive, Dropbox)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const chosenDir = result.filePaths[0];
  const newDbPath = path.join(chosenDir, 'sonara.db');
  const curDbPath = db.getPath();

  // Copy existing DB to new location (keeps original as fallback)
  if (curDbPath && fs.existsSync(curDbPath) && curDbPath !== newDbPath) {
    fs.copyFileSync(curDbPath, newDbPath);
    // Also copy WAL / SHM if present
    for (const ext of ['-wal', '-shm']) {
      const wal = curDbPath + ext;
      if (fs.existsSync(wal)) fs.copyFileSync(wal, newDbPath + ext);
    }
  }

  _writeConfig({ customDbPath: newDbPath });
  db.reopen(newDbPath);
  return newDbPath;
});

/** Reset to default Sonara-Data path */
ipcMain.handle('db:resetPath', () => {
  _writeConfig({ customDbPath: null });
  const defaultPath = path.join(sonaraDataDir, 'sonara.db');
  db.reopen(defaultPath);
  return defaultPath;
});

/** Export all DB data as JSON — shows save dialog */
ipcMain.handle('db:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Sonara Database',
    defaultPath: path.join(app.getPath('documents'), 'sonara-backup.json'),
    filters:     [{ name: 'JSON Backup', extensions: ['json'] }],
  });
  if (result.canceled) return null;
  const data = db.exportAll();
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { path: result.filePath, books: data.books.length, notes: data.notes.length };
});

/** Import data from a JSON backup file */
ipcMain.handle('db:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:   'Import Sonara Backup',
    filters: [{ name: 'JSON Backup', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const raw  = fs.readFileSync(result.filePaths[0], 'utf8');
  const data = JSON.parse(raw);
  const stats = db.importAll(data);
  return stats;
});

// ─────────────────────────────────────────────────────────────
//  IPC — BOOKS FOLDER (read-only — path is always userData/books)
// ─────────────────────────────────────────────────────────────

ipcMain.handle('books:getDir', () => booksDir);

/** Return the unified Sonara-Data folder path */
ipcMain.handle('data:getDir', () => sonaraDataDir);

/** Open the books folder in the system file explorer */
ipcMain.handle('books:openDir', () => {
  shell.openPath(booksDir);
  return booksDir;
});

/** Open the unified Sonara-Data folder in the system file explorer */
ipcMain.handle('data:openDir', () => {
  shell.openPath(sonaraDataDir);
  return sonaraDataDir;
});

/**
 * Parse a MOBI or AZW3 (Kindle) file. Runs in the main process using the
 * bundled mobi-parser module (no DRM supported). Returns { title, chunks }.
 */
ipcMain.handle('books:parseMOBI', ipcHandler(async (_, filePath) => {
  const { parseMobi } = require('./mobi-parser');
  const buf = fs.readFileSync(filePath);
  return parseMobi(buf); // { title: string, chunks: [{title,text,page,source}] }
}));

/**
 * Auto-classify a book title. Uses LOCAL keyword heuristics first (instant,
 * works offline). Falls back to Open Library then Google Books only when
 * no heuristic genre is found. Returns up to 2 normalised genre strings.
 */
ipcMain.handle('books:classify', ipcHandler(async (_, title) => {
  const lc = title.toLowerCase().replace(/[\(\)\[\]\.]/g, ' ').replace(/\s+/g, ' ');

  // ── 1. LOCAL TITLE HEURISTICS (primary — instant, no network) ──
  const TITLE_RULES = [
    { genre: 'Technology', patterns: [
      'javascript','typescript','python','java ','c# ','c++ ','golang','rust ','swift ','kotlin',
      'programming','developer','software','coding','algorithm','data structure','design pattern',
      'architecture','microservice',' api ','rest ','graphql','machine learning','deep learning',
      'neural network','artificial intelligence',' ai ','database',' sql ','nosql','mongodb',
      'postgresql','web dev','frontend','backend','fullstack','devops','cloud ','aws ','azure ',
      'docker','kubernetes','linux','unix','bash ','react ','angular','vue ','node ','django',
      'flask ','spring ','ajax','html ','css ','object orient','functional program','clean code',
      'refactor','agile','scrum','test driven','tdd','cybersecurity','blockchain','data science',
      'head first','eloquent','pragmatic','you don\'t know','learning ',
    ]},
    { genre: 'Science', patterns: [
      'physics','quantum','relativity','astronomy','cosmolog','astrophysics','universe ',
      'chemistry','biology','genetics','evolution','ecology','climate change','natural history',
      'mathematics','calculus','geometry','topology','number theory','neuroscience',' brain ',
      'geology','pandemic','popular science','brief history of time','cosmos',
    ]},
    { genre: 'Self-Help', patterns: [
      'self-help','self help','self improvement','seven habits','7 habits','atomic habit',
      'think and grow','power of','rich dad','motivation','productivity','mindset','mindfulness',
      'meditation','happiness','confidence','discipline','mastery','deep work','essentialism',
      'stoic','willpower','procrastinat','time management','goal setting',
    ]},
    { genre: 'Business', patterns: [
      'business','entrepreneur','startup','management','leadership','strategy','marketing',
      'sales','finance','economics','investment',' wealth ','zero to one','good to great',
      'lean startup','innovate','disruption','negotiation','influence','brand ',
    ]},
    { genre: 'Psychology', patterns: [
      'psychology','thinking fast','thinking slow','behavior','behaviour','cognitive','emotion ',
      'mental health','personality','body language','social influence','anxiety','depression',
      'trauma','bias','heuristic','freud','jung','decision making',
    ]},
    { genre: 'Biography', patterns: [
      'biography','autobiography','memoir','my life','my story','life of ','becoming ',
      'long walk to freedom','confessions','diaries','letters of',
    ]},
    { genre: 'History', patterns: [
      ' history','world war','revolution','empire ','ancient ','medieval ','civilization',
      'chronicle','dynasty','kingdom ','sapiens','colonial','the rise','the fall',
    ]},
    { genre: 'Philosophy', patterns: [
      'philosophy','philosophi','ethics','virtue','stoicism','nietzsche','plato','aristotle',
      'kant','hegel','socrates','metaphysics','existentialism','republic ',
    ]},
    { genre: 'Religion', patterns: [
      'bible','quran','gospel','prayer','faith ','jesus','allah','buddhist','hindu',
      'spiritual','religion','church','monastery','sermon','divine',
    ]},
    { genre: 'Fantasy', patterns: [
      'fantasy','dragon ','wizard','magic ','elf ','hobbit','the ring','sword ','quest ',
      'realm ','throne','sorcerer','enchant','dungeon','chronicles of','wheel of time',
    ]},
    { genre: 'Science Fiction', patterns: [
      'science fiction','sci-fi','starship','alien ','robot ','android ','cyborg','dystopi',
      'cyberpunk','time travel',' mars ','interstellar','dune ','singularity','the matrix',
    ]},
    { genre: 'Mystery', patterns: [
      'mystery','detective','murder ','the killer','crime ','investigation','sherlock',
      'hercule poirot','whodunit','cold case','true crime',
    ]},
    { genre: 'Thriller', patterns: [
      'thriller','conspiracy','spy ','the agent','assassin','mission ','hunt ','operative',
    ]},
    { genre: 'Romance', patterns: [
      'romance','love story','falling in love','passion',' affair','wedding ','bride ',
    ]},
    { genre: 'Children', patterns: [
      'children\'s','for kids','picture book','young adult','middle grade','harry potter',
    ]},
    { genre: 'Poetry', patterns: ['poetry','collection of poems','selected poems','verse '] },
    { genre: 'Fiction',   patterns: ['fiction','novel ','short stories','novella'] },
  ];

  const found = [];
  for (const { genre, patterns } of TITLE_RULES) {
    if (found.length >= 2) break;
    if (patterns.some(p => lc.includes(p))) found.push(genre);
  }
  if (found.length) return found;

  // ── 2. ONLINE FALLBACK (Open Library → Google Books) ──
  function httpsGet(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.get(url, { headers: { 'User-Agent': 'Sonara/2.0' } }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('bad JSON')); } });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  const API_GENRE_MAP = [
    { genre: 'Science Fiction', keys: ['science fiction','sci-fi','cyberpunk','dystopian'] },
    { genre: 'Fantasy',         keys: ['fantasy','magic'] },
    { genre: 'Mystery',         keys: ['mystery','detective','crime fiction'] },
    { genre: 'Thriller',        keys: ['thriller','suspense'] },
    { genre: 'Horror',          keys: ['horror','supernatural'] },
    { genre: 'Romance',         keys: ['romance','love stories'] },
    { genre: 'Biography',       keys: ['biography','autobiography','memoir'] },
    { genre: 'History',         keys: ['history'] },
    { genre: 'Science',         keys: ['popular science','astronomy','physics','chemistry','biology','mathematics'] },
    { genre: 'Technology',      keys: ['technology','computer','programming','software','artificial intelligence'] },
    { genre: 'Self-Help',       keys: ['self-help','personal development','productivity'] },
    { genre: 'Psychology',      keys: ['psychology','cognitive'] },
    { genre: 'Philosophy',      keys: ['philosophy','ethics'] },
    { genre: 'Business',        keys: ['business','economics','management','finance'] },
    { genre: 'Religion',        keys: ['religion','spirituality','theology'] },
    { genre: 'Fiction',         keys: ['fiction','novel'] },
  ];

  function normalise(subjects) {
    const out = [];
    const lcs = subjects.map(s => s.toLowerCase());
    for (const { genre, keys } of API_GENRE_MAP) {
      if (out.length >= 2) break;
      if (keys.some(k => lcs.some(s => s.includes(k)))) out.push(genre);
    }
    return out;
  }

  const q = encodeURIComponent(title.replace(/[\(\)\[\]]/g, '').trim());
  try {
    const data = await httpsGet(`https://openlibrary.org/search.json?title=${q}&fields=subject&limit=1`);
    const genres = normalise(data.docs?.[0]?.subject || []);
    if (genres.length) return genres;
  } catch {}

  try {
    const data = await httpsGet(`https://www.googleapis.com/books/v1/volumes?q=intitle:${q}&maxResults=1`);
    const genres = normalise(data.items?.[0]?.volumeInfo?.categories || []);
    if (genres.length) return genres;
  } catch {}

  return [];
}));

// ─────────────────────────────────────────────────────────────
//  IPC — TURSO HTTP HELPERS

function _toTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float',   value: String(v) };
  }
  return { type: 'text', value: String(v) };
}

function _parseResult(result) {
  const r = result?.response?.result;
  if (!r || !r.cols) return [];
  const cols = r.cols.map(c => c.name);
  return r.rows.map(row =>
    Object.fromEntries(cols.map((c, i) => {
      const cell = row[i];
      const val  = cell?.value ?? null;
      const type = cell?.type;
      if (type === 'integer') return [c, val === null ? null : parseInt(val, 10)];
      if (type === 'float')   return [c, val === null ? null : parseFloat(val)];
      if (type === 'null')    return [c, null];
      return [c, val];
    }))
  );
}

async function _tursoHttp(url, token, pipeline) {
  const https = require('https');
  const base  = url.replace(/\/$/, '');
  const body  = JSON.stringify({ requests: pipeline });
  const u     = new URL('/v2/pipeline', base);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port:     443,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Turso: invalid response (' + res.statusCode + '): ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const TURSO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, format TEXT NOT NULL,
   file_path TEXT NOT NULL, file_name TEXT NOT NULL, file_size INTEGER NOT NULL, cover_path TEXT,
   total_chunks INTEGER DEFAULT 0, total_seconds INTEGER DEFAULT 0, duration_seconds REAL DEFAULT 0,
   status TEXT DEFAULT 'unstarted', added_at INTEGER NOT NULL, last_read INTEGER)`,
  `CREATE TABLE IF NOT EXISTS progress (book_id TEXT PRIMARY KEY, chunk_index INTEGER DEFAULT 0,
   word_index INTEGER DEFAULT 0, elapsed_seconds INTEGER DEFAULT 0, percent INTEGER DEFAULT 0,
   updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, book_id TEXT NOT NULL,
   chunk_index INTEGER DEFAULT 0, chunk_title TEXT DEFAULT '', tag TEXT DEFAULT 'note',
   content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
   color TEXT DEFAULT '#c8a96e', sort_order INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS book_collections (book_id TEXT NOT NULL, collection_id INTEGER NOT NULL,
   added_at INTEGER NOT NULL, PRIMARY KEY (book_id, collection_id))`,
];

/** Quick connectivity test */
ipcMain.handle('db:testTurso', async (_, { url, token }) => {
  if (!url || !token) throw new Error('Turso URL and token are required');
  const res = await _tursoHttp(url, token, [
    { type: 'execute', stmt: { sql: 'SELECT 1' } },
    { type: 'close' },
  ]);
  if (res.results?.[0]?.type === 'error') throw new Error(res.results[0].error?.message || 'Unknown Turso error');
  return { ok: true };
});

/** Full bidirectional sync with Turso */
ipcMain.handle('db:syncTurso', async (_, { url, token }) => {
  if (!url || !token) throw new Error('Enter Turso URL and token first');
  const local = db.exportAll();

  // ── PUSH: ensure schema + upsert all local records ──
  const pushPipeline = [
    ...TURSO_SCHEMA.map(sql => ({ type: 'execute', stmt: { sql } })),
  ];

  const pushBook = 'INSERT OR REPLACE INTO books (id,title,author,format,file_path,file_name,file_size,cover_path,total_chunks,total_seconds,duration_seconds,status,added_at,last_read) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  for (const b of local.books)
    pushPipeline.push({ type: 'execute', stmt: { sql: pushBook, args: [b.id,b.title,b.author,b.format,b.file_path,b.file_name,b.file_size,b.cover_path,b.total_chunks,b.total_seconds,b.duration_seconds,b.status,b.added_at,b.last_read].map(_toTursoArg) } });

  const pushProg = 'INSERT OR REPLACE INTO progress (book_id,chunk_index,word_index,elapsed_seconds,percent,updated_at) VALUES (?,?,?,?,?,?)';
  for (const p of local.progress)
    pushPipeline.push({ type: 'execute', stmt: { sql: pushProg, args: [p.book_id,p.chunk_index,p.word_index,p.elapsed_seconds,p.percent,p.updated_at].map(_toTursoArg) } });

  const pushNote = 'INSERT OR REPLACE INTO notes (id,book_id,chunk_index,chunk_title,tag,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)';
  for (const n of local.notes)
    pushPipeline.push({ type: 'execute', stmt: { sql: pushNote, args: [n.id,n.book_id,n.chunk_index,n.chunk_title,n.tag,n.content,n.created_at,n.updated_at].map(_toTursoArg) } });

  const pushCol = 'INSERT OR IGNORE INTO collections (id,name,color,sort_order,created_at) VALUES (?,?,?,?,?)';
  for (const c of local.collections)
    pushPipeline.push({ type: 'execute', stmt: { sql: pushCol, args: [c.id,c.name,c.color,c.sort_order,c.created_at].map(_toTursoArg) } });

  const pushBC = 'INSERT OR IGNORE INTO book_collections (book_id,collection_id,added_at) VALUES (?,?,?)';
  for (const bc of local.book_collections)
    pushPipeline.push({ type: 'execute', stmt: { sql: pushBC, args: [bc.book_id,bc.collection_id,bc.added_at].map(_toTursoArg) } });

  pushPipeline.push({ type: 'close' });
  await _tursoHttp(url, token, pushPipeline);

  // ── PULL: fetch all remote records ──
  const pullRes = await _tursoHttp(url, token, [
    { type: 'execute', stmt: { sql: 'SELECT * FROM books' } },
    { type: 'execute', stmt: { sql: 'SELECT * FROM progress' } },
    { type: 'execute', stmt: { sql: 'SELECT * FROM notes' } },
    { type: 'execute', stmt: { sql: 'SELECT * FROM collections' } },
    { type: 'execute', stmt: { sql: 'SELECT * FROM book_collections' } },
    { type: 'close' },
  ]);

  const remote = {
    version:          2,
    books:            _parseResult(pullRes.results[0]),
    progress:         _parseResult(pullRes.results[1]),
    notes:            _parseResult(pullRes.results[2]),
    collections:      _parseResult(pullRes.results[3]),
    book_collections: _parseResult(pullRes.results[4]),
  };
  const stats = db.importAll(remote);

  return {
    pushed: { books: local.books.length, notes: local.notes.length },
    pulled: stats,
  };
});

// ═════════════════════════════════════════════════════════════
//  BACKUP & RESTORE
// ═════════════════════════════════════════════════════════════

const DEFAULT_BACKUP_SETTINGS = {
  frequency:    'daily',   // 'off' | 'hourly' | 'daily' | 'weekly'
  location:     '',        // '' = resolved to Documents\Sonara Backups at runtime
  lastBackupAt: null,
  maxKeep:      10,
};

function getDefaultBackupLocation() {
  return path.join(app.getPath('documents'), 'Sonara Backups');
}

function _getBackupSettings() {
  try {
    const raw = db.getSetting('backupSettings', null);
    if (!raw) return { ...DEFAULT_BACKUP_SETTINGS };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Object.assign({}, DEFAULT_BACKUP_SETTINGS, parsed);
  } catch { return { ...DEFAULT_BACKUP_SETTINGS }; }
}

function _setBackupSettings(partial) {
  const current = _getBackupSettings();
  const merged  = Object.assign({}, current, partial);
  db.setSetting('backupSettings', JSON.stringify(merged));
  return merged;
}

function _fmtTs(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Recursively remove a directory and all its contents
function _rimraf(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const f of fs.readdirSync(dirPath)) {
    const fp = path.join(dirPath, f);
    if (fs.statSync(fp).isDirectory()) _rimraf(fp);
    else fs.unlinkSync(fp);
  }
  fs.rmdirSync(dirPath);
}

// Recursively sum file sizes in a directory
function _dirSize(dirPath) {
  let total = 0;
  const _sum = d => {
    try {
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        const s  = fs.statSync(fp);
        if (s.isFile()) total += s.size;
        else if (s.isDirectory()) _sum(fp);
      }
    } catch {}
  };
  _sum(dirPath);
  return total;
}

/**
 * Create a full backup folder: DB + books + covers + config.
 * Returns { backupDir, dirName, totalSize }.
 */
function createBackup(location, appVersion) {
  if (!location) throw new Error('Backup location is not set');
  fs.mkdirSync(location, { recursive: true });

  const now       = new Date();
  const dirName   = `sonara-backup-${_fmtTs(now)}`;
  const backupDir = path.join(location, dirName);
  fs.mkdirSync(backupDir, { recursive: true });

  // ── Database ─────────────────────────────────────────────
  const dbPath = db.getPath();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, path.join(backupDir, 'sonara.db'));
    for (const ext of ['-wal', '-shm']) {
      const wal = dbPath + ext;
      if (fs.existsSync(wal)) fs.copyFileSync(wal, path.join(backupDir, 'sonara.db' + ext));
    }
  }

  // ── Config ────────────────────────────────────────────────
  if (_configPath && fs.existsSync(_configPath)) {
    fs.copyFileSync(_configPath, path.join(backupDir, 'sonara-config.json'));
  }

  // ── Book files ────────────────────────────────────────────
  const booksBackupDir = path.join(backupDir, 'books');
  fs.mkdirSync(booksBackupDir, { recursive: true });
  let bookFilesCount = 0;
  if (booksDir && fs.existsSync(booksDir)) {
    for (const f of fs.readdirSync(booksDir)) {
      try {
        const src = path.join(booksDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(booksBackupDir, f));
          bookFilesCount++;
        }
      } catch {}
    }
  }

  // ── Cover images ─────────────────────────────────────────
  const coversBackupDir = path.join(backupDir, 'covers');
  fs.mkdirSync(coversBackupDir, { recursive: true });
  let coversCount = 0;
  if (coversDir && fs.existsSync(coversDir)) {
    for (const f of fs.readdirSync(coversDir)) {
      try {
        const src = path.join(coversDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(coversBackupDir, f));
          coversCount++;
        }
      } catch {}
    }
  }

  // ── Manifest ─────────────────────────────────────────────
  const allBooks = db.getAllBooks();
  const manifest = {
    version:        '1.0',
    appVersion:     appVersion || app.getVersion(),
    createdAt:      now.toISOString(),
    platform:       process.platform,
    booksCount:     allBooks.length,
    bookFilesCount,
    coversCount,
  };
  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2), 'utf8'
  );

  return { backupDir, dirName, totalSize: _dirSize(backupDir) };
}

/** Return sorted (newest-first) list of backup metadata objects. */
function listBackups(location) {
  if (!location || !fs.existsSync(location)) return [];
  try {
    return fs.readdirSync(location)
      .filter(f => {
        if (!f.startsWith('sonara-backup-')) return false;
        return fs.statSync(path.join(location, f)).isDirectory();
      })
      .map(f => {
        const backupDir = path.join(location, f);
        const stat      = fs.statSync(backupDir);
        let manifest = null;
        try {
          const mp = path.join(backupDir, 'manifest.json');
          if (fs.existsSync(mp)) manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
        } catch {}
        return {
          dirName:    f,
          backupDir,
          totalSize:  _dirSize(backupDir),
          modifiedAt: stat.mtime.toISOString(),
          manifest,
        };
      })
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  } catch { return []; }
}

/** Delete oldest backups beyond maxKeep. */
function pruneBackups(location, maxKeep) {
  if (!location || !maxKeep || maxKeep <= 0) return;
  listBackups(location).slice(maxKeep).forEach(b => {
    try { _rimraf(b.backupDir); } catch {}
  });
}

/**
 * Restore all data from a backup folder.
 * Preserves current backup settings and DB path config after restoring.
 */
function restoreBackup(backupDir) {
  if (!fs.existsSync(backupDir)) throw new Error('Backup folder not found');
  const mpath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(mpath)) throw new Error('Invalid backup: missing manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  if (!manifest.version) throw new Error('Invalid backup manifest');

  // Preserve current backup settings so rotation config survives the restore
  const savedBackupSettings = _getBackupSettings();
  // Preserve current DB path from config so location override stays
  const currentCfg = _readConfig();

  // ── Restore database ─────────────────────────────────────
  const srcDb = path.join(backupDir, 'sonara.db');
  if (fs.existsSync(srcDb)) {
    const destDb = db.getPath();
    db.reopen(destDb);          // flush WAL + close
    fs.copyFileSync(srcDb, destDb);
    for (const ext of ['-wal', '-shm']) {
      const srcWal = path.join(backupDir, 'sonara.db' + ext);
      if (fs.existsSync(srcWal)) fs.copyFileSync(srcWal, destDb + ext);
    }
    db.reopen(destDb);          // reopen with restored DB
  }

  // ── Restore book files (merge — overwrite existing with backup copy) ──
  const srcBooks = path.join(backupDir, 'books');
  if (fs.existsSync(srcBooks)) {
    for (const f of fs.readdirSync(srcBooks)) {
      try {
        const src = path.join(srcBooks, f);
        if (fs.statSync(src).isFile())
          fs.copyFileSync(src, path.join(booksDir, f));
      } catch {}
    }
  }

  // ── Restore cover images (merge) ─────────────────────────
  const srcCovers = path.join(backupDir, 'covers');
  if (fs.existsSync(srcCovers)) {
    for (const f of fs.readdirSync(srcCovers)) {
      try {
        const src = path.join(srcCovers, f);
        if (fs.statSync(src).isFile())
          fs.copyFileSync(src, path.join(coversDir, f));
      } catch {}
    }
  }

  // ── Restore config (preserve current DB path & backup settings) ──
  const srcCfg = path.join(backupDir, 'sonara-config.json');
  if (fs.existsSync(srcCfg)) {
    try {
      const restoredCfg = JSON.parse(fs.readFileSync(srcCfg, 'utf8'));
      // Keep current DB path so the location override is not lost
      const mergedCfg = Object.assign({}, restoredCfg, {
        customDbPath: currentCfg.customDbPath || null,
      });
      fs.writeFileSync(_configPath, JSON.stringify(mergedCfg, null, 2));
    } catch {}
  }

  // Re-persist backup settings (DB restore wiped them)
  _setBackupSettings(savedBackupSettings);

  return { booksCount: manifest.booksCount || 0, bookFilesCount: manifest.bookFilesCount || 0 };
}

// ─────────────────────────────────────────────────────────────
//  BACKUP — AUTO-BACKUP SCHEDULER
// ─────────────────────────────────────────────────────────────
let _autoBackupTimer = null;

function scheduleAutoBackup() {
  if (_autoBackupTimer) { clearInterval(_autoBackupTimer); _autoBackupTimer = null; }

  const bk = _getBackupSettings();
  if (bk.frequency === 'off') return;

  const INTERVALS = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
  const ms = INTERVALS[bk.frequency];
  if (!ms) return;

  // Run immediately if overdue (5s delay lets the window finish loading)
  const lastAt = bk.lastBackupAt ? new Date(bk.lastBackupAt).getTime() : 0;
  if (Date.now() - lastAt >= ms) setTimeout(performAutoBackup, 5000);

  // Periodic tick — re-check every hour max
  const tick = Math.min(ms, 3_600_000);
  _autoBackupTimer = setInterval(() => {
    const b  = _getBackupSettings();
    const dur = INTERVALS[b.frequency];
    const lt  = b.lastBackupAt ? new Date(b.lastBackupAt).getTime() : 0;
    if (dur && Date.now() - lt >= dur) performAutoBackup();
  }, tick);
}

function performAutoBackup() {
  try {
    const bk  = _getBackupSettings();
    const loc = bk.location || getDefaultBackupLocation();
    createBackup(loc, app.getVersion());
    pruneBackups(loc, bk.maxKeep || 10);
    _setBackupSettings({ lastBackupAt: new Date().toISOString() });
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('backup:done', { success: true });
  } catch (e) {
    console.error('[autoBackup]', e.message);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('backup:done', { success: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
//  IPC — BACKUP
// ─────────────────────────────────────────────────────────────

ipcMain.handle('backup:getSettings', ipcHandler(() => {
  const bk = _getBackupSettings();
  if (!bk.location) bk.location = getDefaultBackupLocation();
  return bk;
}));

ipcMain.handle('backup:setSettings', ipcHandler((_, partial) => {
  const merged = _setBackupSettings(partial);
  scheduleAutoBackup();
  return merged;
}));

ipcMain.handle('backup:create', ipcHandler(async (_, { location } = {}) => {
  const bk  = _getBackupSettings();
  const loc = location || bk.location || getDefaultBackupLocation();
  const result = createBackup(loc, app.getVersion());
  pruneBackups(loc, bk.maxKeep || 10);
  _setBackupSettings({ lastBackupAt: new Date().toISOString() });
  return result;
}));

ipcMain.handle('backup:restore', ipcHandler(async (_, { backupDir }) => {
  return restoreBackup(backupDir);
}));

ipcMain.handle('backup:list', ipcHandler((_, { location } = {}) => {
  const bk  = _getBackupSettings();
  const loc = location || bk.location || getDefaultBackupLocation();
  return listBackups(loc);
}));

ipcMain.handle('backup:delete', ipcHandler((_, { backupDir }) => {
  if (!backupDir || !fs.existsSync(backupDir)) throw new Error('Backup not found');
  _rimraf(backupDir);
  return { success: true };
}));

ipcMain.handle('backup:chooseLocation', ipcHandler(async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Choose Backup Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}));
