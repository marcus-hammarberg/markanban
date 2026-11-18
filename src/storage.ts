// The only module that touches the filesystem. Swap this for Drive/hosted storage later.
import fs from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './board.ts';

export interface StoredFile { name: string; text: string; created: string; mtime: string }

export function isCardName(name: string) {
  return /\.md$/i.test(name) && !name.startsWith('.') && name.toLowerCase() !== 'readme.md';
}

/** The folder that holds a card's attachments: `fix-bug.md` → `fix-bug`. */
const folderOf = (card: string) => card.replace(/\.md$/i, '');

/** An uploaded file's name, safe to use as one path segment: the original name minus paths and unsafe characters. */
export function attachmentName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Control characters and characters Windows (or a synced share) can't store become '-'; no hidden files.
  const clean = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '-').replace(/^[.\s]+/, '').trim();
  return clean || 'file';
}

const invalid = (name: string) => Object.assign(new Error(`Invalid file name: ${name}`), { status: 400 });

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

  // <card folder>/<file>: one level, the card must be a card name, the file a plain visible name.
  const attachmentPath = (card: string, file?: string) => {
    if (!isCardName(card) || path.basename(card) !== card) throw invalid(card);
    const folder = path.join(dir, folderOf(card));
    if (file === undefined) return folder;
    if (file.startsWith('.') || path.basename(file) !== file || /[\\/]/.test(file)) throw invalid(file);
    return path.join(folder, file);
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

    /** A card's attachments: visible files in its folder, sorted. No folder means none. */
    async listAttachments(card: string): Promise<string[]> {
      try {
        const entries = await readdir(attachmentPath(card), { withFileTypes: true });
        return entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
      } catch (e) {
        if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return [];
        throw e;
      }
    },

    async readAttachment(card: string, file: string): Promise<Buffer | null> {
      try {
        return await readFile(attachmentPath(card, file));
      } catch (e) {
        if (['ENOENT', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
        throw e;
      }
    },

    /**
     * Streams to a hidden temp file, then claims a free name (`shot.png`, `shot-2.png`, …) and renames
     * into place. Never overwrites. Returns the name used; a failed upload leaves nothing behind.
     */
    async writeAttachment(card: string, wanted: string, data: AsyncIterable<Buffer>): Promise<string> {
      const folder = attachmentPath(card);
      const name = attachmentName(wanted);
      await mkdir(folder, { recursive: true });
      const tmp = path.join(folder, `.${name}.${process.pid}.${Date.now()}.tmp`);
      try {
        const fh = await open(tmp, 'wx');
        try {
          for await (const chunk of data) await fh.write(chunk);
        } finally {
          await fh.close();
        }
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        for (let i = 1; i < 1000; i++) {
          const candidate = i > 1 ? `${stem}-${i}${ext}` : name;
          const full = path.join(folder, candidate);
          try {
            // Claim the name atomically ('wx' fails if taken), then replace our own empty claim.
            await writeFile(full, '', { flag: 'wx' });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw e;
          }
          await rename(tmp, full);
          return candidate;
        }
        throw Object.assign(new Error('Could not find a free file name'), { status: 409 });
      } finally {
        await rm(tmp, { force: true });
      }
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
 * Calls onChange when a card, an attachment or the config file is added, removed, renamed or modified.
 * Compares name, size and mtime only, so online-only Drive files are not downloaded.
 */
export function pollFolder(dir: string, ms: number, onChange: () => void) {
  let last: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      const top = (await readdir(dir)).filter((n) => n === CONFIG_FILE || isCardName(n));
      // Attachments: the visible files in each card's folder (most cards have none).
      const inFolders = await Promise.all(top.filter(isCardName).map(async (card) => {
        const folder = folderOf(card);
        const files = await readdir(path.join(dir, folder)).catch(() => [] as string[]);
        return files.filter((f) => !f.startsWith('.')).map((f) => `${folder}/${f}`);
      }));
      const names = [...top, ...inFolders.flat()].sort();
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
