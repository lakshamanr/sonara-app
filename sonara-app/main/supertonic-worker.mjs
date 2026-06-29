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

async function loadHelper() {
  if (helper) return helper;
  const url = pathToFileURL(path.join(workerData.workerDir, 'supertonic-helper.mjs')).href;
  helper = await import(url);
  return helper;
}

async function ensureTts() {
  if (tts) return tts;
  const h = await loadHelper();
  tts = await h.loadTextToSpeech(onnxDir);
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
  } catch (err) {
    parentPort.postMessage({ type: 'result', id, ok: false, error: err.message || String(err) });
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'synth') handleSynth(msg);
});

parentPort.postMessage({ type: 'ready' });
