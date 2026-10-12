import { expect, mock, test } from 'claude-code/testing'

import { localDate } from '../hooks/notes'

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

test('a session starts by showing overdue notes, in a toast and on the status line', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const ago = localDate(Date.now() - 3 * day)
  const soon = localDate(Date.now() + 3 * day)
  mock.store(on, {
    'project:/work/a': [note(`late #due:${ago}`, '/work/a'), note(`soon #due:${soon}`, '/work/a')],
    global: [note(`global late #due:${ago}`, null)],
  })
  on('session.cwd', () => ({ value: '/work/a' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
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

  await $.session.start({ cwd: '/work/a', surface: 'terminal', isInteractive: true })
  expect(statuses).toEqual(['📝 2 here · 1 global · ⏰ 2 overdue'])
  expect(toasts).toEqual([`⏰ 2 overdue notes: late #due:${ago} · global late #due:${ago}`])
})
