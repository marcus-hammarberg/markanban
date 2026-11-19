import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachmentName, createStorage, pollFolder } from './storage.ts';

// Synced folders (Drive for desktop, SMB) often fire no fs events, so polling alone must see every change.
test('pollFolder: sees card and config changes, ignores other files, stops on close', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-poll-'));
  await writeFile(path.join(dir, 'a.md'), 'one');
  let changes = 0;
  const stop = pollFolder(dir, 20, () => changes++);
  t.after(stop);
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const expectChange = async (what: string, act: () => Promise<unknown>) => {
    const before = changes;
    await act();
    await settle();
    assert.ok(changes > before, `${what} should be noticed`);
  };

  await settle();
  assert.equal(changes, 0, 'first look is the baseline, not a change');

  await expectChange('edit', () => writeFile(path.join(dir, 'a.md'), 'two!'));
  await expectChange('new card', () => writeFile(path.join(dir, 'b.md'), 'x'));
  await expectChange('rename', () => rename(path.join(dir, 'b.md'), path.join(dir, 'c.md')));
  await expectChange('config', () => writeFile(path.join(dir, '.markanban.yml'), 'columns: [todo]'));

  const before = changes;
  await writeFile(path.join(dir, 'README.md'), 'not a card');
  await writeFile(path.join(dir, '.a.md.123.tmp'), 'temp');
  await writeFile(path.join(dir, 'notes.txt'), 'x');
  await settle();
  assert.equal(changes, before, 'non-card files are ignored');

  stop();
  await writeFile(path.join(dir, 'a.md'), 'after stop');
  await settle();
  assert.equal(changes, before, 'no polling after stop');
});

test('attachmentName: keeps the name, strips paths, hidden dots and unsafe characters', () => {
  assert.equal(attachmentName('shot.png'), 'shot.png');
  assert.equal(attachmentName('../../etc/passwd'), 'passwd');
  assert.equal(attachmentName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(attachmentName('.env'), 'env');
  assert.equal(attachmentName('a\nb:c?.txt'), 'a-b-c-.txt');
  assert.equal(attachmentName('...'), 'file');
  assert.equal(attachmentName(''), 'file');
});

test('attachments: a folder per card, never overwritten, only one level deep', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-att-'));
  await writeFile(path.join(dir, 'fix-bug.md'), '# Fix bug');
  const s = createStorage(dir);
  const chunks = (text: string) => [Buffer.from(text)];

  assert.deepEqual(await s.listAttachments('fix-bug.md'), [], 'no folder yet');
  assert.equal(await s.writeAttachment('fix-bug.md', 'shot.png', chunks('one')), 'shot.png');
  assert.equal(await s.writeAttachment('fix-bug.md', 'shot.png', chunks('two')), 'shot-2.png');
  assert.equal(await s.writeAttachment('fix-bug.md', 'notes', chunks('three')), 'notes');
  assert.equal(await readFile(path.join(dir, 'fix-bug', 'shot.png'), 'utf8'), 'one', 'first file untouched');
  assert.equal((await s.readAttachment('fix-bug.md', 'shot-2.png'))?.toString(), 'two');
  assert.equal(await s.readAttachment('fix-bug.md', 'missing.png'), null);

  // Hand-added files count; hidden files and subfolders don't.
  await writeFile(path.join(dir, 'fix-bug', 'added-by-hand.txt'), 'x');
  await writeFile(path.join(dir, 'fix-bug', '.DS_Store'), 'x');
  await mkdir(path.join(dir, 'fix-bug', 'sub'));
  assert.deepEqual(await s.listAttachments('fix-bug.md'), ['added-by-hand.txt', 'notes', 'shot-2.png', 'shot.png']);

  // A failed upload leaves nothing behind.
  async function* broken() { yield Buffer.from('partial'); throw new Error('client went away'); }
  await assert.rejects(s.writeAttachment('fix-bug.md', 'big.bin', broken()), /client went away/);
  assert.deepEqual((await readdir(path.join(dir, 'fix-bug'))).filter((f) => f.startsWith('.') && f !== '.DS_Store'), []);
  assert.ok(!(await readdir(path.join(dir, 'fix-bug'))).includes('big.bin'));

  for (const [card, file] of [['fix-bug.md', '../fix-bug.md'], ['fix-bug.md', '.DS_Store'], ['fix-bug.md', 'sub/x'], ['../x.md', 'a'], ['fix-bug.md', '..']]) {
    await assert.rejects(s.readAttachment(card, file), /Invalid/, `${card} ${file}`);
  }
});

test('pollFolder: sees files added to a card folder, ignores other folders', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-poll-'));
  await writeFile(path.join(dir, 'a.md'), 'one');
  await mkdir(path.join(dir, 'a'));
  await mkdir(path.join(dir, 'unrelated'));
  let changes = 0;
  const stop = pollFolder(dir, 20, () => changes++);
  t.after(stop);
  const settle = () => new Promise((r) => setTimeout(r, 80));
  await settle();
  await writeFile(path.join(dir, 'unrelated', 'x.txt'), 'x');
  await settle();
  assert.equal(changes, 0, 'a folder that belongs to no card is ignored');
  await writeFile(path.join(dir, 'a', 'shot.png'), 'x');
  await settle();
  assert.ok(changes > 0, 'an attachment dropped in by hand is noticed');
});

test('lanes: a folder without a same-named card is a lane, one level deep', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-lanes-'));
  const put = async (rel: string, text = 'x') => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  await put('a.md');
  await put('a/notes.txt'); // attachment of a.md, not a lane
  await put('frontend/b.md');
  await put('frontend/README.md');
  await put('frontend/b/shot.png'); // attachment of frontend/b.md
  await put('frontend/notes/x.txt'); // ignored, no warning
  await put('frontend/deep/c.md'); // ignored, with a warning
  await put('images/pic.png'); // no cards: not a lane, no warning
  await put('.hidden/d.md');
  await put('backend.md');
  await put('backend/e.md'); // was a lane, now backend.md's attachments: warning
  const s = createStorage(dir);

  const { files, warnings } = await s.list();
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.md', 'backend.md', 'frontend/b.md']);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /frontend\/deep\/.*not shown/);
  assert.match(warnings.join('\n'), /backend\/ is the attachment folder of backend\.md/);

  assert.equal(await s.read('frontend/b.md'), 'x');
  await s.write('frontend/b.md', 'y');
  assert.equal(await readFile(path.join(dir, 'frontend', 'b.md'), 'utf8'), 'y');
  assert.deepEqual(await s.listAttachments('frontend/b.md'), ['shot.png']);
  assert.equal(await s.writeAttachment('frontend/b.md', 'two.png', [Buffer.from('2')]), 'two.png');
  assert.equal((await s.readAttachment('frontend/b.md', 'two.png'))?.toString(), '2');

  for (const bad of ['frontend/deep/c.md', '../x.md', '.hidden/d.md', 'frontend/../a.md', 'frontend\\b.md', '/frontend/b.md', 'frontend/', '/b.md']) {
    await assert.rejects(s.read(bad), /Invalid/, bad);
  }
});

test('move: the card and its attachment folder go together, never over anything', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-move-'));
  await mkdir(path.join(dir, 'fix-bug'));
  await mkdir(path.join(dir, 'frontend', 'taken'), { recursive: true });
  await mkdir(path.join(dir, 'backend'));
  await writeFile(path.join(dir, 'fix-bug.md'), 'card');
  await writeFile(path.join(dir, 'fix-bug', 'shot.png'), 'png');
  await writeFile(path.join(dir, 'frontend', 'other.md'), 'other');
  await writeFile(path.join(dir, 'frontend', 'taken.md'), 'mine');
  await writeFile(path.join(dir, 'backend', 'taken.md'), 'theirs');
  await writeFile(path.join(dir, 'backend', 'other.md'), 'second');
  const s = createStorage(dir);

  await s.move('fix-bug.md', 'frontend/fix-bug.md');
  assert.equal(await readFile(path.join(dir, 'frontend', 'fix-bug.md'), 'utf8'), 'card');
  assert.deepEqual(await s.listAttachments('frontend/fix-bug.md'), ['shot.png']);
  assert.deepEqual((await readdir(dir)).sort(), ['backend', 'frontend']);

  // Back to the top level, without attachments to carry.
  await s.move('frontend/other.md', 'other.md');
  assert.equal(await readFile(path.join(dir, 'other.md'), 'utf8'), 'other');

  // Refused: a card with that name, or a folder with that name, is already there.
  await assert.rejects(s.move('backend/taken.md', 'frontend/taken.md'), (e: Error & { status?: number }) => e.status === 409);
  await assert.rejects(s.move('backend/other.md', 'other.md'), (e: Error & { status?: number }) => e.status === 409);
  await writeFile(path.join(dir, 'frontend', 'taken.md.bak'), '');
  await mkdir(path.join(dir, 'frontend', 'lonely'));
  await writeFile(path.join(dir, 'backend', 'lonely.md'), 'l');
  await assert.rejects(s.move('backend/lonely.md', 'frontend/lonely.md'), /folder/);
  assert.equal(await readFile(path.join(dir, 'backend', 'taken.md'), 'utf8'), 'theirs', 'nothing moved');
  assert.equal(await readFile(path.join(dir, 'frontend', 'taken.md'), 'utf8'), 'mine', 'nothing overwritten');
  await assert.rejects(s.move('backend/taken.md', 'nowhere/taken.md'), /ENOENT|No such|not exist/i);
  await assert.rejects(s.move('backend/taken.md', '../taken.md'), /Invalid/);
});

test('pollFolder: sees lane cards and their attachments, ignores other lane files', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'markanban-poll-'));
  await mkdir(path.join(dir, 'frontend', 'b'), { recursive: true });
  await mkdir(path.join(dir, 'frontend', 'misc'));
  await writeFile(path.join(dir, 'frontend', 'b.md'), 'one');
  let changes = 0;
  const stop = pollFolder(dir, 20, () => changes++);
  t.after(stop);
  const settle = () => new Promise((r) => setTimeout(r, 80));
  await settle();
  await writeFile(path.join(dir, 'frontend', 'misc', 'x.txt'), 'x');
  await writeFile(path.join(dir, 'frontend', 'notes.txt'), 'x');
  await settle();
  assert.equal(changes, 0, 'files that are no card or attachment are ignored');
  await writeFile(path.join(dir, 'frontend', 'b.md'), 'two!');
  await settle();
  assert.ok(changes > 0, 'a lane card edit is noticed');
  const before = changes;
  await writeFile(path.join(dir, 'frontend', 'b', 'shot.png'), 'x');
  await settle();
  assert.ok(changes > before, 'a lane card attachment is noticed');
  const again = changes;
  await mkdir(path.join(dir, 'backend'));
  await writeFile(path.join(dir, 'backend', 'c.md'), 'new lane');
  await settle();
  assert.ok(changes > again, 'a new lane is noticed');
});
