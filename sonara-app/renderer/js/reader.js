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

  // Audiobook mode state
  let audioMode      = false;
  let audioElement   = null;
  let audioBookData  = null;

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

    // Render voice items WITHOUT inline onclick (CSP/frozen issue)
    el.innerHTML = filtered.map((v, i) => {
      const sel = chosenVoice && chosenVoice.name === v.name;
      const isNatural = !!v._edgeVoice;
      const isCloud = !v.localService;
      const serviceType = isNatural ? 'NATURAL' : (v.localService ? 'LOCAL' : 'CLOUD');
      const serviceBadge = isNatural ? 'badge-natural' : (v.localService ? 'badge-local' : 'badge-remote');
      const tooltip = isNatural ? 'Microsoft Neural voice — high quality, natural sounding'
        : (v.localService ? 'Offline voice — works without internet' : 'Online voice — requires internet');

      return `<div class="voice-item${sel ? ' selected' : ''}" data-voice-name="${_escHtml(v.name)}" data-voice-type="${isNatural ? 'natural' : (isCloud ? 'cloud' : 'local')}">
        <div class="vi-radio"></div>
        <div class="vi-info">
          <div class="vi-name">${_escHtml(v.name)}</div>
          <div class="vi-lang">${_escHtml(v.lang)}${v.gender ? ' · ' + _escHtml(v.gender) : ''}</div>
        </div>
        <div class="vi-badges">
          ${v.lang && v.lang.startsWith('en') ? '<span class="vi-badge badge-en">EN</span>' : ''}
          <span class="vi-badge ${serviceBadge}" title="${tooltip}">${serviceType}</span>
        </div>
        <button class="vi-pbtn" data-preview-voice="${_escHtml(v.name)}" title="Preview this voice">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    }).join('');
    
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
      if (item && !e.target.closest('.vi-pbtn')) {
        const voiceName = item.getAttribute('data-voice-name');
        if (voiceName) {
          selectVoice(voiceName);
        }
      }
    });
    
    // Event delegation for preview buttons
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.vi-pbtn');
      if (btn) {
        e.stopPropagation();
        const voiceName = btn.getAttribute('data-preview-voice');
        if (voiceName) {
          previewVoice(voiceName);
        }
      }
    });
  }

  function selectVoice(name) {
    const v = voiceList.find(x => x.name === name);
    if (!v) {
      UI.toast('Voice not found', 'error');
      return;
    }
    
    chosenVoice = v;

    // Update UI immediately
    renderVoiceList();
    _updateVoiceBar();
    
    // Save to settings globally (persists across all books)
    window.sonara?.settings.set('voice', name).then(() => {
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

  function previewVoice(name) {
    const v = voiceList.find(x => x.name === name);
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
        u.volume = 1.0;
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

    pdfRendering = false;
  }

  function _initPDFNav() {
    document.getElementById('pdfPrevPage').addEventListener('click', () => {
      if (pdfCurrentPage > 1) {
        _showPDFPage(pdfCurrentPage - 1);
        // Sync chunk to match the page
        _syncChunkToPage(pdfCurrentPage);
      }
    });
    document.getElementById('pdfNextPage').addEventListener('click', () => {
      if (pdfCurrentPage < Parser.getPDFPageCount()) {
        _showPDFPage(pdfCurrentPage + 1);
        _syncChunkToPage(pdfCurrentPage);
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
  }

  // Sync reader chunk index to match a PDF page number
  function _syncChunkToPage(pageNum) {
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
    // Also clear PDF text layer highlights
    _clearPdfHighlights();
  }

  // ── PLAYBACK ─────────────────────────────────────────────
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
  }

  function _pause() {
    isPlaying = false;
    _updatePlayIcon(false);
    speechSynthesis.pause();
    CloudTTS.pause();
    _stopTimer();
    _saveProgress();
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

    const chunkText = chunks[idx].text;

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
    const chunkText = chunks[idx].text;
    const u = new SpeechSynthesisUtterance(chunkText);
    u.rate   = speed;
    u.pitch  = pitch;
    u.volume = 1.0;

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

    const savedVoice = await window.sonara.settings.get('voice');
    const savedSpeed = await window.sonara.settings.get('speed', 1.0);
    const savedPitch = await window.sonara.settings.get('pitch', 1.0);

    speed = parseFloat(savedSpeed) || 1.0;
    pitch = parseFloat(savedPitch) || 1.0;

    document.getElementById('speedSlider').value  = speed;
    document.getElementById('speedVal').textContent = speed.toFixed(2) + '×';
    document.getElementById('pbSpeedLabel').textContent = speed.toFixed(1) + '×';
    document.getElementById('pitchSlider').value  = pitch;
    document.getElementById('pitchVal').textContent = pitch.toFixed(1);
    
    // Try to restore saved voice (global setting - persists across all books)
    if (savedVoice) {
      // If voices already loaded, select immediately
      if (voiceList.length) {
        const v = voiceList.find(x => x.name === savedVoice);
        if (v) { 
          chosenVoice = v;
          _updateVoiceBar();
          renderVoiceList();
        } else {
          _pickDefaultVoice();
        }
      } else {
        // Voices not loaded yet - retry after delays
        const tryRestore = async () => {
          if (voiceList.length) {
            const v = voiceList.find(x => x.name === savedVoice);
            if (v) { 
              chosenVoice = v;
              _updateVoiceBar();
              renderVoiceList();
            } else {
              _pickDefaultVoice();
            }
          } else {
            // Still no voices, pick default when available
            if (!chosenVoice && voiceList.length) {
              _pickDefaultVoice();
            }
          }
        };
        setTimeout(tryRestore, 1000);
        setTimeout(tryRestore, 2000);
      }
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
    document.getElementById('pbSeeker').value = p;
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

  function loadAudioBook(bookData, resumeData) {
    audioMode = true;
    audioBookData = bookData;
    bookId = bookData.id;
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

    // Update topbar
    document.getElementById('tbCenter').textContent = bookData.title;

    // Chapter list (single entry for audiobook)
    document.getElementById('chaptersLabel').textContent = 'Audiobook';
    document.getElementById('chaptersCount').textContent = '1';
    document.getElementById('chaptersList').innerHTML =
      '<div class="chapter-item active"><span class="ci-name">' + _escHtml(bookData.title) + '</span></div>';
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
    document.getElementById('pbSeeker').value = pct;
  }

  function _onAudioEnded() {
    isPlaying = false;
    _updatePlayIcon(false);
    _saveAudioProgress(true);
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
    selectVoice, previewVoice, previewSelectedVoice,
    loadBook, loadAudioBook,
    togglePlay, stop, skipChunk, jumpToChunk, seekAudio,
    cycleSpeed, onSpeedChange, onPitchChange,
    applySettings,
    saveProgress: _saveProgress,
    saveBookmark,
    getState:  () => ({ isPlaying, currentChunk, elapsedTime, speed, pitch, chosenVoice }),
    getChunks: () => chunks
  };
})();
