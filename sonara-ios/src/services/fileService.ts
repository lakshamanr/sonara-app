/**
 * FileService — Sonara iOS
 * Handles book import, file storage, and cover extraction.
 */
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import 'react-native-get-random-values';

const BOOKS_DIR = FileSystem.documentDirectory + 'books/';
const COVERS_DIR = FileSystem.documentDirectory + 'covers/';

// Simple UUID v4 generator (no external dependency)
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export interface ImportedFile {
  id: string;
  title: string;
  author: string | null;
  format: 'pdf' | 'epub' | 'mp3' | 'm4b' | 'm4a' | 'ogg';
  file_path: string;
  file_name: string;
  file_size: number;
  cover_path: string | null;
  added_at: number;
}

const SUPPORTED_TYPES = [
  'application/pdf',
  'application/epub+zip',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4b',
  'audio/ogg',
  // UTIs for iOS document picker
  'com.adobe.pdf',
  'org.idpf.epub-container',
  'public.mp3',
  'com.apple.m4a-audio',
  'public.mpeg-4-audio',
];

export const FileService = {
  async ensureDirs(): Promise<void> {
    const booksInfo = await FileSystem.getInfoAsync(BOOKS_DIR);
    if (!booksInfo.exists) await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });

    const coversInfo = await FileSystem.getInfoAsync(COVERS_DIR);
    if (!coversInfo.exists) await FileSystem.makeDirectoryAsync(COVERS_DIR, { intermediates: true });
  },

  async pickBooks(): Promise<ImportedFile[]> {
    await this.ensureDirs();

    const result = await DocumentPicker.getDocumentAsync({
      type: SUPPORTED_TYPES,
      multiple: true,
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.length) return [];

    const imported: ImportedFile[] = [];

    for (const asset of result.assets) {
      try {
        const format = detectFormat(asset.name ?? '', asset.mimeType ?? '');
        if (!format) continue;

        const id = generateId();
        const ext = asset.name?.split('.').pop() || format;
        const destPath = BOOKS_DIR + id + '.' + ext;

        // Copy file to permanent storage
        await FileSystem.copyAsync({ from: asset.uri, to: destPath });

        const fileInfo = await FileSystem.getInfoAsync(destPath);
        const fileSize = fileInfo.exists && 'size' in fileInfo ? (fileInfo.size ?? asset.size ?? 0) : (asset.size ?? 0);

        // Extract title from filename
        const title = cleanTitle(asset.name ?? 'Unknown Book');

        imported.push({
          id,
          title,
          author: null,
          format,
          file_path: destPath,
          file_name: asset.name ?? id + '.' + ext,
          file_size: fileSize,
          cover_path: null,
          added_at: Date.now(),
        });
      } catch (err) {
        console.error('Failed to import file:', err);
      }
    }

    return imported;
  },

  async deleteBookFile(filePath: string): Promise<void> {
    try {
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists) await FileSystem.deleteAsync(filePath, { idempotent: true });
    } catch {}
  },

  async saveCover(bookId: string, imageUri: string): Promise<string> {
    await this.ensureDirs();
    const dest = COVERS_DIR + bookId + '.jpg';
    await FileSystem.copyAsync({ from: imageUri, to: dest });
    return dest;
  },

  async getCoverUri(coverPath: string | null): Promise<string | null> {
    if (!coverPath) return null;
    const info = await FileSystem.getInfoAsync(coverPath);
    return info.exists ? coverPath : null;
  },

  getBooksDir: () => BOOKS_DIR,
  getCoversDir: () => COVERS_DIR,
};

function detectFormat(name: string, mimeType: string): ImportedFile['format'] | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = mimeType.toLowerCase();

  if (ext === 'pdf' || mime.includes('pdf')) return 'pdf';
  if (ext === 'epub' || mime.includes('epub')) return 'epub';
  if (ext === 'm4b' || mime.includes('m4b')) return 'm4b';
  if (ext === 'm4a' || mime.includes('m4a')) return 'm4a';
  if (ext === 'mp3' || mime.includes('mp3') || mime.includes('mpeg')) return 'mp3';
  if (ext === 'ogg' || mime.includes('ogg')) return 'ogg';

  return null;
}

function cleanTitle(filename: string): string {
  // Remove extension
  let title = filename.replace(/\.[^/.]+$/, '');
  // Replace underscores and dashes with spaces
  title = title.replace(/[_-]+/g, ' ');
  // Clean up multiple spaces
  title = title.replace(/\s+/g, ' ').trim();
  // Title case first word
  return title.charAt(0).toUpperCase() + title.slice(1);
}
