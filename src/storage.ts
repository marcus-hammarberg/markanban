// The only module that touches the filesystem. Swap this for Drive/hosted storage later.
import fs from 'node:fs';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './board.ts';

export interface StoredFile { name: string; text: string; created: string; mtime: string }

export function isCardName(name: string) {
  return /\.md$/i.test(name) && !name.startsWith('.') && name.toLowerCase() !== 'readme.md';
}

export function createStorage(root: string) {
  const dir = path.resolve(root);

  // Only top-level card files and the config file are reachable. Blocks ../ and subfolders.
  const resolve = (name: string) => {
    const full = path.join(dir, name);
    if ((name !== CONFIG_FILE && !isCardName(name)) || path.dirname(full) !== dir || path.basename(full) !== name) {
      throw Object.assign(new Error(`Invalid file name: ${name}`), { status: 400 });
    }
    return full;
  };

  return {
    dir,

    /** One unreadable file never fails the listing: it is reported in `unreadable` instead. */
    async list(): Promise<{ files: StoredFile[]; unreadable: { name: string; message: string }[] }> {
      const entries = await readdir(dir, { withFileTypes: true });
      const names = entries.filter((e) => e.isFile() && isCardName(e.name)).map((e) => e.name);
      const files: StoredFile[] = [];
      const unreadable: { name: string; message: string }[] = [];
      await Promise.all(names.map(async (name) => {
        const full = path.join(dir, name);
        try {
          const [text, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
          files.push({ name, text, created: st.birthtime.toISOString(), mtime: st.mtime.toISOString() });
        } catch (e) {
          // Vanished between readdir and read (sync tool, editor save): not worth a warning.
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push({ name, message: (e as Error).message });
        }
      }));
      return { files, unreadable };
    },

    async read(name: string): Promise<string | null> {
      try {
        return await readFile(resolve(name), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    /** create: fail if the file exists. Otherwise write atomically (temp file + rename). */
    async write(name: string, text: string, opts: { create?: boolean } = {}) {
      const full = resolve(name);
      if (opts.create) return writeFile(full, text, { flag: 'wx' });
      const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
      await writeFile(tmp, text);
      await rename(tmp, full);
    },

    /** fs.watch for instant local updates, plus polling for synced folders that fire no events. */
    watch(onChange: () => void) {
      let timer: NodeJS.Timeout | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 100);
      };
      const w = fs.watch(dir, (_event, file) => {
        if (file && file.startsWith('.') && file !== CONFIG_FILE) return;
        changed();
      });
      const stopPolling = pollFolder(dir, 3000, changed);
      return () => { w.close(); stopPolling(); clearTimeout(timer); };
    },
  };
}

/**
 * Calls onChange when a card or the config file is added, removed, renamed or modified.
 * Compares name, size and mtime only, so online-only Drive files are not downloaded.
 */
export function pollFolder(dir: string, ms: number, onChange: () => void) {
  let last: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      const names = (await readdir(dir)).filter((n) => n === CONFIG_FILE || isCardName(n)).sort();
      const parts = await Promise.all(names.map(async (n) => {
        const st = await stat(path.join(dir, n)).catch(() => null); // vanished mid-look: next tick sees it
        return st ? `${n}:${st.size}:${st.mtimeMs}` : '';
      }));
      const now = parts.join('\n');
      if (last !== undefined && now !== last && !stopped) onChange();
      last = now;
    } catch {
      // Share briefly unreachable: keep the last snapshot and try again next tick.
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

export type Storage = ReturnType<typeof createStorage>;
