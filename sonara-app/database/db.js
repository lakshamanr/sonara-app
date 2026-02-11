'use strict';
const path = require('path');
const fs   = require('fs');

let db;

function init(userDataPath) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(userDataPath, 'sonara.db');
  db = new Database(dbPath);

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
    console.log('getAllBooks returned', books.length, 'books');
    return books;
  } catch (err) {
    console.error('Database error in getAllBooks:', err);
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
        (id, title, format, file_path, file_name, file_size, total_chunks, total_seconds, status, added_at, last_read)
      VALUES
        (@id, @title, @format, @file_path, @file_name, @file_size, @total_chunks, @total_seconds, @status, @added_at, @last_read)
    `);
    const result = stmt.run(book);
    console.log('Database addBook result:', result.changes, 'rows affected');
    return book;
  } catch (err) {
    console.error('Database error in addBook:', err);
    throw err;
  }
}

function updateBook(id, fields) {
  const allowed = ['title','status','total_chunks','total_seconds','last_read'];
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

  console.log('[DB] saveProgress called:', {
    book_id: data.book_id,
    chunk_index: data.chunk_index,
    percent: percent,
    status: status
  });

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
    
  console.log('[DB] Progress saved successfully');
}

function getProgress(bookId) {
  const progress = db.prepare('SELECT * FROM progress WHERE book_id = ?').get(bookId);
  console.log('[DB] getProgress for bookId:', bookId, '-> result:', progress);
  return progress;
}

function resetProgress(bookId) {
  db.prepare('DELETE FROM progress WHERE book_id = ?').run(bookId);
  db.prepare(`UPDATE books SET status = 'unstarted', last_read = NULL WHERE id = ?`).run(bookId);
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

module.exports = {
  init,
  getAllBooks, getBook, addBook, updateBook, deleteBook, bookExists,
  getProgress, saveProgress, resetProgress,
  getSetting, setSetting, getAllSettings
};
