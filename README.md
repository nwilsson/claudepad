# claudepad

A notepad pane for Claude Code, as a mod.

<!-- demo video: drag an .mp4 into a GitHub issue or the README editor and paste the user-attachments link here -->

Ideas, follow-ups and TODOs pile up while Claude works, and the transcript
is a bad place to keep them. claudepad adds a notes pane inside the same
TUI, in the terminal or the desktop Code tab. Notes belong to the project
you are in or live globally, and Claude can read them, add to them and keep
your pinned ones in mind. Nothing leaves your machine: notes sit in the
mod's own store under your Claude Code config folder.

## What it does

- **A pane, one command away.** `/notes` opens or closes it. `/note <text>`
  adds a quick note, `/note -g <text>` a global one, and a bare `/note`
  opens the multi-line editor.
- **Per-project and global notes.** Project notes are tied to the session's
  folder, so each repo keeps its own list. Global notes follow you
  everywhere.
- **Done, pin, edit, move, delete.** One button each on every note, and
  **clear done** at the bottom sweeps finished ones away.
- **Search.** Every word must match; `#tag` matches a tag exactly. The same
  search is `/notes find <text>`.
- **Tags.** Write `#hashtags` in a note. The pane colors them and adds a
  clickable tag bar; `/notes tags` lists them.
- **A multi-line editor.** A full editor with cursor keys and `Ctrl+S` to
  save, with a line-by-line fallback where the full one cannot draw.
- **`NOTES.md` sync.** `/notes export [--force]` writes the project's notes
  to a `NOTES.md` in the folder, `/notes import [--replace]` reads it back.
  Export never overwrites a `NOTES.md` it did not write unless forced.
- **A status line.** `📝 3 here · 5 global`.
- **Claude-aware.**
  - Pinned notes are sent to Claude with every prompt, as standing context.
  - **→ prompt** puts a note into the prompt box.
  - Claude gets `add_note` and `list_notes` tools, so it can park a
    follow-up instead of derailing the task, and look up what you wrote.

## Install

```
claude plugin marketplace add nwilsson/claudepad
claude plugin install claudepad@claudepad
```

Restart Claude Code, then run `/notes`.

To try it from a clone without installing:

```
claude --plugin-dir /path/to/claudepad
```

Use a Claude Code at least as new as 2.1.286, the version the mod was built
against. Older CLIs reject the hook API.

## Layout

- `.claude-plugin/plugin.json`: the manifest; `marketplace.json` lists it.
- `hooks/register.tsx`: commands, pane, tools, prompt context, export and
  import.
- `hooks/editor.tsx`: the multi-line editor component.
- `types/index.d.ts`: the mod's state types.
- `tests/editor.test.tsx`: the editor test.

## Development

```
claude plugin validate .
npx -p typescript tsc -p .   # after the engine has laid .claude-plugin/types
claude plugin test .         # tests/*.test.tsx, run in the engine's own sandbox
```

`scripts/check.sh` runs all three and checks that both manifests carry the
same version. CI runs it on every push and pull request, without tsc: the
types only exist once the engine has loaded the plugin.

## License

MIT
