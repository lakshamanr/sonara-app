-- Sonara Database Schema
-- Version 3 (Production)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Books table - stores all imported books (PDF, EPUB, audio)
CREATE TABLE IF NOT EXISTS books (
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

-- Progress tracking - reading position, percentage, time
CREATE TABLE IF NOT EXISTS progress (
  book_id         TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  chunk_index     INTEGER DEFAULT 0,
  word_index      INTEGER DEFAULT 0,
  elapsed_seconds INTEGER DEFAULT 0,
  percent         INTEGER DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

-- Collections - user-created book groups
CREATE TABLE IF NOT EXISTS collections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT DEFAULT '#c8a96e',
  sort_order  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Book-Collection relationships (many-to-many)
CREATE TABLE IF NOT EXISTS book_collections (
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (book_id, collection_id)
);

-- Settings - app configuration and user preferences
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bc_collection ON book_collections(collection_id);
CREATE INDEX IF NOT EXISTS idx_bc_book ON book_collections(book_id);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_added ON books(added_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read DESC);

-- Schema version tracking
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '"3"');
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v2', '"true"');
INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v3', '"true"');
