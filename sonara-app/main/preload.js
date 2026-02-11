'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, typed API to the renderer
contextBridge.exposeInMainWorld('sonara', {

  // ── LIBRARY ──────────────────────────────────────────────
  library: {
    getAll:      ()         => ipcRenderer.invoke('library:getAll'),
    getBook:     (id)       => ipcRenderer.invoke('library:getBook', id),
    addBook:     (data)     => ipcRenderer.invoke('library:addBook', data),
    updateBook:  (id, f)    => ipcRenderer.invoke('library:updateBook', id, f),
    deleteBook:  (id)       => ipcRenderer.invoke('library:deleteBook', id),
    bookExists:  (id)       => ipcRenderer.invoke('library:bookExists', id),
  },

  // ── PROGRESS ─────────────────────────────────────────────
  progress: {
    get:   (bookId) => ipcRenderer.invoke('progress:get', bookId),
    save:  (data)   => ipcRenderer.invoke('progress:save', data),
    reset: (bookId) => ipcRenderer.invoke('progress:reset', bookId),
  },

  // ── SETTINGS ─────────────────────────────────────────────
  settings: {
    get:    (key, def) => ipcRenderer.invoke('settings:get', key, def),
    set:    (key, val) => ipcRenderer.invoke('settings:set', key, val),
    getAll: ()         => ipcRenderer.invoke('settings:getAll'),
  },

  // ── FILE ─────────────────────────────────────────────────
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
  },
  file: {
    read:   (p) => ipcRenderer.invoke('file:read', p),
    exists: (p) => ipcRenderer.invoke('file:exists', p),
  },

  // ── APP ──────────────────────────────────────────────────
  app: {
    getVersion:      () => ipcRenderer.invoke('app:getVersion'),
    getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── EDGE TTS (Natural Neural Voices) ───────────────────
  tts: {
    getVoices:   ()     => ipcRenderer.invoke('tts:getVoices'),
    synthesize:  (opts) => ipcRenderer.invoke('tts:synthesize', opts),
  }
});
