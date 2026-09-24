// Supertonic ONNX inference worker.
// Runs in a Node worker_thread so heavy synthesis never blocks the
// Electron main process (IPC, UI, prefetch all stay responsive).
//
// Protocol:
//   parent -> worker: { type:'init', onnxDir, stylesDir }
//                     { type:'synth', id, text, voice, lang, speed, totalStep }
//   worker -> parent: { type:'ready' }
//                     { type:'result', id, ok:true, wav:[...], sampleRate, durationMs }
//                     { type:'result', id, ok:false, error }
import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { pathToFileURL } from 'url';

let tts        = null;
let helper     = null;
let onnxDir    = workerData?.onnxDir;
let stylesDir  = workerData?.stylesDir;
const styles   = new Map();
let synthQueue = Promise.resolve();

async function loadHelper() {
  if (helper) return helper;
  const url = pathToFileURL(path.join(workerData.workerDir, 'supertonic-helper.mjs')).href;
  helper = await import(url);
  return helper;
}

async function ensureTts() {
  if (tts) return tts;
  helper = await loadHelper();
  tts = await helper.loadTextToSpeech(onnxDir);
  return tts;
}

function getStyle(voiceId) {
  let s = styles.get(voiceId);
  if (s) return s;
  s = helper.loadVoiceStyle([path.join(stylesDir, `${voiceId}.json`)]);
  styles.set(voiceId, s);
  return s;
}

async function handleSynth(msg) {
  const { id, text, voice, lang, speed, totalStep } = msg;
  parentPort.postMessage({ type: 'progress', id, phase: 'generating', textLength: text.length });
  try {
    const t = await ensureTts();
    const style = getStyle(voice);
    const { wav, duration } = await t.call(text, lang, style, totalStep, speed);
    const samples = Math.floor(t.sampleRate * duration[0]);
    // Transfer Float32Array as plain array — boundary cost is small vs. synth.
    parentPort.postMessage({
      type: 'result', id, ok: true,
      wav: wav.slice(0, samples),
      sampleRate: t.sampleRate,
      durationMs: Math.round(duration[0] * 1000),
    });
    parentPort.postMessage({ type: 'progress', id, phase: 'complete' });
  } catch (err) {
    parentPort.postMessage({ type: 'progress', id, phase: 'error', error: err.message || String(err) });
    parentPort.postMessage({ type: 'result', id, ok: false, error: err.message || String(err) });
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'synth') {
    // ONNX sessions are not cheap to run concurrently. Queue requests so
    // prefetch or export cannot multiply peak memory usage.
    parentPort.postMessage({ type: 'progress', id: msg.id, phase: 'queued' });
    synthQueue = synthQueue.then(() => handleSynth(msg), () => handleSynth(msg));
  }
});

// Do not report ready until ONNX sessions are loaded. Otherwise the first
// playback request appears hung while it performs the expensive initialization.
ensureTts()
  .then(() => parentPort.postMessage({ type: 'ready' }))
  .catch((err) => parentPort.postMessage({ type: 'worker-error', error: err.message || String(err) }));
