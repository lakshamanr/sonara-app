/* ══════════════════════════════════════════════════════════
   LIBRARY.JS — Book list, cards, refresh
══════════════════════════════════════════════════════════ */
'use strict';

const Library = (() => {

  let books = [];

  // ── LOAD & RENDER ─────────────────────────────────────────
  async function load() {
    try {
      books = await window.sonara.library.getAll() || [];
      render();
      console.log('Library loaded:', books.length, 'books');
    } catch (err) {
      console.error('Error loading library:', err);
      books = [];
      render();
    }
  }

  function render() {
    const list  = document.getElementById('bookList');
    const empty = document.getElementById('libEmpty');

    // Stats
    const total   = books.length;
    const reading = books.filter(b => b.status === 'reading').length;
    document.getElementById('lsmTotal').textContent   = total + ' book' + (total !== 1 ? 's' : '');
    document.getElementById('lsmReading').textContent = reading + ' reading';

    if (!total) {
      empty.classList.add('visible');
      list.innerHTML = '';
      return;
    }

    empty.classList.remove('visible');

    list.innerHTML = books.map(b => _cardHTML(b)).join('');
  }

  function _cardHTML(b) {
    const pct        = b.percent || 0;
    const statusLabel = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[b.status] || '';
    const fmtClass   = b.format === 'epub' ? 'epub' : 'pdf';
    const lastRead   = b.last_read ? _relTime(b.last_read) : 'Never';
    const isActive   = App.currentBookId === b.id;

    return `
      <div class="book-card${isActive ? ' active' : ''}" id="bc-${b.id}" onclick="console.log('[Library] Card clicked:', '${b.id}'); App.openBook('${b.id}')">
        <button class="bc-delete-btn" onclick="event.stopPropagation();Library.deleteBook(${JSON.stringify(b.id)})" title="Remove">✕</button>
        <div class="bc-progress-stripe">
          <div class="bc-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="bc-inner">
          <div class="bc-top">
            <span class="bc-format ${fmtClass}">${b.format.toUpperCase()}</span>
            <span class="bc-title" title="${_escHtml(b.title)}">${_escHtml(b.title)}</span>
          </div>
          <div class="bc-meta">${b.total_chunks} ${b.format==='epub'?'ch':'pg'} · ${lastRead}</div>
          <div class="bc-bottom">
            <span class="bc-pct">${pct}%</span>
            <span class="bc-status ${b.status}">${statusLabel}</span>
          </div>
        </div>
      </div>`;
  }

  // ── REFRESH A SINGLE CARD ─────────────────────────────────
  function refreshCard(id, pct, status) {
    const idx = books.findIndex(b => b.id === id);
    if (idx < 0) return;
    books[idx].percent = pct;
    books[idx].status  = status;
    books[idx].last_read = Date.now();

    const el = document.getElementById('bc-' + id);
    if (!el) return;

    // Update progress stripe
    const fill = el.querySelector('.bc-progress-fill');
    if (fill) fill.style.width = pct + '%';

    // Update pct text
    const pctEl = el.querySelector('.bc-pct');
    if (pctEl) pctEl.textContent = pct + '%';

    // Update status
    const stEl = el.querySelector('.bc-status');
    if (stEl) {
      stEl.className = 'bc-status ' + status;
      stEl.textContent = { unstarted: 'Not started', reading: 'In progress', done: 'Completed' }[status] || '';
    }

    // Update meta (last read)
    const meta = el.querySelector('.bc-meta');
    if (meta) {
      const b = books[idx];
      meta.textContent = b.total_chunks + ' ' + (b.format==='epub'?'ch':'pg') + ' · Just now';
    }

    // Stats
    const reading = books.filter(b => b.status === 'reading').length;
    document.getElementById('lsmReading').textContent = reading + ' reading';
  }

  // ── ADD BOOK ──────────────────────────────────────────────
  async function addBookToList(bookData) {
    // bookData already saved via IPC in App — just reload
    await load();
    // Highlight the new card
    const el = document.getElementById('bc-' + bookData.id);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── DELETE ────────────────────────────────────────────────
  async function deleteBook(id) {
    const book = books.find(b => b.id === id);
    if (!book) return;
    if (!confirm(`Remove "${book.title}" from your library?\nProgress will be lost and the file deleted from Sonara's storage.`)) return;

    await window.sonara.library.deleteBook(id);

    // Clear auto-load if this was the last-opened book
    const lastBookId = await window.sonara.settings.get('lastBookId', null);
    if (lastBookId === id) {
      await window.sonara.settings.set('lastBookId', '');
    }

    // If currently open, reset player
    if (App.currentBookId === id) {
      App.clearCurrentBook();
    }

    await load();
    UI.toast('Book removed', '');
  }

  // ── MARK ACTIVE ───────────────────────────────────────────
  function setActiveCard(id) {
    document.querySelectorAll('.book-card').forEach(el => el.classList.remove('active'));
    if (id) {
      document.getElementById('bc-' + id)?.classList.add('active');
    }
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _relTime(ts) {
    const diff = Date.now() - ts;
    const m    = Math.floor(diff / 60000);
    if (m < 1)  return 'Just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { load, render, refreshCard, addBookToList, deleteBook, setActiveCard };
})();
