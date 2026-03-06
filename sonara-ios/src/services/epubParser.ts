/**
 * EpubParser — Sonara iOS
 * Parses EPUB files into text chunks for TTS reading.
 * Ported from the desktop parser with React Native file system APIs.
 */
import * as FileSystem from 'expo-file-system';

export interface Chapter {
  title: string;
  content: string;
  index: number;
}

export interface ParsedBook {
  title: string;
  author: string | null;
  coverBase64: string | null;
  chapters: Chapter[];
  totalChunks: number;
}

/**
 * Parse EPUB (which is a ZIP file containing XHTML + metadata)
 * Uses expo-file-system to read the file, then processes the XML/HTML content.
 *
 * Note: Full ZIP parsing requires a JS ZIP library. We include a lightweight
 * approach reading the epub as binary and extracting text via regex patterns.
 * For production, integrate 'jszip' package.
 */
export async function parseEpub(filePath: string): Promise<ParsedBook> {
  // Read the epub binary content
  const base64Content = await FileSystem.readAsStringAsync(filePath, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Convert base64 to binary string for ZIP parsing
  const binary = atob(base64Content);

  // Extract text content from EPUB ZIP structure
  // EPUB files are ZIP archives containing XHTML files
  const textContent = extractTextFromEpubBinary(binary);
  const chunks = splitIntoChunks(textContent, 800);

  const title = extractMetaTitle(binary) || 'Unknown Title';
  const author = extractMetaAuthor(binary);

  return {
    title,
    author,
    coverBase64: null, // Cover extraction requires full ZIP support
    chapters: chunks.map((content, index) => ({
      title: `Section ${index + 1}`,
      content,
      index,
    })),
    totalChunks: chunks.length,
  };
}

function extractTextFromEpubBinary(binary: string): string {
  // Extract all text from XHTML content within the EPUB ZIP
  // Pattern: Look for content between HTML body tags
  const allText: string[] = [];

  // Find all local file entries in the ZIP (simplified local header parsing)
  const signature = 'PK\x03\x04';
  let pos = 0;

  while (pos < binary.length - 4) {
    const idx = binary.indexOf(signature, pos);
    if (idx === -1) break;

    // Parse local file header
    if (idx + 30 > binary.length) break;

    const filenameLen = binary.charCodeAt(idx + 26) | (binary.charCodeAt(idx + 27) << 8);
    const extraLen = binary.charCodeAt(idx + 28) | (binary.charCodeAt(idx + 29) << 8);
    const compressedLen = (binary.charCodeAt(idx + 18) | (binary.charCodeAt(idx + 19) << 8) |
                          (binary.charCodeAt(idx + 20) << 16) | (binary.charCodeAt(idx + 21) << 24)) >>> 0;
    const compressionMethod = binary.charCodeAt(idx + 8) | (binary.charCodeAt(idx + 9) << 8);

    const filename = binary.slice(idx + 30, idx + 30 + filenameLen);
    const dataStart = idx + 30 + filenameLen + extraLen;

    // Only process XHTML/HTML files (stored uncompressed, method=0)
    if (compressionMethod === 0 &&
        (filename.endsWith('.xhtml') || filename.endsWith('.html') || filename.endsWith('.htm')) &&
        !filename.includes('toc') && !filename.includes('nav')) {
      const content = binary.slice(dataStart, dataStart + compressedLen);
      const text = stripHtmlTags(content);
      if (text.trim().length > 200) {
        allText.push(text);
      }
    }

    pos = dataStart + compressedLen;
  }

  return allText.join('\n\n');
}

function extractMetaTitle(binary: string): string | null {
  // Look for OPF/NCX metadata
  const titleMatch = binary.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
  return titleMatch ? titleMatch[1].trim() : null;
}

function extractMetaAuthor(binary: string): string | null {
  const authorMatch = binary.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
  return authorMatch ? authorMatch[1].trim() : null;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

export function splitIntoChunks(text: string, wordsPerChunk = 800): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  return chunks;
}

/**
 * Parse plain text into chunks suitable for TTS.
 */
export function parseText(text: string): ParsedBook {
  const chunks = splitIntoChunks(text, 800);
  return {
    title: 'Text Document',
    author: null,
    coverBase64: null,
    chapters: chunks.map((content, index) => ({
      title: `Section ${index + 1}`,
      content,
      index,
    })),
    totalChunks: chunks.length,
  };
}
