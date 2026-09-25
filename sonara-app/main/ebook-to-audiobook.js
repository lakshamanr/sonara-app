'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SKIP_CHARS = '*_~#';
const MAX_SEGMENT = 3000;

app.setName('Sonara');
app.on('window-all-closed', event => event.preventDefault());

function usage() {
  console.log('Usage: electron main/ebook-to-audiobook.js <book.pdf|book.epub> [--format mp3|m4b] [--voice M1] [--steps 4|6|8]');
}

function args() {
  const values = process.argv.slice(2);
  const input = values.find(value => !value.startsWith('--'));
  const formatAt = values.indexOf('--format');
  const voiceAt = values.indexOf('--voice');
  const stepsAt = values.indexOf('--steps');
  const format = formatAt >= 0 ? values[formatAt + 1] : 'm4b';
  const voice = voiceAt >= 0 ? values[voiceAt + 1] : 'M1';
  const steps = stepsAt >= 0 ? Number(values[stepsAt + 1]) : 6;
  if (!input || !['mp3', 'm4b'].includes(format) || !/^[A-Z]\d$/.test(voice) || ![4, 6, 8].includes(steps)) return null;
  return { input: path.resolve(input), format, voice, steps };
}

function splitText(text) {
  if (!text || !text.trim()) return [];
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > MAX_SEGMENT) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_SEGMENT - 1);
    if (splitAt < MAX_SEGMENT * 0.4) {
      splitAt = Math.max(
        remaining.lastIndexOf('. ', MAX_SEGMENT - 1),
        remaining.lastIndexOf('! ', MAX_SEGMENT - 1),
        remaining.lastIndexOf('? ', MAX_SEGMENT - 1)
      );
    }
    if (splitAt < MAX_SEGMENT * 0.4) splitAt = MAX_SEGMENT;
    else splitAt += 1;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function cleanText(text, skipChars, skipWords) {
  let result = text;
  if (skipChars) {
    const escaped = [...skipChars].map(char => char.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')).join('');
    if (escaped) result = result.replace(new RegExp(`[${escaped}]`, 'g'), ' ');
  }
  const words = String(skipWords || '').split(',').map(word => word.trim())
    .filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length) result = result.replace(new RegExp(`\\b(${words.join('|')})\\b`, 'gi'), ' ');
  return result.replace(/ {2,}/g, ' ').trim();
}

function readSettings() {
  const userData = app.getPath('userData');
  let dbPath = path.join(userData, 'Sonara-Data', 'sonara.db');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    if (config.customDbPath && fs.existsSync(config.customDbPath)) dbPath = config.customDbPath;
  } catch (_) {}
  if (!fs.existsSync(dbPath)) return { skipChars: DEFAULT_SKIP_CHARS, skipWords: '' };
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const get = db.prepare('SELECT value FROM settings WHERE key = ?');
    const value = key => {
      const row = get.get(key);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch (_) { return row.value; }
    };
    return {
      skipChars: value('ttsSkipChars') || DEFAULT_SKIP_CHARS,
      skipWords: value('ttsSkipWords') || '',
    };
  } finally {
    db.close();
  }
}

async function parseBook(input) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
    const base64 = fs.readFileSync(input).toString('base64');
    const ext = path.extname(input).toLowerCase();
    return await win.webContents.executeJavaScript(`(async () => {
      const data = ${JSON.stringify(base64)};
      return ${ext === '.pdf'
        ? 'Parser.parsePDF(data, () => {})'
        : 'Parser.parseEPUB(data, () => {})'};
    })()`);
  } finally {
    win.destroy();
  }
}

function ffmpegPath() {
  let binary = require('ffmpeg-static');
  if (binary.includes(`app.asar${path.sep}`)) {
    binary = binary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  if (!fs.existsSync(binary)) throw new Error(`FFmpeg binary not found: ${binary}`);
  return binary;
}

function runFfmpeg(parameters) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-y', ...parameters], { windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-800))));
  });
}

function ffmeta(chapters, title) {
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/=/g, '\\=')
    .replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/\n/g, '\\n');
  const lines = [';FFMETADATA1', `title=${escape(title)}`];
  for (const chapter of chapters) {
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000',
      `START=${Math.round(chapter.startMs)}`,
      `END=${Math.max(Math.round(chapter.startMs) + 1, Math.round(chapter.endMs))}`,
      `title=${escape(chapter.title)}`);
  }
  return lines.join('\n');
}

async function main() {
  const options = args();
  if (!options || !fs.existsSync(options.input) || !['.pdf', '.epub'].includes(path.extname(options.input).toLowerCase())) {
    usage();
    process.exitCode = 2;
    return;
  }

  const settings = readSettings();
  console.log(`Reading ${options.input}`);
  const parsed = await parseBook(options.input);
  const chunks = Array.isArray(parsed) ? parsed : parsed?.chunks || [];
  console.log('Parsing complete');
  const segments = [];
  chunks.forEach((chunk, index) => splitText(chunk.text).forEach(text => {
    segments.push({ text, title: chunk.title || `Chapter ${index + 1}`, index });
  }));
  if (!segments.length) throw new Error('No readable text found');

  const tts = require('./supertonic-tts');
  const title = path.basename(options.input, path.extname(options.input));
  const output = path.join(path.dirname(options.input), `${title}.${options.format}`);
  console.log(`Output: ${output}`);
  const tempWav = `${output}.tmp.wav`;
  const audioParts = [];
  const chapters = [];
  let cursorMs = 0;
  let current = null;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const text = cleanText(segment.text, settings.skipChars, settings.skipWords);
    if (!text) continue;
    const percent = Math.round(((i + 1) / segments.length) * 90);
    console.log(`[${percent}%] Segment ${i + 1}/${segments.length}: ${segment.title}`);
    const result = await tts.synthesize({ text, voice: options.voice, speed: 1.05, totalStep: options.steps });
    audioParts.push(result.wav);
    if (!current || current.index !== segment.index) {
      if (current) chapters.push(current);
      current = { index: segment.index, title: segment.title, startMs: cursorMs, endMs: cursorMs };
    }
    cursorMs += result.durationMs || 0;
    current.endMs = cursorMs;
  }
  if (current) chapters.push(current);
  if (!audioParts.length) throw new Error('No audio was generated after applying skip settings');

  const first = audioParts[0];
  const pcm = Buffer.concat(audioParts.map(part => part.slice(44)));
  const header = Buffer.from(first.slice(0, 44));
  header.writeUInt32LE(36 + pcm.length, 4);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(tempWav, Buffer.concat([header, pcm]));

  try {
    console.log('[95%] Packaging audio');
    if (options.format === 'mp3') {
      await runFfmpeg(['-i', tempWav, '-c:a', 'libmp3lame', '-b:a', '128k', output]);
    } else {
      const metadata = `${output}.ffmeta.txt`;
      fs.writeFileSync(metadata, ffmeta(chapters, title), 'utf8');
      try {
        await runFfmpeg(['-i', tempWav, '-i', metadata, '-map', '0:a', '-map_metadata', '1',
          '-c:a', 'aac', '-b:a', '128k', '-metadata', `title=${title}`, '-metadata', 'genre=Audiobook',
          '-f', 'mp4', output]);
      } finally {
        fs.rmSync(metadata, { force: true });
      }
    }
  } finally {
    fs.rmSync(tempWav, { force: true });
  }
  console.log(`[100%] Saved: ${output}`);
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error(`Conversion failed: ${error.message}`);
    app.exit(1);
  }
});
