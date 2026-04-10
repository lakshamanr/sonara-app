/* ══════════════════════════════════════════════════════════
   EDGE-TTS.JS — Real Microsoft Edge Neural TTS Engine

   Connects to Microsoft's free Edge TTS service via WebSocket.
   Returns high-quality neural voice audio (MP3) — no API key needed.

   Implements Sec-MS-GEC DRM token authentication as required by
   Microsoft's service (based on rany2/edge-tts Python library).
══════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const https  = require('https');
const zlib   = require('zlib');

// ── CONSTANTS ────────────────────────────────────────────
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_BASE_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// Chromium version — must be kept up to date to avoid 403
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

// Windows epoch offset (seconds between 1601-01-01 and 1970-01-01)
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;

// Clock skew correction (adjusted if server returns different time)
let clockSkewSeconds = 0;

// ── DRM TOKEN GENERATION ─────────────────────────────────
/**
 * Generate the Sec-MS-GEC security token required by Microsoft's TTS service.
 * Based on rany2/edge-tts DRM implementation.
 */
function generateSecMsGec() {
  // Get current timestamp with clock skew correction
  let ticks = (Date.now() / 1000) + clockSkewSeconds;

  // Switch to Windows file time epoch (1601-01-01)
  ticks += WIN_EPOCH;

  // Round down to nearest 5 minutes (300 seconds)
  ticks -= ticks % 300;

  // Convert to 100-nanosecond intervals (Windows file time format)
  ticks *= S_TO_NS / 100;

  // Create hash input: ticks + trusted client token
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;

  // SHA-256 hash → uppercase hex
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

/**
 * Generate a random MUID for cookie header
 */
function generateMuid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

/**
 * Generate a unique connection/request ID
 */
function generateConnectionId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ── HEADERS ──────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  // Keep encodings to formats Node can decode reliably.
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
};

function getWssHeaders() {
  return {
    ...BASE_HEADERS,
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'Cookie': `muid=${generateMuid()};`,
  };
}

const VOICE_HEADERS = {
  ...BASE_HEADERS,
  'Authority': 'speech.platform.bing.com',
  'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR_VERSION}", "Chromium";v="${CHROMIUM_MAJOR_VERSION}"`,
  'Sec-CH-UA-Mobile': '?0',
  'Accept': '*/*',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
};

function decodeHttpBody(buffer, contentEncoding) {
  const encoding = (contentEncoding || '').toLowerCase().trim();
  if (!encoding || encoding === 'identity') return buffer;
  if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer);
  if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
  if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
  return buffer;
}

// ── VOICE LIST CACHE ─────────────────────────────────────
let cachedVoices = null;
let cacheTime    = 0;
const CACHE_TTL  = 3600000; // 1 hour

/**
 * Fetch available voices from Microsoft Edge TTS service
 */
async function getVoices() {
  if (cachedVoices && (Date.now() - cacheTime) < CACHE_TTL) {
    return cachedVoices;
  }

  return new Promise((resolve, reject) => {
    const voiceHeaders = {
      ...VOICE_HEADERS,
      'Sec-MS-GEC': generateSecMsGec(),
      'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
      'Cookie': `muid=${generateMuid()};`,
    };

    https.get(VOICE_LIST_URL, {
      headers: voiceHeaders,
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const status = res.statusCode || 0;
          const rawBuffer = Buffer.concat(chunks);
          const decoded = decodeHttpBody(rawBuffer, res.headers['content-encoding']);
          const data = decoded.toString('utf8');

          if (status < 200 || status >= 300) {
            const bodySnippet = data.slice(0, 180).replace(/\s+/g, ' ');
            reject(new Error(`Edge voice list HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ''}`));
            return;
          }

          const voices = JSON.parse(data);
          if (!Array.isArray(voices)) {
            reject(new Error('Edge voice list returned invalid payload'));
            return;
          }

          cachedVoices = voices.map(v => ({
            name:         v.ShortName,
            friendlyName: v.FriendlyName,
            locale:       v.Locale,
            lang:         v.Locale,
            gender:       v.Gender,
            voiceTag:     v.VoiceTag,
            status:       v.Status
          }));
          cacheTime = Date.now();
          resolve(cachedVoices);
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    })
      .on('timeout', function() {
        this.destroy(new Error('Edge voice list request timed out'));
      })
      .on('error', reject);
  });
}

/**
 * Compute MP3 duration in milliseconds by walking MPEG frame headers.
 * Works on raw MP3 byte stream (including multiple concatenated chunks).
 */
const MPEG_BITRATES = {
  // [version, layer] → bitrate table (kbps), index 1..14
  'V1L1': [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448],
  'V1L2': [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384],
  'V1L3': [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
  'V2L1': [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256],
  'V2L2': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
  'V2L3': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
};
const MPEG_SAMPLERATES = {
  V1:  [44100, 48000, 32000],
  V2:  [22050, 24000, 16000],
  V25: [11025, 12000, 8000],
};

function mp3DurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 0;
  let pos = 0;
  // Skip ID3v2 if present
  if (buffer.length > 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) |
                 ((buffer[8] & 0x7f) <<  7) |  (buffer[9] & 0x7f);
    pos = 10 + size;
  }
  let totalSamples = 0;
  let sampleRate = 24000; // sane fallback (Edge output format)
  const len = buffer.length;
  while (pos + 4 <= len) {
    // Frame sync: 11 bits set
    if (buffer[pos] !== 0xff || (buffer[pos + 1] & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const b1 = buffer[pos + 1], b2 = buffer[pos + 2];
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits   = (b1 >> 1) & 0x03;
    const bitrateIdx  = (b2 >> 4) & 0x0f;
    const srIdx       = (b2 >> 2) & 0x03;
    const padding     = (b2 >> 1) & 0x01;

    if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      pos++;
      continue;
    }
    const version = versionBits === 3 ? 'V1' : versionBits === 2 ? 'V2' : 'V25';
    const layer   = layerBits === 3 ? 'L1' : layerBits === 2 ? 'L2' : 'L3';
    const brKey   = (version === 'V25' ? 'V2' : version) + layer;
    const brTable = MPEG_BITRATES[brKey];
    if (!brTable) { pos++; continue; }
    const bitrateKbps = brTable[bitrateIdx];
    sampleRate = MPEG_SAMPLERATES[version][srIdx];
    if (!bitrateKbps || !sampleRate) { pos++; continue; }

    // Samples per frame
    let samplesPerFrame;
    if (layer === 'L1') samplesPerFrame = 384;
    else if (layer === 'L2') samplesPerFrame = 1152;
    else samplesPerFrame = (version === 'V1') ? 1152 : 576; // L3

    // Frame length in bytes
    const frameBytes = layer === 'L1'
      ? Math.floor((12 * bitrateKbps * 1000 / sampleRate + padding) * 4)
      : Math.floor(samplesPerFrame / 8 * bitrateKbps * 1000 / sampleRate + padding);

    if (frameBytes < 4 || pos + frameBytes > len) {
      pos++;
      continue;
    }
    totalSamples += samplesPerFrame;
    pos += frameBytes;
  }
  return sampleRate > 0 ? Math.round(totalSamples * 1000 / sampleRate) : 0;
}

/**
 * Escape text for XML/SSML
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate date string for X-Timestamp header
 */
function dateToString() {
  return new Date().toISOString();
}

/**
 * Synthesize text to MP3 audio using Edge TTS
 * @param {string} text - Text to synthesize
 * @param {string} voice - Voice short name (e.g., 'en-US-AriaNeural')
 * @param {object} options - { rate: '+0%', pitch: '+0Hz', volume: '+0%' }
 * @returns {Promise<Buffer>} MP3 audio buffer
 */
async function synthesize(text, voice = 'en-US-AriaNeural', options = {}) {
  const rate   = options.rate   || '+0%';
  const pitch  = options.pitch  || '+0Hz';
  const volume = options.volume || '+0%';

  return new Promise((resolve, reject) => {
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      reject(new Error('WebSocket not available. Install ws: npm install ws'));
      return;
    }

    const connectionId = generateConnectionId();
    const secMsGec = generateSecMsGec();

    // Build full WebSocket URL with DRM tokens
    const wssUrl = `${WSS_BASE_URL}&ConnectionId=${connectionId}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    const audioChunks = [];
    const wordBoundaries = [];
    let textSearchPos = 0;  // Running position for computing word text offsets
    let resolved = false;

    const ws = new WebSocket(wssUrl, {
      headers: getWssHeaders(),
      perMessageDeflate: true,
    });

    // Scale timeout with text length — longer texts need more time
    const timeoutMs = Math.max(30000, Math.min(120000, text.length * 20));
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error(`Edge TTS timeout after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    ws.on('open', () => {
      // 1. Send speech config
      const configMsg =
        `X-Timestamp:${dateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'true'
                },
                outputFormat: OUTPUT_FORMAT
              }
            }
          }
        });
      ws.send(configMsg);

      // 2. Send SSML
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${escapeXml(voice)}'>` +
        `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
        `${escapeXml(text)}` +
        `</prosody></voice></speak>`;

      const ssmlMsg =
        `X-RequestId:${connectionId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateToString()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      // Text messages (turn.end, metadata, etc.)
      if (!isBinary) {
        const msg = typeof data === 'string' ? data : data.toString('utf8');

        if (msg.includes('Path:turn.end')) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          resolve({ audio: Buffer.concat(audioChunks), wordBoundaries });
          return;
        }

        // Parse word boundary metadata
        if (msg.includes('Path:audio.metadata')) {
          try {
            const jsonStr = msg.substring(msg.indexOf('{'));
            const meta = JSON.parse(jsonStr);
            if (meta.Metadata) {
              for (const item of meta.Metadata) {
                if (item.Type === 'WordBoundary' && item.Data) {
                  const wordText = item.Data.text?.Text ?? '';
                  const wordLen  = item.Data.text?.Length ?? wordText.length;

                  // Compute textOffset by finding this word in the original text
                  // starting from where the last word ended
                  let computedOffset = text.indexOf(wordText, textSearchPos);
                  if (computedOffset < 0) computedOffset = textSearchPos;
                  textSearchPos = computedOffset + wordLen;

                  wordBoundaries.push({
                    audioOffset: item.Data.Offset / 1e7,
                    duration: item.Data.Duration / 1e7,
                    textOffset: computedOffset,
                    textLength: wordLen,
                    text: wordText
                  });
                }
              }
            }
          } catch (e) {
            // Metadata parse failure is non-fatal
          }
        }
        return;
      }

      // Binary message — extract audio data
      // Format: [headerLen (2 bytes big-endian)] [header text] [audio bytes]
      if (Buffer.isBuffer(data) && data.length > 2) {
        const headerLen = data.readUInt16BE(0);
        if (2 + headerLen < data.length) {
          const header = data.slice(2, 2 + headerLen).toString('utf8');

          if (header.includes('Path:audio')) {
            const audioData = data.slice(2 + headerLen);
            if (audioData.length > 0) {
              audioChunks.push(audioData);
            }
          } else if (header.includes('Path:turn.end')) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            resolve({ audio: Buffer.concat(audioChunks), wordBoundaries });
          }
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (audioChunks.length > 0) {
          resolve({ audio: Buffer.concat(audioChunks), wordBoundaries });
        } else {
          reject(new Error(`WebSocket closed (code: ${code}) without audio`));
        }
      }
    });

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);

      // Try clock skew correction from server Date header
      const serverDate = res.headers['date'];
      if (serverDate && res.statusCode === 403) {
        try {
          const serverTime = new Date(serverDate).getTime() / 1000;
          const clientTime = Date.now() / 1000;
          const skew = serverTime - clientTime;
          if (Math.abs(skew) > 1) {
            clockSkewSeconds += skew;
          }
        } catch (e) {
          // skew correction failed
        }
      }

      if (!resolved) {
        resolved = true;
        reject(new Error(`Unexpected server response: ${res.statusCode}`));
      }
    });
  });
}

/**
 * Synthesize with automatic retry on transient failures (403, timeout)
 */
async function synthesizeWithRetry(text, voice, options, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await synthesize(text, voice, options);
    } catch (err) {
      const isRetryable = err.message && (
        err.message.includes('403') ||
        err.message.includes('timeout') ||
        err.message.includes('WebSocket closed')
      );
      if (isRetryable && attempt < maxRetries) {
        const delay = (attempt + 1) * 1000; // 1s, 2s backoff
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Convert a speed multiplier (1.0 = normal) to Edge TTS rate string
 */
function speedToRate(speed) {
  const pct = Math.round((speed - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

/**
 * Convert a pitch value (1.0 = normal) to Edge TTS pitch string
 */
function pitchToHz(pitch) {
  const hz = Math.round((pitch - 1) * 200);
  return (hz >= 0 ? '+' : '') + hz + 'Hz';
}

module.exports = {
  getVoices,
  synthesize: synthesizeWithRetry,
  speedToRate,
  pitchToHz,
  mp3DurationMs
};
