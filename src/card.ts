// A card is a markdown file: optional YAML front-matter, a body, and an optional
// trailing "## Changelog" section. All edits are targeted text edits so whatever
// the user wrote (comments, key order, unknown fields, line endings) survives.
import { parseDocument, isSeq, YAMLSeq, type Document } from 'yaml';

export const KNOWN = ['heading', 'status', 'type', 'assignee', 'tags', 'created', 'archived', 'rank'] as const;
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
  rank: number | null; // position in its column: lower is higher up (more important)
  rankError?: string;
  mtime: string;
  body: string;
  history: string[];
  comments: Comment[];
  extra: Record<string, string>;
  conflict: boolean;
  error?: string;
}

export interface FileMeta { name: string; created: string; mtime: string }

export interface Change {
  fields?: Record<string, string | null>;
  body?: string;
  archive?: boolean;
  comment?: string;
  rank?: number; // board housekeeping: written to front-matter, never logged
}

// File layout: [front-matter] body [## Comments] [## Changelog] — the last two are optional.
interface Parts { eol: string; head: string; fm: string | null; body: string; comments: string | null; log: string | null }

const lastHeading = (text: string, re: RegExp) => {
  let idx = -1;
  for (const m of text.matchAll(re)) idx = m.index;
  return idx;
};

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
  const logAt = lastHeading(rest, /^## Changelog[ \t]*$/gm);
  const beforeLog = logAt < 0 ? rest : rest.slice(0, logAt);
  const commentsAt = lastHeading(beforeLog, /^## Comments[ \t]*$/gm);
  return {
    eol,
    head: text.slice(0, text.length - rest.length),
    fm,
    body: commentsAt < 0 ? beforeLog : beforeLog.slice(0, commentsAt),
    comments: commentsAt < 0 ? null : beforeLog.slice(commentsAt),
    log: logAt < 0 ? null : rest.slice(logAt),
  };
}

export interface Comment { at: string; who: string; text: string }

function parseComments(section: string | null): Comment[] {
  if (!section) return [];
  return section.split(/^### /m).slice(1).map((chunk) => {
    const [first, ...rest] = chunk.split('\n');
    const [at = '', who = ''] = first.trim().split(/\s+/);
    return { at, who, text: rest.join('\n').trim() };
  });
}

// Headings inside a comment would end the comment (or the section), so demote them.
const commentText = (text: string) => text.replace(/\r\n/g, '\n').trim().replace(/^#{1,3}(?=\s)/gm, '####');

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

// A broken hand-written rank is treated as "no rank" and flagged; the next move fixes it.
function parseRank(v: unknown): { rank: number | null; rankError?: string } {
  if (v == null) return { rank: null };
  if (typeof v === 'number' && Number.isFinite(v)) return { rank: v };
  return { rank: null, rankError: `rank must be a number (found ${JSON.stringify(v)})` };
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
    ...parseRank(data.rank),
    mtime: meta.mtime,
    body: p.body,
    history: (p.log ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    comments: parseComments(p.comments),
    extra,
    conflict: CONFLICT.test(meta.name),
    ...(error ? { error } : {}),
  };
}

const fmt = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(', ') : str(v);
  return s == null || s === '' ? '(none)' : s.replace(/\s+/g, ' ');
};

// Our own section and comment headings get a blank line after them (markdownlint MD022).
// Also upgrades files written before this rule. Never applied to the user's body.
const spaceHeadings = (s: string) => s.replace(/^(#{2,3} .*)\n(?!\n)/gm, '$1\n\n');

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

  let comments = p.comments;
  if (change.comment !== undefined) {
    const text = commentText(change.comment);
    if (!text) throw new Error('Comment is empty');
    comments = (comments ? comments.replace(/\s*$/, '\n\n') : '## Comments\n') + `### ${now} ${who}\n\n${text}\n`;
    log.push(`- ${now} ${who} comment: added`);
  }

  if (change.rank !== undefined && data.rank !== change.rank) setKey(doc, 'rank', change.rank);

  if (!log.length && !docChanged) return raw;

  let head = p.head;
  if (docChanged) {
    const empty = (doc.contents as { items?: unknown[] } | null)?.items?.length === 0 || doc.contents == null;
    head = empty ? '' : `---\n${String(doc)}---\n`;
  }
  const eol = (out: string) => (p.eol === '\n' ? out : out.replace(/\n/g, p.eol));
  // Front-matter-only change (rank): leave the rest of the file exactly as it was.
  if (!log.length) return eol(head + p.body + (p.comments ?? '') + (p.log ?? ''));

  // Sections followed by another section end with a blank line.
  const spaced = (s: string) => (s === '' ? '' : s.replace(/\n*$/, '\n\n'));
  const tail = spaceHeadings((p.log ?? '## Changelog\n').replace(/\n*$/, '\n'));
  const out = head + spaced(p.body) + (comments === null ? '' : spaced(spaceHeadings(comments))) + tail + log.join('\n') + '\n';
  return eol(out);
}

export function slug(heading: string): string {
  const s = heading.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'card';
}

export function newCard(heading: string, status: string | null, who: string, now: string): string {
  const doc = parseDocument('');
  if (status) doc.set('status', status);
  doc.set('created', now);
  return `---\n${String(doc)}---\n# ${heading.trim()}\n\n## Changelog\n\n- ${now} ${who} card: created\n`;
}
