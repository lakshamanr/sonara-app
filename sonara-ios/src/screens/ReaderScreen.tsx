import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Dimensions, ActivityIndicator, Platform, Alert, Modal,
  TextInput, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import * as Haptics from 'expo-haptics';

import { RootState, AppDispatch } from '../store';
import {
  setPlaying, setPaused, setCurrentChunk, setCurrentWord,
  setSpeed, setPitch, setChunks, setProgress, restoreProgress,
} from '../store/playerSlice';
import { Colors } from '../theme/colors';
import { Typography } from '../theme/styles';
import { TTSService } from '../services/ttsService';
import { DatabaseService } from '../services/database';
import { parseEpub, splitIntoChunks } from '../services/epubParser';
import { ClaudeService } from '../services/claudeService';
import { RootStackParamList } from '../navigation/AppNavigator';
import * as FileSystem from 'expo-file-system';
import Pdf from 'react-native-pdf';

type ReaderRoute = RouteProp<RootStackParamList, 'Reader'>;

const AUDIO_FORMATS = ['mp3', 'm4b', 'm4a', 'ogg'];

export default function ReaderScreen() {
  const navigation = useNavigation();
  const route = useRoute<ReaderRoute>();
  const dispatch = useDispatch<AppDispatch>();
  const { bookId } = route.params;

  const {
    activeBook, mode, isPlaying, isPaused,
    currentChunk, chunks, speed, pitch, voiceId, voiceMode,
    elapsedSeconds, percent,
  } = useSelector((s: RootState) => s.player);

  const settings = useSelector((s: RootState) => s.settings);
  const scrollRef = useRef<ScrollView>(null);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [loading, setLoading] = useState(true);
  const [currentWords, setCurrentWords] = useState<string[]>([]);
  const [highlightedWord, setHighlightedWord] = useState(-1);
  const [showControls, setShowControls] = useState(true);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [showClaudePanel, setShowClaudePanel] = useState(false);
  const [claudeQuery, setClaudeQuery] = useState('');
  const [claudeResponse, setClaudeResponse] = useState('');
  const [claudeLoading, setClaudeLoading] = useState(false);
  const [pdfSource, setPdfSource] = useState<{ uri: string } | null>(null);

  // ── Load book content ──────────────────────────────────────
  useEffect(() => {
    if (!activeBook) return;
    loadBook();
    startAutoSave();
    return () => {
      stopSpeaking();
      clearAutoSave();
      saveProgressNow();
    };
  }, [activeBook?.id]);

  async function loadBook() {
    if (!activeBook) return;
    setLoading(true);
    try {
      if (activeBook.format === 'pdf') {
        // PDF mode — use native PDF renderer
        setPdfSource({ uri: activeBook.file_path });
        setLoading(false);
        return;
      }

      if (AUDIO_FORMATS.includes(activeBook.format)) {
        // Audio mode — handled by PlayerScreen
        navigation.goBack();
        return;
      }

      let textChunks: string[] = [];

      if (activeBook.format === 'epub') {
        const parsed = await parseEpub(activeBook.file_path);
        textChunks = parsed.chapters.map(c => c.content);
      } else {
        // Plain text fallback
        const content = await FileSystem.readAsStringAsync(activeBook.file_path);
        textChunks = splitIntoChunks(content, 800);
      }

      dispatch(setChunks(textChunks));

      // Restore progress
      const prog = await DatabaseService.getProgress(activeBook.id);
      if (prog && prog.chunk_index < textChunks.length) {
        dispatch(restoreProgress({
          chunk: prog.chunk_index,
          word: prog.word_index,
          elapsed: prog.elapsed_seconds,
          percent: prog.percent,
        }));
        updateCurrentWords(textChunks[prog.chunk_index]);
      } else if (textChunks.length > 0) {
        updateCurrentWords(textChunks[0]);
      }

      await DatabaseService.updateLastRead(activeBook.id);
    } catch (err) {
      console.error('Failed to load book:', err);
      Alert.alert('Error', 'Could not load book content.');
    } finally {
      setLoading(false);
    }
  }

  function updateCurrentWords(text: string) {
    setCurrentWords(text ? text.split(/\s+/).filter(w => w.length > 0) : []);
    setHighlightedWord(-1);
  }

  // ── TTS Engine ─────────────────────────────────────────────
  function startReading(fromChunk = currentChunk) {
    if (!chunks.length) return;
    dispatch(setPlaying(true));
    speakChunk(fromChunk);
  }

  function speakChunk(chunkIdx: number) {
    if (chunkIdx >= chunks.length) {
      dispatch(setPlaying(false));
      return;
    }

    const text = cleanTextForTTS(chunks[chunkIdx], settings.ttsSkipChars, settings.ttsSkipWords);
    updateCurrentWords(chunks[chunkIdx]);
    dispatch(setCurrentChunk(chunkIdx));

    const opts = {
      voice: voiceId || undefined,
      rate: speed,
      pitch,
      onWord: (_word: string, _idx: number, start: number, end: number) => {
        // Map character index to word index
        const before = chunks[chunkIdx].slice(0, start);
        const wordCount = before.split(/\s+/).filter(w => w.length > 0).length;
        dispatch(setCurrentWord(wordCount));
        setHighlightedWord(wordCount);
      },
      onChunkEnd: () => {
        const next = chunkIdx + 1;
        if (next < chunks.length) {
          dispatch(setCurrentChunk(next));
          speakChunk(next);
        } else {
          dispatch(setPlaying(false));
          dispatch(setCurrentWord(0));
        }
      },
      onError: (err: Error) => {
        console.error('TTS error:', err);
        dispatch(setPaused(true));
      },
    };

    if (voiceMode === 'edge') {
      TTSService.speakWithEdge(text, opts).catch(() =>
        TTSService.speakWithSystem(text, opts)
      );
    } else {
      TTSService.speakWithSystem(text, opts);
    }
  }

  function stopSpeaking() {
    TTSService.stop();
    dispatch(setPlaying(false));
  }

  function pauseSpeaking() {
    TTSService.pause();
    dispatch(setPaused(true));
  }

  function resumeSpeaking() {
    TTSService.resume();
    dispatch(setPlaying(true));
  }

  function togglePlayback() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) {
      pauseSpeaking();
    } else if (isPaused) {
      resumeSpeaking();
    } else {
      startReading();
    }
  }

  function goBack() {
    dispatch(setCurrentChunk(Math.max(0, currentChunk - 1)));
    stopSpeaking();
    startReading(Math.max(0, currentChunk - 1));
  }

  function goForward() {
    const next = Math.min(chunks.length - 1, currentChunk + 1);
    dispatch(setCurrentChunk(next));
    stopSpeaking();
    startReading(next);
  }

  // ── Auto-save ──────────────────────────────────────────────
  function startAutoSave() {
    saveTimerRef.current = setInterval(() => saveProgressNow(), 15000);
  }

  function clearAutoSave() {
    if (saveTimerRef.current) {
      clearInterval(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }

  async function saveProgressNow() {
    if (!activeBook || !chunks.length) return;
    const pct = Math.round((currentChunk / chunks.length) * 100);
    await DatabaseService.saveProgress({
      book_id: activeBook.id,
      chunk_index: currentChunk,
      word_index: highlightedWord,
      elapsed_seconds: elapsedSeconds,
      percent: pct,
    });
  }

  // ── Claude AI ──────────────────────────────────────────────
  async function askClaude() {
    if (!claudeQuery.trim() || !settings.claudeKey) return;
    setClaudeLoading(true);
    try {
      const context = chunks[currentChunk] ?? '';
      const answer = await ClaudeService.ask(settings.claudeKey, claudeQuery, context);
      setClaudeResponse(answer);
    } catch (err) {
      setClaudeResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClaudeLoading(false);
    }
  }

  // ── PDF mode ───────────────────────────────────────────────
  if (pdfSource && activeBook?.format === 'pdf') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <PdfHeader title={activeBook.title} onClose={() => navigation.goBack()} />
        <Pdf
          source={pdfSource}
          style={styles.pdf}
          onError={(err) => Alert.alert('PDF Error', String(err))}
          enablePaging={true}
          fitPolicy={0}
          horizontal={false}
          trustAllCerts={false}
        />
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.gold} />
          <Text style={styles.loadingText}>Loading book...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const progressPercent = chunks.length > 0
    ? Math.round((currentChunk / chunks.length) * 100) : 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => { stopSpeaking(); navigation.goBack(); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-down" size={24} color={Colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>{activeBook?.title}</Text>
          <Text style={styles.headerProgress}>{progressPercent}% · {currentChunk + 1}/{chunks.length}</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => setShowClaudePanel(true)}
            style={[styles.headerBtn, !!settings.claudeKey && styles.headerBtnActive]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="sparkles-outline" size={18} color={settings.claudeKey ? Colors.gold : Colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowVoicePanel(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="options-outline" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── PROGRESS BAR ── */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
      </View>

      {/* ── READER CONTENT ── */}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: 20 },
        ]}
        showsVerticalScrollIndicator={false}
        onTouchEnd={() => setShowControls(s => !s)}
      >
        <WordRenderer
          words={currentWords}
          highlightedIndex={highlightedWord}
          fontSize={settings.readerFontSize}
          lineHeight={settings.readerLineHeight}
          fontFamily={settings.readerFont === 'serif' ? 'Georgia' : 'System'}
        />
      </ScrollView>

      {/* ── PLAYER CONTROLS ── */}
      {showControls && (
        <View style={styles.controlsBar}>
          {/* Waveform / progress mini display */}
          <View style={styles.waveRow}>
            {Array.from({ length: 30 }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.waveBar,
                  {
                    height: 4 + Math.random() * 18,
                    backgroundColor: i < (progressPercent / 100) * 30
                      ? Colors.gold : Colors.waveInactive,
                  },
                ]}
              />
            ))}
          </View>

          {/* Playback row */}
          <View style={styles.playRow}>
            <SpeedBtn value={0.75} current={speed} onPress={() => dispatch(setSpeed(0.75))} />
            <SpeedBtn value={1.0} current={speed} onPress={() => dispatch(setSpeed(1.0))} />
            <SpeedBtn value={1.25} current={speed} onPress={() => dispatch(setSpeed(1.25))} />
            <SpeedBtn value={1.5} current={speed} onPress={() => dispatch(setSpeed(1.5))} />
            <SpeedBtn value={2.0} current={speed} onPress={() => dispatch(setSpeed(2.0))} />
          </View>

          <View style={styles.mainButtons}>
            <ControlBtn icon="play-skip-back" onPress={goBack} />
            <ControlBtn icon="skip-back" onPress={() => { dispatch(setCurrentChunk(Math.max(0, currentChunk - 1))); }} />
            <TouchableOpacity style={styles.playBtn} onPress={togglePlayback}>
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={28}
                color={Colors.textInverse}
              />
            </TouchableOpacity>
            <ControlBtn icon="skip-forward" onPress={() => { dispatch(setCurrentChunk(Math.min(chunks.length - 1, currentChunk + 1))); }} />
            <ControlBtn icon="play-skip-forward" onPress={goForward} />
          </View>
        </View>
      )}

      {/* ── VOICE PANEL MODAL ── */}
      <VoicePanel
        visible={showVoicePanel}
        speed={speed}
        pitch={pitch}
        onSpeedChange={v => dispatch(setSpeed(v))}
        onPitchChange={v => dispatch(setPitch(v))}
        onClose={() => setShowVoicePanel(false)}
      />

      {/* ── CLAUDE PANEL MODAL ── */}
      <Modal visible={showClaudePanel} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.claudePanel}
        >
          <View style={styles.claudeCard}>
            <View style={styles.claudeHeader}>
              <Ionicons name="sparkles" size={16} color={Colors.gold} />
              <Text style={styles.claudeTitle}>Claude AI</Text>
              <TouchableOpacity onPress={() => setShowClaudePanel(false)}>
                <Ionicons name="close" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>

            {!settings.claudeKey && (
              <Text style={styles.claudeNoKey}>
                Add your Claude API key in Settings to use AI features.
              </Text>
            )}

            {claudeResponse ? (
              <ScrollView style={styles.claudeResponse} showsVerticalScrollIndicator={false}>
                <Text style={styles.claudeResponseText}>{claudeResponse}</Text>
              </ScrollView>
            ) : null}

            <View style={styles.claudeInputRow}>
              <TextInput
                style={styles.claudeInput}
                placeholder="Ask about this passage..."
                placeholderTextColor={Colors.textMuted}
                value={claudeQuery}
                onChangeText={setClaudeQuery}
                multiline
                returnKeyType="send"
              />
              <TouchableOpacity
                style={[styles.claudeSend, (!claudeQuery || claudeLoading) && styles.claudeSendDisabled]}
                onPress={askClaude}
                disabled={!claudeQuery || claudeLoading || !settings.claudeKey}
              >
                {claudeLoading
                  ? <ActivityIndicator size="small" color={Colors.textInverse} />
                  : <Ionicons name="send" size={16} color={Colors.textInverse} />
                }
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── WordRenderer — word-by-word TTS highlighting ────────────
function WordRenderer({
  words, highlightedIndex, fontSize, lineHeight, fontFamily,
}: {
  words: string[];
  highlightedIndex: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}) {
  return (
    <Text style={{ lineHeight: fontSize * lineHeight }}>
      {words.map((word, i) => (
        <Text
          key={i}
          style={[
            styles.word,
            { fontSize, fontFamily },
            i === highlightedIndex && styles.wordHighlighted,
            i < highlightedIndex && styles.wordRead,
          ]}
        >
          {word}{' '}
        </Text>
      ))}
    </Text>
  );
}

// ── Sub-components ───────────────────────────────────────────
function PdfHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={styles.pdfHeader}>
      <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="chevron-down" size={24} color={Colors.textSecondary} />
      </TouchableOpacity>
      <Text style={styles.pdfHeaderTitle} numberOfLines={1}>{title}</Text>
      <View style={{ width: 24 }} />
    </View>
  );
}

function ControlBtn({ icon, onPress }: { icon: any; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.controlBtn} onPress={onPress}>
      <Ionicons name={icon} size={22} color={Colors.textSecondary} />
    </TouchableOpacity>
  );
}

function SpeedBtn({ value, current, onPress }: { value: number; current: number; onPress: () => void }) {
  const active = Math.abs(value - current) < 0.01;
  return (
    <TouchableOpacity
      style={[styles.speedBtn, active && styles.speedBtnActive]}
      onPress={onPress}
    >
      <Text style={[styles.speedText, active && styles.speedTextActive]}>
        {value}×
      </Text>
    </TouchableOpacity>
  );
}

function VoicePanel({
  visible, speed, pitch, onSpeedChange, onPitchChange, onClose,
}: {
  visible: boolean;
  speed: number;
  pitch: number;
  onSpeedChange: (v: number) => void;
  onPitchChange: (v: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity style={styles.voiceOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.voicePanel} activeOpacity={1} onPress={() => {}}>
          <View style={styles.voicePanelHandle} />
          <Text style={styles.voicePanelTitle}>Reader Settings</Text>

          <SliderRow
            label="Speed"
            value={speed}
            min={0.5} max={3.0} step={0.25}
            display={`${speed}×`}
            onChange={onSpeedChange}
          />
          <SliderRow
            label="Pitch"
            value={pitch}
            min={0.5} max={2.0} step={0.1}
            display={pitch.toFixed(1)}
            onChange={onPitchChange}
          />

          <TouchableOpacity style={styles.voiceCloseBtn} onPress={onClose}>
            <Text style={styles.voiceCloseBtnText}>Done</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function SliderRow({
  label, value, min, max, step, display, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <View style={styles.sliderRow}>
      <Text style={styles.sliderLabel}>{label}</Text>
      <View style={styles.sliderControls}>
        <TouchableOpacity
          onPress={() => onChange(Math.max(min, Math.round((value - step) * 100) / 100))}
          style={styles.sliderBtn}
        >
          <Ionicons name="remove" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.sliderValue}>{display}</Text>
        <TouchableOpacity
          onPress={() => onChange(Math.min(max, Math.round((value + step) * 100) / 100))}
          style={styles.sliderBtn}
        >
          <Ionicons name="add" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function cleanTextForTTS(text: string, skipChars: string, skipWords: string): string {
  let clean = text;
  if (skipChars) {
    const escaped = skipChars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp(`[${escaped}]`, 'g'), '');
  }
  if (skipWords) {
    for (const word of skipWords.split(',').map(w => w.trim()).filter(Boolean)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
    }
  }
  return clean.replace(/\s+/g, ' ').trim();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  loadingText: { color: Colors.textSecondary, fontSize: 15 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 10 },
  headerTitle: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  headerProgress: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerBtn: { padding: 4, borderRadius: 6 },
  headerBtnActive: { backgroundColor: Colors.goldAlpha },
  progressTrack: { height: 2, backgroundColor: Colors.border },
  progressFill: { height: 2, backgroundColor: Colors.gold },
  scroll: { flex: 1 },
  scrollContent: { paddingVertical: 24, paddingBottom: 200 },
  word: { color: Colors.textPrimary, fontWeight: '400' },
  wordHighlighted: { color: Colors.gold, backgroundColor: Colors.goldAlpha2, borderRadius: 2 },
  wordRead: { color: Colors.textMuted },
  controlsBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.bgCard + 'ee',
    paddingBottom: 30, paddingTop: 12, paddingHorizontal: 16,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  waveRow: {
    flexDirection: 'row', alignItems: 'flex-end', height: 28, gap: 2,
    marginBottom: 12, justifyContent: 'center',
  },
  waveBar: { width: 3, borderRadius: 1.5, opacity: 0.8 },
  playRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 14 },
  mainButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  playBtn: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: Colors.gold, alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.gold, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  controlBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  speedBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  speedBtnActive: { backgroundColor: Colors.goldAlpha, borderColor: Colors.gold },
  speedText: { fontSize: 12, color: Colors.textMuted, fontWeight: '500' },
  speedTextActive: { color: Colors.gold },
  voiceOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: Colors.overlay },
  voicePanel: {
    backgroundColor: Colors.bgCard, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingBottom: 40, paddingTop: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  voicePanelHandle: {
    width: 40, height: 4, backgroundColor: Colors.border,
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  voicePanelTitle: { fontSize: 17, fontWeight: '600', color: Colors.textPrimary, marginBottom: 20 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sliderLabel: { fontSize: 15, color: Colors.textSecondary },
  sliderControls: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  sliderBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bgSurface, borderRadius: 8 },
  sliderValue: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600', minWidth: 50, textAlign: 'center' },
  voiceCloseBtn: {
    backgroundColor: Colors.gold, borderRadius: 10, paddingVertical: 13,
    alignItems: 'center', marginTop: 8,
  },
  voiceCloseBtnText: { color: Colors.textInverse, fontSize: 16, fontWeight: '600' },
  pdf: { flex: 1, backgroundColor: Colors.bg },
  pdfHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  pdfHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600', color: Colors.textPrimary, paddingHorizontal: 8 },
  claudePanel: { flex: 1, justifyContent: 'flex-end' },
  claudeCard: {
    backgroundColor: Colors.bgCard, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 16, paddingBottom: 30, maxHeight: '60%',
    borderWidth: 1, borderColor: Colors.border,
  },
  claudeHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  claudeTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  claudeNoKey: { fontSize: 13, color: Colors.textMuted, marginBottom: 12, fontStyle: 'italic' },
  claudeResponse: { maxHeight: 150, marginBottom: 12 },
  claudeResponseText: { fontSize: 14, color: Colors.textPrimary, lineHeight: 20 },
  claudeInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  claudeInput: {
    flex: 1, backgroundColor: Colors.bgInput, borderRadius: 10, borderWidth: 1,
    borderColor: Colors.border, color: Colors.textPrimary, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 14, maxHeight: 80,
  },
  claudeSend: {
    width: 40, height: 40, borderRadius: 10, backgroundColor: Colors.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  claudeSendDisabled: { opacity: 0.4 },
});
