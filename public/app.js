// Markanban UI. Talks only to the HTTP API; every change re-fetches the board.
const $ = (sel) => document.querySelector(sel);
const boardEl = $('#board');
const dialog = $('#card-dialog');
const form = $('#card-form');

let board = null;
let current = null; // card open in the dialog

// --- helpers ---------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function act(fn) {
  try {
    await fn();
    showError('');
    return true;
  } catch (e) {
    showError(e.message);
    return false;
  } finally {
    await load();
  }
}

const day = (iso) => (iso ? new Date(iso).toLocaleString() : '');

// --- theme -----------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
const ICONS = { system: '◐ System', light: '☀ Light', dark: '☾ Dark' };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function setTheme(mode) {
  const effective = mode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = effective;
  $('#theme').textContent = ICONS[mode];
  $('#theme').dataset.mode = mode;
}

$('#theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf($('#theme').dataset.mode) + 1) % THEMES.length];
  store.set('markanban-theme', next);
  setTheme(next);
});
darkQuery.addEventListener('change', () => setTheme($('#theme').dataset.mode));
setTheme(THEMES.includes(store.get('markanban-theme')) ? store.get('markanban-theme') : 'system');

// --- board -----------------------------------------------------------------

const showArchived = $('#show-archived');
showArchived.checked = store.get('markanban-show-archived') === '1';
showArchived.addEventListener('change', () => {
  store.set('markanban-show-archived', showArchived.checked ? '1' : '0');
  render();
});

// --- filters (client-side only; files are never touched) ------------------

const NONE = '\u0000none'; // option value for "field is empty"
const filterEls = { q: $('#filter-q'), type: $('#filter-type'), assignee: $('#filter-assignee'), tag: $('#filter-tag') };

function matches(card) {
  const q = filterEls.q.value.trim().toLowerCase();
  const text = [card.heading, card.body, ...card.comments.map((c) => c.text)].join('\n');
  if (q && !text.toLowerCase().includes(q)) return false;
  for (const key of ['type', 'assignee']) {
    const v = filterEls[key].value;
    if (v && (v === NONE ? card[key] : card[key] !== v)) return false;
  }
  const tag = filterEls.tag.value;
  if (tag && (tag === NONE ? card.tags.length : !card.tags.includes(tag))) return false;
  return true;
}

// Rebuild options from the current cards, keeping the selection.
function fillSelect(el, label, values, hasEmpty) {
  const selected = el.value;
  const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  el.replaceChildren(
    h('option', { value: '' }, `All ${label}`),
    ...sorted.map((v) => h('option', { value: v }, v)),
    hasEmpty && h('option', { value: NONE }, `No ${label.replace(/s$/, '')}`),
  );
  el.value = [...el.options].some((o) => o.value === selected) ? selected : '';
}

function refreshFilters() {
  const cards = board.cards;
  fillSelect(filterEls.type, 'types', cards.flatMap((c) => c.type ?? []), cards.some((c) => !c.type));
  fillSelect(filterEls.assignee, 'assignees', cards.flatMap((c) => c.assignee ?? []), cards.some((c) => !c.assignee));
  fillSelect(filterEls.tag, 'tags', cards.flatMap((c) => c.tags), cards.some((c) => !c.tags.length));
  let any = false;
  for (const el of Object.values(filterEls)) {
    el.classList.toggle('active', !!el.value);
    any ||= !!el.value;
  }
  $('#filter-clear').hidden = !any;
}

for (const el of Object.values(filterEls)) el.addEventListener('input', () => render());
$('#filter-clear').addEventListener('click', () => {
  for (const el of Object.values(filterEls)) el.value = '';
  render();
});

async function load() {
  try {
    board = await api('GET', '/api/board');
    render();
  } catch (e) {
    showError(`Could not load board: ${e.message}`);
  }
}

function cardEl(card) {
  return h('article', {
    class: 'card',
    'data-name': card.name,
    'data-color': card.color, // decided by the server; CSS maps it to the theme's color
    tabindex: '0',
    draggable: card.archived ? 'false' : 'true',
    ondragstart: (e) => {
      e.dataTransfer.setData('text/x-card', card.name);
      draggingCard = card.name;
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => {
      draggingCard = null;
      clearMarkers();
      e.currentTarget.classList.remove('dragging');
    },
    onclick: () => openCard(card),
    onkeydown: (e) => cardKeys(e, card),
  },
  h('div', { class: 'heading' }, card.heading),
  card.conflict && h('div', { class: 'warn' }, '⚠️ Possible sync conflict copy'),
  card.error && h('div', { class: 'warn' }, '⚠️ Front-matter has invalid YAML'),
  card.rankError && h('div', { class: 'warn', title: card.rankError }, '⚠️ Invalid rank, fixed on next move'),
  (card.type || card.assignee || card.comments.length > 0) && h('div', { class: 'meta' },
    card.type && h('span', { class: 'type-chip' }, card.type),
    card.assignee && h('span', {}, `@${card.assignee}`),
    card.comments.length > 0 && h('span', { title: `${card.comments.length} comment(s)` }, `💬 ${card.comments.length}`)),
  (card.tags.length || Object.keys(card.extra).length) ? h('div', { class: 'chips' },
    card.tags.map((t) => h('span', { class: 'chip' }, t)),
    Object.entries(card.extra).map(([k, v]) => h('span', { class: 'chip extra' }, `${k}: ${v}`))) : null);
}

// Card order: the browser only says where a card goes ("above card X" or the bottom, before = null);
// the server works out ranks and returns the cards in order.
let draggingCard = null; // drag data can't be read during dragover, so remember the name

function moveCard(name, status, before) {
  const card = board.cards.find((c) => c.name === name);
  if (!card) return;
  const sameColumn = (card.status ?? null) === status;
  if (sameColumn) {
    // Dropped where it already is: nothing to do.
    const names = [...document.querySelectorAll('.card')].filter((el) => el.closest('.column') === cardColumn(name)).map((el) => el.dataset.name);
    if ((names[names.indexOf(name) + 1] ?? null) === before) return;
  }
  const body = { place: { before } };
  if (!sameColumn) body.fields = { status: status ?? '' };
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, body));
}

const cardColumn = (name) => document.querySelector(`.card[data-name="${CSS.escape(name)}"]`)?.closest('.column');

// The visible card the dragged card would land above, or null for the bottom of the column.
function insertionPoint(columnEl, y) {
  for (const el of columnEl.querySelectorAll('.card')) {
    if (el.dataset.name === draggingCard) continue;
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) return el.dataset.name;
  }
  return null;
}

function clearMarkers() {
  document.querySelectorAll('.insert-before, .insert-end').forEach((el) => el.classList.remove('insert-before', 'insert-end'));
}

// positioned: dropping shows (and uses) the exact spot between cards; otherwise the card goes to the bottom.
function dropZone(el, onCard, positioned = false) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-card')) return;
    e.preventDefault();
    el.classList.add('over');
    if (!positioned) return;
    clearMarkers();
    const before = insertionPoint(el, e.clientY);
    if (before) el.querySelector(`.card[data-name="${CSS.escape(before)}"]`).classList.add('insert-before');
    else el.classList.add('insert-end');
  });
  el.addEventListener('dragleave', (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('over');
    clearMarkers();
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('over');
    const name = e.dataTransfer.getData('text/x-card');
    const before = positioned ? insertionPoint(el, e.clientY) : null;
    clearMarkers();
    if (name) { e.preventDefault(); onCard(name, before); }
  });
}

// Keyboard: Enter opens; Alt+↑/↓ moves within the column; Alt+←/→ moves to the bottom of the next column.
function cardKeys(e, card) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card); return; }
  if (!e.altKey || card.archived) return;
  const names = [...e.currentTarget.closest('.column').querySelectorAll('.card')].map((el) => el.dataset.name);
  const i = names.indexOf(card.name);
  let status = card.status ?? null;
  let before;
  if (e.key === 'ArrowUp') {
    if (i <= 0) return;
    before = names[i - 1];
  } else if (e.key === 'ArrowDown') {
    if (i === names.length - 1) return;
    before = names[i + 2] ?? null;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const keys = board.columns.map((c) => c.key);
    const j = keys.indexOf(status) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (j < 0 || j >= keys.length) return;
    status = keys[j];
    before = null;
  } else return;
  e.preventDefault();
  moveCard(card.name, status, before);
}

function saveColumnOrder(order) {
  act(() => api('PUT', '/api/config/columns', { columns: order }));
}

// "No status" is always first and can't move; every other column can.
const statusKeys = () => board.columns.filter((c) => c.key !== null).map((c) => c.key);

function reorderColumn(from, target, after) {
  if (from === target) return;
  const order = statusKeys().filter((s) => s !== from);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, from);
  saveColumnOrder(order);
}

// Drop a dragged column on any part of another column; left/right half decides the side.
function columnDropZone(el, key) {
  const clear = () => el.classList.remove('drop-before', 'drop-after');
  const isAfter = (e) => {
    const r = el.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-column')) return;
    e.preventDefault();
    const after = isAfter(e);
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clear(); });
  el.addEventListener('drop', (e) => {
    clear();
    const from = e.dataTransfer.getData('text/x-column');
    if (!from) return;
    e.preventDefault();
    reorderColumn(from, key, isAfter(e));
  });
}

function columnEl(col, cards) {
  const movable = col.key !== null;
  const keys = statusKeys();
  const i = keys.indexOf(col.key);
  const head = h('div', {
    class: `column-head${movable ? '' : ' no-status'}`,
    draggable: movable ? 'true' : 'false',
    title: movable ? 'Drag to reorder' : '',
    ondragstart: (e) => {
      e.dataTransfer.setData('text/x-column', col.key);
      e.dataTransfer.effectAllowed = 'move';
      e.currentTarget.closest('.column').classList.add('dragging');
    },
    ondragend: (e) => e.currentTarget.closest('.column')?.classList.remove('dragging'),
  },
  movable && h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
  h('span', { class: 'title' }, col.label),
  h('span', { class: 'count' }, String(cards.length)),
  movable && h('span', { class: 'move' },
    h('button', { class: 'icon', title: 'Move left', 'aria-label': `Move ${col.label} left`, disabled: i === 0,
      onclick: () => reorderColumn(col.key, keys[i - 1], false) }, '‹'),
    h('button', { class: 'icon', title: 'Move right', 'aria-label': `Move ${col.label} right`, disabled: i === keys.length - 1,
      onclick: () => reorderColumn(col.key, keys[i + 1], true) }, '›')),
  h('button', {
    class: 'icon', title: 'New card', 'aria-label': `New card in ${col.label}`,
    onclick: () => {
      const heading = prompt(`New card in "${col.label}"`);
      if (heading?.trim()) act(() => api('POST', '/api/cards', { heading, status: col.key }));
    },
  }, '+'));
  const el = h('section', { class: 'column' }, head, cards.map(cardEl));
  dropZone(el, (name, before) => moveCard(name, col.key, before), true);
  if (movable) columnDropZone(el, col.key);
  return el;
}

function render() {
  $('#title').textContent = board.folder ? `Markanban · ${board.folder}` : 'Markanban';
  document.title = $('#title').textContent;
  $('#warnings').replaceChildren(...(board.warnings ?? []).map((w) => h('div', {}, `⚠️ ${w}`)));
  $('#warnings').hidden = !board.warnings?.length;
  $('#status-list').replaceChildren(...board.columns.filter((c) => c.key).map((c) => h('option', { value: c.key })));

  refreshFilters();
  const visible = board.cards.filter(matches);
  const active = visible.filter((c) => !c.archived);
  const cols = board.columns.map((col) => columnEl(col, active.filter((c) => (c.status ?? null) === col.key)));

  const newCol = h('section', {
    class: 'column new-column', title: 'Add a column, or drop a card here to give it a new status',
    onclick: () => {
      const name = prompt('New column (status) name')?.trim();
      if (name) saveColumnOrder([...board.columns.filter((c) => c.key).map((c) => c.key), name]);
    },
  }, '+ Column');
  dropZone(newCol, (name) => {
    const status = prompt('Status for the new column')?.trim();
    if (status) moveCard(name, status, null);
  });

  const archived = showArchived.checked ? visible.filter((c) => c.archived) : [];
  const archivedCol = archived.length ? h('section', { class: 'column archived' },
    h('div', { class: 'column-head' }, h('span', { class: 'title' }, 'Archived'), h('span', { class: 'count' }, String(archived.length))),
    archived.map(cardEl)) : null;

  // Every redraw (own actions and live updates) keeps keyboard focus on the same card.
  const focused = document.activeElement?.closest?.('#board .card')?.dataset.name;
  boardEl.replaceChildren(...cols, newCol, ...(archivedCol ? [archivedCol] : []));
  if (focused) boardEl.querySelector(`.card[data-name="${CSS.escape(focused)}"]`)?.focus();
}

// --- card dialog -----------------------------------------------------------

function openCard(card) {
  current = card;
  form.heading.value = card.heading;
  form.status.value = card.status ?? '';
  form.type.value = card.type ?? '';
  form.assignee.value = card.assignee ?? '';
  form.tags.value = card.tags.join(', ');
  form.body.value = card.body.trimEnd();
  form.querySelectorAll('input, textarea').forEach((el) => { el.disabled = !!card.error; });
  $('#extra').replaceChildren(...Object.entries(card.extra).map(([k, v]) => h('span', { class: 'chip extra', title: 'Edit in the file' }, `${k}: ${v}`)));
  $('#new-comment').value = '';
  $('#new-comment').disabled = $('#add-comment').disabled = !!card.error;
  renderLog(card);
  $('#archive').textContent = card.archived ? 'Unarchive' : 'Archive';
  if (card.error) showError(`${card.name}: ${card.error}. Fix it in the file to edit this card.`);
  dialog.showModal();
}

// Comments, history and dates only, so it can refresh without touching unsaved field edits.
function renderLog(card) {
  $('#comments').replaceChildren(...(card.comments.length
    ? card.comments.map((c) => h('li', { class: 'comment' },
      h('div', { class: 'who' }, `${c.who} · ${day(c.at)}`),
      h('div', { class: 'text' }, c.text)))
    : [h('li', { class: 'empty' }, 'No comments yet')]));
  $('#history').replaceChildren(...(card.history.length ? card.history : ['No changes yet']).map((l) => h('li', {}, l)));
  $('#dates').textContent = [card.created && `Created ${day(card.created)}`, `Changed ${day(card.mtime)}`, card.archived && `Archived ${day(card.archived)}`]
    .filter(Boolean).join(' · ');
}

async function addComment() {
  const text = $('#new-comment').value;
  if (!current || !text.trim()) return;
  const name = current.name;
  const ok = await act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, { comment: text }));
  const updated = board.cards.find((c) => c.name === name);
  if (!ok || !updated || current?.name !== name) return;
  $('#new-comment').value = '';
  current = updated;
  renderLog(updated);
}

$('#add-comment').addEventListener('click', addComment);
$('#new-comment').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(); }
});

function changes() {
  const fields = {};
  const was = { heading: current.heading, status: current.status ?? '', type: current.type ?? '', assignee: current.assignee ?? '', tags: current.tags.join(', ') };
  for (const k of Object.keys(was)) if (form[k].value.trim() !== was[k]) fields[k] = form[k].value;
  const body = form.body.value.trimEnd() !== current.body.trimEnd() ? form.body.value : undefined;
  return { fields, body };
}

// Ctrl/⌘+Enter saves the card from any field, except the comment box where it adds the comment.
form.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.target.id === 'new-comment') return;
  e.preventDefault();
  form.requestSubmit(form.querySelector('button[value="save"]'));
});

form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save' || !current) return;
  const { fields, body } = changes();
  if (!Object.keys(fields).length && body === undefined) return;
  const name = current.name;
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, { fields, body }));
});

$('#archive').addEventListener('click', () => {
  const name = current.name;
  const archive = !current.archived;
  dialog.close();
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, { archive }));
});

dialog.addEventListener('close', () => { current = null; });

// --- live updates ----------------------------------------------------------

new EventSource('/api/events').onmessage = () => load();
load();
