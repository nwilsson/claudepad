import { expect, mock, test } from 'claude-code/testing'

const note = (id: string, project: string | null) => ({
  id,
  text: id,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt: 0,
  project,
})

test('status line recounts after a directory change', async ($, on) => {
  mock.store(on, { notes: [note('a1', '/work/a'), note('b1', '/work/b'), note('b2', '/work/b')] })
  let cwd = '/work/a'
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('classic.CwdChanged', () => ({}))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  expect(statuses).toEqual(['📝 1 here · 0 global'])

  cwd = '/work/b'
  await $.classic.CwdChanged({ old_cwd: '/work/a', new_cwd: '/work/b' })
  expect(statuses).toEqual(['📝 1 here · 0 global', '📝 2 here · 0 global'])
})

test('a change keeps notes another session added after this one started', async ($, on) => {
  // A store the test can write behind the session's back, as another session would.
  const stored: Record<string, unknown> = { notes: [note('a1', '/work/a')] }
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  on('store.set', (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work/a' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  // Another session, sharing the store, adds a note.
  stored.notes = [note('a1', '/work/a'), note('a2', '/work/a')]

  await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'a3' })
  expect((stored.notes as { text: string }[]).map(n => n.text)).toEqual(['a1', 'a2', 'a3'])
})

test('saved notes carry their tags, old ones from their next write on', async ($, on) => {
  const stored: Record<string, unknown> = { notes: [note('old #Legacy', '/work/a')] }
  on('store.get', (_$, e) => ({ value: stored[e.key] }))
  on('store.set', (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work/a' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'new #One #two' })
  expect((stored.notes as { text: string; tags?: string[] }[]).map(n => [n.text, n.tags])).toEqual([
    ['old #Legacy', ['legacy']],
    ['new #One #two', ['one', 'two']],
  ])
})
