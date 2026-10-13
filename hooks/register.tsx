import { atom, derive, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArchiveUndo, EditorSession, Note, Scope } from '../types'
import type { Editor, FileLink } from './notes'
import {
  EDITORS,
  EXPORT_FILE,
  EXPORT_MARK,
  GLOBAL_KEY,
  LEGACY_KEY,
  TAG,
  asText,
  baseName,
  doneByWeek,
  dueOf,
  editorCommand,
  groupByKey,
  indented,
  isGlobal,
  isHere,
  isArchived,
  isNotesKey,
  keyOf,
  keyOfProject,
  linksOf,
  live,
  localDate,
  matches,
  mergeImport,
  migrate,
  newId,
  normalize,
  overdue,
  paneOrder,
  parseMarkdown,
  parseNoteArgs,
  plural,
  preview,
  resolvePath,
  statusFor,
  tagCounts,
  tagged,
  tagsOfNote,
  toMarkdown,
  unarchived,
  withDone,
} from './notes'

const PANE = 'claudepad'
const ADD_TOOL = 'mcp__claudepad__add_note'
const LIST_TOOL = 'mcp__claudepad__list_notes'
const COMPLETE_TOOL = 'mcp__claudepad__complete_note'
const UPDATE_TOOL = 'mcp__claudepad__update_note'

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
const lastArchive = atom({ plugin: 'claudepad', key: 'lastArchive' } as const, null as ArchiveUndo | null)
const isArchiveView = atom({ plugin: 'claudepad', key: 'isArchiveView' } as const, false)
const isByDue = atom({ plugin: 'claudepad', key: 'isByDue' } as const, false)

/** Open pinned notes in every project, worked out again only when the notes change. */
const pinned = derive([notes], list => live(list).filter(note => note.isPinned && !note.isDone))

/** How long the pane offers to undo an archive. */
const UNDO_MS = 5000

/** The most open buttons one note gets, one per file it mentions. */
const MAX_LINKS = 3

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
 * Reads every note from the store into the session, and refreshes the status
 * line for `project`. Notes still under the old single key move to their
 * per-project keys.
 */
const reload = async ($: EngineInterface, project: string) => {
  const keys = await $.store.keys()
  const stored = new Map<string, Note[]>()
  for (const key of keys.filter(isNotesKey)) stored.set(key, fromStore(await $.store.get(key)))
  let byKey: ReadonlyMap<string, Note[]> = stored
  if (keys.includes(LEGACY_KEY)) {
    byKey = migrate(fromStore(await $.store.get(LEGACY_KEY)), stored)
    for (const [key, list] of byKey) {
      // `migrate` only adds, so a key it left alone has as many notes as before.
      if (list.length !== stored.get(key)?.length) await $.store.set(key, list)
    }
    await $.store.delete(LEGACY_KEY)
  }
  const all = [...byKey.values()].flat()
  await update($, notes, () => all)
  $.ui.status(statusFor(all, project, localDate(Date.now())))
}

/**
 * Changes the notes stored under `keys`, and refreshes the status line. It
 * starts from the store as it is now, not this session's copy, so a note
 * another session added there survives; and it reads and writes only those
 * keys, so changes to other projects never meet. `fn` gets those keys' notes
 * and may return only notes that belong under them.
 */
const change = async ($: EngineInterface, keys: readonly string[], fn: (list: Note[]) => Note[]) => {
  const touched = [...new Set(keys)]
  const before: Note[] = []
  for (const key of touched) before.push(...fromStore(await $.store.get(key)))
  const written = fn(before)
  const groups = groupByKey(written)
  const stray = [...groups.keys()].find(key => !touched.includes(key))
  if (stray !== undefined) {
    throw new Error(`claudepad: a change returned a note for ${stray}, outside ${touched.join(', ')}`)
  }
  for (const key of touched) {
    const list = groups.get(key)
    await (list ? $.store.set(key, list) : $.store.delete(key))
  }
  const all = await update($, notes, current => [
    ...current.filter(note => !touched.includes(keyOf(note))),
    ...written,
  ])
  $.ui.status(statusFor(all, await projectOf($), localDate(Date.now())))
  return written
}

/**
 * Changes one note, under the key this session last saw it in; resolves to the
 * note as written, or undefined when there is no such note (any longer).
 */
const changeNote = async ($: EngineInterface, id: string, fn: (note: Note) => Note) => {
  const seen = (await read($, notes)).find(note => note.id === id)
  if (!seen) return undefined
  const written = await change($, [keyOf(seen)], all => all.map(note => (note.id === id ? fn(note) : note)))
  return written.find(note => note.id === id)
}

/** Changes the notes with these ids, across whichever keys they are under. */
const changeNotes = async ($: EngineInterface, ids: readonly string[], fn: (note: Note) => Note) => {
  const seen = (await read($, notes)).filter(note => ids.includes(note.id))
  if (seen.length === 0) return []
  const written = await change($, seen.map(keyOf), all => all.map(note => (ids.includes(note.id) ? fn(note) : note)))
  return written.filter(note => ids.includes(note.id))
}

/**
 * Archives notes and keeps them for undo: the pane offers an undo button for
 * UNDO_MS, and /notes undo restores them until the next archive. `label` says
 * what was archived, for the toast and the pane.
 */
const archiveNotes = async ($: EngineInterface, ids: readonly string[], label: string) => {
  const now = Date.now()
  const archived = await changeNotes($, ids, note => (isArchived(note) ? note : { ...note, archivedAt: now }))
  if (archived.length === 0) return
  const archiveId = newId()
  const noteIds = archived.map(note => note.id)
  await update($, lastArchive, () => ({ id: archiveId, noteIds, label, isOffered: true }))
  $.ui.toast(`🗄 Archived: ${label} (undo in the pane, or /notes undo)`, { timeoutMs: UNDO_MS })
  // Hides only this archive's button: a later one, even of the same note, has its own timer.
  $.clock.after(UNDO_MS, () => {
    void update($, lastArchive, last => (last?.id === archiveId ? { ...last, isOffered: false } : last))
  })
}

/** Takes the last archive's notes out of the archive again. */
const undoArchive = async ($: EngineInterface) => {
  const last = await read($, lastArchive)
  if (!last) return 'Nothing to undo.'
  await changeNotes($, last.noteIds, unarchived)
  await update($, lastArchive, () => null)
  return `📝 Restored: ${last.label}`
}

/** Deletes an archived note for good: the only delete there is. */
const purgeNote = async ($: EngineInterface, id: string) => {
  const seen = (await read($, notes)).find(note => note.id === id)
  if (!seen || !isArchived(seen)) return
  await change($, [keyOf(seen)], all => all.filter(note => note.id !== id))
  await update($, lastArchive, last => (last ? { ...last, noteIds: last.noteIds.filter(other => other !== id) } : last))
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
  await change($, [keyOf(note)], list => [...list, note])
  return note
}

/**
 * Saves Claude's last reply in the main conversation (its last message with
 * text) as a note of yours, with `text`, if any, as the first line.
 */
const saveLastReply = async ($: EngineInterface, text: string, where: Scope) => {
  const rows = await $.session.messages()
  const reply = rows.findLast(row => row.role === 'assistant' && row.text.trim() !== '')?.text.trim()
  if (reply === undefined) return 'No reply from Claude yet to save.'
  await addNote($, text === '' ? reply : `${text}\n\n${reply}`, 'you', where)
  return `📝 Saved Claude's last reply as a ${where === 'global' ? 'global' : 'project'} note: ${preview(reply)}`
}

/**
 * Opens a file a note mentions in `editor`. A relative path is under the
 * note's own folder: the session's, spelled as the host spells it, for this
 * project's and the global notes. A failure is a toast.
 */
const openLink = async ($: EngineInterface, editor: Editor, note: Note, link: FileLink) => {
  const here = await $.session.cwd()
  const folder = isGlobal(note) || isHere(note, normalize(here)) ? here : note.project!
  const argv = editorCommand(editor, resolvePath(link.path, folder), link)
  const failed = (why: string) => $.ui.toast(`Couldn't open ${link.text} with ${argv[0]}: ${why}`)
  try {
    const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 15000 })
    if (exitCode !== 0) failed(stderr.trim().split('\n')[0] || `exit code ${exitCode}`)
  } catch (err) {
    failed(err instanceof Error ? err.message : String(err))
  }
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
  await change($, [keyOfProject(project), GLOBAL_KEY], all => {
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
    await changeNote($, session.id, note => tagged({ ...note, text: body }))
  }
  await closeEditor($)
  return session.id === 'new' ? '📝 Note added.' : '📝 Note saved.'
}

export const register: Register = (on, options) => {
  // The mod's `editor` option: which editor a note's file reference opens in.
  const linkEditor: Editor = EDITORS.find(name => name === options.editor) ?? 'vscode'

  on('session.start', async ($, e, next) => {
    const project = await projectOf($)
    await update($, folder, () => project)
    await reload($, project)
    // Overdue notes, here and global, are the first thing the session shows.
    const late = overdue(await read($, notes), project, localDate(Date.now()))
    if (late.length === 1) {
      $.ui.toast(`⏰ Overdue: ${preview(late[0]!.text)}`, { timeoutMs: 8000 })
    } else if (late.length > 1) {
      const more = late.length > 3 ? ` · and ${late.length - 3} more` : ''
      const shown = late.slice(0, 3).map(note => preview(note.text))
      $.ui.toast(`⏰ ${late.length} overdue notes: ${shown.join(' · ')}${more}`, { timeoutMs: 8000 })
    }

    await $.command.register({
      name: 'notes',
      description:
        'Open or close the notepad pane; /notes find <text> searches, /notes tags lists tags, /notes export and /notes import sync NOTES.md, /notes undo restores the last archived notes',
      argumentHint: '[find <text> | tags | export | import | undo]',
    })
    await $.command.register({
      name: 'note',
      description:
        "Add a note for this project (-g for a global note, #words become tags; --last saves Claude's last reply)",
      argumentHint: '[-g] [--last] <text>',
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
        "List the notes in the user's notepad: this project's notes and the global ones, with whether each is done or pinned, and each note's id (for complete_note and update_note). A note with a #due:YYYY-MM-DD date is marked (overdue) or (due today) while open, and a list with dated notes ends with today's date. With `query`, search every note (all projects) for notes containing all of its words; a #word in the query matches that tag exactly. Also lists the tags in use.",
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
    await $.tool.register({
      name: 'complete_note',
      description:
        "Mark a note in the user's notepad done, for example a TODO you have just finished, or (with `done: false`) open again. Take the id from list_notes or add_note. Only mark a note done when the work it describes is actually finished.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: "The note's id, as list_notes shows it." },
          done: { type: 'boolean', description: 'False to reopen a done note. Default true.' },
        },
        required: ['id'],
      },
    })
    await $.tool.register({
      name: 'update_note',
      description:
        "Replace the text of a note in the user's notepad, for example to record progress or correct it. Take the id from list_notes or add_note. Keep the note's #tags unless they no longer apply.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: "The note's id, as list_notes shows it." },
          text: { type: 'string', description: 'The new text, with any #tags inline.' },
        },
        required: ['id', 'text'],
      },
    })

    return next(e)
  })

  // A new folder has its own notes: read them fresh (other sessions may have
  // written since), recount the status line and redraw the pane.
  on('classic.CwdChanged', async ($, e, next) => {
    const project = normalize(e.new_cwd)
    await update($, folder, () => project)
    await reload($, project)
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
      return { text: asText(await read($, notes), await projectOf($), text, false, localDate(Date.now())) }
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
      return { text: await undoArchive($) }
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
    const { text, where, isLast } = parseNoteArgs(e.args)
    if (isLast) {
      return { text: await saveLastReply($, text, where) }
    }
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
    const note = await addNote($, text, 'claude', where)
    $.ui.toast(`📝 Claude added a ${where === 'global' ? 'global' : 'project'} note: ${text.slice(0, 60)}`)
    return { result: `Added to the notepad (${where}): ${text} (id: ${note.id})` }
  })

  on('tool.call', { tool: LIST_TOOL }, async ($, e) => {
    const search = (e as unknown as { query?: unknown }).query
    return {
      result: asText(
        await read($, notes),
        await projectOf($),
        typeof search === 'string' ? search : '',
        true,
        localDate(Date.now()),
      ),
    }
  })

  on('tool.call', { tool: COMPLETE_TOOL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; done?: unknown }
    const id = String(input.id ?? '').trim()
    const isDone = input.done !== false
    const note = await changeNote($, id, found => withDone(found, isDone, Date.now()))
    if (!note) {
      return { deny: `No note with id "${id}". list_notes shows each note's id.` }
    }
    const what = isDone ? 'done' : 'open again'
    $.ui.toast(`📝 Claude marked a note ${what}: ${preview(note.text)}`)
    return { result: `Marked ${what}: ${preview(note.text)}` }
  })

  on('tool.call', { tool: UPDATE_TOOL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; text?: unknown }
    const id = String(input.id ?? '').trim()
    const text = String(input.text ?? '').trim()
    if (text === '') {
      return { deny: 'update_note needs non-empty text.' }
    }
    const note = await changeNote($, id, found => tagged({ ...found, text }))
    if (!note) {
      return { deny: `No note with id "${id}". list_notes shows each note's id.` }
    }
    $.ui.toast(`📝 Claude updated a note: ${preview(note.text)}`)
    return { result: `Updated the note (id: ${note.id}): ${note.text}` }
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

    const undo = await read($, lastArchive)
    const undoLine = undo?.isOffered && (
      <Box marginTop={1} gap={1}>
        <Text dimColor>🗄 Archived: {undo.label}</Text>
        <Button key="undo-archive" plain onPress={async () => $.ui.toast(await undoArchive($))}>
          undo
        </Button>
      </Box>
    )
    // This project's and the global notes, archived ones included.
    const scoped = list.filter(note => isGlobal(note) || isHere(note, project))

    if (await read($, isArchiveView)) {
      const weeks = doneByWeek(scoped)
      const shelved = paneOrder(scoped.filter(note => isArchived(note) && !note.isDone))
      const archiveRow = (note: Note) => (
        <Box key={`arow-${note.id}`} gap={1}>
          <Text dimColor={isArchived(note)}>
            {`${note.isDone ? '☑' : '☐'} ${preview(note.text)}${isGlobal(note) ? ' (global)' : ''}${isArchived(note) ? ' · archived' : ''}`}
          </Text>
          {isArchived(note)
            ? [
                <Button key={`restore-${note.id}`} plain dimColor onPress={() => changeNotes($, [note.id], unarchived)}>
                  restore
                </Button>,
                <Button key={`purge-${note.id}`} plain dimColor onPress={() => purgeNote($, note.id)}>
                  delete for good
                </Button>,
              ]
            : [
                <Button
                  key={`archive-${note.id}`}
                  plain
                  dimColor
                  onPress={() => archiveNotes($, [note.id], preview(note.text))}
                >
                  archive
                </Button>,
              ]}
        </Box>
      )
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            <Text bold>🗄 Archive: {baseName(project)} and global</Text>
            <Button key="archive-back" plain onPress={() => update($, isArchiveView, () => false)}>
              ← back to notes
            </Button>
          </Box>
          {undoLine}
          {weeks.length === 0 && shelved.length === 0 && <Text dimColor>Nothing done or archived yet.</Text>}
          {weeks.map(([week, done]) => (
            <Box key={`week-${week ?? 'earlier'}`} flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>{week === null ? 'Earlier' : `Week of ${week}`}</Text>
                <Text dimColor> ({plural(done.length, 'note')} done)</Text>
              </Box>
              {done.map(archiveRow)}
            </Box>
          ))}
          {shelved.length > 0 && (
            <Box marginTop={1}>
              <Text bold>Archived, not done</Text>
            </Box>
          )}
          {shelved.map(archiveRow)}
        </Box>
      )
    }

    const search = (await read($, query)).trim()
    const tag = await read($, activeTag)
    const isSearching = search !== '' || tag !== null
    const shown = (note: Note) =>
      (search === '' || matches(note, search)) && (tag === null || tagsOfNote(note).includes(tag))

    // The lists show live notes; archived ones are in the archive view.
    const current = live(list)
    const allHere = current.filter(note => isHere(note, project))
    const allGlobal = current.filter(isGlobal)
    const byDue = await read($, isByDue)
    const here = paneOrder(allHere.filter(shown), byDue)
    const global = paneOrder(allGlobal.filter(shown), byDue)
    // Only while searching: matches from every other project too.
    const elsewhere = isSearching
      ? paneOrder(
          current.filter(note => !isGlobal(note) && !isHere(note, project) && shown(note)),
          byDue,
        )
      : []
    // The sort choice shows once a note here or global has a due date (or while sorting by one).
    const isDated = byDue || [...allHere, ...allGlobal].some(note => dueOf(note.text) !== undefined)

    const submit = async (value: string) => {
      const text = value.trim()
      if (text !== '') {
        await addNote($, text, 'you', where)
      }
    }

    const toggle = (id: string, field: 'isDone' | 'isPinned') =>
      changeNote($, id, note =>
        field === 'isDone' ? withDone(note, !note.isDone, Date.now()) : { ...note, isPinned: !note.isPinned },
      )

    // A global note moves to this project; any other to global. The change spans both keys.
    const move = (moved: Note) => {
      const to = isGlobal(moved) ? project : null
      return change($, [keyOf(moved), keyOfProject(to)], all =>
        all.map(note => (note.id === moved.id ? { ...note, project: to } : note)),
      )
    }

    const today = localDate(Date.now())

    /**
     * The note's text with each #tag drawn in its color. A `#due:` date is
     * drawn whole: red once overdue, amber on the day.
     */
    const withTags = (text: string, isDone: boolean) => {
      const parts: (string | ReturnType<typeof h>)[] = []
      let at = 0
      for (const m of text.matchAll(TAG)) {
        const start = m.index! + m[1]!.length
        if (start > at) parts.push(text.slice(at, start))
        const tag = m[2]!.toLowerCase()
        let end = m.index! + m[0].length
        const date = tag === 'due' ? /^:(\d{4}-\d{2}-\d{2})/.exec(text.slice(end))?.[1] : undefined
        if (date) end += date.length + 1
        const word = text.slice(start, end)
        const color = date && date < today ? '#e01b24' : date === today ? '#e5a50a' : colorOf(tag)
        parts.push(isDone ? word : <Text color={color} bold={date !== undefined && date <= today}>{word}</Text>)
        at = end
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
          <Button key={`move-${note.id}`} plain dimColor onPress={() => move(note)}>
            {isGlobal(note) ? '→ project' : '→ global'}
          </Button>
          {linksOf(note.text)
            .slice(0, MAX_LINKS)
            .map((link, i) => (
              <Button key={`open-${note.id}-${i}`} plain dimColor onPress={() => openLink($, linkEditor, note, link)}>
                {`open ${baseName(link.path.replace(/\\/g, '/'))}:${link.line}`}
              </Button>
            ))}
          <Button
            key={`archive-${note.id}`}
            plain
            dimColor
            onPress={() => archiveNotes($, [note.id], preview(note.text))}
          >
            archive
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
          <Button key="save-last" plain onPress={async () => $.ui.toast(await saveLastReply($, '', where))}>
            ↓ Claude's last reply
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

        {isDated && (
          <Box gap={1}>
            <Text dimColor>Sort:</Text>
            <Button key="sort-added" plain dimColor={byDue} onPress={() => update($, isByDue, () => false)}>
              {byDue ? '○ added' : '● added'}
            </Button>
            <Button key="sort-due" plain dimColor={!byDue} onPress={() => update($, isByDue, () => true)}>
              {byDue ? '● due' : '○ due'}
            </Button>
          </Box>
        )}

        {undoLine}

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
              onPress={() => {
                const done = [...allHere, ...allGlobal].filter(note => note.isDone)
                return archiveNotes($, done.map(note => note.id), plural(done.length, 'done note'))
              }}
            >
              clear done
            </Button>
          )}
          <Button key="archive-view" plain dimColor onPress={() => update($, isArchiveView, () => true)}>
            {`🗄 archive (${scoped.filter(isArchived).length})`}
          </Button>
        </Box>
      </Box>
    )
  })
}
