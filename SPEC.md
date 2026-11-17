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
| `created` | ISO UTC timestamp. Written only when the card is created via the UI. Missing → display file birthtime (never written back). |
| `archived` | ISO UTC timestamp. Present = archived, absent = active. |

- **No `changed` field.** "Last changed" is displayed from file mtime.
- **Unknown fields** (e.g. `priority`, `due`) are preserved untouched — comments and key order too — and shown as read-only `key: value` chips.

### New cards (via UI)

- Filename = slug of the heading (`Fix login bug` → `fix-login-bug.md`), `-2`, `-3`… on collision.
- Filename never changes afterwards, even if the heading does.
- Heading is written as a `# H1` in the body (not front-matter). `created` is set.

## Changelog

The last section of the file, `## Changelog`, is a list. Newest last, append-only.

```
- <ISO 8601 UTC timestamp> <who> <field>: <from> → <to>
```

- `(none)` = empty value.
- Body edits log a single line: `<ts> <who> body: edited` (no diff).
- Only changes made through the UI are logged. External edits are accepted silently.
- The section is hidden from the card body and shown in a "History" view instead.

**Who** = `--user` flag → `MARKANBAN_USER` env var → OS username (`os.userInfo()`). No login.

## Board / columns

Columns = distinct `status` values across **active** (non-archived) cards.

Order:
1. `columns` in `.markanban.yml`, if present
2. then the common order: `backlog, todo, ready, doing, in progress, review, done` (case-insensitive)
3. then the remaining statuses alphabetically

- Empty columns disappear unless listed in `.markanban.yml`.
- The user can reorder columns by drag → writes `.markanban.yml`.
- A "+ column" input allows moving a card to a new status.

### `.markanban.yml`

Lives in the board folder. Created lazily on first column reorder.

```yaml
columns: [backlog, todo, doing, review, done]
noStatusColumn: Inbox     # default: "No status"
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
- Hidden from the body textarea; shown as a list with an "Add comment" box (⌘/Ctrl+Enter submits). Cards show a 💬 count. Search includes comment text.

### Filters

A row above the board: free-text search (heading + body), and selects for type, assignee and tag, each with a "No …" option. Options are built from the current cards. Filters combine, apply to archived cards too, are client-side only, and reset on reload.

### Column reordering

Drag a column by its header (⠿ grip) and drop it on either half of another column, or use the ‹ › buttons shown on hover/focus. The order is saved to `.markanban.yml`. "No status" is always first.

### Live updates & safe writes

- Server watches the folder (`fs.watch`) and pushes changes to the browser via Server-Sent Events.
- Every write re-reads the file from disk and applies only the targeted change (one field, or append one changelog line). Never write back a stale full copy.

### Theming

- Every color, font, radius, border and shadow is a CSS custom property on `:root`. No hard-coded colors in components.
- A theme = one CSS file, activated by `<html data-theme="…">`. Themes may override any rule, not just variables (so a hand-drawn theme can change fonts, borders, rotation, filters).
- v1 ships **light** and **dark**. Default follows the OS (`prefers-color-scheme`). Header toggle: System → Light → Dark; a manual choice is saved in `localStorage`.

## Tech

- TypeScript on Node 22+, published as compiled JS (runs via `npx`).
- Runtime dependency: `yaml` (Document API, preserves comments/order). Dev: `typescript`.
- Server: `node:http`, `fs.watch`, SSE. Frontend: plain HTML/CSS/JS, native drag & drop, no framework.
- Storage module with exactly four operations: `list`, `read`, `write`, `watch`. No other abstraction.
- Security: bind to `127.0.0.1` only. All file paths resolved and verified to be inside the board folder (no `../` escape).
- Preserve line endings (CRLF on Windows). macOS primary; Linux/Windows should work via Node.

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
