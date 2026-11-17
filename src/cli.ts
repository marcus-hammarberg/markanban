#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createStorage } from './storage.ts';
import { createServer } from './server.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '4242' },
    user: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: markanban [folder] [--port 4242] [--user name] [--no-open]

  folder      Folder of markdown cards, created if missing (default: current folder)
  --user      Name written in changelogs (default: $MARKANBAN_USER, then OS user)`);
  process.exit(0);
}

const folder = positionals[0] ?? '.';
const existing = statSync(folder, { throwIfNoEntry: false });
if (!existing) {
  // Zero setup: a new board is just a new folder. Say so, so a typo doesn't go unnoticed.
  try {
    mkdirSync(folder, { recursive: true });
    console.log(`Created new board folder: ${folder}`);
  } catch (e) {
    console.error(`Could not create folder ${folder}: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (!existing.isDirectory()) {
  console.error(`Not a folder: ${folder}`);
  process.exit(1);
}

const osUser = () => { try { return os.userInfo().username; } catch { return 'unknown'; } };
// One token, so changelog lines stay "<ts> <who> <field>: …".
const user = (values.user || process.env.MARKANBAN_USER || osUser()).trim().replace(/\s+/g, '_');

const port = Number(values.port);
const storage = createStorage(folder);
const server = createServer(storage, user);

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Try --port ${port + 1}` : e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Markanban: ${storage.dir}\n  ${url}  (as ${user})`);
  if (!values['no-open']) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
