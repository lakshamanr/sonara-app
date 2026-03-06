import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { DatabaseService } from '../services/database';

interface SettingsState {
  theme: 'black' | 'night' | 'warm' | 'sepia';
  readerFont: 'serif' | 'sans' | 'mono';
  readerFontSize: number;
  readerLineHeight: number;
  ttsSkipChars: string;
  ttsSkipWords: string;
  claudeKey: string;
  autoSave: boolean;
  loaded: boolean;
}

const initialState: SettingsState = {
  theme: 'black',
  readerFont: 'serif',
  readerFontSize: 17,
  readerLineHeight: 1.8,
  ttsSkipChars: '*_~#',
  ttsSkipWords: '',
  claudeKey: '',
  autoSave: true,
  loaded: false,
};

export const loadSettings = createAsyncThunk('settings/load', async () => {
  const [theme, readerFont, readerFontSize, readerLineHeight,
         ttsSkipChars, ttsSkipWords, claudeKey, autoSave] = await Promise.all([
    DatabaseService.getSetting('theme', 'black'),
    DatabaseService.getSetting('readerFont', 'serif'),
    DatabaseService.getSetting('readerFontSize', '17'),
    DatabaseService.getSetting('readerLineHeight', '1.8'),
    DatabaseService.getSetting('ttsSkipChars', '*_~#'),
    DatabaseService.getSetting('ttsSkipWords', ''),
    DatabaseService.getSetting('claude_key', ''),
    DatabaseService.getSetting('autoSave', 'true'),
  ]);
  return {
    theme: theme as SettingsState['theme'],
    readerFont: readerFont as SettingsState['readerFont'],
    readerFontSize: parseInt(readerFontSize, 10) || 17,
    readerLineHeight: parseFloat(readerLineHeight) || 1.8,
    ttsSkipChars,
    ttsSkipWords,
    claudeKey,
    autoSave: autoSave === 'true',
  };
});

export const saveSetting = createAsyncThunk(
  'settings/save',
  async ({ key, value }: { key: string; value: string }) => {
    await DatabaseService.setSetting(key, value);
    return { key, value };
  }
);

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setTheme(state, action: PayloadAction<SettingsState['theme']>) {
      state.theme = action.payload;
    },
    setReaderFont(state, action: PayloadAction<SettingsState['readerFont']>) {
      state.readerFont = action.payload;
    },
    setReaderFontSize(state, action: PayloadAction<number>) {
      state.readerFontSize = action.payload;
    },
    setClaudeKey(state, action: PayloadAction<string>) {
      state.claudeKey = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSettings.fulfilled, (state, action) => {
        return { ...action.payload, loaded: true };
      });
  },
});

export const { setTheme, setReaderFont, setReaderFontSize, setClaudeKey } = settingsSlice.actions;
export default settingsSlice.reducer;
