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
  } catch (e) {
    showError(e.message);
  }
  await load();
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
  if (q && !`${card.heading}\n${card.body}`.toLowerCase().includes(q)) return false;
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
    draggable: card.archived ? 'false' : 'true',
    ondragstart: (e) => {
      e.dataTransfer.setData('text/x-card', card.name);
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
    onclick: () => openCard(card),
  },
  h('div', { class: 'heading' }, card.heading),
  card.conflict && h('div', { class: 'warn' }, '⚠️ Possible sync conflict copy'),
  card.error && h('div', { class: 'warn' }, '⚠️ Front-matter has invalid YAML'),
  (card.type || card.assignee) && h('div', { class: 'meta' },
    card.type && h('span', {}, card.type),
    card.assignee && h('span', {}, `@${card.assignee}`)),
  (card.tags.length || Object.keys(card.extra).length) ? h('div', { class: 'chips' },
    card.tags.map((t) => h('span', { class: 'chip' }, t)),
    Object.entries(card.extra).map(([k, v]) => h('span', { class: 'chip extra' }, `${k}: ${v}`))) : null);
}

function moveCard(name, status) {
  const card = board.cards.find((c) => c.name === name);
  if (!card || card.status === status) return;
  act(() => api('PATCH', `/api/cards/${encodeURIComponent(name)}`, { fields: { status: status ?? '' } }));
}

function dropZone(el, onCard) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-card')) return;
    e.preventDefault();
    el.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('over');
    const name = e.dataTransfer.getData('text/x-card');
    if (name) { e.preventDefault(); onCard(name); }
  });
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
  dropZone(el, (name) => moveCard(name, col.key));
  if (movable) columnDropZone(el, col.key);
  return el;
}

function render() {
  $('#title').textContent = board.folder ? `Markanban · ${board.folder}` : 'Markanban';
  document.title = $('#title').textContent;
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
    if (status) moveCard(name, status);
  });

  const archived = showArchived.checked ? visible.filter((c) => c.archived) : [];
  const archivedCol = archived.length ? h('section', { class: 'column archived' },
    h('div', { class: 'column-head' }, h('span', { class: 'title' }, 'Archived'), h('span', { class: 'count' }, String(archived.length))),
    archived.map(cardEl)) : null;

  boardEl.replaceChildren(...cols, newCol, ...(archivedCol ? [archivedCol] : []));
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
  $('#history').replaceChildren(...(card.history.length ? card.history : ['No changes yet']).map((l) => h('li', {}, l)));
  $('#archive').textContent = card.archived ? 'Unarchive' : 'Archive';
  $('#dates').textContent = [card.created && `Created ${day(card.created)}`, `Changed ${day(card.mtime)}`, card.archived && `Archived ${day(card.archived)}`]
    .filter(Boolean).join(' · ');
  if (card.error) showError(`${card.name}: ${card.error}. Fix it in the file to edit this card.`);
  dialog.showModal();
}

function changes() {
  const fields = {};
  const was = { heading: current.heading, status: current.status ?? '', type: current.type ?? '', assignee: current.assignee ?? '', tags: current.tags.join(', ') };
  for (const k of Object.keys(was)) if (form[k].value.trim() !== was[k]) fields[k] = form[k].value;
  const body = form.body.value.trimEnd() !== current.body.trimEnd() ? form.body.value : undefined;
  return { fields, body };
}

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
