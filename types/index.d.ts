export type PreviewFile = {
  /** Path as given: absolute, or relative to the session's directory. */
  path: string
  /** Bumped when the file changes on disk, so the pane redraws. */
  rev: number
}

/** The file's text before the pane's last edit, for Undo. */
export type UndoEntry = { path: string; text: string; label: string }

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
    }
  }
}
