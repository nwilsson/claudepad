import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Mounted } from 'claude-code/testing'

const pane = (isFocused: boolean) =>
  ({
    plugin: 'claudepad',
    component: 'Pane',
    requestId: 'claudepad',
    surface: 'terminal',
    props: { title: 'claudepad', isFocused, bodyColumns: 80, placement: 'dock' } as never,
  }) as const

/** A session in `/work/demo`; `toasts` records what it showed. */
const setup = (on: On) => {
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts }
}

type Ui = Mounted<'terminal', 'Pane'>

/** The notes' rows in the pane, top to bottom, as their first line reads. */
const rows = async (ui: Ui) =>
  (await ui.findAll({ type: 'Box' }))
    .filter(b => b.key?.startsWith('row-'))
    .map(b => b.text.split(/\s{2,}|done|undo/)[0]!.trim())

const add = async (ui: Ui, ...texts: string[]) => {
  for (const text of texts) await ui.input({ key: 'new-project', text })
}

test('j and k select a note, d marks it done, u and n move it', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount(pane(true))
  await add(ui, 'one', 'two', 'three')
  // Nothing selected yet: only next and previous.
  expect(await ui.find({ key: 'key-done' })).toBeUndefined()
  await ui.press({ key: 'key-next' })
  await ui.press({ key: 'key-next' })
  expect(await rows(ui)).toEqual(['☐ one', '▸ ☐ two', '☐ three'])

  await ui.press({ key: 'key-up' })
  expect(await rows(ui)).toEqual(['▸ ☐ two', '☐ one', '☐ three'])
  // At the top it stays.
  await ui.press({ key: 'key-up' })
  await ui.press({ key: 'key-down' })
  await ui.press({ key: 'key-down' })
  expect(await rows(ui)).toEqual(['☐ one', '☐ three', '▸ ☐ two'])

  // Done sinks below the open notes, still selected; k walks back from it.
  await ui.press({ key: 'key-previous' })
  await ui.press({ key: 'key-done' })
  expect(await rows(ui)).toEqual(['☐ one', '☐ two', '▸ ☑ three'])
  await ui.press({ key: 'key-previous' })
  expect(await rows(ui)).toEqual(['☐ one', '▸ ☐ two', '☑ three'])
  // The order is kept: the export reads it too.
  await ui.unmount()
  const again = await $.ui.mount(pane(true))
  expect((await rows(again)).map(r => r.replace('▸ ', ''))).toEqual(['☐ one', '☐ two', '☑ three'])
  await again.unmount()
})

test('each row has ↑ and ↓ where it can move; none while sorted by due date or unfocused keys', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount(pane(false))
  await add(ui, 'a #due:2026-12-01', 'b')
  expect(await ui.find({ key: 'key-next' })).toBeUndefined()
  const ids = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-')).map(b => b.key!.slice(4))
  expect(await ui.find({ key: `up-${ids[0]}` })).toBeUndefined()
  expect(await ui.find({ key: `down-${ids[0]}` })).toBeDefined()
  await ui.press({ key: `down-${ids[0]}` })
  expect(await rows(ui)).toEqual(['☐ b', '☐ a #due:2026-12-01'])
  await ui.press({ key: 'sort-due' })
  expect((await ui.findAll({ type: 'Button' })).some(b => /^(up|down)-/.test(b.key ?? ''))).toBe(false)
  await ui.unmount()
})

test('pinned notes past about 1k tokens: a line in the pane, and a toast once at the next prompt', async ($, on) => {
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context
    return { text: e.text }
  })
  const { toasts } = setup(on)
  const ui = await $.ui.mount(pane(true))
  await add(ui, `long ${'x'.repeat(4200)}`)
  const id = (await ui.findAll({ type: 'Box' })).find(b => b.key?.startsWith('row-'))!.key!.slice(4)
  const warning = async () =>
    (await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('📌 Pinned notes add about 1.1k tokens'))
  expect(await warning()).toBe(false)
  await ui.press({ key: `pin-${id}` })
  expect(await warning()).toBe(true)

  const submit = () => $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await submit()
  await submit()
  expect(toasts.filter(t => t.startsWith('📌'))).toEqual([
    "📌 Pinned notes add about 1.1k tokens to every prompt. Unpin what Claude doesn't need each time.",
  ])
  // The notes still ride along: the warning only warns.
  expect(context?.[0]).toContain('long xxx')
  // Unpinned, then pinned again: a new warning.
  await ui.press({ key: `pin-${id}` })
  await submit()
  await ui.press({ key: `pin-${id}` })
  await submit()
  expect(toasts.filter(t => t.startsWith('📌'))).toHaveLength(2)
  await ui.unmount()
})
