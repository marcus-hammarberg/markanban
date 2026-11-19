// The only module that touches the filesystem. Swap this for Drive/hosted storage later.
import fs, { type Dirent } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from './board.ts';

export interface StoredFile { name: string; text: string; created: string; mtime: string }

function isCardName(name: string) {
  return /\.md$/i.test(name) && !name.startsWith('.') && name.toLowerCase() !== 'readme.md';
}

/** The folder that holds a card's attachments: `fix-bug.md` → `fix-bug`, `frontend/b.md` → `frontend/b`. */
const folderOf = (card: string) => card.replace(/\.md$/i, '');

const isVisibleDir = (e: Dirent) => e.isDirectory() && !e.name.startsWith('.');

/**
 * Where the cards are: top-level cards, lane cards (one folder down) and the attachment folders that exist.
 * A folder next to a same-named card holds its attachments; any other folder with cards in it is a lane.
 */
async function scan(dir: string) {
  const top = await readdir(dir, { withFileTypes: true });
  const cards = top.filter((e) => e.isFile() && isCardName(e.name)).map((e) => e.name);
  const owned = new Set(cards.map(folderOf));
  const folders: string[] = [];
  const warnings: string[] = [];
  await Promise.all(top.filter(isVisibleDir).map(async (d) => {
    const inner = await readdir(path.join(dir, d.name), { withFileTypes: true }).catch(() => [] as Dirent[]);
    const laneCards = inner.filter((e) => e.isFile() && isCardName(e.name)).map((e) => e.name);
    if (owned.has(d.name)) {
      folders.push(d.name);
      if (laneCards.length) warnings.push(`${d.name}/ is the attachment folder of ${d.name}.md, so the cards in it are not shown as a lane. Rename one of them if it should be a lane.`);
      return;
    }
    if (!laneCards.length) return; // images/, an orphan attachment folder: not a lane
    cards.push(...laneCards.map((n) => `${d.name}/${n}`));
    const laneOwned = new Set(laneCards.map(folderOf));
    await Promise.all(inner.filter(isVisibleDir).map(async (sub) => {
      if (laneOwned.has(sub.name)) return void folders.push(`${d.name}/${sub.name}`);
      const deeper = await readdir(path.join(dir, d.name, sub.name)).catch(() => [] as string[]);
      if (deeper.some(isCardName)) warnings.push(`Cards in ${d.name}/${sub.name}/ are not shown: lanes are one folder deep.`);
    }));
  }));
  return { cards, folders, warnings };
}

/** An uploaded file's name, safe to use as one path segment: the original name minus paths and unsafe characters. */
export function attachmentName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Control characters and characters Windows (or a synced share) can't store become '-'; no hidden files.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (they are stripped)
  const clean = base.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '-').replace(/^[.\s]+/, '').trim();
  return clean || 'file';
}

const invalid = (name: string) => Object.assign(new Error(`Invalid file name: ${name}`), { status: 400 });

export function createStorage(root: string) {
  const dir = path.resolve(root);

  // A card is `<card>.md` or `<lane>/<card>.md`: plain visible names, nothing deeper, no ../ or \.
  const cardPath = (name: string) => {
    const parts = name.split('/');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a path are refused on purpose
    const plain = (p: string) => p !== '' && !p.startsWith('.') && !/[\\\u0000-\u001f]/.test(p);
    if (parts.length > 2 || !parts.every(plain) || !isCardName(parts[parts.length - 1])) throw invalid(name);
    const full = path.join(dir, name);
    if (path.relative(dir, full) !== path.join(...parts)) throw invalid(name);
    return full;
  };
  const resolve = (name: string) => (name === CONFIG_FILE ? path.join(dir, name) : cardPath(name));
  const exists = (p: string) => stat(p).then(() => true, (e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  });

  // [<lane>/]<card folder>/<file>: the card must be a card path, the file a plain visible name.
  const attachmentPath = (card: string, file?: string) => {
    const folder = cardPath(card).replace(/\.md$/i, '');
    if (file === undefined) return folder;
    if (file.startsWith('.') || path.basename(file) !== file || /[\\/]/.test(file)) throw invalid(file);
    return path.join(folder, file);
  };

  return {
    dir,

    /** One unreadable file never fails the listing: it is reported in `unreadable` instead. */
    async list(): Promise<{ files: StoredFile[]; unreadable: { name: string; message: string }[]; warnings: string[] }> {
      const { cards: names, warnings } = await scan(dir);
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
      return { files, unreadable, warnings };
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
      const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
      await writeFile(tmp, text);
      await rename(tmp, full);
    },

    /**
     * Moves a card to another lane (or the top level), its attachment folder first. Refused (409) when the
     * target already has a card file or folder of that name: nothing is ever overwritten or renamed to fit.
     */
    async move(from: string, to: string) {
      const [src, dst] = [cardPath(from), cardPath(to)];
      const [srcFolder, dstFolder] = [src, dst].map((p) => p.replace(/\.md$/i, ''));
      const where = to.includes('/') ? to.split('/')[0] : 'The top level';
      const base = path.basename(dst);
      if (await exists(dst)) throw Object.assign(new Error(`${where} already has ${base}`), { status: 409 });
      if (await exists(dstFolder)) throw Object.assign(new Error(`${where} already has a folder ${path.basename(dstFolder)}`), { status: 409 });
      // ponytail: check-then-rename; a file a sync client creates at `dst` in between would be replaced. Use link+unlink if that ever shows up.
      const hasFolder = await exists(srcFolder);
      if (hasFolder) await rename(srcFolder, dstFolder);
      try {
        await rename(src, dst);
      } catch (e) {
        if (hasFolder) await rename(dstFolder, srcFolder).catch(() => {}); // keep the attachments with their card
        throw e;
      }
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
    async writeAttachment(card: string, wanted: string, data: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<string> {
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
      // Recursive, so lane folders are watched too; polling catches whatever this misses.
      const w = fs.watch(dir, { recursive: true }, (_event, file) => {
        if (file && file !== CONFIG_FILE && file.split(path.sep).some((part) => part.startsWith('.'))) return;
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
      const { cards, folders } = await scan(dir);
      // Attachments: the visible files in each card's folder (most cards have none).
      const inFolders = await Promise.all(folders.map(async (folder) => {
        const files = await readdir(path.join(dir, folder)).catch(() => [] as string[]);
        return files.filter((f) => !f.startsWith('.')).map((f) => `${folder}/${f}`);
      }));
      const names = [CONFIG_FILE, ...cards, ...inFolders.flat()].sort();
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
