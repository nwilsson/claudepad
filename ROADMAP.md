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
  - Sorting by due date: **Sort: ● added ○ due** in the pane, shown once a note here or global has a date. By due keeps pinned first and open before done, then the earliest date, then undated notes, each oldest first (`paneOrder(list, true)`). The choice is per session, like the search.
  - Telling Claude: `list_notes` (and `/notes find`) mark an open note `(overdue)` or `(due today)` against the local date, and a list with a dated note ends with `Today is YYYY-MM-DD.`, since Claude may not know the person's date.
- [x] "Save last response as note."
  - `/note --last [text]` (with `-g` for global, flags in any order before the text) and a pane button save the main conversation's last assistant message with text, read from `$.session.messages()` when asked, so it works after a reload too. Any text becomes the first line. The note is yours (`author: 'you'`): you chose to save it. A long reply is saved whole.
- [x] Notes can carry a `path:line` link that opens the file.
  - A path with an extension, then `:line` and maybe `:column`, standing alone in the text (`linksOf()`), gets an **open** button in the pane (up to three per note). It runs the editor through `$.process.run`, so it works in any terminal but only where the session runs locally. The mod's `editor` option (a picker: `vscode`, the default, `cursor`, `jetbrains`) picks `code -g`, `cursor -g` or `idea --line`. A relative path resolves under the session's folder for this project's and the global notes, and under the stored (lowercased) project folder for another project's, which can miss on a case-sensitive file system. A failed command is a toast.
  - Probed on this machine: `$.process.run(['code', ...])` starts VS Code's `code.cmd` on Windows with no shell.

## Phase 4: sync and workflow (M–L)

- [x] Watch `NOTES.md` for outside edits and re-import.
  - Polled, not watched: `$.clock.every` 3 s stats the session folder's `NOTES.md` and reads it only when its `mtimeMs` changed (`fileSeen` atom). The engine's own watch (`watchPaths`) is taken only from a classic SessionStart, so it would miss the folder after a directory change. A poll also runs at `session.start`, so edits made between sessions apply.
  - Only a file starting with the export's mark line is followed. Each project's file as last synced is kept in the store under `sync:` and the folder (`keyOfSync`): set by export and import, and by the poll after it applies an edit. A file seen with nothing stored is only recorded, since there is nothing to compare it with.
  - `syncFile` applies only what the edit changed, so a line left alone never undoes a change made in the notepad since (a tick, a delete for good): a line new to the file adds a note, or restores the archived note it matches; a line whose done or pinned mark changed passes it on; a line gone from the file archives its note through `archiveNotes`, so the pane and `/notes undo` can undo it. A changed line's text reads as one removed and one added: the old note is archived and a new one added. One toast says what was added, restored and updated.
  - Two sessions on the same folder both poll; the second finds the stored copy already matching the file and does nothing, short of a tie.
- [x] Make the store path configurable, so notes can live in a git-tracked folder across machines.
  - The `notesFolder` option (a string; `~/` is the home folder from `USERPROFILE` or `HOME`). Set, notes live in that folder as one file per store key (`fileNameOf`: the key made file-safe, cut to 80 characters, plus an FNV hash), written as the key and one note per line (`toNotesFile`) so git merges two machines' changes to different notes. `$.fs` has no delete, so an emptied key keeps its file with no notes. `NotesStore` in `register.tsx` puts the plugin store and the folder behind one `keys`/`get`/`set`/`clear`; only `reload`, `change` and `adopt` use it. The NOTES.md sync records (`sync:` keys) and the old `notes` key stay in the plugin store: they belong to this machine.
  - The first time a folder holds no `.json` files, the plugin store's notes are copied in (and kept there, so clearing the option goes back to them). A file that no longer parses (a merge conflict) is toasted at load and its key is left out; a change to that key throws before writing, so it is never written over.
  - Projects are now known by their git remote (`remoteId`: host and path, lowercased, without scheme, user, port or `.git`), from `$.session.repo()`, so a project's notes are the same on every machine and clone. A repository with no remote is its root folder; outside a repository, the folder as before. A session in a subfolder shares the repository's notes. `identify` works this out at `session.start` and on a directory change (cached in the `folder` atom); `adopt` then moves notes filed under the repository root or the session folder to the project, with their NOTES.md sync record, and says so in a toast. Notes of other subfolders move when a session visits them.
  - A note's relative `path:line` now opens under the repository root. Another project's note known by its remote has no folder on this machine, so only an absolute path in it opens.
  - Not done: another machine's changes, pulled into the folder while a session runs, show at the next session start or directory change, as other sessions' changes do (a change to a key reads it fresh first).
- [x] Branch-scoped notes.
  - A project note can carry `branch`, under the same store key. `git branch --format=%(HEAD)%(refname:short)` gives the current branch and every local one in one run (`parseBranches`); it runs at `session.start`, on a directory change, when `/notes` opens the pane, before each prompt (a switch in another terminal), and after a tool batch with a Bash or PowerShell call. A failed run, no git, or a detached HEAD is no branch. `$.session.repo()` has no branch, and watching `.git/HEAD` would need `watchPaths` from a classic SessionStart, so it is not done: an outside switch shows at the next prompt.
  - Another branch's notes, while that branch exists, are left out of the lists, the status line, overdue, pinned context, `list_notes` and export (`isOffBranch`, `onBranch`); a search finds them, under **🗂 Other projects and branches**. A deleted branch's notes list with the project's again, marked `(gone)` (Claude sees `since deleted`), so merging a branch never strands its notes. Outside a repository every branch counts as gone.
  - Adding: **Add to: ○ 🌿 branch** in the pane (shown on a branch), `/note -b`, and `add_note`'s `branch: true`, each falling back to a project note with no branch checked out. A row's **→ 🌿 name** puts a project note on the branch, **→ whole project** takes it off; a branch note has no **→ global**.
  - `NOTES.md`: each branch exported gets a `## 🌿 name` section, read back onto that branch; the branch is part of the import's match, and `--replace` keeps other branches' notes, which the file cannot hold.
- [ ] Templates with variables, sent through the existing → prompt button.
- [x] Archive instead of delete, and a completed-by-week view.
  - Notes carry `doneAt` (set on done, cleared on reopen; `withDone()`) and `archivedAt`. **archive** replaces **delete**, and **clear done** archives every done note here and global in one go; both offer undo in the pane for 5 s and with `/notes undo` (which now restores a whole **clear done**). Archived notes are left out of the lists, search, the status line, overdue, pinned context, `list_notes` and export; an import that matches one leaves it archived, so an old file cannot bring it back.
  - **🗄 archive (N)** opens the archive view for this project and global: done notes by the local week (Monday) they were finished, newest first, with notes done before `doneAt` existed under "Earlier", then archived notes that were not done. Each archived note can be restored or deleted for good, the only permanent delete.

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