export type Note = {
  id: string
  /** The note; may span several lines. */
  text: string
  isDone: boolean
  isPinned: boolean
  /** Who wrote it: the person, or Claude through the add_note tool. */
  author: 'you' | 'claude'
  createdAt: number
  /**
   * The project folder the note belongs to (normalized path), or null for a
   * global note. Notes saved before projects existed have none: global.
   */
  project?: string | null
}

/** Where the pane's input adds new notes. */
export type Scope = 'project' | 'global'

/** The multi-line editor while it is open. */
export type EditorSession = {
  /** The note being edited, or 'new' for a note not saved yet. */
  id: string
  /** The text the editor opened with. */
  initial: string
  /** Line mode only: the line the input edits, or null to add a line. */
  line: number | null
}

/** The last deleted note, kept so it can be put back. */
export type DeletedNote = {
  /** This delete's own id: the same note deleted again is a new delete. */
  id: string
  note: Note
  /** Where it stood in the saved list. */
  index: number
  /** While the pane shows its undo button (a few seconds after the delete). */
  isOffered: boolean
}

declare module 'claude-code' {
  interface PluginState {
    claudepad: {
      notes: Note[]
      /** The open multi-line editor, or null. */
      editor: EditorSession | null
      /** The editor's current text, kept as it is typed. */
      draft: string
      /** Use the line-by-line editor even where the full editor can draw. */
      isLineMode: boolean
      /** The session's folder, normalized; empty before session.start. */
      folder: string
      scope: Scope
      /** The pane's search text; empty shows every note. */
      query: string
      /** The tag the pane filters on (lowercase, no `#`), or null for all. */
      tag: string | null
      /** The last deleted note, until it is restored or another is deleted. */
      deleted: DeletedNote | null
    }
  }
}
