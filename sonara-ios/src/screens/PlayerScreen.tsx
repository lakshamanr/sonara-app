import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  Dimensions, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Slider from '@react-native-community/slider';

import { RootState, AppDispatch } from '../store';
import { setPlaying, setPaused, setSpeed, setAudioProgress } from '../store/playerSlice';
import { Colors } from '../theme/colors';
import { AudioService } from '../services/audioService';
import { DatabaseService } from '../services/database';
import { useProgress, usePlaybackState, State } from 'react-native-track-player';

const { width: SCREEN_W } = Dimensions.get('window');

export default function PlayerScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const navigation = useNavigation();

  const { activeBook, speed, audioPosition, audioDuration } = useSelector(
    (s: RootState) => s.player
  );
  const playbackState = usePlaybackState();
  const progress = useProgress(250);

  const [loading, setLoading] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [seekPos, setSeekPos] = useState(0);

  const isPlaying = playbackState.state === State.Playing;
  const isAudio = activeBook && ['mp3', 'm4b', 'm4a', 'ogg'].includes(activeBook.format);

  useEffect(() => {
    if (activeBook && isAudio) {
      loadAudio();
    }
  }, [activeBook?.id]);

  useEffect(() => {
    if (!seeking && progress.duration > 0) {
      dispatch(setAudioProgress({ position: progress.position, duration: progress.duration }));
      // Save progress every 30 seconds
      if (activeBook && Math.floor(progress.position) % 30 === 0) {
        saveAudioProgress();
      }
    }
  }, [progress.position, progress.duration, seeking]);

  async function loadAudio() {
    if (!activeBook) return;
    setLoading(true);
    try {
      await AudioService.setup();
      await AudioService.loadAudiobook([
        {
          id: activeBook.id,
          url: activeBook.file_path,
          title: activeBook.title,
          artist: activeBook.author ?? 'Unknown',
          album: 'Sonara Audiobook',
          artwork: activeBook.cover_path ?? undefined,
        }
      ]);

      // Restore position
      const prog = await DatabaseService.getProgress(activeBook.id);
      if (prog && prog.elapsed_seconds > 0) {
        await AudioService.seekTo(prog.elapsed_seconds);
      }

      await AudioService.setRate(speed);

      await AudioService.play();
      dispatch(setPlaying(true));
      await DatabaseService.updateLastRead(activeBook.id);
    } catch (err) {
      console.error('Failed to load audio:', err);
      Alert.alert('Audio Error', 'Could not load this audio file.');
    } finally {
      setLoading(false);
    }
  }

  async function saveAudioProgress() {
    if (!activeBook || progress.duration === 0) return;
    const pct = Math.round((progress.position / progress.duration) * 100);
    await DatabaseService.saveProgress({
      book_id: activeBook.id,
      chunk_index: 0,
      word_index: 0,
      elapsed_seconds: Math.floor(progress.position),
      percent: pct,
    });
  }

  async function togglePlay() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) {
      await AudioService.pause();
    } else {
      await AudioService.play();
    }
  }

  async function skipBack() {
    await AudioService.seekTo(Math.max(0, progress.position - 30));
  }

  async function skipForward() {
    await AudioService.seekTo(Math.min(progress.duration, progress.position + 30));
  }

  async function onSeekComplete(value: number) {
    await AudioService.seekTo(value);
    setSeeking(false);
  }

  async function cycleSpeed() {
    const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
    const current = speeds.indexOf(speed);
    const next = speeds[(current + 1) % speeds.length];
    dispatch(setSpeed(next));
    await AudioService.setRate(next);
  }

  if (!activeBook || !isAudio) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.emptyPlayer}>
          <Ionicons name="headset-outline" size={80} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>No audiobook playing</Text>
          <Text style={styles.emptySubtitle}>
            Open an MP3, M4B, or M4A file from your library
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const position = seeking ? seekPos : progress.position;
  const duration = progress.duration;
  const percent = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Cover Art */}
        <View style={styles.coverWrap}>
          {activeBook.cover_path ? (
            <Image
              source={{ uri: activeBook.cover_path }}
              style={styles.cover}
              resizeMode="cover"
            />
          ) : (
            <LinearGradient
              colors={['#1a1a2e', '#2a1a3e']}
              style={styles.cover}
            >
              <Ionicons name="headset" size={80} color={Colors.gold + '88'} />
            </LinearGradient>
          )}
        </View>

        {/* Book Info */}
        <View style={styles.bookInfo}>
          <Text style={styles.bookTitle} numberOfLines={2}>{activeBook.title}</Text>
          <Text style={styles.bookAuthor}>{activeBook.author ?? 'Unknown Author'}</Text>
        </View>

        {/* Progress */}
        <View style={styles.progressSection}>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={duration || 1}
            value={position}
            minimumTrackTintColor={Colors.gold}
            maximumTrackTintColor={Colors.border}
            thumbTintColor={Colors.gold}
            onSlidingStart={(v) => { setSeeking(true); setSeekPos(v); }}
            onValueChange={(v) => setSeeking && setSeekPos(v)}
            onSlidingComplete={onSeekComplete}
          />
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(position)}</Text>
            <Text style={styles.timeText}>{formatTime(duration)}</Text>
          </View>
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {/* Speed button */}
          <TouchableOpacity style={styles.speedBtn} onPress={cycleSpeed}>
            <Text style={styles.speedText}>{speed}×</Text>
          </TouchableOpacity>

          <View style={styles.mainControls}>
            <TouchableOpacity style={styles.skipBtn} onPress={() => AudioService.skipToPrevious()}>
              <Ionicons name="play-skip-back" size={28} color={Colors.textSecondary} />
            </TouchableOpacity>

            <TouchableOpacity style={styles.skipBtn} onPress={skipBack}>
              <Ionicons name="play-back" size={28} color={Colors.textSecondary} />
              <Text style={styles.skipLabel}>30</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.playBtn} onPress={togglePlay}>
              {loading
                ? <ActivityIndicator size="large" color={Colors.textInverse} />
                : <Ionicons name={isPlaying ? 'pause' : 'play'} size={32} color={Colors.textInverse} />
              }
            </TouchableOpacity>

            <TouchableOpacity style={styles.skipBtn} onPress={skipForward}>
              <Ionicons name="play-forward" size={28} color={Colors.textSecondary} />
              <Text style={styles.skipLabel}>30</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.skipBtn} onPress={() => AudioService.skipToNext()}>
              <Ionicons name="play-skip-forward" size={28} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Sleep timer placeholder */}
          <TouchableOpacity style={styles.sleepBtn}>
            <Ionicons name="moon-outline" size={20} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Chapter info */}
        <View style={styles.chapterInfo}>
          <Text style={styles.chapterLabel}>
            {Math.round(percent)}% complete · {formatTime(duration - position)} remaining
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 24, paddingBottom: 40 },
  emptyPlayer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: Colors.textPrimary },
  emptySubtitle: { fontSize: 14, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },
  coverWrap: {
    alignSelf: 'center',
    marginTop: 32,
    marginBottom: 28,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 20,
  },
  cover: {
    width: SCREEN_W - 80,
    height: SCREEN_W - 80,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  bookInfo: { alignItems: 'center', marginBottom: 24 },
  bookTitle: {
    fontSize: 22, fontWeight: '700', color: Colors.textPrimary,
    textAlign: 'center', lineHeight: 28,
  },
  bookAuthor: { fontSize: 15, color: Colors.textSecondary, marginTop: 6 },
  progressSection: { marginBottom: 24 },
  slider: { width: '100%', height: 40 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -8 },
  timeText: { fontSize: 12, color: Colors.textMuted },
  controls: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 20,
  },
  mainControls: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playBtn: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: Colors.gold, alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.gold, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  skipBtn: { alignItems: 'center', justifyContent: 'center', position: 'relative' },
  skipLabel: { fontSize: 8, color: Colors.textMuted, position: 'absolute', bottom: -10 },
  speedBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 10, backgroundColor: Colors.bgSurface, borderWidth: 1, borderColor: Colors.border,
  },
  speedText: { fontSize: 12, color: Colors.gold, fontWeight: '700' },
  sleepBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 10, backgroundColor: Colors.bgSurface, borderWidth: 1, borderColor: Colors.border,
  },
  chapterInfo: { alignItems: 'center' },
  chapterLabel: { fontSize: 13, color: Colors.textMuted },
});
