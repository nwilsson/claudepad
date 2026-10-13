# Changelog

## 0.2.0

### Added

- **Branch notes.** `/note -b`, the 🌿 choice in the pane, or `add_note`
  with `branch: true` ties a note to the current git branch. It is listed
  only while that branch is checked out, and rejoins the repo's notes,
  marked (gone), once the branch is deleted.
- **Notes follow the repo.** Projects are known by their git remote, so a
  repo's notes are the same in every clone, subfolder and machine. Notes
  filed under the folder before move over on their own.
- **A notes folder.** The `notesFolder` option keeps notes in a folder you
  choose, one JSON file per project, one note per line, ready for git or a
  synced drive. Existing notes are copied in the first time.
- **`NOTES.md` is followed.** After `/notes export`, edits to the file
  (yours, Claude's or git's) apply within seconds; a deleted line archives
  its note, with undo.
- **Archive instead of delete,** with a done-by-week view and undo for
  every archive, including **clear done**.
- **Due dates** with `#due:YYYY-MM-DD`: flagged at session start and on the
  status line, sortable in the pane, and marked overdue for Claude.
- **Claude's tools** `complete_note` and `update_note`, and note ids in
  `list_notes`.
- **Keys in the pane:** `j`/`k` select, `d` done, `p` pin, `u`/`n` move.
- **Your own order,** with ↑ and ↓ on each note.
- **A warning** when pinned notes add more than about 1k tokens to every
  prompt.
- `/note --last` saves Claude's last reply as a note.
- A note's `path:line` opens in VS Code, Cursor or a JetBrains IDE (the
  `editor` option).

### Changed

- Notes are stored under one key per project, and every change re-reads the
  stored notes first, so two sessions open at once no longer overwrite each
  other.
- The status line follows a directory change.

## 0.1.0

The first version: the notes pane, project and global notes, tags and
search, a multi-line editor, `NOTES.md` export and import, pinned notes sent
as context, and the `add_note` and `list_notes` tools.
