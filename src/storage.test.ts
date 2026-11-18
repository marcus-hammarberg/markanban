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
