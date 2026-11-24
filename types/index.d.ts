export type PreviewFile = {
  /** Path as given: absolute, or relative to the session's directory. */
  path: string
  /** Bumped when the file changes on disk, so the pane redraws. */
  rev: number
}

/** The file's text before the pane's last edit, for Undo. */
export type UndoEntry = { path: string; text: string; label: string }

/** A ✦ Edit in progress on one cell: composing, waiting for Claude, or showing a diff. */
export type AiEdit = {
  path: string
  index: number
  /** 1-based lines of the highlighted text in the cell, or null for the whole cell. */
  span: { start: number; end: number; text: string } | null
  /** The cell's source when ✦ Edit was pressed. */
  original: string
  instruction: string
  status: 'composing' | 'running' | 'review' | 'error'
  proposed: string
  message: string
}

declare module 'claude-code' {
  interface PluginState {
    'notebook-preview': {
      file: Shaped<PreviewFile | null>
      page: Shaped<number>
      showOutputs: Shaped<boolean>
      follow: Shaped<boolean>
      /** Index of the cell being edited, or null. */
      editing: Shaped<number | null>
      /** The text typed into the cell editor so far. */
      draft: Shaped<string>
      undo: Shaped<UndoEntry | null>
      /** Clicking a notebook or Markdown link in a reply opens it in the pane. */
      linkClicks: Shaped<boolean>
      ai: Shaped<AiEdit | null>
      /** Model used for inline edits: an alias such as haiku or sonnet. */
      aiModel: Shaped<string>
    }
  }
}
