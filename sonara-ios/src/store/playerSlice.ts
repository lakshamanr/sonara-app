import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Book } from '../services/database';

export type PlayerMode = 'tts' | 'audio';

interface PlayerState {
  activeBook: Book | null;
  mode: PlayerMode;
  isPlaying: boolean;
  isPaused: boolean;
  currentChunk: number;
  totalChunks: number;
  currentWordIndex: number;
  speed: number;
  pitch: number;
  voiceId: string;
  voiceMode: 'system' | 'edge';
  elapsedSeconds: number;
  percent: number;
  // Audio mode specific
  audioPosition: number;
  audioDuration: number;
  // TTS chunks cache
  chunks: string[];
}

const initialState: PlayerState = {
  activeBook: null,
  mode: 'tts',
  isPlaying: false,
  isPaused: false,
  currentChunk: 0,
  totalChunks: 0,
  currentWordIndex: 0,
  speed: 1.0,
  pitch: 1.0,
  voiceId: '',
  voiceMode: 'system',
  elapsedSeconds: 0,
  percent: 0,
  audioPosition: 0,
  audioDuration: 0,
  chunks: [],
};

const playerSlice = createSlice({
  name: 'player',
  initialState,
  reducers: {
    openBook(state, action: PayloadAction<{ book: Book; mode: PlayerMode }>) {
      state.activeBook = action.payload.book;
      state.mode = action.payload.mode;
      state.isPlaying = false;
      state.isPaused = false;
      state.currentChunk = 0;
      state.currentWordIndex = 0;
      state.percent = 0;
    },
    closeBook(state) {
      state.activeBook = null;
      state.isPlaying = false;
      state.isPaused = false;
      state.chunks = [];
    },
    setPlaying(state, action: PayloadAction<boolean>) {
      state.isPlaying = action.payload;
      if (action.payload) state.isPaused = false;
    },
    setPaused(state, action: PayloadAction<boolean>) {
      state.isPaused = action.payload;
      if (action.payload) state.isPlaying = false;
    },
    setChunks(state, action: PayloadAction<string[]>) {
      state.chunks = action.payload;
      state.totalChunks = action.payload.length;
    },
    setCurrentChunk(state, action: PayloadAction<number>) {
      state.currentChunk = Math.max(0, Math.min(action.payload, state.totalChunks - 1));
      state.currentWordIndex = 0;
    },
    setCurrentWord(state, action: PayloadAction<number>) {
      state.currentWordIndex = action.payload;
    },
    setSpeed(state, action: PayloadAction<number>) {
      state.speed = Math.max(0.5, Math.min(3.0, action.payload));
    },
    setPitch(state, action: PayloadAction<number>) {
      state.pitch = Math.max(0.5, Math.min(2.0, action.payload));
    },
    setVoice(state, action: PayloadAction<{ voiceId: string; voiceMode: 'system' | 'edge' }>) {
      state.voiceId = action.payload.voiceId;
      state.voiceMode = action.payload.voiceMode;
    },
    setProgress(state, action: PayloadAction<{ elapsed: number; percent: number }>) {
      state.elapsedSeconds = action.payload.elapsed;
      state.percent = action.payload.percent;
    },
    setAudioProgress(state, action: PayloadAction<{ position: number; duration: number }>) {
      state.audioPosition = action.payload.position;
      state.audioDuration = action.payload.duration;
    },
    restoreProgress(state, action: PayloadAction<{ chunk: number; word: number; elapsed: number; percent: number }>) {
      state.currentChunk = action.payload.chunk;
      state.currentWordIndex = action.payload.word;
      state.elapsedSeconds = action.payload.elapsed;
      state.percent = action.payload.percent;
    },
  },
});

export const {
  openBook,
  closeBook,
  setPlaying,
  setPaused,
  setChunks,
  setCurrentChunk,
  setCurrentWord,
  setSpeed,
  setPitch,
  setVoice,
  setProgress,
  setAudioProgress,
  restoreProgress,
} = playerSlice.actions;

export default playerSlice.reducer;
