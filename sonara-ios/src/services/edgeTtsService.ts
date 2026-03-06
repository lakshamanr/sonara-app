/**
 * EdgeTTSService — Sonara iOS
 * Ports the desktop Edge TTS WebSocket implementation to React Native.
 * Returns MP3 audio data from Microsoft's free neural TTS service.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;

let clockSkewSeconds = 0;

async function generateSecMsGec(): Promise<string> {
  let ticks = (Date.now() / 1000) + clockSkewSeconds;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    strToHash
  );
  return digest.toUpperCase();
}

function randomHex(n: number): string {
  let result = '';
  for (let i = 0; i < n; i++) result += Math.floor(Math.random() * 16).toString(16);
  return result;
}

function buildSsml(text: string, voice: string, rate: number, pitch: number): string {
  const rateStr = rate >= 1 ? `+${Math.round((rate - 1) * 100)}%` : `${Math.round((rate - 1) * 100)}%`;
  const pitchStr = pitch >= 1 ? `+${Math.round((pitch - 1) * 50)}Hz` : `${Math.round((pitch - 1) * 50)}Hz`;

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitchStr}' rate='${rateStr}'>` +
    `${escapeXml(text)}` +
    `</prosody></voice></speak>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface EdgeVoice {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  SuggestedCodec: string;
  FriendlyName: string;
  Status: string;
}

let _cachedVoices: EdgeVoice[] | null = null;

export const EdgeTTSService = {
  async getVoices(): Promise<EdgeVoice[]> {
    if (_cachedVoices) return _cachedVoices;
    try {
      const res = await fetch(VOICE_LIST_URL, {
        headers: {
          'Authority': 'speech.platform.bing.com',
          'Accept': 'application/json',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
        }
      });
      if (!res.ok) throw new Error(`Voice list HTTP ${res.status}`);
      _cachedVoices = await res.json();
      return _cachedVoices ?? [];
    } catch (err) {
      console.warn('EdgeTTS voice list failed:', err);
      return [];
    }
  },

  /**
   * Synthesize text using Edge TTS WebSocket.
   * Returns a local file URI to the MP3 audio.
   */
  async synthesize(
    text: string,
    voiceName = 'en-US-AriaNeural',
    rate = 1.0,
    pitch = 1.0,
    outputPath?: string
  ): Promise<string> {
    const secMsGec = await generateSecMsGec();
    const requestId = randomHex(32);
    const timestamp = new Date().toISOString();
    const ssml = buildSsml(text, voiceName, rate, pitch);

    const destPath = outputPath ?? FileSystem.cacheDirectory + `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `${WSS_BASE_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`
      );

      const audioChunks: Uint8Array[] = [];
      let headerDone = false;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        // Send speech config
        ws.send(
          `X-Timestamp:${timestamp}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' }
              }
            }
          })
        );

        // Send SSML
        ws.send(
          `X-RequestId:${requestId}\r\n` +
          `X-Timestamp:${timestamp}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml
        );
      };

      ws.onmessage = (evt) => {
        if (typeof evt.data === 'string') {
          if (evt.data.includes('Path:turn.end')) {
            ws.close();
          }
        } else if (evt.data instanceof ArrayBuffer) {
          const view = new DataView(evt.data);
          // First 2 bytes = header length
          const headerLen = view.getUint16(0, false);
          const audioData = new Uint8Array(evt.data, 2 + headerLen);
          if (audioData.length > 0) audioChunks.push(audioData);
        }
      };

      ws.onclose = async () => {
        if (!audioChunks.length) {
          reject(new Error('EdgeTTS: no audio data received'));
          return;
        }
        try {
          // Convert chunks to base64 and write
          let totalLen = audioChunks.reduce((a, c) => a + c.length, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of audioChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }

          // Write to file using base64
          const base64 = _uint8ToBase64(merged);
          await FileSystem.writeAsStringAsync(destPath, base64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          resolve(destPath);
        } catch (e) {
          reject(e);
        }
      };

      ws.onerror = (e) => {
        reject(new Error('EdgeTTS WebSocket error'));
      };
    });
  },
};

function _uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
