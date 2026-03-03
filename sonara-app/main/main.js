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
//  APP BOOTSTRAP
// ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  try {
    const userData = app.getPath('userData');
    booksDir  = path.join(userData, 'books');
    coversDir = path.join(userData, 'covers');
    fs.mkdirSync(booksDir, { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });

    db.init(userData);
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

  mainWindow = new BrowserWindow({
    width:  Math.min(1400, width  - 40),
    height: Math.min(900,  height - 40),
    minWidth:  900,
    minHeight: 600,
    icon: path.join(__dirname, 'logo', 'logo.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
