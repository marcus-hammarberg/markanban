---
rank: 1000
created: 2026-11-17T08:14:24Z
---
# Markanban — v1 Spec

A kanban board driven by a folder of markdown files. Point it at a folder and you're done.

```
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

A card is any `*.md` file directly in the board folder.

- Excluded: `README.md`, hidden files (`.*`), subfolders.
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
|---|---|
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

```
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

- Format: `http://localhost:<port>/#card=<file name>`, name URL-encoded (`#card=fix-login-bug.md`). The file name never changes, so the link is stable. The host and port are the sender's own; a team that shares a board should agree on a port.
- The address bar follows the dialog: opening a card (click, Enter or link) sets the hash, closing it clears the hash. Back/Forward therefore open and close cards.
- Arriving on a link opens the card once the board has loaded, and again on every hash change.
- Archived cards open even when "Show archived" is off; filters never affect the dialog.
- A link to a card that doesn't exist shows "No card <name>" in the error banner and clears the hash. It is checked on load and on hash change, not on live updates, so the dialog can't reopen after being closed.
- Changing the link while the dialog is open switches cards without asking, like Esc, which also drops unsaved edits.
- The 🔗 button sits in the dialog header, left of ✕, and copies the full URL. It shows "✓ Copied" for about 1.5 s. If the clipboard is refused, the link is shown in the error banner instead. Board cards carry no link icon.
- A failed save reopens the dialog with the typed values and restores the hash.
- Not in v1: links between cards, port-independent links.

### Filters

A row above the board: free-text search (heading + body), and selects for type, assignee and tag, each with a "No …" option. Options are built from the current cards. Filters combine, apply to archived cards too, are client-side only, and reset on reload.

### Column reordering

Drag a column by its header (⠿ grip) and drop it on either half of another column, or use the ‹ › buttons shown on hover/focus. The order is saved to `.markanban.yml`. "No status" is always first.

### Live updates & safe writes

- Server watches the folder (`fs.watch`) and pushes changes to the browser via Server-Sent Events.
- A card file that can't be read (permissions, etc.) is left out of the board with a warning; it never fails the whole board. A file that vanishes mid-listing is skipped silently.
- Every write re-reads the file from disk and applies only the targeted change (one field, or append one changelog line). Never write back a stale full copy.

### Theming

- Every color, font, radius, border and shadow is a CSS custom property on `:root`. No hard-coded colors in components.
- A theme = one CSS file, activated by `<html data-theme="…">`. Themes may override any rule, not just variables (so a hand-drawn theme can change fonts, borders, rotation, filters).
- v1 ships **light** and **dark**. Default follows the OS (`prefers-color-scheme`). Header toggle: System → Light → Dark; a manual choice is saved in `localStorage`.

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
  |---|---|
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

## Tech

- TypeScript on Node 22+, published as compiled JS (runs via `npx`).
- Runtime dependency: `yaml` (Document API, preserves comments/order). Dev: `typescript`.
- Server: `node:http`, `fs.watch`, SSE. Frontend: plain HTML/CSS/JS, native drag & drop, no framework.
- Storage module with exactly four operations: `list`, `read`, `write`, `watch`. No other abstraction.
- Security: bind to `127.0.0.1` only. All file paths resolved and verified to be inside the board folder (no `../` escape).
- Preserve line endings (CRLF on Windows). macOS primary; Linux/Windows should work via Node.

## Known edge cases

- **User headings named like our sections.** Sections are found by the last `## Changelog` and the last `## Comments` before it, and headings inside comments are demoted to `####`, so comments can't break sections. But if a card body uses `## Comments` or `## Changelog` as its own heading and the card has no such section yet, Markanban reads that text as its section. Impact: a misread card, never data loss (the body is never rewritten by section logic). `---` dividers would not help (ambiguous with thematic breaks, setext headings and front-matter). If this shows up in practice: write an invisible marker such as `<!-- markanban:comments -->` above our headings and upgrade existing files on write.

## Deferred (not v1)

- Swimlanes from subfolders
- Attachments in a folder per card
- Google Drive / network share storage, plus polling watcher for shares
- Hosted version
- Logging external edits
- LAN access flag
- Delete cards
- Hand-drawn theme; board-level default theme in `.markanban.yml`
- `.markanban.yml` in the run folder pointing at a board folder
- Editing unknown fields in the UI

## Proposed: Replay (decided — not built yet)

A separate, read-only mode that plays back how cards moved across the board over time.

**Modes**
- Normal board: unchanged, plus one "▶ Replay" button in the header. No replay controls are visible.
- Replay mode: entered via that button. Board is read-only (no drag, no `+` buttons, no "+ Column", no card dialog), live file updates are held until exit. The filter row stays, so you can replay a subset (e.g. one assignee). A control bar appears: play/pause, timeline slider, replayed date/time clock, Exit.
- Exit returns to the live board and removes the control bar.

**Playback**
- Play runs at a fixed **8 hours per second**. No speed selector: drag the timeline slider to go faster, slower or backwards.
- The timeline runs from the earliest event to now.

**Data (client-side only, no server or file changes)**
- Rebuilt from the changelogs already returned by `/api/board`; no extra file reads.
- A card appears at its earliest known time: `card: created` line → `created` field → file birthtime.
- Its starting column is the `from` of its first status change, else its current status.
- `archived` hides it; unarchive brings it back.
- Other field changes are not replayed; cards show their current heading and fields.
- If building the timeline is ever noticeably slow, show a "Preparing replay…" loading state.

**Board**
- Statuses no longer in use appear as a column only while they hold cards, ordered by the normal column rules.
- Moving cards slide between columns (Web Animations API, no dependency). New cards fade in, archived fade out. Animations are cut short at high speed so they never lag the clock.

**Card order**
- Ranks aren't logged, so order changes can't be replayed; cards in a replayed column are shown in their current order. Revisit these decisions when building replay.

**Known gap (accepted)**
- Edits made outside the UI aren't in the changelog, so such a card jumps to its current column at the end. Replay is only as complete as the changelog.
- 2026-11-17T13:41:26Z marcushammarberg status: (none) → Demo
- 2026-11-17T13:41:34Z marcushammarberg status: Demo → Done
- 2026-11-17T13:41:35Z marcushammarberg status: Done → (none)
