import { expect, test } from 'claude-code/testing'

import {
  dueOf,
  editorCommand,
  exportOrder,
  groupByKey,
  keyOfProject,
  linksOf,
  localDate,
  mergeImport,
  migrate,
  overdue,
  normalize,
  paneOrder,
  parseMarkdown,
  parseNoteArgs,
  matches,
  preview,
  resolvePath,
  statusFor,
  tagCounts,
  tagged,
  toMarkdown,
} from '../hooks/notes'
import type { Note } from '../types'

// hooks/notes.ts directly, for what the command-level tests in notes.test.ts
// cannot pin down: exact orders, dates, merge counts.

const note = (text: string, fields: Partial<Note> = {}): Note => ({
  id: text,
  text,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt: 0,
  project: '/work/demo',
  ...fields,
})

test('the pane puts pinned first, the export puts open first', () => {
  const list = [
    note('old done pinned', { isDone: true, isPinned: true, createdAt: 1 }),
    note('new open', { createdAt: 3 }),
    note('old open', { createdAt: 2 }),
  ]
  expect(paneOrder(list).map(n => n.text)).toEqual(['old done pinned', 'old open', 'new open'])
  expect(exportOrder(list).map(n => n.text)).toEqual(['old open', 'new open', 'old done pinned'])
  // Neither sorts in place.
  expect(list[0]!.text).toBe('old done pinned')
})

test('the export is dated by the time it is given', () => {
  const markdown = toMarkdown([note('one')], '/work/demo', Date.UTC(2026, 9, 12, 12))
  expect(markdown.split('\n')[3]).toBe('_Exported 2026-10-12. 1 project note, 0 global notes._')
})

test('merge counts added, updated and removed, and dates new notes in file order', () => {
  const all = [
    note('keep', { isDone: false }),
    note('global', { project: null }),
    note('other', { project: '/work/other' }),
  ]
  const parsed = parseMarkdown('- [x] KEEP\n- new one\n- new two\n')

  const merged = mergeImport(all, parsed, '/work/demo', false, 1000)
  expect([merged.added, merged.updated, merged.removed]).toEqual([2, 1, 0])
  expect(merged.list.map(n => [n.text, n.isDone, n.createdAt])).toEqual([
    ['keep', true, 0],
    ['global', false, 0],
    ['other', false, 0],
    ['new one', false, 1001],
    ['new two', false, 1002],
  ])
  // The input list is left alone.
  expect(all[0]!.isDone).toBe(false)

  const replaced = mergeImport(all, parsed, '/work/demo', true, 1000)
  expect([replaced.added, replaced.updated, replaced.removed]).toEqual([3, 0, 2])
  expect(replaced.list.map(n => n.text)).toEqual(['other', 'KEEP', 'new one', 'new two'])
})

test('tags are stored with a note, and read from the text when a note has none stored', () => {
  expect(tagged(note('fix #Bug and #bug #ui-x')).tags).toEqual(['bug', 'ui-x'])
  // Search and counts read the stored tags...
  const stored = { ...note('plain text'), tags: ['kept'] }
  expect(matches(stored, '#kept')).toBe(true)
  // ...and fall back to the text for an old note.
  const old = note('old #Legacy')
  expect(old.tags).toBeUndefined()
  expect(matches(old, '#legacy')).toBe(true)
  expect(tagCounts([stored, old, tagged(note('again #legacy'))])).toEqual([
    ['legacy', 2],
    ['kept', 1],
  ])
})

test('merge matches through its key map as a scan would: first alike wins, repeats merge', () => {
  const all = [note('twin', { id: 'first' }), note('twin', { id: 'second' }), note('twin', { project: null })]
  const parsed = parseMarkdown('- [x] Twin\n- new #Tag\n- NEW  #tag\n## Global\n- twin\n')
  const merged = mergeImport(all, parsed, '/work/demo', false, 0)
  expect([merged.added, merged.updated]).toEqual([1, 1])
  expect(merged.list.map(n => [n.id === 'first' || n.id === 'second' ? n.id : n.text, n.isDone])).toEqual([
    ['first', true],
    ['second', false],
    ['twin', false],
    ['new #Tag', false],
  ])
  // A note the import adds carries its tags.
  expect(merged.list[3]!.tags).toEqual(['tag'])
})

test('a store key fits the 256-character key limit, however long the folder', () => {
  expect(keyOfProject(null)).toBe('global')
  expect(keyOfProject('e:/code/x')).toBe('project:e:/code/x')
  const long = `/${'d'.repeat(300)}`
  const key = keyOfProject(long)
  expect(key.length).toBeLessThanOrEqual(256)
  expect(key.startsWith(`project:/${'d'.repeat(199)}…`)).toBe(true)
  // Long folders that share the first 200 characters still get their own keys.
  expect(keyOfProject(`${long}x`)).not.toBe(key)
  expect(keyOfProject(long)).toBe(key)
})

test('migrate folds the old list into per-key lists, and again changes nothing', () => {
  const legacy = [note('a1'), note('g1', { project: null }), note('a2')]
  const once = migrate(legacy, new Map())
  expect([...once].map(([key, list]) => [key, list.map(n => n.id)])).toEqual([
    ['project:/work/demo', ['a1', 'a2']],
    ['global', ['g1']],
  ])
  expect(migrate(legacy, once)).toEqual(once)
  // A note already stored keeps its stored copy, even under another key.
  const moved = new Map([['global', [note('a1', { project: null, text: 'moved' })]]])
  expect([...migrate(legacy, moved)].map(([key, list]) => [key, list.map(n => n.text)])).toEqual([
    ['global', ['moved', 'g1']],
    ['project:/work/demo', ['a2']],
  ])
  expect([...groupByKey(legacy).keys()]).toEqual(['project:/work/demo', 'global'])
})

test('status counts open notes here and global, and is empty with none', () => {
  const list = [
    note('here'),
    note('here done', { isDone: true }),
    note('global', { project: null }),
    note('elsewhere', { project: '/work/other' }),
  ]
  expect(statusFor(list, '/work/demo')).toBe('📝 1 here · 1 global')
  expect(statusFor([note('elsewhere', { project: '/work/other' })], '/work/demo')).toBeUndefined()
})

test('small helpers: folder spelling, /note flags, previews', () => {
  expect(normalize('E:\\Code\\Demo\\')).toBe('e:/code/demo')
  expect(parseNoteArgs('-g  milk ')).toEqual({ text: 'milk', where: 'global', isLast: false })
  expect(parseNoteArgs('-gx milk')).toEqual({ text: '-gx milk', where: 'project', isLast: false })
  expect(parseNoteArgs('--last -g #idea')).toEqual({ text: '#idea', where: 'global', isLast: true })
  expect(parseNoteArgs('-g --last')).toEqual({ text: '', where: 'global', isLast: true })
  // Flags count only before the text.
  expect(parseNoteArgs('see --last -g')).toEqual({ text: 'see --last -g', where: 'project', isLast: false })
  expect(preview('first\nsecond')).toBe('first')
  expect(preview('x'.repeat(61))).toBe(`${'x'.repeat(59)}…`)
})

test('a due date is #due: and a real YYYY-MM-DD date', () => {
  expect(dueOf('call the bank #due:2026-10-20')).toBe('2026-10-20')
  expect(dueOf('#due:2026-10-20, then relax')).toBe('2026-10-20')
  expect(dueOf('no date #due')).toBeUndefined()
  expect(dueOf('not a day #due:2026-02-30')).toBeUndefined()
  expect(dueOf('glued #due:2026-10-20x')).toBeUndefined()
  expect(dueOf('mid-word a#due:2026-10-20')).toBeUndefined()
  expect(localDate(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
})

test('overdue: open notes here and global due before today, earliest first; status counts them', () => {
  const list = [
    note('later #due:2026-10-30'),
    note('today #due:2026-10-12'),
    note('late #due:2026-10-10'),
    note('later still', { project: null }),
    note('global late #due:2026-10-01', { project: null }),
    note('done late #due:2026-10-01', { isDone: true }),
    note('elsewhere late #due:2026-10-01', { project: '/work/other' }),
  ]
  expect(overdue(list, '/work/demo', '2026-10-12').map(n => n.text)).toEqual([
    'global late #due:2026-10-01',
    'late #due:2026-10-10',
  ])
  expect(statusFor(list, '/work/demo', '2026-10-12')).toBe('📝 3 here · 2 global · ⏰ 2 overdue')
  expect(statusFor(list, '/work/demo')).toBe('📝 3 here · 2 global')
})

test('a file reference is a path with an extension, then :line and maybe :column', () => {
  expect(linksOf('see hooks/register.tsx:42, then (E:\\Code\\x.ts:3:7) and `README.md:1`')).toEqual([
    { path: 'hooks/register.tsx', line: 42, text: 'hooks/register.tsx:42' },
    { path: 'E:\\Code\\x.ts', line: 3, column: 7, text: 'E:\\Code\\x.ts:3:7' },
    { path: 'README.md', line: 1, text: 'README.md:1' },
  ])
  // Not references: no extension, a URL, a time, a line number glued to more.
  expect(linksOf('localhost:3000 https://x.dev/a.ts:3 at 10:30 a.ts:12b Makefile:3')).toEqual([])
})

test('a reference resolves under the note folder unless absolute, and opens in the chosen editor', () => {
  expect(resolvePath('src/a.ts', 'E:\\Code\\X\\')).toBe('E:\\Code\\X/src/a.ts')
  expect(resolvePath('./a.ts', '/work/demo')).toBe('/work/demo/a.ts')
  expect(resolvePath('/etc/a.conf', '/work/demo')).toBe('/etc/a.conf')
  expect(resolvePath('C:/b.ts', '/work/demo')).toBe('C:/b.ts')

  expect(editorCommand('vscode', '/w/a.ts', { line: 4 })).toEqual(['code', '-g', '/w/a.ts:4'])
  expect(editorCommand('cursor', '/w/a.ts', { line: 4, column: 2 })).toEqual(['cursor', '-g', '/w/a.ts:4:2'])
  expect(editorCommand('jetbrains', '/w/a.ts', { line: 4, column: 2 })).toEqual([
    'idea', '--line', '4', '--column', '2', '/w/a.ts',
  ])
})
