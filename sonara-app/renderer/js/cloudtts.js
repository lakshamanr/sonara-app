/* ══════════════════════════════════════════════════════════
   CLOUDTTS.JS — Real Microsoft Edge Neural TTS Integration

   Uses Microsoft Edge's free neural TTS service via the main
   process. Returns actual high-quality MP3 audio — no API key.
   300+ natural-sounding neural voices available.
══════════════════════════════════════════════════════════ */
'use strict';

const CloudTTS = (() => {

  let edgeVoices    = [];      // Full list from Edge TTS service
  let isLoaded      = false;
  let isLoading     = false;
  let currentAudio  = null;    // HTMLAudioElement for current playback
  let onEndCb       = null;
  let onBoundaryCb  = null;
  let requestId     = 0;       // Monotonic counter to cancel stale synthesis
  let boundaryRafId = null;    // requestAnimationFrame ID for word tracking

  // ── LOAD VOICES FROM EDGE TTS SERVICE ──────────────────
  async function loadVoices() {
    if (isLoaded || isLoading) return edgeVoices;
    if (!window.sonara?.tts) {
      return [];
    }

    isLoading = true;
    try {
      const raw = await window.sonara.tts.getVoices();

      edgeVoices = raw.map(v => ({
        // Display name: "en-US-AriaNeural" -> "Microsoft Aria (Natural)"
        name:         _friendlyName(v.friendlyName || v.name),
        shortName:    v.name,        // e.g. 'en-US-AriaNeural'
        lang:         v.locale || v.lang,
        gender:       v.gender,
        localService: false,
        voiceURI:     v.name,
        default:      false,
        _cloudVoice:  true,
        _edgeVoice:   v.name         // The actual voice ID for synthesis
      }));

      isLoaded = true;
      return edgeVoices;

    } catch (err) {
      return [];
    } finally {
      isLoading = false;
    }
  }

  function _friendlyName(raw) {
    // "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)"
    // -> "Microsoft Aria (Natural)"
    // Or "en-US-AriaNeural" -> "Aria (Natural) en-US"
    if (raw.includes('(') && raw.includes(',')) {
      const match = raw.match(/\(([^,]+),\s*(\w+?)(?:Neural)?\)/);
      if (match) return match[2] + ' (Natural) - ' + match[1];
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
    return edgeVoices;
  }

  function isCloudVoice(voice) {
    return voice && voice._cloudVoice === true;
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

      const voiceId = voice._edgeVoice || voice.shortName || voice.voiceURI;

      const result = await window.sonara.tts.synthesize({
        text,
        voice: voiceId,
        speed: rate,
        pitch
      });

      // Another speak() or stop() was called while we were waiting — discard
      if (myRequestId !== requestId) {
        return;
      }

      if (!result || !result.audio) {
        throw new Error('No audio returned from Edge TTS');
      }

      // Convert base64 to blob URL and play
      const binary = atob(result.audio);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const url  = URL.createObjectURL(blob);

      currentAudio = new Audio(url);
      currentAudio.playbackRate = 1.0; // Rate already applied in SSML
      onEndCb = onEnd;

      // Word boundary highlighting — poll at ~60fps for smooth tracking
      const boundaries = result.wordBoundaries || [];
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

  return {
    loadVoices,
    shouldEnable,
    getVoices,
    isCloudVoice,
    speak,
    onBoundary,
    preview,
    stop,
    pause,
    resume,
    isPlaying
  };

})();
