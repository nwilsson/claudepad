import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'claudepad',
  component: 'Pane',
  requestId: 'claudepad',
  props: {
    title: 'claudepad',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
  } as never,
} as const

type Saved = { id: string; text: string }
type Drawing = {
  drawn: () => Promise<unknown>
  findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]>
}

/** Every string a tree draws, in order, joined. */
const textOf = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : node && typeof node === 'object'
        ? textOf((node as { children?: unknown }).children ?? (node as { props?: { children?: unknown } }).props?.children)
        : ''

/**
 * The notes as the pane lists them: each note's id (off its edit Button) and
 * text (its row's first Text, less the checkbox prefix).
 */
const saved = async (ui: Drawing): Promise<Saved[]> => {
  const ids = (await ui.findAll({ type: 'Button' }))
    .map(b => b.key ?? '')
    .filter(key => key.startsWith('edit-'))
    .map(key => key.slice('edit-'.length))
  const rows: Saved[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const el = node as { type?: string; key?: string; children?: unknown; props?: { key?: string; children?: unknown } }
    const children = el.children ?? el.props?.children
    const key = el.props?.key ?? el.key
    if (el.type === 'Box' && typeof key === 'string' && key.startsWith('row-')) {
      const kids = ([] as unknown[]).concat(children ?? [])
      const text = textOf(kids[0]).replace(/^[☐☑] (📌 )?(🤖 )?/u, '')
      rows.push({ id: key.slice('row-'.length), text })
      return
    }
    walk(children)
  }
  walk(await ui.drawn())
  return rows.filter(row => ids.includes(row.id))
}

const type = async (ui: { key: (e: { key: string; in?: string }) => Promise<void> }, text: string, editor: string) => {
  for (const ch of text) await ui.key({ key: ch, in: editor })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`full editor writes, edits and saves a multi-line note (${surface})`, async ($, on) => {
    mock.store(on)
    on('session.cwd', () => ({ value: '/work/demo' }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    const ui = await $.ui.mount({ ...PANE, surface })

    // New note: type two lines, save with Ctrl+S.
    await ui.press({ key: 'new-multiline' })
    expect(await ui.find({ type: 'Client' })).toBeDefined()
    await type(ui, 'hi', 'editor-new')
    await ui.key({ key: 'return', in: 'editor-new' })
    await type(ui, 'yo #tag', 'editor-new')
    await ui.key({ key: 's', ctrl: true, in: 'editor-new' })

    let notes = await saved(ui)
    expect(notes.map(n => n.text)).toEqual(['hi\nyo #tag'])
    expect(await ui.find({ type: 'Client' })).toBeUndefined()

    // Edit it: up to line 1, End, add "!", backspace across the line break test, Save button.
    const id = notes[0]!.id
    await ui.press({ key: `edit-${id}` })
    const ed = `editor-${id}`
    await ui.key({ key: 'up', in: ed })
    await ui.key({ key: 'end', in: ed })
    await ui.key({ key: '!', in: ed })
    await ui.key({ key: 'down', in: ed })
    await ui.key({ key: 'home', in: ed })
    await ui.key({ key: 'backspace', in: ed }) // joins line 2 onto line 1
    await ui.key({ key: 'return', in: ed }) // splits it again
    await ui.press({ key: 'editor-save' })
    notes = await saved(ui)
    expect(notes.map(n => n.text)).toEqual(['hi!\nyo #tag'])

    // Cancel leaves the note alone.
    await ui.press({ key: `edit-${id}` })
    await type(ui, 'zzz', ed)
    await ui.press({ key: 'editor-cancel' })
    notes = await saved(ui)
    expect(notes.map(n => n.text)).toEqual(['hi!\nyo #tag'])

    // Line mode: add a third line, replace the first.
    await ui.press({ key: `edit-${id}` })
    await ui.press({ key: 'editor-mode' })
    await ui.input({ key: 'line-add-2', text: 'third' })
    await ui.press({ key: 'line-edit-0' })
    await ui.input({ key: 'line-set-0', text: 'first' })
    await ui.press({ key: 'editor-save' })
    notes = await saved(ui)
    expect(notes.map(n => n.text)).toEqual(['first\nyo #tag\nthird'])

    await ui.unmount()
  })
}
