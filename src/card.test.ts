import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, applyChange, newCard, slug } from './card.ts';

const NOW = '2026-11-16T14:03:12Z';
const meta = { name: 'fix-login-bug.md', created: 'C', mtime: 'M' };

const sample = `---
# keep me
status: todo
tags: ui, auth
priority: high
---
# Fix login bug

Some text.

## Changelog
- 2026-11-01T00:00:00Z anna status: (none) → todo
`;

test('parses fields, heading, body, history and unknown fields', () => {
  const c = parseCard(sample, meta);
  assert.equal(c.status, 'todo');
  assert.deepEqual(c.tags, ['ui', 'auth']);
  assert.equal(c.heading, 'Fix login bug');
  assert.equal(c.body, '# Fix login bug\n\nSome text.\n\n');
  assert.deepEqual(c.history, ['2026-11-01T00:00:00Z anna status: (none) → todo']);
  assert.deepEqual(c.extra, { priority: 'high' });
  assert.equal(c.created, 'C');
});

test('heading fallback chain: front-matter > H1 > filename', () => {
  assert.equal(parseCard('---\nheading: A\n---\n# B\n', meta).heading, 'A');
  assert.equal(parseCard('# B\n', meta).heading, 'B');
  assert.equal(parseCard('just text', meta).heading, 'fix login bug');
});

test('file without front-matter is a card with no status', () => {
  const c = parseCard('hello', meta);
  assert.equal(c.status, null);
  assert.equal(c.body, 'hello');
});

test('tags as YAML list', () => {
  assert.deepEqual(parseCard('---\ntags: [a, b]\n---\n', meta).tags, ['a', 'b']);
});

test('detects sync conflict copies', () => {
  assert.equal(parseCard('', { ...meta, name: 'x (1).md' }).conflict, true);
  assert.equal(parseCard('', { ...meta, name: "x (Anna's conflicted copy 2026-01-01).md" }).conflict, true);
  assert.equal(parseCard('', meta).conflict, false);
});

test('invalid YAML is reported, not thrown', () => {
  const c = parseCard('---\nstatus: [oops\n---\nbody', meta);
  assert.ok(c.error);
  assert.equal(c.status, null);
});

test('status change keeps comments/order and appends a changelog line', () => {
  const out = applyChange(sample, { fields: { status: 'doing' } }, 'marcus', NOW);
  assert.match(out, /# keep me\nstatus: doing\ntags: ui, auth\npriority: high\n---/);
  assert.ok(out.endsWith(`- 2026-11-01T00:00:00Z anna status: (none) → todo\n- ${NOW} marcus status: todo → doing\n`));
});

test('no-op change returns file untouched', () => {
  assert.equal(applyChange(sample, { fields: { status: 'todo' } }, 'm', NOW), sample);
  assert.equal(applyChange(sample, { body: '# Fix login bug\n\nSome text.\n\n' }, 'm', NOW), sample);
});

test('creates front-matter and changelog section when missing', () => {
  const out = applyChange('# Hi\n', { fields: { status: 'todo' } }, 'm', NOW);
  assert.equal(out, `---\nstatus: todo\n---\n# Hi\n\n## Changelog\n\n- ${NOW} m status: (none) → todo\n`);
});

test('clearing a field removes it and logs (none)', () => {
  const out = applyChange(sample, { fields: { status: '' } }, 'm', NOW);
  assert.doesNotMatch(out, /^status:/m);
  assert.match(out, /status: todo → \(none\)\n$/);
});

test('tags keep the form already used in the file', () => {
  const asList = applyChange('---\ntags: [a]\n---\n', { fields: { tags: 'a, b' } }, 'm', NOW);
  assert.match(asList, /tags: \[ a, b \]|tags:\s*\n\s*- a\n\s*- b|tags: \[a, b\]/);
  const asString = applyChange(sample, { fields: { tags: 'ui,auth , x' } }, 'm', NOW);
  assert.match(asString, /^tags: ui, auth, x$/m);
  assert.match(asString, /tags: ui, auth → ui, auth, x\n$/);
});

test('body edit logs "body: edited" and keeps changelog out of the body', () => {
  const out = applyChange(sample, { body: 'New body\n' }, 'm', NOW);
  const c = parseCard(out, meta);
  assert.equal(c.body, 'New body\n\n');
  assert.equal(c.history.at(-1), `${NOW} m body: edited`);
});

test('heading edit updates the H1 when that is where it came from', () => {
  const out = applyChange(sample, { fields: { heading: 'Fix logout bug' } }, 'm', NOW);
  assert.match(out, /^# Fix logout bug$/m);
  assert.doesNotMatch(out, /^heading:/m);
  assert.match(out, /heading: Fix login bug → Fix logout bug\n$/);
});

test('archive sets a timestamp; unarchive removes it', () => {
  const a = applyChange(sample, { archive: true }, 'm', NOW);
  assert.equal(parseCard(a, meta).archived, NOW);
  assert.match(a, new RegExp(`archived: \\(none\\) → ${NOW}\\n$`));
  const u = applyChange(a, { archive: false }, 'm', NOW);
  assert.equal(parseCard(u, meta).archived, null);
});

test('CRLF files stay CRLF', () => {
  const crlf = sample.replace(/\n/g, '\r\n');
  const out = applyChange(crlf, { fields: { status: 'doing' } }, 'm', NOW);
  assert.doesNotMatch(out.replace(/\r\n/g, ''), /\n/);
});

test('refuses to write into invalid YAML', () => {
  assert.throws(() => applyChange('---\nstatus: [oops\n---\n', { fields: { status: 'x' } }, 'm', NOW));
});

test('comments: added between body and changelog, logged, kept out of the body', () => {
  const out = applyChange(sample, { comment: 'First!\n## Changelog\nsecond line' }, 'anna', NOW);
  assert.equal(out, `---
# keep me
status: todo
tags: ui, auth
priority: high
---
# Fix login bug

Some text.

## Comments

### ${NOW} anna

First!
#### Changelog
second line

## Changelog

- 2026-11-01T00:00:00Z anna status: (none) → todo
- ${NOW} anna comment: added
`);
  const c = parseCard(out, meta);
  assert.equal(c.body, '# Fix login bug\n\nSome text.\n\n');
  assert.deepEqual(c.comments, [{ at: NOW, who: 'anna', text: 'First!\n#### Changelog\nsecond line' }]);
  assert.equal(c.history.length, 2);

  const two = applyChange(out, { comment: 'Second' }, 'marcus', 'T2');
  assert.deepEqual(parseCard(two, meta).comments.map((x) => x.text), ['First!\n#### Changelog\nsecond line', 'Second']);
  assert.match(two, /second line\n\n### T2 marcus\n\nSecond\n\n## Changelog\n\n- /);
});

test('comment on a bare file; empty comment is refused', () => {
  assert.equal(applyChange('Hi\n', { comment: 'yo' }, 'm', NOW), `Hi\n\n## Comments\n\n### ${NOW} m\n\nyo\n\n## Changelog\n\n- ${NOW} m comment: added\n`);
  assert.throws(() => applyChange('Hi\n', { comment: '  ' }, 'm', NOW));
});

test('body edit keeps existing comments', () => {
  const withComment = applyChange(sample, { comment: 'keep me' }, 'm', NOW);
  const out = applyChange(withComment, { body: 'New' }, 'm', NOW);
  const c = parseCard(out, meta);
  assert.equal(c.body, 'New\n\n');
  assert.equal(c.comments[0].text, 'keep me');
});

test('newCard writes status, created, H1 and a "card: created" changelog line; slug is filename-safe', () => {
  const raw = newCard('Fix: Åsa’s login!', 'todo', 'anna', NOW);
  assert.equal(raw, `---\nstatus: todo\ncreated: ${NOW}\n---\n# Fix: Åsa’s login!\n\n## Changelog\n\n- ${NOW} anna card: created\n`);
  const c = parseCard(raw, meta);
  assert.equal(c.heading, 'Fix: Åsa’s login!');
  assert.equal(c.status, 'todo');
  assert.equal(c.created, NOW);
  assert.equal(c.body, '# Fix: Åsa’s login!\n\n');
  assert.deepEqual(c.history, [`${NOW} anna card: created`]);
  // Later changes append below the created line.
  assert.match(applyChange(raw, { fields: { status: 'doing' } }, 'm', 'T2'), /card: created\n- T2 m status: todo → doing\n$/);
  assert.equal(slug('Fix: Åsa’s login!'), 'fix-asa-s-login');
  assert.equal(slug('!!!'), 'card');
});

// MD022: every heading Markanban writes has a blank line after it (and before, unless first).
const headingsSpaced = (text: string) =>
  text.split('\n').every((line, i, lines) => !/^#{1,6} /.test(line) || ((i === 0 || lines[i - 1] === '' || lines[i - 1] === '---') && (lines[i + 1] ?? '') === ''));

test('written sections satisfy markdownlint MD022, also when upgrading the old layout', () => {
  const old = '# Hi\n\n## Comments\n### T0 a\nold\n\n## Changelog\n- T0 a comment: added\n';
  const out = applyChange(old, { comment: 'new' }, 'm', NOW);
  assert.ok(headingsSpaced(out.replace(/^# Hi\n/, '')), out);
  assert.match(out, /## Comments\n\n### T0 a\n\nold\n\n### .+\n\nnew\n\n## Changelog\n\n- T0 a comment: added\n- .+ comment: added\n$/);
  assert.deepEqual(parseCard(out, meta).comments.map((c) => c.text), ['old', 'new']);
  assert.ok(headingsSpaced(newCard('X', null, 'm', NOW).replace(/^---[\s\S]*?---\n# X\n/, '')));
});

test('rank: parsed as a hidden number; bad values are flagged, not shown', () => {
  const c = parseCard('---\nstatus: todo\nrank: 1500.5\n---\n', meta);
  assert.equal(c.rank, 1500.5);
  assert.equal(c.rankError, undefined);
  assert.deepEqual(c.extra, {});
  assert.equal(parseCard('no front-matter', meta).rank, null);
  const bad = parseCard('---\nrank: high\n---\n', meta);
  assert.equal(bad.rank, null);
  assert.match(String(bad.rankError), /rank must be a number/);
  assert.deepEqual(bad.extra, {});
});

test('rank changes rewrite only the front-matter and are never logged', () => {
  const out = applyChange(sample, { rank: 2000 }, 'm', NOW);
  assert.equal(out, sample.replace('priority: high\n', 'priority: high\nrank: 2000\n'));
  assert.equal(applyChange(out, { rank: 2000 }, 'm', NOW), out);
  // No changelog section is created for a rank-only change.
  assert.equal(applyChange('# Hi\n', { rank: 1000 }, 'm', NOW), '---\nrank: 1000\n---\n# Hi\n');
  // Moving to another column: status is logged, rank is not.
  const moved = applyChange(sample, { fields: { status: 'doing' }, rank: 500 }, 'm', NOW);
  assert.match(moved, /^rank: 500$/m);
  assert.match(moved, /status: todo → doing\n$/);
  assert.doesNotMatch(moved, /rank: .* → /);
});

test('a heading with $ replacement patterns is written literally', () => {
  const out = applyChange('# Old\n\nbody\n', { fields: { heading: 'Cost $& more $1 $$' } }, 'me', NOW);
  assert.equal(out.split('\n')[0], '# Cost $& more $1 $$');
});

test('headings with line breaks are refused (they could forge sections)', () => {
  assert.throws(() => applyChange('# Old\n', { fields: { heading: 'x\n## Changelog' } }, 'me', NOW), /single line/);
  assert.throws(() => newCard('x\n## Changelog', null, 'me', NOW), /single line/);
});

test('first write to a card without `created` stamps the birthtime; no-op writes stay no-ops', () => {
  const created = '2026-01-01T00:00:00Z';
  const out = applyChange('just text\n', { fields: { status: 'todo' }, created }, 'me', NOW);
  assert.equal(parseCard(out, { ...meta, created: 'X' }).created, created);
  assert.equal(applyChange('just text\n', { created }, 'me', NOW), 'just text\n');
  // An existing `created` is never overwritten.
  const has = '---\ncreated: 2025-05-05T00:00:00Z\n---\nx\n';
  assert.equal(parseCard(applyChange(has, { fields: { status: 'a' }, created }, 'me', NOW), meta).created, '2025-05-05T00:00:00Z');
  // Rank-only writes stamp too, so a reorder can't reset the date either.
  assert.match(applyChange('just text\n', { rank: 1000, created }, 'me', NOW), /created: 2026-01-01T00:00:00Z/);
});

test('a whitespace-only status counts as no status', () => {
  assert.equal(parseCard('---\nstatus: "  "\n---\nx', meta).status, null);
});

test('attachment: an upload is logged as one changelog line, the rest of the file untouched', () => {
  // The only other change is the usual blank line after "## Changelog" (MD022).
  const expected = sample.replace('## Changelog\n', '## Changelog\n\n') + `- ${NOW} anna attachment: added shot.png\n`;
  assert.equal(applyChange(sample, { attachment: 'shot.png' }, 'anna', NOW), expected);
  assert.equal(applyChange(sample.replace(/\n/g, '\r\n'), { attachment: 'shot.png' }, 'anna', NOW), expected.replace(/\n/g, '\r\n'));
  assert.throws(() => applyChange(sample, { attachment: 'a\n## Changelog' }, 'anna', NOW), /single line/);
});
