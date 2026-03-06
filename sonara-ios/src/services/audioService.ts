/**
 * AudioService — Sonara iOS
 * Background audio playback for MP3/M4B audiobooks via react-native-track-player.
 * Provides lock screen controls, progress tracking, and chapter navigation.
 */
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  RepeatMode,
  State,
  usePlaybackState,
  useProgress,
  useTrackPlayerEvents,
} from 'react-native-track-player';

export interface AudioTrack {
  id: string;
  url: string;
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
  duration?: number;
}

export const AudioService = {
  async setup(): Promise<void> {
    try {
      await TrackPlayer.setupPlayer({
        maxCacheSize: 1024 * 5, // 5MB cache
      });

      await TrackPlayer.updateOptions({
        android: {
          appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
        },
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.Stop,
          Capability.SeekTo,
        ],
        compactCapabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
        ],
        notificationCapabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.SeekTo,
        ],
        progressUpdateEventInterval: 2,
      });
    } catch {
      // Already initialized
    }
  },

  async loadAudiobook(tracks: AudioTrack[], startIndex = 0, startPosition = 0): Promise<void> {
    await TrackPlayer.reset();
    await TrackPlayer.add(tracks);
    if (startIndex > 0) await TrackPlayer.skip(startIndex);
    if (startPosition > 0) await TrackPlayer.seekTo(startPosition);
  },

  async play(): Promise<void> { await TrackPlayer.play(); },
  async pause(): Promise<void> { await TrackPlayer.pause(); },
  async stop(): Promise<void> { await TrackPlayer.stop(); },
  async reset(): Promise<void> { await TrackPlayer.reset(); },

  async seekTo(seconds: number): Promise<void> { await TrackPlayer.seekTo(seconds); },
  async skipToNext(): Promise<void> { await TrackPlayer.skipToNext().catch(() => {}); },
  async skipToPrevious(): Promise<void> { await TrackPlayer.skipToPrevious().catch(() => {}); },

  async setRate(rate: number): Promise<void> { await TrackPlayer.setRate(rate); },
  async getRate(): Promise<number> { return await TrackPlayer.getRate(); },

  async getState(): Promise<State> { return await TrackPlayer.getState(); },
  async getProgress(): Promise<{ position: number; duration: number; buffered: number }> {
    return await TrackPlayer.getProgress();
  },

  async getCurrentTrack(): Promise<number | null | undefined> {
    return await TrackPlayer.getActiveTrackIndex();
  },

  async getQueue(): Promise<AudioTrack[]> {
    const queue = await TrackPlayer.getQueue();
    return queue as AudioTrack[];
  },

  // Re-export hooks for components
  usePlaybackState,
  useProgress,
  useTrackPlayerEvents,
};
