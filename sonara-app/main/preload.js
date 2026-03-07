'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * window.sonara — the entire renderer-facing API surface.
 *
 * Standards:
 *  - All methods return Promises (wrapping ipcRenderer.invoke).
 *  - Read operations resolve with the requested data (or null/[] if not found).
 *  - Write/delete operations resolve with { success: true }.
 *  - Errors are thrown as structured Error objects with `e.code` set.
 *  - The `meta` namespace exposes static runtime values synchronously.
 */
contextBridge.exposeInMainWorld('sonara', {

  // ── META / RUNTIME (synchronous — available immediately) ─
  meta: {
    platform: process.platform,        // 'win32' | 'darwin' | 'linux'
    arch:     process.arch,            // 'x64' | 'arm64' | ...
    version:  () => ipcRenderer.invoke('app:getVersion'),
    getAll:   () => ipcRenderer.invoke('app:getMeta'),
  },

  // ── LIBRARY ──────────────────────────────────────────────
  library: {
    /** @returns {Promise<Book[]>} */
    getAll:     ()         => ipcRenderer.invoke('library:getAll'),
    /** @returns {Promise<Book|null>} */
    getBook:    (id)       => ipcRenderer.invoke('library:getBook', id),
    /** @returns {Promise<Book>} */
    addBook:    (data)     => ipcRenderer.invoke('library:addBook', data),
    /** @returns {Promise<Book>} */
    updateBook: (id, f)    => ipcRenderer.invoke('library:updateBook', id, f),
    /** @returns {Promise<{success:true}>} */
    deleteBook: (id)       => ipcRenderer.invoke('library:deleteBook', id),
    /** @returns {Promise<boolean>} */
    bookExists: (id)       => ipcRenderer.invoke('library:bookExists', id),
    /** @returns {Promise<Book|null>} updated book, or null if cancelled */
    relinkFile: (id)       => ipcRenderer.invoke('library:relinkFile', id),
  },

  // ── PROGRESS ─────────────────────────────────────────────
  progress: {
    /** @returns {Promise<Progress|null>} */
    get:   (bookId) => ipcRenderer.invoke('progress:get', bookId),
    /** @returns {Promise<{success:true}>} */
    save:  (data)   => ipcRenderer.invoke('progress:save', data),
    /** @returns {Promise<{success:true}>} */
    reset: (bookId) => ipcRenderer.invoke('progress:reset', bookId),
  },

  // ── SETTINGS ─────────────────────────────────────────────
  settings: {
    /** @returns {Promise<any>} resolved value or defaultVal */
    get:    (key, def) => ipcRenderer.invoke('settings:get', key, def),
    /** @returns {Promise<{success:true}>} */
    set:    (key, val) => ipcRenderer.invoke('settings:set', key, val),
    /** @returns {Promise<Record<string,any>>} */
    getAll: ()         => ipcRenderer.invoke('settings:getAll'),
  },
  // ── WINDOW CONTROLS ──────────────────────────────
  win: {
    minimize:    () => ipcRenderer.invoke('win:minimize'),
    maximize:    () => ipcRenderer.invoke('win:maximize'),
    close:       () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),    alwaysOnTop: (val) => ipcRenderer.invoke('win:alwaysOnTop', val),  },

  // ── DATABASE SYNC ─────────────────────────────────────────
  db: {
    /** @returns {Promise<string>} current db file path */
    getPath:         ()    => ipcRenderer.invoke('db:getPath'),
    /** @returns {Promise<string|null>} new path, or null if cancelled */
    choosePath:      ()    => ipcRenderer.invoke('db:choosePath'),
    /** @returns {Promise<string>} default userData path */
    resetPath:       ()    => ipcRenderer.invoke('db:resetPath'),
    /** @returns {Promise<{path,books,notes}|null>} */
    export:          ()    => ipcRenderer.invoke('db:export'),
    /** @returns {Promise<{books,notes,collections}|null>} */
    import:          ()    => ipcRenderer.invoke('db:import'),
    /** @returns {Promise<{url,token}>} */
    getTursoConfig:  ()    => ipcRenderer.invoke('db:getTursoConfig'),
    /** @returns {Promise<{success:true}>} */
    saveTursoConfig: (cfg) => ipcRenderer.invoke('db:saveTursoConfig', cfg),
    /** @returns {Promise<{ok:true}>} */
    testTurso:       (cfg) => ipcRenderer.invoke('db:testTurso', cfg),
    /** @returns {Promise<{pushed,pulled}>} */
    syncTurso:       (cfg) => ipcRenderer.invoke('db:syncTurso', cfg),
  },

  // ── BOOKS FOLDER ────────────────────────────────────────
  books: {
    /** @returns {Promise<string>} books folder path */
    getDir:    ()       => ipcRenderer.invoke('books:getDir'),
    /** @returns {Promise<string>} open the books folder in Explorer */
    openDir:   ()       => ipcRenderer.invoke('books:openDir'),
    /** @returns {Promise<string[]>} up to 2 normalised genre names */
    classify:  (title)    => ipcRenderer.invoke('books:classify', title),
    /**
     * Parse a MOBI or AZW3 file; returns { title, chunks }
     * @returns {Promise<{title: string, chunks: Array}>}
     */
    parseMOBI: (filePath) => ipcRenderer.invoke('books:parseMOBI', filePath),
  },

  // ── UNIFIED DATA FOLDER ──────────────────────────────────
  data: {
    /** @returns {Promise<string>} path to the unified Sonara-Data folder */
    getDir: () => ipcRenderer.invoke('data:getDir'),
    /** @returns {Promise<string>} open Sonara-Data folder in Explorer */
    openDir: () => ipcRenderer.invoke('data:openDir'),
  },

  // ── FILE / DIALOG ─────────────────────────────────────────
  dialog: {
    /** @returns {Promise<FileInfo|null>} */
    openFile:  () => ipcRenderer.invoke('dialog:openFile'),
    /** @returns {Promise<string|null>} chosen image file path */
    openImage: () => ipcRenderer.invoke('dialog:openImage'),
  },
  file: {
    /** @returns {Promise<string|null>} base64 encoded file contents */
    read:   (p) => ipcRenderer.invoke('file:read', p),
    /** @returns {Promise<boolean>} */
    exists: (p) => ipcRenderer.invoke('file:exists', p),
  },

  // ── SHELL ────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── COLLECTIONS ──────────────────────────────────────────
  collections: {
    /** @returns {Promise<Collection[]>} */
    getAll:             ()           => ipcRenderer.invoke('collections:getAll'),
    /** @returns {Promise<Collection|null>} */
    get:                (id)         => ipcRenderer.invoke('collections:get', id),
    /** @returns {Promise<Collection>} */
    create:             (name, col)  => ipcRenderer.invoke('collections:create', name, col),
    /** @returns {Promise<Collection>} */
    update:             (id, f)      => ipcRenderer.invoke('collections:update', id, f),
    /** @returns {Promise<{success:true}>} */
    delete:             (id)         => ipcRenderer.invoke('collections:delete', id),
    /** @returns {Promise<{success:true}>} */
    addBook:            (bId, cId)   => ipcRenderer.invoke('collections:addBook', bId, cId),
    /** @returns {Promise<{success:true}>} */
    removeBook:         (bId, cId)   => ipcRenderer.invoke('collections:removeBook', bId, cId),
    /** @returns {Promise<Collection[]>} */
    getBookCollections: (bId)        => ipcRenderer.invoke('collections:getBookCollections', bId),
    /** @returns {Promise<Book[]>} */
    getBooks:           (cId)        => ipcRenderer.invoke('collections:getBooks', cId),
  },

  // ── COVERS ───────────────────────────────────────────────
  cover: {
    /** @returns {Promise<string>} saved cover file path */
    save:         (data)              => ipcRenderer.invoke('cover:save', data),
    /** @returns {Promise<string|null>} */
    getPath:      (bId)               => ipcRenderer.invoke('cover:getPath', bId),
    /** @returns {Promise<string>} saved cover path */
    saveFromFile: (bookId, imagePath) => ipcRenderer.invoke('cover:saveFromFile', { bookId, imagePath }),
  },

  // ── AUDIO ────────────────────────────────────────────────
  audio: {
    /** Extract embedded cover art from an audio file and save it.
     *  @returns {Promise<string|null>} saved cover path or null */
    extractCover: (data) => ipcRenderer.invoke('audio:extractCover', data),
  },

  // ── EDGE TTS (Neural voices — no API key required) ────────
  tts: {
    /** @returns {Promise<Voice[]>} */
    getVoices:  ()     => ipcRenderer.invoke('tts:getVoices'),
    /**
     * @param {{ text: string, voice: string, speed?: number, pitch?: number }} opts
     * @returns {Promise<{ audio: string, wordBoundaries: any[] }>} base64 MP3
     */
    synthesize: (opts) => ipcRenderer.invoke('tts:synthesize', opts),
  },

  // ── EXPORT ───────────────────────────────────────────────
  export: {
    /**
     * Show save dialog for MP3.
     * @returns {Promise<string|null>} file path, or null if cancelled
     */
    saveDialog: (title) => ipcRenderer.invoke('export:saveDialog', title),
    /**
     * Concatenate base64 chunks and write to disk.
     * @param {{ path: string, chunks: string[] }} data
     * @returns {Promise<{success:true}>}
     */
    writeFile:  (data)  => ipcRenderer.invoke('export:writeFile',  data),
  },
  // ── NOTES ───────────────────────────────────────
  notes: {
    /** @returns {Promise<Note>} newly created note */
    add:        (data)             => ipcRenderer.invoke('notes:add', data),
    /** @returns {Promise<Note[]>} all notes for book, ordered by chapter */
    getAll:     (bookId)           => ipcRenderer.invoke('notes:getAll', bookId),
    /** @returns {Promise<{success:true}>} */
    update:     (id, content, tag) => ipcRenderer.invoke('notes:update', id, content, tag),
    /** @returns {Promise<{success:true}>} */
    delete:     (id)               => ipcRenderer.invoke('notes:delete', id),
    /** @returns {Promise<string|null>} chosen file path or null */
    saveDialog: (opts)             => ipcRenderer.invoke('notes:saveDialog', opts),
    /** @returns {Promise<{success:true}>} */
    writeText:  (data)             => ipcRenderer.invoke('notes:writeText',  data),
    /** @returns {Promise<{success:true}>} */
    writePdf:   (data)             => ipcRenderer.invoke('notes:writePdf',   data),
  },

  // ── PLAYER STATE BRIDGE (renderer ↔ tray / mini player) ───────────
  player: {
    /** Push current playback state to tray + mini player */
    updateState: (state) => ipcRenderer.send('player:updateState', state),
    /** Listen for tray/mini-player commands: 'toggle' | 'prev' | 'next' */
    onCommand:   (cb)    => ipcRenderer.on('player:command', (_, cmd) => cb(cmd)),
  },

  // ── MINI PLAYER WINDOW ───────────────────────────────────
  miniPlayer: {
    /** Toggle the mini floating player window */
    toggle: () => ipcRenderer.send('miniPlayer:toggle'),
  },
});

