import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderColumns, parseConfig, setConfigColumns, typeColor } from './board.ts';

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
