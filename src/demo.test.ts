import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoBoard } from './demo.ts';
import { parseCard } from './card.ts';
import { replay } from './board.ts';

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
