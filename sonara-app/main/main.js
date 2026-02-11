'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const db    = require('../database/db');

const edgeTTS = require('./edge-tts');

const isDev = process.env.NODE_ENV === 'development';

// ═══════════════════════════════════════════════════════════
//  ENABLE CLOUD VOICES - MAXIMUM CHROMIUM ACCESS
// ═══════════════════════════════════════════════════════════
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

let mainWindow;
let booksDir;   // where we copy user files
let coversDir;  // where we save extracted cover images

// ─────────────────────────────────────────────────────────────
//  APP BOOTSTRAP
// ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  try {
    const userData = app.getPath('userData');
    booksDir  = path.join(userData, 'books');
    coversDir = path.join(userData, 'covers');
    console.log('User data path:', userData);
    console.log('Books directory:', booksDir);
    console.log('Covers directory:', coversDir);
    fs.mkdirSync(booksDir, { recursive: true });
    fs.mkdirSync(coversDir, { recursive: true });

    db.init(userData);
    console.log('Database initialized');
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Always open DevTools to see console logs
    mainWindow.webContents.openDevTools({ mode: 'detach' });
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
ipcMain.handle('library:getAll', () => {
  return db.getAllBooks();
});

ipcMain.handle('library:getBook', (_, id) => {
  return db.getBook(id);
});

ipcMain.handle('library:addBook', async (_, bookData) => {
  try {
    // bookData: { id, title, format, sourcePath, fileName, fileSize }
    const destPath = path.join(booksDir, bookData.id + path.extname(bookData.fileName));

    // Copy file to our managed folder if not already there
    if (bookData.sourcePath && fs.existsSync(bookData.sourcePath) && bookData.sourcePath !== destPath) {
      console.log('Copying file from', bookData.sourcePath, 'to', destPath);
      fs.copyFileSync(bookData.sourcePath, destPath);
    }

    const book = {
      id:            bookData.id,
      title:         bookData.title,
      format:        bookData.format,
      file_path:     destPath,
      file_name:     bookData.fileName,
      file_size:     bookData.fileSize,
      total_chunks:  bookData.totalChunks  || 0,
      total_seconds: bookData.totalSeconds || 0,
      status:        'unstarted',
      added_at:      Date.now(),
      last_read:     null
    };

    console.log('Adding book to database:', book.id, book.title);
    db.addBook(book);
    const savedBook = db.getBook(book.id);
    console.log('Book saved successfully:', savedBook?.id);
    return savedBook;
  } catch (err) {
    console.error('Error adding book:', err);
    throw err;
  }
});

ipcMain.handle('library:updateBook', (_, id, fields) => {
  db.updateBook(id, fields);
  return db.getBook(id);
});

ipcMain.handle('library:deleteBook', (_, id) => {
  const book = db.getBook(id);
  if (book && book.file_path && fs.existsSync(book.file_path)) {
    try { fs.unlinkSync(book.file_path); } catch {}
  }
  db.deleteBook(id);
  return { success: true };
});

ipcMain.handle('library:bookExists', (_, id) => {
  return db.bookExists(id);
});

// ─────────────────────────────────────────────────────────────
//  IPC — PROGRESS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('progress:get', (_, bookId) => {
  const progress = db.getProgress(bookId);
  console.log('[Main] progress:get for bookId:', bookId, '-> progress:', progress);
  return progress;
});

ipcMain.handle('progress:save', (_, data) => {
  console.log('[Main] progress:save - bookId:', data.book_id, 'chunk:', data.chunk_index, 'percent:', data.percent + '%');
  db.saveProgress(data);
  return { success: true };
});

ipcMain.handle('progress:reset', (_, bookId) => {
  console.log('[Main] progress:reset for bookId:', bookId);
  db.resetProgress(bookId);
  return { success: true };
});

// ─────────────────────────────────────────────────────────────
//  IPC — SETTINGS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', (_, key, defaultVal) => {
  return db.getSetting(key, defaultVal);
});

ipcMain.handle('settings:set', (_, key, value) => {
  db.setSetting(key, value);
  return { success: true };
});

ipcMain.handle('settings:getAll', () => {
  return db.getAllSettings();
});

// ─────────────────────────────────────────────────────────────
//  IPC — FILE DIALOG & READING
// ─────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  try {
    console.log('[Main] Opening file dialog...');
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
      console.log('[Main] File dialog canceled');
      return null;
    }
    const filePath = result.filePaths[0];
    console.log('[Main] File selected:', filePath);
    const stat = fs.statSync(filePath);
    const fileInfo = {
      path:     filePath,
      name:     path.basename(filePath),
      size:     stat.size,
      format:   path.extname(filePath).toLowerCase().slice(1)
    };
    console.log('[Main] File info:', fileInfo);
    console.log('[Main] File size:', (fileInfo.size / (1024 * 1024)).toFixed(2), 'MB');
    return fileInfo;
  } catch (err) {
    console.error('[Main] Error in file dialog:', err);
    return null;
  }
});

ipcMain.handle('file:read', (_, filePath) => {
  try {
    console.log('[Main] Reading file:', filePath);
    // Returns file as base64 for renderer to parse
    if (!fs.existsSync(filePath)) {
      console.error('[Main] File does not exist:', filePath);
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    console.log('[Main] File read successfully, size:', buffer.length, 'bytes, base64 length:', base64.length);
    return base64;
  } catch (err) {
    console.error('[Main] Error reading file:', err);
    return null;
  }
});

ipcMain.handle('file:exists', (_, filePath) => {
  return fs.existsSync(filePath);
});

// ─────────────────────────────────────────────────────────────
//  IPC — APP INFO
// ─────────────────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url);
});

// ─────────────────────────────────────────────────────────────
//  IPC — EDGE TTS (Natural Neural Voices)
// ─────────────────────────────────────────────────────────────
ipcMain.handle('tts:getVoices', async () => {
  try {
    const voices = await edgeTTS.getVoices();
    console.log('[Main] Edge TTS voices:', voices.length);
    return voices;
  } catch (err) {
    console.error('[Main] Error fetching Edge TTS voices:', err);
    return [];
  }
});

// ─────────────────────────────────────────────────────────────
//  IPC — COLLECTIONS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('collections:getAll', () => db.getAllCollections());

ipcMain.handle('collections:get', (_, id) => db.getCollection(id));

ipcMain.handle('collections:create', (_, name, color) => db.createCollection(name, color));

ipcMain.handle('collections:update', (_, id, fields) => {
  db.updateCollection(id, fields);
  return db.getCollection(id);
});

ipcMain.handle('collections:delete', (_, id) => {
  db.deleteCollection(id);
  return { success: true };
});

ipcMain.handle('collections:addBook', (_, bookId, collectionId) => {
  db.addBookToCollection(bookId, collectionId);
  return { success: true };
});

ipcMain.handle('collections:removeBook', (_, bookId, collectionId) => {
  db.removeBookFromCollection(bookId, collectionId);
  return { success: true };
});

ipcMain.handle('collections:getBookCollections', (_, bookId) => {
  return db.getBookCollections(bookId);
});

ipcMain.handle('collections:getBooks', (_, collectionId) => {
  return db.getCollectionBooks(collectionId);
});

// ─────────────────────────────────────────────────────────────
//  IPC — COVERS
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
    const rate = edgeTTS.speedToRate(speed || 1.0);
    const pitchHz = edgeTTS.pitchToHz(pitch || 1.0);
    console.log('[Main] TTS synthesize:', voice, 'rate:', rate, 'pitch:', pitchHz, 'text length:', text.length);
    const result = await edgeTTS.synthesize(text, voice, { rate, pitch: pitchHz });
    console.log('[Main] TTS audio generated:', result.audio.length, 'bytes,', result.wordBoundaries.length, 'word boundaries');
    return {
      audio: result.audio.toString('base64'),
      wordBoundaries: result.wordBoundaries
    };
  } catch (err) {
    console.error('[Main] TTS synthesis error:', err);
    throw err;
  }
});
