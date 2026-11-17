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

    watch(onChange: () => void) {
      let timer: NodeJS.Timeout | undefined;
      // ponytail: fs.watch is unreliable on network shares; add polling when shares are supported.
      const w = fs.watch(dir, (_event, file) => {
        if (file && file.startsWith('.') && file !== CONFIG_FILE) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 100);
      });
      return () => w.close();
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
