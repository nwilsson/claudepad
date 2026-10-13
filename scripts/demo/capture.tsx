import { mock, test } from 'claude-code/testing'

// Plays the README demo against the real mod and prints what the pane drew
// at each step, for scripts/demo/build.py. Not one of the mod's tests: it
// lives outside tests/ so CI never runs it. See scripts/demo/README.md.

const PANE = {
  plugin: 'claudepad',
  component: 'Pane',
  requestId: 'claudepad',
  surface: 'terminal',
  props: { title: 'claudepad', isFocused: true, bodyColumns: 64, placement: 'dock' } as never,
} as const

test('capture the demo', async ($, on) => {
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/acme-app' }))
  on('session.repo', () => ({
    value: { root: '/work/acme-app', remote: 'git@github.com:you/acme-app.git', internal: false, name: null },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '*main\n feature/retry\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  let status: string | undefined
  on('ui.status', (_$, e) => {
    status = e.text
    return { value: undefined }
  })
  let toast: string | undefined
  on('ui.toast', (_$, e) => {
    toast = e.text
    return { value: undefined }
  })
  await $.session.start({ cwd: '/work/acme-app', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  const run = (command: string, args: string) =>
    $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const idOf = async (text: string) =>
    (await ui.findAll({ type: 'Box' })).find(b => b.key?.startsWith('row-') && b.text.includes(text))!.key!.slice(4)

  const frame = async (label: string) => {
    console.log(`FRAME ${JSON.stringify({ label, toast, status, tree: await ui.drawn() })}`)
    toast = undefined
  }

  await frame('empty')
  await run('note', 'fix the login redirect #bug')
  await frame('note')
  await run('note', '-g renew the domain #due:2026-11-01')
  await frame('global')
  await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'retry logic swallows 429s #bug #followup' })
  await frame('claude')
  await run('note', '-b ask in review whether the retry belongs here')
  await frame('branch')
  await ui.press({ key: `pin-${await idOf('login redirect')}` })
  await frame('pin')
  await ui.press({ key: 'key-next' })
  await ui.press({ key: 'key-next' })
  await frame('select')
  await ui.press({ key: 'key-done' })
  await frame('done')
  await ui.unmount()
})
