import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { DatabaseService, Book, Collection } from '../services/database';
import { FileService, ImportedFile } from '../services/fileService';

interface LibraryState {
  books: Book[];
  collections: Collection[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  activeFormat: 'all' | 'pdf' | 'epub' | 'audio';
  activeCollection: 'all' | 'recent' | 'reading' | number;
  sortBy: 'recent' | 'title' | 'author' | 'progress';
}

const initialState: LibraryState = {
  books: [],
  collections: [],
  loading: false,
  error: null,
  searchQuery: '',
  activeFormat: 'all',
  activeCollection: 'all',
  sortBy: 'recent',
};

// Async thunks
export const loadLibrary = createAsyncThunk('library/load', async () => {
  const [books, collections] = await Promise.all([
    DatabaseService.getAllBooks(),
    DatabaseService.getAllCollections(),
  ]);
  return { books, collections };
});

export const importBooks = createAsyncThunk('library/import', async (_, { dispatch }) => {
  const files = await FileService.pickBooks();
  for (const file of files) {
    await DatabaseService.addBook(file);
  }
  dispatch(loadLibrary());
  return files.length;
});

export const deleteBook = createAsyncThunk('library/delete', async (book: Book, { dispatch }) => {
  await DatabaseService.deleteBook(book.id);
  await FileService.deleteBookFile(book.file_path);
  if (book.cover_path) await FileService.deleteBookFile(book.cover_path);
  dispatch(loadLibrary());
});

export const createCollection = createAsyncThunk(
  'library/createCollection',
  async ({ name, color }: { name: string; color: string }, { dispatch }) => {
    await DatabaseService.createCollection(name, color);
    dispatch(loadLibrary());
  }
);

export const deleteCollection = createAsyncThunk(
  'library/deleteCollection',
  async (id: number, { dispatch }) => {
    await DatabaseService.deleteCollection(id);
    dispatch(loadLibrary());
  }
);

const librarySlice = createSlice({
  name: 'library',
  initialState,
  reducers: {
    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
    },
    setActiveFormat(state, action: PayloadAction<LibraryState['activeFormat']>) {
      state.activeFormat = action.payload;
    },
    setActiveCollection(state, action: PayloadAction<LibraryState['activeCollection']>) {
      state.activeCollection = action.payload;
    },
    setSortBy(state, action: PayloadAction<LibraryState['sortBy']>) {
      state.sortBy = action.payload;
    },
    clearError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLibrary.pending, (state) => { state.loading = true; state.error = null; })
      .addCase(loadLibrary.fulfilled, (state, action) => {
        state.loading = false;
        state.books = action.payload.books;
        state.collections = action.payload.collections;
      })
      .addCase(loadLibrary.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? 'Failed to load library';
      });
  },
});

export const {
  setSearchQuery,
  setActiveFormat,
  setActiveCollection,
  setSortBy,
  clearError,
} = librarySlice.actions;

// Selectors
export const selectFilteredBooks = (state: { library: LibraryState }) => {
  const { books, searchQuery, activeFormat, activeCollection, sortBy } = state.library;
  let filtered = [...books];

  const AUDIO = ['mp3', 'm4b', 'm4a', 'ogg'];

  // Collection filter
  if (activeCollection === 'recent') {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter(b => b.added_at > weekAgo);
  } else if (activeCollection === 'reading') {
    filtered = filtered.filter(b => b.status === 'reading');
  }

  // Format filter
  if (activeFormat === 'audio') {
    filtered = filtered.filter(b => AUDIO.includes(b.format));
  } else if (activeFormat !== 'all') {
    filtered = filtered.filter(b => b.format === activeFormat);
  }

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(b =>
      b.title.toLowerCase().includes(q) ||
      (b.author?.toLowerCase().includes(q) ?? false)
    );
  }

  // Sort
  if (sortBy === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title));
  else if (sortBy === 'author') filtered.sort((a, b) => (a.author ?? '').localeCompare(b.author ?? ''));
  else if (sortBy === 'progress') filtered.sort((a, b) => (b.status === 'reading' ? 1 : 0) - (a.status === 'reading' ? 1 : 0));

  return filtered;
};

export default librarySlice.reducer;
