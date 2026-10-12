import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Note } from '../types'

// The store layout: one key per project plus `global`, the move from the old
// single `notes` key, and changes that read and write only their own keys.

const ADD_TOOL = 'mcp__claudepad__add_note'

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

const note = (id: string, project: string | null): Note => ({
  id,
  text: id,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt: 0,
  project,
})

const texts = (value: unknown) => (value as Note[]).map(n => n.text)

/**
 * A store in memory the test can read and write behind the session's back, as
 * another session would; `writes` records each set and delete, in order.
 */
const memoryStore = (on: On, initial: Record<string, unknown> = {}) => {
  const stored = new Map(Object.entries(initial))
  const writes: string[] = []
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    writes.push(`set ${e.key}`)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)
    writes.push(`delete ${e.key}`)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  return { stored, writes }
}

/** A session in `/work/a`: `start` runs session.start, `cd` changes folder as the host does. */
const session = ($: Engine, on: On) => {
  let cwd = '/work/a'
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('classic.CwdChanged', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return {
    start: () => $.session.start({ cwd, surface: 'terminal', isInteractive: true }),
    cd: async (path: string) => {
      const old = cwd
      cwd = path
      await $.classic.CwdChanged({ old_cwd: old, new_cwd: path })
    },
  }
}

const notesCommand = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'notes',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text

test('notes under the old single key move to per-project keys, and again if it comes back', async ($, on) => {
  const { stored, writes } = memoryStore(on, {
    unrelated: 'kept',
    notes: [note('a1', '/work/a'), note('g1 #Tag', null), note('b1', '/work/b'), note('a2', '/work/a')],
  })
  const s = session($, on)
  await s.start()
  expect([...stored.keys()]).toEqual(['unrelated', 'project:/work/a', 'global', 'project:/work/b'])
  expect(texts(stored.get('project:/work/a'))).toEqual(['a1', 'a2'])
  // Notes saved before tags were stored get theirs on the way.
  expect((stored.get('global') as Note[])[0]!.tags).toEqual(['tag'])

  // A session still on the old version writes the old key again: the next
  // load folds in what it added, and touches nothing else.
  stored.set('notes', [note('a1', '/work/a'), note('a3', '/work/a')])
  writes.length = 0
  await s.cd('/work/b')
  expect(writes).toEqual(['set project:/work/a', 'delete notes'])
  expect(texts(stored.get('project:/work/a'))).toEqual(['a1', 'a2', 'a3'])
  expect(stored.get('unrelated')).toBe('kept')
})

test('a change writes only the keys it touches', async ($, on) => {
  mock.clock(on)
  const { stored, writes } = memoryStore(on, {
    'project:/work/a': [note('a1', '/work/a')],
    'project:/work/b': [note('b1', '/work/b')],
  })
  await session($, on).start()
  const ui = await $.ui.mount(PANE)

  writes.length = 0
  await $.tool.call({ tool: ADD_TOOL, text: 'g1', global: true })
  expect(writes).toEqual(['set global'])

  // A move spans two keys; a key left with no notes is deleted.
  writes.length = 0
  await ui.press({ key: 'move-a1' })
  expect(writes).toEqual(['delete project:/work/a', 'set global'])
  // The change reads its keys in the order given, so the moved note comes first, as it did in one list.
  expect(texts(stored.get('global'))).toEqual(['a1', 'g1'])

  writes.length = 0
  await ui.press({ key: 'archive-a1' })
  expect(await notesCommand($, 'undo')).toBe('📝 Restored: a1')
  expect(writes).toEqual(['set global', 'set global'])
  expect(texts(stored.get('global'))).toEqual(['a1', 'g1'])

  // Another project's key was never read back or written.
  expect(texts(stored.get('project:/work/b'))).toEqual(['b1'])
  await ui.unmount()
})

test('notes another session wrote survive, and show up once this session reloads', async ($, on) => {
  const { stored } = memoryStore(on, { 'project:/work/a': [note('a1', '/work/a')] })
  const s = session($, on)
  await s.start()

  // Another session adds a note here and one in another project.
  stored.set('project:/work/a', [note('a1', '/work/a'), note('a-other', '/work/a')])
  stored.set('project:/work/b', [note('b-other', '/work/b')])

  await $.tool.call({ tool: ADD_TOOL, text: 'a2' })
  expect(texts(stored.get('project:/work/a'))).toEqual(['a1', 'a-other', 'a2'])
  expect(texts(stored.get('project:/work/b'))).toEqual(['b-other'])

  await s.cd('/work/b')
  const listed = (await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }
  expect(String(listed.result)).toContain('Notes for this project (b):\n- [ ] b-other')
})
