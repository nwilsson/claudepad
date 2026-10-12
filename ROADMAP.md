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

- [x] Fix concurrent-session overwrites, if phase 0 confirms them. Options: per-project store keys, or merge on write.
  - Merge on write: `change()` applies its edit to the store as it is now, not to the session's copy. A short gap between the read and the write remains, because the store has no `ifVersion`; per-project keys (phase 2) shrink it further. A session still shows other sessions' notes only after its own next change.
- [x] Refresh the status line on directory change.
  - `classic.CwdChanged` recounts the status line and sets a `folder` atom, which the pane reads so it redraws too.
- [x] Undo for delete: a toast with "undo" for about 5 seconds.
  - Toasts carry text only, so the toast points at an **undo** button the pane shows for 5 s. `/notes undo` restores the last deleted note after that too, back where it stood. **clear done** is not covered.
- [x] Add `NOTES.md` to `.gitignore`.

## Phase 2: performance groundwork (M)

- [x] Extract `parseMarkdown`, `matches`, `tagsOf`, the import merge, and the sort into `hooks/notes.ts` with no UI imports. This also shrinks `hooks/register.tsx`.
  - `hooks/notes.ts` also holds the text and Markdown formats, the status text and the small helpers; `register.tsx` went from 891 to about 740 lines. The import merge is `mergeImport`, which returns the list and its counts. `tests/logic.test.ts` tests the module directly. Import it as `./notes`: tsc refuses a `.ts` extension.
- [x] Store tags on each note at write time instead of re-parsing on every render.
  - `Note.tags`, set by `tagged()` wherever text is written (add, edit, import). A note saved before this gets its tags when loaded, and keeps them from its next write on. Search, tag counts and the pane's tag filter read `tagsOfNote()`, which falls back to the text.
- ~~Post the editor draft on save, mode switch, or a 300 ms debounce, not on every keystroke.~~ **Dropped, not worth doing.** The engine already sends at most one post per frame, and in full-editor mode the pane does not read the draft, so a post redraws nothing. A debounce would make the pane's **Save** button miss up to 300 ms of typing, because the hooks module cannot ask the editor for its text (Ctrl+S posts it directly).
- [x] Replace the O(n·m) `findIndex` in import with a key `Map`.
  - Keyed by scope and loose text; the first of two alike notes wins, and a line the file repeats merges into the note it added, as the scan did.
- [x] Keep a derived `pinned` atom so `prompt.submit` skips the full scan.
  - `derive([notes], …)` keeps the open pinned notes of every project and recomputes only when the notes change; `prompt.submit` filters that short list to this project and global.
- [x] Write per-project store keys, or one document per note, so writes are proportional to the change.
  - Per-project keys: `global`, and `project:` plus the normalized folder (a folder over 200 characters is cut and hashed, because the store refuses keys over 256). A change reads and writes only its own keys (a move, both), and deletes a key left empty. The whole store is still one JSON file that the host rewrites on every `set`, so the gain is smaller values and fewer clashes between sessions, not smaller disk writes. One document per note was ruled out: loading would take one `get`, a full file read, per note.
  - The old `notes` key moves to the new keys on load (`session.start`, and a directory change, which also picks up other sessions' notes). A session still on an older version can write `notes` again; the next load folds in what it added, but can bring back a note the new layout deleted.
  - Two sessions saving the same project at the same instant can still lose one change: the store has no `ifVersion`.

## Phase 3: Claude-aware features (M)

- [x] `complete_note` and `update_note` tools, so Claude can close the TODOs it finishes.
  - Both take a note's id, which `list_notes` and `add_note` now report (`/notes find`, for the person, does not). `complete_note` takes `done: false` to reopen; `update_note` replaces the text and its tags. An unknown id or empty text is refused, and every change shows a toast.
- [x] Due dates via a `#due:YYYY-MM-DD` tag, with overdue notes surfaced at `session.start`.
  - `dueOf()` reads a real date only (`#due:2026-02-30` is none); dates compare on the local calendar. Open overdue notes here and global get a toast at `session.start` (up to three named) and a `⏰ N overdue` count on the status line, kept on every change. The pane draws the date red once past, amber on the day. `#due` stays an ordinary tag, so the tag bar filters every dated note.
  - Not done: sorting by due date, and telling Claude which notes are overdue (`list_notes` shows the dates as written).
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