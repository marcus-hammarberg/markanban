import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderColumns, parseConfig, setConfigColumns } from './board.ts';

test('common order first, then alphabetical', () => {
  assert.deepEqual(orderColumns(['zeta', 'Done', 'alpha', 'todo', 'In Progress'], []), ['todo', 'In Progress', 'Done', 'alpha', 'zeta']);
});

test('configured columns come first and survive when empty', () => {
  assert.deepEqual(orderColumns(['todo', 'done', 'x'], ['done', 'review']), ['done', 'review', 'todo', 'x']);
});

test('no duplicates', () => {
  assert.deepEqual(orderColumns(['todo', 'todo'], ['todo']), ['todo']);
});

test('config parsing tolerates junk', () => {
  assert.deepEqual(parseConfig(''), { columns: [], noStatusColumn: 'No status' });
  assert.deepEqual(parseConfig('columns: [a, b]\nnoStatusColumn: Inbox\n'), { columns: ['a', 'b'], noStatusColumn: 'Inbox' });
  assert.deepEqual(parseConfig('columns: nope\n: : ['), { columns: [], noStatusColumn: 'No status' });
});

test('setting columns keeps other keys and comments', () => {
  const out = setConfigColumns('# mine\nnoStatusColumn: Inbox\n', ['b', 'a']);
  assert.match(out, /# mine/);
  assert.deepEqual(parseConfig(out), { columns: ['b', 'a'], noStatusColumn: 'Inbox' });
});
