import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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

const note = (text: string, createdAt: number, project: string | null = '/work/demo'): Note => ({
  id: text.split(' ')[0]!,
  text,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt,
  project,
})

/** A started session in `/work/demo` with `stored` in the store, and the pane mounted. */
const started = async ($: Engine, on: On, stored: Record<string, unknown>) => {
  mock.store(on, stored)
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  return $.ui.mount(PANE)
}

test('the pane sorts by due date on request, and offers it only once a note has one', async ($, on) => {
  const ui = await started($, on, {
    'project:/work/demo': [note('undated', 1), note('late #due:2026-10-30', 2), note('early #due:2026-10-01', 3)],
  })
  const order = async () =>
    (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-')).map(b => b.key!.slice('row-'.length))

  expect(await order()).toEqual(['undated', 'late', 'early'])
  expect(await ui.find({ key: 'sort-added' })).toMatchObject({ text: '● added' })
  await ui.press({ key: 'sort-due' })
  expect(await order()).toEqual(['early', 'late', 'undated'])
  expect(await ui.find({ key: 'sort-due' })).toMatchObject({ text: '● due' })
  await ui.press({ key: 'sort-added' })
  expect(await order()).toEqual(['undated', 'late', 'early'])
  await ui.unmount()
})

test('with no due dates here or global, the pane has no sort choice', async ($, on) => {
  const ui = await started($, on, {
    'project:/work/demo': [note('plain', 1)],
    'project:/work/other': [note('elsewhere #due:2026-10-01', 2, '/work/other')],
  })
  // The project's note is listed, so the missing choice is not an empty pane.
  expect(await ui.find({ key: 'row-plain' })).toBeDefined()
  expect(await ui.find({ key: 'sort-due' })).toBeUndefined()
  await ui.unmount()
})
