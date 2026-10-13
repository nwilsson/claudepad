import { expect, test } from 'claude-code/testing'

import {
  asText,
  branchMark,
  doneByWeek,
  dueOf,
  editorCommand,
  exportOrder,
  groupByKey,
  keyOfProject,
  linksOf,
  localDate,
  mergeImport,
  migrate,
  overdue,
  normalize,
  onBranch,
  paneOrder,
  parseBranches,
  parseMarkdown,
  parseNoteArgs,
  matches,
  preview,
  resolvePath,
  statusFor,
  syncFile,
  tagCounts,
  tagged,
  toMarkdown,
  weekOf,
  withDone,
} from '../hooks/notes'
import type { Note } from '../types'

// hooks/notes.ts directly, for what the command-level tests in notes.test.ts
// cannot pin down: exact orders, dates, merge counts.

const note = (text: string, fields: Partial<Note> = {}): Note => ({
  id: text,
  text,
  isDone: false,
  isPinned: false,
  author: 'you',
  createdAt: 0,
  project: '/work/demo',
  ...fields,
})

test('the pane puts pinned first, the export puts open first', () => {
  const list = [
    note('old done pinned', { isDone: true, isPinned: true, createdAt: 1 }),
    note('new open', { createdAt: 3 }),
    note('old open', { createdAt: 2 }),
  ]
  expect(paneOrder(list).map(n => n.text)).toEqual(['old done pinned', 'old open', 'new open'])
  expect(exportOrder(list).map(n => n.text)).toEqual(['old open', 'new open', 'old done pinned'])
  // Neither sorts in place.
  expect(list[0]!.text).toBe('old done pinned')
})

test('the export is dated by the time it is given', () => {
  const markdown = toMarkdown([note('one')], '/work/demo', Date.UTC(2026, 9, 12, 12))
  expect(markdown.split('\n')[3]).toBe('_Exported 2026-10-12. 1 project note, 0 global notes._')
})

test('merge counts added, updated and removed, and dates new notes in file order', () => {
  const all = [
    note('keep', { isDone: false }),
    note('global', { project: null }),
    note('other', { project: '/work/other' }),
  ]
  const parsed = parseMarkdown('- [x] KEEP\n- new one\n- new two\n')

  const merged = mergeImport(all, parsed, '/work/demo', false, 1000)
  expect([merged.added, merged.updated, merged.removed]).toEqual([2, 1, 0])
  expect(merged.list.map(n => [n.text, n.isDone, n.createdAt])).toEqual([
    ['keep', true, 0],
    ['global', false, 0],
    ['other', false, 0],
    ['new one', false, 1001],
    ['new two', false, 1002],
  ])
  // The input list is left alone.
  expect(all[0]!.isDone).toBe(false)

  const replaced = mergeImport(all, parsed, '/work/demo', true, 1000)
  expect([replaced.added, replaced.updated, replaced.removed]).toEqual([3, 0, 2])
  expect(replaced.list.map(n => n.text)).toEqual(['other', 'KEEP', 'new one', 'new two'])
})

test('tags are stored with a note, and read from the text when a note has none stored', () => {
  expect(tagged(note('fix #Bug and #bug #ui-x')).tags).toEqual(['bug', 'ui-x'])
  // Search and counts read the stored tags...
  const stored = { ...note('plain text'), tags: ['kept'] }
  expect(matches(stored, '#kept')).toBe(true)
  // ...and fall back to the text for an old note.
  const old = note('old #Legacy')
  expect(old.tags).toBeUndefined()
  expect(matches(old, '#legacy')).toBe(true)
  expect(tagCounts([stored, old, tagged(note('again #legacy'))])).toEqual([
    ['legacy', 2],
    ['kept', 1],
  ])
})

test('merge matches through its key map as a scan would: first alike wins, repeats merge', () => {
  const all = [note('twin', { id: 'first' }), note('twin', { id: 'second' }), note('twin', { project: null })]
  const parsed = parseMarkdown('- [x] Twin\n- new #Tag\n- NEW  #tag\n## Global\n- twin\n')
  const merged = mergeImport(all, parsed, '/work/demo', false, 0)
  expect([merged.added, merged.updated]).toEqual([1, 1])
  expect(merged.list.map(n => [n.id === 'first' || n.id === 'second' ? n.id : n.text, n.isDone])).toEqual([
    ['first', true],
    ['second', false],
    ['twin', false],
    ['new #Tag', false],
  ])
  // A note the import adds carries its tags.
  expect(merged.list[3]!.tags).toEqual(['tag'])
})

test('a store key fits the 256-character key limit, however long the folder', () => {
  expect(keyOfProject(null)).toBe('global')
  expect(keyOfProject('e:/code/x')).toBe('project:e:/code/x')
  const long = `/${'d'.repeat(300)}`
  const key = keyOfProject(long)
  expect(key.length).toBeLessThanOrEqual(256)
  expect(key.startsWith(`project:/${'d'.repeat(199)}…`)).toBe(true)
  // Long folders that share the first 200 characters still get their own keys.
  expect(keyOfProject(`${long}x`)).not.toBe(key)
  expect(keyOfProject(long)).toBe(key)
})

test('migrate folds the old list into per-key lists, and again changes nothing', () => {
  const legacy = [note('a1'), note('g1', { project: null }), note('a2')]
  const once = migrate(legacy, new Map())
  expect([...once].map(([key, list]) => [key, list.map(n => n.id)])).toEqual([
    ['project:/work/demo', ['a1', 'a2']],
    ['global', ['g1']],
  ])
  expect(migrate(legacy, once)).toEqual(once)
  // A note already stored keeps its stored copy, even under another key.
  const moved = new Map([['global', [note('a1', { project: null, text: 'moved' })]]])
  expect([...migrate(legacy, moved)].map(([key, list]) => [key, list.map(n => n.text)])).toEqual([
    ['global', ['moved', 'g1']],
    ['project:/work/demo', ['a2']],
  ])
  expect([...groupByKey(legacy).keys()]).toEqual(['project:/work/demo', 'global'])
})

test('status counts open notes here and global, and is empty with none', () => {
  const list = [
    note('here'),
    note('here done', { isDone: true }),
    note('global', { project: null }),
    note('elsewhere', { project: '/work/other' }),
  ]
  expect(statusFor(list, '/work/demo')).toBe('📝 1 here · 1 global')
  expect(statusFor([note('elsewhere', { project: '/work/other' })], '/work/demo')).toBeUndefined()
})

test('small helpers: folder spelling, /note flags, previews', () => {
  expect(normalize('E:\\Code\\Demo\\')).toBe('e:/code/demo')
  expect(parseNoteArgs('-g  milk ')).toEqual({ text: 'milk', where: 'global', isLast: false })
  expect(parseNoteArgs('-gx milk')).toEqual({ text: '-gx milk', where: 'project', isLast: false })
  expect(parseNoteArgs('--last -g #idea')).toEqual({ text: '#idea', where: 'global', isLast: true })
  expect(parseNoteArgs('-g --last')).toEqual({ text: '', where: 'global', isLast: true })
  // Flags count only before the text.
  expect(parseNoteArgs('see --last -g')).toEqual({ text: 'see --last -g', where: 'project', isLast: false })
  // -b is the branch; the later of -g and -b wins.
  expect(parseNoteArgs('-b fix it')).toEqual({ text: 'fix it', where: 'branch', isLast: false })
  expect(parseNoteArgs('--branch --last')).toEqual({ text: '', where: 'branch', isLast: true })
  expect(parseNoteArgs('-b -g x')).toEqual({ text: 'x', where: 'global', isLast: false })
  expect(preview('first\nsecond')).toBe('first')
  expect(preview('x'.repeat(61))).toBe(`${'x'.repeat(59)}…`)
})

test('a due date is #due: and a real YYYY-MM-DD date', () => {
  expect(dueOf('call the bank #due:2026-10-20')).toBe('2026-10-20')
  expect(dueOf('#due:2026-10-20, then relax')).toBe('2026-10-20')
  expect(dueOf('no date #due')).toBeUndefined()
  expect(dueOf('not a day #due:2026-02-30')).toBeUndefined()
  expect(dueOf('glued #due:2026-10-20x')).toBeUndefined()
  expect(dueOf('mid-word a#due:2026-10-20')).toBeUndefined()
  expect(localDate(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
})

test('overdue: open notes here and global due before today, earliest first; status counts them', () => {
  const list = [
    note('later #due:2026-10-30'),
    note('today #due:2026-10-12'),
    note('late #due:2026-10-10'),
    note('later still', { project: null }),
    note('global late #due:2026-10-01', { project: null }),
    note('done late #due:2026-10-01', { isDone: true }),
    note('elsewhere late #due:2026-10-01', { project: '/work/other' }),
  ]
  expect(overdue(list, '/work/demo', '2026-10-12').map(n => n.text)).toEqual([
    'global late #due:2026-10-01',
    'late #due:2026-10-10',
  ])
  expect(statusFor(list, '/work/demo', '2026-10-12')).toBe('📝 3 here · 2 global · ⏰ 2 overdue')
  expect(statusFor(list, '/work/demo')).toBe('📝 3 here · 2 global')
})

test('by due: pinned and open first still, then earliest date, then undated, each oldest first', () => {
  const list = [
    note('undated old', { createdAt: 1 }),
    note('late #due:2026-10-30', { createdAt: 2 }),
    note('undated new', { createdAt: 3 }),
    note('early #due:2026-10-01', { createdAt: 4 }),
    note('same day, newer #due:2026-10-01', { createdAt: 5 }),
    note('pinned late #due:2026-12-01', { isPinned: true, createdAt: 6 }),
    note('done early #due:2026-01-01', { isDone: true, createdAt: 7 }),
    note('done undated', { isDone: true, createdAt: 0 }),
  ]
  expect(paneOrder(list, true).map(n => n.text)).toEqual([
    'pinned late #due:2026-12-01',
    'early #due:2026-10-01',
    'same day, newer #due:2026-10-01',
    'late #due:2026-10-30',
    'undated old',
    'undated new',
    'done early #due:2026-01-01',
    'done undated',
  ])
  // Without it, the order is as before: by when each was added.
  expect(paneOrder(list).map(n => n.text).slice(1, 5)).toEqual([
    'undated old',
    'late #due:2026-10-30',
    'undated new',
    'early #due:2026-10-01',
  ])
})

test('the listing marks open notes overdue or due today, and ends with the date it was given', () => {
  const list = [
    note('late #due:2026-10-10'),
    note('today #due:2026-10-12'),
    note('later #due:2026-10-30'),
    note('done late #due:2026-10-01', { isDone: true }),
    note('global late #due:2026-10-01', { project: null }),
  ]
  expect(asText(list, '/work/demo', { today: '2026-10-12' }).split('\n')).toEqual([
    'Notes for this project (demo):',
    '- [ ] late #due:2026-10-10 (overdue)',
    '- [ ] today #due:2026-10-12 (due today)',
    '- [ ] later #due:2026-10-30',
    '- [x] done late #due:2026-10-01',
    '',
    'Global notes:',
    '- [ ] global late #due:2026-10-01 (overdue)',
    '',
    'Tags in use: #due (5)',
    '',
    'Today is 2026-10-12.',
  ])
  // The mark comes before the id, and a search marks and dates too.
  expect(asText(list, '/work/demo', { search: 'late', withIds: true, today: '2026-10-12' }).split('\n')).toEqual([
    '4 notes matching "late":',
    '- [ ] late #due:2026-10-10 (overdue) (id: late #due:2026-10-10) (this project)',
    '- [ ] later #due:2026-10-30 (id: later #due:2026-10-30) (this project)',
    '- [x] done late #due:2026-10-01 (id: done late #due:2026-10-01) (this project)',
    '- [ ] global late #due:2026-10-01 (overdue) (id: global late #due:2026-10-01) (global)',
    '',
    'Today is 2026-10-12.',
  ])
  // With no date given, nothing is marked; with no dated note listed, no date is added.
  expect(asText(list, '/work/demo')).not.toContain('(overdue)')
  expect(asText([note('plain')], '/work/demo', { today: '2026-10-12' })).not.toContain('Today is')
})

test('a file reference is a path with an extension, then :line and maybe :column', () => {
  expect(linksOf('see hooks/register.tsx:42, then (E:\\Code\\x.ts:3:7) and `README.md:1`')).toEqual([
    { path: 'hooks/register.tsx', line: 42, text: 'hooks/register.tsx:42' },
    { path: 'E:\\Code\\x.ts', line: 3, column: 7, text: 'E:\\Code\\x.ts:3:7' },
    { path: 'README.md', line: 1, text: 'README.md:1' },
  ])
  // Not references: no extension, a URL, a time, a line number glued to more.
  expect(linksOf('localhost:3000 https://x.dev/a.ts:3 at 10:30 a.ts:12b Makefile:3')).toEqual([])
})

test('a reference resolves under the note folder unless absolute, and opens in the chosen editor', () => {
  expect(resolvePath('src/a.ts', 'E:\\Code\\X\\')).toBe('E:\\Code\\X/src/a.ts')
  expect(resolvePath('./a.ts', '/work/demo')).toBe('/work/demo/a.ts')
  expect(resolvePath('/etc/a.conf', '/work/demo')).toBe('/etc/a.conf')
  expect(resolvePath('C:/b.ts', '/work/demo')).toBe('C:/b.ts')

  expect(editorCommand('vscode', '/w/a.ts', { line: 4 })).toEqual(['code', '-g', '/w/a.ts:4'])
  expect(editorCommand('cursor', '/w/a.ts', { line: 4, column: 2 })).toEqual(['cursor', '-g', '/w/a.ts:4:2'])
  expect(editorCommand('jetbrains', '/w/a.ts', { line: 4, column: 2 })).toEqual([
    'idea', '--line', '4', '--column', '2', '/w/a.ts',
  ])
})

test('done keeps its time: set on done, cleared on reopen, kept when nothing changes', () => {
  const done = withDone(note('a'), true, 500)
  expect([done.isDone, done.doneAt]).toEqual([true, 500])
  expect(withDone(done, true, 900)).toBe(done)
  const open = withDone(done, false, 900)
  expect([open.isDone, 'doneAt' in open]).toEqual([false, false])
})

test('done notes group by the Monday of their week, newest first, undated last', () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 15).getTime()
  expect(weekOf(at(2026, 10, 12))).toBe('2026-10-12') // a Monday
  expect(weekOf(at(2026, 10, 18))).toBe('2026-10-12') // its Sunday
  expect(weekOf(at(2026, 10, 1))).toBe('2026-09-28') // across a month
  const list = [
    note('undated', { isDone: true }),
    note('open'),
    note('last week', { isDone: true, doneAt: at(2026, 10, 9) }),
    note('monday', { isDone: true, doneAt: at(2026, 10, 12) }),
    note('friday', { isDone: true, doneAt: at(2026, 10, 16) }),
  ]
  expect(doneByWeek(list).map(([week, done]) => [week, done.map(n => n.text)])).toEqual([
    ['2026-10-12', ['friday', 'monday']],
    ['2026-10-05', ['last week']],
    [null, ['undated']],
  ])
})

test('archived notes stay out of lists, counts and export, and an import leaves them archived', () => {
  const list = [note('kept #a'), note('shelved #b', { archivedAt: 1, isDone: true })]
  expect(statusFor(list, '/work/demo')).toBe('📝 1 here · 0 global')
  expect(toMarkdown(list, '/work/demo', 0)).not.toContain('shelved')
  const merged = mergeImport(list, parseMarkdown('- [ ] shelved #b\n'), '/work/demo', false, 0)
  expect([merged.added, merged.updated]).toEqual([0, 0])
  expect(merged.list[1]).toEqual(list[1])
})

test('git branch output: the starred line is current, a detached HEAD is none', () => {
  expect(parseBranches('*main\n feature/login\r\n old\n')).toEqual({ current: 'main', all: ['main', 'feature/login', 'old'] })
  expect(parseBranches('*(HEAD detached at 1a2b3c4)\n main\n')).toEqual({ current: null, all: ['main'] })
  expect(parseBranches('')).toEqual({ current: null, all: [] })
})

test('other branches are left out until checked out, and come back once their branch is gone', () => {
  const branches = { current: 'feat', all: ['main', 'feat', 'other'] }
  const list = [
    note('whole project'),
    note('on feat', { branch: 'feat' }),
    note('on other #due:2026-10-01', { branch: 'other' }),
    note('on deleted', { branch: 'deleted' }),
    note('another project, other branch', { project: '/work/x', branch: 'other' }),
  ]
  expect(onBranch(list, '/work/demo', branches).map(n => n.text)).toEqual([
    'whole project',
    'on feat',
    'on deleted',
    'another project, other branch',
  ])
  expect(branchMark(list[1]!, '/work/demo', branches)).toBe(' 🌿 feat')
  expect(branchMark(list[3]!, '/work/demo', branches)).toBe(' 🌿 deleted (gone)')
  expect(branchMark(list[0]!, '/work/demo', branches)).toBe('')
  // Another project's branches are not known, so its notes are never called gone.
  expect(branchMark(list[4]!, '/work/demo', branches)).toBe(' 🌿 other')
  // The other branch's note does not count, and its overdue date does not either.
  expect(statusFor(onBranch(list, '/work/demo', branches), '/work/demo', '2026-10-12')).toBe('📝 3 here · 0 global')
  // Outside a repository every branch is gone: nothing is hidden.
  expect(onBranch(list, '/work/demo', { current: null, all: [] })).toHaveLength(5)
})

test('the listing names the branch, leaves out other branches, and a search still finds them', () => {
  const branches = { current: 'feat', all: ['main', 'feat', 'other'] }
  const list = [note('fix it'), note('fix feat', { branch: 'feat' }), note('fix other', { branch: 'other' }), note('fix gone', { branch: 'gone' })]
  expect(asText(list, '/work/demo', { branches }).split('\n').slice(0, 4)).toEqual([
    'Notes for this project (demo, on branch feat):',
    '- [ ] fix it',
    '- [ ] fix feat (branch feat)',
    '- [ ] fix gone (branch gone, since deleted)',
  ])
  expect(asText(list, '/work/demo', { branches, search: 'other' })).toBe(
    '1 note matching "other":\n- [ ] fix other (branch other) (this project)',
  )
})

test('branch notes export under their own heading and import back onto their branch', () => {
  const branches = { current: 'feat', all: ['main', 'feat', 'other'] }
  const list = [
    note('whole', { createdAt: 1 }),
    note('feat work', { branch: 'feat', createdAt: 2 }),
    note('other work', { branch: 'other', createdAt: 3 }),
    note('zombie', { branch: 'deleted', createdAt: 4 }),
  ]
  const markdown = toMarkdown(list, '/work/demo', 0, branches)
  expect(markdown).toContain('## demo\n\n- [ ] whole\n\n## 🌿 feat\n\n- [ ] feat work\n\n## 🌿 deleted\n\n- [ ] zombie\n\n## Global')
  expect(markdown).not.toContain('other work')

  const parsed = parseMarkdown(markdown)
  expect(parsed.map(item => [item.text, item.branch])).toEqual([
    ['whole', undefined],
    ['feat work', 'feat'],
    ['zombie', 'deleted'],
  ])
  // Back unchanged: the branch is part of the match.
  const merged = mergeImport(list, parsed, '/work/demo', false, 10, branches)
  expect([merged.added, merged.updated]).toEqual([0, 0])
  // The same text on another branch is a different note.
  const elsewhere = mergeImport(list, parseMarkdown('## 🌿 main\n- [ ] whole\n'), '/work/demo', false, 10, branches)
  expect(elsewhere.added).toBe(1)
  expect(elsewhere.list.at(-1)).toMatchObject({ text: 'whole', branch: 'main', project: '/work/demo' })
  // --replace swaps what the file could hold, and keeps the other branch's note.
  const replaced = mergeImport(list, parseMarkdown('- [ ] fresh\n'), '/work/demo', true, 10, branches)
  expect(replaced.list.map(n => n.text)).toEqual(['other work', 'fresh'])
  expect(replaced.removed).toBe(3)
})

test('a NOTES.md edit adds new lines, applies marks, archives removed lines and restores put-back ones', () => {
  const list = [
    note('keep', { id: 'k' }),
    note('drop', { id: 'd' }),
    note('tick', { id: 't' }),
    note('global drop', { id: 'g', project: null }),
    note('shelved', { id: 's', archivedAt: 1 }),
    note('elsewhere drop', { id: 'e', project: '/work/other' }),
  ]
  const before = parseMarkdown('## demo\n- [ ] keep\n- [ ] drop\n- [ ] tick\n## Global\n- [ ] global drop\n')
  const after = parseMarkdown('## demo\n- [ ] keep\n- [x] tick\n- [ ] new one\n- [ ] shelved\n## Global\n')
  const result = syncFile(list, before, after, '/work/demo', 5)
  expect([result.added, result.updated, result.restored]).toEqual([1, 1, 1])
  // Archiving is left to the caller, which offers undo.
  expect(result.archive).toEqual(['d', 'g'])
  const byId = new Map(result.list.map(n => [n.id, n]))
  expect(byId.get('t')).toMatchObject({ isDone: true, doneAt: 5 })
  expect(byId.get('s')!.archivedAt).toBeUndefined()
  expect(byId.get('e')).toEqual(list[5])
  expect(result.list.at(-1)).toMatchObject({ text: 'new one', project: '/work/demo' })

  // An archived note whose line was in the file all along stays archived.
  const still = syncFile(list, parseMarkdown('- [ ] shelved\n- [ ] keep\n'), parseMarkdown('- [ ] shelved\n'), '/work/demo', 5)
  expect([still.restored, still.archive]).toEqual([0, ['k']])

  // A line the edit left alone changes nothing: "keep", ticked in the notepad
  // since the export, stays done, and "gone for good" (deleted) stays gone.
  const ticked = [note('keep', { id: 'k', isDone: true }), note('other', { id: 'o' })]
  const file = '- [ ] keep\n- [ ] gone for good\n- [ ] other\n'
  const edited = syncFile(ticked, parseMarkdown(file), parseMarkdown(file.replace('- [ ] other', '- [x] other')), '/work/demo', 5)
  expect([edited.added, edited.updated]).toEqual([0, 1])
  expect(edited.list.map(n => [n.text, n.isDone])).toEqual([
    ['keep', true],
    ['other', true],
  ])
})
