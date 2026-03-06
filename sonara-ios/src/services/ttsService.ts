/**
 * TTSService — Sonara iOS
 * Text-to-speech engine that combines:
 *  1. iOS native AVSpeechSynthesizer (via expo-speech) — instant playback
 *  2. Edge TTS neural voices (Microsoft) — premium neural voices via WebSocket
 *
 * Supports word-by-word highlighting via speech boundary callbacks.
 */
import * as Speech from 'expo-speech';
import { EdgeTTSService } from './edgeTtsService';
import TrackPlayer, { Capability, State } from 'react-native-track-player';

export interface TTSOptions {
  voice?: string;           // voice identifier
  rate?: number;            // 0.5 – 2.0
  pitch?: number;           // 0.5 – 2.0
  onWord?: (word: string, index: number, start: number, end: number) => void;
  onChunkEnd?: () => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

export type VoiceMode = 'system' | 'edge';

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  quality: 'local' | 'neural';
  mode: VoiceMode;
}

let _isPlaying = false;
let _currentMode: VoiceMode = 'system';

export const TTSService = {
  // ── Voice discovery ────────────────────────────────────────
  async getSystemVoices(): Promise<VoiceInfo[]> {
    const voices = await Speech.getAvailableVoicesAsync();
    return voices.map(v => ({
      id: v.identifier,
      name: v.name,
      language: v.language,
      quality: v.quality === Speech.VoiceQuality.Enhanced ? 'neural' : 'local',
      mode: 'system',
    }));
  },

  async getEdgeVoices(): Promise<VoiceInfo[]> {
    const voices = await EdgeTTSService.getVoices();
    return voices
      .filter(v => v.Status === 'GA')
      .map(v => ({
        id: v.ShortName,
        name: v.FriendlyName,
        language: v.Locale,
        quality: 'neural',
        mode: 'edge',
      }));
  },

  async getAllVoices(): Promise<VoiceInfo[]> {
    const [sys, edge] = await Promise.all([
      this.getSystemVoices().catch(() => []),
      this.getEdgeVoices().catch(() => []),
    ]);
    // Neural edge voices first, then system
    return [...edge, ...sys];
  },

  // ── System TTS (expo-speech) ────────────────────────────────
  speakWithSystem(text: string, opts: TTSOptions = {}): void {
    _isPlaying = true;
    _currentMode = 'system';

    Speech.speak(text, {
      voice: opts.voice,
      rate: opts.rate ?? 1.0,
      pitch: opts.pitch ?? 1.0,
      onBoundary: opts.onWord
        ? ({ charIndex, charLength }) => {
            const word = text.slice(charIndex, charIndex + charLength);
            opts.onWord!(word, charIndex, charIndex, charIndex + charLength);
          }
        : undefined,
      onDone: () => {
        _isPlaying = false;
        opts.onChunkEnd?.();
        opts.onDone?.();
      },
      onError: (err) => {
        _isPlaying = false;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    });
  },

  // ── Edge TTS (neural, streamed via WebSocket → TrackPlayer) ──
  async speakWithEdge(text: string, opts: TTSOptions = {}): Promise<void> {
    _isPlaying = true;
    _currentMode = 'edge';

    try {
      const audioPath = await EdgeTTSService.synthesize(
        text,
        opts.voice ?? 'en-US-AriaNeural',
        opts.rate ?? 1.0,
        opts.pitch ?? 1.0
      );

      await TrackPlayer.reset();
      await TrackPlayer.add([{
        id: 'tts_chunk',
        url: audioPath,
        title: 'Sonara TTS',
        artist: 'Sonara',
      }]);
      await TrackPlayer.play();

      // Poll for completion
      const checkDone = setInterval(async () => {
        const state = await TrackPlayer.getState();
        if (state === State.Stopped || state === State.None) {
          clearInterval(checkDone);
          _isPlaying = false;
          opts.onChunkEnd?.();
          opts.onDone?.();
        }
      }, 300);
    } catch (err) {
      _isPlaying = false;
      // Fall back to system TTS
      console.warn('Edge TTS failed, falling back to system:', err);
      this.speakWithSystem(text, opts);
    }
  },

  stop(): void {
    _isPlaying = false;
    if (_currentMode === 'system') {
      Speech.stop();
    } else {
      TrackPlayer.stop().catch(() => {});
    }
  },

  pause(): void {
    if (_currentMode === 'system') {
      Speech.pause();
    } else {
      TrackPlayer.pause().catch(() => {});
    }
  },

  resume(): void {
    if (_currentMode === 'system') {
      Speech.resume();
    } else {
      TrackPlayer.play().catch(() => {});
    }
  },

  isPlaying(): boolean {
    return _isPlaying;
  },
};
