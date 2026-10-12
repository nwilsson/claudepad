import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

/**
 * A session in `/Work/Demo` (as the host spells it) whose editor commands
 * are recorded, not run; `exitCode` and `stderr` are what each one answers.
 */
const setup = (on: On, answer = { exitCode: 0, stderr: '' }) => {
  mock.store(on)
  on('session.cwd', () => ({ value: '/Work/Demo' }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const commands: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    commands.push(e.argv)
    return {
      value: { ...answer, stdout: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return { toasts, commands }
}

/** The keys of the note's open buttons, in order. */
const openButtons = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('open-'))

test('a note gets an open button per file it mentions, opening it in VS Code', async ($, on) => {
  const { commands, toasts } = setup(on)
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'new-project', text: 'fix hooks/register.tsx:42 and /etc/app.conf:3:9' })

  const keys = await openButtons(ui)
  expect(keys).toHaveLength(2)
  expect((await ui.find({ key: keys[0]! }))?.text).toBe('open register.tsx:42')
  await ui.press({ key: keys[0]! })
  await ui.press({ key: keys[1]! })
  // A relative path is under the session's folder, spelled as the host spells it.
  expect(commands).toEqual([
    ['code', '-g', '/Work/Demo/hooks/register.tsx:42'],
    ['code', '-g', '/etc/app.conf:3:9'],
  ])
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('the editor option picks the command, and a failure is a toast', { options: { editor: 'jetbrains' } }, async ($, on) => {
  const { commands, toasts } = setup(on, { exitCode: 1, stderr: 'idea: command not found\nmore' })
  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'new-project', text: 'see a.ts:7' })

  await ui.press({ key: (await openButtons(ui))[0]! })
  expect(commands).toEqual([['idea', '--line', '7', '/Work/Demo/a.ts']])
  expect(toasts).toEqual(["Couldn't open a.ts:7 with idea: idea: command not found"])
  await ui.unmount()
})
