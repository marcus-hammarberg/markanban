# Agent instructions — Markanban

Markanban is a kanban board driven by a folder of markdown files. `SPEC.md` is the source of truth for behaviour: read the relevant section before changing a feature, and update it in the same change. `README.md` is the user guide; keep it in step with user-visible changes.

## Principles

- **Files are the truth.** The user may hand-edit any card at any time. Every write re-reads the file and makes a targeted change (one field, one appended line). Preserve front-matter comments, key order, unknown fields and line endings (CRLF stays CRLF). Never rewrite the user's body text except for an explicit body edit.
- **Dumb client.** Rules and decisions (column order, type colors, validation) live on the server in tested code, and `/api/board` returns the results. The browser in `public/` only displays and sends user actions.
- **Config problems never break the board.** Skip the broken part, fall back to the default, return a warning naming the valid values (see `parseConfig` in `src/board.ts`).
- **One storage seam.** Only `src/storage.ts` touches the filesystem; a Drive/hosted backend replaces that module alone.
- **Lightweight.** Runtime dependency is `yaml`, nothing else. Reach for Node built-ins and native browser features (drag & drop, `<dialog>`, CSS) first; the frontend stays plain HTML/CSS/JS, no framework or bundler.
- **Theme tokens only.** Components use CSS custom properties, never raw colors. A theme file under `public/themes/` redefines the tokens (including every `--type-<color>`) and may override any rule.
- **Secure by default.** Keep the 127.0.0.1 bind, the Host-header check (DNS rebinding), the `application/json` requirement on writes (CSRF), and path validation in `storage.ts`.
- **Lint-clean markdown.** Headings Markanban writes (`## Comments`, `### <comment>`, `## Changelog`) get blank lines around them (markdownlint MD022).

## Workflow

- New features are designed into `SPEC.md` first. A "Proposed" section is a plan, not a task: build it only when the user asks.
- Test-first for logic in `src/` (`node:test`, `npm test`). Every rule that can lose or corrupt user data gets a test.
- Check UI changes in a real browser against a scratch board folder, both light and dark theme. Leave the user's own board files as you found them.
- Commit only when the user asks.

## Gotchas

- Source runs directly on Node ≥ 22.18 (type stripping): relative imports use the `.ts` extension, and only erasable TypeScript is allowed (no enums, namespaces or constructor parameter properties). `tsc` rewrites imports to `.js` for `dist/`.
- `dist/` is not committed. The `prepare` script builds it, which is what makes `npx github:<owner>/markanban` work.
- `createServer` must close its folder watcher on `server.close()`, otherwise the test process never exits.
- `fetch()` silently drops a custom `Host` header; use `node:http` to test the Host check.
- The `h()` helper in `public/app.js` skips only `null`/`false` children, so `0 && …` renders a literal `0`. Use `count > 0 && …`.
