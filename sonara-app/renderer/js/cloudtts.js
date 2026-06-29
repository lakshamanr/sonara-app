/* ══════════════════════════════════════════════════════════
   CLOUDTTS.JS — Real Microsoft Edge Neural TTS Integration

   Uses Microsoft Edge's free neural TTS service via the main
   process. Returns actual high-quality MP3 audio — no API key.
   300+ natural-sounding neural voices available.
══════════════════════════════════════════════════════════ */
'use strict';

const CloudTTS = (() => {

  let edgeVoices    = [];      // Full list from Edge TTS service
  let localVoices   = [];      // Supertonic on-device voices
  let isLoaded      = false;
  let isLoading     = false;
  let currentAudio  = null;    // HTMLAudioElement for current playback
  let onEndCb       = null;
  let onBoundaryCb  = null;
  let requestId     = 0;       // Monotonic counter to cancel stale synthesis
  let boundaryRafId = null;    // requestAnimationFrame ID for word tracking
  let volume        = 1.0;     // Global output volume (0..1)

  // ── LOAD VOICES FROM EDGE TTS SERVICE ──────────────────
  async function loadVoices() {
    if (isLoaded || isLoading) return [...edgeVoices, ...localVoices];
    if (!window.sonara?.tts) {
      return [];
    }

    isLoading = true;
    try {
      // Edge cloud voices
      const raw = await window.sonara.tts.getVoices();
      edgeVoices = raw.map(v => ({
        name:         _friendlyName(v.friendlyName || v.name),
        shortName:    v.name,
        lang:         v.locale || v.lang,
        gender:       v.gender,
        localService: false,
        voiceURI:     v.name,
        default:      false,
        _cloudVoice:  true,
        _edgeVoice:   v.name
      }));

      // Supertonic on-device voices (best-effort — failure leaves list unchanged)
      try {
        const local = await window.sonara.supertonic?.getVoices() || [];
        localVoices = local.map(v => ({
          name:         `${v.name} [Local]`,
          shortName:    v.id,
          lang:         v.lang || 'en',
          gender:       v.gender,
          localService: true,
          voiceURI:     `supertonic:${v.id}`,
          default:      false,
          _cloudVoice:  true,     // routes through CloudTTS.speak (not SpeechSynthesis)
          _supertonic:  true,
          _supertonicId:v.id,
        }));
      } catch (_) { /* Supertonic unavailable — keep edge-only */ }

      isLoaded = true;
      return [...edgeVoices, ...localVoices];

    } catch (err) {
      return [];
    } finally {
      isLoading = false;
    }
  }

  // Synthesize word boundaries for engines (like Supertonic) that only give total duration.
  // Linear estimate by character position — good enough for highlight tracking.
  function _synthBoundaries(text, durationMs) {
    const totalChars = text.length || 1;
    const durationSec = (durationMs || 0) / 1000;
    if (durationSec <= 0) return [];
    const out = [];
    const wordRe = /\S+/g;
    let m;
    while ((m = wordRe.exec(text)) !== null) {
      out.push({
        audioOffset: (m.index / totalChars) * durationSec,
        textOffset:  m.index,
        textLength:  m[0].length,
        text:        m[0],
      });
    }
    return out;
  }

  // ── PREFETCH CACHE (Edge TTS + Supertonic) ─────────────
  // ponytail: bounded LRU (last 3 chunks) — each WAV is ~1MB/10s, so a few MB max.
  const _audioCache = new Map(); // key -> Promise<{audioBytes,mimeType,boundaries,durationMs}>
  const _AUDIO_CACHE_MAX = 3;

  function _cacheKey(text, voice, rate, pitch) {
    const id = voice._supertonicId || voice._edgeVoice || voice.shortName || voice.voiceURI || voice.name;
    return `${id}|${rate}|${pitch}|${text}`;
  }

  function _fetchAudio(text, voice, rate, pitch) {
    if (voice._supertonic) {
      return window.sonara.supertonic.synthesize({
        text,
        voice: voice._supertonicId,
        lang:  voice.lang || 'en',
        speed: rate,
      }).then(result => {
        if (!result || !result.audio) throw new Error('No audio returned from Supertonic');
        return {
          audioBytes: result.audio,
          mimeType:   'audio/wav',
          boundaries: _synthBoundaries(text, result.durationMs || 0),
          durationMs: result.durationMs,
        };
      });
    }
    // Edge TTS
    const voiceId = voice._edgeVoice || voice.shortName || voice.voiceURI;
    return window.sonara.tts.synthesize({ text, voice: voiceId, speed: rate, pitch })
      .then(result => {
        if (!result || !result.audio) throw new Error('No audio returned from Edge TTS');
        return {
          audioBytes: result.audio,
          mimeType:   'audio/mpeg',
          boundaries: result.wordBoundaries || [],
          durationMs: result.durationMs,
        };
      });
  }

  function _getAudio(text, voice, rate, pitch) {
    const key = _cacheKey(text, voice, rate, pitch);
    let p = _audioCache.get(key);
    if (p) {
      _audioCache.delete(key);  // LRU touch
      _audioCache.set(key, p);
      return p;
    }
    p = _fetchAudio(text, voice, rate, pitch)
      .catch(err => { _audioCache.delete(key); throw err; });
    _audioCache.set(key, p);
    while (_audioCache.size > _AUDIO_CACHE_MAX) {
      _audioCache.delete(_audioCache.keys().next().value);
    }
    return p;
  }

  // Public: warm the cache for upcoming text without playing it.
  function prefetch(text, voice, rate = 1.0, pitch = 1.0) {
    if (!text || !voice) return;
    if (!voice._cloudVoice) return;     // system voices are instant — no prefetch needed
    try { _getAudio(text, voice, rate, pitch); } catch (_) {}
  }

  // Public: synthesize-and-return without playing. Used by the export pipeline.
  // Returns {audioBase64, mimeType, durationMs} from the unified cache.
  async function synthOnly(text, voice, rate = 1.0, pitch = 1.0) {
    if (!voice || !voice._cloudVoice) throw new Error('synthOnly: voice must be Edge or Supertonic');
    const r = await _getAudio(text, voice, rate, pitch);
    return { audioBase64: r.audioBytes, mimeType: r.mimeType, durationMs: r.durationMs };
  }


  function _friendlyName(raw) {
    // "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
    // -> "Microsoft Aria (Natural)"
    // Or "en-US-AriaNeural" -> "Aria (Natural) en-US"
    if (raw.includes('(') && raw.includes(',')) {
      const match = raw.match(/\(([^,]+),\s*(\w+?)(?:Neural)?\)/);      if (match) return match[2] + ' (Natural) - ' + match[1];
    }
    // Already friendly: "Microsoft Aria Online (Natural) - English (United States)"
    if (raw.includes('(Natural)')) return raw;
    // ShortName like "en-US-AriaNeural"
    const parts = raw.match(/^([a-z]{2}-[A-Z]{2})-(\w+?)(?:Neural)?$/);
    if (parts) return parts[2] + ' (Natural) - ' + parts[1];
    return raw;
  }

  // Always show cloud voices (they're the best quality)
  function shouldEnable(_systemVoiceCount) {
    return true;
  }

  // Get voices formatted for the voice list
  function getVoices() {
    return [...edgeVoices, ...localVoices];
  }

  function isCloudVoice(voice) {
    return voice && (voice._cloudVoice === true || voice._supertonic === true);
  }

  function isLocalVoice(voice) {
    return !!(voice && voice._supertonic === true);
  }

  // ── SYNTHESIZE & PLAY ──────────────────────────────────
  async function speak(text, voice, rate = 1.0, pitch = 1.0, onEnd, onError) {
    if (!window.sonara?.tts) {
      if (onError) onError(new Error('TTS API not available'));
      return;
    }

    // Stop current playback & kill old Audio element (without bumping requestId)
    _stopAudio();

    // Increment request ID and capture it — any older pending synthesis
    // will see a mismatch after its await and discard the stale result.
    const myRequestId = ++requestId;

    try {
      const result = await _getAudio(text, voice, rate, pitch);

      // Another speak() or stop() was called while we were waiting — discard
      if (myRequestId !== requestId) return;

      const audioBytes = result.audioBytes;
      const mimeType   = result.mimeType;
      const boundaries = result.boundaries;

      // Convert base64 to blob URL and play
      const binary = atob(audioBytes);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const url  = URL.createObjectURL(blob);

      currentAudio = new Audio(url);
      currentAudio.playbackRate = 1.0; // Rate already applied in synth
      currentAudio.volume = volume;
      onEndCb = onEnd;

      // Word boundary highlighting — poll at ~60fps for smooth tracking
      let lastBoundaryIdx = -1;

      if (boundaries.length > 0 && onBoundaryCb) {
        const pollBoundaries = () => {
          if (!currentAudio || currentAudio.paused || currentAudio.ended) {
            boundaryRafId = null;
            return;
          }
          const t = currentAudio.currentTime;
          let idx = lastBoundaryIdx;
          for (let i = lastBoundaryIdx + 1; i < boundaries.length; i++) {
            if (boundaries[i].audioOffset <= t) {
              idx = i;
            } else {
              break;
            }
          }
          if (idx !== lastBoundaryIdx && idx >= 0) {
            lastBoundaryIdx = idx;
            const b = boundaries[idx];
            onBoundaryCb(b.textOffset, b.textLength, b.text);
          }
          boundaryRafId = requestAnimationFrame(pollBoundaries);
        };
        // Start polling once audio begins playing
        currentAudio.onplay = () => {
          if (!boundaryRafId) boundaryRafId = requestAnimationFrame(pollBoundaries);
        };
      }

      currentAudio.onended = () => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        if (onEndCb) onEndCb();
      };

      currentAudio.onerror = (e) => {
        URL.revokeObjectURL(url);
        currentAudio = null;
        if (onError) onError(e);
      };

      // Final check before playing — another request may have come in
      if (myRequestId !== requestId) {
        URL.revokeObjectURL(url);
        return;
      }

      await currentAudio.play();

    } catch (err) {
      // Only report error if this request is still the active one
      if (myRequestId !== requestId) return;
      if (onError) onError(err);
    }
  }

  /**
   * Set the word boundary callback.
   * Called with (textOffset, textLength, wordText) on each word during playback.
   */
  function onBoundary(cb) {
    onBoundaryCb = cb;
  }

  // ── PREVIEW A VOICE ────────────────────────────────────
  async function preview(voice, rate = 1.0, pitch = 1.0) {
    const name = (voice.name || '').split(' ')[0] || 'I';
    const text = 'Hello, my name is ' + name + '. I will read your book aloud with this natural voice.';
    return new Promise((resolve, reject) => {
      speak(text, voice, rate, pitch, resolve, reject);
    });
  }

  // Internal: stop audio without invalidating requestId
  function _stopAudio() {
    if (boundaryRafId) {
      cancelAnimationFrame(boundaryRafId);
      boundaryRafId = null;
    }
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.onplay = null;
      currentAudio.pause();
      currentAudio.currentTime = 0;
      if (currentAudio.src) {
        URL.revokeObjectURL(currentAudio.src);
      }
      currentAudio = null;
    }
    onEndCb = null;
  }

  function stop() {
    _stopAudio();
    // Invalidate any in-flight synthesis requests
    requestId++;
  }

  function pause() {
    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
    }
  }

  function resume() {
    if (currentAudio && currentAudio.paused) {
      currentAudio.play();
    }
  }

  function isPlaying() {
    return currentAudio && !currentAudio.paused && !currentAudio.ended;
  }

  function isPaused() {
    return !!(currentAudio && currentAudio.paused && !currentAudio.ended);
  }

  function setVolume(val) {
    const next = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 1.0;
    volume = next;
    if (currentAudio) {
      currentAudio.volume = next;
    }
  }

  function getVolume() {
    return volume;
  }

  return {
    loadVoices,
    shouldEnable,
    getVoices,
    isCloudVoice,
    isLocalVoice,
    speak,
    prefetch,
    synthOnly,
    onBoundary,
    preview,
    stop,
    pause,
    resume,
    isPlaying,
    isPaused,
    setVolume,
    getVolume
  };

})();
