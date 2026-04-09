/* ══════════════════════════════════════════════════════════
   QUICKTEXT.JS — Paste text, listen, export MP3
   Temporary — nothing is saved to the library.
══════════════════════════════════════════════════════════ */
'use strict';

const QuickText = (() => {

  const MAX_SEGMENT = 3000;

  let _isPlaying    = false;
  let _isExporting  = false;
  let _cancelled    = false;
  let _currentAudio = null;
  let _requestId    = 0;
  let _voicesLoaded = false;

  // ── OPEN / CLOSE ──────────────────────────────────────────
  async function open() {
    UI.openModal('modalQuickText');
    _setStatus('');
    if (!_voicesLoaded) {
      await _loadVoices();
    }
  }

  function close() {
    _stopAudio();
    UI.closeModal('modalQuickText');
  }

  // ── VOICE LOADER ──────────────────────────────────────────
  async function _loadVoices() {
    const sel = document.getElementById('qtVoice');
    sel.innerHTML = '<option value="">Loading voices…</option>';
    try {
      const voices = await CloudTTS.loadVoices();
      sel.innerHTML = '';

      const english = voices.filter(v => (v.lang || '').startsWith('en-'));
      const rest    = voices.filter(v => !(v.lang || '').startsWith('en-'));
      const sorted  = [...english, ...rest];

      for (const v of sorted) {
        const opt = document.createElement('option');
        opt.value       = v._edgeVoice || v.shortName || v.voiceURI;
        opt.textContent = v.name;
        sel.appendChild(opt);
      }

      // Default to en-US-AriaNeural if available
      const aria = sorted.find(v => (v._edgeVoice || '').includes('Aria'));
      if (aria) sel.value = aria._edgeVoice || aria.shortName;

      _voicesLoaded = true;
    } catch (err) {
      sel.innerHTML = '<option value="en-US-AriaNeural">Aria (Natural) - en-US</option>';
      _voicesLoaded = true;
    }
  }

  // ── PLAY / PAUSE ──────────────────────────────────────────
  async function togglePlay() {
    if (_isPlaying) {
      _stopAudio();
      _setPlayState(false);
      _setStatus('');
      return;
    }

    const text = document.getElementById('qtTextarea').value.trim();
    if (!text) {
      UI.toast('Paste some text first', 'error');
      return;
    }

    const voiceId = document.getElementById('qtVoice').value || 'en-US-AriaNeural';
    const speed   = parseFloat(document.getElementById('qtSpeed').value) || 1.0;

    _setPlayState(true);
    _setStatus('Synthesizing audio…');

    const segments = _splitText(text);
    const myId     = ++_requestId;

    for (let i = 0; i < segments.length; i++) {
      if (_requestId !== myId) return; // stop() was called

      _setStatus(`Playing segment ${i + 1} of ${segments.length}…`);

      try {
        const result = await window.sonara.tts.synthesize({
          text:  segments[i],
          voice: voiceId,
          speed,
          pitch: 1.0
        });

        if (_requestId !== myId) return;

        if (result?.audio) {
          await _playBase64(result.audio, myId);
        }
      } catch (err) {
        if (_requestId !== myId) return;
        UI.toast('Playback error: ' + err.message, 'error');
        break;
      }
    }

    if (_requestId === myId) {
      _setPlayState(false);
      _setStatus('Done.');
      setTimeout(() => { if (!_isPlaying) _setStatus(''); }, 2000);
    }
  }

  function _playBase64(b64, myId) {
    return new Promise((resolve, reject) => {
      const binary = atob(b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const url  = URL.createObjectURL(blob);

      _currentAudio = new Audio(url);
      _currentAudio.onended = () => {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        resolve();
      };
      _currentAudio.onerror = (e) => {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        if (_requestId === myId) reject(e);
        else resolve(); // cancelled — don't propagate error
      };
      _currentAudio.play().catch(err => {
        URL.revokeObjectURL(url);
        _currentAudio = null;
        if (_requestId === myId) reject(err);
        else resolve();
      });
    });
  }

  function _stopAudio() {
    ++_requestId; // invalidate pending synthesis callbacks
    if (_currentAudio) {
      _currentAudio.onended = null;
      _currentAudio.onerror = null;
      _currentAudio.pause();
      if (_currentAudio.src) URL.revokeObjectURL(_currentAudio.src);
      _currentAudio = null;
    }
    _isPlaying = false;
  }

  // ── EXPORT MP3 ────────────────────────────────────────────
  async function exportMp3() {
    if (_isExporting) {
      UI.toast('Export already in progress', 'error');
      return;
    }

    const text = document.getElementById('qtTextarea').value.trim();
    if (!text) {
      UI.toast('Paste some text first', 'error');
      return;
    }

    const voiceId = document.getElementById('qtVoice').value || 'en-US-AriaNeural';
    const speed   = parseFloat(document.getElementById('qtSpeed').value) || 1.0;

    const savePath = await window.sonara.export.saveDialog('QuickText');
    if (!savePath) return;

    _isExporting = true;
    _cancelled   = false;
    _setExportBtnsDisabled(true);

    const segments = _splitText(text);

    // Reuse the shared export badge UI
    _showExportBadge('Quick Text', segments.length, voiceId);

    const audioChunks = [];
    let   failCount   = 0;

    for (let i = 0; i < segments.length; i++) {
      if (_cancelled) break;
      _updateExportProgress(i, segments.length, `Part ${i + 1} of ${segments.length}`);

      try {
        const result = await window.sonara.tts.synthesize({
          text:  segments[i],
          voice: voiceId,
          speed,
          pitch: 1.0
        });
        if (result?.audio) audioChunks.push(result.audio);
      } catch {
        failCount++;
      }
    }

    _isExporting = false;
    _setExportBtnsDisabled(false);

    if (_cancelled) {
      _hideExportBadge();
      UI.toast('Export cancelled', 'error');
      return;
    }

    if (!audioChunks.length) {
      _hideExportBadge();
      UI.toast('Export failed — no audio generated. Check internet connection.', 'error', 5000);
      return;
    }

    _updateExportProgress(segments.length, segments.length, 'Writing MP3…');
    try {
      await window.sonara.export.writeFile({ path: savePath, chunks: audioChunks });
      _hideExportBadge();
      const fname = savePath.split('\\').pop().split('/').pop();
      const warn  = failCount ? ` (${failCount} section(s) skipped)` : '';
      UI.toast(`Saved: ${fname}${warn}`, 'success', 6000);
    } catch (err) {
      _hideExportBadge();
      UI.toast('Failed to save file: ' + err.message, 'error');
    }
  }

  // ── EXPORT BADGE HELPERS (reuse existing badge DOM) ───────
  function _friendlyVoice(id) {
    const m = id.match(/^([a-z]{2}-[A-Z]{2})-([A-Za-z]+)Neural$/);
    return m ? `${m[2]} (Neural) · ${m[1]}` : id;
  }

  function _showExportBadge(title, total, voice) {
    document.getElementById('exportModalTitle').textContent = title;
    document.getElementById('exportVoiceName').textContent  = _friendlyVoice(voice);
    document.getElementById('exportDone').textContent       = '0';
    document.getElementById('exportTotal').textContent      = total;
    document.getElementById('exportStatus').textContent     = 'Starting…';
    document.getElementById('exportPct').textContent        = '0%';
    document.getElementById('exportProgFill').style.width   = '0%';
    const btn = document.getElementById('exportCancelBtn');
    btn.disabled = false;
    btn.onclick  = () => { _cancelled = true; btn.disabled = true; };
    document.getElementById('exportBadge').style.display = 'flex';
  }

  function _hideExportBadge() {
    document.getElementById('exportBadge').style.display = 'none';
    // Restore original cancel handler for ExportMP3
    document.getElementById('exportCancelBtn').onclick = () => ExportMP3.cancel();
  }

  function _updateExportProgress(done, total, label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('exportDone').textContent     = done;
    document.getElementById('exportTotal').textContent    = total;
    document.getElementById('exportStatus').textContent   = label;
    document.getElementById('exportPct').textContent      = pct + '%';
    document.getElementById('exportProgFill').style.width = pct + '%';
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _splitText(text) {
    if (!text || !text.trim()) return [];
    if (text.length <= MAX_SEGMENT) return [text.trim()];

    const parts = [];
    let rem = text.trim();

    while (rem.length > MAX_SEGMENT) {
      let splitAt  = MAX_SEGMENT;
      let bestBreak = -1;
      for (const mark of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
        const idx = rem.lastIndexOf(mark, MAX_SEGMENT - 1);
        if (idx > bestBreak && idx > MAX_SEGMENT * 0.4) bestBreak = idx + mark.length;
      }
      if (bestBreak > 0) splitAt = bestBreak;
      parts.push(rem.slice(0, splitAt).trim());
      rem = rem.slice(splitAt).trim();
    }

    if (rem.length > 0) parts.push(rem);
    return parts;
  }

  function _setStatus(msg) {
    const el = document.getElementById('qtStatus');
    if (el) el.textContent = msg;
  }

  function _setPlayState(playing) {
    _isPlaying = playing;
    const btn   = document.getElementById('qtPlayBtn');
    const icon  = document.getElementById('qtPlayIcon');
    const label = document.getElementById('qtPlayLabel');
    if (!btn) return;

    btn.classList.toggle('playing', playing);

    if (playing) {
      icon.innerHTML  = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      label.textContent = 'Pause';
    } else {
      icon.innerHTML  = '<polygon points="5 3 19 12 5 21 5 3"/>';
      label.textContent = 'Listen';
    }
  }

  function _setExportBtnsDisabled(disabled) {
    const b = document.getElementById('qtExportBtn');
    if (b) b.disabled = disabled;
  }

  return { open, close, togglePlay, exportMp3 };
})();
