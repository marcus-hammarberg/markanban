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
