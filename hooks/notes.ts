// The notes logic, with no engine or UI: tags, search, folders, ordering,
// the text and Markdown formats, and the NOTES.md import merge.

import type { Note, Scope } from '../types'

/** A tag is `#` then letters, digits, `_` or `-`, at the start or after a space. */
export const TAG = /(^|\s)#([\p{L}\p{N}_-]+)/gu

/** The note's tags, lowercased, each once, without the `#`. */
export const tagsOf = (text: string) => [...new Set([...text.matchAll(TAG)].map(m => m[2]!.toLowerCase()))]

/** Each tag in `list` with how many notes carry it, most used first. */
export const tagCounts = (list: readonly Note[]) => {
  const counts = new Map<string, number>()
  for (const note of list) {
    for (const tag of tagsOf(note.text)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Every word of the query appears in the note, in any order, any case;
 * a `#word` must be one of the note's tags exactly.
 */
export const matches = (note: Note, text: string) => {
  const haystack = note.text.toLowerCase()
  const tags = tagsOf(note.text)
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

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Continuation lines of a multi-line note, indented to sit under its first line. */
export const indented = (text: string, by: string) => text.replace(/\n/g, `\n${by}`)

/** A note's first line, cut to fit a toast or a pane line. */
export const preview = (text: string) => {
  const first = text.split('\n')[0]!
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

export const statusFor = (list: readonly Note[], project: string) => {
  const here = list.filter(note => isHere(note, project) && !note.isDone).length
  const global = list.filter(note => isGlobal(note) && !note.isDone).length
  if (here === 0 && global === 0) return undefined
  return `📝 ${here} here · ${global} global`
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

/** `/note -g text` or `/note --global text` adds a global note. */
export const parseNoteArgs = (args: string): { text: string; where: Scope } => {
  const match = /^\s*(-g|--global)\s+/.exec(args)
  return match
    ? { text: args.slice(match[0].length).trim(), where: 'global' }
    : { text: args.trim(), where: 'project' }
}

const lines = (list: readonly Note[]) =>
  list
    .map(
      note =>
        `- [${note.isDone ? 'x' : ' '}]${note.isPinned ? ' (pinned)' : ''} ${indented(note.text, '      ')}`,
    )
    .join('\n')

/** The notes as /notes find and list_notes give them: this project's and global, or a search over all. */
export const asText = (list: readonly Note[], project: string, search = '') => {
  if (search.trim() !== '') {
    const found = list.filter(note => matches(note, search))
    return found.length === 0
      ? `No notes match "${search.trim()}".`
      : `${plural(found.length, 'note')} matching "${search.trim()}":\n` +
          found
            .map(note => {
              const where = isGlobal(note) ? 'global' : isHere(note, project) ? 'this project' : baseName(note.project ?? '')
              return `${lines([note])} (${where})`
            })
            .join('\n')
  }
  const here = list.filter(note => isHere(note, project))
  const global = list.filter(isGlobal)
  return [
    `Notes for this project (${baseName(project)}):`,
    here.length ? lines(here) : '(none)',
    '',
    'Global notes:',
    global.length ? lines(global) : '(none)',
    '',
    `Tags in use: ${tagCounts(list).map(([tag, n]) => `#${tag} (${n})`).join(', ') || '(none)'}`,
  ].join('\n')
}

export const EXPORT_FILE = 'NOTES.md'
/** First line of every export, so a later export knows the file is ours to replace. */
export const EXPORT_MARK = '<!-- exported by the claudepad mod for Claude Code; re-exporting replaces this file -->'

/** This project's and the global notes as a NOTES.md, dated `now`. */
export const toMarkdown = (list: readonly Note[], project: string, now = Date.now()) => {
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

/** Text compared loosely, so spacing and case changes still match a note. */
export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()

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
  const inScope = (note: Note, where: Scope) => (where === 'global' ? isGlobal(note) : isHere(note, project))
  const kept = replace ? all.filter(note => !(isGlobal(note) || isHere(note, project))) : all
  const list = [...kept]
  let added = 0
  let updated = 0
  parsed.forEach((item, i) => {
    const at = replace ? -1 : list.findIndex(note => inScope(note, item.where) && sameText(note.text, item.text))
    const match = list[at]
    if (match) {
      if (match.isDone !== item.isDone || match.isPinned !== item.isPinned) {
        list[at] = { ...match, isDone: item.isDone, isPinned: item.isPinned }
        updated += 1
      }
      return
    }
    list.push({
      id: newId(),
      text: item.text,
      isDone: item.isDone,
      isPinned: item.isPinned,
      author: item.author,
      createdAt: now + i,
      project: item.where === 'global' ? null : project,
    })
    added += 1
  })
  return { list, added, updated, removed: all.length - kept.length }
}
