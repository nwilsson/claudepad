# claudepad roadmap

Work items for the mod. Each item is a checkbox: mark it `- [x]` when it is
done and verified. Sizes are rough: S (under a day), M (a few days), L (a week
or more).

## Phase 0: verify before changing anything (S)

- [x] Confirm how the engine scopes `store` and atoms across sessions. Record the answer here.
  - **Atoms (`$.state`)** are per session. Each session loads `notes` from the store once, at `session.start`, and never re-reads it.
  - **`$.store`** is one JSON file per plugin, shared by every session: `~/.claude/plugins/store/claudepad_<source>-<hash>.json`. Tested with two concurrent `claude -p` sessions (a throwaway probe plugin, 2026-10-12): `store.get` reads the file fresh, so it sees a write another session made after it started; `store.set` merges at the key level, so writing key `a2` kept the other session's key `b`. There is no `ifVersion` on the store, so a second write to the same key wins.
  - **So overwrites are confirmed.** All notes live under the one `notes` key, and `change()` writes the session's atom (as loaded at start, plus its own edits). Session A adds a note, session B (started earlier) adds another, and A's note is gone from the store. Any fix has to re-read the store before writing, or split the data across keys.
- [x] Reproduce the stale status line after a directory change. Record the steps.
  - Steps: open a session in folder A, which has notes; move to folder B, which has a different number of open notes (`/cd B`, or a host directory change); the status line keeps A's count until a note is changed. The pane's project heading and list are stale too, because the render reads `$.session.cwd()` but subscribes only to atoms.
  - Cause: `$.ui.status` is set only in `session.start` and `change()`; nothing hooks `classic.CwdChanged`.
  - Test (fails today, add it with the phase 1 fix): store notes for `/work/a` (1) and `/work/b` (2), call `$.session.start`, switch `session.cwd` to `/work/b`, raise `$.classic.CwdChanged`, and expect a second status `📝 2 here · 0 global`. Only the first status, `📝 1 here · 0 global`, is ever set.
- [x] Add `tests/` coverage for the pure logic so later refactors are safe.
  - `tests/notes.test.ts` drives the logic through `/note`, `/notes` and the two tools, because none of it is exported yet: scope flags, folder spelling, search and exact `#tag` matching, tag counts, export order and its overwrite guard, import parsing, merge and `--replace`, an export imported back unchanged, and pinned-note context. Once phase 2 extracts `hooks/notes.ts`, add direct unit tests beside these.

## Phase 1: correctness and safety (S–M)

- [ ] Fix concurrent-session overwrites, if phase 0 confirms them. Options: per-project store keys, or merge on write.
- [ ] Refresh the status line on directory change.
- [ ] Undo for delete: a toast with "undo" for about 5 seconds.
- [ ] Add `NOTES.md` to `.gitignore`.

## Phase 2: performance groundwork (M)

- [ ] Extract `parseMarkdown`, `matches`, `tagsOf`, the import merge, and the sort into `hooks/notes.ts` with no UI imports. This also shrinks `hooks/register.tsx`.
- [ ] Store tags on each note at write time instead of re-parsing on every render.
- [ ] Post the editor draft on save, mode switch, or a 300 ms debounce, not on every keystroke.
- [ ] Replace the O(n·m) `findIndex` in import with a key `Map`.
- [ ] Keep a derived `pinned` atom so `prompt.submit` skips the full scan.
- [ ] Write per-project store keys, or one document per note, so writes are proportional to the change.

## Phase 3: Claude-aware features (M)

- [ ] `complete_note` and `update_note` tools, so Claude can close the TODOs it finishes.
- [ ] Due dates via a `#due:YYYY-MM-DD` tag, with overdue notes surfaced at `session.start`.
- [ ] "Save last response as note."
- [ ] Notes can carry a `path:line` link that opens the file.

## Phase 4: sync and workflow (M–L)

- [ ] Watch `NOTES.md` for outside edits and re-import.
- [ ] Make the store path configurable, so notes can live in a git-tracked folder across machines.
- [ ] Branch-scoped notes.
- [ ] Templates with variables, sent through the existing → prompt button.
- [ ] Archive instead of delete, and a completed-by-week view.

## Phase 5: polish (S)

- [ ] Pane keyboard shortcuts (j/k to move, d to mark done).
- [ ] Up/down reordering.
- [ ] Warning when pinned notes take up too much prompt context.

## Dependencies

- Phase 2 comes before the Claude-aware and sync work, so new features do not repeat the render churn.
- Phase 4's sync depends on the phase 1 storage fix.

## Done when

- Each phase has a test for its pure logic.
- `scripts/check.sh` passes.
- The README reflects any new commands or tools.