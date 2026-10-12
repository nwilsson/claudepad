import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The notes logic (search, tags, export, import) through the commands and
// tools that use it. logic.test.ts tests hooks/notes.ts directly.

/** A file's name: the plugin writes `NOTES.md`, which the engine resolves to an absolute path. */
const name = (path: string) => path.replace(/\\/g, '/').split('/').pop()!

/** A session in `/work/demo` with an in-memory store and folder. */
const setup = (on: On, files: Record<string, string> = {}) => {
  mock.store(on)
  let cwd = '/work/demo'
  on('session.cwd', () => ({ value: cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    const text = files[name(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files[name(e.path)] = e.text
    return { value: undefined }
  })
  return { files, cd: (path: string) => void (cwd = path) }
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

/** list_notes' text with the random note ids taken out; idOf reads one. */
const listNotes = async ($: Engine, query?: string) => (await listRaw($, query)).replace(/ \(id: [^)]+\)/g, '')

const listRaw = async ($: Engine, query?: string) =>
  String(
    (
      (await $.tool.call({ tool: 'mcp__claudepad__list_notes', ...(query === undefined ? {} : { query }) })) as {
        result?: unknown
      }
    ).result,
  )

/** The id list_notes gives the note whose first line is `text`. */
const idOf = async ($: Engine, text: string) => {
  const line = (await listRaw($)).split('\n').find(l => l.includes(`] ${text} (id: `))
  return /\(id: ([^)]+)\)$/.exec(line ?? '')?.[1]
}

test('/note adds to this project, -g and --global to the global list', async ($, on) => {
  setup(on)
  expect(await run($, 'note', 'fix the login')).toBe('📝 Noted (demo): fix the login')
  expect(await run($, 'note', '-g buy milk')).toBe('📝 Noted (global): buy milk')
  expect(await run($, 'note', '--global  call mum ')).toBe('📝 Noted (global): call mum')

  expect(await listNotes($)).toBe(
    [
      'Notes for this project (demo):',
      '- [ ] fix the login',
      '',
      'Global notes:',
      '- [ ] buy milk',
      '- [ ] call mum',
      '',
      'Tags in use: (none)',
    ].join('\n'),
  )
})

test('a project is its folder however it is spelled', async ($, on) => {
  const { cd } = setup(on)
  cd('E:\\Code\\Demo\\')
  await run($, 'note', 'one')
  cd('e:/code/demo')
  expect(await listNotes($)).toContain('Notes for this project (demo):\n- [ ] one')
  cd('/elsewhere')
  expect(await listNotes($)).toContain('Notes for this project (elsewhere):\n(none)')
})

test('search needs every word, in any order and case; #word is an exact tag', async ($, on) => {
  const { cd } = setup(on)
  await run($, 'note', 'Fix LOGIN redirect #bug')
  await run($, 'note', 'login page copy #bugfix')
  await run($, 'note', 'redirect after logout')
  await run($, 'note', '-g email#bug is not a tag')
  cd('/work/other')
  await run($, 'note', 'login #Bug on other')

  expect(await run($, 'notes', 'find redirect login')).toBe(
    '1 note matching "redirect login":\n- [ ] Fix LOGIN redirect #bug (demo)',
  )
  expect(await run($, 'notes', 'find #bug login')).toBe(
    [
      '2 notes matching "#bug login":',
      '- [ ] Fix LOGIN redirect #bug (demo)',
      '- [ ] login #Bug on other (this project)',
    ].join('\n'),
  )
  expect(await run($, 'notes', 'find nothing-like-this')).toBe('No notes match "nothing-like-this".')
  expect(await run($, 'notes', 'find')).toBe('Usage: /notes find <text>')
  // list_notes searches the same way.
  expect(await listNotes($, '#bugfix')).toBe('1 note matching "#bugfix":\n- [ ] login page copy #bugfix (demo)')
})

test('tags are lowercased, counted once per note, most used first', async ($, on) => {
  setup(on)
  expect(await run($, 'notes', 'tags')).toBe('No tags yet. Add #words to a note, e.g. /note fix login #bug')
  await run($, 'note', '#idea first #Idea again')
  await run($, 'note', 'second #idea #ui-polish')
  await run($, 'note', '-g #bug #été')
  await run($, 'note', 'not#atag and # alone')
  expect(await run($, 'notes', 'tags')).toBe('Tags: #idea (2)  #bug (1)  #été (1)  #ui-polish (1)')
})

test('export orders open before done, pinned first, then oldest', async ($, on) => {
  const { files } = setup(on)
  await run($, 'note', 'first')
  await run($, 'note', 'second\nwith a second line')
  await run($, 'note', 'third #todo')
  await run($, 'note', '-g global one')
  // Pin "third" and finish "first" through an import (the pane's buttons need a mount).
  files['NOTES.md'] = '- [x] first\n- [ ] 📌 third #todo\n'
  expect(await run($, 'notes', 'import')).toBe('📝 Imported NOTES.md: 0 added, 2 updated, 0 unchanged.')
  await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'from claude' })

  delete files['NOTES.md']
  expect(await run($, 'notes', 'export')).toBe('📝 Exported notes to NOTES.md in demo.')
  const [mark, title, , summary, ...rest] = files['NOTES.md']!.split('\n')
  expect(mark).toBe('<!-- exported by the claudepad mod for Claude Code; re-exporting replaces this file -->')
  expect(title).toBe('# Notes: demo')
  expect(summary).toMatch(/^_Exported \d{4}-\d{2}-\d{2}\. 4 project notes, 1 global note\._$/)
  expect(rest.join('\n')).toBe(
    [
      '',
      '## demo',
      '',
      '- [ ] 📌 third #todo',
      '- [ ] second',
      '  with a second line',
      '- [ ] from claude _(added by Claude)_',
      '- [x] first',
      '',
      '## Global',
      '',
      '- [ ] global one',
      '',
      '## Tags',
      '',
      '`#todo` (1)',
      '',
    ].join('\n'),
  )
})

test('export leaves a NOTES.md it did not write alone, unless --force', async ($, on) => {
  const { files } = setup(on, { 'NOTES.md': '# My own notes\n' })
  await run($, 'note', 'mine')
  expect(await run($, 'notes', 'export')).toBe(
    "NOTES.md already exists and wasn't written by the notepad. Run /notes export --force to replace it.",
  )
  expect(files['NOTES.md']).toBe('# My own notes\n')
  expect(await run($, 'notes', 'export --force')).toBe('📝 Exported notes to NOTES.md in demo.')
  expect(files['NOTES.md']).toContain('- [ ] mine')
})

test('import reads checkboxes, bullets, scopes and multi-line items', async ($, on) => {
  setup(on, {
    'NOTES.md': [
      '# Anything',
      'Loose text is not a note.',
      '- [ ] open task',
      '* [X] done task',
      '+ plain bullet',
      '- 📌 pinned _(added by Claude)_',
      '- [ ] multi-line',
      '  second line',
      '  ',
      '  after a blank line',
      '-   ',
      '## 🌐 Global',
      '- global item',
      '## Tags',
      '- #not-a-note',
      '### Later',
      '- project again',
    ].join('\r\n'),
  })
  expect(await run($, 'notes', 'import')).toBe('📝 Imported NOTES.md: 7 added, 0 updated, 0 unchanged.')
  expect(await listNotes($)).toBe(
    [
      'Notes for this project (demo):',
      '- [ ] open task',
      '- [x] done task',
      '- [ ] plain bullet',
      '- [ ] (pinned) pinned',
      '- [ ] multi-line',
      '      second line',
      '      ',
      '      after a blank line',
      '- [ ] project again',
      '',
      'Global notes:',
      '- [ ] global item',
      '',
      'Tags in use: (none)',
    ].join('\n'),
  )
  const added = await $.tool.call({ tool: 'mcp__claudepad__list_notes', query: 'pinned' })
  expect(String((added as { result?: unknown }).result)).toContain('(pinned) pinned')
})

test('import merges by loose text and scope; --replace swaps this project and global', async ($, on) => {
  const { files, cd } = setup(on)
  await run($, 'note', 'Keep   This')
  await run($, 'note', '-g shared')
  cd('/work/other')
  await run($, 'note', 'other project')
  cd('/work/demo')

  // Same text in the other scope is a new note; changed spacing and case still match.
  files['NOTES.md'] = '- [x] keep this\n- [ ] shared\n## Global\n- [ ] shared\n- [ ] new global\n'
  expect(await run($, 'notes', 'import')).toBe('📝 Imported NOTES.md: 2 added, 1 updated, 1 unchanged.')
  expect(await run($, 'notes', 'import')).toBe('📝 Imported NOTES.md: 0 added, 0 updated, 4 unchanged.')

  files['NOTES.md'] = '- only this\n'
  expect(await run($, 'notes', 'import --replace')).toBe('📝 Replaced 4 notes with 1 note from NOTES.md.')
  expect(await listNotes($)).toContain('Notes for this project (demo):\n- [ ] only this\n\nGlobal notes:\n(none)')
  // Other projects' notes are untouched.
  expect(await listNotes($, 'other')).toBe('1 note matching "other":\n- [ ] other project (other)')

  files['NOTES.md'] = 'no list here'
  expect(await run($, 'notes', 'import')).toBe(
    'NOTES.md has no list items to import (notes are lines starting with "- ").',
  )
  delete files['NOTES.md']
  expect(await run($, 'notes', 'import')).toBe('No NOTES.md in this folder to import.')
})

test('an export imports back unchanged', async ($, on) => {
  const { files } = setup(on)
  await run($, 'note', 'one #a')
  await run($, 'note', 'two\n  indented line')
  await run($, 'note', '-g three')
  await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'four', global: true })
  await run($, 'notes', 'export')
  const before = await listNotes($)
  expect(await run($, 'notes', 'import')).toBe('📝 Imported NOTES.md: 0 added, 0 updated, 4 unchanged.')
  expect(await listNotes($)).toBe(before)
  expect(files['NOTES.md']).toContain('- [ ] four _(added by Claude)_')
})

test('add_note refuses empty text', async ($, on) => {
  setup(on)
  expect(await $.tool.call({ tool: 'mcp__claudepad__add_note', text: '   ' })).toEqual({
    deny: 'add_note needs non-empty text.',
  })
})

test('pinned open notes for this project and global ride along with a prompt', async ($, on) => {
  const { files, cd } = setup(on)
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(context).toBeUndefined()

  cd('/work/other')
  await run($, 'note', 'elsewhere')
  cd('/work/demo')
  files['NOTES.md'] = '- 📌 here\n- [x] 📌 done\n- not pinned\n## Global\n- 📌 everywhere\n  two lines\n'
  await run($, 'notes', 'import')
  cd('/work/other')
  files['NOTES.md'] = '- 📌 elsewhere\n'
  await run($, 'notes', 'import')
  cd('/work/demo')

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(context).toEqual([
    "The user's pinned notes from their notepad (standing context; keep them in mind):\n" +
      '- here (this project)\n' +
      '- everywhere\n  two lines',
  ])
})

test('Claude can mark a note done or open again, and rewrite it, by its id', async ($, on) => {
  setup(on)
  const added = (await $.tool.call({ tool: 'mcp__claudepad__add_note', text: 'fix login #todo' })) as {
    result?: unknown
  }
  const id = await idOf($, 'fix login #todo')
  expect(added.result).toBe(`Added to the notepad (project): fix login #todo (id: ${id})`)

  expect(await $.tool.call({ tool: 'mcp__claudepad__complete_note', id })).toEqual({
    result: 'Marked done: fix login #todo',
  })
  expect(await listNotes($)).toContain('- [x] fix login #todo')
  expect(await $.tool.call({ tool: 'mcp__claudepad__complete_note', id, done: false })).toEqual({
    result: 'Marked open again: fix login #todo',
  })
  expect(await listNotes($)).toContain('- [ ] fix login #todo')

  // A new text brings new tags.
  expect(await $.tool.call({ tool: 'mcp__claudepad__update_note', id, text: 'fix login, half done #wip' })).toEqual({
    result: `Updated the note (id: ${id}): fix login, half done #wip`,
  })
  expect(await run($, 'notes', 'tags')).toBe('Tags: #wip (1)')
})

test('complete_note and update_note refuse an unknown id or empty text', async ($, on) => {
  setup(on)
  await run($, 'note', 'one')
  const id = await idOf($, 'one')
  expect(await $.tool.call({ tool: 'mcp__claudepad__complete_note', id: 'nope' })).toEqual({
    deny: `No note with id "nope". list_notes shows each note's id.`,
  })
  expect(await $.tool.call({ tool: 'mcp__claudepad__update_note', id: 'nope', text: 'x' })).toEqual({
    deny: `No note with id "nope". list_notes shows each note's id.`,
  })
  expect(await $.tool.call({ tool: 'mcp__claudepad__update_note', id, text: '  ' })).toEqual({
    deny: 'update_note needs non-empty text.',
  })
  expect(await listNotes($)).toContain('- [ ] one')
})
