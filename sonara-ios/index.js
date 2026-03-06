// Polyfills required for React Native (Edge TTS crypto, etc.)
import 'react-native-get-random-values';

// Register the TrackPlayer service for background audio playback
import TrackPlayer from 'react-native-track-player';
const { PlaybackService } = require('./src/services/trackPlayerService');

TrackPlayer.registerPlaybackService(() => PlaybackService);

// Expo entry point
import 'expo/AppEntry';
