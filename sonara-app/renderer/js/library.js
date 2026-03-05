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

  const AUDIO_FORMATS = ['mp3', 'm4b', 'm4a', 'ogg'];

  // ── LOAD ─────────────────────────────────────────────────
  async function load() {
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
        _initialized = true;
      }

    } catch (err) {
      books = [];
      renderGrid();
    }
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

    grid.innerHTML = filtered.map(b => _coverCardHTML(b)).join('');
    _attachCardListeners();
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

    return '<div class="lib-card" data-book-id="' + b.id + '" data-format="' + b.format + '">' +
      '<button class="lc-menu-btn" data-menu-id="' + b.id + '" title="More options">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
          '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>' +
        '</svg></button>' +
      '<div class="lc-cover">' +
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

  function _attachCardListeners() {
    // Card click -> open book
    document.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.lc-menu-btn')) return;
        const id = card.dataset.bookId;
        App.openBook(id).catch(err => console.error('openBook error:', err));
      });
    });
    // Menu button -> context menu
    document.querySelectorAll('.lc-menu-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.menuId;
        _showContextMenu(e, id);
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
      '<div class="lib-ctx-item" data-action="assign">Add to Collection</div>' +
      '<div class="lib-ctx-item" data-action="classify">✨ Auto-classify</div>' +
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
      if (action === 'assign')   showAssignModal(bookId);
      if (action === 'classify') {
        UI.toast('Classifying…', 'success', 2000);
        App._classifyExisting(bookId, book.title);
      }
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

    container.innerHTML = collections.map(c => {
      const count = bookCollectionMap[c.id]?.size || 0;
      const isActive = activeCollection === c.id;
      return '<div class="collection-item' + (isActive ? ' active' : '') + '" data-collection="' + c.id + '">' +
        '<div class="user-col-dot" style="background:' + _escHtml(c.color) + '"></div>' +
        '<span class="col-name">' + _escHtml(c.name) + '</span>' +
        '<span class="col-count">' + count + '</span>' +
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
  function showCreateCollectionModal() {
    _editCollectionId = null;
    document.getElementById('colModalTitle').textContent = 'New Collection';
    document.getElementById('colNameInput').value = '';
    document.getElementById('colModalSave').textContent = 'Create';
    // Reset color swatches
    document.querySelectorAll('.col-swatch').forEach((s, i) => s.classList.toggle('active', i === 0));
    UI.openModal('modalCollection');
    document.getElementById('colNameInput').focus();
  }

  async function _saveCollection() {
    const name  = document.getElementById('colNameInput').value.trim();
    if (!name) { UI.toast('Please enter a collection name', 'error'); return; }

    const activeSwatch = document.querySelector('.col-swatch.active');
    const color = activeSwatch?.dataset.color || '#c8a96e';

    try {
      if (_editCollectionId) {
        await window.sonara.collections.update(_editCollectionId, { name, color });
        UI.toast('Collection updated', 'success');
      } else {
        await window.sonara.collections.create(name, color);
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
  }

  // ── ADD BOOK ──────────────────────────────────────────────
  async function addBookToList(bookData) {
    await load();
    // Scroll to new card in grid
    const card = document.querySelector('.lib-card[data-book-id="' + bookData.id + '"]');
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── DELETE ────────────────────────────────────────────────
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

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    load, render: renderGrid, renderGrid, refreshCard, addBookToList,
    deleteBook, setActiveCard, onShow,
    showCreateCollectionModal, showAssignModal, saveAssignments,
    closeDeleteColModal,
    getBooks: () => books
  };
})();
