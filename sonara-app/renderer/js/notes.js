/* ══════════════════════════════════════════════════════════
   NOTES.JS — Per-book note-taking while reading / listening

   Features:
   • Save notes tagged by type: Note, Key Point, Quote, Question
   • Each note is anchored to the current chapter/section
   • Click any note → jump back to that exact position
   • Inline edit & delete with confirmation
   • Auto-updates badge count on the Notes tab
══════════════════════════════════════════════════════════ */
'use strict';

const Notes = (() => {

  let _bookId = null;
  let _notes  = [];

  const TAG_DEFS = [
    { value: 'note',     emoji: '📝', label: 'Note'      },
    { value: 'key',      emoji: '💡', label: 'Key Point' },
    { value: 'quote',    emoji: '📌', label: 'Quote'     },
    { value: 'question', emoji: '❓', label: 'Question'  },
  ];

  function _tagDef(v) { return TAG_DEFS.find(t => t.value === v) || TAG_DEFS[0]; }

  // ── LOAD ──────────────────────────────────────────────────
  async function load(bookId) {
    _bookId = bookId || null;
    _notes  = [];
    if (_bookId) {
      try { _notes = await window.sonara.notes.getAll(_bookId); } catch (_) {}
    }
    _render();
    _updateBadge();
  }

  function clear() { load(null); }

  // ── SAVE NEW NOTE ─────────────────────────────────────────
  async function save() {
    const textarea = document.getElementById('noteTextarea');
    const tagSel   = document.getElementById('noteTagSel');
    const content  = textarea ? textarea.value.trim() : '';

    if (!content) {
      UI.toast('Write something before saving', 'error', 1800);
      return;
    }
    if (!_bookId) {
      UI.toast('Open a book first', 'error', 1800);
      return;
    }

    const tag = tagSel ? tagSel.value : 'note';

    // Capture current playback position
    let chunkIndex = 0;
    let chunkTitle = '';
    try {
      const state  = Reader.getState();
      const chunks = Reader.getChunks();
      chunkIndex = (state && state.chunkIndex != null) ? state.chunkIndex : 0;
      chunkTitle = (chunks && chunks[chunkIndex]) ? (chunks[chunkIndex].title || ('Section ' + (chunkIndex + 1))) : '';
    } catch (_) {}

    try {
      const note = await window.sonara.notes.add({
        book_id:     _bookId,
        chunk_index: chunkIndex,
        chunk_title: chunkTitle,
        tag,
        content,
      });
      _notes.unshift(note);
      textarea.value = '';
      textarea.style.height = '';
      _render();
      _updateBadge();
      _updatePositionLabel();
      UI.toast('Note saved', 'success', 1800);
    } catch (err) {
      UI.toast('Could not save note: ' + err.message, 'error');
    }
  }

  // ── DELETE ────────────────────────────────────────────────
  async function remove(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await window.sonara.notes.delete(id);
      _notes = _notes.filter(n => n.id !== id);
      _render();
      _updateBadge();
    } catch (err) {
      UI.toast('Could not delete note', 'error');
    }
  }

  // ── EDIT ──────────────────────────────────────────────────
  function startEdit(id) {
    const note = _notes.find(n => n.id === id);
    if (!note) return;
    const card = document.getElementById('note-card-' + id);
    if (!card) return;

    card.innerHTML = `
      <div class="note-edit-row">
        <select class="note-tag-mini" id="edit-tag-${id}">
          ${TAG_DEFS.map(t => `<option value="${t.value}"${t.value === note.tag ? ' selected' : ''}>${t.emoji} ${t.label}</option>`).join('')}
        </select>
        <div class="note-edit-actions">
          <button class="note-btn note-btn-cancel" onclick="Notes._cancelEdit(${id})">Cancel</button>
          <button class="note-btn note-btn-save"   onclick="Notes._commitEdit(${id})">Save</button>
        </div>
      </div>
      <textarea class="note-edit-ta" id="edit-ta-${id}" rows="3">${_esc(note.content)}</textarea>`;

    const ta = document.getElementById('edit-ta-' + id);
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }
  }

  async function _commitEdit(id) {
    const ta      = document.getElementById('edit-ta-' + id);
    const sel     = document.getElementById('edit-tag-' + id);
    const content = ta ? ta.value.trim() : '';
    if (!content) return;
    const tag = sel ? sel.value : 'note';

    try {
      await window.sonara.notes.update(id, content, tag);
      const note = _notes.find(n => n.id === id);
      if (note) { note.content = content; note.tag = tag; }
      _render();
    } catch (err) {
      UI.toast('Could not update note', 'error');
    }
  }

  function _cancelEdit(_id) { _render(); }

  // ── RENDER ────────────────────────────────────────────────
  function _render() {
    const list = document.getElementById('notesList');
    if (!list) return;

    if (!_notes.length) {
      list.innerHTML = `<div class="notes-empty">${
        _bookId
          ? 'No notes yet — add your first note above'
          : 'Open a book to start taking notes'
      }</div>`;
      return;
    }

    list.innerHTML = _notes.map(n => {
      const def      = _tagDef(n.tag);
      const date     = new Date(n.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const pos      = (n.chunk_title || '').trim() || ('Section ' + (n.chunk_index + 1));
      const posShort = pos.length > 22 ? pos.slice(0, 20) + '…' : pos;

      return `
        <div class="note-card" id="note-card-${n.id}">
          <div class="note-card-head">
            <span class="note-tag-badge note-tag-${n.tag}" title="${def.label}">${def.emoji}</span>
            <button class="note-pos-link" onclick="Reader.jumpToChunk(${n.chunk_index})" title="Jump to: ${_esc(pos)}">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              ${_esc(posShort)}
            </button>
            <span class="note-date">${date}</span>
            <div class="note-actions">
              <button class="note-icon-btn" onclick="Notes.startEdit(${n.id})" title="Edit note">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button class="note-icon-btn note-icon-del" onclick="Notes.remove(${n.id})" title="Delete note">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="note-content">${_esc(n.content)}</div>
        </div>`;
    }).join('');
  }

  // ── HELPERS ───────────────────────────────────────────────
  function _updateBadge() {
    const badge  = document.getElementById('notesTabCount');
    const expRow = document.getElementById('notesExportRow');
    if (badge)  badge.textContent  = _notes.length > 0 ? _notes.length : '';
    if (expRow) expRow.style.display = _notes.length > 0 ? '' : 'none';
  }

  function _updatePositionLabel() {
    const el = document.getElementById('notesPosition');
    if (!el) return;
    try {
      const state  = Reader.getState();
      const chunks = Reader.getChunks();
      const idx    = (state && state.chunkIndex != null) ? state.chunkIndex : 0;
      const title  = (chunks && chunks[idx]) ? (chunks[idx].title || ('Section ' + (idx + 1))) : '—';
      el.textContent = title.length > 22 ? title.slice(0, 20) + '…' : title;
    } catch (_) {
      el.textContent = '—';
    }
  }

  // ── EXPORT ─────────────────────────────────────────────────
  async function exportNotes(type) {
    if (!_notes.length) {
      UI.toast('No notes to export', 'error', 2000);
      return;
    }

    // Grab book title from player bar if available
    const titleEl  = document.getElementById('pbMetaTitle');
    const bookTitle = (titleEl && titleEl.textContent.trim()) || 'My Reading Notes';
    const defaultName = bookTitle + ' — Notes';
    const exportDate  = new Date().toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    try {
      const filePath = await window.sonara.notes.saveDialog({ defaultName, type });
      if (!filePath) return; // cancelled

      if (type === 'txt') {
        await window.sonara.notes.writeText({ path: filePath, content: _buildTextExport(bookTitle, exportDate) });
      } else {
        await window.sonara.notes.writePdf({ path: filePath, html: _buildHtmlExport(bookTitle, exportDate) });
      }
      UI.toast('Notes exported as ' + type.toUpperCase(), 'success', 2500);
    } catch (err) {
      UI.toast('Export failed: ' + err.message, 'error');
    }
  }

  function _buildTextExport(bookTitle, exportDate) {
    const sep = '─'.repeat(40);
    const lines = [
      sep,
      '  SONARA — READING NOTES',
      sep,
      '  Book:     ' + bookTitle,
      '  Exported: ' + exportDate,
      '  Notes:    ' + _notes.length,
      sep, '',
    ];
    _notes.forEach((n, i) => {
      const def     = _tagDef(n.tag);
      const date    = new Date(n.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const pos     = (n.chunk_title || '').trim() || ('Section ' + (n.chunk_index + 1));
      const content = n.content.replace(/\n/g, '\n    ');
      lines.push(
        '',
        '[' + (i + 1) + '] ' + def.emoji + ' ' + def.label + '  |  ' + pos,
        '    Date: ' + date,
        '',
        '    ' + content,
        '',
        sep,
      );
    });
    return lines.join('\n') + '\n';
  }

  function _buildHtmlExport(bookTitle, exportDate) {
    const TAG_COLORS = { note: '#c8a96e', key: '#7ec8a4', quote: '#a96ec8', question: '#c8786e' };
    const notesHtml = _notes.map((n, i) => {
      const def    = _tagDef(n.tag);
      const date   = new Date(n.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const pos    = (n.chunk_title || '').trim() || ('Section ' + (n.chunk_index + 1));
      const color  = TAG_COLORS[n.tag] || '#c8a96e';
      const body   = _esc(n.content);
      return (
        '<div class="note-card">' +
          '<div class="note-head">' +
            '<span class="note-idx">' + (i + 1) + '</span>' +
            '<span class="note-tag" style="color:' + color + '">' + def.emoji + ' ' + def.label + '</span>' +
            '<span class="note-pos">' + _esc(pos) + '</span>' +
            '<span class="note-date">' + date + '</span>' +
          '</div>' +
          '<div class="note-body">' + body + '</div>' +
        '</div>'
      );
    }).join('');

    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + bookTitle + ' — Notes</title><style>' +
      '* { box-sizing: border-box; margin: 0; padding: 0; }' +
      'body { font-family: Georgia, serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 40px 48px; line-height: 1.6; }' +
      '.page-header { border-bottom: 2px solid #c8a96e; padding-bottom: 16px; margin-bottom: 28px; }' +
      '.page-header h1 { font-size: 22px; }' +
      '.page-header p  { font-size: 12px; color: #666; margin-top: 4px; }' +
      '.note-card { border: 1px solid #ddd; border-left: 3px solid #c8a96e; border-radius: 4px; padding: 12px 16px; margin-bottom: 14px; page-break-inside: avoid; }' +
      '.note-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }' +
      '.note-idx  { font-size: 11px; color: #999; min-width: 20px; }' +
      '.note-tag  { font-size: 12px; font-weight: 600; }' +
      '.note-pos  { font-size: 11px; color: #555; flex: 1; font-style: italic; }' +
      '.note-date { font-size: 11px; color: #999; }' +
      '.note-body { font-size: 13px; color: #333; white-space: pre-wrap; }' +
      '.footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #eee; font-size: 11px; color: #aaa; text-align: center; }' +
      '@media print { body { padding: 20px 28px; } }' +
    '</style></head><body>' +
    '<div class="page-header"><h1>' + bookTitle + '</h1>' +
    '<p>Reading Notes &bull; Exported ' + exportDate + ' &bull; ' + _notes.length + ' note' + (_notes.length !== 1 ? 's' : '') + '</p></div>' +
    notesHtml +
    '<div class="footer">Generated by Sonara</div></body></html>';
  }

  // ── TAB SWITCH ────────────────────────────────────────────
  function switchTab(tab) {
    const ctrlPane = document.getElementById('paneControls');
    const ntWrap   = document.getElementById('rpNotesWrap');
    const ctrlTab  = document.getElementById('rpTabControls');
    const ntTab    = document.getElementById('rpTabNotes');

    // Hide all panes, deactivate all tabs
    if (ctrlPane) ctrlPane.style.display = 'none';
    if (ntWrap)   ntWrap.style.display   = 'none';
    [ctrlTab, ntTab].forEach(t => t && t.classList.remove('rp-tab-active'));

    if (tab === 'notes') {
      if (ntWrap)  ntWrap.style.display = '';
      if (ntTab)   ntTab.classList.add('rp-tab-active');
      _updatePositionLabel();
    } else {
      if (ctrlPane) ctrlPane.style.display = '';
      if (ctrlTab)  ctrlTab.classList.add('rp-tab-active');
    }
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/\n/g, '<br>');
  }

  return { load, clear, save, remove, startEdit, _commitEdit, _cancelEdit, switchTab, exportNotes };
})();
