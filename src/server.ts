// HTTP API + static UI. The browser only ever talks to this API, never to files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChange, newCard, parseCard, slug, type Change } from './card.ts';
import { CONFIG_FILE, orderColumns, parseConfig, placeCard, rankOrder, setConfigColumns, typeColor } from './board.ts';
import type { Storage } from './storage.ts';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const MAX_BODY = 1_000_000;
// ISO 8601 UTC, whole seconds: the timestamp format used in every card file.
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  // Requiring application/json forces a CORS preflight, so other websites can't post here.
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* fall through */ }
  throw new HttpError(400, 'Invalid JSON');
}

const optString = (v: unknown, field: string) => {
  if (v == null || typeof v === 'string') return v as string | null | undefined;
  throw new HttpError(400, `${field} must be a string`);
};

export function createServer(storage: Storage, user: string) {
  const clients = new Set<http.ServerResponse>();
  const stopWatching = storage.watch(() => { for (const c of clients) c.write('data: change\n\n'); });

  async function board() {
    const config = parseConfig((await storage.read(CONFIG_FILE)) ?? '');
    // All board rules are decided here; the browser only displays the result.
    const { files, unreadable } = await storage.list();
    const cards = files.map((f) => {
      const card = parseCard(f.text, f);
      return { ...card, color: typeColor(card.type, config.types) };
    }).sort(rankOrder); // within each column: priority order, top first
    const active = cards.filter((c) => !c.archived);
    const columns = orderColumns(active.flatMap((c) => (c.status ? [c.status] : [])), config.columns)
      .map((s) => ({ key: s as string | null, label: s }));
    if (active.some((c) => !c.status)) columns.unshift({ key: null, label: config.noStatusColumn });
    const { warnings, ...settings } = config;
    warnings.push(...unreadable.map((u) => `${u.name} could not be read and is not shown (${u.message})`));
    return { folder: path.basename(storage.dir), user, config: settings, warnings, columns, cards };
  }

  async function createCard(body: Record<string, unknown>) {
    const heading = optString(body.heading, 'heading')?.trim();
    if (!heading) throw new HttpError(400, 'heading is required');
    const status = optString(body.status, 'status')?.trim() || null;
    if (/[\r\n]/.test(heading)) throw new HttpError(400, 'Heading must be a single line');
    const base = slug(heading);
    for (let i = 1; i < 1000; i++) {
      const name = `${base}${i > 1 ? `-${i}` : ''}.md`;
      try {
        await storage.write(name, newCard(heading, status, user, now()), { create: true });
        return { name };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new HttpError(409, 'Could not find a free file name');
  }

  // Applies a change to a card's text. A card without `created` gets its birthtime stamped
  // (see Change.created), so the atomic write can't reset the date it shows.
  async function applyTo(name: string, raw: string, change: Change) {
    if (parseCard(raw, { name, created: '', mtime: '' }).created === '') {
      const file = (await storage.list()).files.find((f) => f.name === name);
      if (file) change = { ...change, created: file.created.replace(/\.\d+Z$/, 'Z') };
    }
    return applyChange(raw, change, user, now());
  }

  async function updateCard(name: string, body: Record<string, unknown>) {
    const change: Change = {};
    if (body.fields !== undefined) {
      if (!body.fields || typeof body.fields !== 'object') throw new HttpError(400, 'fields must be an object');
      change.fields = Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, optString(v, k) ?? null]));
    }
    if (body.body !== undefined) change.body = optString(body.body, 'body') ?? '';
    if (body.comment !== undefined) change.comment = optString(body.comment, 'comment') ?? '';
    if (body.archive !== undefined) {
      if (typeof body.archive !== 'boolean') throw new HttpError(400, 'archive must be a boolean');
      change.archive = body.archive;
    }
    // Card order: the browser says where ("above card X", or the bottom); the server ranks.
    let rankUpdates: { name: string; rank: number }[] = [];
    if (body.place !== undefined) {
      const place = body.place as { before?: unknown } | null;
      if (!place || typeof place !== 'object' || !('before' in place) || (place.before !== null && typeof place.before !== 'string')) {
        throw new HttpError(400, 'place must be { "before": <card name> | null }');
      }
      const { cards } = await board();
      const card = cards.find((c) => c.name === name);
      if (!card) throw new HttpError(404, `No card ${name}`);
      const status = change.fields && 'status' in change.fields ? change.fields.status?.trim() || null : card.status;
      const column = cards.filter((c) => !c.archived && c.name !== name && c.status === status).sort(rankOrder);
      try {
        const plan = placeCard(column, place.before);
        change.rank = plan.rank;
        rankUpdates = plan.updates;
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }

    // Re-read right before writing so external edits are never overwritten with a stale copy.
    const raw = await storage.read(name);
    if (raw === null) throw new HttpError(404, `No card ${name}`);
    let next: string;
    try {
      next = await applyTo(name, raw, change);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (next === raw && !rankUpdates.length) return { name };
    const before = await statusColumns();
    for (const u of rankUpdates) {
      const text = await storage.read(u.name);
      if (text === null) continue;
      const ranked = await applyTo(u.name, text, { rank: u.rank });
      if (ranked !== text) await storage.write(u.name, ranked);
    }
    if (next !== raw) await storage.write(name, next);
    await keepColumns(before);
    return { name };
  }

  const statusColumns = async () => (await board()).columns.flatMap((c) => (c.key === null ? [] : [c.key]));

  // A column you can see doesn't vanish because a board action emptied it: if one would,
  // save the column order (before the action, plus any new columns) to .markanban.yml.
  // Boards where nothing disappears stay zero-config.
  async function keepColumns(before: string[]) {
    const after = await statusColumns();
    if (before.every((c) => after.includes(c))) return;
    const text = (await storage.read(CONFIG_FILE)) ?? '';
    try {
      await storage.write(CONFIG_FILE, setConfigColumns(text, [...before, ...after.filter((c) => !before.includes(c))]));
    } catch {
      // Unparseable config: leave it alone. The board already shows a warning about it.
    }
  }

  async function saveColumns(body: Record<string, unknown>) {
    const cols = body.columns;
    if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string')) throw new HttpError(400, 'columns must be a list of strings');
    await storage.write(CONFIG_FILE, setConfigColumns((await storage.read(CONFIG_FILE)) ?? '', cols));
    return { ok: true };
  }

  async function serveStatic(pathname: string, res: http.ServerResponse) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.join(PUBLIC, rel);
    if (!full.startsWith(PUBLIC)) throw new HttpError(404, 'Not found');
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: only answer requests addressed to localhost.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden host');

      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const cardMatch = /^\/api\/cards\/([^/]+)$/.exec(url.pathname);

      if (req.method === 'GET' && url.pathname === '/api/board') return send(await board());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/cards') return send(await createCard(await readJson(req)), 201);
      if (req.method === 'PATCH' && cardMatch) return send(await updateCard(decodeURIComponent(cardMatch[1]), await readJson(req)));
      if (req.method === 'PUT' && url.pathname === '/api/config/columns') return send(await saveColumns(await readJson(req)));
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as { status?: number }).status ?? 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.on('close', () => {
    stopWatching();
    for (const c of clients) c.end();
  });
  return server;
}
