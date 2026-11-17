import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pollFolder } from './storage.ts';

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
