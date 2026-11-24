import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PreviewFile, UndoEntry } from '../types'
import { applyEdit, basename, fileLinks, paginate, parse, pathFrom, previewKind } from './notebook'
import type { Cell, CellType, Doc, Edit, Output } from './notebook'

const PANE = 'notebook-preview'
// The theme's Claude orange: hover, editing and the kernel tag.
const ACCENT = 'claude'
const MAX_BYTES = 4 * 1024 * 1024

// Change a shape tag when that value's type changes: it declines what an
// earlier version stored, which outlives a reload.
const file = atom({ plugin: 'notebook-preview', key: 'file' } as const, null as PreviewFile | null, {
  shape: 'file-1',
})
const page = atom({ plugin: 'notebook-preview', key: 'page' } as const, 0, { shape: 'page-1' })
const showOutputs = atom({ plugin: 'notebook-preview', key: 'showOutputs' } as const, true, {
  shape: 'outputs-1',
})
const follow = atom({ plugin: 'notebook-preview', key: 'follow' } as const, true, { shape: 'follow-1' })
const editing = atom({ plugin: 'notebook-preview', key: 'editing' } as const, null as number | null, {
  shape: 'editing-1',
})
const draft = atom({ plugin: 'notebook-preview', key: 'draft' } as const, '', { shape: 'draft-1' })
const undo = atom({ plugin: 'notebook-preview', key: 'undo' } as const, null as UndoEntry | null, {
  shape: 'undo-1',
})
const linkClicks = atom({ plugin: 'notebook-preview', key: 'linkClicks' } as const, true, {
  shape: 'links-1',
})

const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const

function toolPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const field of PATH_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && previewKind(value) !== undefined) return value
  }
  return undefined
}

async function bump($: EngineInterface): Promise<void> {
  await update($, file, value => (value === null ? null : { ...value, rev: value.rev + 1 }))
}

async function show($: EngineInterface, path: string, focus = false): Promise<void> {
  const current = await read($, file)
  if (current?.path !== path) {
    await update($, page, () => 0)
    await update($, editing, () => null)
  }
  await update($, file, () => ({ path, rev: (current?.rev ?? 0) + 1 }))
  await $.ui.open({ id: PANE, title: basename(path), ...(focus ? { focus: true } : {}) })
}

type Loaded = { doc: Doc } | { error: string }

async function load($: EngineInterface, path: string): Promise<Loaded> {
  if (previewKind(path) === undefined) return { error: `Not a notebook or Markdown file: ${path}` }
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return { error: `File not found: ${path}` }
  if (stat.size > MAX_BYTES) {
    return { error: `${basename(path)} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the 4 MB the pane reads. Use "Open as HTML".` }
  }
  try {
    return { doc: parse(await $.fs.read(path), path) }
  } catch (error) {
    return { error: `Could not read ${basename(path)}: ${String(error).slice(0, 300)}` }
  }
}

/** Apply one edit to the file on disk, keeping the old text for Undo. */
async function edit($: EngineInterface, path: string, change: Edit, label: string): Promise<void> {
  const before = await $.fs.read(path)
  const after = applyEdit(before, path, change)
  if (after === before) return
  await $.fs.write(path, after)
  await update($, undo, () => ({ path, text: before, label }))
  await bump($)
}

async function exportHtml($: EngineInterface, path: string): Promise<void> {
  const html = path.replace(/\.[^.]+$/, '.html')
  const argv =
    previewKind(path) === 'notebook'
      ? ['jupyter', 'nbconvert', '--to', 'html', path]
      : ['pandoc', '--standalone', '--metadata', `title=${basename(path)}`, path, '-o', html]
  let ran = await $.process.run(argv, { timeoutMs: 120_000 }).catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) {
    // The app may start without the person's PATH (conda, pipx): try a login shell.
    ran = await $.process.run(['/bin/sh', '-lc', 'exec "$@"', 'sh', ...argv], { timeoutMs: 120_000 }).catch(() => undefined)
  }
  if (ran === undefined || ran.exitCode !== 0) {
    const tool = previewKind(path) === 'notebook' ? 'jupyter nbconvert (pip install nbconvert)' : 'pandoc'
    $.ui.toast(`Could not export: ${tool} did not run. ${(ran?.stderr ?? '').split('\n').filter(Boolean).pop() ?? ''}`)
    return
  }
  $.ui.toast(`Saved ${basename(html)} next to ${basename(path)}.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'notebook',
      description: 'Open a .ipynb or .md file in the notebook pane: /notebook path/to/file.ipynb',
    })
    await $.command.register({
      name: 'notebook-follow',
      description: 'Turn on or off: the notebook pane follows files Claude reads or edits',
    })
    await $.command.register({
      name: 'notebook-links',
      description: 'Turn on or off: clicking a .ipynb or .md link in a reply opens it in the notebook pane',
    })

    // Redraw when the open file changes on disk (Claude, Colab, an editor).
    let seen: { path: string; mtime: number } | undefined
    $.clock.every(2000, async () => {
      const current = await read($, file)
      if (current === null) return
      const stat = await $.fs.stat(current.path).catch(() => undefined)
      if (stat === undefined) return
      if (seen?.path === current.path && stat.mtimeMs !== seen.mtime) await bump($)
      seen = { path: current.path, mtime: stat.mtimeMs }
    })

    return next(e)
  })

  on('command.run', { command: 'notebook' }, async ($, e) => {
    const typed = pathFrom(e.args)
    if (typed === '') {
      const current = await read($, file)
      if (current === null) return { text: 'Usage: /notebook path/to/file.ipynb (or a .md file)' }
      await $.ui.open({ id: PANE, title: basename(current.path), focus: true })
      return { text: `Showing ${current.path}` }
    }
    if (previewKind(typed) === undefined) return { text: `Not a .ipynb or .md file: ${typed}` }
    if (!(await $.fs.exists(typed))) return { text: `File not found: ${typed}` }
    await show($, typed, true)
    return { text: `Opened ${typed}` }
  })

  on('command.run', { command: 'notebook-follow' }, async $ => {
    const now = await update($, follow, value => !value)
    return {
      text: now
        ? 'The notebook pane now follows .ipynb and .md files Claude reads or edits.'
        : 'The notebook pane no longer follows files. Use /notebook <path> to open one.',
    }
  })

  on('command.run', { command: 'notebook-links' }, async $ => {
    const now = await update($, linkClicks, value => !value)
    return {
      text: now
        ? 'Clicking a .ipynb or .md link in a reply now opens it in the notebook pane.'
        : 'Links in replies open as before.',
    }
  })

  // Follow notebooks and Markdown files Claude reads, writes or edits.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = toolPath(e)
    if (path !== undefined && !result.isError && (await read($, follow))) await show($, path)
    return result
  })

  // A click on a notebook or Markdown link in a reply opens it in the pane.
  // Only replies holding such a link are redrawn; the rest draw as before.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || !/\.(ipynb|md|markdown|mdx)\b/i.test(e.props.text)) return next(e)
    if (!(await read($, linkClicks))) return next(e)
    const { text, hrefs } = fileLinks(e.props.text, await $.session.cwd())
    if (hrefs.length === 0) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return (
      <Markdown
        key={`reply-${e.requestId}`}
        text={text}
        pressableLinks={hrefs}
        onLinkPress={link => show($, pathFrom(link.href), true)}
      />
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown, Input, Link } = $.ui.resolve(e)
    const current = await read($, file)
    if (current === null) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Notebook</Text>
          <Text dimColor>No file open. Run /notebook path/to/file.ipynb, click a .ipynb or .md link in a reply, or ask Claude to open one.</Text>
        </Box>
      )
    }
    const path = current.path
    const loaded = await load($, path)
    if ('error' in loaded) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="error">{loaded.error}</Text>
          <Button key="refresh" hotkey="r" onPress={() => show($, path)}>Refresh</Button>
        </Box>
      )
    }
    const { doc } = loaded
    const outputs = await read($, showOutputs)
    const editingIndex = await read($, editing)
    const lastUndo = await read($, undo)
    const canUndo = lastUndo !== null && lastUndo.path === path
    const pages = paginate(doc.cells, outputs)
    const at = Math.min(await read($, page), pages.length - 1)
    const go = (to: number) => update($, page, () => Math.max(0, Math.min(pages.length - 1, to)))
    const isNotebook = doc.kind === 'notebook'
    const canHover = e.surface === 'desktop' || e.surface === 'vscode'
    const absolute = path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
    const htmlPath = absolute.replace(/\.[^.]+$/, '.html')
    const hasHtml = await $.fs.exists(htmlPath)

    const startEdit = async (cell: Cell) => {
      await update($, draft, () => cell.source)
      await update($, editing, () => cell.index)
    }
    const save = async (index: number, value?: string) => {
      const source = value ?? (await read($, draft))
      await edit($, path, { op: 'set', index, source }, `Edit cell ${index + 1}`)
      await update($, editing, () => null)
    }
    const insert = async (after: number, type: CellType) => {
      await edit($, path, { op: 'insert', after, type }, `Add ${type} cell`)
      await update($, draft, () => '')
      await update($, editing, () => after + 1)
    }
    const ask = (cell: Cell) =>
      $.prompt.fill({
        text: `In ${path}, ${isNotebook ? `cell ${cell.index + 1}` : `the section starting "${cell.source.split('\n')[0]?.slice(0, 60) ?? ''}"`}: `,
        mode: 'insert',
      })

    const drawOutput = (output: Output, key: string) => {
      switch (output.kind) {
        case 'markdown':
          return <Markdown key={key} text={output.text} />
        case 'text':
          return <Code key={key} source={output.text} language={output.language} />
        case 'error':
          return (
            <Box key={key} borderStyle="single" borderColor="error" paddingX={1}>
              <Code source={output.text} language="pytb" />
            </Box>
          )
        case 'note':
          return (
            <Text key={key} dimColor italic>
              {output.text}
            </Text>
          )
      }
    }

    // Where the pointer can hover, a cell's tools show only while it is hovered,
    // floating over its top-right corner as in Cursor; elsewhere they sit inline.
    const reveal = (scope: string) =>
      canHover ? { display: 'none' as const, hover: { scope, display: 'flex' as const } } : {}
    const float = canHover ? { position: 'absolute' as const, top: 0, right: 1 } : {}

    // `_name` documents the control; the engine names a Button by its label.
    const tool = (key: string, _name: string, label: string, onPress: () => unknown) => (
      <Button key={key} label={label} plain onPress={onPress} />
    )

    const toolbar = (cell: Cell, scope: string) => (
      <Box
        flexDirection="row"
        gap={1}
        paddingX={1}
        borderStyle="round"
        borderColor="subtle"
        alignSelf="flex-end"
        {...float}
        {...reveal(scope)}
      >
        {!cell.isCut && tool(`edit-${cell.index}`, 'Edit cell', '✎ Edit', () => startEdit(cell))}
        {tool(`ask-${cell.index}`, 'Ask Claude about this cell', '✦ Ask', () => ask(cell))}
        {isNotebook &&
          cell.type !== 'raw' &&
          tool(
            `retype-${cell.index}`,
            cell.type === 'code' ? 'Change to Markdown' : 'Change to code',
            cell.type === 'code' ? 'M↓' : '{ }',
            () =>
              edit($, path, { op: 'retype', index: cell.index, type: cell.type === 'code' ? 'markdown' : 'code' }, `Change cell ${cell.index + 1} type`),
          )}
        {tool(`up-${cell.index}`, 'Move cell up', '↑', () => edit($, path, { op: 'move', index: cell.index, by: -1 }, `Move cell ${cell.index + 1}`))}
        {tool(`down-${cell.index}`, 'Move cell down', '↓', () => edit($, path, { op: 'move', index: cell.index, by: 1 }, `Move cell ${cell.index + 1}`))}
        {tool(`delete-${cell.index}`, 'Delete cell', '✕', () => edit($, path, { op: 'delete', index: cell.index }, `Delete cell ${cell.index + 1}`))}
      </Box>
    )

    const adder = (cell: Cell, scope: string) => (
      <Box flexDirection="row" gap={2} justifyContent="center" alignItems="center" {...reveal(scope)}>
        <Text color={ACCENT}>──</Text>
        {isNotebook ? (
          <>
            {tool(`add-code-${cell.index}`, 'Add code cell below', '+ Code', () => insert(cell.index, 'code'))}
            {tool(`add-md-${cell.index}`, 'Add Markdown cell below', '+ Markdown', () => insert(cell.index, 'markdown'))}
          </>
        ) : (
          tool(`add-md-${cell.index}`, 'Add section below', '+ Section', () => insert(cell.index, 'markdown'))
        )}
        <Text color={ACCENT}>──</Text>
      </Box>
    )

    const editor = (cell: Cell) => (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Input
          key={`input-${cell.index}`}
          value={cell.source}
          rows={Math.min(24, Math.max(4, cell.source.split('\n').length + 1))}
          autoFocus
          submitLabel="Save"
          onInput={value => update($, draft, () => value)}
          onSubmit={value => save(cell.index, value)}
        />
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key={`save-${cell.index}`} variant="primary" onPress={() => save(cell.index)}>Save</Button>
          <Button key={`cancel-${cell.index}`} plain onPress={() => update($, editing, () => null)}>Cancel</Button>
          <Text dimColor>Enter to save · Shift+Enter for a new line</Text>
        </Box>
      </Box>
    )

    const drawCell = (cell: Cell) => {
      const scope = `cell-${cell.index}`
      const isEditing = editingIndex === cell.index
      const isCode = cell.type === 'code'
      const gutter = isCode ? `[${cell.count ?? ' '}]` : ''
      return (
        <Box key={scope} flexDirection="column" marginTop={1} hover={{ scope }}>
          {!canHover && !isEditing && toolbar(cell, scope)}
          <Box flexDirection="row">
            <Box width={6} flexShrink={0} paddingTop={isCode ? 1 : 0}>
              <Text dimColor hover={{ scope, color: ACCENT }}>
                {gutter}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              {isEditing ? (
                editor(cell)
              ) : isCode ? (
                <Box borderStyle="round" borderColor="subtle" paddingX={1} hover={{ scope, borderColor: ACCENT }}>
                  <Code source={cell.source === '' ? ' ' : cell.source} language={doc.language} />
                </Box>
              ) : cell.type === 'markdown' ? (
                <Box paddingX={1} paddingY={1}>
                  <Markdown text={cell.source === '' ? '*Empty Markdown cell. Hover and click Edit.*' : cell.source} dimColor={cell.source === ''} />
                </Box>
              ) : (
                <Code source={cell.source} language="text" />
              )}
              {outputs && cell.outputs.length > 0 && (
                <Box flexDirection="column" paddingX={1} marginTop={1}>
                  {cell.outputs.map((output, i) => drawOutput(output, `${scope}-out-${i}`))}
                </Box>
              )}
            </Box>
          </Box>
          {canHover && !isEditing && toolbar(cell, scope)}
          {!isEditing && adder(cell, scope)}
        </Box>
      )
    }

    const pager = (where: string) =>
      pages.length > 1 && (
        <Box flexDirection="row" gap={1} alignItems="center">
          {tool(`prev-${where}`, 'Previous page', '‹ Prev', () => go(at - 1))}
          <Text dimColor>
            {at + 1} / {pages.length}
          </Text>
          {tool(`next-${where}`, 'Next page', 'Next ›', () => go(at + 1))}
        </Box>
      )

    const visible = pages[at] ?? []
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={ACCENT}>◆</Text>
            <Text bold>{doc.title}</Text>
          </Box>
          <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
            <Text color={ACCENT}>{doc.kernel}</Text>
          </Box>
        </Box>
        <Text dimColor>{doc.summary}</Text>
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap" alignItems="center">
          {isNotebook && tool('add-code-top', 'Add code cell at the top', '+ Code', () => insert(-1, 'code'))}
          {tool('add-md-top', isNotebook ? 'Add Markdown cell at the top' : 'Add section at the top', isNotebook ? '+ Markdown' : '+ Section', () => insert(-1, 'markdown'))}
          <Text dimColor>│</Text>
          {isNotebook && (
            <Button key="outputs" label={outputs ? '◉ Outputs' : '○ Outputs'} hotkey="o" plain onPress={() => update($, showOutputs, value => !value)} />
          )}
          {canUndo && (
            <Button
              key="undo"
              label={`↶ Undo ${lastUndo.label.toLowerCase()}`}
              hotkey="u"
              plain
              onPress={async () => {
                await $.fs.write(lastUndo.path, lastUndo.text)
                await update($, undo, () => null)
                await bump($)
              }}
            />
          )}
          <Button key="refresh" label="⟳ Refresh" hotkey="r" plain onPress={() => show($, path)} />
          <Button key="html" label="↗ HTML" hotkey="h" plain onPress={() => exportHtml($, absolute).then(() => bump($))} />
        </Box>
        {hasHtml && <Link href={`file://${encodeURI(htmlPath)}`}>{`${basename(htmlPath)} · rendered with images`}</Link>}
        {pager('top')}
        <Box flexDirection="column">{visible.map(drawCell)}</Box>
        {visible.length === 0 && <Text dimColor>Empty file. Add a cell above.</Text>}
        <Box marginTop={1}>{pager('bottom')}</Box>
      </Box>
    )
  })
}
