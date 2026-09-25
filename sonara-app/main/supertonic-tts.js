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
const { Worker } = require('worker_threads');
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
let helperMod   = null;   // lazy dynamic ESM import (main process; only used by encodeWav)
let downloading = null;   // in-flight download Promise to dedupe concurrent calls
let worker      = null;   // Node worker_thread running ONNX inference
let workerReady = null;   // Promise that resolves when worker posts 'ready'
let workerLoadingProgressCb = null;
const pending   = new Map(); // id -> {resolve, reject}
let nextId      = 1;

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

async function ensureWorker(progressCb) {
  if (worker && workerReady) return workerReady;

  // Make sure models are on disk before the worker tries to load them.
  await ensureModels(progressCb);
  if (progressCb) progressCb({ phase: 'loading' });
  workerLoadingProgressCb = progressCb;

  worker = new Worker(path.join(__dirname, 'supertonic-worker.mjs'), {
    workerData: {
      onnxDir:    onnxDir(),
      stylesDir:  stylesDir(),
      workerDir:  __dirname,
    },
  });

  workerReady = new Promise((resolve, reject) => {
    const onReady = (msg) => {
      if (msg.type === 'ready') {
        if (workerLoadingProgressCb) workerLoadingProgressCb({ phase: 'ready' });
        workerLoadingProgressCb = null;
        resolve();
      } else if (msg.type === 'worker-error') {
        const err = new Error(msg.error || 'Supertonic worker failed to load');
        reject(err);
        worker = null;
        workerReady = null;
      } else if (msg.type === 'result') {
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.ok) slot.resolve(msg);
        else slot.reject(new Error(msg.error || 'worker synth failed'));
      } else if (msg.type === 'progress') {
        const slot = pending.get(msg.id);
        if (slot?.progress) slot.progress(msg);
      }
    };
    worker.on('message', onReady);
    worker.on('error', (err) => {
      reject(err);
      // Fail all pending and reset so next call can respawn the worker.
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      worker = null;
      workerReady = null;
    });
    worker.on('exit', (code) => {
      const err = new Error(`Supertonic worker exited (code ${code})`);
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      worker = null;
      workerReady = null;
    });
  });

  return workerReady;
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
    ready: missingFiles().length === 0 && worker !== null && workerReady !== null,
  };
}

// Warm up the worker (spawn + load ONNX sessions) ahead of the first
// synthesize() call, so Play doesn't pay the model-load cost. Idempotent —
// safe to call repeatedly; returns the existing load promise if in flight.
function preload(progressCb) {
  return ensureWorker(progressCb);
}

// Kill the worker (cancels any in-flight inference). Worker respawns on the
// next synthesize() call. Cheap hammer for stop/cancel from the UI.
function abort() {
  if (!worker) return;
  try { worker.terminate(); } catch (_) {}
  const err = new Error('aborted');
  for (const slot of pending.values()) slot.reject(err);
  pending.clear();
  worker = null;
  workerReady = null;
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

  await ensureWorker(progressCb);
  const h = await ensureHelper();

  const id = nextId++;
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress: progressCb });
    worker.postMessage({ type: 'synth', id, text, voice, lang, speed, totalStep });
  });

  const buf = h.encodeWav(result.wav, result.sampleRate, result.wav.length);
  return { wav: buf, sampleRate: result.sampleRate, durationMs: result.durationMs };
}

module.exports = { getVoices, status, synthesize, ensureModels, preload, abort };
