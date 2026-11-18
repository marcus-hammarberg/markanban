// Demo board: the story of how Markanban was built, as cards whose changelogs Replay can play.
// The real commit order, stretched over three weeks and dated back from today so the story
// always ends just now. Cards are written with newCard/applyChange, exactly like the UI does.
//
//   npm run demo [folder]      # folder defaults to demo-board; must be new or empty
import { mkdirSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applyChange, newCard, slug, type Change } from './card.ts';
import { CONFIG_FILE } from './board.ts';
import { createStorage } from './storage.ts';

const DAY = 86_400_000;
const SPAN = 21; // days the story covers

type Step = [day: number, who: string, change: Change];
interface Story { heading: string; day: number; who: string; status: string; fields?: Record<string, string>; body?: string; steps?: Step[] }

const to = (status: string): Change => ({ fields: { status } });
const say = (comment: string): Change => ({ comment });
// The usual path: picked up, built, reviewed, done. Days are offsets into the story.
const flow = (doing: number, review: number, done: number, extra: Step[] = []): Step[] => [
  [doing, 'claude', to('doing')], [review, 'claude', to('review')], ...extra, [done, 'marcus', to('done')],
];

const STORIES: Story[] = [
  {
    heading: 'A board from a folder of markdown files', day: 0, who: 'marcus', status: 'todo',
    fields: { type: 'epic', assignee: 'claude', tags: 'core' },
    body: 'Point it at a folder and you are done. Each `.md` file is a card, `status` is the column.\n\nFiles are the truth: hand-editing a card is always allowed. One runtime dependency (`yaml`).',
    steps: flow(0.2, 1.6, 2.1, [[1.9, 'marcus', say('Tried it on my notes folder. It just worked, no setup at all.')]]),
  },
  {
    heading: 'Comments on cards', day: 0.5, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', assignee: 'claude', tags: 'cards' },
    body: 'Stored in the card file itself, as a `## Comments` section above the changelog.',
    steps: [[2.2, 'marcus', to('todo')], ...flow(2.4, 3.1, 3.6)],
  },
  {
    heading: 'Log "card: created"', day: 2.5, who: 'claude', status: 'todo',
    fields: { type: 'task', assignee: 'claude', tags: 'history' },
    body: 'The first changelog line of a card made in the UI. Replay will need it to know when a card appeared.',
    steps: flow(3.7, 3.9, 4.2),
  },
  {
    heading: 'Replay mode', day: 3, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', tags: 'replay' },
    body: 'Play back how cards moved across the board over time, rebuilt from the changelogs. Read-only, 8 hours per second.',
    steps: [
      [3.3, 'marcus', say('Spec written and decided. Not building it yet: the changelogs need to be complete first.')],
      [18.2, 'marcus', to('todo')],
      [18.3, 'marcus', { fields: { assignee: 'claude' } }],
      ...flow(18.5, 20.2, 20.6, [[19.4, 'claude', say('Moved the timeline building to the server, where it can be tested. The browser only plays it back.')]]),
    ],
  },
  {
    heading: 'Lint-clean headings (MD022)', day: 4, who: 'marcus', status: 'todo',
    fields: { type: 'chore', assignee: 'claude', tags: 'files' },
    body: 'Headings Markanban writes get a blank line after them, so card files pass markdownlint.',
    steps: flow(4.3, 4.5, 4.8),
  },
  {
    heading: 'Color cards by type', day: 5, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', assignee: 'claude', tags: 'ui' },
    body: 'Bugs red, features green, docs teal. Override in `.markanban.yml`; an unknown color is a warning, never a broken board.',
    steps: [[6.8, 'marcus', to('todo')], ...flow(7, 7.6, 8)],
  },
  {
    heading: 'Save with Ctrl/⌘+Enter', day: 7.2, who: 'marcus', status: 'todo',
    fields: { type: 'improvement', assignee: 'claude', tags: 'ui' },
    steps: flow(8.1, 8.2, 8.4),
  },
  {
    heading: 'README, license and npx install', day: 6, who: 'marcus', status: 'backlog',
    fields: { type: 'docs', assignee: 'claude', tags: 'release' },
    body: '`npx github:marcus-hammarberg/markanban` should just work: build `dist/` on install.',
    steps: [[8.3, 'marcus', to('todo')], ...flow(8.5, 9.2, 9.8, [
      [9.4, 'marcus', say('The quick start still points at a placeholder path.')],
      [9.5, 'claude', to('doing')], [9.7, 'claude', to('review')],
    ])],
  },
  {
    heading: 'Empty warning bar shows up', day: 9.9, who: 'marcus', status: 'todo',
    fields: { type: 'bug', assignee: 'claude', tags: 'ui' },
    body: 'A thin red line sits above the board even when there is nothing to warn about.',
    steps: flow(10.1, 10.3, 10.5),
  },
  {
    heading: 'Create the board folder if missing', day: 10.2, who: 'claude', status: 'todo',
    fields: { type: 'improvement', assignee: 'claude', tags: 'cli' },
    body: 'Zero setup: a new board is just a new folder. Say so, so a typo does not go unnoticed.',
    steps: flow(10.6, 11, 11.2),
  },
  {
    heading: 'Column vanishes when its last card moves', day: 11.5, who: 'marcus', status: 'todo',
    fields: { type: 'bug', assignee: 'claude', tags: 'columns' },
    body: 'Moved the last card out of "review" and the column was gone.',
    steps: flow(12, 12.6, 13, [[12.8, 'marcus', say('Fixed: the column order is saved to `.markanban.yml` first.')]]),
  },
  {
    heading: 'Card order is priority', day: 9, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', assignee: 'claude', tags: 'cards' },
    body: 'Top card matters most. Each card keeps its own `rank`, so a move only touches that one file (no shared file to conflict on).',
    steps: [[13.1, 'marcus', to('todo')], ...flow(13.3, 14.4, 15)],
  },
  {
    heading: 'Saving a heading corrupts the card', day: 14.6, who: 'marcus', status: 'todo',
    fields: { type: 'bug', assignee: 'claude', tags: 'files' },
    body: 'A heading with `$&` in it came back mangled. Also: the atomic write resets the file birthtime.',
    steps: flow(14.7, 15.1, 15.3, [[15.2, 'claude', say('Pass a function to `String.replace`, and keep `created` in the file. Tests added for both.')]]),
  },
  {
    heading: 'Links to cards', day: 12, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', assignee: 'claude', tags: 'ui' },
    body: '`#card=<file name>` opens the card. The file name never changes, so the link is stable.',
    steps: [[15.4, 'marcus', to('todo')], ...flow(15.6, 16.3, 16.6)],
  },
  {
    heading: 'Collapse comments by default', day: 16.4, who: 'marcus', status: 'todo',
    fields: { type: 'improvement', assignee: 'claude', tags: 'ui' },
    steps: flow(16.7, 16.9, 17),
  },
  {
    heading: 'Shared folders update live', day: 15, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', assignee: 'claude', tags: 'sharing' },
    body: 'Drive for desktop fires no file events for remote changes. Poll every 3 seconds: names, sizes, mtimes, never contents.',
    steps: [[16.8, 'marcus', to('todo')], ...flow(17.1, 17.8, 18)],
  },
  {
    heading: 'Use a drag & drop library', day: 1, who: 'claude', status: 'backlog',
    fields: { type: 'spike', tags: 'ui' },
    steps: [
      [1.2, 'marcus', say('Native drag & drop is enough. One dependency is the rule.')],
      [1.3, 'marcus', { archive: true }],
    ],
  },
  {
    heading: 'Delete cards', day: 4.5, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', tags: 'cards' },
    steps: [
      [5.5, 'marcus', say('Not in v1. Remove the file yourself; archive covers the rest.')],
      [5.6, 'marcus', { archive: true }],
    ],
  },
  { heading: 'Swimlanes from subfolders', day: 6.5, who: 'marcus', status: 'backlog', fields: { type: 'feature', tags: 'columns' } },
  {
    heading: 'Render markdown in cards', day: 8.6, who: 'marcus', status: 'backlog',
    fields: { type: 'feature', tags: 'cards' },
    body: 'Card text and comments are plain text for now. Without adding a dependency.',
    steps: [[19, 'marcus', to('todo')]],
  },
  { heading: 'Hosted version', day: 11, who: 'marcus', status: 'backlog', fields: { type: 'epic', tags: 'sharing' }, body: 'Swap the storage module for Drive or a server. Nothing else should change.' },
  {
    heading: 'A demo board that tells this story', day: 20.7, who: 'marcus', status: 'todo',
    fields: { type: 'docs', assignee: 'claude', tags: 'replay' },
    steps: [[20.8, 'claude', to('doing')], [20.9, 'claude', say('You are looking at it. Press ▶ Replay.')]],
  },
];

/** The demo board's files (name → text), dated so the story ends just before `now` (ms). */
export function demoBoard(now: number): Map<string, string> {
  const start = now - SPAN * DAY;
  const at = (day: number) => new Date(start + day * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
  const files = new Map<string, string>([[CONFIG_FILE, 'columns: [backlog, todo, doing, review, done]\n']]);
  for (const s of STORIES) {
    let text = newCard(s.heading, s.status, s.who, at(s.day));
    if (s.fields || s.body) text = applyChange(text, { fields: s.fields, body: s.body && `# ${s.heading}\n\n${s.body}` }, s.who, at(s.day));
    for (const [day, who, change] of s.steps ?? []) text = applyChange(text, change, who, at(day));
    files.set(`${slug(s.heading)}.md`, text);
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const folder = process.argv[2] ?? 'demo-board';
  mkdirSync(folder, { recursive: true });
  if (readdirSync(folder).length) {
    console.error(`${folder} is not empty. The demo board needs a new or empty folder.`);
    process.exit(1);
  }
  const storage = createStorage(folder);
  for (const [name, text] of demoBoard(Date.now())) await storage.write(name, text, { create: true });
  console.log(`Demo board written to ${folder}. Open it with:\n  npm start -- ${folder}\nthen press ▶ Replay.`);
}
