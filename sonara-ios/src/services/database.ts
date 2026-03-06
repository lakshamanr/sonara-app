/**
 * DatabaseService — Sonara iOS
 * Ports the desktop SQLite schema using expo-sqlite.
 * Same schema, same data model as the Electron version.
 */
import * as SQLite from 'expo-sqlite';

export interface Book {
  id: string;
  title: string;
  author: string | null;
  format: 'pdf' | 'epub' | 'mp3' | 'm4b' | 'm4a' | 'ogg';
  file_path: string;
  file_name: string;
  file_size: number;
  cover_path: string | null;
  total_chunks: number;
  total_seconds: number;
  duration_seconds: number;
  status: 'unstarted' | 'reading' | 'done';
  added_at: number;
  last_read: number | null;
}

export interface Progress {
  book_id: string;
  chunk_index: number;
  word_index: number;
  elapsed_seconds: number;
  percent: number;
  updated_at: number;
}

export interface Collection {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export interface Note {
  id: number;
  book_id: string;
  chunk_index: number;
  content: string;
  color: string;
  created_at: number;
  updated_at: number;
}

export interface Highlight {
  id: number;
  book_id: string;
  page: number;
  text: string;
  color: string;
  note: string | null;
  created_at: number;
}

let db: SQLite.SQLiteDatabase | null = null;

export const DatabaseService = {
  async init(): Promise<void> {
    db = await SQLite.openDatabaseAsync('sonara.db');

    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS books (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        author           TEXT DEFAULT NULL,
        format           TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        file_name        TEXT NOT NULL,
        file_size        INTEGER NOT NULL,
        cover_path       TEXT DEFAULT NULL,
        total_chunks     INTEGER DEFAULT 0,
        total_seconds    INTEGER DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        status           TEXT DEFAULT 'unstarted',
        added_at         INTEGER NOT NULL,
        last_read        INTEGER
      );

      CREATE TABLE IF NOT EXISTS progress (
        book_id         TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        chunk_index     INTEGER DEFAULT 0,
        word_index      INTEGER DEFAULT 0,
        elapsed_seconds INTEGER DEFAULT 0,
        percent         INTEGER DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collections (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        color       TEXT DEFAULT '#c8a96e',
        sort_order  INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS book_collections (
        book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        added_at      INTEGER NOT NULL,
        PRIMARY KEY (book_id, collection_id)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content     TEXT NOT NULL,
        color       TEXT DEFAULT '#c8a96e',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS highlights (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        page       INTEGER DEFAULT 0,
        text       TEXT NOT NULL,
        color      TEXT DEFAULT '#c8a96e44',
        note       TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bc_collection ON book_collections(collection_id);
      CREATE INDEX IF NOT EXISTS idx_bc_book ON book_collections(book_id);
      CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
      CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
    `);
  },

  getDb(): SQLite.SQLiteDatabase {
    if (!db) throw new Error('Database not initialized. Call DatabaseService.init() first.');
    return db;
  },

  // ── BOOKS ──────────────────────────────────────────────────
  async getAllBooks(): Promise<Book[]> {
    const database = this.getDb();
    return await database.getAllAsync<Book>(
      'SELECT * FROM books ORDER BY COALESCE(last_read, added_at) DESC'
    );
  },

  async getBook(id: string): Promise<Book | null> {
    const database = this.getDb();
    return await database.getFirstAsync<Book>('SELECT * FROM books WHERE id = ?', [id]);
  },

  async addBook(book: Omit<Book, 'status' | 'total_chunks' | 'total_seconds' | 'duration_seconds'>): Promise<void> {
    const database = this.getDb();
    await database.runAsync(
      `INSERT OR REPLACE INTO books
        (id, title, author, format, file_path, file_name, file_size, cover_path, 
         total_chunks, total_seconds, duration_seconds, status, added_at, last_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'unstarted', ?, NULL)`,
      [book.id, book.title, book.author ?? null, book.format, book.file_path,
       book.file_name, book.file_size, book.cover_path ?? null, book.added_at]
    );
  },

  async updateBook(id: string, fields: Partial<Book>): Promise<void> {
    const database = this.getDb();
    const entries = Object.entries(fields).filter(([k]) => k !== 'id');
    if (!entries.length) return;
    const setClauses = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    await database.runAsync(`UPDATE books SET ${setClauses} WHERE id = ?`, [...values, id]);
  },

  async deleteBook(id: string): Promise<void> {
    const database = this.getDb();
    await database.runAsync('DELETE FROM books WHERE id = ?', [id]);
  },

  async updateLastRead(id: string): Promise<void> {
    const database = this.getDb();
    await database.runAsync('UPDATE books SET last_read = ? WHERE id = ?', [Date.now(), id]);
  },

  // ── PROGRESS ───────────────────────────────────────────────
  async getProgress(bookId: string): Promise<Progress | null> {
    const database = this.getDb();
    return await database.getFirstAsync<Progress>(
      'SELECT * FROM progress WHERE book_id = ?', [bookId]
    );
  },

  async saveProgress(p: Omit<Progress, 'updated_at'>): Promise<void> {
    const database = this.getDb();
    await database.runAsync(
      `INSERT OR REPLACE INTO progress 
        (book_id, chunk_index, word_index, elapsed_seconds, percent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.book_id, p.chunk_index, p.word_index, p.elapsed_seconds, p.percent, Date.now()]
    );
    if (p.percent > 0) {
      const status = p.percent >= 100 ? 'done' : 'reading';
      await database.runAsync('UPDATE books SET status = ? WHERE id = ?', [status, p.book_id]);
    }
  },

  // ── COLLECTIONS ────────────────────────────────────────────
  async getAllCollections(): Promise<Collection[]> {
    const database = this.getDb();
    return await database.getAllAsync<Collection>(
      'SELECT * FROM collections ORDER BY sort_order, name'
    );
  },

  async createCollection(name: string, color = '#c8a96e'): Promise<number> {
    const database = this.getDb();
    const result = await database.runAsync(
      'INSERT INTO collections (name, color, sort_order, created_at) VALUES (?, ?, 0, ?)',
      [name, color, Date.now()]
    );
    return result.lastInsertRowId;
  },

  async deleteCollection(id: number): Promise<void> {
    const database = this.getDb();
    await database.runAsync('DELETE FROM collections WHERE id = ?', [id]);
  },

  async getCollectionBooks(collectionId: number): Promise<Book[]> {
    const database = this.getDb();
    return await database.getAllAsync<Book>(
      `SELECT b.* FROM books b
       JOIN book_collections bc ON bc.book_id = b.id
       WHERE bc.collection_id = ?
       ORDER BY bc.added_at DESC`,
      [collectionId]
    );
  },

  async addBookToCollection(bookId: string, collectionId: number): Promise<void> {
    const database = this.getDb();
    await database.runAsync(
      'INSERT OR IGNORE INTO book_collections (book_id, collection_id, added_at) VALUES (?, ?, ?)',
      [bookId, collectionId, Date.now()]
    );
  },

  async removeBookFromCollection(bookId: string, collectionId: number): Promise<void> {
    const database = this.getDb();
    await database.runAsync(
      'DELETE FROM book_collections WHERE book_id = ? AND collection_id = ?',
      [bookId, collectionId]
    );
  },

  // ── NOTES ─────────────────────────────────────────────────
  async getNotes(bookId: string): Promise<Note[]> {
    const database = this.getDb();
    return await database.getAllAsync<Note>(
      'SELECT * FROM notes WHERE book_id = ? ORDER BY chunk_index', [bookId]
    );
  },

  async saveNote(bookId: string, chunkIndex: number, content: string, color = '#c8a96e'): Promise<number> {
    const database = this.getDb();
    const result = await database.runAsync(
      `INSERT INTO notes (book_id, chunk_index, content, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bookId, chunkIndex, content, color, Date.now(), Date.now()]
    );
    return result.lastInsertRowId;
  },

  async deleteNote(id: number): Promise<void> {
    const database = this.getDb();
    await database.runAsync('DELETE FROM notes WHERE id = ?', [id]);
  },

  // ── HIGHLIGHTS ────────────────────────────────────────────
  async getHighlights(bookId: string): Promise<Highlight[]> {
    const database = this.getDb();
    return await database.getAllAsync<Highlight>(
      'SELECT * FROM highlights WHERE book_id = ? ORDER BY page, created_at', [bookId]
    );
  },

  async saveHighlight(bookId: string, page: number, text: string, color = '#c8a96e44', note?: string): Promise<number> {
    const database = this.getDb();
    const result = await database.runAsync(
      `INSERT INTO highlights (book_id, page, text, color, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bookId, page, text, color, note ?? null, Date.now()]
    );
    return result.lastInsertRowId;
  },

  async deleteHighlight(id: number): Promise<void> {
    const database = this.getDb();
    await database.runAsync('DELETE FROM highlights WHERE id = ?', [id]);
  },

  // ── SETTINGS ──────────────────────────────────────────────
  async getSetting(key: string, fallback = ''): Promise<string> {
    const database = this.getDb();
    const row = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?', [key]
    );
    return row?.value ?? fallback;
  },

  async setSetting(key: string, value: string): Promise<void> {
    const database = this.getDb();
    await database.runAsync(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]
    );
  },
};
