'use strict';
const path = require('path');
const fs   = require('fs');

let db;
let _dbPath = null;

function init(dbFullPath) {
  const Database = require('better-sqlite3');
  _dbPath = dbFullPath;
  db = new Database(dbFullPath);

  // WAL mode for better performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      format        TEXT NOT NULL CHECK(format IN ('pdf','epub')),
      file_path     TEXT NOT NULL,
      file_name     TEXT NOT NULL,
      file_size     INTEGER NOT NULL,
      total_chunks  INTEGER DEFAULT 0,
      total_seconds INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'unstarted' CHECK(status IN ('unstarted','reading','done')),
      added_at      INTEGER NOT NULL,
      last_read     INTEGER
    );

    CREATE TABLE IF NOT EXISTS progress (
      book_id         TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      chunk_index     INTEGER DEFAULT 0,
      word_index      INTEGER DEFAULT 0,
      elapsed_seconds INTEGER DEFAULT 0,
      percent         INTEGER DEFAULT 0,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── SCHEMA V2 MIGRATION ─────────────────────────────────────
  // Adds: collections, book_collections, expanded book format, cover_path, author, duration_seconds
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'schema_v2'").get();
  if (!migrated) {
    db.pragma('foreign_keys = OFF');

    db.exec(`
      ALTER TABLE books RENAME TO books_old;

      CREATE TABLE books (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        author          TEXT DEFAULT NULL,
        format          TEXT NOT NULL CHECK(format IN ('pdf','epub','mp3','m4b','m4a','ogg')),
        file_path       TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        file_size       INTEGER NOT NULL,
        cover_path      TEXT DEFAULT NULL,
        total_chunks    INTEGER DEFAULT 0,
        total_seconds   INTEGER DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        status          TEXT DEFAULT 'unstarted' CHECK(status IN ('unstarted','reading','done')),
        added_at        INTEGER NOT NULL,
        last_read       INTEGER
      );

      INSERT INTO books (id, title, format, file_path, file_name, file_size,
                         total_chunks, total_seconds, status, added_at, last_read)
      SELECT id, title, format, file_path, file_name, file_size,
             total_chunks, total_seconds, status, added_at, last_read
      FROM books_old;

      DROP TABLE books_old;

      CREATE TABLE IF NOT EXISTS collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        color       TEXT DEFAULT '#c8a96e',
        parent_id   INTEGER DEFAULT NULL REFERENCES collections(id) ON DELETE SET NULL,
        sort_order  INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS book_collections (
        book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        added_at      INTEGER NOT NULL,
        PRIMARY KEY (book_id, collection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bc_collection ON book_collections(collection_id);
      CREATE INDEX IF NOT EXISTS idx_bc_book ON book_collections(book_id);
    `);

    db.pragma('foreign_keys = ON');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v2', '\"true\"')").run();
  } else {
    // Ensure collections tables exist (fresh installs after migration flag)
    db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        color       TEXT DEFAULT '#c8a96e',
        parent_id   INTEGER DEFAULT NULL REFERENCES collections(id) ON DELETE SET NULL,
        sort_order  INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS book_collections (
        book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        added_at      INTEGER NOT NULL,
        PRIMARY KEY (book_id, collection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bc_collection ON book_collections(collection_id);
      CREATE INDEX IF NOT EXISTS idx_bc_book ON book_collections(book_id);
    `);
  }

  // ── SCHEMA V3 FIX ──────────────────────────────────────────
  // Fix: V2 migration broke progress table FK (SQLite updated it to
  // reference books_old, which was then dropped). Recreate progress table.
  const v3 = db.prepare("SELECT value FROM settings WHERE key = 'schema_v3'").get();
  if (!v3) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS progress_new (
        book_id         TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        chunk_index     INTEGER DEFAULT 0,
        word_index      INTEGER DEFAULT 0,
        elapsed_seconds INTEGER DEFAULT 0,
        percent         INTEGER DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO progress_new SELECT * FROM progress;
      DROP TABLE IF EXISTS progress;
      ALTER TABLE progress_new RENAME TO progress;
    `);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v3', '\"true\"')").run();
  }

  // ── SCHEMA V4 — Notes table ──────────────────────────────
  const v4 = db.prepare("SELECT value FROM settings WHERE key = 'schema_v4'").get();
  if (!v4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_title TEXT    NOT NULL DEFAULT '',
        tag         TEXT    NOT NULL DEFAULT 'note',
        content     TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
    `);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v4', '\"true\"')").run();
  } else {
    // Ensure notes table exists on fresh installs after v4 flag already set
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_title TEXT    NOT NULL DEFAULT '',
        tag         TEXT    NOT NULL DEFAULT 'note',
        content     TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
    `);
  }

  // ── SCHEMA V5 — Nested collections (folders inside folders) ─────────
  const v5 = db.prepare("SELECT value FROM settings WHERE key = 'schema_v5'").get();
  if (!v5) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ALTER TABLE collections RENAME TO collections_old;

      CREATE TABLE collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        color       TEXT DEFAULT '#c8a96e',
        parent_id   INTEGER DEFAULT NULL REFERENCES collections(id) ON DELETE SET NULL,
        sort_order  INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      INSERT INTO collections (id, name, color, sort_order, created_at)
      SELECT id, name, color, sort_order, created_at
      FROM collections_old;

      DROP TABLE collections_old;
    `);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v5', '\"true\"')").run();
  }

  // ── SCHEMA V6 — Repair broken collection FK after V5 rename ─────────
  // Some installs ended up with book_collections FK targeting collections_old.
  // This rebuild ensures collection_id references the real collections table.
  const v6 = db.prepare("SELECT value FROM settings WHERE key = 'schema_v6'").get();
  const hasBookCollections = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'book_collections'"
  ).get();
  const fkRows = hasBookCollections
    ? db.prepare('PRAGMA foreign_key_list(book_collections)').all()
    : [];
  const hasBrokenCollectionFK = fkRows.some(r => String(r.table || '').toLowerCase() === 'collections_old');

  if (!v6 || hasBrokenCollectionFK || !hasBookCollections) {
    db.pragma('foreign_keys = OFF');

    db.exec(`
      CREATE TABLE IF NOT EXISTS book_collections_new (
        book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        added_at      INTEGER NOT NULL,
        PRIMARY KEY (book_id, collection_id)
      );
    `);

    if (hasBookCollections) {
      db.prepare(`
        INSERT OR IGNORE INTO book_collections_new (book_id, collection_id, added_at)
        SELECT book_id, collection_id, added_at FROM book_collections
      `).run();
    }

    db.exec(`
      DROP TABLE IF EXISTS book_collections;
      ALTER TABLE book_collections_new RENAME TO book_collections;
      CREATE INDEX IF NOT EXISTS idx_bc_collection ON book_collections(collection_id);
      CREATE INDEX IF NOT EXISTS idx_bc_book ON book_collections(book_id);
    `);

    db.pragma('foreign_keys = ON');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v6', '\"true\"')").run();
  }

  return db;
}

// ── BOOKS ──────────────────────────────────────────────────────────────────

function getAllBooks() {
  try {
    const books = db.prepare(`
      SELECT b.*, p.chunk_index, p.word_index, p.elapsed_seconds, p.percent
      FROM books b
      LEFT JOIN progress p ON p.book_id = b.id
      ORDER BY COALESCE(b.last_read, b.added_at) DESC
    `).all();
    return books;
  } catch (err) {
    return [];
  }
}

function getBook(id) {
  return db.prepare(`
    SELECT b.*, p.chunk_index, p.word_index, p.elapsed_seconds, p.percent
    FROM books b
    LEFT JOIN progress p ON p.book_id = b.id
    WHERE b.id = ?
  `).get(id);
}

function addBook(book) {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO books
        (id, title, author, format, file_path, file_name, file_size, cover_path, total_chunks, total_seconds, duration_seconds, status, added_at, last_read)
      VALUES
        (@id, @title, @author, @format, @file_path, @file_name, @file_size, @cover_path, @total_chunks, @total_seconds, @duration_seconds, @status, @added_at, @last_read)
    `);
    stmt.run(book);
    return book;
  } catch (err) {
    throw err;
  }
}

function updateBook(id, fields) {
  const allowed = ['title','author','status','total_chunks','total_seconds','duration_seconds','cover_path','last_read','file_path','file_name'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = @${k}`).join(', ');
  if (!sets) return;
  db.prepare(`UPDATE books SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

function deleteBook(id) {
  // File cleanup handled in main process
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
}

function bookExists(id) {
  return !!db.prepare('SELECT 1 FROM books WHERE id = ? LIMIT 1').get(id);
}

// ── PROGRESS ──────────────────────────────────────────────────────────────

function saveProgress(data) {
  // data: { book_id, chunk_index, word_index, elapsed_seconds, percent }
  const now = Date.now();
  const percent = data.percent || 0;
  const status = percent >= 98 ? 'done' : percent > 0 ? 'reading' : 'unstarted';

  db.prepare(`
    INSERT INTO progress (book_id, chunk_index, word_index, elapsed_seconds, percent, updated_at)
    VALUES (@book_id, @chunk_index, @word_index, @elapsed_seconds, @percent, @updated_at)
    ON CONFLICT(book_id) DO UPDATE SET
      chunk_index     = excluded.chunk_index,
      word_index      = excluded.word_index,
      elapsed_seconds = excluded.elapsed_seconds,
      percent         = excluded.percent,
      updated_at      = excluded.updated_at
  `).run({ ...data, updated_at: now });

  db.prepare(`UPDATE books SET status = ?, last_read = ? WHERE id = ?`)
    .run(status, now, data.book_id);
}

function getProgress(bookId) {
  return db.prepare('SELECT * FROM progress WHERE book_id = ?').get(bookId);
}

function resetProgress(bookId) {
  db.prepare('DELETE FROM progress WHERE book_id = ?').run(bookId);
  db.prepare(`UPDATE books SET status = 'unstarted', last_read = NULL WHERE id = ?`).run(bookId);
}

// ── COLLECTIONS ──────────────────────────────────────────────────────────

function getAllCollections() {
  return db.prepare(`
    SELECT c.*, COUNT(bc.book_id) as book_count
    FROM collections c
    LEFT JOIN book_collections bc ON bc.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `).all();
}

function getCollection(id) {
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}

function createCollection(name, color) {
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO collections (name, color, parent_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, color || '#c8a96e', null, now);
  return { id: result.lastInsertRowid, name, color: color || '#c8a96e', parent_id: null, created_at: now };
}

function createCollectionWithParent(name, color, parentId = null) {
  const now = Date.now();
  const safeParent = Number.isInteger(parentId) ? parentId : null;
  const result = db.prepare(
    'INSERT INTO collections (name, color, parent_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, color || '#c8a96e', safeParent, now);
  return {
    id: result.lastInsertRowid,
    name,
    color: color || '#c8a96e',
    parent_id: safeParent,
    created_at: now
  };
}

function updateCollection(id, fields) {
  const allowed = ['name', 'color', 'parent_id', 'sort_order'];
  const sets = Object.keys(fields)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = @${k}`)
    .join(', ');
  if (!sets) return;
  db.prepare(`UPDATE collections SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

function deleteCollection(id) {
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

function addBookToCollection(bookId, collectionId) {
  db.prepare(
    'INSERT OR IGNORE INTO book_collections (book_id, collection_id, added_at) VALUES (?, ?, ?)'
  ).run(bookId, collectionId, Date.now());
}

function removeBookFromCollection(bookId, collectionId) {
  db.prepare(
    'DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?'
  ).run(bookId, collectionId);
}

function getBookCollections(bookId) {
  return db.prepare(`
    SELECT c.* FROM collections c
    JOIN book_collections bc ON bc.collection_id = c.id
    WHERE bc.book_id = ?
    ORDER BY c.name
  `).all(bookId);
}

function getCollectionBooks(collectionId) {
  return db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM collections WHERE id = ?
      UNION ALL
      SELECT c.id FROM collections c
      JOIN descendants d ON c.parent_id = d.id
    )
    SELECT DISTINCT b.*, p.chunk_index, p.word_index, p.elapsed_seconds, p.percent
    FROM books b
    LEFT JOIN progress p ON p.book_id = b.id
    JOIN book_collections bc ON bc.book_id = b.id
    WHERE bc.collection_id IN (SELECT id FROM descendants)
    ORDER BY COALESCE(b.last_read, b.added_at) DESC
  `).all(collectionId);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────

function getSetting(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return defaultVal;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return rows.reduce((acc, r) => {
    try { acc[r.key] = JSON.parse(r.value); } catch { acc[r.key] = r.value; }
    return acc;
  }, {});
}

// ── NOTES ────────────────────────────────────────────────────────────────

function addNote({ book_id, chunk_index, chunk_title, tag, content }) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO notes (book_id, chunk_index, chunk_title, tag, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(book_id, chunk_index || 0, chunk_title || '', tag || 'note', content, now, now);
  return { id: result.lastInsertRowid, book_id, chunk_index: chunk_index || 0,
           chunk_title: chunk_title || '', tag: tag || 'note', content, created_at: now, updated_at: now };
}

function getNotes(bookId) {
  return db.prepare(`
    SELECT * FROM notes WHERE book_id = ?
    ORDER BY chunk_index ASC, created_at DESC
  `).all(bookId);
}

function updateNote(id, { content, tag }) {
  const now = Date.now();
  db.prepare('UPDATE notes SET content = ?, tag = ?, updated_at = ? WHERE id = ?')
    .run(content, tag || 'note', now, id);
}

function deleteNote(id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

// ── DB PATH / EXPORT / IMPORT / REOPEN ────────────────────────────────────

function getPath() { return _dbPath; }

function reopen(newFullPath) {
  if (db) { try { db.close(); } catch {} }
  _dbPath = newFullPath;
  const Database = require('better-sqlite3');
  db = new Database(newFullPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

function exportAll() {
  return {
    version:          2,
    exported_at:      Date.now(),
    books:            db.prepare('SELECT * FROM books').all(),
    progress:         db.prepare('SELECT * FROM progress').all(),
    notes:            db.prepare('SELECT * FROM notes').all(),
    collections:      db.prepare('SELECT * FROM collections').all(),
    book_collections: db.prepare('SELECT * FROM book_collections').all(),
  };
}

function importAll(data) {
  if (!data || !data.books) throw new Error('Invalid or incompatible backup format');

  const run = db.transaction(() => {
    // Books
    const bStmt = db.prepare(`
      INSERT OR REPLACE INTO books
        (id,title,author,format,file_path,file_name,file_size,cover_path,total_chunks,total_seconds,duration_seconds,status,added_at,last_read)
      VALUES
        (@id,@title,@author,@format,@file_path,@file_name,@file_size,@cover_path,@total_chunks,@total_seconds,@duration_seconds,@status,@added_at,@last_read)`);
    for (const b of (data.books || [])) bStmt.run(b);

    // Progress — newer timestamp wins
    const pStmt = db.prepare(`
      INSERT INTO progress (book_id,chunk_index,word_index,elapsed_seconds,percent,updated_at)
      VALUES (@book_id,@chunk_index,@word_index,@elapsed_seconds,@percent,@updated_at)
      ON CONFLICT(book_id) DO UPDATE SET
        chunk_index     = CASE WHEN excluded.updated_at > updated_at THEN excluded.chunk_index     ELSE chunk_index     END,
        word_index      = CASE WHEN excluded.updated_at > updated_at THEN excluded.word_index      ELSE word_index      END,
        elapsed_seconds = CASE WHEN excluded.updated_at > updated_at THEN excluded.elapsed_seconds ELSE elapsed_seconds END,
        percent         = CASE WHEN excluded.updated_at > updated_at THEN excluded.percent         ELSE percent         END,
        updated_at      = MAX(excluded.updated_at, updated_at)`);
    for (const p of (data.progress || [])) pStmt.run(p);

    // Notes — INSERT OR IGNORE to preserve locally created notes
    const nStmt = db.prepare(`
      INSERT OR IGNORE INTO notes
        (id,book_id,chunk_index,chunk_title,tag,content,created_at,updated_at)
      VALUES
        (@id,@book_id,@chunk_index,@chunk_title,@tag,@content,@created_at,@updated_at)`);
    for (const n of (data.notes || [])) nStmt.run(n);

    // Collections — INSERT OR IGNORE to preserve local collections
    const cStmt = db.prepare(`
      INSERT OR IGNORE INTO collections (id,name,color,parent_id,sort_order,created_at)
      VALUES (@id,@name,@color,@parent_id,@sort_order,@created_at)`);
    for (const c of (data.collections || [])) cStmt.run(c);

    // Book-collection links
    const bcStmt = db.prepare(`
      INSERT OR IGNORE INTO book_collections (book_id,collection_id,added_at)
      VALUES (@book_id,@collection_id,@added_at)`);
    for (const bc of (data.book_collections || [])) bcStmt.run(bc);
  });

  run();
  return {
    books:       (data.books       || []).length,
    notes:       (data.notes       || []).length,
    collections: (data.collections || []).length,
  };
}

module.exports = {
  init,
  getPath, reopen, exportAll, importAll,
  getAllBooks, getBook, addBook, updateBook, deleteBook, bookExists,
  getProgress, saveProgress, resetProgress,
  getAllCollections, getCollection, createCollection, updateCollection, deleteCollection,
  createCollectionWithParent,
  addBookToCollection, removeBookFromCollection, getBookCollections, getCollectionBooks,
  getSetting, setSetting, getAllSettings,
  addNote, getNotes, updateNote, deleteNote,
};
