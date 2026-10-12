// The notes logic, with no engine or UI: tags, search, folders, ordering,
// the text and Markdown formats, and the NOTES.md import merge.

import type { Note, Scope } from '../types'

/** A tag is `#` then letters, digits, `_` or `-`, at the start or after a space. */
export const TAG = /(^|\s)#([\p{L}\p{N}_-]+)/gu

/** The note's tags, lowercased, each once, without the `#`. */
export const tagsOf = (text: string) => [...new Set([...text.matchAll(TAG)].map(m => m[2]!.toLowerCase()))]

/** The note with its tags stored; call it whenever the text is written. */
export const tagged = (note: Note): Note => ({ ...note, tags: tagsOf(note.text) })

/** The note's stored tags, or its text's for a note saved before tags were stored. */
export const tagsOfNote = (note: Note) => note.tags ?? tagsOf(note.text)

/** Each tag in `list` with how many notes carry it, most used first. */
export const tagCounts = (list: readonly Note[]) => {
  const counts = new Map<string, number>()
  for (const note of list) {
    for (const tag of tagsOfNote(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Every word of the query appears in the note, in any order, any case;
 * a `#word` must be one of the note's tags exactly.
 */
export const matches = (note: Note, text: string) => {
  const haystack = note.text.toLowerCase()
  const tags = tagsOfNote(note)
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word =>
      word.startsWith('#') && word.length > 1 ? tags.includes(word.slice(1)) : haystack.includes(word),
    )
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** One spelling per folder, so `E:\Code\X` and `e:/code/x/` match. */
export const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const baseName = (path: string) => path.split('/').pop() || path

export const isGlobal = (note: Note) => note.project == null

export const isHere = (note: Note, project: string) => note.project === project

export const isArchived = (note: Note) => note.archivedAt != null

/** The notes not archived: what every list, count and export shows. */
export const live = (list: readonly Note[]) => list.filter(note => !isArchived(note))

/** The note marked done or open as of `now`; `doneAt` follows, and stays when nothing changes. */
export const withDone = (note: Note, isDone: boolean, now: number): Note => {
  if (note.isDone === isDone) return note
  const changed: Note = { ...note, isDone }
  if (isDone) changed.doneAt = now
  else delete changed.doneAt
  return changed
}

/** The note out of the archive. */
export const unarchived = (note: Note): Note => {
  const restored = { ...note }
  delete restored.archivedAt
  return restored
}

/** The store key of the global notes; each project's are under `project:` and its folder. */
export const GLOBAL_KEY = 'global'
const PROJECT_PREFIX = 'project:'
/** The old layout: every note under this one key. */
export const LEGACY_KEY = 'notes'
/** The store refuses keys over 256 characters: a longer folder is cut here and hashed. */
const MAX_PATH_IN_KEY = 200

/** FNV-1a over the UTF-16 code units, 32 bits, as 8 hex digits. */
const fnv = (text: string, seed: number) => {
  let hash = seed
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

/** The store key of a project's notes (or the global ones, for null). */
export const keyOfProject = (project: string | null | undefined) =>
  project == null
    ? GLOBAL_KEY
    : project.length <= MAX_PATH_IN_KEY
      ? `${PROJECT_PREFIX}${project}`
      : `${PROJECT_PREFIX}${project.slice(0, MAX_PATH_IN_KEY)}…${fnv(project, 0x811c9dc5)}${fnv(project, 0x9e3779b9)}`

export const keyOf = (note: Note) => keyOfProject(note.project)

/** A store key that holds notes in the per-project layout. */
export const isNotesKey = (key: string) => key === GLOBAL_KEY || key.startsWith(PROJECT_PREFIX)

/** The notes by store key, each key's in list order. */
export const groupByKey = (list: readonly Note[]) => {
  const groups = new Map<string, Note[]>()
  for (const note of list) {
    const key = keyOf(note)
    const group = groups.get(key)
    if (group) group.push(note)
    else groups.set(key, [note])
  }
  return groups
}

/**
 * Folds the old single-key list into the per-key layout. A note already stored
 * under some key keeps that copy; any other joins the end of its key's list.
 * Running it again on what it returned changes nothing.
 */
export const migrate = (legacy: readonly Note[], stored: ReadonlyMap<string, readonly Note[]>) => {
  const result = new Map([...stored].map(([key, list]) => [key, [...list]]))
  const ids = new Set([...stored.values()].flat().map(note => note.id))
  for (const note of legacy) {
    if (ids.has(note.id)) continue
    ids.add(note.id)
    const key = keyOf(note)
    result.set(key, [...(result.get(key) ?? []), note])
  }
  return result
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Continuation lines of a multi-line note, indented to sit under its first line. */
export const indented = (text: string, by: string) => text.replace(/\n/g, `\n${by}`)

/** A note's first line, cut to fit a toast or a pane line. */
export const preview = (text: string) => {
  const first = text.split('\n')[0]!
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

/**
 * A due date in a note: `#due:` then YYYY-MM-DD, ending at a space or
 * punctuation. Its `#due` is an ordinary tag too, so the tag bar finds every
 * dated note.
 */
const DUE = /(?:^|\s)#due:(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}_-])/u

/** The note's due date as YYYY-MM-DD, or undefined when it has none (or not a real date). */
export const dueOf = (text: string) => {
  const m = DUE.exec(text)
  if (!m) return undefined
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

/** A `path:line` (or `path:line:column`) a note mentions, as written. */
export type FileLink = { path: string; line: number; column?: number; text: string }

/**
 * A file reference: a path whose last part has an extension, then `:line`
 * and maybe `:column`, standing alone (after a space or an opening bracket or
 * quote, before a space or punctuation). A drive letter is allowed.
 */
const LINK = /(^|[\s([`'"])((?:[A-Za-z]:)?[\w.~/\\-]*[\w~]\.[A-Za-z0-9]+):(\d+)(?::(\d+))?(?=$|[\s)\]`'",.;!?])/g

/** The file references in a note's text, in order. */
export const linksOf = (text: string): FileLink[] =>
  [...text.matchAll(LINK)].map(m => ({
    path: m[2]!,
    line: Number(m[3]),
    ...(m[4] === undefined ? {} : { column: Number(m[4]) }),
    text: m[0].slice(m[1]!.length),
  }))

/** `path` as an absolute path: as it is when absolute, else under `folder`. */
export const resolvePath = (path: string, folder: string) =>
  /^([A-Za-z]:[\\/]|[\\/])/.test(path) ? path : `${folder.replace(/[\\/]+$/, '')}/${path.replace(/^\.[\\/]/, '')}`

/** The editors a link can open in; the mod's `editor` option picks one. */
export const EDITORS = ['vscode', 'cursor', 'jetbrains'] as const
export type Editor = (typeof EDITORS)[number]

/** The command that opens `path` at the link's line (and column) in `editor`. */
export const editorCommand = (editor: Editor, path: string, link: Pick<FileLink, 'line' | 'column'>) => {
  const at = `${path}:${link.line}${link.column === undefined ? '' : `:${link.column}`}`
  switch (editor) {
    case 'vscode':
      return ['code', '-g', at]
    case 'cursor':
      return ['cursor', '-g', at]
    case 'jetbrains':
      return [
        'idea',
        '--line',
        String(link.line),
        ...(link.column === undefined ? [] : ['--column', String(link.column)]),
        path,
      ]
  }
}

/** The date at `ms` on the local calendar, as YYYY-MM-DD, which compares as text. */
export const localDate = (ms: number) => {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The Monday that starts the local week `ms` falls in, as YYYY-MM-DD. */
export const weekOf = (ms: number) => {
  const date = new Date(ms)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return localDate(date.getTime())
}

/**
 * The done notes by the week they were finished, newest week first and the
 * latest finished first within it. Notes done before `doneAt` was kept come
 * last, under a null week.
 */
export const doneByWeek = (list: readonly Note[]) => {
  const groups = new Map<string | null, Note[]>()
  const done = list.filter(note => note.isDone).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  for (const note of done) {
    const week = note.doneAt === undefined ? null : weekOf(note.doneAt)
    groups.set(week, [...(groups.get(week) ?? []), note])
  }
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b.localeCompare(a)))
}

/** This project's and the global open notes due before `today`, earliest first. */
export const overdue = (list: readonly Note[], project: string, today: string) =>
  live(list)
    .filter(note => !note.isDone && (isGlobal(note) || isHere(note, project)))
    .map(note => ({ note, due: dueOf(note.text) }))
    .filter((item): item is { note: Note; due: string } => item.due !== undefined && item.due < today)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map(item => item.note)

/** The status line: open notes here and global, and how many are overdue when `today` is given. */
export const statusFor = (list: readonly Note[], project: string, today?: string) => {
  const open = live(list).filter(note => !note.isDone)
  const here = open.filter(note => isHere(note, project)).length
  const global = open.filter(isGlobal).length
  if (here === 0 && global === 0) return undefined
  const late = today === undefined ? 0 : overdue(list, project, today).length
  return `📝 ${here} here · ${global} global${late ? ` · ⏰ ${late} overdue` : ''}`
}

/** The pane's order: pinned first, then open before done, then oldest. */
export const paneOrder = (list: readonly Note[]) =>
  [...list].sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      Number(a.isDone) - Number(b.isDone) ||
      a.createdAt - b.createdAt,
  )

/** The export's order: open before done, then pinned first, then oldest. */
export const exportOrder = (list: readonly Note[]) =>
  [...list].sort(
    (a, b) =>
      Number(a.isDone) - Number(b.isDone) ||
      Number(b.isPinned) - Number(a.isPinned) ||
      a.createdAt - b.createdAt,
  )

/**
 * `/note [-g | --global] [--last] [text]`, flags in any order before the
 * text: -g makes a global note, --last saves Claude's last reply (with the
 * text, if any, as its first line).
 */
export const parseNoteArgs = (args: string): { text: string; where: Scope; isLast: boolean } => {
  let rest = args
  let where: Scope = 'project'
  let isLast = false
  for (let flag = /^\s*(-g|--global|--last)(?=\s|$)/.exec(rest); flag; flag = /^\s*(-g|--global|--last)(?=\s|$)/.exec(rest)) {
    if (flag[1] === '--last') isLast = true
    else where = 'global'
    rest = rest.slice(flag[0].length)
  }
  return { text: rest.trim(), where, isLast }
}

/** One line per note (more for a multi-line one), each ending in its id when `withIds`. */
const lines = (list: readonly Note[], withIds: boolean) =>
  list
    .map(
      note =>
        `- [${note.isDone ? 'x' : ' '}]${note.isPinned ? ' (pinned)' : ''} ${indented(note.text, '      ')}` +
        (withIds ? ` (id: ${note.id})` : ''),
    )
    .join('\n')

/**
 * The notes as /notes find and list_notes give them: this project's and
 * global, or a search over all. `withIds` (for Claude's tools) adds each
 * note's id, which complete_note and update_note take.
 */
export const asText = (all: readonly Note[], project: string, search = '', withIds = false) => {
  const list = live(all)
  if (search.trim() !== '') {
    // Oldest first, whatever order the store keys hold the projects in.
    const found = list.filter(note => matches(note, search)).sort((a, b) => a.createdAt - b.createdAt)
    return found.length === 0
      ? `No notes match "${search.trim()}".`
      : `${plural(found.length, 'note')} matching "${search.trim()}":\n` +
          found
            .map(note => {
              const where = isGlobal(note) ? 'global' : isHere(note, project) ? 'this project' : baseName(note.project ?? '')
              return `${lines([note], withIds)} (${where})`
            })
            .join('\n')
  }
  const here = list.filter(note => isHere(note, project))
  const global = list.filter(isGlobal)
  return [
    `Notes for this project (${baseName(project)}):`,
    here.length ? lines(here, withIds) : '(none)',
    '',
    'Global notes:',
    global.length ? lines(global, withIds) : '(none)',
    '',
    `Tags in use: ${tagCounts(list).map(([tag, n]) => `#${tag} (${n})`).join(', ') || '(none)'}`,
  ].join('\n')
}

export const EXPORT_FILE = 'NOTES.md'
/** First line of every export, so a later export knows the file is ours to replace. */
export const EXPORT_MARK = '<!-- exported by the claudepad mod for Claude Code; re-exporting replaces this file -->'

/** This project's and the global notes as a NOTES.md, dated `now`. */
export const toMarkdown = (all: readonly Note[], project: string, now = Date.now()) => {
  const list = live(all)
  // A multi-line note: its first line on the checkbox, the rest indented two
  // spaces beneath (a blank line inside it as two spaces, so it stays inside).
  const item = (note: Note) => {
    const [first = '', ...rest] = note.text.split('\n')
    return [
      `- [${note.isDone ? 'x' : ' '}] ${note.isPinned ? '📌 ' : ''}${first}` +
        (note.author === 'claude' ? ' _(added by Claude)_' : ''),
      ...rest.map(line => `  ${line}`),
    ].join('\n')
  }
  const section = (title: string, subset: Note[]) => [
    `## ${title}`,
    '',
    ...(subset.length ? exportOrder(subset).map(item) : ['_No notes._']),
    '',
  ]
  const here = list.filter(note => isHere(note, project))
  const global = list.filter(isGlobal)
  const tags = tagCounts([...here, ...global])
  return [
    EXPORT_MARK,
    `# Notes: ${baseName(project)}`,
    '',
    `_Exported ${new Date(now).toISOString().slice(0, 10)}. ${plural(here.length, 'project note')}, ${plural(global.length, 'global note')}._`,
    '',
    ...section(baseName(project), here),
    ...section('Global', global),
    ...(tags.length ? ['## Tags', '', tags.map(([tag, n]) => `\`#${tag}\` (${n})`).join(' · '), ''] : []),
  ].join('\n')
}

export type ParsedNote = Pick<Note, 'text' | 'isDone' | 'isPinned' | 'author'> & { where: Scope }

/**
 * Reads the notes out of a NOTES.md: every `- [ ]`/`- [x]` checkbox and every
 * plain `-`/`*` bullet. Items under a `## Global` heading are global, all
 * others belong to the project; a `## Tags` section is skipped. Understands
 * the export's 📌 and "(added by Claude)" marks, and any hand-written list.
 */
export const parseMarkdown = (markdown: string): ParsedNote[] => {
  const found: ParsedNote[] = []
  let where: Scope = 'project'
  let isSkipped = false
  // The item an indented, non-bullet line continues (a multi-line note).
  let current: ParsedNote | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.*)$/.exec(raw)
    if (heading) {
      const title = heading[1]!.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '')
      isSkipped = title === 'tags'
      where = title === 'global' ? 'global' : 'project'
      current = null
      continue
    }
    if (isSkipped) continue
    const item = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*\S)\s*$/.exec(raw)
    if (!item) {
      if (current && /^\s/.test(raw)) {
        current.text += `\n${raw.replace(/^ {1,2}/, '').trimEnd()}`
      } else {
        current = null
      }
      continue
    }
    let text = item[2]!
    const isPinned = text.startsWith('📌')
    if (isPinned) text = text.replace(/^📌\s*/u, '')
    const byClaude = /\s*_\(added by Claude\)_$/.exec(text)
    if (byClaude) text = text.slice(0, byClaude.index)
    text = text.trim()
    if (text === '') {
      current = null
      continue
    }
    current = {
      text,
      isDone: item[1] === 'x' || item[1] === 'X',
      isPinned,
      author: byClaude ? 'claude' : 'you',
      where,
    }
    found.push(current)
  }
  return found.map(note => ({ ...note, text: note.text.trimEnd() }))
}

/** Text as import compares it, so spacing and case changes still match a note. */
const looseText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** A note's scope and loose text, as one key; loose text never holds a newline. */
const importKey = (where: Scope, text: string) => `${where}\n${looseText(text)}`

/**
 * The notes after importing `parsed` into `project`. By default it merges: a
 * note already here (same text and scope) takes the file's done and pinned
 * marks, a new one is added, and nothing is deleted. With `replace`, this
 * project's and the global notes become exactly the file's. New notes are
 * dated from `now`, one millisecond apart, in the file's order.
 */
export const mergeImport = (
  all: readonly Note[],
  parsed: readonly ParsedNote[],
  project: string,
  replace: boolean,
  now: number,
) => {
  const kept = replace ? all.filter(note => !(isGlobal(note) || isHere(note, project))) : all
  const list = [...kept]
  // Where each of this project's and the global notes stands, by key; the
  // first of two alike wins. A note the file adds joins it, so a line the
  // file repeats matches that note.
  const at = new Map<string, number>()
  list.forEach((note, i) => {
    const where: Scope | null = isGlobal(note) ? 'global' : isHere(note, project) ? 'project' : null
    const key = where && importKey(where, note.text)
    if (key && !at.has(key)) at.set(key, i)
  })
  let added = 0
  let updated = 0
  parsed.forEach((item, i) => {
    const key = importKey(item.where, item.text)
    const index = replace ? undefined : at.get(key)
    const match = index === undefined ? undefined : list[index]
    if (index !== undefined && match) {
      // An archived note stays archived: an old file must not bring it back.
      if (!isArchived(match) && (match.isDone !== item.isDone || match.isPinned !== item.isPinned)) {
        list[index] = { ...withDone(match, item.isDone, now), isPinned: item.isPinned }
        updated += 1
      }
      return
    }
    at.set(key, list.length)
    list.push(
      tagged({
        id: newId(),
        text: item.text,
        isDone: item.isDone,
        ...(item.isDone ? { doneAt: now } : {}),
        isPinned: item.isPinned,
        author: item.author,
        createdAt: now + i,
        project: item.where === 'global' ? null : project,
      }),
    )
    added += 1
  })
  return { list, added, updated, removed: all.length - kept.length }
}
