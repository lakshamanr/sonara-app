'use strict';

const Review = (() => {
  let bookId = null;
  let notes = [];
  let state = {};
  let current = null;
  let currentBookId = null;
  let sources = [];

  const intervals = { again: 10 * 60 * 1000, good: 24 * 60 * 60 * 1000, remembered: 3 * 24 * 60 * 60 * 1000 };

  async function load(id, bookNotes = []) {
    currentBookId = id || null;
    bookId = id || null;
    notes = bookNotes;
    state = (await window.sonara.settings.get('review_state', {})) || {};
    current = null;
    await loadSources();
    render();
  }

  async function loadSources() {
    const select = document.getElementById('reviewSource');
    if (!select) return;
    try {
      const books = await window.sonara.library.getAll();
      const collections = await window.sonara.collections.getAll();
      sources = [
        ...books.map(book => ({ value: 'book:' + book.id, label: book.title, type: 'book', id: book.id })),
        ...collections.map(col => ({ value: 'collection:' + col.id, label: 'Collection: ' + col.name, type: 'collection', id: col.id })),
      ];
      select.innerHTML = '<option value="current">Current book</option>' +
        sources.map(source => `<option value="${source.value}">${_esc(source.label)}</option>`).join('');
      select.value = 'book:' + (currentBookId || '');
    } catch (err) {
      console.error('[Review] Could not load review sources:', err);
    }
  }

  async function selectSource(value) {
    if (!value || value === 'current' || value === 'book:' + currentBookId) {
      bookId = currentBookId;
      notes = currentBookId ? await window.sonara.notes.getAll(currentBookId) : [];
    } else {
      const source = sources.find(item => item.value === value);
      if (!source) return;
      if (source.type === 'book') {
        bookId = source.id;
        notes = await window.sonara.notes.getAll(source.id);
      } else {
        bookId = null;
        const books = await window.sonara.collections.getBooks(source.id);
        const loaded = await Promise.all(books.map(book => window.sonara.notes.getAll(book.id)));
        notes = loaded.flat();
      }
    }
    current = null;
    render();
  }

  function due(note) {
    return !state[note.id] || state[note.id].due <= Date.now();
  }

  function render() {
    const count = notes.filter(due).length;
    const badge = document.getElementById('reviewTabCount');
    const countEl = document.getElementById('reviewCount');
    const card = document.getElementById('reviewCard');
    const actions = document.getElementById('reviewActions');
    if (badge) badge.textContent = count || '';
    if (countEl) countEl.textContent = count + ' due today';
    if (!card) return;

    if (!bookId || !notes.length) {
      card.innerHTML = '<div class="notes-empty">Add notes to start reviewing</div>';
      actions?.classList.add('hidden');
      return;
    }
    if (!current || !due(current)) current = notes.find(due) || null;
    if (!current) {
      card.innerHTML = '<div class="notes-empty">All caught up. Come back later.</div>';
      actions?.classList.add('hidden');
      return;
    }
    card.innerHTML = `
      <div class="review-card-label">What do you remember?</div>
      <div class="review-location">${_esc(current.chunk_title || ('Section ' + (current.chunk_index + 1)))}</div>
      <button class="review-reveal" onclick="Review.reveal()">Reveal note</button>
      <div class="review-answer hidden" id="reviewAnswer">${_esc(current.content)}</div>`;
    actions?.classList.add('hidden');
  }

  function reveal() {
    document.getElementById('reviewAnswer')?.classList.remove('hidden');
    document.getElementById('reviewActions')?.classList.remove('hidden');
    document.querySelector('.review-reveal')?.classList.add('hidden');
  }

  async function rate(result) {
    if (!current || !intervals[result]) return;
    state[current.id] = { due: Date.now() + intervals[result], result };
    await window.sonara.settings.set('review_state', state);
    current = null;
    render();
  }

  function _esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
  }

  return { load, reveal, rate, selectSource };
})();
