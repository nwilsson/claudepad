import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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

/** The project's notes in saved order, from list_notes. */
const listed = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result)
    .split('\n')
    .filter(line => line.startsWith('- [ ] '))
    .map(line => line.slice('- [ ] '.length))

const undoNotes = async ($: Engine) =>
  (
    await $.command.run({
      command: 'notes',
      args: 'undo',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text

test('a deleted note can be put back from the pane for 5 s, and by /notes undo after', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const ui = await $.ui.mount(PANE)
  for (const text of ['one', 'two', 'three']) await ui.input({ key: 'new-project', text })
  // The pane lists the notes in the order list_notes does: oldest first.
  const del = async (text: string) => {
    const ids = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('del-'))
    await ui.press({ key: ids[(await listed($)).indexOf(text)]! })
  }

  // Delete "two"; the pane's button puts it back in its place.
  await del('two')
  expect(await listed($)).toEqual(['one', 'three'])
  expect(toasts.at(-1)).toBe('🗑 Deleted: two (undo in the pane, or /notes undo)')
  await ui.press({ key: 'undo-delete' })
  expect(await listed($)).toEqual(['one', 'two', 'three'])
  expect(toasts.at(-1)).toBe('📝 Restored: two')
  expect(await ui.find({ key: 'undo-delete' })).toBeUndefined()

  // A later delete keeps its button when an earlier one's time runs out, even
  // the first delete of "two", now restored and deleted again.
  await del('one')
  await clock.advance(3000)
  await del('two')
  await clock.advance(2000)
  expect(await ui.find({ key: 'undo-delete' })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ key: 'undo-delete' })).toBeUndefined()

  // The button is gone, but /notes undo still restores the last delete, once.
  expect(await undoNotes($)).toBe('📝 Restored: two')
  expect(await listed($)).toEqual(['two', 'three'])
  expect(await undoNotes($)).toBe('Nothing to undo.')

  await ui.unmount()
})
