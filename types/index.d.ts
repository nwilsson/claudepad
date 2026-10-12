export type Note = {
  id: string
  /** The note; may span several lines. */
  text: string
  isDone: boolean
  /** When it was last marked done; notes done before this was kept have none. */
  doneAt?: number
  isPinned: boolean
  /**
   * When it was archived: hidden from the lists, the status line, pinned
   * context and export, and shown in the pane's archive view until restored
   * or deleted for good.
   */
  archivedAt?: number
  /** Who wrote it: the person, or Claude through the add_note tool. */
  author: 'you' | 'claude'
  createdAt: number
  /**
   * The note's tags, lowercased, without the `#`, stored whenever its text is
   * written. Notes saved before tags were stored have none until loaded.
   */
  tags?: string[]
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

/** The last archive (one note, or every one `clear done` swept), kept for undo. */
export type ArchiveUndo = {
  /** This archive's own id: the same note archived again is a new archive. */
  id: string
  /** The notes it archived. */
  noteIds: string[]
  /** What it archived, as the pane and the toasts say it. */
  label: string
  /** While the pane shows its undo button (a few seconds after the archive). */
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
      /** The last archive, until it is undone or another one replaces it. */
      lastArchive: ArchiveUndo | null
      /** The pane shows the archive view (done notes by week, archived notes). */
      isArchiveView: boolean
    }
  }
}
