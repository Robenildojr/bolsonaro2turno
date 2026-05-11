// =============================================
//  MINHA BIBLIOTECA — app.js
// =============================================

// ===== STATE =====
const state = {
  books: [],
  currentBookId: null,
  currentTopicId: null,
  currentView: 'books',
  searchQuery: '',
  statusFilter: 'all',
  editingBookId: null,
  editingTopicId: null,
  editingNoteId: null,
  pendingRating: 0,
  pendingCoverImage: undefined, // undefined = no change; null = removed; string = new image
  confirmCallback: null,
};

// ===== STORAGE =====
const STORAGE_KEY = 'minha-biblioteca-v1';

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.books = JSON.parse(raw);
  } catch {
    state.books = [];
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.books));
}

// ===== HELPERS =====
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function escapeHtml(str) {
  const el = document.createElement('div');
  el.textContent = str || '';
  return el.innerHTML;
}

function starsHtml(rating, max = 5) {
  return '★'.repeat(rating) + '☆'.repeat(max - rating);
}

function statusLabel(status) {
  return { 'para-ler': 'Para Ler', lendo: 'Lendo', lido: 'Lido' }[status] || status;
}

function notesLabel(n) {
  return n === 0 ? 'Nenhuma anotação' : n === 1 ? '1 anotação' : `${n} anotações`;
}

function topicsLabel(n) {
  return n === 1 ? '1 tópico' : `${n} tópicos`;
}

function getCurrentBook() {
  return state.books.find(b => b.id === state.currentBookId) || null;
}

function getCurrentTopic() {
  return getCurrentBook()?.topics.find(t => t.id === state.currentTopicId) || null;
}

// ===== TOAST =====
function showToast(message, type = 'default') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = '0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

// ===== NAVIGATION =====
function navigate(view, bookId, topicId) {
  state.currentView = view;
  if (bookId !== undefined) state.currentBookId = bookId;
  if (topicId !== undefined) state.currentTopicId = topicId;

  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  const viewEl = document.getElementById(`view-${view === 'book-detail' ? 'book-detail' : view === 'topic-detail' ? 'topic-detail' : 'books'}`);
  if (viewEl) viewEl.classList.remove('hidden');

  rerender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function rerender() {
  if (state.currentView === 'books') renderBooksView();
  else if (state.currentView === 'book-detail') renderBookDetailView();
  else if (state.currentView === 'topic-detail') renderTopicDetailView();
}

// ===== CRUD: BOOKS =====
function createBook(data) {
  const book = {
    id: genId(),
    title: data.title.trim(),
    author: (data.author || '').trim(),
    status: data.status || 'para-ler',
    rating: data.rating || 0,
    coverImage: data.coverImage || null,
    createdAt: Date.now(),
    topics: [],
  };
  state.books.unshift(book);
  saveData();
  return book;
}

function updateBook(id, data) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;
  book.title = data.title.trim();
  book.author = (data.author || '').trim();
  book.status = data.status;
  book.rating = data.rating;
  if (data.coverImage !== undefined) book.coverImage = data.coverImage;
  saveData();
}

function deleteBook(id) {
  state.books = state.books.filter(b => b.id !== id);
  saveData();
}

// ===== CRUD: TOPICS =====
function createTopic(bookId, title) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return null;
  const topic = { id: genId(), title: title.trim(), createdAt: Date.now(), notes: [] };
  book.topics.push(topic);
  saveData();
  return topic;
}

function updateTopic(bookId, topicId, title) {
  const book = state.books.find(b => b.id === bookId);
  const topic = book?.topics.find(t => t.id === topicId);
  if (!topic) return;
  topic.title = title.trim();
  saveData();
}

function deleteTopic(bookId, topicId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  book.topics = book.topics.filter(t => t.id !== topicId);
  saveData();
}

// ===== CRUD: NOTES =====
function createNote(bookId, topicId, content) {
  const book = state.books.find(b => b.id === bookId);
  const topic = book?.topics.find(t => t.id === topicId);
  if (!topic) return null;
  const note = { id: genId(), content: content.trim(), createdAt: Date.now(), updatedAt: Date.now() };
  topic.notes.push(note);
  saveData();
  return note;
}

function updateNote(bookId, topicId, noteId, content) {
  const book = state.books.find(b => b.id === bookId);
  const topic = book?.topics.find(t => t.id === topicId);
  const note = topic?.notes.find(n => n.id === noteId);
  if (!note) return;
  note.content = content.trim();
  note.updatedAt = Date.now();
  saveData();
}

function deleteNote(bookId, topicId, noteId) {
  const book = state.books.find(b => b.id === bookId);
  const topic = book?.topics.find(t => t.id === topicId);
  if (!topic) return;
  topic.notes = topic.notes.filter(n => n.id !== noteId);
  saveData();
}

// ===== RENDER: BOOKS VIEW =====
function renderBooksView() {
  const books = state.books.filter(book => {
    const q = state.searchQuery.toLowerCase();
    const matchSearch = !q || book.title.toLowerCase().includes(q) || book.author.toLowerCase().includes(q);
    const matchStatus = state.statusFilter === 'all' || book.status === state.statusFilter;
    return matchSearch && matchStatus;
  });

  renderStats();

  const grid = document.getElementById('books-grid');
  const empty = document.getElementById('books-empty');

  if (books.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = books.map(book => `
    <div class="book-card" data-id="${book.id}">
      ${book.coverImage
        ? `<img class="book-cover" src="${book.coverImage}" alt="${escapeHtml(book.title)}" loading="lazy">`
        : `<div class="book-cover-placeholder">📖</div>`
      }
      <div class="book-card-body">
        <div class="book-card-title">${escapeHtml(book.title)}</div>
        ${book.author ? `<div class="book-card-author">${escapeHtml(book.author)}</div>` : ''}
        <div class="book-card-footer">
          <span class="status-badge status-${book.status}">${statusLabel(book.status)}</span>
          <span class="book-topics-count">${topicsLabel(book.topics.length)}</span>
        </div>
        ${book.rating > 0 ? `<div class="book-card-stars">${'★'.repeat(book.rating)}</div>` : ''}
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.book-card').forEach(card => {
    card.addEventListener('click', () => navigate('book-detail', card.dataset.id));
  });
}

function renderStats() {
  const total = state.books.length;
  if (total === 0) { document.getElementById('books-stats').innerHTML = ''; return; }

  const lendo = state.books.filter(b => b.status === 'lendo').length;
  const lidos = state.books.filter(b => b.status === 'lido').length;
  const paraLer = state.books.filter(b => b.status === 'para-ler').length;

  document.getElementById('books-stats').innerHTML = `
    <div class="stat-chip">📚 <span class="stat-count">${total}</span> livro${total !== 1 ? 's' : ''}</div>
    ${lendo > 0 ? `<div class="stat-chip">📖 <span class="stat-count">${lendo}</span> lendo</div>` : ''}
    ${lidos > 0 ? `<div class="stat-chip">✅ <span class="stat-count">${lidos}</span> lido${lidos !== 1 ? 's' : ''}</div>` : ''}
    ${paraLer > 0 ? `<div class="stat-chip">🔖 <span class="stat-count">${paraLer}</span> para ler</div>` : ''}
  `;
}

// ===== RENDER: BOOK DETAIL =====
function renderBookDetailView() {
  const book = getCurrentBook();
  if (!book) { navigate('books'); return; }

  document.getElementById('book-detail-header').innerHTML = `
    <div class="book-detail-cover">
      ${book.coverImage
        ? `<img src="${book.coverImage}" alt="${escapeHtml(book.title)}">`
        : `<div class="cover-placeholder">📖</div>`
      }
    </div>
    <div class="book-detail-info">
      <h1 class="book-detail-title">${escapeHtml(book.title)}</h1>
      ${book.author ? `<p class="book-detail-author">por ${escapeHtml(book.author)}</p>` : ''}
      <div class="book-detail-meta">
        <span class="status-badge status-${book.status}">${statusLabel(book.status)}</span>
        ${book.rating > 0 ? `<span class="star-display" title="${book.rating} de 5 estrelas">${starsHtml(book.rating)}</span>` : ''}
      </div>
      <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.5rem;">
        Adicionado em ${formatDate(book.createdAt)}
      </p>
    </div>
  `;

  renderTopicsList(book);
}

function renderTopicsList(book) {
  const list = document.getElementById('topics-list');
  const empty = document.getElementById('topics-empty');

  if (!book || book.topics.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = book.topics.map(topic => `
    <div class="topic-item" data-id="${topic.id}">
      <div class="topic-item-left">
        <div class="topic-icon">📌</div>
        <div class="topic-info">
          <div class="topic-title">${escapeHtml(topic.title)}</div>
          <div class="topic-notes-count">${notesLabel(topic.notes.length)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:0.25rem;">
        <div class="topic-actions">
          <button class="btn-icon btn-edit-topic" data-id="${topic.id}" title="Editar tópico">✏️</button>
          <button class="btn-icon btn-del-topic" data-id="${topic.id}" title="Excluir tópico">🗑️</button>
        </div>
        <span class="topic-arrow">›</span>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.topic-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.topic-actions')) return;
      navigate('topic-detail', state.currentBookId, item.dataset.id);
    });
  });

  list.querySelectorAll('.btn-edit-topic').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openTopicModal(btn.dataset.id);
    });
  });

  list.querySelectorAll('.btn-del-topic').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      confirmDelete(`Excluir o tópico "${escapeHtml(getCurrentBook()?.topics.find(t=>t.id===btn.dataset.id)?.title || '')}" e todas as suas anotações?`, () => {
        deleteTopic(state.currentBookId, btn.dataset.id);
        renderTopicsList(getCurrentBook());
        showToast('Tópico excluído', 'success');
      });
    });
  });
}

// ===== RENDER: TOPIC DETAIL =====
function renderTopicDetailView() {
  const book = getCurrentBook();
  const topic = getCurrentTopic();
  if (!book || !topic) { navigate('book-detail', state.currentBookId); return; }

  document.getElementById('topic-detail-header').innerHTML = `
    <div class="topic-detail-breadcrumb">
      <span onclick="navigate('book-detail','${book.id}')">📚 ${escapeHtml(book.title)}</span>
      <span>›</span>
      <span style="color:var(--text-secondary);">Tópico</span>
    </div>
    <h1 class="topic-detail-title">${escapeHtml(topic.title)}</h1>
  `;

  renderNotesList(book, topic);
}

function renderNotesList(book, topic) {
  const list = document.getElementById('notes-list');
  const empty = document.getElementById('notes-empty');

  if (!topic || topic.notes.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Newest notes first
  const sorted = [...topic.notes].reverse();

  list.innerHTML = sorted.map(note => `
    <div class="note-item" data-id="${note.id}">
      <div class="note-header">
        <span class="note-date">
          ${note.updatedAt && note.updatedAt !== note.createdAt
            ? `Editado em ${formatDate(note.updatedAt)}`
            : `${formatDate(note.createdAt)}`
          }
        </span>
        <div class="note-actions">
          <button class="btn-icon btn-edit-note" data-id="${note.id}" title="Editar anotação">✏️</button>
          <button class="btn-icon btn-del-note" data-id="${note.id}" title="Excluir anotação">🗑️</button>
        </div>
      </div>
      <div class="note-content">${escapeHtml(note.content)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-edit-note').forEach(btn => {
    btn.addEventListener('click', () => openNoteModal(btn.dataset.id));
  });

  list.querySelectorAll('.btn-del-note').forEach(btn => {
    btn.addEventListener('click', () => {
      confirmDelete('Excluir esta anotação?', () => {
        deleteNote(state.currentBookId, state.currentTopicId, btn.dataset.id);
        renderNotesList(getCurrentBook(), getCurrentTopic());
        showToast('Anotação excluída', 'success');
      });
    });
  });
}

// ===== MODALS =====
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openBookModal(bookId = null) {
  state.editingBookId = bookId;
  state.pendingRating = 0;
  state.pendingCoverImage = undefined;

  const preview = document.getElementById('cover-preview');
  const placeholder = document.getElementById('cover-placeholder');
  const removeBtn = document.getElementById('cover-remove');
  document.getElementById('modal-book-title').textContent = bookId ? 'Editar Livro' : 'Adicionar Livro';

  if (bookId) {
    const book = state.books.find(b => b.id === bookId);
    document.getElementById('book-title-input').value = book.title;
    document.getElementById('book-author-input').value = book.author;
    const radio = document.querySelector(`input[name="book-status"][value="${book.status}"]`);
    if (radio) radio.checked = true;
    state.pendingRating = book.rating;

    if (book.coverImage) {
      preview.src = book.coverImage;
      preview.classList.remove('hidden');
      placeholder.style.display = 'none';
      removeBtn.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
      placeholder.style.display = '';
      removeBtn.classList.add('hidden');
    }
  } else {
    document.getElementById('book-title-input').value = '';
    document.getElementById('book-author-input').value = '';
    document.querySelector('input[name="book-status"][value="para-ler"]').checked = true;
    preview.classList.add('hidden');
    preview.src = '';
    placeholder.style.display = '';
    removeBtn.classList.add('hidden');
  }

  updateStars(state.pendingRating);
  openModal('modal-book');
  setTimeout(() => document.getElementById('book-title-input').focus(), 120);
}

function openTopicModal(topicId = null) {
  state.editingTopicId = topicId;
  document.getElementById('modal-topic-title').textContent = topicId ? 'Editar Tópico' : 'Adicionar Tópico';
  const titleInput = document.getElementById('topic-title-input');

  if (topicId) {
    const topic = getCurrentBook()?.topics.find(t => t.id === topicId);
    titleInput.value = topic?.title || '';
  } else {
    titleInput.value = '';
  }

  openModal('modal-topic');
  setTimeout(() => titleInput.focus(), 120);
}

function openNoteModal(noteId = null) {
  state.editingNoteId = noteId;
  document.getElementById('modal-note-title').textContent = noteId ? 'Editar Anotação' : 'Nova Anotação';
  const contentInput = document.getElementById('note-content-input');

  if (noteId) {
    const note = getCurrentTopic()?.notes.find(n => n.id === noteId);
    contentInput.value = note?.content || '';
  } else {
    contentInput.value = '';
  }

  openModal('modal-note');
  setTimeout(() => contentInput.focus(), 120);
}

function confirmDelete(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  state.confirmCallback = callback;
  openModal('modal-confirm');
}

function updateStars(rating) {
  document.querySelectorAll('#star-rating .star').forEach((star, i) => {
    star.classList.toggle('active', i < rating);
  });
}

// ===== SAVE HANDLERS =====
function handleSaveBook() {
  const title = document.getElementById('book-title-input').value.trim();
  if (!title) {
    showToast('O título é obrigatório', 'error');
    document.getElementById('book-title-input').focus();
    return;
  }

  const author = document.getElementById('book-author-input').value;
  const status = document.querySelector('input[name="book-status"]:checked')?.value || 'para-ler';

  if (state.editingBookId) {
    const existing = state.books.find(b => b.id === state.editingBookId);
    const coverImage = state.pendingCoverImage !== undefined ? state.pendingCoverImage : existing?.coverImage;
    updateBook(state.editingBookId, { title, author, status, rating: state.pendingRating, coverImage });
    showToast('Livro atualizado!', 'success');
  } else {
    createBook({ title, author, status, rating: state.pendingRating, coverImage: state.pendingCoverImage ?? null });
    showToast('Livro adicionado com sucesso!', 'success');
  }

  closeModal('modal-book');
  rerender();
}

function handleSaveTopic() {
  const title = document.getElementById('topic-title-input').value.trim();
  if (!title) {
    showToast('O nome do tópico é obrigatório', 'error');
    document.getElementById('topic-title-input').focus();
    return;
  }

  if (state.editingTopicId) {
    updateTopic(state.currentBookId, state.editingTopicId, title);
    showToast('Tópico atualizado!', 'success');
  } else {
    createTopic(state.currentBookId, title);
    showToast('Tópico adicionado!', 'success');
  }

  closeModal('modal-topic');

  if (state.currentView === 'topic-detail') {
    renderTopicDetailView();
  } else {
    renderTopicsList(getCurrentBook());
  }
}

function handleSaveNote() {
  const content = document.getElementById('note-content-input').value.trim();
  if (!content) {
    showToast('A anotação não pode estar vazia', 'error');
    document.getElementById('note-content-input').focus();
    return;
  }

  if (state.editingNoteId) {
    updateNote(state.currentBookId, state.currentTopicId, state.editingNoteId, content);
    showToast('Anotação atualizada!', 'success');
  } else {
    createNote(state.currentBookId, state.currentTopicId, content);
    showToast('Anotação adicionada!', 'success');
  }

  closeModal('modal-note');
  renderNotesList(getCurrentBook(), getCurrentTopic());
}

// ===== EVENT LISTENERS =====
function initEvents() {
  // Book actions
  document.getElementById('btn-add-book').addEventListener('click', () => openBookModal());
  document.getElementById('btn-save-book').addEventListener('click', handleSaveBook);
  document.getElementById('btn-edit-book').addEventListener('click', () => openBookModal(state.currentBookId));
  document.getElementById('btn-delete-book').addEventListener('click', () => {
    const book = getCurrentBook();
    confirmDelete(`Excluir o livro "${book?.title || ''}" e todos os seus dados?`, () => {
      deleteBook(state.currentBookId);
      navigate('books');
      showToast('Livro excluído', 'success');
    });
  });

  // Topic actions from book-detail header
  document.getElementById('btn-add-topic').addEventListener('click', () => openTopicModal());
  document.getElementById('btn-save-topic').addEventListener('click', handleSaveTopic);

  // Topic actions from topic-detail header
  document.getElementById('btn-edit-topic-header').addEventListener('click', () => openTopicModal(state.currentTopicId));
  document.getElementById('btn-delete-topic-header').addEventListener('click', () => {
    const topic = getCurrentTopic();
    confirmDelete(`Excluir o tópico "${topic?.title || ''}" e todas as suas anotações?`, () => {
      deleteTopic(state.currentBookId, state.currentTopicId);
      navigate('book-detail', state.currentBookId);
      showToast('Tópico excluído', 'success');
    });
  });

  // Note actions
  document.getElementById('btn-add-note').addEventListener('click', () => openNoteModal());
  document.getElementById('btn-save-note').addEventListener('click', handleSaveNote);

  // Navigation
  document.getElementById('btn-back-to-books').addEventListener('click', () => navigate('books'));
  document.getElementById('btn-back-to-book').addEventListener('click', () => navigate('book-detail', state.currentBookId));

  // Close modals via data-close
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // Confirm delete
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    state.confirmCallback?.();
    state.confirmCallback = null;
    closeModal('modal-confirm');
  });

  // Search
  document.getElementById('search-books').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderBooksView();
  });

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.statusFilter = tab.dataset.filter;
      renderBooksView();
    });
  });

  // Star rating
  const stars = document.querySelectorAll('#star-rating .star');
  stars.forEach(star => {
    star.addEventListener('click', () => {
      const val = parseInt(star.dataset.value);
      // Click same star again to remove rating
      state.pendingRating = state.pendingRating === val ? 0 : val;
      updateStars(state.pendingRating);
    });
    star.addEventListener('mouseenter', () => updateStars(parseInt(star.dataset.value)));
    star.addEventListener('mouseleave', () => updateStars(state.pendingRating));
  });

  // Cover upload click
  document.getElementById('cover-upload-area').addEventListener('click', e => {
    if (e.target === document.getElementById('cover-remove')) return;
    document.getElementById('cover-input').click();
  });

  // Cover file input
  document.getElementById('cover-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('Imagem muito grande. Use uma imagem de até 5MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      state.pendingCoverImage = ev.target.result;
      const preview = document.getElementById('cover-preview');
      preview.src = ev.target.result;
      preview.classList.remove('hidden');
      document.getElementById('cover-placeholder').style.display = 'none';
      document.getElementById('cover-remove').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // Remove cover
  document.getElementById('cover-remove').addEventListener('click', e => {
    e.stopPropagation();
    state.pendingCoverImage = null;
    const preview = document.getElementById('cover-preview');
    preview.classList.add('hidden');
    preview.src = '';
    document.getElementById('cover-placeholder').style.display = '';
    document.getElementById('cover-remove').classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    // Escape closes any open modal
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }

    // Ctrl/Cmd + Enter saves the focused modal
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const active = document.querySelector('.modal-overlay:not(.hidden)');
      if (!active) return;
      if (active.id === 'modal-book') handleSaveBook();
      else if (active.id === 'modal-topic') handleSaveTopic();
      else if (active.id === 'modal-note') handleSaveNote();
    }

    // Enter in single-line inputs saves the modal
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const active = document.querySelector('.modal-overlay:not(.hidden)');
      if (!active) return;
      if (active.id === 'modal-topic' && document.activeElement.id === 'topic-title-input') handleSaveTopic();
    }
  });
}

// ===== INIT =====
function init() {
  loadData();
  initEvents();
  navigate('books');
}

document.addEventListener('DOMContentLoaded', init);
