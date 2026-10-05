# Notepad: a Claude Code mod

A notepad pane inside Claude Code (terminal or desktop Code tab).

## Features

- `/notes` opens or closes the pane. `/note <text>` adds a quick note, `/note -g <text>` a global one, and a bare `/note` opens the multi-line editor.
- **Per-project and global notes:** project notes are tied to the session's folder.
- **Done / pin / edit / move / delete** buttons on each note, and **clear done** at the bottom.
- **Search** box (all words must match, `#tag` matches a tag exactly) and `/notes find <text>`.
- **Tags:** write `#hashtags` in a note. The pane colors them and adds a clickable tag bar. `/notes tags` lists them.
- **Multi-line editor:** a full editor with cursor keys and Ctrl+S to save, plus a line-by-line fallback.
- **Export / import** with `NOTES.md`: `/notes export [--force]`, `/notes import [--replace]`.
- **Status line:** `📝 N here · M global`.
- **Claude-aware:**
  - Pinned notes are sent to Claude with every prompt.
  - **→ prompt** puts a note into the prompt box.
  - Claude gets `add_note` and `list_notes` tools.

Notes are saved in the mod's own store under your Claude Code config folder, not in this folder.

## Loading it

For one session:

```
claude --plugin-dir "E:/Code/Modding/Claude Mods/notepad"
```

For every session, including the desktop app: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "E:/Code/Modding/Claude Mods/notepad" } }
```

## Checking and testing

```
claude plugin validate "E:/Code/Modding/Claude Mods/notepad"
claude plugin test "E:/Code/Modding/Claude Mods/notepad"
```

Use a Claude Code at least as new as 2.1.286, the version the mod was built against. Older CLIs reject the hook API.

## Files

- `.claude-plugin/plugin.json`: the manifest.
- `hooks/register.tsx`: the hooks: commands, pane, tools, prompt context, export and import.
- `hooks/editor.tsx`: the multi-line editor component.
- `types/index.d.ts`: the mod's state types.
- `tests/editor.test.tsx`: the editor test.
