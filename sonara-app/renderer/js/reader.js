/* ══════════════════════════════════════════════════════════
   READER.JS — TTS engine + word highlight + waveform
══════════════════════════════════════════════════════════ */
'use strict';

const Reader = (() => {

  // ── STATE ─────────────────────────────────────────────────
  let chunks         = [];
  let currentChunk   = 0;
  let isPlaying      = false;
  let speed          = 1.0;
  let pitch          = 1.0;
  let chosenVoice    = null;
  let voiceList      = [];
  let totalDuration  = 0;
  let elapsedTime    = 0;
  let timerInterval  = null;
  let waveAnimId     = null;
  let utterance      = null;
  let wordSpans      = [];      // flat array of all word <span> elements
  let sentenceMap    = [];      // [ { startWord, endWord, el } ]
  let currentWordIdx = 0;
  let bookId         = null;
  let autoSaveEvery  = 10;      // save every N chunks
  let saveTimer      = null;

  // ── VOICES ───────────────────────────────────────────────
  function initVoices() {
    console.log('[Reader] Initializing voices...');
    const load = () => {
      const v = speechSynthesis.getVoices();
      console.log('[Reader] Voices loaded:', v.length);
      if (!v.length) return;
      voiceList = v;
      _populateLangFilter();
      renderVoiceList();
      if (!chosenVoice) _pickDefaultVoice();
      else _updateVoiceBar(); // Update UI if voice already selected from settings
    };
    
    // Initial load
    load();
    
    // Set up voice change listener (essential for Chrome/Edge where voices load async)
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = load;
    }
    
    // Retry after delays to catch late-loading voices (Safari, Firefox)
    setTimeout(load, 500);
    setTimeout(load, 1000);
    setTimeout(load, 2000);
  }

  function _pickDefaultVoice() {
    if (!voiceList.length) {
      console.log('[Reader] No voices available yet');
      return;
    }
    
    // Priority list matches reference HTML for best English voices
    const priority = [
      'Samantha', 'Google UK English Female', 'Google US English',
      'Microsoft Zira', 'Karen', 'Moira', 'Tessa', 'Fiona', 'Victoria', 'Alex', 'Daniel'
    ];
    
    // Try priority names first
    for (const name of priority) {
      const v = voiceList.find(x => x.name === name || x.name.includes(name));
      if (v) { 
        chosenVoice = v; 
        console.log('[Reader] Default voice selected:', v.name);
        _updateVoiceBar(); 
        return; 
      }
    }
    
    // Fallback: first English voice
    const englishVoice = voiceList.find(v => v.lang.startsWith('en'));
    if (englishVoice) {
      chosenVoice = englishVoice;
      console.log('[Reader] Default English voice selected:', englishVoice.name);
    } else if (voiceList[0]) {
      // Last resort: any voice
      chosenVoice = voiceList[0];
      console.log('[Reader] Default to first available voice:', voiceList[0].name);
    }
    
    _updateVoiceBar();
  }

  function _populateLangFilter() {
    const sel = document.getElementById('langFilter');
    if (!sel) return;
    
    const existing = new Set([...sel.options].map(o => o.value));
    const langs = [...new Set(voiceList.map(v => v.lang.split('-')[0].toUpperCase()))].sort();
    
    langs.forEach(l => {
      if (!existing.has(l) && l) {
        const o = document.createElement('option');
        o.value = l; 
        o.textContent = l; 
        sel.appendChild(o);
      }
    });
    
    console.log('[Reader] Language filter populated with', langs.length, 'languages');
  }

  function filterVoices() { 
    console.log('[Reader] Filtering voices');
    renderVoiceList(); 
  }

  function renderVoiceList() {
    const search = document.getElementById('voiceSearch')?.value.toLowerCase() || '';
    const lang   = document.getElementById('langFilter')?.value.toUpperCase() || '';
    
    if (!voiceList.length) {
      console.log('[Reader] No voices to render yet');
      document.getElementById('voiceList').innerHTML = '<div class="voice-loading">Loading voices…</div>';
      return;
    }
    
    const filtered = voiceList
      .filter(v => {
        const matchSearch = !search || v.name.toLowerCase().includes(search) || v.lang.toLowerCase().includes(search);
        const matchLang   = !lang   || v.lang.toUpperCase().startsWith(lang);
        return matchSearch && matchLang;
      })
      .sort((a, b) => {
        // English voices first, then alphabetical
        const aIsEn = a.lang.startsWith('en') ? 0 : 1;
        const bIsEn = b.lang.startsWith('en') ? 0 : 1;
        if (aIsEn !== bIsEn) return aIsEn - bIsEn;
        return a.name.localeCompare(b.name);
      });

    const el = document.getElementById('voiceList');
    if (!el) return;
    
    if (!filtered.length) { 
      el.innerHTML = '<div class="voice-empty-msg">No voices match your search.</div>'; 
      return; 
    }

    el.innerHTML = filtered.map((v, i) => {
      const sel = chosenVoice && chosenVoice.name === v.name;
      return `<div class="voice-item${sel ? ' selected' : ''}" onclick="Reader.selectVoice(${JSON.stringify(v.name)})">
        <div class="vi-radio"></div>
        <div class="vi-info">
          <div class="vi-name">${_escHtml(v.name)}</div>
          <div class="vi-lang">${_escHtml(v.lang)}</div>
        </div>
        <div class="vi-badges">
          ${v.lang.startsWith('en') ? '<span class="vi-badge badge-en">EN</span>' : ''}
          <span class="vi-badge ${v.localService ? 'badge-local' : 'badge-remote'}">${v.localService ? 'LOCAL' : 'CLOUD'}</span>
        </div>
        <button class="vi-pbtn" onclick="event.stopPropagation();Reader.previewVoice(${JSON.stringify(v.name)})">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    }).join('');
  }

  function selectVoice(name) {
    console.log('[Reader] Selecting voice:', name);
    const v = voiceList.find(x => x.name === name);
    if (!v) {
      console.error('[Reader] Voice not found:', name);
      return;
    }
    
    chosenVoice = v;
    renderVoiceList();
    _updateVoiceBar();
    
    // Save to settings
    window.sonara?.settings.set('voice', name);
    console.log('[Reader] Voice saved to settings:', name);
    
    // If currently playing, switch voice live
    if (isPlaying) { 
      console.log('[Reader] Switching voice during playback');
      speechSynthesis.cancel(); 
      _speakChunk(currentChunk); 
    }
    
    UI.toast('Voice: ' + v.name, 'success');
  }

  function _updateVoiceBar() {
    if (!chosenVoice) {
      console.log('[Reader] No voice selected for UI update');
      return;
    }
    
    const nameEl = document.getElementById('vsbName');
    const langEl = document.getElementById('vsbLang');
    
    if (nameEl) nameEl.textContent = chosenVoice.name;
    if (langEl) langEl.textContent = chosenVoice.lang + (chosenVoice.localService ? ' · Local' : ' · Cloud');
    
    console.log('[Reader] Voice bar updated:', chosenVoice.name);
  }

  function previewVoice(name) {
    console.log('[Reader] Previewing voice:', name);
    const v = voiceList.find(x => x.name === name);
    if (!v) {
      console.error('[Reader] Voice not found for preview:', name);
      UI.toast('Voice not found', 'error');
      return;
    }
    
    // Stop any current speech
    speechSynthesis.cancel();
    
    // Create preview utterance with same text as reference HTML
    const previewText = 'Hello, my name is ' + v.name.split(' ')[0] + '. I will read your book aloud with this voice.';
    const u = new SpeechSynthesisUtterance(previewText);
    u.voice = v;
    u.rate = speed; 
    u.pitch = pitch;
    u.volume = 1.0;
    
    u.onerror = (e) => {
      console.error('[Reader] Preview error:', e);
      UI.toast('Preview failed: ' + e.error, 'error');
    };
    
    u.onstart = () => {
      console.log('[Reader] Preview started');
    };
    
    u.onend = () => {
      console.log('[Reader] Preview complete');
    };
    
    speechSynthesis.speak(u);
  }

  function previewSelectedVoice() {
    if (!chosenVoice) {
      console.log('[Reader] No voice selected to preview');
      UI.toast('Please select a voice first', 'error');
      return;
    }
    console.log('[Reader] Previewing selected voice:', chosenVoice.name);
    previewVoice(chosenVoice.name);
  }

  // ── LOAD BOOK ────────────────────────────────────────────
  function loadBook(newChunks, newBookId, resumeData) {
    console.log('[Reader] ========== LOAD BOOK ==========');
    console.log('[Reader] bookId:', newBookId);
    console.log('[Reader] chunks:', newChunks.length);
    console.log('[Reader] resumeData:', resumeData);
    
    // Stop any current playback
    stop();

    chunks       = newChunks;
    bookId       = newBookId;
    currentChunk = resumeData?.chunk_index || 0;
    elapsedTime  = resumeData?.elapsed_seconds || 0;
    currentWordIdx = 0;
    
    console.log('[Reader] ✓ Set currentChunk to:', currentChunk);
    console.log('[Reader] ✓ Set elapsedTime to:', elapsedTime);
    console.log('[Reader] Total chunks:', chunks.length);
    console.log('[Reader] Progress:', Math.round((currentChunk / chunks.length) * 100) + '%');
    console.log('[Reader] =======================================');

    // Build chapter list
    _buildChapterList();

    // Estimate total duration
    const words = chunks.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
    totalDuration = Math.round((words / (150 * speed)) * 60);
    document.getElementById('pbTimeTotal').textContent = _fmt(totalDuration);

    // Show first chunk
    _renderChunkText(currentChunk);
    _updateChapterTitleBar(currentChunk);
    _highlightChapterItem(currentChunk);
    _updateSeekBar();
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);

    // Start waveform
    _drawWaveform();
  }

  // ── RENDER CHUNK TEXT (word spans) ────────────────────────
  function _renderChunkText(idx) {
    const chunk = chunks[idx];
    if (!chunk) return;

    const container = document.getElementById('readerText');
    const text      = chunk.text;

    // Split into sentences, then words, build spans
    // A "sentence" is delimited by . ! ? — used for background highlight
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    wordSpans   = [];
    sentenceMap = [];

    let wordGlobalIdx = 0;
    const html = sentences.map((sentence, si) => {
      const words = sentence.split(/(\s+)/);
      let sentStartIdx = wordGlobalIdx;
      const wordHtml = words.map(tok => {
        if (/^\s+$/.test(tok)) return tok; // whitespace — preserve
        const idx = wordGlobalIdx++;
        return `<span class="word word-unspoken" data-wi="${idx}">${_escHtml(tok)}</span>`;
      }).join('');
      sentenceMap.push({ start: sentStartIdx, end: wordGlobalIdx - 1 });
      return `<span class="sentence" data-si="${si}">${wordHtml}</span>`;
    }).join(' ');

    container.innerHTML = html;

    // Cache span references
    wordSpans = [...container.querySelectorAll('.word')];

    // Show the reader
    document.getElementById('readerWelcome').style.display   = 'none';
    document.getElementById('chapterTitlebar').style.display = 'flex';
    document.getElementById('readerTextWrap').style.display  = 'flex';
  }

  // ── WORD HIGHLIGHT (onboundary) ───────────────────────────
  function _highlightWord(charIndex) {
    // Find the word span whose charIndex corresponds
    // We walk wordSpans by accumulated charIndex
    if (!wordSpans.length) return;

    // Find which word contains this charIndex
    let acc = 0;
    const chunkText = chunks[currentChunk]?.text || '';
    let targetIdx = 0;
    for (let i = 0; i < wordSpans.length; i++) {
      const word = wordSpans[i].textContent;
      if (acc + word.length > charIndex) { targetIdx = i; break; }
      acc += word.length + 1; // +1 for space
    }

    if (targetIdx === currentWordIdx && wordSpans[targetIdx]?.classList.contains('word-active')) return;

    // Clear previous active
    if (wordSpans[currentWordIdx]) {
      wordSpans[currentWordIdx].classList.remove('word-active');
      wordSpans[currentWordIdx].classList.add('word-spoken');
    }

    currentWordIdx = targetIdx;

    // Mark active word
    const activeSpan = wordSpans[currentWordIdx];
    if (activeSpan) {
      activeSpan.classList.remove('word-unspoken', 'word-spoken');
      activeSpan.classList.add('word-active');

      // Sentence background highlight
      const si = parseInt(activeSpan.closest('.sentence')?.dataset?.si ?? '-1');
      document.querySelectorAll('.sentence').forEach((s, i) => {
        s.classList.toggle('sentence-active', i === si);
      });

      // Auto-scroll to keep word visible
      activeSpan.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function _clearWordHighlight() {
    wordSpans.forEach(s => {
      s.classList.remove('word-active', 'word-spoken');
      s.classList.add('word-unspoken');
    });
    document.querySelectorAll('.sentence').forEach(s => s.classList.remove('sentence-active'));
    currentWordIdx = 0;
  }

  // ── PLAYBACK ─────────────────────────────────────────────
  function togglePlay() {
    console.log('[Reader] togglePlay called, isPlaying:', isPlaying);
    isPlaying ? _pause() : _play();
  }

  function _play() {
    console.log('[Reader] Play button clicked. Chunks loaded:', chunks.length);
    if (!chunks.length) {
      console.log('[Reader] No book loaded - cannot play');
      UI.toast('Please add a book first', 'error');
      return;
    }
    
    // Try to pick a voice if none selected
    if (!chosenVoice && voiceList.length > 0) {
      console.log('[Reader] No voice selected, picking default...');
      _pickDefaultVoice();
    }
    
    // If still no voice, wait for voices to load
    if (!chosenVoice) {
      console.log('[Reader] No voice available yet, trying to load...');
      UI.toast('Voices are loading, please wait a moment...', '');
      
      // Retry after 1 second
      setTimeout(() => {
        if (voiceList.length > 0) {
          _pickDefaultVoice();
          _play(); // Try again
        } else {
          UI.toast('No voices available. Please check your system settings.', 'error');
        }
      }, 1000);
      return;
    }
    
    if (currentChunk >= chunks.length) { currentChunk = 0; elapsedTime = 0; }
    console.log('[Reader] Starting playback, chunk:', currentChunk, 'voice:', chosenVoice?.name);
    isPlaying = true;
    _updatePlayIcon(true);
    _speakChunk(currentChunk);
    _startTimer();
  }

  function _pause() {
    isPlaying = false;
    _updatePlayIcon(false);
    speechSynthesis.pause();
    _stopTimer();
    _saveProgress();
  }

  function stop() {
    isPlaying = false;
    speechSynthesis.cancel();
    _stopTimer();
    _updatePlayIcon(false);
    _clearWordHighlight();
  }

  function _speakChunk(idx) {
    if (idx >= chunks.length) {
      // Book finished
      isPlaying = false;
      _updatePlayIcon(false);
      _stopTimer();
      _saveProgress(true);
      UI.toast('🎉 Book complete!', 'success');
      return;
    }

    speechSynthesis.cancel();
    currentChunk = idx;
    console.log('[Reader] _speakChunk - Setting currentChunk to:', idx, 'of', chunks.length);
    _renderChunkText(idx);
    _updateChapterTitleBar(idx);
    _highlightChapterItem(idx);
    _clearWordHighlight();
    document.getElementById('pbChapterLabel').textContent = chunks[idx].title || ('Section ' + (idx + 1));

    // Auto-save periodically
    if (idx % autoSaveEvery === 0) {
      console.log('[Reader] Auto-save trigger at chunk', idx);
      _saveProgress();
    }

    // Ensure we have a voice selected
    if (!chosenVoice && voiceList.length > 0) {
      console.log('[Reader] No voice selected, picking default');
      _pickDefaultVoice();
    }

    const u = new SpeechSynthesisUtterance(chunks[idx].text);
    u.rate   = speed;
    u.pitch  = pitch;
    u.volume = 1.0;
    
    // Set voice - ensure it's valid
    if (chosenVoice) {
      u.voice = chosenVoice;
      console.log('[Reader] Speaking with voice:', chosenVoice.name);
    } else {
      console.warn('[Reader] No voice available - using system default');
    }

    // ── WORD BOUNDARY ──
    u.onboundary = (e) => {
      if (e.name === 'word') _highlightWord(e.charIndex);
    };

    u.onend = () => {
      console.log('[Reader] Chunk', idx, 'finished. Moving to next chunk.');
      // Save progress when finishing a chunk
      _saveProgress();
      if (isPlaying) _speakChunk(idx + 1);
    };

    u.onerror = (e) => {
      console.error('[Reader] Speech error:', e.error);
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        UI.toast('Speech error: ' + e.error, 'error');
      }
    };

    utterance = u;
    speechSynthesis.speak(u);
  }

  function skipChunk(dir) {
    const next = Math.max(0, Math.min(chunks.length - 1, currentChunk + dir));
    currentChunk = next;
    elapsedTime  = Math.round((next / chunks.length) * totalDuration);
    _updateSeekBar();
    if (isPlaying) _speakChunk(next);
    else {
      _renderChunkText(next);
      _updateChapterTitleBar(next);
      _highlightChapterItem(next);
    }
  }

  function jumpToChunk(idx) {
    currentChunk = idx;
    elapsedTime  = Math.round((idx / chunks.length) * totalDuration);
    _updateSeekBar();
    _renderChunkText(idx);
    _updateChapterTitleBar(idx);
    _highlightChapterItem(idx);
    if (isPlaying) _speakChunk(idx);
  }

  function seekAudio(val) {
    const ratio  = val / 100;
    elapsedTime  = Math.round(ratio * totalDuration);
    const target = Math.floor(ratio * chunks.length);
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);
    jumpToChunk(Math.max(0, Math.min(target, chunks.length - 1)));
  }

  function cycleSpeed() {
    const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
    const i = speeds.findIndex(s => Math.abs(s - speed) < 0.01);
    speed = speeds[(i + 1) % speeds.length];
    document.getElementById('pbSpeedLabel').textContent = speed + '×';
    document.getElementById('speedSlider').value = speed;
    document.getElementById('speedVal').textContent = speed + '×';
    window.sonara?.settings.set('speed', speed);
    if (isPlaying) { speechSynthesis.cancel(); _speakChunk(currentChunk); }
  }

  function onSpeedChange(val) {
    speed = parseFloat(val);
    document.getElementById('speedVal').textContent = speed.toFixed(2) + '×';
    document.getElementById('pbSpeedLabel').textContent = speed.toFixed(1) + '×';
    window.sonara?.settings.set('speed', speed);
    // Recalculate total duration
    const words = chunks.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
    totalDuration = Math.round((words / (150 * speed)) * 60);
    document.getElementById('pbTimeTotal').textContent = _fmt(totalDuration);
  }

  function onPitchChange(val) {
    pitch = parseFloat(val);
    document.getElementById('pitchVal').textContent = pitch.toFixed(1);
    window.sonara?.settings.set('pitch', pitch);
  }

  // ── TIMER ─────────────────────────────────────────────────
  function _startTimer() {
    _stopTimer();
    timerInterval = setInterval(() => {
      if (isPlaying && elapsedTime < totalDuration) {
        elapsedTime++;
        document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);
        _updateSeekBar();
      }
    }, 1000);
  }

  function _stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
  }

  // ── CHAPTER LIST ──────────────────────────────────────────
  function _buildChapterList() {
    const isEpub   = chunks.length > 0 && chunks[0].source === 'epub';
    const label    = isEpub ? 'Chapters' : 'Sections';
    document.getElementById('chaptersLabel').textContent = label;
    document.getElementById('chaptersCount').textContent = chunks.length;

    const el = document.getElementById('chaptersList');
    el.innerHTML = chunks.map((c, i) => `
      <div class="chapter-item${i === 0 ? ' active' : ''}" id="ch-item-${i}" onclick="Reader.jumpToChunk(${i})">
        <span class="ci-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="ci-dot"></span>
        <span class="ci-name">${_escHtml(c.title || (label.slice(0,-1) + ' ' + (i+1)))}</span>
        <span class="ci-dur">${_estimateDur(c.text)}</span>
      </div>`
    ).join('');
  }

  function _highlightChapterItem(idx) {
    document.querySelectorAll('.chapter-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    document.getElementById('ch-item-' + idx)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function _updateChapterTitleBar(idx) {
    const c    = chunks[idx];
    const pct  = chunks.length > 0 ? Math.round((idx / chunks.length) * 100) : 0;
    const isEpub = chunks.length > 0 && chunks[0].source === 'epub';
    document.getElementById('ctbNum').textContent   = String(idx + 1).padStart(2, '0');
    document.getElementById('ctbTitle').textContent = c?.title || (isEpub ? 'Chapter ' : 'Page ') + (idx + 1);
    document.getElementById('ctbProgress').textContent = pct + '% complete';
    document.getElementById('ctbBarFill').style.width  = pct + '%';

    // Top bar center
    document.getElementById('tbCenter').textContent = c?.title || '';

    // Reader header badge
    document.getElementById('readerProgBadge')?.textContent && (document.getElementById('readerProgBadge').textContent = pct + '%');
  }

  // ── WAVEFORM ──────────────────────────────────────────────
  function _drawWaveform() {
    const canvas = document.getElementById('waveCanvas');
    const wrap   = canvas.parentElement;
    canvas.width  = wrap.clientWidth * 2;
    canvas.height = wrap.clientHeight * 2;

    const draw = () => {
      const ctx     = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const bars    = 60, bw = W / bars;
      const progress = totalDuration > 0 ? elapsedTime / totalDuration : 0;
      const t       = Date.now() * 0.0018;

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < bars; i++) {
        const n      = i / bars;
        const played = n < progress;
        const act    = isPlaying && Math.abs(n - progress) < 0.05;
        const h      = (Math.sin(n * Math.PI * 6 + t) * 0.35 + Math.sin(n * Math.PI * 11 + t * 1.4) * 0.2 + 0.5) * 0.7 + 0.1;
        const bh     = h * H * (act ? 1.2 : 1);
        const x      = i * bw + 1, y = (H - bh) / 2;

        if (played) {
          const g = ctx.createLinearGradient(0, y, 0, y + bh);
          g.addColorStop(0, act ? 'rgba(232,200,138,.95)' : 'rgba(200,169,110,.8)');
          g.addColorStop(1, 'rgba(155,122,78,.4)');
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = 'rgba(39,39,54,.8)';
        }
        ctx.beginPath();
        ctx.roundRect(x, y, bw - 2, bh, 2);
        ctx.fill();
      }
      waveAnimId = requestAnimationFrame(draw);
    };

    if (waveAnimId) cancelAnimationFrame(waveAnimId);
    draw();
  }

  // ── PROGRESS SAVE ─────────────────────────────────────────
  function _saveProgress(finished = false) {
    if (!bookId || !chunks.length) return;
    const percent = finished ? 100 : Math.round((currentChunk / chunks.length) * 100);
    console.log('[Reader] Saving progress - bookId:', b