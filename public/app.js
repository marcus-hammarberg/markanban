// Markanban UI. Talks only to the HTTP API; every change re-fetches the board.
const $ = (sel) => document.querySelector(sel);
const boardEl = $('#board');
const dialog = $('#card-dialog');
const form = $('#card-form');

let board = null;
let current = null; // card open in the dialog
let hashSynced = false; // the link in the address bar is opened once, after the first load

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
  const text = [card.heading, card.body, ...card.comments.map((c) => c.text), ...card.attachments].join('\n');
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
  if (replaying) return; // live updates wait until replay ends; exitReplay() loads
  try {
    board = await api('GET', '/api/board');
    render();
    // Files dropped into the card's folder by hand show up in the open dialog too (fields are left alone).
    const open = current && board.cards.find((c) => c.name === current.name);
    if (open) { current.attachments = open.attachments; renderAttachments(current); }
    if (!hashSynced) { hashSynced = true; syncFromHash(); }
  } catch (e) {
    showError(`Could not load board: ${e.message}`);
  }
}

// live = false: a read-only card for replay (no drag, no dialog, no keyboard moves).
// Call it with an arrow, never .map(cardEl): map's index would land in `live`, making the first card read-only.
function cardEl(card, live = true) {
  const attrs = { class: 'card', 'data-name': card.name, 'data-color': card.color }; // color decided by the server
  return h('article', !live ? { ...attrs, title: 'Read-only during replay. Exit replay to edit.' } : {
    ...attrs,
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
  (card.type || card.assignee || card.comments.length > 0 || card.attachments.length > 0) && h('div', { class: 'meta' },
    card.type && h('span', { class: 'type-chip' }, card.type),
    card.assignee && h('span', {}, `@${card.assignee}`),
    card.comments.length > 0 && h('span', { title: `${card.comments.length} comment(s)` }, `💬 ${card.comments.length}`),
    card.attachments.length > 0 && h('span', { title: `${card.attachments.length} attachment(s)` }, `📎 ${card.attachments.length}`)),
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
  const el = h('section', { class: 'column' }, head, cards.map((c) => cardEl(c)));
  dropZone(el, (name, before) => moveCard(name, col.key, before), true);
  if (movable) columnDropZone(el, col.key);
  return el;
}

function render() {
  if (replaying) { refreshFilters(); return renderReplay(); }
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
    archived.map((c) => cardEl(c))) : null;

  // Every redraw (own actions and live updates) keeps keyboard focus on the same card.
  const focused = document.activeElement?.closest?.('#board .card')?.dataset.name;
  boardEl.replaceChildren(...cols, newCol, ...(archivedCol ? [archivedCol] : []));
  if (focused) boardEl.querySelector(`.card[data-name="${CSS.escape(focused)}"]`)?.focus();
}

// --- card dialog -----------------------------------------------------------

// The address bar follows the dialog (#card=<file name>): opening a card sets the hash, and the
// hashchange handler below does the showing, so clicks, Back/Forward and pasted links share one path.
const cardHash = (name) => `#card=${encodeURIComponent(name)}`;
const hashedCard = () => new URLSearchParams(location.hash.slice(1)).get('card');
const clearHash = () => { if (location.hash) history.replaceState(null, '', location.pathname + location.search); };

function openCard(card) {
  if (hashedCard() === card.name) showCard(card);
  else location.hash = cardHash(card.name);
}

function showCard(card) {
  current = card;
  form.heading.value = card.heading;
  form.status.value = card.status ?? '';
  form.type.value = card.type ?? '';
  form.assignee.value = card.assignee ?? '';
  form.tags.value = card.tags.join(', ');
  form.body.value = card.body.trimEnd();
  form.querySelectorAll('input, textarea').forEach((el) => { el.disabled = !!card.error; });
  $('#extra').replaceChildren(...Object.entries(card.extra).map(([k, v]) => h('span', { class: 'chip extra', title: 'Edit in the file' }, `${k}: ${v}`)));
  $('#attachments-section').open = $('#comments-section').open = $('#history-section').open = false; // collapsed by default
  $('#new-comment').value = '';
  $('#new-comment').disabled = $('#add-comment').disabled = !!card.error;
  renderLog(card);
  $('#archive').textContent = card.archived ? 'Unarchive' : 'Archive';
  if (card.error) showError(`${card.name}: ${card.error}. Fix it in the file to edit this card.`);
  if (!dialog.open) dialog.showModal();
}

// Comments, history and dates only, so it can refresh without touching unsaved field edits.
function renderLog(card) {
  $('#comments-title').textContent = card.comments.length ? `Comments (${card.comments.length})` : 'Comments';
  $('#comments').replaceChildren(...(card.comments.length
    ? card.comments.map((c) => h('li', { class: 'comment' },
      h('div', { class: 'who' }, `${c.who} · ${day(c.at)}`),
      h('div', { class: 'text' }, c.text)))
    : [h('li', { class: 'empty' }, 'No comments yet')]));
  renderAttachments(card);
  $('#history').replaceChildren(...(card.history.length ? card.history : ['No changes yet']).map((l) => h('li', {}, l)));
  $('#dates').textContent = [card.created && `Created ${day(card.created)}`, `Changed ${day(card.mtime)}`, card.archived && `Archived ${day(card.archived)}`]
    .filter(Boolean).join(' · ');
}

// --- attachments: files in the card's folder (fix-bug.md → fix-bug/) ------------

const attachmentUrl = (card, file) => `/api/cards/${encodeURIComponent(card)}/attachments/${encodeURIComponent(file)}`;

function renderAttachments(card) {
  const files = card.attachments;
  $('#attachments-title').textContent = files.length ? `Attachments (${files.length})` : 'Attachments';
  $('#attachments').replaceChildren(...(files.length
    ? files.map((f) => h('li', {}, h('a', { href: attachmentUrl(card.name, f), target: '_blank', rel: 'noopener' }, f)))
    : [h('li', { class: 'empty' }, 'No attachments yet')]));
}

// Raw bytes, not JSON: the X-Markanban header is what keeps other websites from uploading (see SPEC.md).
async function uploadFiles(files) {
  if (!current || !files.length) return;
  const name = current.name;
  const warnings = [];
  await act(async () => {
    for (const file of files) {
      const res = await fetch(`/api/cards/${encodeURIComponent(name)}/attachments?name=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'x-markanban': '1' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${file.name}: ${data.error || `${res.status} ${res.statusText}`}`);
      if (data.warning) warnings.push(data.warning);
    }
  });
  if (warnings.length) showError(warnings.join(' '));
  if (current?.name === name) $('#attachments-section').open = true;
}

$('#add-file').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = '';
});
// Pasting a file (a screenshot, a file copied in Finder) uploads it; pasting text works as before.
form.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  uploadFiles(files);
});
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
dialog.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dialog.classList.add('file-over');
});
dialog.addEventListener('dragleave', (e) => { if (!dialog.contains(e.relatedTarget)) dialog.classList.remove('file-over'); });
dialog.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dialog.classList.remove('file-over');
  uploadFiles([...e.dataTransfer.files]);
});

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
  const card = current;
  // The form closes on submit; if the save fails, bring it back with what the user typed.
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(card.name)}`, { fields, body })).then((ok) => {
    if (ok) return;
    current = card;
    history.replaceState(null, '', cardHash(card.name));
    dialog.showModal();
  });
});

$('#archive').addEventListener('click', () => {
  const name = current.name;
  const archive = !current.archived;
  dialog.close();
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, { archive }));
});

dialog.addEventListener('close', () => { current = null; clearHash(); });

// Show the card the hash names (archived or filtered-out cards included), or close the dialog if none.
function syncFromHash() {
  if (!board || replaying) return; // load() calls this once the first board has arrived; replay has no dialog
  const name = hashedCard();
  if (!name) { if (dialog.open) dialog.close(); return; }
  if (current?.name === name) return;
  const card = board.cards.find((c) => c.name === name);
  if (card) { showError(''); return showCard(card); }
  showError(`No card ${name}`);
  clearHash();
}
addEventListener('hashchange', syncFromHash);

let copyTimer;
$('#copy-link').addEventListener('click', async (e) => {
  if (!current) return;
  const url = location.origin + location.pathname + cardHash(current.name);
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '✓ Copied';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { btn.textContent = '🔗'; }, 1500);
  } catch {
    showError(`Could not copy. The link is ${url}`);
  }
});

// --- replay (read-only playback) -------------------------------------------
// The server turns changelogs into steps per card (board.replay); this only plays them back.
// The board snapshot from entering replay is kept; live updates wait until exit.

const SPEED = 8 * 3600; // 8 hours of board time per second
const DURATION = 300; // ms; a new change restarts animations from where they are, so they never lag the clock
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const replayTime = $('#replay-time');
let replaying = null; // { start, end, columns, steps, t, playing, frame, last, shown }

// The step in force at time t (the last one at or before t), or null before the card exists.
function stepAt(steps = [], t) {
  let found = null;
  for (const s of steps) { if (s.at > t) break; found = s; }
  return found;
}

function renderReplay() {
  const r = replaying;
  const byColumn = new Map(r.columns.map((c) => [c.key, []]));
  for (const card of board.cards.filter(matches)) { // board order = current rank order (ranks aren't logged)
    const s = stepAt(r.steps[card.name], r.t);
    if (s && !s.archived) byColumn.get(s.status)?.push(card);
  }
  // Current columns always show; statuses no longer in use only while they hold cards.
  const cols = r.columns.filter((c) => c.current || byColumn.get(c.key).length);
  const shown = JSON.stringify(cols.map((c) => [c.key, byColumn.get(c.key).map((card) => card.name)]));
  if (shown === r.shown) return; // nothing moved this frame
  r.shown = shown;

  const old = new Map([...boardEl.querySelectorAll('.card')].map((el) => [el.dataset.name, { el, rect: el.getBoundingClientRect() }]));
  boardEl.replaceChildren(...cols.map((col) => h('section', { class: 'column' },
    h('div', { class: `column-head${col.key === null ? ' no-status' : ''}` },
      h('span', { class: 'title' }, col.label), h('span', { class: 'count' }, String(byColumn.get(col.key).length))),
    byColumn.get(col.key).map((card) => cardEl(card, false)))));
  if (calm.matches) return;

  // Moved cards slide from where they were (FLIP), new ones fade in, gone ones fade out.
  for (const el of boardEl.querySelectorAll('.card')) {
    const was = old.get(el.dataset.name);
    old.delete(el.dataset.name);
    if (!was) { el.animate([{ opacity: 0 }, { opacity: 1 }], DURATION); continue; }
    const now = el.getBoundingClientRect();
    const dx = was.rect.left - now.left;
    const dy = was.rect.top - now.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DURATION, easing: 'ease-in-out' });
  }
  for (const { el, rect } of old.values()) {
    const ghost = el.cloneNode(true);
    ghost.classList.add('ghost');
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
    document.body.append(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], DURATION).onfinish = () => ghost.remove();
  }
}

function showReplayTime() {
  replayTime.value = replaying.t;
  $('#replay-clock').textContent = new Date(replaying.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('#replay-play').textContent = replaying.playing ? '❚❚ Pause' : '▶ Play';
  renderReplay();
}

function tick(now) {
  const r = replaying;
  r.t = Math.min(r.end, r.t + (now - r.last) * SPEED);
  r.last = now;
  if (r.t >= r.end) r.playing = false;
  else r.frame = requestAnimationFrame(tick);
  showReplayTime();
}

function setPlaying(on) {
  const r = replaying;
  cancelAnimationFrame(r.frame);
  r.playing = on;
  if (on) {
    if (r.t >= r.end) r.t = r.start; // play again from the beginning
    r.last = performance.now();
    r.frame = requestAnimationFrame(tick);
  }
  showReplayTime();
}

function exitReplay() {
  cancelAnimationFrame(replaying.frame);
  replaying = null;
  document.body.classList.remove('replaying');
  $('#replay-bar').hidden = true;
  load();
}

$('#replay-start').addEventListener('click', () => {
  if (!board || replaying) return;
  replaying = { ...board.replay, t: board.replay.start, playing: false, shown: null };
  replayTime.min = replaying.start;
  replayTime.max = replaying.end;
  document.body.classList.add('replaying');
  $('#replay-bar').hidden = false;
  setPlaying(true);
});
$('#replay-play').addEventListener('click', () => setPlaying(!replaying.playing));
replayTime.addEventListener('input', () => { replaying.t = Number(replayTime.value); showReplayTime(); });
$('#replay-exit').addEventListener('click', exitReplay);
// Grabbing a card during replay points at the way out.
boardEl.addEventListener('pointerdown', (e) => {
  if (!replaying || !e.target.closest('.card')) return;
  const exit = $('#replay-exit');
  exit.classList.remove('nudge');
  void exit.offsetWidth; // restart the animation on every grab
  exit.classList.add('nudge');
});
$('#replay-exit').addEventListener('animationend', (e) => e.currentTarget.classList.remove('nudge'));

// --- live updates ----------------------------------------------------------

new EventSource('/api/events').onmessage = () => load();
load();
