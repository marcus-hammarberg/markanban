// A card is a markdown file: optional YAML front-matter, a body, and an optional
// trailing "## Changelog" section. All edits are targeted text edits so whatever
// the user wrote (comments, key order, unknown fields, line endings) survives.
import { parseDocument, isSeq, YAMLSeq, type Document } from 'yaml';

export const KNOWN = ['heading', 'status', 'type', 'assignee', 'tags', 'created', 'archived'] as const;
export const EDITABLE = ['heading', 'status', 'type', 'assignee', 'tags'];

export interface Card {
  name: string;
  heading: string;
  status: string | null;
  type: string | null;
  assignee: string | null;
  tags: string[];
  created: string;
  archived: string | null;
  mtime: string;
  body: string;
  history: string[];
  extra: Record<string, string>;
  conflict: boolean;
  error?: string;
}

export interface FileMeta { name: string; created: string; mtime: string }

export interface Change {
  fields?: Record<string, string | null>;
  body?: string;
  archive?: boolean;
}

interface Parts { eol: string; head: string; fm: string | null; body: string; log: string | null }

function split(raw: string): Parts {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = raw.replace(/\r\n/g, '\n');
  let fm: string | null = null;
  let rest = text;
  if (text.startsWith('---\n')) {
    const lines = text.split('\n');
    const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    if (close > 0) {
      fm = lines.slice(1, close).join('\n');
      rest = lines.slice(close + 1).join('\n');
    }
  }
  let idx = -1;
  for (const m of rest.matchAll(/^## Changelog[ \t]*$/gm)) idx = m.index;
  return {
    eol,
    head: text.slice(0, text.length - rest.length),
    fm,
    body: idx < 0 ? rest : rest.slice(0, idx),
    log: idx < 0 ? null : rest.slice(idx),
  };
}

const str = (v: unknown) => (v == null || v === '' ? null : String(v));

const toTags = (v: unknown): string[] =>
  v == null ? [] : (Array.isArray(v) ? v.map(String) : String(v).split(',')).map((t) => t.trim()).filter(Boolean);

const h1 = (body: string) => /^# +(.+)$/m.exec(body)?.[1].trim() ?? null;

const fileHeading = (name: string) => name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();

// Dropbox "(x's conflicted copy …)", Google Drive / OneDrive "(1)".
const CONFLICT = /\((\d+|[^)]*conflict[^)]*)\)\.md$/i;

function readDoc(fm: string | null) {
  const doc = parseDocument(fm ?? '');
  const error = doc.errors[0]?.message;
  const data = error ? {} : ((doc.toJS() ?? {}) as Record<string, unknown>);
  return { doc, error, data: typeof data === 'object' && !Array.isArray(data) ? data : {} };
}

export function parseCard(raw: string, meta: FileMeta): Card {
  const p = split(raw);
  const { data, error } = readDoc(p.fm);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!(KNOWN as readonly string[]).includes(k)) extra[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return {
    name: meta.name,
    heading: str(data.heading) ?? h1(p.body) ?? fileHeading(meta.name),
    status: str(data.status),
    type: str(data.type),
    assignee: str(data.assignee),
    tags: toTags(data.tags),
    created: str(data.created) ?? meta.created,
    archived: str(data.archived),
    mtime: meta.mtime,
    body: p.body,
    history: (p.log ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    extra,
    conflict: CONFLICT.test(meta.name),
    ...(error ? { error } : {}),
  };
}

const fmt = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(', ') : str(v);
  return s == null || s === '' ? '(none)' : s.replace(/\s+/g, ' ');
};

const normBody = (b: string) => b.replace(/\r\n/g, '\n').trimEnd();

/** Apply a UI change to a file's text. Returns the new text (unchanged if nothing changed). */
export function applyChange(raw: string, change: Change, who: string, now: string): string {
  const p = split(raw);
  const { doc, error, data } = readDoc(p.fm);
  if (error) throw new Error(`Front-matter is not valid YAML: ${error}`);
  const log: string[] = [];
  let docChanged = false;
  const record = (field: string, from: unknown, to: unknown) => log.push(`- ${now} ${who} ${field}: ${fmt(from)} → ${fmt(to)}`);
  const setKey = (doc: Document, key: string, value: unknown) => {
    if (value == null) doc.delete(key);
    else doc.set(key, value);
    docChanged = true;
  };

  if (change.body !== undefined && normBody(change.body) !== normBody(p.body)) {
    p.body = normBody(change.body) + '\n';
    log.push(`- ${now} ${who} body: edited`);
  }

  for (const [key, rawValue] of Object.entries(change.fields ?? {})) {
    if (!EDITABLE.includes(key)) throw new Error(`Field "${key}" is not editable`);
    const value = rawValue == null ? null : rawValue.trim() || null;

    if (key === 'heading') {
      const old = str(data.heading) ?? h1(p.body);
      if (value === old || value === null) {
        if (value === null && doc.has('heading')) { record(key, data.heading, null); setKey(doc, key, null); }
        continue;
      }
      if (!doc.has('heading') && h1(p.body) !== null) p.body = p.body.replace(/^# +.+$/m, `# ${value}`);
      else setKey(doc, key, value);
      record(key, old, value);
      continue;
    }

    if (key === 'tags') {
      const tags = toTags(value);
      if (fmt(tags) === fmt(toTags(data.tags))) continue;
      const old = doc.get('tags', true);
      let next: unknown = tags.length ? tags.join(', ') : null;
      if (tags.length && isSeq(old)) {
        const node = doc.createNode(tags) as YAMLSeq;
        node.flow = old.flow;
        next = node;
      }
      record(key, toTags(data.tags), tags);
      setKey(doc, key, next);
      continue;
    }

    if (fmt(value) === fmt(data[key])) continue;
    record(key, data[key], value);
    setKey(doc, key, value);
  }

  if (change.archive === true && !data.archived) { record('archived', null, now); setKey(doc, 'archived', now); }
  if (change.archive === false && data.archived) { record('archived', data.archived, null); setKey(doc, 'archived', null); }

  if (!log.length) return raw;

  let head = p.head;
  if (docChanged) {
    const empty = (doc.contents as { items?: unknown[] } | null)?.items?.length === 0 || doc.contents == null;
    head = empty ? '' : `---\n${String(doc)}---\n`;
  }
  let body = p.body;
  let tail = p.log;
  if (tail === null) {
    body = body === '' ? '' : body.replace(/\n*$/, '\n\n');
    tail = '## Changelog\n';
  } else if (!/\n\n$/.test(body) && body !== '') {
    body = body.replace(/\n*$/, '\n\n');
  }
  if (!tail.endsWith('\n')) tail += '\n';
  const out = head + body + tail + log.join('\n') + '\n';
  return p.eol === '\n' ? out : out.replace(/\n/g, p.eol);
}

export function slug(heading: string): string {
  const s = heading.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'card';
}

export function newCard(heading: string, status: string | null, now: string): string {
  const doc = parseDocument('');
  if (status) doc.set('status', status);
  doc.set('created', now);
  return `---\n${String(doc)}---\n# ${heading.trim()}\n`;
}
