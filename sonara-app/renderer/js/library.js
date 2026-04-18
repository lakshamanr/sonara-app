/* ══════════════════════════════════════════════════════════
   LIBRARY.JS — Full-screen grid, search, collections, covers
══════════════════════════════════════════════════════════ */
'use strict';

const Library = (() => {

  let books = [];
  let collections = [];
  let bookCollectionMap = {};   // { collectionId: Set<bookId> }
  let searchQuery = '';
  let activeFormat = 'all';
  let activeCollection = 'all';
  let sortBy = 'recent';
  let _initialized = false;
  let _assignBookId = null;     // for assign-to-collection modal
  let _editCollectionId = null; // for edit collection modal
  let _contextMenu = null;      // active context menu element
  let _currentGroupKey = null;  // for format picker modal
  let _playingBookId = null;
  let _isPlaying = false;
  let _renameBookIds = [];
  let _renameMode = 'single';
  let _bulkSelectMode = false;
  let _selectedBooks  = new Set();  // Set of book IDs (strings)

  const AUDIO_FORMATS = ['mp3', 'm4b', 'm4a', 'ogg'];

  // ── LOAD ─────────────────────────────────────────────────
  async function load() {
    _renderSkeletonGrid();

    try {
      books = await window.sonara.library.getAll() || [];
      collections = await window.sonara.collections.getAll() || [];

      // Build collection membership map
      bookCollectionMap = {};
      for (const col of collections) {
        try {
          const colBooks = await window.sonara.collections.getBooks(col.id);
          bookCollectionMap[col.id] = new Set(colBooks.map(b => b.id));
        } catch { bookCollectionMap[col.id] = new Set(); }
      }

      renderGrid();
      renderCollections();
      _updateStats();
      _renderOldSidebar();

      if (!_initialized) {
        _initSearchAndFilters();
        _initCollectionListeners();
        _initSetCoverModal();
        _initialized = true;
      }

    } catch (err) {
      books = [];
      renderGrid();
    }
  }

  function _renderSkeletonGrid() {
    const grid  = document.getElementById('libGrid');
    const empty = document.getElementById('libEmptyHero');
    if (!grid || !empty) return;

    empty.style.display = 'none';
    grid.innerHTML = Array.from({ length: 8 }, () => (
      '<div class="lib-card-skeleton">' +
        '<div class="skel-cover"></div>' +
        '<div class="skel-line"></div>' +
        '<div class="skel-line short"></div>' +
      '</div>'
    )).join('');
  }

  // ── FILTER + SORT ─────────────────────────────────────────
  function _getFilteredBooks() {
    let filtered = [...books];

    // Collection filter
    if (activeCollection === 'recent') {
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      filtered = filtered.filter(b => b.added_at > weekAgo);
    } else if (activeCollection === 'reading') {
      filtered = filtered.filter(b => b.status === 'reading');
    } else if (typeof activeCollection === 'number') {
      const ids = bookCollectionMap[activeCollection] || new Set();
      filtered = filtered.filter(b => ids.has(b.id));
    }

    // Format filter
    if (activeFormat !== 'all') {
      if (activeFormat === 'audio') {
        filtered = filtered.filter(b => AUDIO_FORMATS.includes(b.format));
      } else {
        filtered = filtered.filter(b => b.format === activeFormat);
      }
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(b =>
        b.title.toLowerCase().includes(q) ||
        (b.author && b.author.toLowerCase().includes(q))
      );
    }

    // Sort
    switch (sortBy) {
      case 'recent':
        filtered.sort((a, b) => (b.last_read || b.added_at) - (a.last_read || a.added_at));
        break;
      case 'added':
        filtered.sort((a, b) => b.added_at - a.added_at);
        break;
      case 'title':
        filtered.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'progress':
        filtered.sort((a, b) => (b.percent || 0) - (a.percent || 0));
        break;
    }

    return filtered;
  }

  // ── RENDER GRID ───────────────────────────────────────────
  function renderGrid() {
    const grid  = document.getElementById('libGrid');
    const empty = document.getElementById('libEmptyHero');

    if (!books.length) {
      grid.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    const filtered = _getFilteredBooks();

    if (!filtered.length) {
      grid.innerHTML = '<div class="lib-no-results">No books match your filters</div>';
      return;
    }

    const groups = _buildGroups(filtered);
    grid.innerHTML = groups.map(g => g.books.length > 1 ? _groupCardHTML(g) : _coverCardHTML(g.books[0])).join('');
    _attachCardListeners();
    _syncPlaybackMarkers();
  }

  function _coverCardHTML(b) {
    const pct         = b.percent || 0;
    const statusLabel = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[b.status] || '';
    const isAudio     = AUDIO_FORMATS.includes(b.format);
    const fmtLabel    = isAudio ? 'AUDIO' : b.format.toUpperCase();
    const fmtClass    = isAudio ? 'audio' : b.format;

    let coverHTML;
    if (b.cover_path) {
      coverHTML = '<img class="lc-cover-img" src="file:///' + _escHtml(b.cover_path.replace(/\\/g, '/')) + '" alt="" />';
    } else {
      const style = _generatePlaceholderStyle(b.title);
      const letter = _escHtml((b.title || '?')[0].toUpperCase());
      const title  = _escHtml(b.title);
      coverHTML = '<div class="lc-cover-placeholder" style="' + style + '">' +
        '<span class="lc-cover-letter">' + letter + '</span>' +
        '<span class="lc-cover-title">' + title + '</span></div>';
    }

    const isCurrent    = App.currentBookId === b.id;
    const isNowPlaying = _isPlaying && _playingBookId === b.id;
    const isSelected   = _bulkSelectMode && _selectedBooks.has(String(b.id));
    const bulkCheck    = _bulkSelectMode
      ? '<label class="lc-bulk-check" title="Select for export"><input type="checkbox" data-bulk-id="' + b.id + '"' + (isSelected ? ' checked' : '') + '/><span class="lc-bulk-checkmark"></span></label>'
      : '';

    return '<div class="lib-card' +
        (isCurrent      ? ' is-current'     : '') +
        (isNowPlaying   ? ' is-now-playing' : '') +
        (isSelected     ? ' bulk-selected'  : '') +
        (_bulkSelectMode ? ' bulk-mode-card' : '') +
        '" data-book-id="' + b.id + '" data-format="' + b.format + '">' +
      bulkCheck +
      '<button class="lc-menu-btn" data-menu-id="' + b.id + '" title="More options">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
          '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>' +
        '</svg></button>' +
      '<div class="lc-cover">' +
        _playbackBadgeHTML() +
        coverHTML +
        '<span class="lc-format-badge ' + fmtClass + '">' + fmtLabel + '</span>' +
        '<div class="lc-progress-bar"><div class="lc-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="lc-hover-overlay">' +
          '<button class="lc-play-btn" title="Open & Play">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
          '</button></div>' +
      '</div>' +
      '<div class="lc-info">' +
        '<div class="lc-title" title="' + _escHtml(b.title) + '">' + _escHtml(b.title) + '</div>' +
        (b.author ? '<div class="lc-author">' + _escHtml(b.author) + '</div>' : '') +
        '<div class="lc-meta">' +
          '<span class="lc-pct">' + pct + '%</span>' +
          '<span class="lc-status ' + b.status + '">' + statusLabel + '</span>' +
        '</div>' +
      '</div></div>';
  }

  // ── TITLE NORMALISATION & GROUPING ──────────────────────
  function _normalizeTitle(title) {
    return (title || '')
      .toLowerCase()
      .replace(/[_\-–—]+/g, ' ')                        // separators → space
      .replace(/[^\w\s]/g, ' ')                          // other punctuation → space
      .replace(/\b(the|a|an)\b/g, ' ')                  // drop leading articles
      .replace(/\b(unabridged|audiobook|audio\s*book|narrated\s*by|complete|full)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _buildGroups(filtered) {
    const groupMap = new Map();
    for (const book of filtered) {
      const key = _normalizeTitle(book.title);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(book);
    }
    const seen = new Set();
    const result = [];
    for (const book of filtered) {
      const key = _normalizeTitle(book.title);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, books: groupMap.get(key) });
      }
    }
    return result;
  }

  // ── GROUP CARD HTML ───────────────────────────────────────
  function _groupCardHTML(group) {
    const grpBooks = group.books;
    const rep   = grpBooks.find(b => b.cover_path) || grpBooks[0];
    const pct   = Math.max(...grpBooks.map(b => b.percent || 0));
    const title = _escHtml(rep.title);
    const hasActive = grpBooks.some(b => b.status === 'reading');
    const ids = grpBooks.map(b => String(b.id));
    const currentId = String(App.currentBookId || '');
    const playingId = String(_playingBookId || '');
    const isCurrent = !!currentId && ids.includes(currentId);
    const isNowPlaying = _isPlaying && !!playingId && ids.includes(playingId);

    let coverHTML;
    if (rep.cover_path) {
      coverHTML = '<img class="lc-cover-img" src="file:///' + _escHtml(rep.cover_path.replace(/\\/g, '/')) + '" alt="" />';
    } else {
      const style  = _generatePlaceholderStyle(rep.title);
      const letter = _escHtml((rep.title || '?')[0].toUpperCase());
      coverHTML = '<div class="lc-cover-placeholder" style="' + style + '">' +
        '<span class="lc-cover-letter">' + letter + '</span>' +
        '<span class="lc-cover-title">' + title + '</span></div>';
    }

    const badges = grpBooks.map(b => {
      const isAudio = AUDIO_FORMATS.includes(b.format);
      const label   = isAudio ? 'AUDIO' : b.format.toUpperCase();
      const cls     = isAudio ? 'audio' : b.format;
      return '<span class="lc-format-badge lcg-badge ' + cls + '">' + label + '</span>';
    }).join('');

    // In bulk mode, a group card selects all its constituent books
    const allSelected   = _bulkSelectMode && ids.every(id => _selectedBooks.has(id));
    const someSelected  = _bulkSelectMode && ids.some(id => _selectedBooks.has(id));
    const bulkCheck     = _bulkSelectMode
      ? '<label class="lc-bulk-check" title="Select all formats for export"><input type="checkbox" data-bulk-ids="' + ids.join(',') + '"' + (allSelected ? ' checked' : '') + (someSelected && !allSelected ? ' data-indeterminate="1"' : '') + '/><span class="lc-bulk-checkmark"></span></label>'
      : '';

    return '<div class="lib-card lib-card-group' +
        (isCurrent      ? ' is-current'     : '') +
        (isNowPlaying   ? ' is-now-playing' : '') +
        (someSelected   ? ' bulk-selected'  : '') +
        (_bulkSelectMode ? ' bulk-mode-card' : '') +
        '" data-group-key="' + _escHtml(group.key) + '" data-book-ids="' + ids.join(',') + '">' +
      '<div class="lcg-stack lcg-stack-2"></div>' +
      '<div class="lcg-stack lcg-stack-1"></div>' +
      bulkCheck +
      '<button class="lc-menu-btn" data-menu-group="' + _escHtml(group.key) + '" title="More options">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
          '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>' +
        '</svg></button>' +
      '<div class="lc-cover">' +
        _playbackBadgeHTML() +
        coverHTML +
        '<div class="lcg-badges">' + badges + '</div>' +
        '<div class="lc-progress-bar"><div class="lc-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="lc-hover-overlay">' +
          '<button class="lc-play-btn" title="Choose Format">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>' +
              '<line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>' +
              '<line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>' +
            '</svg>' +
          '</button></div>' +
      '</div>' +
      '<div class="lc-info">' +
        '<div class="lc-title" title="' + title + '">' + title + '</div>' +
        (rep.author ? '<div class="lc-author">' + _escHtml(rep.author) + '</div>' : '') +
        '<div class="lc-meta">' +
          '<span class="lcg-count">' + grpBooks.length + ' formats</span>' +
          (hasActive ? '<span class="lc-status reading">In progress</span>' : '') +
        '</div>' +
      '</div></div>';
  }

  function _generatePlaceholderStyle(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = ((hash << 5) - hash) + title.charCodeAt(i);
      hash |= 0;
    }
    const hue1 = Math.abs(hash) % 360;
    const hue2 = (hue1 + 40) % 360;
    return 'background:linear-gradient(135deg,hsl(' + hue1 + ',25%,15%),hsl(' + hue2 + ',30%,22%))';
  }

  function _playbackBadgeHTML() {
    return '<span class="lc-now-playing" style="display:none">' +
      '<span class="lc-np-eq"><i></i><i></i><i></i></span>' +
    '</span>';
  }

  function _attachCardListeners() {
    // In bulk-select mode, card clicks toggle selection instead of opening the book
    if (_bulkSelectMode) {
      document.querySelectorAll('.lib-card:not(.lib-card-group)').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.lc-menu-btn')) return;
          // Allow the checkbox label to handle its own click natively
          if (e.target.closest('.lc-bulk-check')) return;
          const id = String(card.dataset.bookId || '');
          if (!id) return;
          if (_selectedBooks.has(id)) _selectedBooks.delete(id);
          else _selectedBooks.add(id);
          _syncBulkToolbar();
          renderGrid();
        });
      });
      document.querySelectorAll('.lib-card-group').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.lc-menu-btn')) return;
          if (e.target.closest('.lc-bulk-check')) return;
          const ids = (card.dataset.bookIds || '').split(',').map(s => s.trim()).filter(Boolean);
          const allSel = ids.every(id => _selectedBooks.has(id));
          if (allSel) ids.forEach(id => _selectedBooks.delete(id));
          else ids.forEach(id => _selectedBooks.add(id));
          _syncBulkToolbar();
          renderGrid();
        });
      });
    } else {
      // Normal mode — open book / format picker
      document.querySelectorAll('.lib-card:not(.lib-card-group)').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.lc-menu-btn')) return;
          App.openBook(card.dataset.bookId).catch(err => console.error('openBook error:', err));
        });
      });
      document.querySelectorAll('.lib-card-group').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.lc-menu-btn')) return;
          _showFormatPicker(card.dataset.groupKey);
        });
      });
    }

    // Bulk checkboxes (native input change for keyboard users)
    document.querySelectorAll('.lc-bulk-check input[data-bulk-id]').forEach(cb => {
      // Set indeterminate state for partial group selection
      if (cb.dataset.indeterminate === '1') cb.indeterminate = true;
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = String(cb.dataset.bulkId || '');
        if (cb.checked) _selectedBooks.add(id);
        else _selectedBooks.delete(id);
        _syncBulkToolbar();
        // Reflect selected class on the card without full re-render
        const card = cb.closest('.lib-card');
        if (card) card.classList.toggle('bulk-selected', cb.checked);
      });
    });
    document.querySelectorAll('.lc-bulk-check input[data-bulk-ids]').forEach(cb => {
      if (cb.dataset.indeterminate === '1') cb.indeterminate = true;
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const ids = (cb.dataset.bulkIds || '').split(',').map(s => s.trim()).filter(Boolean);
        if (cb.checked) ids.forEach(id => _selectedBooks.add(id));
        else ids.forEach(id => _selectedBooks.delete(id));
        _syncBulkToolbar();
        const card = cb.closest('.lib-card');
        if (card) card.classList.toggle('bulk-selected', cb.checked);
      });
    });

    // Single card menu button
    document.querySelectorAll('.lc-menu-btn[data-menu-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _showContextMenu(e, btn.dataset.menuId);
      });
    });
    // Group card menu button
    document.querySelectorAll('.lc-menu-btn[data-menu-group]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _showGroupContextMenu(e, btn.dataset.menuGroup);
      });
    });

    _attachCardDragListeners();
  }

  function _attachCardDragListeners() {
    document.querySelectorAll('.lib-card').forEach(card => {
      card.setAttribute('draggable', 'true');

      card.addEventListener('dragstart', (e) => {
        if (e.target.closest('.lc-menu-btn')) {
          e.preventDefault();
          return;
        }

        const ids = card.dataset.bookIds
          ? String(card.dataset.bookIds).split(',').map(id => id.trim()).filter(Boolean)
          : (card.dataset.bookId ? [String(card.dataset.bookId)] : []);

        if (!ids.length) {
          e.preventDefault();
          return;
        }

        const payload = JSON.stringify({ bookIds: ids });
        e.dataTransfer.setData('application/x-sonara-books', payload);
        e.dataTransfer.setData('text/plain', payload);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('is-dragging');
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('is-dragging');
        document.querySelectorAll('.collection-item.drag-over').forEach(el => el.classList.remove('drag-over'));
      });
    });
  }

  // ── CONTEXT MENU ──────────────────────────────────────────
  function _showContextMenu(e, bookId) {
    _closeContextMenu();
    const book = books.find(b => b.id === bookId);
    if (!book) return;

    const menu = document.createElement('div');
    menu.className = 'lib-context-menu';
    menu.innerHTML =
      '<div class="lib-ctx-item" data-action="open">Open</div>' +
      '<div class="lib-ctx-item" data-action="rename">Rename Book</div>' +
      '<div class="lib-ctx-item" data-action="assign">Add to Collection</div>' +
      '<div class="lib-ctx-item" data-action="classify">✨ Auto-classify</div>' +
      '<div class="lib-ctx-item" data-action="setcover">🖼 Set Cover Image</div>' +
      '<div class="lib-ctx-sep"></div>' +
      '<div class="lib-ctx-item danger" data-action="delete">Remove from Library</div>';

    document.body.appendChild(menu);

    // Position near click
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 160);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    _contextMenu = menu;

    menu.addEventListener('click', async (ev) => {
      const action = ev.target.closest('.lib-ctx-item')?.dataset.action;
      _closeContextMenu();
      if (action === 'open')     App.openBook(bookId).catch(err => console.error('openBook error:', err));
      if (action === 'rename')   renameBook(bookId);
      if (action === 'assign')   showAssignModal(bookId);
      if (action === 'classify') {
        UI.toast('Classifying…', 'success', 2000);
        App._classifyExisting(bookId, book.title);
      }
      if (action === 'setcover') setCoverImage(bookId);
      if (action === 'delete')   deleteBook(bookId);
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _closeContextMenu, { once: true });
    }, 10);
  }

  function _closeContextMenu() {
    if (_contextMenu) { _contextMenu.remove(); _contextMenu = null; }
  }

  // ── GROUP CONTEXT MENU ────────────────────────────────────
  function _showGroupContextMenu(e, key) {
    _closeContextMenu();
    const grpBooks = _buildGroups(_getFilteredBooks()).find(g => g.key === key)?.books || [];
    if (!grpBooks.length) return;
    const rep = grpBooks.find(b => b.cover_path) || grpBooks[0];

    const menu = document.createElement('div');
    menu.className = 'lib-context-menu';
    menu.innerHTML =
      '<div class="lib-ctx-item" data-action="open">Choose Format…</div>' +
      '<div class="lib-ctx-item" data-action="renamegroup">Rename All Versions</div>' +
      '<div class="lib-ctx-item" data-action="classify">✨ Auto-classify</div>' +
      '<div class="lib-ctx-item" data-action="setcover">🖼 Set Cover Image</div>' +
      '<div class="lib-ctx-sep"></div>' +
      '<div class="lib-ctx-item danger" data-action="deletegroup">Remove All Versions</div>';

    document.body.appendChild(menu);
    const x = Math.min(e.clientX, window.innerWidth - 210);
    const y = Math.min(e.clientY, window.innerHeight - 180);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    _contextMenu = menu;

    menu.addEventListener('click', async (ev) => {
      const action = ev.target.closest('.lib-ctx-item')?.dataset.action;
      _closeContextMenu();
      if (action === 'open')        _showFormatPicker(key);
      if (action === 'renamegroup') renameGroupBooks(key, rep.title);
      if (action === 'classify') { UI.toast('Classifying…', 'success', 2000); App._classifyExisting(rep.id, rep.title); }
      if (action === 'setcover')    setCoverImage(rep.id);
      if (action === 'deletegroup') {
        const titles = grpBooks.map(b => b.format.toUpperCase()).join(', ');
        if (!confirm('Remove all ' + grpBooks.length + ' versions of "' + rep.title + '" (' + titles + ') from your library?')) return;
        for (const b of grpBooks) {
          await window.sonara.library.deleteBook(b.id);
          const last = await window.sonara.settings.get('lastBookId', null);
          if (last === b.id) await window.sonara.settings.set('lastBookId', '');
          if (App.currentBookId === b.id) App.clearCurrentBook();
        }
        await load();
        UI.toast(grpBooks.length + ' versions removed', '');
      }
    });
    setTimeout(() => { document.addEventListener('click', _closeContextMenu, { once: true }); }, 10);
  }

  // ── FORMAT PICKER MODAL ───────────────────────────────────
  function _showFormatPicker(key) {
    _currentGroupKey = key;
    const groups  = _buildGroups(_getFilteredBooks());
    const group   = groups.find(g => g.key === key);
    if (!group) return;

    const rep = group.books[0];
    document.getElementById('fpTitle').textContent = rep.title;
    document.getElementById('fpCount').textContent = group.books.length + ' version' + (group.books.length > 1 ? 's' : '') + ' available';

    const listEl = document.getElementById('fpList');
    listEl.innerHTML = group.books.map(b => {
      const isAudio   = AUDIO_FORMATS.includes(b.format);
      const fmtLabel  = isAudio ? 'Audiobook' : b.format.toUpperCase();
      const fmtClass  = isAudio ? 'audio' : b.format;
      const pct       = b.percent || 0;
      const statusLbl = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[b.status] || '';

      let iconSvg;
      if (isAudio) {
        iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      } else if (b.format === 'epub' || b.format === 'mobi' || b.format === 'azw3') {
        iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
      } else {
        iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      }

      let coverThumb = '';
      if (b.cover_path) {
        coverThumb = '<img class="fp-thumb" src="file:///' + b.cover_path.replace(/\\/g, '/') + '" alt=""/>';
      }

      return '<div class="fp-item" data-book-id="' + b.id + '">' +
        '<div class="fp-icon fp-icon-' + fmtClass + '">' + iconSvg + '</div>' +
        '<div class="fp-info">' +
          '<div class="fp-format">' + fmtLabel + ' <span class="fp-ext">.' + b.format + '</span></div>' +
          '<div class="fp-progress-bar"><div class="fp-progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="fp-meta">' + pct + '% &middot; ' + statusLbl + '</div>' +
        '</div>' +
        '<button class="fp-open-btn" data-book-id="' + b.id + '">Open</button>' +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.fp-open-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        UI.closeModal('modalFormatPicker');
        await App.openBook(btn.dataset.bookId);
      });
    });

    UI.openModal('modalFormatPicker');
  }

  // ── SET COVER IMAGE MODAL ─────────────────────────────────
  let _setCoverId   = null;
  let _setCoverPath = null; // chosen image path

  async function setCoverImage(bookId) {
    _setCoverId   = bookId;
    _setCoverPath = null;
    const book = books.find(b => b.id === bookId);
    document.getElementById('setCoverSub').textContent =
      'Choose a cover for "' + _escHtml(book?.title || '') + '"';
    _scReset();
    UI.openModal('modalSetCover');
  }

  function _scReset() {
    _setCoverPath = null;
    document.getElementById('scPreviewWrap').style.display = 'none';
    document.getElementById('scPlaceholder').style.display = 'flex';
    document.getElementById('scPreviewImg').src = '';
    document.getElementById('scSaveBtn').disabled = true;
  }

  function _scSetPreview(filePath) {
    _setCoverPath = filePath;
    const img = document.getElementById('scPreviewImg');
    img.src = 'file:///' + filePath.replace(/\\/g, '/');
    document.getElementById('scPreviewWrap').style.display = 'flex';
    document.getElementById('scPlaceholder').style.display = 'none';
    document.getElementById('scSaveBtn').disabled = false;
  }

  async function _scSave() {
    if (!_setCoverId || !_setCoverPath) return;
    try {
      await window.sonara.cover.saveFromFile(_setCoverId, _setCoverPath);
      UI.closeModal('modalSetCover');
      UI.toast('Cover image updated!', 'success');
      await load();
    } catch (err) {
      UI.toast('Could not save cover: ' + (err.message || err), 'error');
    }
  }

  function _initSetCoverModal() {
    const dropZone   = document.getElementById('scDropZone');
    const browseBtn  = document.getElementById('scBrowseBtn');
    const clearBtn   = document.getElementById('scClearBtn');
    const saveBtn    = document.getElementById('scSaveBtn');

    // Browse button → file picker dialog
    browseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const imagePath = await window.sonara.dialog.openImage();
      if (imagePath) _scSetPreview(imagePath);
    });

    // Click anywhere on drop zone → file picker
    dropZone.addEventListener('click', async (e) => {
      if (e.target.closest('#scBrowseBtn') || e.target.closest('#scClearBtn')) return;
      if (document.getElementById('scPreviewWrap').style.display !== 'none') return;
      const imagePath = await window.sonara.dialog.openImage();
      if (imagePath) _scSetPreview(imagePath);
    });

    // Clear preview
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); _scReset(); });

    // Save button
    saveBtn.addEventListener('click', _scSave);

    // Drag-and-drop
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        // Use file URL path for local files
        const url = URL.createObjectURL(file);
        // We need the real path — Electron exposes it via file.path
        if (file.path) {
          _scSetPreview(file.path);
          URL.revokeObjectURL(url);
        } else {
          // Fallback: show blob preview only (no save path)
          document.getElementById('scPreviewImg').src = url;
          document.getElementById('scPreviewWrap').style.display = 'flex';
          document.getElementById('scPlaceholder').style.display = 'none';
          document.getElementById('scSaveBtn').disabled = true;
          UI.toast('Drag-and-drop works best with local files. Use Browse instead.', 'error', 3000);
        }
      }
    });
  }

  // ── RENDER COLLECTIONS SIDEBAR ────────────────────────────
  function renderCollections() {
    // Update built-in counts
    document.getElementById('colAllCount').textContent     = books.length;
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    document.getElementById('colRecentCount').textContent   = books.filter(b => b.added_at > weekAgo).length;
    document.getElementById('colReadingCount').textContent   = books.filter(b => b.status === 'reading').length;

    // Render user collections
    const container = document.getElementById('userCollections');
    if (!collections.length) {
      container.innerHTML = '';
      return;
    }

    const ordered = _orderedCollections();
    container.innerHTML = ordered.map(({ col: c, depth }) => {
      const count = bookCollectionMap[c.id]?.size || 0;
      const isActive = activeCollection === c.id;
      const marker = depth > 0 ? '<span class="collection-tree-marker">↳</span>' : '';
      return '<div class="collection-item' + (isActive ? ' active' : '') + '" data-collection="' + c.id + '">' +
        '<span class="collection-indent" style="--indent:' + (depth * 14) + 'px"></span>' +
        marker +
        '<div class="user-col-dot" style="background:' + _escHtml(c.color) + '"></div>' +
        '<span class="col-name">' + _escHtml(c.name) + '</span>' +
        '<span class="col-count">' + count + '</span>' +
        '<button class="col-add-child-btn" data-col-child="' + c.id + '" title="Create subfolder">+</button>' +
        '<button class="col-delete-btn" data-col-del="' + c.id + '" title="Delete collection">&times;</button>' +
      '</div>';
    }).join('');

    // Attach click listeners
    container.querySelectorAll('.collection-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.col-delete-btn')) return;
        const colId = parseInt(item.dataset.collection, 10);
        _setActiveCollection(colId);
      });
    });
    container.querySelectorAll('.col-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const colId = parseInt(btn.dataset.colDel, 10);
        _deleteCollection(colId);
      });
    });
    container.querySelectorAll('.col-add-child-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const colId = parseInt(btn.dataset.colChild, 10);
        showCreateCollectionModal(colId);
      });
    });

    _wireCollectionDropTargets(container);
  }

  function _wireCollectionDropTargets(container) {
    container.querySelectorAll('.collection-item[data-collection]').forEach(item => {
      const colId = parseInt(item.dataset.collection, 10);
      if (Number.isNaN(colId)) return;

      item.addEventListener('dragover', (e) => {
        if (!_hasBookDragData(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', (e) => {
        if (!item.contains(e.relatedTarget)) {
          item.classList.remove('drag-over');
        }
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const ids = _extractDraggedBookIds(e);
        if (!ids.length) return;

        const addedCount = await _addBooksToCollection(ids, colId);
        if (!addedCount) {
          UI.toast('Book already in this collection', '', 1800);
          return;
        }

        const col = collections.find(c => c.id === colId);
        const label = col?.name || 'collection';
        const noun = addedCount === 1 ? 'book' : 'books';
        UI.toast('Added ' + addedCount + ' ' + noun + ' to ' + label, 'success', 2200);
        await load();
      });
    });
  }

  function _extractDraggedBookIds(e) {
    const custom = e.dataTransfer?.getData('application/x-sonara-books') || '';
    const plain = e.dataTransfer?.getData('text/plain') || '';
    const raw = custom || plain;
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.bookIds)) {
        return parsed.bookIds.map(id => String(id).trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
    return [];
  }

  function _hasBookDragData(e) {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes('application/x-sonara-books') || types.includes('text/plain');
  }

  async function _addBooksToCollection(bookIds, collectionId) {
    let added = 0;
    const uniqueIds = [...new Set(bookIds.map(id => String(id)))] ;
    if (!bookCollectionMap[collectionId]) bookCollectionMap[collectionId] = new Set();

    for (const bookId of uniqueIds) {
      const alreadyIn = bookCollectionMap[collectionId].has(bookId);
      if (alreadyIn) continue;
      try {
        await window.sonara.collections.addBook(bookId, collectionId);
        bookCollectionMap[collectionId].add(bookId);
        added++;
      } catch {
        // Ignore duplicates/race errors and continue with remaining books.
      }
    }

    return added;
  }

  function _orderedCollections() {
    const byParent = new Map();
    for (const col of collections) {
      const parent = Number.isInteger(col.parent_id) ? col.parent_id : null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(col);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
    }

    const ordered = [];
    const seen = new Set();
    const walk = (parentId, depth) => {
      const children = byParent.get(parentId) || [];
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        ordered.push({ col: child, depth });
        walk(child.id, depth + 1);
      }
    };

    walk(null, 0);

    for (const col of collections) {
      if (!seen.has(col.id)) {
        ordered.push({ col, depth: 0 });
      }
    }
    return ordered;
  }

  function _setActiveCollection(val) {
    activeCollection = val;
    // Update sidebar active states
    document.querySelectorAll('.collection-item').forEach(item => {
      const v = item.dataset.collection;
      const match = (v === String(val)) || (v === val);
      item.classList.toggle('active', match);
    });
    _updateStats();
    renderGrid();
  }

  // ── COLLECTION CRUD ───────────────────────────────────────
  function showCreateCollectionModal(parentId = null) {
    _editCollectionId = null;
    document.getElementById('colModalTitle').textContent = 'New Collection';
    document.getElementById('colNameInput').value = '';
    document.getElementById('colModalSave').textContent = 'Create';
    _populateParentOptions(parentId);
    // Reset color swatches
    document.querySelectorAll('.col-swatch').forEach((s, i) => s.classList.toggle('active', i === 0));
    UI.openModal('modalCollection');
    document.getElementById('colNameInput').focus();
  }

  function _populateParentOptions(selectedParentId = null) {
    const select = document.getElementById('colParentSelect');
    if (!select) return;

    const ordered = _orderedCollections();
    const options = ['<option value="">Top level</option>'];
    for (const { col, depth } of ordered) {
      const indent = '&nbsp;'.repeat(depth * 4);
      options.push('<option value="' + col.id + '">' + indent + _escHtml(col.name) + '</option>');
    }
    select.innerHTML = options.join('');

    const activeParent = Number.isInteger(selectedParentId)
      ? selectedParentId
      : (typeof activeCollection === 'number' ? activeCollection : null);

    if (activeParent !== null) {
      select.value = String(activeParent);
    }
  }

  async function _saveCollection() {
    const name  = document.getElementById('colNameInput').value.trim();
    if (!name) { UI.toast('Please enter a collection name', 'error'); return; }

    const activeSwatch = document.querySelector('.col-swatch.active');
    const color = activeSwatch?.dataset.color || '#c8a96e';
    const parentRaw = document.getElementById('colParentSelect')?.value;
    const parentId = parentRaw ? parseInt(parentRaw, 10) : null;

    try {
      if (_editCollectionId) {
        await window.sonara.collections.update(_editCollectionId, { name, color, parent_id: parentId });
        UI.toast('Collection updated', 'success');
      } else {
        await window.sonara.collections.create(name, color, parentId);
        UI.toast('Collection created', 'success');
      }
      UI.closeModal('modalCollection');
      await load();
    } catch (err) {
      UI.toast('Error: ' + (err.message || 'Could not save'), 'error');
    }
  }

  let _deleteColResolve = null;

  async function _deleteCollection(id) {
    const col = collections.find(c => c.id === id);
    if (!col) return;
    const bookCount = bookCollectionMap[id]?.size || 0;

    // Populate and open the confirmation modal
    document.getElementById('delColName').textContent      = col.name;
    document.getElementById('delColDot').style.background  = col.color || '#888';
    document.getElementById('delColBookCount').textContent = bookCount;
    document.getElementById('delColSub').textContent =
      'You are about to delete “' + col.name + '”.';

    const confirmed = await new Promise(resolve => {
      _deleteColResolve = resolve;
      document.getElementById('delColConfirmBtn').onclick = () => { resolve(true);  UI.closeModal('modalDeleteCollection'); };
      UI.openModal('modalDeleteCollection');
    });
    _deleteColResolve = null;
    if (!confirmed) return;

    await window.sonara.collections.delete(id);
    if (activeCollection === id) _setActiveCollection('all');
    UI.toast('Collection “' + col.name + '” deleted — ' + bookCount + ' book(s) kept', 'success', 3500);
    await load();
  }

  function closeDeleteColModal() {
    if (_deleteColResolve) { _deleteColResolve(false); _deleteColResolve = null; }
    UI.closeModal('modalDeleteCollection');
  }

  // ── ASSIGN TO COLLECTION ──────────────────────────────────
  async function showAssignModal(bookId) {
    _assignBookId = bookId;
    const book = books.find(b => b.id === bookId);
    document.getElementById('assignColSub').textContent = 'Select collections for "' + (book?.title || '') + '"';

    const bookCols = await window.sonara.collections.getBookCollections(bookId);
    const bookColIds = new Set(bookCols.map(c => c.id));

    const list = document.getElementById('assignColList');
    if (!collections.length) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">No collections yet. Create one first.</div>';
    } else {
      list.innerHTML = collections.map(c => {
        const checked = bookColIds.has(c.id) ? ' checked' : '';
        return '<div class="assign-col-item' + checked + '" data-col-id="' + c.id + '">' +
          '<div class="assign-col-check"></div>' +
          '<div class="assign-col-item-dot" style="background:' + _escHtml(c.color) + '"></div>' +
          '<span class="assign-col-item-name">' + _escHtml(c.name) + '</span></div>';
      }).join('');

      // Toggle on click
      list.querySelectorAll('.assign-col-item').forEach(item => {
        item.addEventListener('click', () => item.classList.toggle('checked'));
      });
    }

    UI.openModal('modalAssignCollection');
  }

  async function saveAssignments() {
    if (!_assignBookId) return;
    const items = document.querySelectorAll('#assignColList .assign-col-item');
    for (const item of items) {
      const colId   = parseInt(item.dataset.colId, 10);
      const checked = item.classList.contains('checked');
      const wasIn   = bookCollectionMap[colId]?.has(_assignBookId) || false;
      if (checked && !wasIn)  await window.sonara.collections.addBook(_assignBookId, colId);
      if (!checked && wasIn)  await window.sonara.collections.removeBook(_assignBookId, colId);
    }
    UI.closeModal('modalAssignCollection');
    UI.toast('Collections updated', 'success');
    await load();
  }

  // ── SEARCH & FILTERS ─────────────────────────────────────
  function _initSearchAndFilters() {
    const searchInput = document.getElementById('libSearch');
    const searchClear = document.getElementById('libSearchClear');

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = searchInput.value.trim();
        searchClear.style.display = searchQuery ? 'flex' : 'none';
        renderGrid();
        _updateStats();
      }, 150);
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      searchClear.style.display = 'none';
      renderGrid();
      _updateStats();
    });

    // Format tabs
    document.querySelectorAll('.lib-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeFormat = tab.dataset.format;
        renderGrid();
        _updateStats();
      });
    });

    // Sort
    document.getElementById('libSort').addEventListener('change', (e) => {
      sortBy = e.target.value;
      renderGrid();
    });

    // Add book buttons (library view)
    document.getElementById('libAddBtn').addEventListener('click', () => App.addBook());
    document.getElementById('libEmptyAddBtn').addEventListener('click', () => App.addBook());

    // Drag-and-drop import directly into library grid
    const gridWrap = document.getElementById('libGridWrap');
    if (gridWrap) {
      gridWrap.addEventListener('dragover', (e) => {
        e.preventDefault();
        gridWrap.classList.add('drag-over');
      });

      gridWrap.addEventListener('dragleave', (e) => {
        if (!gridWrap.contains(e.relatedTarget)) {
          gridWrap.classList.remove('drag-over');
        }
      });

      gridWrap.addEventListener('drop', async (e) => {
        e.preventDefault();
        gridWrap.classList.remove('drag-over');
        const droppedFiles = Array.from(e.dataTransfer?.files || []);
        if (!droppedFiles.length) return;
        await App.addDroppedFiles(droppedFiles);
      });
    }
  }

  function _initCollectionListeners() {
    // Built-in collection items
    document.querySelectorAll('#collectionList > .collection-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.dataset.collection;
        _setActiveCollection(val);
      });
    });

    // New collection button
    document.getElementById('btnNewCollection').addEventListener('click', showCreateCollectionModal);

    // Collection modal save
    document.getElementById('colModalSave').addEventListener('click', _saveCollection);

    // Collection modal enter key
    document.getElementById('colNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _saveCollection();
    });

    // Color swatches
    document.querySelectorAll('.col-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.col-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
      });
    });

    // Assign collection modal save
    document.getElementById('assignColSave').addEventListener('click', saveAssignments);

    const renameInput = document.getElementById('renameBookInput');
    if (renameInput) {
      renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveRename();
        }
      });
    }
  }

  // ── STATS ─────────────────────────────────────────────────
  function _updateStats() {
    const filtered = _getFilteredBooks();
    const total    = books.length;
    const shown    = filtered.length;
    let text;
    if (searchQuery || activeFormat !== 'all' || activeCollection !== 'all') {
      text = shown + ' of ' + total + ' book' + (total !== 1 ? 's' : '');
    } else {
      text = total + ' book' + (total !== 1 ? 's' : '') + ' in library';
    }
    document.getElementById('libStatsText').textContent = text;
  }

  // ── OLD SIDEBAR (for reader mode) ────────────────────────
  function _renderOldSidebar() {
    const list  = document.getElementById('bookList');
    const empty = document.getElementById('libEmpty');
    if (!list) return;

    const total   = books.length;
    const reading = books.filter(b => b.status === 'reading').length;
    const totalEl   = document.getElementById('lsmTotal');
    const readingEl = document.getElementById('lsmReading');
    if (totalEl)   totalEl.textContent   = total + ' book' + (total !== 1 ? 's' : '');
    if (readingEl) readingEl.textContent = reading + ' reading';

    if (!total) {
      empty.classList.add('visible');
      list.innerHTML = '';
      return;
    }
    empty.classList.remove('visible');
    list.innerHTML = books.map(b => _oldCardHTML(b)).join('');
  }

  function _oldCardHTML(b) {
    const pct        = b.percent || 0;
    const statusLabel = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[b.status] || '';
    const isAudio    = AUDIO_FORMATS.includes(b.format);
    const fmtClass   = isAudio ? 'audio' : (b.format === 'epub' ? 'epub' : 'pdf');
    const fmtLabel   = isAudio ? 'AUDIO' : b.format.toUpperCase();
    const lastRead   = b.last_read ? _relTime(b.last_read) : 'Never';
    const isActive   = App.currentBookId === b.id;
    const unitLabel  = b.format === 'epub' ? 'ch' : (isAudio ? 'audio' : 'pg');

    return '<div class="book-card' + (isActive ? ' active' : '') + '" id="bc-' + b.id + '" onclick="App.openBook(\'' + b.id + '\')">' +
      '<button class="bc-delete-btn" onclick="event.stopPropagation();Library.deleteBook(' + JSON.stringify(b.id) + ')" title="Remove">\u2715</button>' +
      '<div class="bc-progress-stripe"><div class="bc-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bc-inner">' +
        '<div class="bc-top">' +
          '<span class="bc-format ' + fmtClass + '">' + fmtLabel + '</span>' +
          '<span class="bc-title" title="' + _escHtml(b.title) + '">' + _escHtml(b.title) + '</span></div>' +
        '<div class="bc-meta">' + (isAudio ? 'Audiobook' : b.total_chunks + ' ' + unitLabel) + ' \u00b7 ' + lastRead + '</div>' +
        '<div class="bc-bottom"><span class="bc-pct">' + pct + '%</span><span class="bc-status ' + b.status + '">' + statusLabel + '</span></div>' +
      '</div></div>';
  }

  // ── REFRESH A SINGLE CARD ─────────────────────────────────
  function refreshCard(id, pct, status) {
    const idx = books.findIndex(b => b.id === id);
    if (idx < 0) return;
    books[idx].percent  = pct;
    books[idx].status   = status;
    books[idx].last_read = Date.now();

    // Update old sidebar card
    const el = document.getElementById('bc-' + id);
    if (el) {
      const fill = el.querySelector('.bc-progress-fill');
      if (fill) fill.style.width = pct + '%';
      const pctEl = el.querySelector('.bc-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      const stEl = el.querySelector('.bc-status');
      if (stEl) {
        stEl.className = 'bc-status ' + status;
        stEl.textContent = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[status] || '';
      }
      const meta = el.querySelector('.bc-meta');
      if (meta) {
        const b = books[idx];
        const isAudio = AUDIO_FORMATS.includes(b.format);
        meta.textContent = (isAudio ? 'Audiobook' : b.total_chunks + ' ' + (b.format === 'epub' ? 'ch' : 'pg')) + ' \u00b7 Just now';
      }
    }

    // Update library grid card if visible
    const gridCard = document.querySelector('.lib-card[data-book-id="' + id + '"]');
    if (gridCard) {
      const fill = gridCard.querySelector('.lc-progress-fill');
      if (fill) fill.style.width = pct + '%';
      const pctEl = gridCard.querySelector('.lc-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      const stEl = gridCard.querySelector('.lc-status');
      if (stEl) {
        stEl.className = 'lc-status ' + status;
        stEl.textContent = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[status] || '';
      }
    }

    // Stats
    const reading = books.filter(b => b.status === 'reading').length;
    const readingEl = document.getElementById('lsmReading');
    if (readingEl) readingEl.textContent = reading + ' reading';

    _syncPlaybackMarkers();
  }

  // ── ADD BOOK ──────────────────────────────────────────────
  async function addBookToList(bookData) {
    await load();
    // Scroll to new card in grid
    const card = document.querySelector('.lib-card[data-book-id="' + bookData.id + '"]');
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── DELETE ────────────────────────────────────────────────
  async function renameBook(id) {
    const book = books.find(b => b.id === id);
    if (!book) return;

    _renameBookIds = [book.id];
    _renameMode = 'single';

    const titleEl = document.getElementById('renameBookTitle');
    const subEl = document.getElementById('renameBookSub');
    const input = document.getElementById('renameBookInput');
    if (titleEl) titleEl.textContent = 'Rename Book';
    if (subEl) subEl.textContent = 'Update the title in your library';
    if (input) {
      input.value = book.title || '';
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    UI.openModal('modalRenameBook');
  }

  async function renameGroupBooks(groupKey, currentTitle) {
    const group = _buildGroups(_getFilteredBooks()).find(g => g.key === groupKey);
    if (!group || !group.books.length) return;

    _renameBookIds = group.books.map(b => b.id);
    _renameMode = 'group';

    const titleEl = document.getElementById('renameBookTitle');
    const subEl = document.getElementById('renameBookSub');
    const input = document.getElementById('renameBookInput');
    if (titleEl) titleEl.textContent = 'Rename All Versions';
    if (subEl) subEl.textContent = 'Apply one title to ' + _renameBookIds.length + ' version' + (_renameBookIds.length > 1 ? 's' : '');
    if (input) {
      input.value = currentTitle || group.books[0].title || '';
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    UI.openModal('modalRenameBook');
  }

  async function saveRename() {
    if (!_renameBookIds.length) return;

    const input = document.getElementById('renameBookInput');
    const clean = String(input?.value || '').trim();
    if (!clean) {
      UI.toast('Title cannot be empty', 'error');
      input?.focus();
      return;
    }

    let changed = 0;
    for (const id of _renameBookIds) {
      const book = books.find(b => b.id === id);
      if (!book || book.title === clean) continue;
      await window.sonara.library.updateBook(id, { title: clean });
      changed++;
    }

    closeRenameModal();
    if (!changed) return;

    await load();
    if (_renameMode === 'group') {
      UI.toast('Renamed ' + changed + ' version' + (changed > 1 ? 's' : ''), 'success');
    } else {
      UI.toast('Book renamed', 'success');
    }
  }

  function closeRenameModal() {
    _renameBookIds = [];
    _renameMode = 'single';
    UI.closeModal('modalRenameBook');
  }

  async function deleteBook(id) {
    const book = books.find(b => b.id === id);
    if (!book) return;
    if (!confirm('Remove "' + book.title + '" from your library?\nProgress will be lost and the file deleted from Sonara\'s storage.')) return;

    await window.sonara.library.deleteBook(id);

    const lastBookId = await window.sonara.settings.get('lastBookId', null);
    if (lastBookId === id) await window.sonara.settings.set('lastBookId', '');
    if (App.currentBookId === id) App.clearCurrentBook();

    await load();
    UI.toast('Book removed', '');
  }

  // ── MARK ACTIVE ───────────────────────────────────────────
  function setActiveCard(id) {
    document.querySelectorAll('.book-card').forEach(el => el.classList.remove('active'));
    if (id) document.getElementById('bc-' + id)?.classList.add('active');
    _syncPlaybackMarkers();
  }

  function setPlaybackState(bookId, isPlaying) {
    _playingBookId = bookId || null;
    _isPlaying = !!isPlaying;
    _syncPlaybackMarkers();
  }

  function _syncPlaybackMarkers() {
    const currentId = String(App.currentBookId || '');
    const playingId = _isPlaying && _playingBookId ? String(_playingBookId) : '';
    const playingBook = playingId ? books.find(b => String(b.id) === playingId) : null;
    const currentBook = currentId ? books.find(b => String(b.id) === currentId) : null;

    document.querySelectorAll('.lib-card').forEach(card => {
      let ids = [];
      if (card.dataset.bookId) ids = [String(card.dataset.bookId)];
      else if (card.dataset.bookIds) ids = String(card.dataset.bookIds).split(',');

      const isCurrent = !!currentId && ids.includes(currentId);
      const isNowPlaying = !!playingId && ids.includes(playingId);

      card.classList.toggle('is-current', isCurrent);
      card.classList.toggle('is-now-playing', isNowPlaying);

      const badge = card.querySelector('.lc-now-playing');
      if (!badge) return;

      if (isNowPlaying) {
        badge.style.display = 'inline-flex';
        return;
      }
      if (isCurrent) {
        badge.style.display = 'inline-flex';
        return;
      }
      badge.style.display = 'none';
    });

    const nowPlayingEl = document.getElementById('libNowPlaying');
    if (nowPlayingEl) {
      if (playingBook) {
        nowPlayingEl.classList.add('active');
        nowPlayingEl.textContent = 'Now Playing: ' + playingBook.title;
      } else if (currentBook) {
        nowPlayingEl.classList.remove('active');
        nowPlayingEl.textContent = 'Current: ' + currentBook.title;
      } else {
        nowPlayingEl.classList.remove('active');
        nowPlayingEl.textContent = '';
      }
    }
  }

  // ── ON SHOW (called when switching to library mode) ──────
  function onShow() {
    load();
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'Just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── BULK SELECT MODE ──────────────────────────────────────

  function toggleBulkSelectMode() {
    _bulkSelectMode = !_bulkSelectMode;
    if (!_bulkSelectMode) {
      _selectedBooks.clear();
      _syncBulkToolbar();
    }
    const btn = document.getElementById('btnBulkSelect');
    if (btn) btn.classList.toggle('active', _bulkSelectMode);
    renderGrid();
    _syncBulkToolbar();
  }

  function _syncBulkToolbar() {
    const toolbar = document.getElementById('bulkActionBar');
    const countEl = document.getElementById('bulkSelCount');
    const exportBtn = document.getElementById('btnBulkExportM4B');
    const selColBtn = document.getElementById('btnSelectCollection');

    if (!toolbar) return;

    if (_bulkSelectMode) {
      toolbar.style.display = 'flex';
      const n = _selectedBooks.size;
      if (countEl) countEl.textContent = n + ' book' + (n !== 1 ? 's' : '') + ' selected';
      if (exportBtn) exportBtn.disabled = n === 0;
    } else {
      toolbar.style.display = 'none';
    }
  }

  /**
   * Select all books in the currently active collection (or all filtered books).
   */
  function selectCurrentCollection() {
    const filtered = _getFilteredBooks();
    filtered.forEach(b => _selectedBooks.add(String(b.id)));
    _syncBulkToolbar();
    renderGrid();
  }

  /** Return the book objects for all currently selected IDs. */
  function getSelectedBooks() {
    const idSet = _selectedBooks;
    return books.filter(b => idSet.has(String(b.id)));
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    load, render: renderGrid, renderGrid, refreshCard, addBookToList,
    deleteBook, setActiveCard, setPlaybackState, onShow,
    showCreateCollectionModal, showAssignModal, saveAssignments,
    closeDeleteColModal, setCoverImage,
    saveRename, closeRenameModal,
    getBooks: () => books,
    toggleBulkSelectMode,
    selectCurrentCollection,
    getSelectedBooks,
    isBulkSelectMode: () => _bulkSelectMode,
  };
})();
