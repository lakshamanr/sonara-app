/* ══════════════════════════════════════════════════════════
   SUPERTONIC-TTS.JS — Local on-device neural TTS (Supertonic 3)

   Wraps the upstream ONNX helper (supertonic-helper.mjs) with:
   - first-use download from Hugging Face into userData/supertonic
   - lazy ONNX session load (kept warm in memory once loaded)
   - voice-style discovery and synth → 16-bit WAV Buffer

   The whole module is silent until the first IPC call; no work
   happens at app start.
   ══════════════════════════════════════════════════════════ */
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { app } = require('electron');

// ── REMOTE LAYOUT ────────────────────────────────────────
const HF_REPO = 'Supertone/supertonic-3';
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;

const ONNX_FILES = [
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
];

// ponytail: ten built-in speaker styles ship with the model; no enumeration needed.
const VOICE_IDS = ['M1','M2','M3','M4','M5','F1','F2','F3','F4','F5'];
const VOICE_FILES = VOICE_IDS.map(id => `voice_styles/${id}.json`);
const ALL_FILES = [...ONNX_FILES, ...VOICE_FILES];

// ── PATHS ────────────────────────────────────────────────
function rootDir() {
  return path.join(app.getPath('userData'), 'supertonic');
}
function localPathFor(rel) {
  return path.join(rootDir(), rel);
}
function onnxDir()  { return path.join(rootDir(), 'onnx'); }
function stylesDir(){ return path.join(rootDir(), 'voice_styles'); }

// ── STATE ────────────────────────────────────────────────
let helperMod   = null;   // lazy dynamic ESM import
let tts         = null;   // loaded TextToSpeech instance
let loadingTts  = null;   // in-flight Promise to dedupe concurrent calls
let downloading = null;   // in-flight download Promise to dedupe concurrent calls

// ── DOWNLOAD ─────────────────────────────────────────────
function downloadOne(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmp = destPath + '.part';
    const file = fs.createWriteStream(tmp);
    let received = 0, total = 0;

    const get = (u, redirects = 0) => {
      let parsed;
      try { parsed = new URL(u); }
      catch { return reject(new Error(`Invalid redirect URL: ${u}`)); }
      https.get(parsed, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) return reject(new Error('Too many redirects'));
          res.resume();
          // Resolve relative redirects against the current URL (HF LFS sometimes returns them)
          const next = new URL(res.headers.location, parsed).toString();
          return get(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close((err) => {
          if (err) return reject(err);
          fs.rename(tmp, destPath, (e) => e ? reject(e) : resolve());
        }));
        res.on('error', reject);
        file.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function missingFiles() {
  return ALL_FILES.filter(rel => !fs.existsSync(localPathFor(rel)));
}

async function ensureModels(progressCb) {
  if (downloading) return downloading;
  const missing = missingFiles();
  if (missing.length === 0) return;

  downloading = (async () => {
    for (let i = 0; i < missing.length; i++) {
      const rel = missing[i];
      if (progressCb) progressCb({ phase: 'download', file: rel, fileIndex: i, fileCount: missing.length, received: 0, total: 0 });
      await downloadOne(`${HF_BASE}/${rel}`, localPathFor(rel), (received, total) => {
        if (progressCb) progressCb({ phase: 'download', file: rel, fileIndex: i, fileCount: missing.length, received, total });
      });
    }
    if (progressCb) progressCb({ phase: 'ready', fileIndex: missing.length, fileCount: missing.length });
  })();

  try { await downloading; }
  finally { downloading = null; }
}

// ── LOAD ─────────────────────────────────────────────────
async function ensureHelper() {
  if (!helperMod) helperMod = await import('./supertonic-helper.mjs');
  return helperMod;
}

async function ensureTTS(progressCb) {
  if (tts) return tts;
  if (loadingTts) return loadingTts;
  loadingTts = (async () => {
    await ensureModels(progressCb);
    if (progressCb) progressCb({ phase: 'loading' });
    const h = await ensureHelper();
    tts = await h.loadTextToSpeech(onnxDir());
    if (progressCb) progressCb({ phase: 'ready' });
    return tts;
  })();
  try { return await loadingTts; }
  finally { loadingTts = null; }
}

// ── PUBLIC API ───────────────────────────────────────────
function getVoices() {
  return VOICE_IDS.map(id => ({
    id,
    gender: id.startsWith('M') ? 'male' : 'female',
    name: `Supertonic ${id} (${id.startsWith('M') ? 'Male' : 'Female'})`,
    lang: 'en',
  }));
}

function status() {
  return {
    rootDir: rootDir(),
    missing: missingFiles(),
    ready: missingFiles().length === 0 && tts !== null,
  };
}

/**
 * @param {{ text, voice, lang, speed, totalStep }} opts
 * @param {(p:object)=>void} [progressCb]
 * @returns {{wav: Buffer, sampleRate: number, durationMs: number}}
 */
async function synthesize(opts, progressCb) {
  const { text, voice = 'M1', lang = 'en', speed = 1.05, totalStep = 8 } = opts || {};
  if (!text || !text.trim()) throw new Error('synthesize: text is empty');
  if (!VOICE_IDS.includes(voice)) throw new Error(`Unknown voice: ${voice}`);

  const t = await ensureTTS(progressCb);
  const h = await ensureHelper();
  const stylePath = path.join(stylesDir(), `${voice}.json`);
  const style = h.loadVoiceStyle([stylePath]);

  const { wav, duration } = await t.call(text, lang, style, totalStep, speed);
  const samples = Math.floor(t.sampleRate * duration[0]);
  const buf = h.encodeWav(wav, t.sampleRate, samples);
  return { wav: buf, sampleRate: t.sampleRate, durationMs: Math.round(duration[0] * 1000) };
}

module.exports = { getVoices, status, synthesize, ensureModels };
