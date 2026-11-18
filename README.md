# Markanban

A kanban board for a folder of markdown files. Point it at a folder and you're done: every `.md` file is a card, and the board is built from what's in them. No database, no account, no setup.

Your cards stay plain markdown files. Edit them in the board, in your editor, or both at the same time; the board updates live.

## Quick start

You need [Node.js](https://nodejs.org) 22.18 or newer.

```sh
npx github:marcus-hammarberg/markanban ./my-board
```

This opens the board in your browser at <http://localhost:4242>. The folder is created if it doesn't exist yet; leave it out to use the current one. The first run takes a little longer while it downloads and builds.

| Option | What it does |
|---|---|
| `--port 4242` | Port to run on |
| `--user anna` | Your name in comments and history (see [Who you are](#who-you-are)) |
| `--no-open` | Don't open the browser automatically |
| `--help` | Show usage |

### Starting a new board

A new, empty board shows only **+ Column**. Click it to add your first column (for example `todo`), then use the **+** in that column to create your first card. Or just drop a few `.md` files into the folder; they show up right away.

## Cards

A card is any `.md` file directly in the folder. `README.md`, hidden files and subfolders are ignored. A file doesn't need anything special to be a card:

```markdown
Just an idea I had.
```

That shows up in a **No status** column. Add front-matter to give it more:

```markdown
---
status: doing
type: bug
assignee: anna
tags: ui, auth
priority: high
---
# Fix login bug

Users get logged out after 5 minutes.
```

Every field is optional:

| Field | Meaning |
|---|---|
| `status` | The column the card is in |
| `type` | Free text, e.g. `bug` or `feature`; also sets the card's [color](#colors) |
| `assignee` | Who is working on it |
| `tags` | `ui, auth` or `[ui, auth]` |
| `heading` | The card title. Without it, the first `# Heading` in the text is used, then the file name (`fix-login-bug.md` → "fix login bug") |

Any other field (like `priority` above) is kept as-is and shown as a small label on the card. Markanban also adds a `rank` field when you reorder cards; it stores the card's position and isn't shown.

## Columns

Columns come from the statuses on your cards, so a new status gives you a new column. They're ordered the way you'd expect (`backlog`, `todo`, `ready`, `doing`, `in progress`, `review`, `done`), with any others after them alphabetically.

To change the order, drag a column by its header (⠿), or hover over the header and use the ‹ › buttons. Your order is saved in `.markanban.yml`, and columns listed there stay visible even when they're empty. A column also stays when you move or archive its last card on the board. Use **+ Column** to add a new one, or drop a card on it to give the card a new status.

## Working with cards

- **Move** a card by dragging it to another column, or up and down within one. The order is your priority: the top card matters most. A line shows where the card will land.
- **Keyboard**: Tab to a card, Enter opens it, Alt+↑/↓ moves it up or down, Alt+←/→ moves it to the next column.
- **Create** a card with the **+** in a column header. It becomes a new file named after its heading.
- **Edit** by clicking a card: change its fields and text, then **Save** (or press Ctrl/⌘+Enter).
- **Link** to a card with the 🔗 in its dialog: it copies an address (like `http://localhost:4242/#card=fix-login-bug.md`) that opens the card. Teammates need to use the same port.
- **Comment** in the Comments section at the bottom of the card (collapsed until you open it, with the number of comments shown). Comments are saved in the card file.
- **Archive** cards you're done with. They disappear from the board; tick **Show archived** to see them again and unarchive. There's no delete button: to remove a card for good, delete its file.
- **Filter** with the row above the board: search text (headings, card text and comments), or pick a type, assignee or tag.
- **Replay** shows how the board got here: **▶ Replay** in the top right plays back how cards moved between columns, 8 hours per second. Drag the slider to jump around, and use the filters to follow one person or tag. The board is read-only while replaying; **Exit replay** brings back the live board.
- **Theme**: the board follows your system's light or dark mode. The button in the top right switches between System, Light and Dark.

## History and comments

Every change you make on the board is recorded at the bottom of the card file, with who made it and when:

```markdown
## Comments

### 2026-11-17T09:12:00Z anna

The session timeout is 5 minutes.

## Changelog

- 2026-11-17T09:00:00Z anna card: created
- 2026-11-17T09:10:00Z anna status: todo → doing
- 2026-11-17T09:12:00Z anna comment: added
```

The card view shows comments and history separately from the card's text. Changes made directly in the file aren't recorded.

## Colors

Cards get a colored edge based on their `type`. Common types have colors out of the box:

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

Other types have no color until you add them to `.markanban.yml` (below).

## Settings: `.markanban.yml`

Optional. It lives in the board folder and is created for you the first time you reorder columns, add a column, or empty one by moving or archiving its last card.

```yaml
columns: [backlog, todo, doing, review, done]   # column order
noStatusColumn: Inbox                           # name of the "No status" column
types:                                          # colors per type
  incident: orange
  ops: pink
```

Colors: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `grey`. If something in the file is wrong, the board still works and shows a warning telling you what to fix.

## Who you are

Comments and history use your name. Markanban picks it from, in order:

1. `--user anna`
2. the `MARKANBAN_USER` environment variable (e.g. `export MARKANBAN_USER=anna` in your shell profile)
3. your computer's login name

## Sharing a board

Put the folder in a synced folder (Google Drive for desktop, Dropbox, OneDrive) or on a network share, and have each person run Markanban on their own computer, pointed at their local copy:

```sh
cd ~/"Library/CloudStorage/GoogleDrive-<you>/My Drive/team-board"
npx markanban
```

Each person's changes are recorded under their own name, and other people's changes show up on your board within a few seconds of syncing.

If two people change the same card at almost the same moment, the sync service decides what happens. Dropbox and OneDrive create a conflict copy (like `card (1).md`), which shows a ⚠️ so you can sort it out. Google Drive keeps the newest version; the other one is in the file's version history in Drive.

Markanban only accepts connections from your own computer; it isn't reachable from the network.

## Limitations

- Swimlanes, attachments and a hosted version aren't there yet.
- Card text and comments are shown as plain text; markdown isn't rendered yet.
- Changes made outside the board (in an editor or by sync) aren't recorded in the history, so Replay can't show them: such a card jumps to where it is now at the end.
- A card file Markanban can't read (for example, no permission) is left out and a warning names it.

## Contributing

Design and behaviour are described in [`SPEC.md`](SPEC.md). Development conventions are in [`AGENTS.md`](AGENTS.md).

```sh
npm install
npm test
npm start -- ./some-board
```

To see Replay in action, generate a demo board: the story of how Markanban itself was built, about 20 cards dated over the last three weeks.

```sh
npm run demo -- ./demo-board   # needs a new or empty folder
npm start -- ./demo-board      # then press ▶ Replay
```
