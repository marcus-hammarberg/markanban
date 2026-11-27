# Markanban — v1 Spec

A kanban board driven by a folder of markdown files. Point it at a folder and you're done.

```sh
npx markanban [folder]     # folder defaults to .
```

## Principles

- **Zero setup.** Any folder of `.md` files is a valid board. Nothing is required.
- **Files are the truth.** The tool never holds state the files don't. Hand-editing a card is always allowed.
- **Lightweight.** One runtime dependency (`yaml`). Everything else is Node 22+ built-ins.
- **Built for later.** UI talks to an HTTP API only; all file access goes through one storage module, so a hosted / Google Drive version swaps storage, not the app.
- **Dumb client.** All rules and decisions (column order, type colors, validation) live on the server in tested code; `/api/board` returns the results and the browser only displays them.
- **Config problems never break the board.** Skip only the broken part, fall back to the default, and show a clear warning in the UI that names the valid values. Unparseable `.markanban.yml` is a warning too, never silently ignored.

## Cards

A card is any `*.md` file directly in the board folder, or directly in a lane folder (see Swimlanes).

- Excluded: `README.md`, hidden files (`.*`), and folders: a folder named after a card holds its attachments (see Attachments), any other folder is a lane.
- A card is identified by its path relative to the board folder: `fix-bug.md`, or `frontend/fix-bug.md` in a lane.
- Files without front-matter are still cards.
- Sync-conflict copies (`name (1).md`, `name (conflicted copy).md`, etc.) are shown as normal cards with a ⚠️ "possible sync conflict" badge. No auto-merge.

### Example

```markdown
---
status: doing
type: bug
assignee: marcus
tags: ui, auth
created: 2026-11-16T14:03:12Z
priority: high
---
# Fix login bug

Users get logged out after 5 minutes.

## Changelog

- 2026-11-16T14:03:12Z marcus status: todo → doing
- 2026-11-16T15:20:00Z marcus assignee: (none) → marcus
- 2026-11-16T15:22:41Z marcus body: edited
```

### Fields (all optional)

| Field | Meaning |
| --- | --- |
| `heading` | Card title. Fallback chain: `heading` → first `# H1` in body → filename (`fix-login-bug.md` → "fix login bug"). |
| `status` | Column. Missing → "No status" column (renamable via config). |
| `type` | Free text. |
| `assignee` | Free text. |
| `tags` | Comma string (`ui, auth`) or YAML list (`[ui, auth]`). Read both; write back in the form already used; new cards use comma string. |
| `created` | ISO UTC timestamp. Written when the card is created via the UI. Missing → display file birthtime; the first write Markanban makes to such a card (edit, move or reorder) stamps that birthtime here, because the atomic write replaces the file and would reset it. Never logged. |
| `archived` | ISO UTC timestamp. Present = archived, absent = active. |
| `rank` | Number: the card's position in its column (lower = higher up = more important). Managed by the board, hidden on the card, never logged. See Card order. |

- **No `changed` field.** "Last changed" is displayed from file mtime.
- **Unknown fields** (e.g. `priority`, `due`) are preserved untouched — comments and key order too — and shown as read-only `key: value` chips.

### New cards (via UI)

- Filename = slug of the heading (`Fix login bug` → `fix-login-bug.md`), `-2`, `-3`… on collision.
- Filename never changes afterwards, even if the heading does.
- A heading is a single line; the API refuses line breaks (they could forge `## Changelog`).
- Heading is written as a `# H1` in the body (not front-matter). `created` is set, and the changelog starts with `card: created`.

## Changelog

The last section of the file, `## Changelog`, is a list. Newest last, append-only. Markanban-written headings (`## Comments`, `### <comment>`, `## Changelog`) always have a blank line after them (markdownlint MD022); older files are upgraded on the next write to those sections.

```text
- <ISO 8601 UTC timestamp> <who> <field>: <from> → <to>
```

- `(none)` = empty value.
- Body edits log a single line: `<ts> <who> body: edited` (no diff).
- Creating a card in the UI logs `<ts> <who> card: created` as the first line.
- Only changes made through the UI are logged. External edits are accepted silently.
- The section is hidden from the card body and shown in a "History" view instead.

**Who** = `--user` flag → `MARKANBAN_USER` env var → OS username (`os.userInfo()`). No login.

## Board / columns

Columns = distinct `status` values across **active** (non-archived) cards.

Order:

1. `columns` in `.markanban.yml`, if present
2. then the common order: `backlog, todo, ready, doing, in progress, review, done` (case-insensitive)
3. then the remaining statuses alphabetically

- A column emptied by a board action (moving or archiving its last card) stays: the server saves the current column order to `.markanban.yml` first. Columns known only from card statuses, emptied by an outside edit, still disappear unless listed in `.markanban.yml`.
- The user can reorder columns by drag → writes `.markanban.yml`.
- A "+ column" input allows moving a card to a new status.

### `.markanban.yml`

Lives in the board folder. Created lazily: on the first column reorder or added column, or when a board action would otherwise make a column disappear.

```yaml
columns: [backlog, todo, doing, review, done]
noStatusColumn: Inbox     # default: "No status"
types:                    # optional: type → color, see Type colors
  incident: orange
wip:                      # optional: column → WIP limit, see WIP limits
  doing: 3
```

## UI (v1)

Actions:

- Move cards between columns (drag & drop)
- Create card
- Edit front-matter fields (known fields; unknown are read-only)
- Edit body (plain markdown textarea)
- Archive / unarchive
- "Show archived" toggle (archived cards greyed out; they never create columns)
- History view per card
- Attachments: upload by button, drop or paste; listed in the card dialog (see Attachments)
- Link to a card: 🔗 in the card dialog copies its link (see Card links)
- Ctrl/⌘+Enter in the card dialog saves the card (in the comment box it adds the comment instead)

**No delete** in v1. Remove the file yourself.

### Comments

Stored in the card file as a `## Comments` section between the body and `## Changelog`:

```markdown

## Comments

### 2026-11-17T09:12:00Z marcus

Session timeout is 5 minutes.
Checked in staging.

## Changelog

- 2026-11-17T09:12:00Z marcus comment: added
```

- One `### <ISO UTC> <who>` heading per comment, oldest first; text is markdown and may be multi-line.
- Headings (`#`–`###`) inside a comment are demoted to `####` so they can't end the comment or section.
- Add-only in the UI; edit or delete by editing the file. Each add logs `comment: added` in the changelog.
- Hidden from the body textarea; shown in a "Comments (n)" section that is collapsed by default, like History (both collapse again whenever a card is opened), with a list and an "Add comment" box (⌘/Ctrl+Enter submits). Cards show a 💬 count. Search includes comment text.

### Card links

Every card has a link, so it can be pasted into chat, a ticket or a note. Client-side only: no server or API change.

- Format: `http://localhost:<port>/#card=<card path>`, URL-encoded (`#card=fix-login-bug.md`, `#card=frontend%2Ffix-login-bug.md`). The file name never changes, so the link is stable; after a lane move it still opens the card by file name (see Swimlanes). The host and port are the sender's own; a team that shares a board should agree on a port.
- The address bar follows the dialog: opening a card (click, Enter or link) sets the hash, closing it clears the hash. Back/Forward therefore open and close cards.
- Arriving on a link opens the card once the board has loaded, and again on every hash change.
- Archived cards open even when "Show archived" is off; filters never affect the dialog.
- A link to a card that doesn't exist shows "No card `<name>`" in the error banner and clears the hash. It is checked on load and on hash change, not on live updates, so the dialog can't reopen after being closed.
- Changing the link while the dialog is open switches cards without asking, like Esc, which also drops unsaved edits.
- The 🔗 button sits in the dialog header, left of ✕, and copies the full URL. It shows "✓ Copied" for about 1.5 s. If the clipboard is refused, the link is shown in the error banner instead. Board cards carry no link icon.
- A failed save reopens the dialog with the typed values and restores the hash.
- Not in v1: links between cards, port-independent links.

### Filters

A row above the board: free-text search (heading, body, comments, attachment names), and selects for type, assignee and tag, each with a "No …" option. Options are built from the current cards. Filters combine, apply to archived cards too, are client-side only, and reset on reload.

### Column reordering

Drag a column by its header (⠿ grip) and drop it on either half of another column, or use the ‹ › buttons shown on hover/focus. The order is saved to `.markanban.yml`. "No status" is always first.

### WIP limits

A column can have a work-in-progress limit. It is a board-level fact, so it lives in `.markanban.yml` (card statuses stay plain, e.g. `doing`), set by hand only:

```yaml
wip:
  doing: 3
  review: 2
```

- The key is the column name as shown on the board, matched ignoring case and surrounding spaces. That includes the "No status" column under its `noStatusColumn` name. Archived is not a status and has no limit. If two statuses differ only in case, each gets the limit on its own.
- One limit per column, counting the active cards in it across all lanes. Archived cards never count. Filters don't change the count: the limit is about the team's system, not one person's view.
- The value must be a whole number ≥ 1. Anything else (`0`, `-1`, `2.5`, `three`, empty) skips that entry with a warning; to remove a limit, remove the line. A `wip` that isn't a map is skipped with a warning. Names that match no current column are ignored silently (an emptied column isn't a typo).
- Header of a limited column: `count / limit` (e.g. `3 / 3`), always the unfiltered count. Columns without a limit keep showing the filtered count.
- At the limit is the goal, so it looks normal. Over the limit (`4 / 3`), the whole column (header and every lane cell) gets the `--wip-over` theme tint and the header shows ⚠ (U+26A0, text, not emoji) with the label "over WIP limit" (tooltip and screen readers), so color is never the only signal.
- Limits never block: moves into a full column always go through, and hand edits can push a column over anyway. The warning is the signal; acting on it is the team's call.
- `/api/board` returns `limit` (number or `null`) and `count` on each column; the browser only shows them.
- Replay shows the limits too, with the count of replayed cards at that moment (all cards, ignoring the filter), tinting the column whenever it went over: a signal for retrospectives. It uses today's limits, because config changes aren't logged.

### Live updates & safe writes

- Server watches the folder (`fs.watch`) and pushes changes to the browser via Server-Sent Events.
- It also polls every 3 seconds (card, attachment and config file names, sizes and mtimes; no contents), because synced folders (Drive for desktop, SMB shares) often fire no file events for remote changes. Always on, no flag. A failed poll (share briefly unreachable) is skipped, never an error.
- A card file that can't be read (permissions, etc.) is left out of the board with a warning; it never fails the whole board. A file that vanishes mid-listing is skipped silently.
- Every write re-reads the file from disk and applies only the targeted change (one field, or append one changelog line). Never write back a stale full copy.

### Theming

- Every color, font, radius, border and shadow is a CSS custom property on `:root`. No hard-coded colors in components.
- A theme = one CSS file, activated by `<html data-theme="…">`. Themes may override any rule, not just variables (so a hand-drawn theme can change fonts, borders, rotation, filters).
- Ships **light**, **dark** and **whiteboard**. Default follows the OS (`prefers-color-scheme`, light or dark). Header dropdown: System, Light, Dark, Whiteboard; a manual choice is saved in `localStorage`.
- **Whiteboard** (`themes/whiteboard.css`, CSS only): an aluminium-framed whiteboard with a marker tray, column headers and dividers drawn in marker, cards as slightly tilted sticky notes whose color is the type color (no type = canary yellow), type underlined and tags written as `#tag`. Fonts: Permanent Marker (headings, Apache 2.0) and Covered By Your Grace (notes, OFL), bundled in `public/fonts/` with their licences and served by Markanban, so nothing is fetched from the internet; OS handwriting fonts are the fallback. The card dialog keeps the normal light look.

### Card order (priority)

Order within a column is a priority signal: the top card is the most important. Each card carries its own position as `rank` in its front-matter, so a move only touches that card's file (no shared file to conflict on when the folder is synced).

- Sort: ranked cards by `rank` ascending, then unranked cards oldest first (`created`). New cards from **+** get no rank, so they land at the bottom.
- Placing a card gives it the number halfway between its neighbours (ranks start at 1000 and step by 1000). Unranked cards above the drop point get a rank first; cards below are left alone. When a gap gets too small (< 0.001), that one column is renumbered in steps of 1000.
- Moving to another column is one write: `status` (logged) and `rank` (not logged). Rank changes and renumbering are never logged.
- The browser only sends the intent, `place: { before: <card name> | null }` (null = bottom) on `PATCH /api/cards/:name`; the server computes ranks and returns cards in order.
- With a filter on, a card dropped above a visible card lands directly above that card.
- Keyboard: cards are focusable (Tab). Enter opens; Alt+↑/↓ moves within the column; Alt+←/→ moves to the bottom of the neighbouring column. Focus stays on the card.
- A hand-written rank that isn't a number is treated as unranked and shows ⚠️ on the card; the next move that places it fixes it.
- Archived cards keep their rank, so unarchiving puts them back where they were.

### Type colors

Cards are color-coded by `type`: a 4px stripe on the left edge plus a tinted type chip. The type is always shown as text too, and there is no legend.

- Palette (names, not hex): `red, orange, yellow, green, teal, blue, purple, pink, grey`. Each theme defines its own shade as `--type-<name>`, so colors fit light/dark (and future themes). Red and green also differ in lightness.
- Built-in defaults (no config needed):

  | Color | Types |
  | --- | --- |
  | red | bug, defect, incident |
  | orange | epic |
  | yellow | spike, research |
  | green | feature, story |
  | blue | improvement, enhancement |
  | teal | docs, documentation |
  | purple | design |
  | grey | task, chore |

- Any other type: uncolored chip. No type: no stripe.
- Override or extend in `.markanban.yml`; config wins over the built-in list:

  ```yaml
  types:
    incident: orange
    ops: pink
  ```

- Matching ignores case and surrounding spaces; otherwise exact (no plurals, no fuzzy matching).
- Colors are changed only via config or defaults, never in the UI.
- An unknown color name skips that entry (falls back to the built-in color, if any) and shows a warning listing the valid colors.

### Replay

A separate, read-only mode that plays back how cards moved across the board over time.

**Modes**

- Normal board: unchanged, plus one "▶ Replay" button in the header. No replay controls are visible.
- Replay mode: entered via that button. Board is read-only (no drag, no `+` buttons, no "+ Column", no card dialog, no "Show archived"; `#card=` links are ignored), live file updates are held until exit. The filter row stays, so you can replay a subset (e.g. one assignee). A control bar appears: play/pause, timeline slider, replayed date/time clock, Exit.
- Replay mode is unmistakable: the control bar starts with "● Replay · read-only" and is accent-tinted, the board gets an accent tint and frame, cards show a not-allowed cursor and a "Read-only during replay" tooltip, and pressing a card makes the Exit button pulse.
- Exit returns to the live board (loading any held updates) and removes the control bar.

**Playback**

- Starts at the beginning and plays at a fixed **8 hours per second**. No speed selector: drag the timeline slider to go faster, slower or backwards. Stops at the end; Play again restarts from the beginning.
- The timeline runs from the earliest event to the moment the board was loaded.

**Data (no extra file reads, no file changes)**

- The server builds the timeline from the changelogs it already reads (`replay()` in `src/board.ts`, tested) and returns it as `replay` in `/api/board`: `{ start, end, columns, steps }`. `steps[<file name>]` is a list of `{ at, status, archived }` (`at` in ms), each in force from `at` until the next. The browser only plays it back.
- A card appears at its earliest known time: `card: created` line → `created` field → file birthtime (or its first logged change, if earlier).
- Its starting column is the `from` of its first status change, else its current status.
- `archived` hides it; unarchive brings it back.
- Lines with an unreadable timestamp are skipped; out-of-order lines are sorted by time.
- Other field changes are not replayed; cards show their current heading and fields.

**Board**

- `columns` lists every status the timeline uses, plus the current columns, ordered by the normal column rules ("No status" first). Current columns always show; statuses no longer in use appear only while they hold cards.
- Only active cards are shown; archived ones are hidden.
- Moving cards slide between columns (Web Animations API, no dependency). New cards fade in, archived fade out. A new change restarts animations from wherever the cards are, so they never lag the clock. No animation when the OS asks for reduced motion.

**Card order**

- Ranks aren't logged, so order changes can't be replayed; cards in a replayed column are shown in their current order.

**Demo board**

- `npm run demo [folder]` (`src/demo.ts`, default `demo-board`) writes a board telling how Markanban was built: the real commit order, stretched over three weeks and dated back from today so the story ends just now. Cards sit in three lane folders (`1 Cards & files`, `2 Board`, `3 Sharing & release`) with the newest at the top level, and one card has a logged lane move. `.markanban.yml` sets WIP limits (doing 2, review 1); the story goes over each once, for long enough to see in Replay (about a day of board time, a few seconds of playback), with a comment saying why, and is within the limits at the end. Cards are written with `newCard`/`applyChange`, exactly as the UI would. Refuses a folder that isn't new or empty; never overwrites. A dev script, not part of the CLI.

**Known gap (accepted)**

- Edits made outside the UI aren't in the changelog, so such a card jumps to its current state at the end. Replay is only as complete as the changelog.

### Swimlanes

Lanes are horizontal rows that share one set of columns. A lane is a folder in the board folder; there is no config.

**Which folders are lanes**

- A visible folder `X/` directly in the board folder is a lane, unless `X.md` sits next to it (then it is that card's attachment folder). Lane cards are the `*.md` files directly in it, with the same rules as top-level cards; a lane card's attachments are in `X/<card>/`.
- A folder is a lane only while it holds at least one card file (archived ones count). Folders without cards (`images/`, orphan attachment folders) are not shown and give no warning.
- One level only. A folder inside a lane that isn't a lane card's attachment folder is ignored; if it holds `*.md` files, a warning says they are not shown.
- A hand-made `X.md` next to a lane folder `X/` that holds cards turns that folder into its attachment folder; a warning names both. New cards from the UI never take a name whose folder already holds files (`frontend-2.md`).

**Board**

- No lanes: the board looks exactly as before.
- With lanes, top-level cards form the first lane, without a header, shown only when it has active cards. Named lanes follow in natural, case-insensitive name order (`lane 2` before `lane 10`); the label is the folder name as written. Order them with a prefix such as `1 Frontend`.
- Column headers show once, at the top. Each named lane has a full-width header with its name and active card count. Archived cards share one Archived column.
- Clicking a lane header (a button, so Tab and Enter work too) collapses the lane to its header, with a "3 cards" note in each column. Clicking again opens it. Collapsed lanes are a per-person view setting kept in the browser (`localStorage`, per board folder name), never in the board folder; they stay collapsed in Replay. A card dropped on a collapsed lane goes to the bottom of that column; Alt+↑/↓ skips collapsed lanes. The top-level lane has no header and can't collapse.
- Lanes always show while filtering, even when empty. There is no lane filter, and search doesn't match lane names.
- `/api/board` returns `lanes` (named lanes in order, with `null` first when top-level cards are shown) and each card's `lane` (folder name or `null`).

**Moving between lanes**

- Lanes are created and removed in the file system only. The UI moves cards between lanes that exist.
- Dragging a card into another lane's cell moves it there (and to that column). The keyboard moves within the card's lane cell; Alt+↓ on the bottom card of a cell moves it to the top of the same column in the next lane, Alt+↑ on the top card to the bottom of the previous lane (the top-level lane counts as the first), so the opposite key undoes it.
- A move renames the card file into the target folder and moves its attachment folder with it (folder first; if the card can't follow, the folder is moved back). It is logged as `lane: (none) → frontend`. The browser sends `lane: <name> | null` on `PATCH /api/cards/:name`; the server checks the lane exists.
- A move is refused when the target already has a card file or a folder with that name ("frontend already has fix-bug.md"). Names never change to make room.
- A card link to a path that no longer exists opens the card if exactly one card has that file name, so links survive lane moves.
- New cards from "+" are created at the top level.
- Replay shows every card in its current lane; lane moves are not replayed.

### Attachments

Every file in a sibling folder named after the card file is an attachment: `fix-login-bug.md` → `fix-login-bug/`. The folder is the truth, so files dropped in by hand count too. Card filenames never change, so the link can't break, and a relative body link (`fix-login-bug/shot.png`) works in any markdown viewer.

**Dialog**

- An "Attachments (n)" section below the body, above Comments. Collapsed by default, like Comments and History; opens after an upload.
- One link per file, filename only, opening in a new tab. No previews, no sizes.
- Hidden while creating a card (no file yet, so no folder name).
- Cards show a 📎 count. Search matches attachment filenames.

**Upload**

- An "Add file" button (native file input), dropping a file anywhere on the dialog, or pasting when the clipboard holds a file (pasting text still works as before).
- The folder is created on the first upload. The original name is kept; on collision `-2`, `-3`… (the same logic as new card filenames). Never overwrites. Names are sanitized: no path, no leading `.`, no control characters.
- Raw request body with a required `X-Markanban: 1` header (the CSRF guard for uploads: a cross-site page can't send it without a CORS preflight, which is never answered). Max 50 MB. Streamed to a temp file, then renamed into place.
- Logs `attachment: added <name>` in the changelog. The file is saved first; if the log line fails, the upload stays and a warning is shown. Files added by hand are not logged. Replay ignores these lines.

**Serving**

- Only png, jpg, gif and webp are shown inline; everything else is sent as `Content-Disposition: attachment`. Every response has `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so an `.html` or `.svg` attachment can't run script against the API.
- `GET /api/cards/<card>/attachments/<file>` serves a file; `POST /api/cards/<card>/attachments?name=<file name>` uploads one and returns `{ name }` (plus `warning` if the log line failed).
- Paths are `[<lane>/]<card>/<file>` only: no `..`, no hidden files. Checked in `storage.ts`.

**Live updates and storage**

- The 3-second poll also checks each card folder and each lane folder (names, sizes, mtimes; no contents).
- `storage.ts` gets `listAttachments`, `readAttachment` and `writeAttachment`, so a Drive/hosted backend still replaces one module.

**Edge cases (accepted)**

- Archiving leaves the folder alone. A card file renamed or deleted by hand leaves an orphan folder, which is ignored and never touched. A sync-conflict copy (`name (1).md`) has no attachments of its own.

**Not included**

- Removing attachments in the UI (remove the file yourself), previews or thumbnails, inserting links into the body.

## Tech

- TypeScript on Node 22+, published as compiled JS (runs via `npx`).
- Runtime dependency: `yaml` (Document API, preserves comments/order). Dev: `typescript`.
- Server: `node:http`, `fs.watch` + polling, SSE. Frontend: plain HTML/CSS/JS, native drag & drop, no framework.
- Storage module with exactly eight operations: `list`, `read`, `write`, `move`, `watch`, and `listAttachments`, `readAttachment`, `writeAttachment`. No other abstraction.
- Security: bind to `127.0.0.1` only. All file paths resolved and verified to be inside the board folder (no `../` escape). JSON writes require `application/json`, uploads require the `X-Markanban: 1` header (both force a CORS preflight, which is never answered). Attachments are served with `nosniff` and `CSP: sandbox`; only safe image types inline.
- Preserve line endings (CRLF on Windows). macOS primary; Linux/Windows should work via Node.

## Shared folders

Sharing a board = putting the folder in a sync client's folder (Google Drive for desktop, Dropbox, OneDrive) or on a network share; each person runs Markanban locally. The folder is a CLI path, never a cloud URL; no cloud API, OAuth or extra dependency.

- Other people's changes arrive via the 3-second poll above.
- Two people editing the same card within the sync delay is resolved by the sync client, not Markanban: some create a conflict copy (shown with ⚠️), Google Drive keeps the newest file and the other version is in Drive's version history. Accepted and documented; no locks.

## Known edge cases

- **User headings named like our sections.** Sections are found by the last `## Changelog` and the last `## Comments` before it, and headings inside comments are demoted to `####`, so comments can't break sections. But if a card body uses `## Comments` or `## Changelog` as its own heading and the card has no such section yet, Markanban reads that text as its section. Impact: a misread card, never data loss (the body is never rewritten by section logic). `---` dividers would not help (ambiguous with thematic breaks, setext headings and front-matter). If this shows up in practice: write an invisible marker such as `<!-- markanban:comments -->` above our headings and upgrade existing files on write.

## Deferred (not v1)

- Swimlanes: different statuses per lane; a "Lane" field in the card dialog that can create a lane; a "+ lane" drop zone; "+" per lane cell; reordering lanes in the UI; replaying lane moves
- Hosted version
- Logging external edits
- LAN access flag
- Delete cards
- Board-level default theme in `.markanban.yml`
- `.markanban.yml` in the run folder pointing at a board folder
- Editing unknown fields in the UI
- WIP limits: setting a limit in the UI; per-lane limits
- Blocker marker on a card (e.g. a `blocked` field holding the reason), shown prominently on the board

## Browser build (tried and rejected, 2026-11)

We spiked a version that runs without `npx`: a hosted page, an installable PWA and a single `markanban.html`, for Chrome and Edge, reading the board folder through the File System Access API. We also considered an Electron wrapper for the same goal. We dropped both. This note is here so nobody tries again without new reasons. The spike's code is in `git stash` as "browser-build spike (rejected, see SPEC.md)".

What the spike had:

- `src/core.ts`: the API taken out of `server.ts` (`createApi(storage).handle(request)`), so the same routes could answer a page's `fetch()`.
- `src/layout.ts`: lane, attachment and card-name rules taken out of `storage.ts`, so Node and the browser shared them.
- `web/`: a shell (folder picker, IndexedDB registry of folder handles, permission prompts, and a shim that answered `fetch('/api/…')` and stood in for `EventSource`), a browser storage over directory handles, and an esbuild build that produced a static site and one inline HTML file.
- A board `id:` in `.markanban.yml`, created when a link was copied, so a link could find the same folder on another computer through the registry.
- A scenario that ran the same API steps against Node storage and browser storage and compared the bytes. It passed, also from `file://`.

Why we backed out:

- **Not everything is a file any more.** The list of opened folders, and the permission to open them, lived in browser storage (IndexedDB handles) tied to one origin. Changing the URL would lose everyone's saved boards. Links needed a new `id:` written into the user's config. Markanban's only state should be the folder.
- **Too much machinery for the gain.** A second storage implementation, a transport shim, a build step and bundler (esbuild), a hosting origin to choose and keep, a service worker, and CI to publish it all. The runtime is meant to be Node built-ins plus `yaml`.
- **A weaker product in places.** Chrome and Edge only. No file events, so a 3 s poll. Moves aren't atomic without native `move()`. Chrome refuses some top-level folders. Permission prompts come back after a restart.
- **A bigger trust boundary.** Whoever can change the hosted page can read and write every folder a person has granted it. With `npx`, the code runs locally from a package the person chose to run.
- Electron avoids the browser limits, but it ships a whole browser runtime, needs signing and auto-update, and is heavier than everything above.

`npx markanban` stays the only way to run Markanban. Two parts could come back on their own if they prove useful: a transport-free API module taken out of `server.ts` (if a second backend ever appears behind the storage seam), and board ids in links (if links between computers become a real need).
