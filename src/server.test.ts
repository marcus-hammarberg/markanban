import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStorage } from './storage.ts';
import { createServer } from './server.ts';

test('API: create, move, archive, reorder, and refuse unsafe requests', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-'));
  await writeFile(path.join(dir, 'README.md'), '# not a card');
  await writeFile(path.join(dir, 'loose.md'), 'no front-matter');
  const server = createServer(createStorage(dir), 'tester');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

  let board = await (await call('GET', '/api/board')).json();
  assert.deepEqual(board.cards.map((c: { name: string }) => c.name), ['loose.md']);
  assert.deepEqual(board.columns, [{ key: null, label: 'No status' }]);

  assert.equal((await call('POST', '/api/cards', { heading: 'Fix bug', status: 'todo' })).status, 201);
  assert.equal((await (await call('POST', '/api/cards', { heading: 'Fix bug' })).json()).name, 'fix-bug-2.md');

  assert.equal((await call('PATCH', '/api/cards/fix-bug.md', { fields: { status: 'doing' } })).status, 200);
  assert.match(await readFile(path.join(dir, 'fix-bug.md'), 'utf8'), /- \S+ tester status: todo → doing\n$/);

  await call('PATCH', '/api/cards/loose.md', { archive: true });
  await call('PUT', '/api/config/columns', { columns: ['done', 'doing'] });
  board = await (await call('GET', '/api/board')).json();
  assert.deepEqual(board.columns.map((c: { key: string | null }) => c.key), [null, 'done', 'doing']);
  assert.ok(board.cards.find((c: { name: string }) => c.name === 'loose.md').archived);

  // Colors and config warnings are decided by the server.
  await writeFile(path.join(dir, '.markanban.yml'), 'types:\n  chore: pink\n  bug: reddish\n');
  await call('PATCH', '/api/cards/fix-bug.md', { fields: { type: 'Bug' } });
  await call('PATCH', '/api/cards/fix-bug-2.md', { fields: { type: 'chore' } });
  board = await (await call('GET', '/api/board')).json();
  const color = (name: string) => board.cards.find((c: { name: string }) => c.name === name).color;
  assert.equal(color('fix-bug.md'), 'red');
  assert.equal(color('fix-bug-2.md'), 'pink');
  assert.equal(color('loose.md'), null);
  assert.equal(board.warnings.length, 1);
  assert.match(board.warnings[0], /unknown color "reddish"/);

  // Refusals
  assert.equal((await call('PATCH', '/api/cards/..%2Fescape.md', { fields: { status: 'x' } })).status, 400);
  assert.equal((await call('PATCH', '/api/cards/fix-bug.md', { fields: { created: 'x' } })).status, 400);
  assert.equal((await call('PATCH', '/api/cards/missing.md', { fields: { status: 'x' } })).status, 404);
  assert.equal((await call('PATCH', '/api/cards/fix-bug.md', { fields: { status: 'x' } }, { 'content-type': 'text/plain' })).status, 415);
  // fetch() drops custom Host headers, so use node:http for the DNS-rebinding check.
  const rebound = await new Promise<number | undefined>((resolve, reject) =>
    http.get(`${base}/api/board`, { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(rebound, 403);
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')));
});

test('static UI files are served, nothing outside public/ is, and bad JSON is refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-'));
  const server = createServer(createStorage(dir), 'tester');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  // Raw request: the path is sent exactly as written (fetch would normalise "../" away first).
  const request = (method: string, rawPath: string, body?: string, contentType = 'application/json') =>
    new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: { host: 'localhost', 'content-type': contentType } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  // Static files, with the right content type.
  const index = await request('GET', '/');
  assert.equal(index.status, 200);
  assert.equal(index.type, 'text/html');
  assert.match(index.text, /<title>Markanban<\/title>/);
  assert.equal((await request('GET', '/app.js')).type, 'text/javascript');
  assert.equal((await request('GET', '/style.css')).type, 'text/css');
  assert.equal((await request('GET', '/themes/dark.css')).status, 200);
  assert.equal((await request('GET', '/nope.html')).status, 404);
  assert.equal((await request('GET', '/api/nope')).status, 404);

  // Nothing outside public/ is reachable: package.json and src/ sit right next to it.
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2Fpackage.json', '/..%5Cpackage.json', '/../src/server.ts', '//etc/passwd']) {
    const res = await request('GET', p);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(res.text, /"dependencies"|createServer|root:/, p);
  }

  // Invalid request bodies are refused with a clear error, and nothing is written.
  const post = (body: string) => request('POST', '/api/cards', body);
  const invalid = await post('{oops');
  assert.equal(invalid.status, 400);
  assert.deepEqual(JSON.parse(invalid.text), { error: 'Invalid JSON' });
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('"just a string"')).status, 400);
  assert.equal((await post('')).status, 400);
  assert.match((await post('{"heading": 5}')).text, /heading must be a string/);
  assert.equal((await post('{"heading": "  "}')).status, 400);
  assert.equal((await post(JSON.stringify({ heading: 'x'.repeat(1_000_001) }))).status, 413);

  await writeFile(path.join(dir, 'card.md'), '---\nstatus: todo\n---\n# Card\n');
  const patch = (body: string) => request('PATCH', '/api/cards/card.md', body);
  assert.match((await patch('{"fields": {"status": 5}}')).text, /status must be a string/);
  assert.match((await patch('{"fields": "todo"}')).text, /fields must be an object/);
  assert.match((await patch('{"archive": "yes"}')).text, /archive must be a boolean/);
  assert.match((await patch('{"comment": 1}')).text, /comment must be a string/);
  assert.equal(await readFile(path.join(dir, 'card.md'), 'utf8'), '---\nstatus: todo\n---\n# Card\n');
  assert.deepEqual(await readdir(dir), ['card.md']);
});

test('a column emptied from the board stays (saved to .markanban.yml); others stay zero-config', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-'));
  // Columns known only from card statuses (cards written by hand, no config file).
  await writeFile(path.join(dir, 'a.md'), '---\nstatus: Todo\n---\n# A\n');
  await writeFile(path.join(dir, 'b.md'), '---\nstatus: Todo\n---\n# B\n');
  await writeFile(path.join(dir, 'c.md'), '---\nstatus: Review\n---\n# C\n');
  const server = createServer(createStorage(dir), 'tester');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const patch = (name: string, body: unknown) =>
    fetch(`${base}/api/cards/${name}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const columns = async () => (await (await fetch(`${base}/api/board`)).json()).columns.map((c: { key: string | null }) => c.key);
  const config = () => readFile(path.join(dir, '.markanban.yml'), 'utf8').catch(() => null);

  // Todo still has B: nothing would disappear, so no config file is created.
  await patch('a.md', { fields: { status: 'Doing' } });
  assert.equal(await config(), null);

  // Moving the last card out of Todo keeps Todo, in place and empty.
  await patch('b.md', { fields: { status: 'Doing' } });
  assert.deepEqual(await columns(), ['Todo', 'Doing', 'Review']);
  assert.match(String(await config()), /columns: \[ Todo, Doing, Review \]/);

  // Archiving the last card in a column keeps it too.
  await patch('c.md', { archive: true });
  assert.deepEqual(await columns(), ['Todo', 'Doing', 'Review']);
});
