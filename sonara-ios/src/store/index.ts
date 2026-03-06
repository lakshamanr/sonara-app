import { configureStore } from '@reduxjs/toolkit';
import libraryReducer from './librarySlice';
import playerReducer from './playerSlice';
import settingsReducer from './settingsSlice';

export const store = configureStore({
  reducer: {
    library: libraryReducer,
    player: playerReducer,
    settings: settingsReducer,
  },
  middleware: (getDefault) =>
    getDefault({ serializableCheck: false }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
