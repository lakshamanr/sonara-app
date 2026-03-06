import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, Gradients } from '../theme/colors';
import { Book } from '../services/database';

interface BookCardProps {
  book: Book;
  width: number;
  onPress: () => void;
  onLongPress: () => void;
}

const FORMAT_COLOR: Record<string, string> = {
  pdf: '#e05c5c',
  epub: '#5c9ce0',
  mp3: '#4caf87',
  m4b: '#4caf87',
  m4a: '#4caf87',
  ogg: '#4caf87',
};

const FORMAT_ICON: Record<string, string> = {
  pdf: '📄',
  epub: '📚',
  mp3: '🎵',
  m4b: '🎧',
  m4a: '🎵',
  ogg: '🎵',
};

export default function BookCard({ book, width, onPress, onLongPress }: BookCardProps) {
  const height = width * 1.45;
  const statusColor = book.status === 'reading' ? Colors.gold
    : book.status === 'done' ? Colors.success : 'transparent';

  const gradientColors = useMemo(() => {
    // Generate deterministic gradient from book ID
    const hash = book.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const hue = hash % 360;
    return [`hsl(${hue}, 30%, 15%)`, `hsl(${(hue + 40) % 360}, 25%, 10%)`] as [string, string];
  }, [book.id]);

  return (
    <TouchableOpacity
      style={[styles.card, { width, height }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.85}
      delayLongPress={400}
    >
      {/* Cover */}
      {book.cover_path ? (
        <Image
          source={{ uri: book.cover_path }}
          style={styles.coverImage}
          resizeMode="cover"
        />
      ) : (
        <LinearGradient colors={gradientColors} style={styles.coverGrad}>
          <Text style={styles.bookEmoji}>{FORMAT_ICON[book.format] ?? '📖'}</Text>
          <Text style={styles.placeholderTitle} numberOfLines={3}>
            {book.title}
          </Text>
        </LinearGradient>
      )}

      {/* Overlay info */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.85)']}
        style={styles.overlay}
      >
        <View style={styles.formatBadge}>
          <Text style={[styles.formatText, { color: FORMAT_COLOR[book.format] ?? Colors.textSecondary }]}>
            {book.format.toUpperCase()}
          </Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>{book.title}</Text>
        {book.author && (
          <Text style={styles.author} numberOfLines={1}>{book.author}</Text>
        )}
      </LinearGradient>

      {/* Status indicator */}
      {book.status !== 'unstarted' && (
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      )}

      {/* Reading progress bar */}
      {book.status === 'reading' && (
        <View style={styles.progressBar}>
          <View style={styles.progressFill} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: Colors.bgCard,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
  },
  coverImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  coverGrad: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  bookEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  placeholderTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 14,
  },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 8,
    paddingTop: 24,
  },
  formatBadge: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  formatText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textPrimary,
    lineHeight: 14,
  },
  author: {
    fontSize: 10,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  statusDot: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  progressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: Colors.bgCard,
  },
  progressFill: {
    width: '40%',
    height: '100%',
    backgroundColor: Colors.gold,
  },
});
