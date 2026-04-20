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
  let volume         = 1.0;
  let lastVolumeBeforeMute = 1.0;
  let volumeApplyTimer = null;

  // ── Reader display preferences ─────────────────────────
  const FONT_MAP = {
    serif:   "'Playfair Display', Georgia, serif",
    sans:    "'Outfit', system-ui, sans-serif",
    georgia: "Georgia, 'Times New Roman', serif",
    mono:    "'Courier New', Courier, monospace",
  };
  let readerFont      = 'serif';
  let readerFontSize  = 17;     // px
  let readerLineH     = 2.0;
  let readerMaxWidth  = 680;    // px
  let chosenVoice          = null;
  let pendingRestoreVoice  = null;  // voice name/ID to restore once cloud voices load
  let _playPendingRetries  = 0;     // guard: max retries waiting for saved voice in _play()
  let voiceList      = [];
  let favoriteVoiceIds = new Set(); // stable voice IDs user starred as favorites
  let favoriteSaveChain = Promise.resolve();
  let totalDuration  = 0;
  let elapsedTime    = 0;
  let timerInterval  = null;
  let waveAnimId     = null;
  let utterance      = null;
  let wordSpans      = [];      // flat array of all word <span> elements
  let wordTtsOffsets = [];      // char offset of each wordSpan in the cleaned TTS text
  let sentenceMap    = [];      // [ { startWord, endWord, el } ]
  let currentWordIdx = 0;
  let bookId         = null;
  let autoSaveEvery  = 10;      // save every N chunks
  let saveTimer      = null;

  // Audiobook mode state
  let audioMode      = false;
  let audioElement   = null;
  let audioBookData  = null;

  // TTS skip characters — stripped from text before speaking
  let ttsSkipChars   = '';   // raw string of chars; built into regex on use
  let ttsSkipEnabled = true; // master on/off toggle
  let ttsSkipWords   = '';   // comma-separated words to skip (whole-word, case-insensitive)
  let currentCoverPath = '';

  // PDF visual mode state
  let pdfMode        = false;
  let pdfZoom        = 1.0;
  let pdfCurrentPage = 1;   // 1-based page number for rendering
  let pdfRendering   = false;
  let pdfTextLayerData = null;  // { spans, offsetMap } for on-page highlighting

  // PDF manual highlights state
  let pdfHighlights  = [];      // Saved highlights for current book
  let selectedHighlight = null; // Currently selected highlight for editing

  // ── VOICES ───────────────────────────────────────────────
  function initVoices() {
    let loadCount = 0;
    let maxVoices = 0;

    const load = () => {
      const v = speechSynthesis.getVoices();
      loadCount++;

      if (v.length > maxVoices) {
        maxVoices = v.length;

        const localCount = v.filter(voice => voice.localService).length;
        const cloudCount = v.length - localCount;
      }

      if (!v.length && loadCount < 5) {
        return;
      }

      // Always merge with Edge TTS neural voices
      _mergeVoices(v);
    };

    // Merge system voices with Edge TTS neural voices
    const _mergeVoices = (systemVoices) => {
      const cloudVoices = CloudTTS.getVoices();
      // Cloud voices first (better quality), then system voices
      if (cloudVoices.length > 0) {
        voiceList = [...cloudVoices, ...systemVoices];
      } else {
        voiceList = systemVoices;
      }

      _populateLangFilter();
      renderVoiceList();

      // Always try to restore pending saved voice before picking default
      if (pendingRestoreVoice) {
        const v = _findVoiceByIdOrName(pendingRestoreVoice);
        if (v) {
          chosenVoice = v;
          pendingRestoreVoice = null;
          _playPendingRetries = 0;
          _updateVoiceBar();
          renderVoiceList();
          // Player may have already started with the wrong default voice while cloud
          // voices were loading. Restart the current chunk with the correct voice now.
          if (isPlaying) {
            speechSynthesis.cancel();
            CloudTTS.stop();
            _speakChunk(currentChunk);
          }
          return;
        }
        // Voice not found yet — if cloud voices have loaded, it truly doesn't exist
        if (cloudVoices.length > 0) {
          pendingRestoreVoice = null;
          _playPendingRetries = 0;
          if (!chosenVoice) _pickDefaultVoice();
          else _updateVoiceBar();
        }
        // If cloud voices haven't loaded yet, keep pendingRestoreVoice and wait
        return;
      }

      if (!chosenVoice) _pickDefaultVoice();
      else _updateVoiceBar();
    };

    // 1. Register word boundary callback for Edge TTS highlighting
    if (CloudTTS && CloudTTS.onBoundary) {
      CloudTTS.onBoundary((textOffset, textLength, wordText) => {
        _highlightWord(textOffset);
      });
    }

    // 2. Load Edge TTS neural voices (async, from main process)
    if (CloudTTS && CloudTTS.loadVoices) {
      CloudTTS.loadVoices().then((cloudVoices) => {
        // Re-merge with whatever system voices we have
        const sysVoices = speechSynthesis.getVoices();
        _mergeVoices(sysVoices);
      }).catch(err => {
        // Cloud TTS load failed — unblock playback so user isn't stuck waiting
        pendingRestoreVoice = null;
        _playPendingRetries = 0;
        if (!chosenVoice && voiceList.length) _pickDefaultVoice();
      });
    }

    // 3. Also load system voices as fallback
    load();

    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => {
        load();
      };
    }

    // 4. Force trigger with dummy utterances (helps Chrome/Electron)
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        const dummy = new SpeechSynthesisUtterance('');
        speechSynthesis.speak(dummy);
        speechSynthesis.cancel();
      }, i * 100);
    }

    // 5. Retry schedule for system voices
    const retrySchedule = [200, 500, 1000, 2000, 5000];
    retrySchedule.forEach(delay => {
      setTimeout(load, delay);
    });
  }
  
  async function refreshVoices() {
    const v = speechSynthesis.getVoices();

    // Reload Edge TTS voices
    let cloudVoices = CloudTTS.getVoices();
    if (CloudTTS.loadVoices) {
      try {
        cloudVoices = await CloudTTS.loadVoices();
      } catch (err) {
      }
    }

    // Merge: neural voices first, then system
    voiceList = [...cloudVoices, ...v];

    const neuralCount = cloudVoices.length;
    const systemCount = v.length;

    _populateLangFilter();
    renderVoiceList();
    if (!chosenVoice) _pickDefaultVoice();

    UI.toast(`Found ${voiceList.length} voices (${neuralCount} natural, ${systemCount} system)`, 'success');
  }

  // Match a voice by stable shortName/edgeVoice ID or by display name (legacy saves).
  function _findVoiceByIdOrName(id) {
    if (!id || !voiceList.length) return null;
    return voiceList.find(x =>
      x.shortName === id ||
      x._edgeVoice === id ||
      x.voiceURI  === id ||
      x.name      === id
    ) || null;
  }

  function _pickDefaultVoice() {
    if (!voiceList.length) {
      return;
    }

    // Priority: Edge TTS neural voices with best English voices first
    const neuralPriority = [
      'en-US-AriaNeural',           // Female, warm and natural
      'en-US-JennyNeural',          // Female, friendly
      'en-US-GuyNeural',            // Male, natural
      'en-US-DavisNeural',          // Male, conversational
      'en-GB-SoniaNeural',          // Female, British
      'en-GB-RyanNeural',           // Male, British
      'en-US-ChristopherNeural',    // Male, professional
      'en-US-MichelleNeural',       // Female, clear
    ];

    // Try neural voices first (best quality)
    for (const shortName of neuralPriority) {
      const v = voiceList.find(x => x._edgeVoice === shortName || x.shortName === shortName);
      if (v) {
        chosenVoice = v;
        _updateVoiceBar();
        return;
      }
    }

    // Fallback: Any English neural voice
    const neuralEn = voiceList.find(v => v._cloudVoice && v.lang && v.lang.startsWith('en'));
    if (neuralEn) {
      chosenVoice = neuralEn;
      _updateVoiceBar();
      return;
    }

    // Fallback: System voices
    const systemPriority = [
      'Google UK English Female', 'Google US English',
      'Microsoft Zira', 'Samantha', 'Microsoft David'
    ];
    for (const name of systemPriority) {
      const v = voiceList.find(x => x.name === name || x.name.includes(name));
      if (v) {
        chosenVoice = v;
        _updateVoiceBar();
        return;
      }
    }

    // Any English voice
    const anyEn = voiceList.find(v => v.lang && v.lang.startsWith('en'));
    if (anyEn) {
      chosenVoice = anyEn;
      _updateVoiceBar();
      return;
    }

    // Last resort
    chosenVoice = voiceList[0];
    _updateVoiceBar();
  }

  function _findFallbackVoice(targetLang) {
    // Find a system voice (not cloud) that matches the target language
    const systemVoices = speechSynthesis.getVoices().filter(v => v.localService);
    
    // Try exact language match first (e.g., en-US)
    let fallback = systemVoices.find(v => v.lang === targetLang);
    if (fallback) return fallback;
    
    // Try language prefix match (e.g., en)
    const langPrefix = targetLang.split('-')[0];
    fallback = systemVoices.find(v => v.lang.startsWith(langPrefix));
    if (fallback) return fallback;
    
    // Fallback to any English voice
    fallback = systemVoices.find(v => v.lang.startsWith('en'));
    if (fallback) return fallback;
    
    // Last resort: first system voice
    return systemVoices[0] || null;
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
    
  }

  function filterVoices() {
    renderVoiceList();
  }

  function _getVoiceId(voice) {
    if (!voice) return '';
    return voice.shortName || voice._edgeVoice || voice.voiceURI || voice.name || '';
  }

  function _isFavoriteVoice(voice) {
    const id = _getVoiceId(voice);
    return !!id && favoriteVoiceIds.has(id);
  }

  function _renderVoiceItem(v) {
    const voiceId = _getVoiceId(v) || v.name;
    const sel = chosenVoice && chosenVoice.name === v.name;
    const isNatural = !!v._edgeVoice;
    const isCloud = !v.localService;
    const serviceType = isNatural ? 'NATURAL' : (v.localService ? 'LOCAL' : 'CLOUD');
    const serviceBadge = isNatural ? 'badge-natural' : (v.localService ? 'badge-local' : 'badge-remote');
    const tooltip = isNatural ? 'Microsoft Neural voice - high quality, natural sounding'
      : (v.localService ? 'Offline voice - works without internet' : 'Online voice - requires internet');
    const favorite = _isFavoriteVoice(v);

    return `<div class="voice-item${sel ? ' selected' : ''}" data-voice-id="${_escHtml(voiceId)}" data-voice-name="${_escHtml(v.name)}" data-voice-type="${isNatural ? 'natural' : (isCloud ? 'cloud' : 'local')}">
      <div class="vi-radio"></div>
      <div class="vi-info">
        <div class="vi-name">${_escHtml(v.name)}</div>
        <div class="vi-lang">${_escHtml(v.lang)}${v.gender ? ' · ' + _escHtml(v.gender) : ''}</div>
      </div>
      <div class="vi-badges">
        ${v.lang && v.lang.startsWith('en') ? '<span class="vi-badge badge-en">EN</span>' : ''}
        <span class="vi-badge ${serviceBadge}" title="${tooltip}">${serviceType}</span>
      </div>
      <button class="vi-fbtn${favorite ? ' active' : ''}" data-favorite-voice="${_escHtml(voiceId)}" title="${favorite ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${favorite ? 'Remove from favorites' : 'Add to favorites'}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
      </button>
      <button class="vi-pbtn" data-preview-voice="${_escHtml(voiceId)}" title="Preview this voice">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    </div>`;
  }

  function _saveFavoriteVoices() {
    const snapshot = [...favoriteVoiceIds];
    favoriteSaveChain = favoriteSaveChain
      .then(() => window.sonara?.settings.set('favoriteVoices', snapshot))
      .catch(() => {});
    return favoriteSaveChain;
  }

  function toggleFavoriteVoice(idOrName) {
    const v = _findVoiceByIdOrName(idOrName);
    if (!v) {
      UI.toast('Voice not found', 'error');
      return;
    }

    const id = _getVoiceId(v);
    if (!id) {
      UI.toast('Cannot favorite this voice', 'error');
      return;
    }

    if (favoriteVoiceIds.has(id)) {
      favoriteVoiceIds.delete(id);
      UI.toast('Removed from favorites: ' + v.name, '', 1800);
    } else {
      favoriteVoiceIds.add(id);
      UI.toast('Added to favorites: ' + v.name, 'success', 1800);
    }

    _saveFavoriteVoices();
    renderVoiceList();
  }

  function renderVoiceList() {
    const search = document.getElementById('voiceSearch')?.value.toLowerCase() || '';
    const lang   = document.getElementById('langFilter')?.value.toUpperCase() || '';
    
    if (!voiceList.length) {
      const el = document.getElementById('voiceList');
      if (el) el.innerHTML = '<div class="voice-loading">Loading voices…</div>';
      return;
    }
    
    const filtered = voiceList
      .filter(v => {
        const matchSearch = !search || v.name.toLowerCase().includes(search) || v.lang.toLowerCase().includes(search);
        const matchLang   = !lang   || v.lang.toUpperCase().startsWith(lang);
        return matchSearch && matchLang;
      })
      .sort((a, b) => {
        // Natural (Edge TTS) voices first
        const aNat = a._edgeVoice ? 0 : 1;
        const bNat = b._edgeVoice ? 0 : 1;
        if (aNat !== bNat) return aNat - bNat;
        // English voices first within each group
        const aIsEn = a.lang && a.lang.startsWith('en') ? 0 : 1;
        const bIsEn = b.lang && b.lang.startsWith('en') ? 0 : 1;
        if (aIsEn !== bIsEn) return aIsEn - bIsEn;
        return a.name.localeCompare(b.name);
      });

    const el = document.getElementById('voiceList');
    if (!el) return;
    
    if (!filtered.length) { 
      el.innerHTML = '<div class="voice-empty-msg">No voices match your search.</div>'; 
      return; 
    }

    const favorites = filtered.filter(_isFavoriteVoice);
    const others = filtered.filter(v => !_isFavoriteVoice(v));

    const sections = [];
    if (favorites.length) {
      sections.push(
        `<div class="voice-group">` +
          `<div class="voice-group-label">Favorites (${favorites.length})</div>` +
          favorites.map(_renderVoiceItem).join('') +
        `</div>`
      );
    }
    if (others.length) {
      sections.push(
        `<div class="voice-group">` +
          `<div class="voice-group-label">All Voices</div>` +
          others.map(_renderVoiceItem).join('') +
        `</div>`
      );
    }

    el.innerHTML = sections.join('');
    
    // Attach event listeners using event delegation
    _attachVoiceListeners();
  }
  
  function _attachVoiceListeners() {
    const el = document.getElementById('voiceList');
    if (!el) return;
    
    // Remove old listeners
    const oldEl = el.cloneNode(true);
    el.parentNode.replaceChild(oldEl, el);
    const listEl = document.getElementById('voiceList');
    
    // Event delegation for voice item clicks
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.voice-item');
      if (item && !e.target.closest('.vi-pbtn') && !e.target.closest('.vi-fbtn')) {
        const voiceId = item.getAttribute('data-voice-id') || item.getAttribute('data-voice-name');
        if (voiceId) {
          selectVoice(voiceId);
        }
      }
    });

    // Event delegation for favorite buttons
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.vi-fbtn');
      if (btn) {
        e.stopPropagation();
        const voiceId = btn.getAttribute('data-favorite-voice');
        if (voiceId) {
          toggleFavoriteVoice(voiceId);
        }
      }
    });
    
    // Event delegation for preview buttons
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.vi-pbtn');
      if (btn) {
        e.stopPropagation();
        const voiceId = btn.getAttribute('data-preview-voice');
        if (voiceId) {
          previewVoice(voiceId);
        }
      }
    });
  }

  function selectVoice(idOrName) {
    const v = _findVoiceByIdOrName(idOrName);
    if (!v) {
      UI.toast('Voice not found', 'error');
      return;
    }
    
    chosenVoice = v;

    // Update UI immediately
    renderVoiceList();
    _updateVoiceBar();
    
    // Save the stable Edge TTS shortName (e.g. "en-US-AriaNeural") instead of the
    // display name so restore survives any future friendly-name reformatting.
    // Legacy saves (display name) still match via _findVoiceByIdOrName's x.name fallback.
    const saveId = v.shortName || v._edgeVoice || v.voiceURI || v.name;
    window.sonara?.settings.set('voice', saveId).then(() => {
    }).catch(err => {
    });
    
    // If currently playing, switch voice live
    if (isPlaying) {
      speechSynthesis.cancel();
      CloudTTS.stop();
      _speakChunk(currentChunk);
    }
    
    // Show success toast with save confirmation
    UI.toast('✓ Voice saved: ' + v.name, 'success', 2000);
  }

  function _updateVoiceBar() {
    const nameEl = document.getElementById('vsbName');
    const langEl = document.getElementById('vsbLang');
    
    if (!chosenVoice) {
      if (nameEl) nameEl.textContent = 'Loading…';
      if (langEl) langEl.textContent = '';
      return;
    }
    
    if (nameEl) {
      nameEl.textContent = chosenVoice.name;
      // Add visual feedback that voice is saved
      nameEl.style.color = '#c8a96e';
      nameEl.style.fontWeight = '500';
    }
    
    if (langEl) {
      const voiceType = chosenVoice._edgeVoice ? ' · Natural' : (chosenVoice.localService ? ' · Local' : ' · Cloud');
      langEl.textContent = chosenVoice.lang + voiceType;
    }
    
  }

  function previewVoice(idOrName) {
    const v = _findVoiceByIdOrName(idOrName);
    if (!v) {
      UI.toast('Voice not found', 'error');
      return;
    }

    // Stop any current speech
    speechSynthesis.cancel();
    CloudTTS.stop();

    setTimeout(() => {
      // Use real Edge TTS for neural voices
      if (v._cloudVoice && v._edgeVoice) {
        UI.toast('Generating natural voice preview...', '', 2000);
        CloudTTS.preview(v, speed, pitch).then(() => {
        }).catch(err => {
          UI.toast('Preview failed: ' + err.message, 'error');
        });
      } else {
        // System voice — use SpeechSynthesis
        const previewText = 'Hello, my name is ' + v.name.split(' ')[0] + '. I will read your book aloud with this voice.';
        const u = new SpeechSynthesisUtterance(previewText);
        u.voice = v;
        u.rate = speed;
        u.pitch = pitch;
        u.volume = volume;
        u.onerror = (e) => {
          if (e.error !== 'interrupted') {
            UI.toast('Preview failed: ' + e.error, 'error');
          }
        };
        u.onend = () => {};
        speechSynthesis.speak(u);
      }
    }, 100);
  }

  function previewSelectedVoice() {
    if (!chosenVoice) {
      UI.toast('Please select a voice first', 'error');
      return;
    }
    previewVoice(chosenVoice.name);
  }

  // ── PDF VISUAL MODE ─────────────────────────────────────
  async function _showPDFPage(pageNum) {
    if (pdfRendering || !Parser.hasPDFDoc()) return;
    pdfRendering = true;

    const totalPages = Parser.getPDFPageCount();
    if (pageNum < 1) pageNum = 1;
    if (pageNum > totalPages) pageNum = totalPages;
    pdfCurrentPage = pageNum;

    const canvas   = document.getElementById('pdfCanvas');
    const viewer   = document.getElementById('pdfViewer');
    const maxWidth = Math.min(viewer.clientWidth - 48, 800) * pdfZoom;

    try {
      await Parser.renderPDFPage(pageNum, canvas, maxWidth);
      // Scale the canvas display size for crisp rendering
      const displayW = Math.round(canvas.width / 2);
      const displayH = Math.round(canvas.height / 2);
      canvas.style.width  = displayW + 'px';
      canvas.style.height = displayH + 'px';

      // Build text overlay layer for on-page highlighting
      const textLayerDiv = document.getElementById('pdfTextLayer');
      try {
        pdfTextLayerData = await Parser.createPDFTextLayer(pageNum, textLayerDiv, displayW);

        // Render saved highlights on this page
        _renderHighlightsOnPage(pageNum);
      } catch (_) {
        pdfTextLayerData = null;
      }
    } catch (e) {
      // Fallback: leave canvas blank
      pdfTextLayerData = null;
    } finally {
      pdfRendering = false;
    }

    // Update nav info
    document.getElementById('pdfPageInfo').textContent =
      'Page ' + pageNum + ' / ' + totalPages;
    document.getElementById('pdfZoomInfo').textContent =
      Math.round(pdfZoom * 100) + '%';

    // Enable/disable nav buttons
    document.getElementById('pdfPrevPage').disabled = (pageNum <= 1);
    document.getElementById('pdfNextPage').disabled = (pageNum >= totalPages);

    // Scroll to top of viewer on page change
    viewer.scrollTop = 0;
  }

  function _initPDFNav() {
    document.getElementById('pdfPrevPage').addEventListener('click', () => {
      if (pdfCurrentPage > 1) {
        const targetPage = pdfCurrentPage - 1;
        _showPDFPage(targetPage);
        // Sync chunk to match the page
        _syncChunkToPage(targetPage);
      }
    });
    document.getElementById('pdfNextPage').addEventListener('click', () => {
      if (pdfCurrentPage < Parser.getPDFPageCount()) {
        const targetPage = pdfCurrentPage + 1;
        _showPDFPage(targetPage);
        _syncChunkToPage(targetPage);
      }
    });
    document.getElementById('pdfZoomIn').addEventListener('click', () => {
      pdfZoom = Math.min(pdfZoom + 0.25, 3.0);
      _showPDFPage(pdfCurrentPage);
    });
    document.getElementById('pdfZoomOut').addEventListener('click', () => {
      pdfZoom = Math.max(pdfZoom - 0.25, 0.5);
      _showPDFPage(pdfCurrentPage);
    });

    const pdfWrap = document.getElementById('readerPdfWrap');
    document.getElementById('pdfFullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) {
        pdfWrap.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      const expand  = document.querySelector('.pdf-fs-expand');
      const compress = document.querySelector('.pdf-fs-compress');
      if (expand)   expand.style.display   = isFs ? 'none'  : '';
      if (compress) compress.style.display = isFs ? 'block' : 'none';
      // Re-render at new viewport size
      _showPDFPage(pdfCurrentPage);
    });
  }

  // Sync reader chunk index to match a PDF page number
  function _syncChunkToPage(pageNum) {
    if (pdfMode && pageNum !== pdfCurrentPage) {
      _showPDFPage(pageNum);
    }

    const idx = chunks.findIndex(c => c.page === pageNum);
    if (idx >= 0 && idx !== currentChunk) {
      currentChunk = idx;
      _updateChapterTitleBar(idx);
      _highlightChapterItem(idx);
      _updateSeekBar();
      document.getElementById('pbChapterLabel').textContent =
        chunks[idx].title || ('Page ' + pageNum);
    }
  }

  // Sync PDF viewer page to match current chunk
  function _syncPageToChunk(idx) {
    const chunk = chunks[idx];
    if (chunk && chunk.page && pdfMode) {
      _showPDFPage(chunk.page);
    }
  }

  let _pdfNavInited = false;

  // ── PDF ON-PAGE HIGHLIGHTING ──────────────────────────────
  function _highlightPdfWord(charIndex) {
    if (!pdfTextLayerData || !pdfTextLayerData.offsetMap.length) return;

    // Clear previous active
    if (pdfTextLayerData._activeSpan) {
      pdfTextLayerData._activeSpan.classList.remove('pdf-word-active');
      pdfTextLayerData._activeSpan.classList.add('pdf-word-spoken');
    }

    // Find the span containing this charIndex
    let targetSpan = null;
    for (const entry of pdfTextLayerData.offsetMap) {
      if (charIndex >= entry.start && charIndex < entry.end) {
        targetSpan = entry.span;
        break;
      }
    }

    // Fuzzy match: find closest span if exact match failed
    if (!targetSpan) {
      let minDist = Infinity;
      for (const entry of pdfTextLayerData.offsetMap) {
        const dist = Math.min(
          Math.abs(charIndex - entry.start),
          Math.abs(charIndex - entry.end)
        );
        if (dist < minDist) {
          minDist = dist;
          targetSpan = entry.span;
        }
      }
    }

    if (targetSpan) {
      targetSpan.classList.remove('pdf-word-spoken');
      targetSpan.classList.add('pdf-word-active');
      pdfTextLayerData._activeSpan = targetSpan;
    }
  }

  function _clearPdfHighlights() {
    if (!pdfTextLayerData) return;
    pdfTextLayerData.spans.forEach(s => {
      s.classList.remove('pdf-word-active', 'pdf-word-spoken');
    });
    pdfTextLayerData._activeSpan = null;
  }

  // ── PDF MANUAL HIGHLIGHTING ────────────────────────────────
  function _initPDFHighlighting() {
    const textLayer = document.getElementById('pdfTextLayer');
    const toolbar = document.getElementById('pdfHighlightToolbar');
    if (!textLayer || !toolbar) return;

    // Track text selection
    document.addEventListener('mouseup', (e) => {
      if (!pdfMode || !pdfTextLayerData) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        toolbar.classList.remove('visible');
        return;
      }

      // Check if selection is within PDF text layer
      const range = selection.getRangeAt(0);
      if (!textLayer.contains(range.commonAncestorContainer)) {
        toolbar.classList.remove('visible');
        return;
      }

      // Get selected text spans
      const selectedSpans = _getSelectedSpans(range);
      if (selectedSpans.length === 0) {
        toolbar.classList.remove('visible');
        return;
      }

      // Position toolbar near selection
      const rect = range.getBoundingClientRect();
      const viewerRect = document.getElementById('pdfViewer').getBoundingClientRect();
      toolbar.style.left = Math.min(rect.left - viewerRect.left, viewerRect.width - 300) + 'px';
      toolbar.style.top = (rect.top - viewerRect.top - 40) + 'px';
      toolbar.classList.add('visible');

      // Check if selection overlaps existing highlight
      selectedHighlight = _findHighlightInSelection(selectedSpans);
    });

    // Color button clicks
    toolbar.querySelectorAll('.hl-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;

        const range = selection.getRangeAt(0);
        const selectedSpans = _getSelectedSpans(range);
        if (selectedSpans.length === 0) return;

        _applyHighlight(selectedSpans, color);
        selection.removeAllRanges();
        toolbar.classList.remove('visible');
      });
    });

    // Delete button
    document.getElementById('hlDeleteBtn').addEventListener('click', () => {
      if (selectedHighlight) {
        _removeHighlight(selectedHighlight);
        selectedHighlight = null;
      }
      toolbar.classList.remove('visible');
    });

    // Hide toolbar when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (!toolbar.contains(e.target) && !e.target.closest('.pdf-text-layer')) {
        toolbar.classList.remove('visible');
      }
    });
  }

  function _getSelectedSpans(range) {
    if (!pdfTextLayerData) return [];
    const selectedSpans = [];

    pdfTextLayerData.spans.forEach(span => {
      if (range.intersectsNode(span)) {
        selectedSpans.push(span);
      }
    });

    return selectedSpans;
  }

  function _applyHighlight(spans, color) {
    if (!spans.length || !bookId) return;

    // Get char index range
    const startSpan = spans[0];
    const endSpan = spans[spans.length - 1];

    let startIdx = -1, endIdx = -1;
    for (const entry of pdfTextLayerData.offsetMap) {
      if (entry.span === startSpan && startIdx === -1) startIdx = entry.start;
      if (entry.span === endSpan) endIdx = entry.end;
    }

    if (startIdx === -1 || endIdx === -1) return;

    // Create highlight record
    const highlight = {
      id: Date.now() + Math.random(),
      bookId,
      page: pdfCurrentPage,
      startIdx,
      endIdx,
      color
    };

    // Save to memory and database
    pdfHighlights.push(highlight);
    _saveHighlights();

    // Apply visual highlight
    spans.forEach(span => {
      span.classList.remove('pdf-highlight-yellow', 'pdf-highlight-green',
                           'pdf-highlight-blue', 'pdf-highlight-pink', 'pdf-highlight-orange');
      span.classList.add(`pdf-highlight-${color}`);
      span.dataset.highlightId = highlight.id;
    });

    UI.toast(`Highlighted with ${color}`, 'success', 1500);
  }

  function _removeHighlight(highlight) {
    if (!highlight) return;

    // Remove from memory
    const idx = pdfHighlights.findIndex(h => h.id === highlight.id);
    if (idx >= 0) pdfHighlights.splice(idx, 1);

    // Remove visual highlight
    if (pdfTextLayerData) {
      pdfTextLayerData.spans.forEach(span => {
        if (span.dataset.highlightId == highlight.id) {
          span.classList.remove('pdf-highlight-yellow', 'pdf-highlight-green',
                               'pdf-highlight-blue', 'pdf-highlight-pink', 'pdf-highlight-orange');
          delete span.dataset.highlightId;
        }
      });
    }

    // Save to database
    _saveHighlights();

    UI.toast('Highlight removed', '', 1500);
  }

  function _findHighlightInSelection(spans) {
    if (!spans.length) return null;
    const highlightId = spans[0].dataset.highlightId;
    if (!highlightId) return null;
    return pdfHighlights.find(h => h.id == highlightId);
  }

  async function _loadHighlights() {
    if (!bookId) return;

    try {
      const saved = await window.sonara?.settings.get(`highlights_${bookId}`, '[]');
      pdfHighlights = JSON.parse(saved);
    } catch (err) {
      pdfHighlights = [];
    }
  }

  async function _saveHighlights() {
    if (!bookId) return;

    try {
      await window.sonara?.settings.set(`highlights_${bookId}`, JSON.stringify(pdfHighlights));
    } catch (err) {
    }
  }

  function _renderHighlightsOnPage(pageNum) {
    if (!pdfTextLayerData || !pdfHighlights.length) return;

    const pageHighlights = pdfHighlights.filter(h => h.page === pageNum);

    pageHighlights.forEach(highlight => {
      pdfTextLayerData.offsetMap.forEach(entry => {
        if (entry.start >= highlight.startIdx && entry.end <= highlight.endIdx) {
          entry.span.classList.add(`pdf-highlight-${highlight.color}`);
          entry.span.dataset.highlightId = highlight.id;
        }
      });
    });
  }

  // ── LOAD BOOK ────────────────────────────────────────────
  async function loadBook(newChunks, newBookId, resumeData) {
    // Stop any current playback
    stop();

    chunks       = newChunks;
    bookId       = newBookId;
    currentChunk = resumeData?.chunk_index || 0;
    elapsedTime  = resumeData?.elapsed_seconds || 0;
    currentWordIdx = 0;

    // Detect PDF visual mode
    const isPDF = chunks.length > 0 && chunks[0].source === 'pdf' && Parser.hasPDFDoc();
    pdfMode = isPDF;
    _setVoiceControlsVisible(true);

    // Build chapter list
    _buildChapterList();

    // Estimate total duration
    const words = chunks.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
    totalDuration = Math.round((words / (150 * speed)) * 60);
    document.getElementById('pbTimeTotal').textContent = _fmt(totalDuration);

    if (pdfMode) {
      // PDF visual mode: show PDF page with on-page text layer highlighting
      document.getElementById('readerWelcome').style.display   = 'none';
      document.getElementById('readerAudio').style.display     = 'none';
      document.getElementById('readerPdfWrap').style.display   = 'flex';
      document.getElementById('readerTextWrap').style.display  = 'none';
      document.getElementById('chapterTitlebar').style.display = 'flex';

      // Init PDF nav once
      if (!_pdfNavInited) {
        _initPDFNav();
        _pdfNavInited = true;
      }

      // Init PDF highlighting
      _initPDFHighlighting();

      // Load saved highlights for this book
      await _loadHighlights();

      // Show the page for current chunk
      const startPage = chunks[currentChunk]?.page || 1;
      pdfZoom = 1.0;
      _showPDFPage(startPage);
    } else {
      // Text mode (EPUB or fallback)
      document.getElementById('readerPdfWrap').style.display = 'none';
      _renderChunkText(currentChunk);
    }

    _updateChapterTitleBar(currentChunk);
    _highlightChapterItem(currentChunk);
    _updateSeekBar();
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);

    // Start waveform
    _drawWaveform();
  }

  // ── RENDER CHUNK TEXT (word spans) ────────────────────────
  function _renderChunkText(chunkIdx) {
    const chunk = chunks[chunkIdx];
    if (!chunk) return;

    const container = document.getElementById('readerText');
    const text      = chunk.text;
    wordSpans   = [];
    sentenceMap = [];
    let wordGlobalIdx = 0;

    // ── EPUB with content blocks: render text + images in document order ──
    if (chunk.source === 'epub' && Array.isArray(chunk.contentBlocks) && chunk.contentBlocks.length) {
      let html = '';
      for (const block of chunk.contentBlocks) {
        if (block.type === 'image') {
          html += `<figure class="epub-figure"><img class="epub-image" src="${block.dataUrl}" alt="${_escHtml(block.alt || '')}" loading="lazy" /></figure>`;
        } else if (block.type === 'text' && block.text) {
          const sentences = block.text.match(/[^.!?]+[.!?]*/g) || [block.text];
          html += '<p class="epub-para">';
          for (const sentence of sentences) {
            const si = sentenceMap.length;
            const sentStartIdx = wordGlobalIdx;
            const wordHtml = sentence.split(/(\s+)/).map(tok => {
              if (!tok || /^\s+$/.test(tok)) return tok;
              const wi = wordGlobalIdx++;
              return `<span class="word word-unspoken" data-wi="${wi}">${_escHtml(tok)}</span>`;
            }).join('');
            sentenceMap.push({ start: sentStartIdx, end: wordGlobalIdx - 1 });
            html += `<span class="sentence" data-si="${si}">${wordHtml}</span> `;
          }
          html += '</p>';
        }
      }
      container.innerHTML = html;
    } else {
      // ── Plain text mode (PDF, MOBI, epub without images) ──
      const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
      const html = sentences.map((sentence, si) => {
        const sentStartIdx = wordGlobalIdx;
        const wordHtml = sentence.split(/(\s+)/).map(tok => {
          if (!tok || /^\s+$/.test(tok)) return tok;
          const wi = wordGlobalIdx++;
          return `<span class="word word-unspoken" data-wi="${wi}">${_escHtml(tok)}</span>`;
        }).join('');
        sentenceMap.push({ start: sentStartIdx, end: wordGlobalIdx - 1 });
        return `<span class="sentence" data-si="${si}">${wordHtml}</span>`;
      }).join(' ');
      container.innerHTML = html;
    }

    // Cache span references
    wordSpans = [...container.querySelectorAll('.word')];

    // Precompute char offsets of each word span in the cleaned TTS text so that
    // charIndex values from boundary events (which reference the cleaned text) map
    // correctly even when skip-chars embed extra characters inside displayed words.
    {
      const ttsText = _cleanTextForTTS(text);
      wordTtsOffsets = [];
      let searchPos = 0;
      for (const span of wordSpans) {
        const cleanedWord = _cleanTextForTTS(span.textContent);
        if (!cleanedWord) {
          wordTtsOffsets.push(searchPos);
          continue;
        }
        const idx = ttsText.indexOf(cleanedWord, searchPos);
        if (idx !== -1) {
          wordTtsOffsets.push(idx);
          searchPos = idx + cleanedWord.length;
        } else {
          wordTtsOffsets.push(searchPos);
        }
      }
    }

    // Show the text reader, hide audio/pdf reader
    document.getElementById('readerWelcome').style.display   = 'none';
    document.getElementById('readerAudio').style.display     = 'none';
    document.getElementById('readerPdfWrap').style.display   = 'none';
    document.getElementById('chapterTitlebar').style.display = 'flex';
    document.getElementById('readerTextWrap').style.display  = 'flex';
    audioMode = false;
  }

  // ── WORD HIGHLIGHT (onboundary) ───────────────────────────
  function _highlightWord(charIndex) {
    // In PDF mode, highlight directly on the PDF text layer
    if (pdfMode) {
      _highlightPdfWord(charIndex);
      return;
    }

    if (!wordSpans.length) return;

    // Use precomputed TTS offsets so that charIndex (from the cleaned TTS text)
    // maps correctly regardless of skip-chars embedded in displayed words.
    let targetIdx = 0;
    if (wordTtsOffsets.length === wordSpans.length) {
      targetIdx = wordTtsOffsets.length - 1;
      for (let i = 1; i < wordTtsOffsets.length; i++) {
        if (wordTtsOffsets[i] > charIndex) { targetIdx = i - 1; break; }
      }
    } else {
      // Fallback: accumulate word lengths (less accurate)
      let acc = 0;
      for (let i = 0; i < wordSpans.length; i++) {
        const word = wordSpans[i].textContent;
        if (acc + word.length > charIndex) { targetIdx = i; break; }
        acc += word.length + 1;
      }
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
    // Also clear PDF text layer highlights
    _clearPdfHighlights();
  }

  // ── PLAYBACK ─────────────────────────────────────────────

  // Push current player state to main process (updates tray menu + mini player)
  function _pushPlayerState() {
    const title        = document.getElementById('pbMetaTitle')?.textContent?.trim() || '';
    const chapterTitle = chunks[currentChunk]?.title || '';
    const percent      = chunks.length ? Math.round((currentChunk / chunks.length) * 100) : 0;
    window.sonara?.player?.updateState({
      isPlaying,
      title,
      chapterTitle,
      percent,
      coverPath: currentCoverPath || ''
    });
    window.dispatchEvent(new CustomEvent('sonara:playback-state', {
      detail: { isPlaying, bookId }
    }));
  }

  function _updatePlayerCover() {
    const coverEl = document.getElementById('pbCoverPlaceholder');
    if (!coverEl) return;
    if (currentCoverPath) {
      const url = 'file:///' + currentCoverPath.replace(/\\/g, '/');
      coverEl.style.backgroundImage    = 'url("' + url + '")';
      coverEl.style.backgroundSize     = 'cover';
      coverEl.style.backgroundPosition = 'center';
      coverEl.classList.add('has-cover');
    } else {
      coverEl.style.backgroundImage = '';
      coverEl.classList.remove('has-cover');
    }
  }

  function setBookCoverPath(coverPath) {
    currentCoverPath = typeof coverPath === 'string' ? coverPath : '';
    _updatePlayerCover();
    _pushPlayerState();
  }

  function togglePlay() {
    if (audioMode) {
      _toggleAudioPlay();
      return;
    }
    isPlaying ? _pause() : _play();
  }

  function _play() {
    if (!chunks.length) {
      UI.toast('Please add a book first', 'error');
      return;
    }

    // If still waiting for the user's saved cloud voice to finish loading,
    // hold off instead of snapping to the default voice. Retry up to 5×.
    if (!chosenVoice && pendingRestoreVoice) {
      if (_playPendingRetries < 5) {
        _playPendingRetries++;
        UI.toast('Loading your saved voice…', '');
        setTimeout(() => { if (!isPlaying) _play(); }, 800);
        return;
      }
      // Gave up waiting (~4 s) — proceed with best available voice
      pendingRestoreVoice = null;
      _playPendingRetries = 0;
    } else {
      _playPendingRetries = 0;
    }

    // Try to pick a voice if none selected
    if (!chosenVoice && voiceList.length > 0) {
      _pickDefaultVoice();
    }

    if (!chosenVoice) {
      UI.toast('Voices are loading, please wait...', '');
      setTimeout(() => {
        if (voiceList.length > 0) { _pickDefaultVoice(); _play(); }
        else UI.toast('No voices available.', 'error');
      }, 1000);
      return;
    }

    if (currentChunk >= chunks.length) { currentChunk = 0; elapsedTime = 0; }
    isPlaying = true;
    _updatePlayIcon(true);

    // Resume if paused, otherwise start fresh
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
    } else {
      CloudTTS.resume();
      _speakChunk(currentChunk);
    }
    _startTimer();
    _pushPlayerState();
  }

  function _pause() {
    isPlaying = false;
    _updatePlayIcon(false);
    speechSynthesis.pause();
    CloudTTS.pause();
    _stopTimer();
    _saveProgress();
    _pushPlayerState();
  }

  function stop() {
    isPlaying = false;
    if (audioMode && audioElement) {
      audioElement.pause();
      audioElement.src = '';
      audioMode = false;
      audioBookData = null;
    }
    pdfMode = false;
    pdfTextLayerData = null;
    speechSynthesis.cancel();
    CloudTTS.stop();
    _stopTimer();
    _updatePlayIcon(false);
    _clearWordHighlight();
    _pushPlayerState();
  }

  // ── TTS TEXT CLEANER ─────────────────────────────────────
  // Strips skip-characters from text before speaking so the TTS
  // engine never reads stray markdown / formatting symbols aloud.
  function _cleanTextForTTS(text) {
    if (!ttsSkipEnabled || !text) return text;
    // 1. Strip specified characters
    if (ttsSkipChars) {
      const escaped = ttsSkipChars
        .split('')
        .map(c => c.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'))
        .join('');
      if (escaped) text = text.replace(new RegExp(`[${escaped}]`, 'g'), ' ');
    }
    // 2. Strip whole words (case-insensitive, word-boundary safe)
    if (ttsSkipWords) {
      const words = ttsSkipWords
        .split(',')
        .map(w => w.trim())
        .filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length) {
        const wordPattern = new RegExp(`\\b(${words.join('|')})\\b`, 'gi');
        text = text.replace(wordPattern, ' ');
      }
    }
    return text.replace(/ {2,}/g, ' ').trim();
  }

  function _updateSkipBtn() {
    const btn = document.getElementById('pbCleanTextBtn');
    if (!btn) return;
    btn.classList.toggle('active', ttsSkipEnabled);
    btn.title = ttsSkipEnabled
      ? 'Character filter ON — click to disable'
      : 'Character filter OFF — click to enable';
  }

  function toggleSkipChars() {
    ttsSkipEnabled = !ttsSkipEnabled;
    _updateSkipBtn();
    window.sonara?.settings.set('ttsSkipEnabled', ttsSkipEnabled);
    // If currently reading, restart the current chunk with updated filter
    if (isPlaying) {
      CloudTTS.stop();
      speechSynthesis.cancel();
      _speakChunk(currentChunk);
    }
  }

  function _speakChunk(idx) {
    if (idx >= chunks.length) {
      // Book finished
      isPlaying = false;
      _updatePlayIcon(false);
      _stopTimer();
      _saveProgress(true);
      UI.toast('Book complete!', 'success');
      return;
    }

    speechSynthesis.cancel();
    CloudTTS.stop();
    currentChunk = idx;

    // In PDF mode, sync visual page (text layer highlights directly on PDF)
    if (pdfMode) {
      _syncPageToChunk(idx);
    } else {
      _renderChunkText(idx);
    }

    _updateChapterTitleBar(idx);
    _highlightChapterItem(idx);
    _clearWordHighlight();
    document.getElementById('pbChapterLabel').textContent = chunks[idx].title || ('Section ' + (idx + 1));

    // Auto-save periodically
    if (idx % autoSaveEvery === 0) {
      _saveProgress();
    }

    // Ensure we have a voice selected
    if (!chosenVoice && voiceList.length > 0) {
      _pickDefaultVoice();
    }

    const chunkText = _cleanTextForTTS(chunks[idx].text);

    // ── EDGE TTS (Neural voice) ──
    if (chosenVoice && chosenVoice._cloudVoice && chosenVoice._edgeVoice) {
      CloudTTS.speak(
        chunkText,
        chosenVoice,
        speed,
        pitch,
        () => {
          // onEnd
          _saveProgress();
          if (isPlaying) _speakChunk(idx + 1);
        },
        (err) => {
          // onError — fall back to system voice
          _speakChunkWithSystem(idx);
        }
      );
      return;
    }

    // ── SYSTEM VOICE (SpeechSynthesis) ──
    _speakChunkWithSystem(idx);
  }

  function _speakChunkWithSystem(idx) {
    const chunkText = _cleanTextForTTS(chunks[idx].text);
    const u = new SpeechSynthesisUtterance(chunkText);
    u.rate   = speed;
    u.pitch  = pitch;
    u.volume = volume;

    if (chosenVoice && !chosenVoice._cloudVoice) {
      u.voice = chosenVoice;
    } else {
      // Fallback system voice for cloud voice failures
      const fallback = _findFallbackVoice(chosenVoice?.lang || 'en-US');
      if (fallback) u.voice = fallback;
    }

    u.onboundary = (e) => {
      if (e.name === 'word') _highlightWord(e.charIndex);
    };

    u.onend = () => {
      _saveProgress();
      if (isPlaying) _speakChunk(idx + 1);
    };

    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        UI.toast('Speech error: ' + e.error, 'error');
      }
    };

    utterance = u;
    speechSynthesis.speak(u);
  }

  function skipChunk(dir) {
    if (audioMode && audioElement) {
      audioElement.currentTime = Math.max(0, Math.min(audioElement.duration || 0, audioElement.currentTime + (dir * 30)));
      return;
    }
    const next = Math.max(0, Math.min(chunks.length - 1, currentChunk + dir));
    currentChunk = next;
    elapsedTime  = Math.round((next / chunks.length) * totalDuration);
    _updateSeekBar();
    if (isPlaying) _speakChunk(next);
    else {
      if (pdfMode) {
        _syncPageToChunk(next);
      } else {
        _renderChunkText(next);
      }
      _updateChapterTitleBar(next);
      _highlightChapterItem(next);
    }
    _pushPlayerState();
  }

  function jumpToChunk(idx) {
    currentChunk = idx;
    elapsedTime  = Math.round((idx / chunks.length) * totalDuration);
    _updateSeekBar();

    if (pdfMode) {
      _syncPageToChunk(idx);
    } else {
      _renderChunkText(idx);
    }

    _updateChapterTitleBar(idx);
    _highlightChapterItem(idx);
    if (isPlaying) _speakChunk(idx);
  }

  function seekAudio(val) {
    if (audioMode && audioElement) {
      const ratio = val / 100;
      audioElement.currentTime = ratio * (audioElement.duration || 0);
      return;
    }
    const ratio  = val / 100;
    elapsedTime  = Math.round(ratio * totalDuration);
    const target = Math.floor(ratio * chunks.length);
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);
    jumpToChunk(Math.max(0, Math.min(target, chunks.length - 1)));
  }

  function seekBy(seconds) {
    if (audioMode && audioElement) {
      audioElement.currentTime = Math.max(0, Math.min(audioElement.currentTime + seconds, audioElement.duration || 0));
      return;
    }
    elapsedTime = Math.max(0, Math.min(elapsedTime + seconds, totalDuration));
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);
    const target = Math.floor((elapsedTime / (totalDuration || 1)) * chunks.length);
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
    if (isPlaying) { speechSynthesis.cancel(); CloudTTS.stop(); _speakChunk(currentChunk); }
  }

  function onSpeedChange(val) {
    speed = parseFloat(val);
    document.getElementById('speedVal').textContent = speed.toFixed(2) + '×';
    document.getElementById('pbSpeedLabel').textContent = speed.toFixed(1) + '×';
    window.sonara?.settings.set('speed', speed);
    if (audioMode && audioElement) {
      audioElement.playbackRate = speed;
      return;
    }
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

  function onVolumeChange(val) {
    const raw = parseFloat(val);
    const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
    volume = pct / 100;
    if (volume > 0) lastVolumeBeforeMute = volume;

    const volumeSlider = document.getElementById('volumeSlider');
    const pbVolumeSlider = document.getElementById('pbVolumeSlider');
    const volumeVal = document.getElementById('volumeVal');
    const pbVolumeVal = document.getElementById('pbVolumeVal');

    if (volumeSlider && Number(volumeSlider.value) !== pct) volumeSlider.value = String(pct);
    if (pbVolumeSlider && Number(pbVolumeSlider.value) !== pct) pbVolumeSlider.value = String(pct);
    if (volumeVal) volumeVal.textContent = Math.round(pct) + '%';
    if (pbVolumeVal) pbVolumeVal.textContent = Math.round(pct) + '%';

    _updateVolumeButton(pct);

    window.sonara?.settings.set('volume', volume);

    if (audioElement) {
      audioElement.volume = volume;
    }

    if (CloudTTS && typeof CloudTTS.setVolume === 'function') {
      CloudTTS.setVolume(volume);
    }

    // Browser system voices may not apply volume changes mid-utterance.
    // Restart current chunk shortly after slider settles to apply the new level.
    const isSystemVoiceReading = isPlaying && !audioMode && (!chosenVoice || !chosenVoice._cloudVoice);
    if (isSystemVoiceReading) {
      if (utterance) utterance.volume = volume;
      if (volumeApplyTimer) clearTimeout(volumeApplyTimer);
      volumeApplyTimer = setTimeout(() => {
        const stillReadingSystemVoice = isPlaying && !audioMode && (!chosenVoice || !chosenVoice._cloudVoice);
        if (stillReadingSystemVoice) {
          speechSynthesis.cancel();
          _speakChunk(currentChunk);
        }
      }, 180);
    }
  }

  function _updateVolumeButton(pct) {
    const btn = document.getElementById('pbVolumeBtn');
    const wave = document.getElementById('pbVolumeWave');
    const mute1 = document.getElementById('pbVolumeMute');
    const mute2 = document.getElementById('pbVolumeMute2');
    if (!btn || !wave || !mute1 || !mute2) return;

    const muted = pct <= 0;
    btn.classList.toggle('muted', muted);
    btn.title = muted ? 'Unmute' : 'Mute';
    wave.style.display = muted ? 'none' : '';
    mute1.style.display = muted ? '' : 'none';
    mute2.style.display = muted ? '' : 'none';
  }

  function toggleMute() {
    if (volume <= 0.001) {
      const restore = Math.max(0.05, Math.min(1.0, lastVolumeBeforeMute || 1.0));
      onVolumeChange(String(Math.round(restore * 100)));
      return;
    }

    lastVolumeBeforeMute = volume;
    onVolumeChange('0');
  }

  // ── DISPLAY / TYPOGRAPHY CONTROLS ─────────────────────────
  function _applyReadingStyle() {
    const el = document.getElementById('readerText');
    if (!el) return;
    el.style.fontFamily  = FONT_MAP[readerFont] || FONT_MAP.serif;
    el.style.fontSize    = readerFontSize + 'px';
    el.style.lineHeight  = readerLineH;
    el.style.maxWidth    = readerMaxWidth + 'px';
  }

  function _syncFontUI() {
    document.querySelectorAll('.font-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.font === readerFont);
    });
    const sizeEl  = document.getElementById('fontSizeSlider');
    const sizeVal = document.getElementById('fontSizeVal');
    const lhEl    = document.getElementById('lineHeightSlider');
    const lhVal   = document.getElementById('lineHeightVal');
    const wEl     = document.getElementById('readerWidthSlider');
    const wVal    = document.getElementById('readerWidthVal');
    if (sizeEl)  sizeEl.value            = readerFontSize;
    if (sizeVal) sizeVal.textContent     = readerFontSize + 'px';
    if (lhEl)    lhEl.value             = readerLineH.toFixed(1);
    if (lhVal)   lhVal.textContent      = readerLineH.toFixed(1);
    if (wEl)     wEl.value              = readerMaxWidth;
    if (wVal)    wVal.textContent       = readerMaxWidth + 'px';
  }

  function onFontChange(font) {
    readerFont = font;
    _applyReadingStyle();
    _syncFontUI();
    window.sonara?.settings.set('readerFont', font);
  }

  function onFontSizeChange(val) {
    readerFontSize = parseInt(val, 10);
    _applyReadingStyle();
    const el = document.getElementById('fontSizeVal');
    if (el) el.textContent = readerFontSize + 'px';
    window.sonara?.settings.set('readerFontSize', readerFontSize);
  }

  function onLineHeightChange(val) {
    readerLineH = parseFloat(parseFloat(val).toFixed(1));
    _applyReadingStyle();
    const el = document.getElementById('lineHeightVal');
    if (el) el.textContent = readerLineH.toFixed(1);
    window.sonara?.settings.set('readerLineH', readerLineH);
  }

  function onReaderWidthChange(val) {
    readerMaxWidth = parseInt(val, 10);
    _applyReadingStyle();
    const el = document.getElementById('readerWidthVal');
    if (el) el.textContent = readerMaxWidth + 'px';
    window.sonara?.settings.set('readerMaxWidth', readerMaxWidth);
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

    // Populate left nav panel
    const navLabel = document.getElementById('navListLabel');
    const navCount = document.getElementById('navListCount');
    const navList  = document.getElementById('navChapterList');
    if (navLabel) navLabel.textContent = label;
    if (navCount) navCount.textContent = chunks.length;
    if (navList) {
      navList.innerHTML = chunks.map((c, i) => `
        <div class="nav-ch-item${i === 0 ? ' active' : ''}" id="nav-ch-item-${i}" onclick="Reader.jumpToChunk(${i})">
          <span class="nav-ci-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="nav-ci-name">${_escHtml(c.title || (label.slice(0,-1) + ' ' + (i+1)))}</span>
          <span class="nav-ci-dur">${_estimateDur(c.text)}</span>
        </div>`
      ).join('');
    }
  }

  function _highlightChapterItem(idx) {
    // Left nav panel
    document.querySelectorAll('.nav-ch-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    document.getElementById('nav-ch-item-' + idx)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    _setTopbarTitle(c?.title || '');

    // Reader header badge
    document.getElementById('readerProgBadge')?.textContent && (document.getElementById('readerProgBadge').textContent = pct + '%');
  }

  function _setTopbarTitle(text) {
    const el = document.getElementById('tbCenter');
    if (!el) return;
    if (el.textContent === text) return;

    el.textContent = text;
    el.classList.remove('tb-center-anim');
    void el.offsetWidth;
    el.classList.add('tb-center-anim');
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
    window.sonara?.progress.save({
      book_id:         bookId,
      chunk_index:     finished ? chunks.length - 1 : currentChunk,
      word_index:      currentWordIdx,
      elapsed_seconds: elapsedTime,
      percent
    });
    // Refresh library card
    Library.refreshCard(bookId, percent, finished ? 'done' : percent > 0 ? 'reading' : 'unstarted');
  }

  // ── APPLY SAVED SETTINGS ───────────────────────────────────
  async function applySettings() {
    if (!window.sonara) return;

    // Wire tray / mini-player commands (only once)
    if (!applySettings._cmdWired) {
      applySettings._cmdWired = true;
      window.sonara.player?.onCommand(cmd => {
        if      (cmd === 'toggle')      togglePlay();
        else if (cmd === 'prev')        skipChunk(-1);
        else if (cmd === 'next')        skipChunk(1);
        else if (cmd === '__pushState') _pushPlayerState();
      });
    }

    if (!applySettings._epubPageKeysWired) {
      applySettings._epubPageKeysWired = true;
      document.addEventListener('keydown', (e) => {
        const t = e.target;
        const isEditable = t && (
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable
        );
        if (isEditable) return;
        if (audioMode || pdfMode) return;
        if (!chunks.length || chunks[0].source !== 'epub') return;

        if (e.key === 'PageDown') {
          e.preventDefault();
          skipChunk(1);
        } else if (e.key === 'PageUp') {
          e.preventDefault();
          skipChunk(-1);
        }
      });
    }
    const savedVoice     = await window.sonara.settings.get('voice');
    const savedFavorites = await window.sonara.settings.get('favoriteVoices', []);
    const savedSpeed     = await window.sonara.settings.get('speed', 1.0);
    const savedPitch     = await window.sonara.settings.get('pitch', 1.0);
    const savedVolume    = await window.sonara.settings.get('volume', 1.0);
    const savedSkipChars    = await window.sonara.settings.get('ttsSkipChars', '*_~#');
    const savedSkipEnabled  = await window.sonara.settings.get('ttsSkipEnabled', true);
    const savedSkipWords    = await window.sonara.settings.get('ttsSkipWords', '');
    ttsSkipChars   = savedSkipChars || '';
    ttsSkipEnabled = savedSkipEnabled !== false; // default true
    ttsSkipWords   = savedSkipWords  || '';
    favoriteVoiceIds = new Set(Array.isArray(savedFavorites) ? savedFavorites.filter(x => typeof x === 'string' && x) : []);
    _updateSkipBtn();

    speed = parseFloat(savedSpeed) || 1.0;
    pitch = parseFloat(savedPitch) || 1.0;
    volume = parseFloat(savedVolume);
    if (!Number.isFinite(volume)) volume = 1.0;
    volume = Math.max(0, Math.min(1, volume));
    if (volume > 0) lastVolumeBeforeMute = volume;

    document.getElementById('speedSlider').value  = speed;
    document.getElementById('speedVal').textContent = speed.toFixed(2) + '×';
    document.getElementById('pbSpeedLabel').textContent = speed.toFixed(1) + '×';
    document.getElementById('pitchSlider').value  = pitch;
    document.getElementById('pitchVal').textContent = pitch.toFixed(1);
    onVolumeChange(String(Math.round(volume * 100)));

    // ── Restore display/typography preferences ──
    readerFont     = (await window.sonara.settings.get('readerFont',     'serif'))  || 'serif';
    readerFontSize =  parseInt(await window.sonara.settings.get('readerFontSize', 17),  10) || 17;
    readerLineH    =  parseFloat(await window.sonara.settings.get('readerLineH',  2.0)) || 2.0;
    readerMaxWidth =  parseInt(await window.sonara.settings.get('readerMaxWidth', 680), 10) || 680;
    _applyReadingStyle();
    _syncFontUI();
    
    // Try to restore saved voice (global setting - persists across all books)
    if (savedVoice) {
      // Set pendingRestoreVoice so _mergeVoices can restore it whenever cloud voices arrive
      pendingRestoreVoice = savedVoice;

      // If voices are already loaded, try immediately
      if (voiceList.length) {
        const v = _findVoiceByIdOrName(savedVoice);
        if (v) {
          chosenVoice = v;
          pendingRestoreVoice = null;
          _updateVoiceBar();
          renderVoiceList();
        }
        // If not found yet (cloud voices not loaded), pendingRestoreVoice stays
        // and _mergeVoices will restore it once cloud voices arrive
      }
      // Safety net: if the cloud service is unreachable and the voice never loads,
      // unblock after 8s so the app doesn't stay stuck with no voice at all.
      setTimeout(() => {
        if (pendingRestoreVoice) {
          pendingRestoreVoice = null;
          _playPendingRetries = 0;
          if (!chosenVoice && voiceList.length) _pickDefaultVoice();
        }
      }, 8000);
    } else {
      if (voiceList.length && !chosenVoice) {
        _pickDefaultVoice();
      }
    }
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _fmt(s) {
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function _estimateDur(text) {
    return _fmt(Math.round((text.split(/\s+/).length / 150) * 60));
  }

  function _updateSeekBar() {
    const p = totalDuration > 0 ? (elapsedTime / totalDuration) * 100 : 0;
    const seeker = document.getElementById('pbSeeker');
    if (!seeker) return;
    seeker.value = p;
    seeker.style.setProperty('--seeker-pct', p.toFixed(2) + '%');
  }

  function saveBookmark() {
    if (!bookId || !chunks.length) {
      UI.toast('No book loaded', 'error');
      return;
    }
    
    // Save progress (same as auto-save)
    _saveProgress();
    
    const percent = Math.round((currentChunk / chunks.length) * 100);
    const chunkLabel = chunks[currentChunk]?.title || ('Section ' + (currentChunk + 1));
    
    UI.toast('📖 Progress saved at ' + percent + '% - ' + chunkLabel, 'success', 2500);
    
    // Visual feedback on the button
    const btn = document.getElementById('pbBookmarkBtn');
    if (btn) {
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><span>Saved!</span>';
      btn.style.background = 'rgba(82, 200, 122, 0.2)';
      btn.style.borderColor = 'rgba(82, 200, 122, 0.4)';
      btn.style.color = '#52c87a';
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1500);
    }
  }
  
  function _updatePlayIcon(playing) {
    document.getElementById('pbPlayIcon').innerHTML = playing
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<polygon points="5 3 19 12 5 21 5 3"/>';
  }

  function _escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── AUDIOBOOK MODE ──────────────────────────────────────────

  function _setVoiceControlsVisible(visible) {
    const section = document.getElementById('rpVoiceSection');
    if (!section) return;
    section.style.display = visible ? '' : 'none';
  }

  function loadAudioBook(bookData, resumeData) {
    audioMode = true;
    _setVoiceControlsVisible(false);
    audioBookData = bookData;
    bookId = bookData.id;
    currentCoverPath = bookData.cover_path || '';
    _updatePlayerCover();
    chunks = [];

    // Hide text/pdf reader, show audio reader
    document.getElementById('readerWelcome').style.display   = 'none';
    document.getElementById('chapterTitlebar').style.display  = 'none';
    document.getElementById('readerTextWrap').style.display   = 'none';
    document.getElementById('readerPdfWrap').style.display    = 'none';
    document.getElementById('readerAudio').style.display      = 'flex';

    // Set up audio element
    audioElement = document.getElementById('audioPlayer');
    audioElement.src = 'file:///' + bookData.file_path.replace(/\\/g, '/');
    audioElement.playbackRate = speed;
    audioElement.volume = volume;

    // Set title
    document.getElementById('rasTitle').textContent = bookData.title;
    document.getElementById('rasAuthor').textContent = bookData.author || '';

    // Cover
    const coverEl = document.getElementById('rasCover');
    if (bookData.cover_path) {
      coverEl.innerHTML = '<img src="file:///' + bookData.cover_path.replace(/\\/g, '/') + '" alt="" />';
    } else {
      let hash = 0;
      for (let i = 0; i < bookData.title.length; i++) {
        hash = ((hash << 5) - hash) + bookData.title.charCodeAt(i);
        hash |= 0;
      }
      const hue1 = Math.abs(hash) % 360;
      const hue2 = (hue1 + 40) % 360;
      coverEl.innerHTML = '<div class="lc-cover-placeholder" style="background:linear-gradient(135deg,hsl(' + hue1 + ',25%,15%),hsl(' + hue2 + ',30%,22%))">' +
        '<span class="lc-cover-letter">' + (bookData.title[0] || '?').toUpperCase() + '</span></div>';
    }

    // Resume position
    if (resumeData?.elapsed_seconds > 0) {
      audioElement.currentTime = resumeData.elapsed_seconds;
    }

    // Wire up events
    audioElement.removeEventListener('timeupdate', _onAudioTimeUpdate);
    audioElement.addEventListener('timeupdate', _onAudioTimeUpdate);

    audioElement.removeEventListener('loadedmetadata', _onAudioMeta);
    audioElement.addEventListener('loadedmetadata', _onAudioMeta);

    audioElement.removeEventListener('ended', _onAudioEnded);
    audioElement.addEventListener('ended', _onAudioEnded);

    // Update topbar and player bar book info
    _setTopbarTitle(bookData.title || '');
    const pmTitle = document.getElementById('pbMetaTitle');
    const pmAuthor = document.getElementById('pbMetaAuthor');
    if (pmTitle) pmTitle.textContent = bookData.title || '';
    if (pmAuthor) pmAuthor.textContent = bookData.author || '';

    // Left nav panel — single entry for audiobook
    const navLabel = document.getElementById('navListLabel');
    const navCount = document.getElementById('navListCount');
    const navList  = document.getElementById('navChapterList');
    if (navLabel) navLabel.textContent = 'Audiobook';
    if (navCount) navCount.textContent = '1';
    if (navList)  navList.innerHTML =
      '<div class="nav-ch-item active" id="nav-ch-item-0"><span class="nav-ci-name">' + _escHtml(bookData.title) + '</span></div>';

    // Sync tray + mini player
    _pushPlayerState();
  }

  function _onAudioMeta() {
    if (!audioElement) return;
    totalDuration = audioElement.duration || 0;
    document.getElementById('pbTimeTotal').textContent = _fmt(Math.floor(totalDuration));
    document.getElementById('rasTime').textContent =
      _fmt(Math.floor(audioElement.currentTime)) + ' / ' + _fmt(Math.floor(totalDuration));
  }

  function _onAudioTimeUpdate() {
    if (!audioElement) return;
    elapsedTime = Math.floor(audioElement.currentTime);
    document.getElementById('pbTimeCur').textContent = _fmt(elapsedTime);
    document.getElementById('rasTime').textContent =
      _fmt(elapsedTime) + ' / ' + _fmt(Math.floor(audioElement.duration || 0));

    const pct = audioElement.duration > 0
      ? (audioElement.currentTime / audioElement.duration) * 100 : 0;
    const seeker = document.getElementById('pbSeeker');
    if (seeker) {
      seeker.value = pct;
      seeker.style.setProperty('--seeker-pct', pct.toFixed(2) + '%');
    }
  }

  function _onAudioEnded() {
    isPlaying = false;
    _updatePlayIcon(false);
    _saveAudioProgress(true);
    _pushPlayerState();
    UI.toast('Audiobook complete!', 'success');
  }

  function _toggleAudioPlay() {
    if (!audioElement) return;
    if (audioElement.paused) {
      audioElement.play();
      isPlaying = true;
      _updatePlayIcon(true);
      _startTimer();
    } else {
      audioElement.pause();
      isPlaying = false;
      _updatePlayIcon(false);
      _stopTimer();
      _saveAudioProgress();
    }
    _pushPlayerState();
  }

  function _saveAudioProgress(finished = false) {
    if (!bookId || !audioElement) return;
    const percent = finished ? 100 : Math.round(
      (audioElement.currentTime / (audioElement.duration || 1)) * 100
    );
    window.sonara?.progress.save({
      book_id: bookId,
      chunk_index: 0,
      word_index: 0,
      elapsed_seconds: Math.floor(audioElement.currentTime),
      percent
    });
    Library.refreshCard(bookId, percent, finished ? 'done' : percent > 0 ? 'reading' : 'unstarted');
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    initVoices, refreshVoices, filterVoices, renderVoiceList,
    selectVoice, previewVoice, previewSelectedVoice, toggleFavoriteVoice,
    loadBook, loadAudioBook,
    togglePlay, stop, skipChunk, jumpToChunk, seekAudio, seekBy,
    cycleSpeed, onSpeedChange, onPitchChange, onVolumeChange, toggleMute,
    onFontChange, onFontSizeChange, onLineHeightChange, onReaderWidthChange,
    applySettings,
    /** Update the skip chars at runtime (called from settings save) */
    setSkipChars:   (val)  => { ttsSkipChars   = val || ''; },
    setSkipWords:   (val)  => { ttsSkipWords   = val || ''; },
    setSkipEnabled: (val)  => { ttsSkipEnabled = !!val; _updateSkipBtn(); },
    setBookCoverPath,
    toggleSkipChars,
    saveProgress: _saveProgress,
    saveBookmark,
    getState:  () => ({ isPlaying, currentChunk, elapsedTime, speed, pitch, volume, chosenVoice }),
    getChunks: () => chunks
  };
})();
