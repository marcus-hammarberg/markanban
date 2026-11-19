import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoBoard } from './demo.ts';
import { parseCard } from './card.ts';
import { lint } from 'markdownlint/sync';
import { orderLanes, replay } from './board.ts';

test('demo board: every card parses and replays to its current state, ending just before now', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const files = demoBoard(now);
  assert.equal(files.get('.markanban.yml'), 'columns: [backlog, todo, doing, review, done]\n');
  const cards = [...files].filter(([name]) => name.endsWith('.md')).map(([name, text]) => parseCard(text, { name, created: '', mtime: '' }));
  assert.ok(cards.length > 15);
  for (const c of cards) assert.equal(c.error, undefined, c.name);

  const r = replay(cards, [], { columns: [], noStatusColumn: 'No status' }, now);
  assert.ok(r.start >= now - 21 * 86_400_000);
  for (const [name, steps] of Object.entries(r.steps)) {
    // No jump at the end: the changelog alone tells the whole story.
    assert.ok(steps.every((s) => s.at < now), `${name} has a step at or after now`);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i].at >= steps[i - 1].at, `${name} goes back in time`);
  }
  assert.deepEqual([...new Set(cards.map((c) => c.status))].sort(), ['backlog', 'doing', 'done', 'todo']);
  assert.ok(cards.some((c) => c.archived));
});

test('demo board: cards sit in lane folders, one stays at the top level, and one lane move is logged', () => {
  const files = demoBoard(Date.parse('2026-11-18T12:00:00Z'));
  const cards = [...files].filter(([name]) => name.endsWith('.md')).map(([name, text]) => parseCard(text, { name, created: '', mtime: '' }));
  assert.deepEqual(orderLanes(cards), [null, '1 Cards & files', '2 Board', '3 Sharing & release']);
  assert.ok(cards.every((c) => c.name.split('/').length <= 2), 'lanes are one folder deep');
  const moved = cards.filter((c) => c.history.some((l) => / lane: \S.* → /.test(l)));
  assert.equal(moved.length, 1);
  assert.match(moved[0].history.find((l) => l.includes(' lane: '))!, new RegExp(`lane: .+ → ${moved[0].lane}$`), 'logged move ends in the lane the file is in');
  assert.equal(cards.find((c) => c.heading === 'Swimlanes from subfolders')?.status, 'done');
});

// The demo writes cards with the same functions as the board, so this guards every card Markanban writes.
test('demo board: every card passes markdownlint (same rules as the repo docs)', () => {
  const files = demoBoard(Date.parse('2026-11-18T12:00:00Z'));
  const strings = Object.fromEntries([...files].filter(([name]) => name.endsWith('.md')));
  const results = lint({ strings, config: { default: true, MD013: false } });
  const problems = Object.entries(results).flatMap(([name, errors]) =>
    errors.map((e) => `${name}:${e.lineNumber} ${e.ruleNames.join('/')} ${e.ruleDescription}`));
  assert.ok(Object.keys(strings).length > 15);
  assert.deepEqual(problems, []);
});
