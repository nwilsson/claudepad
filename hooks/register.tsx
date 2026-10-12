import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeletedNote, EditorSession, Note, Scope } from '../types'
import {
  EXPORT_FILE,
  EXPORT_MARK,
  TAG,
  asText,
  baseName,
  indented,
  isGlobal,
  isHere,
  matches,
  mergeImport,
  newId,
  normalize,
  paneOrder,
  parseMarkdown,
  parseNoteArgs,
  plural,
  preview,
  statusFor,
  tagCounts,
  tagged,
  tagsOfNote,
  toMarkdown,
} from './notes'

const PANE = 'claudepad'
const STORE_KEY = 'notes'
const ADD_TOOL = 'mcp__claudepad__add_note'
const LIST_TOOL = 'mcp__claudepad__list_notes'

const notes = atom({ plugin: 'claudepad', key: 'notes' } as const, [] as Note[])
const editor = atom({ plugin: 'claudepad', key: 'editor' } as const, null as EditorSession | null)
const draft = atom({ plugin: 'claudepad', key: 'draft' } as const, '')
const isLineMode = atom({ plugin: 'claudepad', key: 'isLineMode' } as const, false)
const EDITOR_MODULE = './editor.tsx'

/** The session's folder, normalized; the pane reads it so a directory change redraws it. */
const folder = atom({ plugin: 'claudepad', key: 'folder' } as const, '')
const scope = atom({ plugin: 'claudepad', key: 'scope' } as const, 'project' as Scope)
const query = atom({ plugin: 'claudepad', key: 'query' } as const, '')
const activeTag = atom({ plugin: 'claudepad', key: 'tag' } as const, null as string | null)
const deleted = atom({ plugin: 'claudepad', key: 'deleted' } as const, null as DeletedNote | null)

/** Open pinned notes in every project, worked out again only when the notes change. */
const pinned = derive([notes], list => list.filter(note => note.isPinned && !note.isDone))

/** How long the pane offers to undo a delete. */
const UNDO_MS = 5000

const TAG_COLORS = ['#e5a50a', '#3584e4', '#c061cb', '#2ec27e', '#e66100', '#1c9fb8', '#e01b24']

/** The same tag gets the same color everywhere. */
const colorOf = (tag: string) => {
  let hash = 0
  for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return TAG_COLORS[hash % TAG_COLORS.length]!
}

const projectOf = async ($: EngineInterface) => normalize(await $.session.cwd())

/** The saved notes, each with its tags (a note saved before tags were stored gets them here). */
const fromStore = (saved: unknown) =>
  Array.isArray(saved) ? (saved as Note[]).map(note => (note.tags ? note : tagged(note))) : []

/**
 * Changes the notes, keeps them on disk, and refreshes the status line. Every
 * session shares the one store key, so the change starts from the store as it
 * is now, not this session's copy, which would drop notes another session added.
 */
const change = async ($: EngineInterface, fn: (list: Note[]) => Note[]) => {
  const written = fn([...fromStore(await $.store.get(STORE_KEY))])
  await $.store.set(STORE_KEY, written)
  await update($, notes, () => written)
  $.ui.status(statusFor(written, await projectOf($)))
  return written
}

/**
 * Deletes a note and keeps it for undo: the pane offers an undo button for
 * UNDO_MS, and /notes undo puts it back until the next delete.
 */
const deleteNote = async ($: EngineInterface, id: string) => {
  let removed = null as Pick<DeletedNote, 'note' | 'index'> | null
  await change($, all => {
    const index = all.findIndex(note => note.id === id)
    removed = index < 0 ? null : { note: all[index]!, index }
    return index < 0 ? all : all.filter(note => note.id !== id)
  })
  if (!removed) return
  const { note, index } = removed
  const deleteId = newId()
  await update($, deleted, () => ({ id: deleteId, note, index, isOffered: true }))
  $.ui.toast(`🗑 Deleted: ${preview(note.text)} (undo in the pane, or /notes undo)`, { timeoutMs: UNDO_MS })
  // Hides only this delete's button: a later one, even of the same note, has its own timer.
  $.clock.after(UNDO_MS, () => {
    void update($, deleted, last => (last?.id === deleteId ? { ...last, isOffered: false } : last))
  })
}

/** Puts the last deleted note back where it stood. */
const undoDelete = async ($: EngineInterface) => {
  const last = await read($, deleted)
  if (!last) return 'Nothing to undo.'
  await change($, all =>
    all.some(note => note.id === last.note.id)
      ? all
      : [...all.slice(0, last.index), last.note, ...all.slice(last.index)],
  )
  await update($, deleted, () => null)
  return `📝 Restored: ${preview(last.note.text)}`
}

const addNote = async ($: EngineInterface, text: string, author: Note['author'], where: Scope) => {
  const note = tagged({
    id: newId(),
    text: text.trim(),
    isDone: false,
    isPinned: false,
    author,
    createdAt: Date.now(),
    project: where === 'global' ? null : await projectOf($),
  })
  await change($, list => [...list, note])
  return note
}

const openPane = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: 'claudepad', focus: true })

/**
 * Writes this project's and the global notes to NOTES.md in the session's
 * folder. A NOTES.md this mod did not write is left alone unless `force`.
 */
const exportNotes = async ($: EngineInterface, force: boolean) => {
  const existing = await $.fs.read(EXPORT_FILE).catch(() => undefined)
  if (typeof existing === 'string' && !existing.startsWith(EXPORT_MARK) && !force) {
    return {
      isWritten: false,
      message: `${EXPORT_FILE} already exists and wasn't written by the notepad. Run /notes export --force to replace it.`,
    }
  }
  const project = await projectOf($)
  await $.fs.write(EXPORT_FILE, toMarkdown(await read($, notes), project))
  return { isWritten: true, message: `📝 Exported notes to ${EXPORT_FILE} in ${baseName(project)}.` }
}

/** Reads NOTES.md from the session's folder into the notepad (see mergeImport). */
const importNotes = async ($: EngineInterface, replace: boolean) => {
  const markdown = await $.fs.read(EXPORT_FILE).catch(() => undefined)
  if (typeof markdown !== 'string') {
    return `No ${EXPORT_FILE} in this folder to import.`
  }
  const parsed = parseMarkdown(markdown)
  if (parsed.length === 0) {
    return `${EXPORT_FILE} has no list items to import (notes are lines starting with "- ").`
  }
  const project = await projectOf($)
  let counts = { added: 0, updated: 0, removed: 0 }
  await change($, all => {
    const { list, ...merged } = mergeImport(all, parsed, project, replace, Date.now())
    counts = merged
    return list
  })
  const { added, updated, removed } = counts
  if (replace) {
    return `📝 Replaced ${plural(removed, 'note')} with ${plural(parsed.length, 'note')} from ${EXPORT_FILE}.`
  }
  const unchanged = parsed.length - added - updated
  return `📝 Imported ${EXPORT_FILE}: ${added} added, ${updated} updated, ${unchanged} unchanged.`
}

/** Opens the multi-line editor on a note's text, or on '' for a new note. */
const openEditor = async ($: EngineInterface, id: string, initial: string) => {
  await update($, draft, () => initial)
  await update($, editor, () => ({ id, initial, line: null }))
}

const closeEditor = async ($: EngineInterface) => {
  await update($, editor, () => null)
  await update($, draft, () => '')
}

/** Saves the editor's text (or `text`, the editor's own last word) and closes it. */
const saveEditor = async ($: EngineInterface, text?: string) => {
  const session = await read($, editor)
  if (!session) return 'Nothing to save.'
  // Drop blank lines at the start and whitespace at the end of every line.
  const body = (text ?? (await read($, draft)))
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
  if (body.trim() === '') return 'The note is empty: nothing saved.'
  if (session.id === 'new') {
    await addNote($, body, 'you', await read($, scope))
  } else {
    await change($, all => all.map(note => (note.id === session.id ? tagged({ ...note, text: body }) : note)))
  }
  await closeEditor($)
  return session.id === 'new' ? '📝 Note added.' : '📝 Note saved.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const list = fromStore(await $.store.get(STORE_KEY))
    await update($, notes, () => list)
    const project = await projectOf($)
    await update($, folder, () => project)
    $.ui.status(statusFor(list, project))

    await $.command.register({
      name: 'notes',
      description:
        'Open or close the notepad pane; /notes find <text> searches, /notes tags lists tags, /notes export and /notes import sync NOTES.md, /notes undo restores the last deleted note',
      argumentHint: '[find <text> | tags | export | import | undo]',
    })
    await $.command.register({
      name: 'note',
      description: 'Add a note for this project (-g for a global note, #words become tags)',
      argumentHint: '[-g] <text>',
      immediate: true,
    })
    await $.tool.register({
      name: 'add_note',
      description:
        "Add a note to the user's notepad (a sidebar they keep across sessions). Use it for follow-ups, TODOs or things to remember later that are not worth doing now. Notes belong to the current project unless `global` is true (use global only for things unrelated to this project). Keep each note short and self-contained. Tag notes with #hashtags in the text (for example #bug, #idea, #todo); prefer tags the user already uses, which list_notes reports.",
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note, one or two lines, with any #tags inline.' },
          global: {
            type: 'boolean',
            description: 'True for a note not tied to this project. Default false.',
          },
        },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'list_notes',
      description:
        "List the notes in the user's notepad: this project's notes and the global ones, with whether each is done or pinned. With `query`, search every note (all projects) for notes containing all of its words; a #word in the query matches that tag exactly. Also lists the tags in use.",
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional words to search for, case-insensitive; #tag matches a tag (e.g. "#bug login").',
          },
        },
      },
    })

    return next(e)
  })

  // A new folder has its own notes: recount the status line and redraw the pane.
  on('classic.CwdChanged', async ($, e, next) => {
    const project = normalize(e.new_cwd)
    await update($, folder, () => project)
    $.ui.status(statusFor(await read($, notes), project))
    return next(e)
  })

  // /notes toggles the pane.
  on('command.run', { command: 'notes' }, async ($, e) => {
    const find = /^\s*(find|search)\b\s*/i.exec(e.args)
    if (find) {
      const text = e.args.slice(find[0].length).trim()
      if (text === '') {
        return { text: 'Usage: /notes find <text>' }
      }
      await update($, query, () => text)
      return { text: asText(await read($, notes), await projectOf($), text) }
    }
    const exportArgs = /^\s*export\b(.*)$/i.exec(e.args)
    if (exportArgs) {
      const force = /(^|\s)(-f|--force)(\s|$)/.test(exportArgs[1] ?? '')
      return { text: (await exportNotes($, force)).message }
    }
    const importArgs = /^\s*import\b(.*)$/i.exec(e.args)
    if (importArgs) {
      const replace = /(^|\s)--replace(\s|$)/.test(importArgs[1] ?? '')
      return { text: await importNotes($, replace) }
    }
    if (/^\s*undo\s*$/i.test(e.args)) {
      return { text: await undoDelete($) }
    }
    if (/^\s*tags\s*$/i.test(e.args)) {
      const counts = tagCounts(await read($, notes))
      return {
        text:
          counts.length === 0
            ? 'No tags yet. Add #words to a note, e.g. /note fix login #bug'
            : `Tags: ${counts.map(([tag, n]) => `#${tag} (${n})`).join('  ')}`,
      }
    }
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'Notepad closed.' }
    }
    await openPane($)
    return { text: 'Notepad opened.' }
  })

  // /note <text> adds to this project; /note -g <text> adds a global note.
  on('command.run', { command: 'note' }, async ($, e) => {
    const { text, where } = parseNoteArgs(e.args)
    if (text === '') {
      // A bare /note (or /note -g) opens the multi-line editor on a new note.
      await update($, scope, () => where)
      await openEditor($, 'new', '')
      await openPane($)
      return { text: 'Multi-line editor opened. Or add a quick note with /note <text> (-g for global).' }
    }
    await addNote($, text, 'you', where)
    const label = where === 'global' ? 'global' : baseName(await projectOf($))
    return { text: `📝 Noted (${label}): ${text}` }
  })

  // Claude-aware: pinned notes (this project's and global) ride along with every prompt.
  on('prompt.submit', async ($, e, next) => {
    const project = await projectOf($)
    const shown = (await read($, pinned)).filter(note => isGlobal(note) || isHere(note, project))
    if (shown.length === 0) {
      return next(e)
    }
    const block =
      "The user's pinned notes from their notepad (standing context; keep them in mind):\n" +
      shown
        .map(note => `- ${indented(note.text, '  ')}${isGlobal(note) ? '' : ' (this project)'}`)
        .join('\n')
    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // Claude-aware: tools so Claude can write and read notes.
  on('tool.call', { tool: ADD_TOOL }, async ($, e) => {
    const input = e as unknown as { text?: unknown; global?: unknown }
    const text = String(input.text ?? '').trim()
    if (text === '') {
      return { deny: 'add_note needs non-empty text.' }
    }
    const where: Scope = input.global === true ? 'global' : 'project'
    await addNote($, text, 'claude', where)
    $.ui.toast(`📝 Claude added a ${where === 'global' ? 'global' : 'project'} note: ${text.slice(0, 60)}`)
    return { result: `Added to the notepad (${where}): ${text}` }
  })

  on('tool.call', { tool: LIST_TOOL }, async ($, e) => {
    const search = (e as unknown as { query?: unknown }).query
    return {
      result: asText(await read($, notes), await projectOf($), typeof search === 'string' ? search : ''),
    }
  })

  // The editor surface module posts its text as it changes, and on Ctrl+S.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !e.element.startsWith('editor-')) {
      return next(e)
    }
    const data = e.data as { type?: unknown; text?: unknown } | null
    if (typeof data?.text !== 'string') {
      return {}
    }
    const text = data.text
    if (data.type === 'draft') {
      await update($, draft, () => text)
    } else if (data.type === 'save') {
      $.ui.toast(await saveEditor($, text))
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    // Reading the atom (not just the session) redraws the pane after a directory change.
    const project = (await read($, folder)) || (await projectOf($))
    const list = await read($, notes)
    const where = await read($, scope)

    const session = await read($, editor)
    if (session) {
      const Client = 'Client' in els ? els.Client : undefined
      const isLines = !Client || (await read($, isLineMode))
      const isNew = session.id === 'new'
      const heading = isNew
        ? `✎ New note (${where === 'global' ? 'global' : baseName(project)})`
        : '✎ Editing note'
      const save = async () => $.ui.toast(await saveEditor($))

      // Line mode: the draft as numbered lines, one Input adding or replacing a line.
      const lineView = async () => {
        const text = await read($, draft)
        const all = text === '' ? [] : text.split('\n')
        const setLines = (fn: (lines: string[]) => string[]) =>
          update($, draft, current => fn(current === '' ? [] : current.split('\n')).join('\n'))
        const editLine = (line: number | null) =>
          update($, editor, current => (current ? { ...current, line } : current))
        const target = session.line !== null && session.line < all.length ? session.line : null
        return (
          <Box flexDirection="column">
            {all.length === 0 && <Text dimColor>Empty. Type the first line below and press Enter.</Text>}
            {all.map((line, i) => (
              <Box key={`line-${i}`} gap={1}>
                <Text dimColor={target !== null && target !== i} bold={target === i}>
                  {`${String(i + 1).padStart(String(all.length).length)} │ ${line}`}
                </Text>
                <Button key={`line-edit-${i}`} plain dimColor onPress={() => editLine(i)}>
                  edit
                </Button>
                <Button
                  key={`line-del-${i}`}
                  plain
                  dimColor
                  onPress={async () => {
                    await setLines(lines => lines.filter((_, at) => at !== i))
                    await editLine(null)
                  }}
                >
                  ×
                </Button>
              </Box>
            ))}
            {Input && (
              <Input
                key={target === null ? `line-add-${all.length}` : `line-set-${target}`}
                label={target === null ? `${all.length + 1} + ` : `${target + 1} ✎ `}
                placeholder={target === null ? 'Next line; Enter adds it (empty adds a blank line)' : 'Enter replaces the line; empty deletes it'}
                value={target === null ? '' : all[target] ?? ''}
                submitLabel={target === null ? 'add line' : 'replace'}
                autoFocus
                onSubmit={async value => {
                  if (target === null) {
                    await setLines(lines => [...lines, value])
                  } else {
                    await setLines(lines =>
                      value === '' ? lines.filter((_, at) => at !== target) : lines.map((l, at) => (at === target ? value : l)),
                    )
                    await editLine(null)
                  }
                }}
              />
            )}
            {target !== null && (
              <Button key="line-stop" plain dimColor onPress={() => editLine(null)}>
                back to adding lines
              </Button>
            )}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Text bold>{heading}</Text>
          {isLines || !Client ? (
            await lineView()
          ) : (
            <Box flexDirection="column">
              <Client key={`editor-${session.id}`} module="./editor.tsx" props={{ text: session.initial }} />
              <Text dimColor>
                Click the box to type · Enter new line · Ctrl+S save · arrows, Home/End, PgUp/PgDn move · Esc leaves the box
              </Text>
            </Box>
          )}
          <Box marginTop={1} gap={2}>
            <Button key="editor-save" variant="primary" onPress={save}>
              Save
            </Button>
            <Button key="editor-cancel" role="dismiss" onPress={() => closeEditor($)}>
              Cancel
            </Button>
            {Client && (
              <Button
                key="editor-mode"
                plain
                dimColor
                onPress={async () => {
                  const text = await read($, draft)
                  // Back to the full editor: it reopens on the text as it stands now.
                  await update($, editor, current => (current ? { ...current, initial: text, line: null } : current))
                  await update($, isLineMode, value => !value)
                }}
              >
                {isLines ? 'switch to full editor' : 'switch to line editor'}
              </Button>
            )}
          </Box>
        </Box>
      )
    }

    const search = (await read($, query)).trim()
    const tag = await read($, activeTag)
    const undo = await read($, deleted)
    const isSearching = search !== '' || tag !== null
    const shown = (note: Note) =>
      (search === '' || matches(note, search)) && (tag === null || tagsOfNote(note).includes(tag))

    const allHere = list.filter(note => isHere(note, project))
    const allGlobal = list.filter(isGlobal)
    const here = paneOrder(allHere.filter(shown))
    const global = paneOrder(allGlobal.filter(shown))
    // Only while searching: matches from every other project too.
    const elsewhere = isSearching
      ? paneOrder(list.filter(note => !isGlobal(note) && !isHere(note, project) && shown(note)))
      : []

    const submit = async (value: string) => {
      const text = value.trim()
      if (text !== '') {
        await addNote($, text, 'you', where)
      }
    }

    const toggle = (id: string, field: 'isDone' | 'isPinned') =>
      change($, all => all.map(note => (note.id === id ? { ...note, [field]: !note[field] } : note)))

    const move = (id: string) =>
      change($, all =>
        all.map(note =>
          note.id === id ? { ...note, project: isGlobal(note) ? project : null } : note,
        ),
      )

    /** The note's text with each #tag drawn in its color. */
    const withTags = (text: string, isDone: boolean) => {
      const parts: (string | ReturnType<typeof h>)[] = []
      let at = 0
      for (const m of text.matchAll(TAG)) {
        const start = m.index! + m[1]!.length
        if (start > at) parts.push(text.slice(at, start))
        const word = text.slice(start, m.index! + m[0].length)
        parts.push(
          isDone ? word : <Text color={colorOf(m[2]!.toLowerCase())}>{word}</Text>,
        )
        at = m.index! + m[0].length
      }
      if (at < text.length) parts.push(text.slice(at))
      return parts
    }

    const row = (note: Note) => (
      <Box key={`row-${note.id}`} flexDirection="column" marginTop={1}>
        <Text dimColor={note.isDone} strikethrough={note.isDone} bold={note.isPinned}>
          {note.isDone ? '☑' : '☐'} {note.isPinned ? '📌 ' : ''}
          {note.author === 'claude' ? '🤖 ' : ''}
          {withTags(note.text, note.isDone)}
          {!isGlobal(note) && !isHere(note, project) ? ` (${baseName(note.project ?? '')})` : ''}
        </Text>
        <Box gap={1}>
          <Button key={`done-${note.id}`} plain dimColor onPress={() => toggle(note.id, 'isDone')}>
            {note.isDone ? 'undo' : 'done'}
          </Button>
          <Button key={`pin-${note.id}`} plain dimColor onPress={() => toggle(note.id, 'isPinned')}>
            {note.isPinned ? 'unpin' : 'pin'}
          </Button>
          <Button
            key={`send-${note.id}`}
            plain
            dimColor
            onPress={() => void $.prompt.fill({ text: note.text, mode: 'insert' })}
          >
            → prompt
          </Button>
          <Button key={`edit-${note.id}`} plain dimColor onPress={() => openEditor($, note.id, note.text)}>
            edit
          </Button>
          <Button key={`move-${note.id}`} plain dimColor onPress={() => move(note.id)}>
            {isGlobal(note) ? '→ project' : '→ global'}
          </Button>
          <Button
            key={`del-${note.id}`}
            plain
            dimColor
            onPress={() => deleteNote($, note.id)}
          >
            delete
          </Button>
        </Box>
      </Box>
    )

    const visible = [...here, ...global]
    // Tags of this project's and the global notes; an active tag stays listed even if it empties.
    const tagBar = tagCounts([...allHere, ...allGlobal])
    if (tag !== null && !tagBar.some(([name]) => name === tag)) tagBar.unshift([tag, 0])
    const openCount = (subset: Note[]) => subset.filter(note => !note.isDone).length
    const countLabel = (found: Note[], all: Note[]) =>
      isSearching
        ? `${found.length} of ${plural(all.length, 'note')} match`
        : plural(openCount(all), 'open note')

    return (
      <Box flexDirection="column">
        {Input && (
          <Input
            key={`new-${where}`}
            label={where === 'global' ? '+ global: ' : `+ ${baseName(project)}: `}
            placeholder="Write a note and press Enter"
            value=""
            submitLabel="add"
            autoFocus
            onSubmit={value => void submit(value)}
          />
        )}
        <Box gap={1}>
          <Text dimColor>Add to:</Text>
          <Button
            key="scope-project"
            plain
            dimColor={where !== 'project'}
            onPress={() => update($, scope, () => 'project')}
          >
            {where === 'project' ? '● project' : '○ project'}
          </Button>
          <Button
            key="scope-global"
            plain
            dimColor={where !== 'global'}
            onPress={() => update($, scope, () => 'global')}
          >
            {where === 'global' ? '● global' : '○ global'}
          </Button>
          <Button key="new-multiline" plain onPress={() => openEditor($, 'new', '')}>
            ✎ multi-line note
          </Button>
        </Box>

        {Input && (
          <Box marginTop={1} gap={1}>
            <Input
              key="search"
              label="🔍 "
              placeholder="Search notes"
              value={search}
              submitLabel="search"
              onInput={value => void update($, query, () => value)}
              onSubmit={value => void update($, query, () => value)}
            />
            {search !== '' && (
              <Button key="clear-search" plain dimColor onPress={() => update($, query, () => '')}>
                clear
              </Button>
            )}
          </Box>
        )}

        {tagBar.length > 0 && (
          <Box gap={1} flexWrap="wrap">
            <Text dimColor>Tags:</Text>
            {tagBar.map(([name, n]) => (
              <Button
                key={`tag-${name}`}
                plain
                dimColor={tag !== null && tag !== name}
                onPress={() => update($, activeTag, current => (current === name ? null : name))}
              >
                {`${tag === name ? '● ' : ''}#${name} ${n}`}
              </Button>
            ))}
            {tag !== null && (
              <Button key="clear-tag" plain dimColor onPress={() => update($, activeTag, () => null)}>
                all tags
              </Button>
            )}
          </Box>
        )}

        {undo?.isOffered && (
          <Box marginTop={1} gap={1}>
            <Text dimColor>🗑 Deleted: {preview(undo.note.text)}</Text>
            <Button key="undo-delete" plain onPress={async () => $.ui.toast(await undoDelete($))}>
              undo
            </Button>
          </Box>
        )}

        <Box marginTop={1}>
          <Text bold>📁 {baseName(project)}</Text>
          <Text dimColor> ({countLabel(here, allHere)})</Text>
        </Box>
        {here.length === 0 && (
          <Text dimColor>{isSearching ? 'No matches here.' : 'No notes for this project yet.'}</Text>
        )}
        {here.map(row)}

        <Box marginTop={1}>
          <Text bold>🌐 Global</Text>
          <Text dimColor> ({countLabel(global, allGlobal)})</Text>
        </Box>
        {global.length === 0 && (
          <Text dimColor>{isSearching ? 'No matches here.' : 'No global notes yet. Try /note -g buy milk'}</Text>
        )}
        {global.map(row)}

        {elsewhere.length > 0 && (
          <Box marginTop={1}>
            <Text bold>🗂 Other projects</Text>
            <Text dimColor> ({plural(elsewhere.length, 'match')})</Text>
          </Box>
        )}
        {elsewhere.map(row)}

        <Box marginTop={1} gap={2}>
          <Button
            key="export"
            plain
            dimColor
            onPress={async () => $.ui.toast((await exportNotes($, false)).message)}
          >
            export to NOTES.md
          </Button>
          <Button
            key="import"
            plain
            dimColor
            onPress={async () => $.ui.toast(await importNotes($, false))}
          >
            import from NOTES.md
          </Button>
          {visible.some(note => note.isDone) && (
            <Button
              key="clear-done"
              plain
              dimColor
              onPress={() =>
                change($, all =>
                  all.filter(note => !(note.isDone && (isGlobal(note) || isHere(note, project)))),
                )
              }
            >
              clear done
            </Button>
          )}
        </Box>
      </Box>
    )
  })
}
