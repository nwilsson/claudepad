// The notepad's multi-line editor: a surface module drawn by a `Client` in
// the pane. It runs on the drawing side, keeps the text and cursor in its
// own local state, and posts to the hooks module: `{ type: 'draft', text }`
// on every change, `{ type: 'save', text }` on Ctrl+S.
import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Props = { text: string }
type State = { lines: string[]; row: number; col: number }

/** Lines drawn at once; the window follows the cursor. */
const WINDOW = 14

/** Key names that are never typed text. */
const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'insert',
])

const fromText = (text: string): State => {
  const lines = text.split('\n')
  const row = lines.length - 1
  return { lines, row, col: lines[row]!.length }
}

const toText = (state: State) => state.lines.join('\n')

const insert = (state: State, typed: string): State => {
  const pieces = typed.replace(/\r\n?/g, '\n').split('\n')
  const line = state.lines[state.row]!
  const before = line.slice(0, state.col)
  const after = line.slice(state.col)
  const last = pieces.length - 1
  const added = pieces.map((piece, i) =>
    (i === 0 ? before : '') + piece + (i === last ? after : ''),
  )
  const lines = [...state.lines.slice(0, state.row), ...added, ...state.lines.slice(state.row + 1)]
  const row = state.row + last
  const col = (last === 0 ? before.length : 0) + pieces[last]!.length
  return { lines, row, col }
}

/** The next state for one key, or 'save', or the same state when nothing changes. */
const apply = (state: State, event: ClientKeyEvent): State | 'save' => {
  const { lines, row, col } = state
  const line = lines[row]!
  const key = event.key

  if (event.ctrl && key.toLowerCase() === 's') return 'save'

  switch (key) {
    case 'return':
    case 'enter':
      return insert(state, '\n')
    case 'tab':
      return insert(state, '  ')
    case 'backspace':
      if (col > 0) {
        const next = [...lines]
        next[row] = line.slice(0, col - 1) + line.slice(col)
        return { lines: next, row, col: col - 1 }
      }
      if (row > 0) {
        const above = lines[row - 1]!
        const next = [...lines.slice(0, row - 1), above + line, ...lines.slice(row + 1)]
        return { lines: next, row: row - 1, col: above.length }
      }
      return state
    case 'delete':
      if (col < line.length) {
        const next = [...lines]
        next[row] = line.slice(0, col) + line.slice(col + 1)
        return { lines: next, row, col }
      }
      if (row < lines.length - 1) {
        const next = [...lines.slice(0, row), line + lines[row + 1]!, ...lines.slice(row + 2)]
        return { lines: next, row, col }
      }
      return state
    case 'left':
      if (col > 0) return { lines, row, col: col - 1 }
      if (row > 0) return { lines, row: row - 1, col: lines[row - 1]!.length }
      return state
    case 'right':
      if (col < line.length) return { lines, row, col: col + 1 }
      if (row < lines.length - 1) return { lines, row: row + 1, col: 0 }
      return state
    case 'up':
      if (row === 0) return { lines, row, col: 0 }
      return { lines, row: row - 1, col: Math.min(col, lines[row - 1]!.length) }
    case 'down':
      if (row === lines.length - 1) return { lines, row, col: line.length }
      return { lines, row: row + 1, col: Math.min(col, lines[row + 1]!.length) }
    case 'pageup': {
      const to = Math.max(0, row - WINDOW)
      return { lines, row: to, col: Math.min(col, lines[to]!.length) }
    }
    case 'pagedown': {
      const to = Math.min(lines.length - 1, row + WINDOW)
      return { lines, row: to, col: Math.min(col, lines[to]!.length) }
    }
    case 'home':
      return { lines, row, col: 0 }
    case 'end':
      return { lines, row, col: line.length }
  }

  // Anything else that isn't a named key is text: one character, or a paste.
  if (event.ctrl || event.meta || SPECIAL.has(key) || key === '') return state
  return insert(state, key)
}

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? fromText(props.text)

  surface.onKey(event => {
    const current = surface.state ?? fromText(props.text)
    const next = apply(current, event)
    if (next === 'save') {
      surface.post({ type: 'save', text: toText(current) })
      return
    }
    if (next !== current) {
      surface.setState(next)
      surface.post({ type: 'draft', text: toText(next) })
    }
  })

  const start = Math.max(0, Math.min(state.row - Math.floor(WINDOW / 2), state.lines.length - WINDOW))
  const shown = state.lines.slice(start, start + WINDOW)
  const gutter = String(state.lines.length).length

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {start > 0 && <Text dimColor>{`  ↑ ${start} more`}</Text>}
      {shown.map((line, i) => {
        const row = start + i
        const number = <Text dimColor>{`${String(row + 1).padStart(gutter)} │ `}</Text>
        if (row !== state.row) {
          return (
            <Text>
              {number}
              {line}
            </Text>
          )
        }
        const at = line[state.col] ?? ' '
        return (
          <Text>
            {number}
            {line.slice(0, state.col)}
            <Text inverse>{at}</Text>
            {line.slice(state.col + 1)}
          </Text>
        )
      })}
      {start + WINDOW < state.lines.length && (
        <Text dimColor>{`  ↓ ${state.lines.length - start - WINDOW} more`}</Text>
      )}
    </Box>
  )
}

export default Editor
