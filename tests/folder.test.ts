import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fileNameOf } from '../hooks/notes'

const note = (id: string, project: string | null) => ({
  id,
  text: id,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt: 0,
  project,
})

/** A file's name: the engine hands a plugin's paths over made absolute. */
const name = (path: string) => path.replace(/\\/g, '/').split('/').pop()!

/**
 * A session in `/work/demo/src`, inside the repository `/work/demo` whose
 * origin is `remote` (none: no repository), with a flat folder in memory for
 * every file the plugin reads, writes or lists.
 */
const setup = (on: On, stored: Record<string, unknown>, remote: string | null | undefined) => {
  mock.store(on, stored)
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  on('session.cwd', () => ({ value: '/work/demo/src' }))
  on('session.repo', () => ({
    value: remote === undefined ? null : { root: '/work/demo', remote, internal: false, name: null },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const files: Record<string, string> = {}
  const written: string[] = []
  on('fs.read', (_$, e) => {
    const text = files[name(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files[name(e.path)] = e.text
    written.push(e.path.replace(/\\/g, '/'))
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: Object.keys(files).map(file => ({ name: file, kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }))
  return { toasts, files, written }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/demo/src', surface: 'terminal', isInteractive: true })

const run = async ($: Engine, command: string, args = '') =>
  (
    await $.command.run({
      command,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

const listed = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result)
    .split('\n')
    .filter(line => line.startsWith('- ['))
    .map(line => line.replace(/ \(id: [^)]+\)$/, ''))

test("a repository's notes go by its remote: notes filed under its folders move there", async ($, on) => {
  const { toasts } = setup(
    on,
    {
      'project:/work/demo': [note('at the root', '/work/demo')],
      'project:/work/demo/src': [note('in src', '/work/demo/src')],
      'project:/work/demo/other': [note('another folder', '/work/demo/other')],
    },
    'git@github.com:Me/Demo.git',
  )
  await start($)
  expect(toasts).toEqual(['📝 2 notes of demo now go with the repository, as github.com/me/demo'])
  expect(await listed($)).toEqual(['- [ ] at the root', '- [ ] in src'])
  expect(await run($, 'note', 'new')).toBe('📝 Noted (demo): new')
  // Only the folders the session is in moved; another folder's notes wait until it is visited.
  expect(await listed($)).toEqual(['- [ ] at the root', '- [ ] in src', '- [ ] new'])
})

test('a repository with no remote goes by its root folder', async ($, on) => {
  setup(on, { 'project:/work/demo/src': [note('in src', '/work/demo/src')] }, null)
  await start($)
  expect(await listed($)).toEqual(['- [ ] in src'])
  expect(String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result)).toContain(
    'Notes for this project (demo):',
  )
})

test('with a notes folder, the plugin store is copied in once and notes live in files', { options: { notesFolder: '~/notes' } }, async ($, on) => {
  const { toasts, files, written } = setup(
    on,
    { 'project:github.com/me/demo': [note('kept', 'github.com/me/demo')], global: [note('everywhere', null)] },
    'https://github.com/me/demo',
  )
  await start($)
  expect(toasts).toEqual(['📝 Copied 2 notes into C:/Users/me/notes'])
  expect(written.every(path => path.startsWith('C:/Users/me/notes/'))).toBe(true)

  await run($, 'note', 'added')
  const file = files[fileNameOf('project:github.com/me/demo')]!
  expect(file.split('\n').slice(0, 1)).toEqual(['{"key": "project:github.com/me/demo", "notes": ['])
  expect(file.split('\n').filter(line => line.startsWith('{"id"'))).toHaveLength(2)
  expect(await listed($)).toEqual(['- [ ] kept', '- [ ] added', '- [ ] everywhere'])
})

test('a notes file a git merge broke is reported and never written over', { options: { notesFolder: '/notes' } }, async ($, on) => {
  const { toasts, files } = setup(on, {}, 'https://github.com/me/demo')
  const key = 'project:github.com/me/demo'
  const broken = `{"key": "${key}", "notes": [\n<<<<<<< HEAD\n${JSON.stringify(note('mine', 'github.com/me/demo'))}\n=======\n>>>>>>> theirs\n]}\n`
  files[fileNameOf(key)] = broken
  files[fileNameOf('global')] = `{"key": "global", "notes": [\n${JSON.stringify(note('global one', null))}\n]}\n`
  await start($)
  // The copy from the plugin store does not run: the folder already has files.
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/no longer reads as notes \(a git merge conflict left in it\?\)/)
  expect(await listed($)).toEqual(['- [ ] global one'])

  let failed = false
  await run($, 'note', 'more').catch(() => {
    failed = true
  })
  expect(failed).toBe(true)
  expect(files[fileNameOf(key)]).toBe(broken)
  // Global notes, in a file of their own, still work.
  await run($, 'note', '-g fine')
  expect(await listed($)).toEqual(['- [ ] global one', '- [ ] fine'])
})
