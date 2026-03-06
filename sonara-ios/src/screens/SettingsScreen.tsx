import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Switch, Alert, ActivityIndicator, Modal,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import * as Haptics from 'expo-haptics';

import { RootState, AppDispatch } from '../store';
import { loadSettings, saveSetting, setTheme, setReaderFont, setReaderFontSize, setClaudeKey } from '../store/settingsSlice';
import { setVoice } from '../store/playerSlice';
import { Colors } from '../theme/colors';
import { TTSService, VoiceInfo } from '../services/ttsService';
import { DatabaseService } from '../services/database';

const THEMES = [
  { id: 'black', label: 'Black', bg: '#0a0a0f', text: '#e8e8f0', accent: '#c8a96e' },
  { id: 'night', label: 'Night', bg: '#0f1117', text: '#e8e8f0', accent: '#7c9cbf' },
  { id: 'warm', label: 'Warm', bg: '#1a1206', text: '#f0e8d8', accent: '#e8a44a' },
  { id: 'sepia', label: 'Sepia', bg: '#f4f0e8', text: '#3c3020', accent: '#8b6914' },
] as const;

const FONT_OPTIONS = [
  { id: 'serif', label: 'Serif', family: 'Georgia' },
  { id: 'sans', label: 'Sans', family: 'System' },
  { id: 'mono', label: 'Mono', family: 'Courier New' },
] as const;

export default function SettingsScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const settings = useSelector((s: RootState) => s.settings);
  const { voiceId, voiceMode } = useSelector((s: RootState) => s.player);

  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [claudeKeyInput, setClaudeKeyInput] = useState('');
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [dbPath, setDbPath] = useState('');

  useEffect(() => {
    dispatch(loadSettings());
    DatabaseService.getSetting('db_path', '').then(p => setDbPath(p || 'Default location'));
  }, [dispatch]);

  useEffect(() => {
    setClaudeKeyInput(settings.claudeKey);
  }, [settings.claudeKey]);

  async function loadVoices() {
    setLoadingVoices(true);
    try {
      const all = await TTSService.getAllVoices();
      setVoices(all);
    } catch (err) {
      console.error('Failed to load voices:', err);
    } finally {
      setLoadingVoices(false);
    }
  }

  const openVoicePicker = () => {
    if (!voices.length) loadVoices();
    setShowVoicePicker(true);
  };

  const selectVoice = async (voice: VoiceInfo) => {
    dispatch(setVoice({ voiceId: voice.id, voiceMode: voice.mode }));
    await DatabaseService.setSetting('voiceId', voice.id);
    await DatabaseService.setSetting('voiceMode', voice.mode);
    setShowVoicePicker(false);
  };

  const saveTheme = async (themeId: typeof THEMES[number]['id']) => {
    Haptics.selectionAsync();
    dispatch(setTheme(themeId));
    await DatabaseService.setSetting('theme', themeId);
  };

  const saveFont = async (fontId: typeof FONT_OPTIONS[number]['id']) => {
    dispatch(setReaderFont(fontId));
    await DatabaseService.setSetting('readerFont', fontId);
  };

  const saveFontSize = async (delta: number) => {
    const newSize = Math.max(12, Math.min(28, settings.readerFontSize + delta));
    dispatch(setReaderFontSize(newSize));
    await DatabaseService.setSetting('readerFontSize', String(newSize));
  };

  const saveClaudeKey = async () => {
    const key = claudeKeyInput.trim();
    if (key && !key.startsWith('sk-ant')) {
      Alert.alert('Invalid Key', 'Claude API keys should start with sk-ant-');
      return;
    }
    dispatch(setClaudeKey(key));
    await DatabaseService.setSetting('claude_key', key);
    Alert.alert('Saved', key ? 'Claude AI enabled!' : 'API key cleared.');
  };

  const filteredVoices = voiceSearch
    ? voices.filter(v =>
        v.name.toLowerCase().includes(voiceSearch.toLowerCase()) ||
        v.language.toLowerCase().includes(voiceSearch.toLowerCase())
      )
    : voices;

  const currentVoice = voices.find(v => v.id === voiceId);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.appVersion}>Sonara v2.0.0</Text>
        </View>

        {/* ── APPEARANCE ── */}
        <SettingSection title="Appearance">
          <Text style={styles.settingLabel}>Theme</Text>
          <View style={styles.themeRow}>
            {THEMES.map(theme => (
              <TouchableOpacity
                key={theme.id}
                style={[
                  styles.themeChip,
                  { backgroundColor: theme.bg, borderColor: theme.accent },
                  settings.theme === theme.id && styles.themeChipActive,
                ]}
                onPress={() => saveTheme(theme.id)}
              >
                <Text style={[styles.themeChipText, { color: theme.text }]}>
                  {theme.label}
                </Text>
                {settings.theme === theme.id && (
                  <View style={[styles.themeCheck, { backgroundColor: theme.accent }]}>
                    <Ionicons name="checkmark" size={10} color="#000" />
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Font</Text>
            <View style={styles.fontRow}>
              {FONT_OPTIONS.map(f => (
                <TouchableOpacity
                  key={f.id}
                  style={[styles.fontChip, settings.readerFont === f.id && styles.fontChipActive]}
                  onPress={() => saveFont(f.id)}
                >
                  <Text style={[styles.fontChipText, settings.readerFont === f.id && styles.fontChipTextActive, { fontFamily: f.family }]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Font Size</Text>
            <View style={styles.stepper}>
              <TouchableOpacity onPress={() => saveFontSize(-1)} style={styles.stepperBtn}>
                <Ionicons name="remove" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              <Text style={styles.stepperValue}>{settings.readerFontSize}px</Text>
              <TouchableOpacity onPress={() => saveFontSize(1)} style={styles.stepperBtn}>
                <Ionicons name="add" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
        </SettingSection>

        {/* ── VOICE / TTS ── */}
        <SettingSection title="Voice & TTS">
          <TouchableOpacity style={styles.voiceSelector} onPress={openVoicePicker}>
            <View>
              <Text style={styles.settingLabel}>Voice</Text>
              <Text style={styles.voiceName}>
                {currentVoice
                  ? `${currentVoice.name} (${currentVoice.quality})`
                  : 'Default system voice'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
          </TouchableOpacity>

          <View style={styles.settingNote}>
            <Ionicons name="information-circle-outline" size={14} color={Colors.textMuted} />
            <Text style={styles.settingNoteText}>
              Edge TTS voices require internet. Neural = Microsoft, Local = iOS built-in.
            </Text>
          </View>
        </SettingSection>

        {/* ── CLAUDE AI ── */}
        <SettingSection title="Claude AI">
          <Text style={styles.settingLabel}>API Key</Text>
          <View style={styles.claudeRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="sk-ant-..."
              placeholderTextColor={Colors.textMuted}
              value={claudeKeyInput}
              onChangeText={setClaudeKeyInput}
              secureTextEntry={!showClaudeKey}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => setShowClaudeKey(s => !s)}
              style={styles.eyeBtn}
            >
              <Ionicons
                name={showClaudeKey ? 'eye-off-outline' : 'eye-outline'}
                size={18}
                color={Colors.textMuted}
              />
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.saveBtn} onPress={saveClaudeKey}>
            <Text style={styles.saveBtnText}>Save API Key</Text>
          </TouchableOpacity>
          <Text style={styles.settingNote2}>
            Claude AI powers Q&A and explanations while reading. Get your key at console.anthropic.com
          </Text>
        </SettingSection>

        {/* ── ABOUT ── */}
        <SettingSection title="About">
          <View style={styles.aboutRow}>
            <Ionicons name="musical-notes" size={24} color={Colors.gold} />
            <View>
              <Text style={styles.aboutName}>Sonara</Text>
              <Text style={styles.aboutVersion}>Version 2.0.0 · iOS Edition</Text>
            </View>
          </View>
          <Text style={styles.aboutDesc}>
            Professional audiobook player with PDF highlighting, TTS, collections, and Claude AI.
            Fully offline-capable — your data stays on your device.
          </Text>
        </SettingSection>

      </ScrollView>

      {/* ── VOICE PICKER MODAL ── */}
      <Modal visible={showVoicePicker} animationType="slide">
        <SafeAreaView style={styles.voiceModalContainer} edges={['top']}>
          <View style={styles.voiceModalHeader}>
            <Text style={styles.voiceModalTitle}>Select Voice</Text>
            <TouchableOpacity onPress={() => setShowVoicePicker(false)}>
              <Ionicons name="close" size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.voiceSearchWrap}>
            <Ionicons name="search" size={15} color={Colors.textMuted} />
            <TextInput
              style={styles.voiceSearch}
              placeholder="Search voices..."
              placeholderTextColor={Colors.textMuted}
              value={voiceSearch}
              onChangeText={setVoiceSearch}
            />
          </View>

          {loadingVoices ? (
            <View style={styles.voiceLoading}>
              <ActivityIndicator color={Colors.gold} />
              <Text style={styles.voiceLoadingText}>Loading voices...</Text>
            </View>
          ) : (
            <FlatList
              data={filteredVoices}
              keyExtractor={v => v.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.voiceItem, voiceId === item.id && styles.voiceItemActive]}
                  onPress={() => selectVoice(item)}
                >
                  <View style={styles.voiceItemLeft}>
                    <Text style={styles.voiceItemName}>{item.name}</Text>
                    <Text style={styles.voiceItemLang}>{item.language}</Text>
                  </View>
                  <View style={styles.voiceItemRight}>
                    <View style={[
                      styles.qualityTag,
                      item.quality === 'neural' && styles.qualityTagNeural,
                    ]}>
                      <Text style={styles.qualityTagText}>
                        {item.quality === 'neural' ? '✦ Neural' : 'Local'}
                      </Text>
                    </View>
                    {voiceId === item.id && (
                      <Ionicons name="checkmark-circle" size={18} color={Colors.gold} />
                    )}
                  </View>
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={styles.voiceDivider} />}
              showsVerticalScrollIndicator={false}
            />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  header: { paddingTop: 8, paddingBottom: 20 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: Colors.textPrimary },
  appVersion: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: Colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, paddingLeft: 4,
  },
  sectionCard: {
    backgroundColor: Colors.bgCard, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 14,
  },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingLabel: { fontSize: 15, color: Colors.textSecondary, marginBottom: 8 },
  themeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  themeChip: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, position: 'relative',
  },
  themeChipActive: { borderWidth: 2 },
  themeChipText: { fontSize: 13, fontWeight: '500' },
  themeCheck: {
    position: 'absolute', top: -4, right: -4,
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  fontRow: { flexDirection: 'row', gap: 8 },
  fontChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgInput,
  },
  fontChipActive: { backgroundColor: Colors.goldAlpha, borderColor: Colors.gold },
  fontChipText: { fontSize: 14, color: Colors.textMuted },
  fontChipTextActive: { color: Colors.gold },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperBtn: {
    width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.bgSurface, borderRadius: 8,
  },
  stepperValue: { fontSize: 15, color: Colors.textPrimary, fontWeight: '600', minWidth: 46, textAlign: 'center' },
  voiceSelector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  voiceName: { fontSize: 13, color: Colors.textMuted, marginTop: 2 },
  settingNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: -6 },
  settingNoteText: { flex: 1, fontSize: 12, color: Colors.textMuted, lineHeight: 16 },
  claudeRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    backgroundColor: Colors.bgInput, borderRadius: 8, borderWidth: 1, borderColor: Colors.border,
    color: Colors.textPrimary, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  eyeBtn: { padding: 10 },
  saveBtn: {
    backgroundColor: Colors.gold, borderRadius: 8, paddingVertical: 11,
    alignItems: 'center', marginTop: 2,
  },
  saveBtnText: { color: Colors.textInverse, fontWeight: '600', fontSize: 15 },
  settingNote2: { fontSize: 12, color: Colors.textMuted, lineHeight: 16 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  aboutName: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  aboutVersion: { fontSize: 12, color: Colors.textMuted },
  aboutDesc: { fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  voiceModalContainer: { flex: 1, backgroundColor: Colors.bg },
  voiceModalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  voiceModalTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  voiceSearchWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgInput,
    borderRadius: 10, margin: 12, paddingHorizontal: 12, height: 40,
    borderWidth: 1, borderColor: Colors.border, gap: 8,
  },
  voiceSearch: { flex: 1, color: Colors.textPrimary, fontSize: 14 },
  voiceLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  voiceLoadingText: { color: Colors.textMuted, fontSize: 14 },
  voiceItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  voiceItemActive: { backgroundColor: Colors.goldAlpha },
  voiceItemLeft: { flex: 1 },
  voiceItemName: { fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  voiceItemLang: { fontSize: 12, color: Colors.textMuted, marginTop: 2 },
  voiceItemRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qualityTag: {
    backgroundColor: Colors.bgSurface, borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  qualityTagNeural: { backgroundColor: Colors.goldAlpha },
  qualityTagText: { fontSize: 11, color: Colors.textMuted, fontWeight: '600' },
  voiceDivider: { height: 1, backgroundColor: Colors.border, marginLeft: 16 },
});
