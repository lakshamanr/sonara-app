import React, { useEffect, useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, RefreshControl, Alert, Dimensions, ActivityIndicator,
  ScrollView, Modal, ActionSheetIOS, Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';

import { RootState, AppDispatch } from '../store';
import {
  loadLibrary, importBooks, deleteBook,
  setSearchQuery, setActiveFormat, setActiveCollection, setSortBy,
  selectFilteredBooks, createCollection,
} from '../store/librarySlice';
import { openBook } from '../store/playerSlice';
import { Colors } from '../theme/colors';
import { Typography } from '../theme/styles';
import BookCard from '../components/BookCard';
import { Book, Collection } from '../services/database';
import { RootStackParamList } from '../navigation/AppNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_COLS = SCREEN_W > 600 ? 4 : 3;
const CARD_MARGIN = 10;
const CARD_W = (SCREEN_W - CARD_MARGIN * (CARD_COLS + 1)) / CARD_COLS;

export default function LibraryScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const { books, collections, loading, searchQuery, activeFormat, activeCollection, sortBy } =
    useSelector((s: RootState) => s.library);
  const filteredBooks = useSelector(selectFilteredBooks);

  const [refreshing, setRefreshing] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [contextBook, setContextBook] = useState<Book | null>(null);

  useEffect(() => {
    dispatch(loadLibrary());
  }, [dispatch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await dispatch(loadLibrary());
    setRefreshing(false);
  }, [dispatch]);

  const handleImport = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dispatch(importBooks());
  }, [dispatch]);

  const handleBookPress = useCallback((book: Book) => {
    const isAudio = ['mp3', 'm4b', 'm4a', 'ogg'].includes(book.format);
    dispatch(openBook({ book, mode: isAudio ? 'audio' : 'tts' }));
    navigation.navigate('Reader', { bookId: book.id });
  }, [dispatch, navigation]);

  const handleBookLongPress = useCallback((book: Book) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setContextBook(book);
  }, []);

  const handleDeleteBook = useCallback((book: Book) => {
    Alert.alert(
      'Remove Book',
      `Remove "${book.title}" from your library? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: () => dispatch(deleteBook(book)),
        },
      ]
    );
    setContextBook(null);
  }, [dispatch]);

  const handleCreateCollection = useCallback(async () => {
    if (!newCollectionName.trim()) return;
    await dispatch(createCollection({ name: newCollectionName.trim(), color: '#c8a96e' }));
    setNewCollectionName('');
    setShowNewCollection(false);
  }, [dispatch, newCollectionName]);

  const AUDIO_FORMATS = ['mp3', 'm4b', 'm4a', 'ogg'];
  const stats = {
    total: books.length,
    reading: books.filter(b => b.status === 'reading').length,
    done: books.filter(b => b.status === 'done').length,
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* ── HEADER ── */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.logoRow}>
            <Ionicons name="musical-notes" size={20} color={Colors.gold} />
            <Text style={styles.logoText}>Sonara</Text>
            <Text style={styles.logoTag}>Audiobook Player</Text>
          </View>
          <TouchableOpacity style={styles.addBtn} onPress={handleImport} activeOpacity={0.8}>
            <Ionicons name="add" size={20} color={Colors.textInverse} />
            <Text style={styles.addBtnText}>Add Book</Text>
          </TouchableOpacity>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <StatBadge label="Total" value={stats.total} />
          <StatBadge label="Reading" value={stats.reading} accent />
          <StatBadge label="Finished" value={stats.done} />
        </View>

        {/* Search */}
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={15} color={Colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search books..."
            placeholderTextColor={Colors.textMuted}
            value={searchQuery}
            onChangeText={t => dispatch(setSearchQuery(t))}
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => dispatch(setSearchQuery(''))} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close-circle" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Format filters */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterRow}
          contentContainerStyle={styles.filterContent}
        >
          {(['all', 'pdf', 'epub', 'audio'] as const).map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, activeFormat === f && styles.filterChipActive]}
              onPress={() => dispatch(setActiveFormat(f))}
            >
              <Text style={[styles.filterChipText, activeFormat === f && styles.filterChipTextActive]}>
                {f === 'all' ? 'All' : f.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}

          <View style={styles.filterDivider} />

          {/* Special collections */}
          {([
            { key: 'all', label: 'All Books' },
            { key: 'recent', label: '🕐 Recent' },
            { key: 'reading', label: '📖 Reading' },
          ] as const).map(c => (
            <TouchableOpacity
              key={c.key}
              style={[styles.filterChip, activeCollection === c.key && styles.filterChipActive]}
              onPress={() => dispatch(setActiveCollection(c.key))}
            >
              <Text style={[styles.filterChipText, activeCollection === c.key && styles.filterChipTextActive]}>
                {c.label}
              </Text>
            </TouchableOpacity>
          ))}

          {/* User collections */}
          {collections.map(col => (
            <TouchableOpacity
              key={col.id}
              style={[styles.filterChip, activeCollection === col.id && styles.filterChipActive]}
              onPress={() => dispatch(setActiveCollection(col.id))}
            >
              <View style={[styles.colDot, { backgroundColor: col.color }]} />
              <Text style={[styles.filterChipText, activeCollection === col.id && styles.filterChipTextActive]}>
                {col.name}
              </Text>
            </TouchableOpacity>
          ))}

          {/* New collection button */}
          <TouchableOpacity
            style={[styles.filterChip, styles.newColChip]}
            onPress={() => setShowNewCollection(true)}
          >
            <Ionicons name="add" size={13} color={Colors.gold} />
            <Text style={[styles.filterChipText, { color: Colors.gold }]}>New</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* ── BOOK GRID ── */}
      {loading && !refreshing ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.gold} />
        </View>
      ) : filteredBooks.length === 0 ? (
        <EmptyLibrary onImport={handleImport} hasBooks={books.length > 0} />
      ) : (
        <FlatList
          data={filteredBooks}
          keyExtractor={b => b.id}
          numColumns={CARD_COLS}
          contentContainerStyle={styles.gridContent}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => (
            <BookCard
              book={item}
              width={CARD_W}
              onPress={() => handleBookPress(item)}
              onLongPress={() => handleBookLongPress(item)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.gold}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* ── NEW COLLECTION MODAL ── */}
      <Modal visible={showNewCollection} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowNewCollection(false)}
        >
          <TouchableOpacity
            style={styles.modalCard}
            activeOpacity={1}
            onPress={() => {}}
          >
            <Text style={styles.modalTitle}>New Collection</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Collection name..."
              placeholderTextColor={Colors.textMuted}
              value={newCollectionName}
              onChangeText={setNewCollectionName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleCreateCollection}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowNewCollection(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={handleCreateCollection}>
                <Text style={styles.modalConfirmText}>Create</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── CONTEXT MENU (book long press) ── */}
      <Modal visible={!!contextBook} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setContextBook(null)}
        >
          <TouchableOpacity style={styles.contextCard} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.contextTitle} numberOfLines={1}>
              {contextBook?.title}
            </Text>
            <View style={styles.separator} />
            <ContextAction
              icon="book-outline"
              label="Open & Read"
              onPress={() => {
                if (contextBook) { handleBookPress(contextBook); setContextBook(null); }
              }}
            />
            <ContextAction
              icon="trash-outline"
              label="Remove from Library"
              destructive
              onPress={() => contextBook && handleDeleteBook(contextBook)}
            />
            <ContextAction
              icon="close"
              label="Cancel"
              onPress={() => setContextBook(null)}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// ── Sub-components ──────────────────────────────────────────

function StatBadge({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <View style={styles.statBadge}>
      <Text style={[styles.statValue, accent && { color: Colors.gold }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function EmptyLibrary({ onImport, hasBooks }: { onImport: () => void; hasBooks: boolean }) {
  return (
    <View style={styles.emptyWrap}>
      <Ionicons name="library-outline" size={64} color={Colors.textMuted} />
      <Text style={styles.emptyTitle}>
        {hasBooks ? 'No books match your filter' : 'Your library is empty'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {hasBooks
          ? 'Try adjusting your search or filter'
          : 'Import PDF, EPUB, or audiobook files to get started'}
      </Text>
      {!hasBooks && (
        <TouchableOpacity style={styles.emptyBtn} onPress={onImport}>
          <Text style={styles.emptyBtnText}>Import Books</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function ContextAction({
  icon, label, onPress, destructive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.contextAction} onPress={onPress}>
      <Ionicons name={icon} size={18} color={destructive ? Colors.error : Colors.textSecondary} />
      <Text style={[styles.contextActionText, destructive && { color: Colors.error }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { paddingHorizontal: 14, paddingBottom: 8, backgroundColor: Colors.bg },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6, paddingBottom: 10 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logoText: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, letterSpacing: 0.3 },
  logoTag: { fontSize: 11, color: Colors.textMuted, marginTop: 2 },
  addBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.gold, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, gap: 5 },
  addBtnText: { color: Colors.textInverse, fontSize: 14, fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 14, marginBottom: 10 },
  statBadge: { alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary },
  statLabel: { fontSize: 11, color: Colors.textMuted, marginTop: 1 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bgInput, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 10, height: 38, marginBottom: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, color: Colors.textPrimary, fontSize: 14 },
  filterRow: { marginBottom: 4 },
  filterContent: { paddingRight: 14, gap: 6, flexDirection: 'row', alignItems: 'center' },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard, flexDirection: 'row', alignItems: 'center', gap: 4 },
  filterChipActive: { backgroundColor: Colors.goldAlpha, borderColor: Colors.gold },
  filterChipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '500' },
  filterChipTextActive: { color: Colors.gold },
  filterDivider: { width: 1, height: 16, backgroundColor: Colors.border, marginHorizontal: 4 },
  colDot: { width: 8, height: 8, borderRadius: 4 },
  newColChip: { borderColor: Colors.gold + '44', borderStyle: 'dashed' },
  gridContent: { padding: CARD_MARGIN },
  gridRow: { justifyContent: 'flex-start', gap: CARD_MARGIN },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: Colors.textPrimary, marginTop: 16, textAlign: 'center' },
  emptySubtitle: { fontSize: 14, color: Colors.textMuted, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { marginTop: 20, backgroundColor: Colors.gold, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  emptyBtnText: { color: Colors.textInverse, fontWeight: '600', fontSize: 15 },
  modalOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'center', alignItems: 'center' },
  modalCard: { backgroundColor: Colors.bgModal, borderRadius: 14, padding: 20, width: 300, borderWidth: 1, borderColor: Colors.border },
  modalTitle: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary, marginBottom: 14 },
  modalInput: { backgroundColor: Colors.bgInput, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, color: Colors.textPrimary, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 16 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  modalCancel: { paddingHorizontal: 16, paddingVertical: 9 },
  modalCancelText: { color: Colors.textSecondary, fontSize: 14 },
  modalConfirm: { backgroundColor: Colors.gold, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  modalConfirmText: { color: Colors.textInverse, fontSize: 14, fontWeight: '600' },
  contextCard: { backgroundColor: Colors.bgModal, borderRadius: 14, padding: 12, width: 280, borderWidth: 1, borderColor: Colors.border },
  contextTitle: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary, paddingHorizontal: 8, paddingVertical: 6 },
  separator: { height: 1, backgroundColor: Colors.border, marginVertical: 6 },
  contextAction: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 12 },
  contextActionText: { fontSize: 15, color: Colors.textPrimary },
});
