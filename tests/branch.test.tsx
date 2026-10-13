import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
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

/**
 * A started session in the git repository `/work/demo`, whose `git branch`
 * answers from `repo`: change it, then raise a tool batch, to switch branches.
 */
const setup = async ($: Engine, on: On) => {
  const repo = { current: 'main' as string | null, all: ['main', 'feat'] }
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('classic.PostToolBatch', () => ({}))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  const gitRuns: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    gitRuns.push(e.argv)
    const stdout = repo.all.map(name => `${name === repo.current ? '*' : ' '}${name}`).join('\n')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  return { repo, statuses, gitRuns }
}

const note = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'note',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text

/** list_notes, without the ids. */
const listed = async ($: Engine) =>
  String(((await $.tool.call({ tool: 'mcp__claudepad__list_notes' })) as { result?: unknown }).result).replace(
    / \(id: [^)]+\)/g,
    '',
  )

/** What a tool batch with these tools raises after it. */
const batch = ($: Engine, ...tools: string[]) =>
  $.classic.PostToolBatch({
    tool_calls: tools.map((tool_name, i) => ({ tool_name, tool_input: {}, tool_use_id: `t${i}` })),
  } as never)

test('a branch note is listed only on its branch, and with the project again once the branch is gone', async ($, on) => {
  const { repo, statuses } = await setup($, on)
  expect(await note($, 'whole project')).toBe('📝 Noted (demo): whole project')
  expect(await note($, '-b main only')).toBe('📝 Noted (demo 🌿 main): main only')
  expect(statuses.at(-1)).toBe('📝 2 here · 0 global')
  expect((await listed($)).split('\n').slice(0, 3)).toEqual([
    'Notes for this project (demo, on branch main):',
    '- [ ] whole project',
    '- [ ] main only (branch main)',
  ])

  // Claude switches branches: the main note leaves the list and the count.
  repo.current = 'feat'
  await batch($, 'Bash')
  expect(statuses.at(-1)).toBe('📝 1 here · 0 global')
  expect((await listed($)).split('\n').slice(0, 3)).toEqual([
    'Notes for this project (demo, on branch feat):',
    '- [ ] whole project',
    '',
  ])

  // main is merged and deleted: its note comes back, marked.
  repo.all = ['feat']
  await batch($, 'PowerShell')
  expect(statuses.at(-1)).toBe('📝 2 here · 0 global')
  expect(await listed($)).toContain('- [ ] main only (branch main, since deleted)')
})

test('git is read again after shell tools and before a prompt, not after other tools', async ($, on) => {
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context
    return { text: e.text }
  })
  const { repo, gitRuns } = await setup($, on)
  const before = gitRuns.length
  await batch($, 'Read', 'Grep')
  expect(gitRuns.length).toBe(before)
  await batch($, 'Read', 'Bash')
  expect(gitRuns.length).toBe(before + 1)
  expect(gitRuns.at(-1)).toEqual(['git', 'branch', '--format=%(HEAD)%(refname:short)'])

  // A pinned branch note rides along with prompts on its branch.
  const ui = await $.ui.mount(PANE)
  await note($, '-b main work')
  const row = (await ui.findAll({ type: 'Box' })).find(b => b.key?.startsWith('row-') && b.text.includes('main work'))
  await ui.press({ key: `pin-${row!.key!.slice('row-'.length)}` })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(context).toEqual([
    "The user's pinned notes from their notepad (standing context; keep them in mind):\n" +
      '- main work (this project, branch main)',
  ])

  // A switch made outside the session, with no tool between: the next prompt reads it.
  repo.current = 'feat'
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(context).toBeUndefined()
  expect(await listed($)).not.toContain('main work')
  await ui.unmount()
})

test('add_note with branch outside a repository falls back to a project note, and says so', async ($, on) => {
  const { repo } = await setup($, on)
  repo.current = null
  repo.all = []
  await batch($, 'Bash')
  const added = (await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'x', branch: true })) as { result?: unknown }
  expect(String(added.result)).toMatch(
    /^Added to the notepad \(project; no git branch is checked out, so it is a project note\): x \(id: /,
  )
  expect(await listed($)).toContain('- [ ] x\n')
})

test('the pane adds to the branch, moves notes on and off it, and finds other branches only in a search', async ($, on) => {
  const { repo } = await setup($, on)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'scope-branch' })).toMatchObject({ text: '○ 🌿 main' })
  await ui.press({ key: 'scope-branch' })
  await ui.input({ key: 'new-branch', text: 'branch note' })
  await ui.press({ key: 'scope-project' })
  await ui.input({ key: 'new-project', text: 'project note' })

  const rowOf = async (text: string) =>
    (await ui.findAll({ type: 'Box' })).find(b => b.key?.startsWith('row-') && b.text.includes(text))
  expect((await rowOf('branch note'))?.text).toContain('branch note 🌿 main')
  // A branch note goes back to the whole project, not to global.
  const branchRow = (await rowOf('branch note'))!.key!.slice('row-'.length)
  expect(await ui.find({ key: `move-${branchRow}` })).toBeUndefined()
  expect(await ui.find({ key: `branch-${branchRow}` })).toMatchObject({ text: '→ whole project' })
  // A project note moves onto the branch.
  const projectRow = (await rowOf('project note'))!.key!.slice('row-'.length)
  await ui.press({ key: `branch-${projectRow}` })
  expect((await rowOf('project note'))?.text).toContain('project note 🌿 main')

  // On feat, main's notes are gone from the list, and a search finds them.
  repo.current = 'feat'
  await batch($, 'Bash')
  expect(await rowOf('note')).toBeUndefined()
  await ui.input({ key: 'search', text: 'note' })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === '🗂 Other projects and branches')).toBe(true)
  expect((await rowOf('branch note'))?.text).toContain('🌿 main')
  await ui.unmount()
})
