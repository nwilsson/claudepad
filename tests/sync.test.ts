import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { EXPORT_MARK } from '../hooks/notes'

/** A file's name: the engine hands the plugin's `NOTES.md` over as an absolute path. */
const name = (path: string) => path.replace(/\\/g, '/').split('/').pop()!

/**
 * A started session in `/work/demo` whose folder lives in memory, each file
 * with a modification time; `edit` changes a file as an outside editor would.
 */
const setup = async ($: Engine, on: On, stored: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, stored)
  const times: Record<string, number> = Object.fromEntries(Object.keys(files).map(file => [file, 1]))
  let tick = 1
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const reads: string[] = []
  on('fs.read', (_$, e) => {
    reads.push(name(e.path))
    const text = files[name(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files[name(e.path)] = e.text
    times[name(e.path)] = ++tick
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    const time = times[name(e.path)]
    if (time === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: files[name(e.path)]!.length, mtimeMs: time, isLink: false } }
  })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  const edit = (file: string, text: string) => {
    files[file] = text
    times[file] = ++tick
  }
  return { clock, toasts, files, edit, reads }
}

const run = async ($: Engine, command: string, args = '') =>
  (
    await $.command.run({
      command,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

/** The open and done lines list_notes gives, without ids. */
const listed = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result)
    .split('\n')
    .filter(line => line.startsWith('- ['))
    .map(line => line.replace(/ \(id: [^)]+\)$/, ''))

test('an exported NOTES.md edited outside: new lines add, ticks apply, a removed line archives with undo', async ($, on) => {
  const { clock, toasts, files, edit, reads } = await setup($, on)
  await run($, 'note', 'one')
  await run($, 'note', 'two')
  await run($, 'note', '-g three')
  expect(await run($, 'notes', 'export')).toBe('📝 Exported notes to NOTES.md in demo.')

  // The export's own write is not read back.
  await clock.advance(3000)
  expect(reads).toEqual(['NOTES.md'])
  expect(toasts.some(t => t.includes('changed'))).toBe(false)

  edit(
    'NOTES.md',
    files['NOTES.md']!.replace('- [ ] one', '- [x] one').replace('- [ ] two\n', '- [ ] four\n'),
  )
  await clock.advance(3000)
  expect(toasts.slice(-2)).toEqual([
    '📝 NOTES.md changed: 1 added, 1 updated',
    '🗄 Archived: 1 note removed from NOTES.md (undo in the pane, or /notes undo)',
  ])
  expect(await listed($)).toEqual(['- [x] one', '- [ ] four', '- [ ] three'])

  // Undo brings the note back; putting its line back in the file would too.
  expect(await run($, 'notes', 'undo')).toBe('📝 Restored: 1 note removed from NOTES.md')
  expect(await listed($)).toEqual(['- [x] one', '- [ ] two', '- [ ] four', '- [ ] three'])

  // Unchanged time: not read again.
  const before = reads.length
  await clock.advance(9000)
  expect(reads.length).toBe(before)
})

test('a line put back in NOTES.md restores the note it archived', async ($, on) => {
  const { clock, toasts, files, edit } = await setup($, on)
  await run($, 'note', 'come back')
  await run($, 'notes', 'export')
  const exported = files['NOTES.md']!
  edit('NOTES.md', exported.replace('- [ ] come back\n', ''))
  await clock.advance(3000)
  expect(await listed($)).toEqual([])
  edit('NOTES.md', exported)
  await clock.advance(3000)
  expect(toasts.at(-1)).toBe('📝 NOTES.md changed: 1 back from the archive')
  expect(await listed($)).toEqual(['- [ ] come back'])
})

test('edits made between sessions apply at the start; a hand-written NOTES.md is never followed', async ($, on) => {
  const note = (id: string) => ({ id, text: id, isDone: false, isPinned: false, author: 'you', createdAt: 0, project: '/work/demo' })
  const synced = `${EXPORT_MARK}\n## demo\n- [ ] a\n- [ ] b\n`
  const { clock, toasts, edit } = await setup(
    $,
    on,
    { 'project:/work/demo': [note('a'), note('b')], 'sync:/work/demo': synced },
    { 'NOTES.md': `${EXPORT_MARK}\n## demo\n- [ ] a\n` },
  )
  expect(toasts).toEqual(['🗄 Archived: 1 note removed from NOTES.md (undo in the pane, or /notes undo)'])
  expect(await listed($)).toEqual(['- [ ] a'])

  // Without the export's first line it is the person's own file: left alone.
  edit('NOTES.md', '## demo\n')
  await clock.advance(3000)
  expect(await listed($)).toEqual(['- [ ] a'])
  expect(toasts).toHaveLength(1)
})

test('a NOTES.md seen for the first time is only recorded', async ($, on) => {
  const { clock, toasts, edit } = await setup($, on, {}, { 'NOTES.md': `${EXPORT_MARK}\n## demo\n- [ ] old\n` })
  expect(await listed($)).toEqual([])
  edit('NOTES.md', `${EXPORT_MARK}\n## demo\n- [ ] old\n- [ ] new\n`)
  await clock.advance(3000)
  // Only the line added since: "old" was never synced, so it is not imported.
  expect(await listed($)).toEqual(['- [ ] new'])
  expect(toasts).toEqual(['📝 NOTES.md changed: 1 added'])
})
