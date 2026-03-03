'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

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

  // Allow remote content for cloud voices
  app.commandLine.appendSwitch('disable-web-security');
  app.commandLine.appendSwitch('allow-running-insecure-content');

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
let booksDir;   // where we copy user files
let coversDir;  // where we save extracted cover images

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
    _userData   = userData;
    _configPath = path.join(userData, 'sonara-config.json');
    booksDir  = path.join(userData, 'books');
    coversDir = path.join(userData, 'covers');
    fs.mkdirSync(booksDir, { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });

    // Determine DB location — custom cloud folder or default userData
    const cfg    = _readConfig();
    const dbPath = (cfg.customDbPath && fs.existsSync(cfg.customDbPath))
      ? cfg.customDbPath
      : path.join(userData, 'sonara.db');
    db.init(dbPath);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error('Error initializing app:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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

  mainWindow.on('close', () => {
    db.setSetting('windowBounds', mainWindow.getBounds());
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
ipcMain.handle('win:isMaximized', () => mainWindow ? mainWindow.isMaximized() : false);

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
      title: 'Select a book or audiobook file',
      filters: [
        { name: 'All Supported', extensions: ['pdf', 'epub', 'mp3', 'm4b', 'm4a', 'ogg'] },
        { name: 'Books',         extensions: ['pdf', 'epub'] },
        { name: 'Audiobooks',    extensions: ['mp3', 'm4b', 'm4a', 'ogg'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) {
      return null;
    }
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    const fileInfo = {
      path:     filePath,
      name:     path.basename(filePath),
      size:     stat.size,
      format:   path.extname(filePath).toLowerCase().slice(1)
    };
    return fileInfo;
  } catch (err) {
    return null;
  }
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
    return [];
  }
});

// ─────────────────────────────────────────────────────────────
//  IPC — COLLECTIONS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('collections:getAll',  ipcHandler(() => db.getAllCollections()));
ipcMain.handle('collections:get',     ipcHandler((_, id) => db.getCollection(id)));
ipcMain.handle('collections:create',  ipcHandler((_, name, color) => db.createCollection(name, color)));
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

/** Reset to default userData path */
ipcMain.handle('db:resetPath', () => {
  _writeConfig({ customDbPath: null });
  const defaultPath = path.join(_userData, 'sonara.db');
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

// ── TURSO HTTP HELPERS ────────────────────────────────────────────────────

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
