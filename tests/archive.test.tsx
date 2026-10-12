import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { weekOf } from '../hooks/notes'
import type { Note } from '../types'

const PANE = {
  plugin: 'claudepad',
  component: 'Pane',
  requestId: 'claudepad',
  surface: 'terminal',
  props: {
    title: 'claudepad',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
  } as never,
} as const

/** The project's open notes in saved order, from list_notes. */
const listed = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result)
    .split('\n')
    .filter(line => line.startsWith('- [ ] '))
    .map(line => line.slice('- [ ] '.length).replace(/ \(id: [^)]+\)$/, ''))

const notesCommand = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'notes',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text

/** A session in `/work/demo`; `toasts` and `statuses` record what it showed. */
const setup = (on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, stored)
  on('session.cwd', () => ({ value: '/work/demo' }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts, statuses }
}

/** The key of the first Button whose key starts with `prefix` on the row of the note shown as `text`. */
const buttonOf = async (ui: { findAll: (q: { type: 'Box' }) => Promise<{ key?: string; text: string }[]> }, row: string, prefix: string, text: string) => {
  const box = (await ui.findAll({ type: 'Box' })).find(b => b.key?.startsWith(row) && b.text.includes(text))
  return `${prefix}${box!.key!.slice(row.length)}`
}

test('an archived note can be restored from the pane for 5 s, and by /notes undo after', async ($, on) => {
  const { clock, toasts } = setup(on)
  const ui = await $.ui.mount(PANE)
  for (const text of ['one', 'two', 'three']) await ui.input({ key: 'new-project', text })
  const archive = async (text: string) => ui.press({ key: await buttonOf(ui, 'row-', 'archive-', text) })

  // Archive "two"; the pane's button takes it out of the archive again.
  await archive('two')
  expect(await listed($)).toEqual(['one', 'three'])
  expect(toasts.at(-1)).toBe('🗄 Archived: two (undo in the pane, or /notes undo)')
  await ui.press({ key: 'undo-archive' })
  expect(await listed($)).toEqual(['one', 'two', 'three'])
  expect(toasts.at(-1)).toBe('📝 Restored: two')
  expect(await ui.find({ key: 'undo-archive' })).toBeUndefined()

  // A later archive keeps its button when an earlier one's time runs out, even
  // the first archive of "two", now restored and archived again.
  await archive('one')
  await clock.advance(3000)
  await archive('two')
  await clock.advance(2000)
  expect(await ui.find({ key: 'undo-archive' })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ key: 'undo-archive' })).toBeUndefined()

  // The button is gone, but /notes undo still restores the last archive, once.
  expect(await notesCommand($, 'undo')).toBe('📝 Restored: two')
  expect(await listed($)).toEqual(['two', 'three'])
  expect(await notesCommand($, 'undo')).toBe('Nothing to undo.')
  await ui.unmount()
})

test('clear done archives every done note at once; the archive view shows them by week', async ($, on) => {
  const old: Note = {
    id: 'old',
    text: 'done long ago',
    isDone: true,
    isPinned: false,
    author: 'you',
    createdAt: 0,
    project: '/work/demo',
  }
  const { toasts, statuses } = setup(on, { 'project:/work/demo': [old] })
  const ui = await $.ui.mount(PANE)
  for (const text of ['a', 'b', 'c']) await ui.input({ key: 'new-project', text })
  await ui.press({ key: await buttonOf(ui, 'row-', 'done-', 'a') })
  await ui.press({ key: await buttonOf(ui, 'row-', 'done-', 'b') })
  const thisWeek = weekOf(Date.now())

  await ui.press({ key: 'clear-done' })
  expect(toasts.at(-1)).toBe('🗄 Archived: 3 done notes (undo in the pane, or /notes undo)')
  // Archived notes leave the lists, the counts and Claude's view.
  expect(await listed($)).toEqual(['c'])
  expect(statuses.at(-1)).toBe('📝 1 here · 0 global')
  expect(await ui.find({ key: 'archive-view' })).toMatchObject({ text: '🗄 archive (3)' })

  // The week a note was done in; one done before that was kept is "Earlier".
  await ui.press({ key: 'archive-view' })
  const weeks = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('week-')).map(b => b.key)
  expect(weeks).toEqual([`week-${thisWeek}`, 'week-earlier'])
  expect((await ui.find({ key: `week-${thisWeek}` }))?.text).toContain(`Week of ${thisWeek} (2 notes done)`)

  // Restore one; delete another for good.
  await ui.press({ key: await buttonOf(ui, 'arow-', 'restore-', '☑ a') })
  await ui.press({ key: 'purge-old' })
  expect(await ui.find({ key: 'week-earlier' })).toBeUndefined()
  await ui.press({ key: 'archive-back' })
  expect(await ui.find({ key: 'archive-view' })).toMatchObject({ text: '🗄 archive (1)' })
  expect(await notesCommand($, 'find done long ago')).toBe('No notes match "done long ago".')
  await ui.unmount()
})
