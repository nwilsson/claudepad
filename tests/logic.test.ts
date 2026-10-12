import { expect, test } from 'claude-code/testing'

import {
  exportOrder,
  mergeImport,
  normalize,
  paneOrder,
  parseMarkdown,
  parseNoteArgs,
  preview,
  statusFor,
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
  expect(parseNoteArgs('-g  milk ')).toEqual({ text: 'milk', where: 'global' })
  expect(parseNoteArgs('-gx milk')).toEqual({ text: '-gx milk', where: 'project' })
  expect(preview('first\nsecond')).toBe('first')
  expect(preview('x'.repeat(61))).toBe(`${'x'.repeat(59)}…`)
})
