import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderColumns, parseConfig, placeCard, rankOrder, setConfigColumns, typeColor } from './board.ts';

test('common order first, then alphabetical', () => {
  assert.deepEqual(orderColumns(['zeta', 'Done', 'alpha', 'todo', 'In Progress'], []), ['todo', 'In Progress', 'Done', 'alpha', 'zeta']);
});

test('configured columns come first and survive when empty', () => {
  assert.deepEqual(orderColumns(['todo', 'done', 'x'], ['done', 'review']), ['done', 'review', 'todo', 'x']);
});

test('no duplicates', () => {
  assert.deepEqual(orderColumns(['todo', 'todo'], ['todo']), ['todo']);
});

test('valid config parses without warnings', () => {
  assert.deepEqual(parseConfig(''), { columns: [], noStatusColumn: 'No status', types: {}, warnings: [] });
  assert.deepEqual(parseConfig('columns: [a, b]\nnoStatusColumn: Inbox\ntypes:\n  Incident : red\n'),
    { columns: ['a', 'b'], noStatusColumn: 'Inbox', types: { incident: 'red' }, warnings: [] });
});

test('config problems: skip the broken part, fall back, warn with valid values', () => {
  const c = parseConfig('columns: nope\nnoStatusColumn: [x]\ntypes:\n  bug: reddish\n  docs: Blue\n');
  assert.deepEqual(c.columns, []);
  assert.equal(c.noStatusColumn, 'No status');
  assert.deepEqual(c.types, { docs: 'blue' });
  assert.equal(c.warnings.length, 3);
  assert.match(c.warnings[0], /columns must be a list/);
  assert.match(c.warnings[1], /noStatusColumn must be text/);
  assert.match(c.warnings[2], /unknown color "reddish" for type "bug".*red, orange/);

  assert.match(parseConfig('types: [bug]\n').warnings[0], /types must be a map/);

  const broken = parseConfig('columns: [a\n');
  assert.deepEqual(broken.columns, []);
  assert.match(broken.warnings[0], /not valid YAML/);
});

test('type colors: config wins, then built-in list, else none; case and spaces ignored', () => {
  assert.equal(typeColor('Bug ', {}), 'red');
  assert.equal(typeColor('defect', {}), 'red');
  assert.equal(typeColor('Story', {}), 'green');
  assert.equal(typeColor('chore', {}), 'grey');
  assert.equal(typeColor('bugs', {}), null);
  assert.equal(typeColor('marketing', {}), null);
  assert.equal(typeColor(null, {}), null);
  assert.equal(typeColor('BUG', { bug: 'pink' }), 'pink');
  assert.equal(typeColor('marketing', { marketing: 'teal' }), 'teal');
});

test('setting columns keeps other keys and comments', () => {
  const out = setConfigColumns('# mine\nnoStatusColumn: Inbox\n', ['b', 'a']);
  assert.match(out, /# mine/);
  assert.deepEqual(parseConfig(out), { columns: ['b', 'a'], noStatusColumn: 'Inbox', types: {}, warnings: [] });
});

const card = (name: string, rank: number | null, created = '2026-01-01T00:00:00Z') => ({ name, rank, created });

test('rankOrder: ranked by number, then unranked oldest first', () => {
  const sorted = [card('u2', null, '2026-02-01'), card('r2', 2000), card('u1', null, '2026-01-01'), card('r1', 1000)].sort(rankOrder);
  assert.deepEqual(sorted.map((c) => c.name), ['r1', 'r2', 'u1', 'u2']);
});

test('placeCard: halfway between neighbours, only the moved card changes', () => {
  const col = [card('a', 1000), card('b', 2000)];
  assert.deepEqual(placeCard(col, 'b'), { rank: 1500, updates: [] });
  assert.deepEqual(placeCard(col, 'a'), { rank: 0, updates: [] });
  assert.deepEqual(placeCard(col, null), { rank: 3000, updates: [] });
  assert.deepEqual(placeCard([], null), { rank: 1000, updates: [] });
});

test('placeCard: unranked cards above the drop point get a rank first; below are left alone', () => {
  const col = [card('a', 1000), card('b', null), card('c', null)];
  assert.deepEqual(placeCard(col, 'c'), { rank: 3000, updates: [{ name: 'b', rank: 2000 }] });
  assert.deepEqual(placeCard(col, 'b'), { rank: 2000, updates: [] });
  assert.deepEqual(placeCard([card('x', null), card('y', null)], null),
    { rank: 3000, updates: [{ name: 'x', rank: 1000 }, { name: 'y', rank: 2000 }] });
});

test('placeCard: renumbers the column in steps of 1000 when the gap runs out', () => {
  const col = [card('a', 1000), card('b', 1000.0005), card('c', null)];
  assert.deepEqual(placeCard(col, 'b'), { rank: 2000, updates: [{ name: 'b', rank: 3000 }] });
  // Equal (hand-edited) ranks also trigger a renumber.
  assert.deepEqual(placeCard([card('a', 5), card('b', 5)], 'b'), { rank: 2000, updates: [{ name: 'a', rank: 1000 }, { name: 'b', rank: 3000 }] });
});

test('placeCard: unknown target card is an error', () => {
  assert.throws(() => placeCard([card('a', 1000)], 'zzz'), /zzz/);
});
