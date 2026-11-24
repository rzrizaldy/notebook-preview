// Pure helpers, no plugin API: read a .ipynb or .md file into cells the pane
// draws, page them to fit one drawing, and apply cell edits to the file text.

export type Output =
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string; language: string }
  | { kind: 'error'; text: string }
  | { kind: 'note'; text: string }

export type CellType = 'code' | 'markdown' | 'raw'

export type Cell = {
  /** Position in the file: the notebook's cell, or the Markdown section. */
  index: number
  type: CellType
  source: string
  /** Execution count of a code cell; null when it never ran. */
  count: number | null
  outputs: Output[]
  /** True when `source` was cut for display, so editing it would lose text. */
  isCut: boolean
}

export type Doc = {
  kind: 'notebook' | 'markdown'
  title: string
  language: string
  /** e.g. "Python 3 · T4" */
  kernel: string
  summary: string
  cells: Cell[]
}

export type Edit =
  | { op: 'set'; index: number; source: string }
  | { op: 'insert'; after: number; type: CellType }
  | { op: 'delete'; index: number }
  | { op: 'move'; index: number; by: -1 | 1 }
  | { op: 'retype'; index: number; type: CellType }

/** Characters one page may hold; the rest of the drawing is chrome. */
export const PAGE_BUDGET = 60_000
/** Longest single output kept; longer ones are cut with a note. */
export const OUTPUT_LIMIT = 4_000
/** Longest single cell source drawn. */
export const SOURCE_LIMIT = 20_000

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// Control characters other than tab and newline are refused by the surface.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')
}

function joined(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('')
  return typeof value === 'string' ? value : ''
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (${(text.length - limit).toLocaleString()} more characters cut)`
}

function kb(base64: string): string {
  return `${Math.max(1, Math.round((base64.length * 3) / 4 / 1024))} KB`
}

type RawOutput = {
  output_type?: string
  text?: unknown
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: unknown
}

type RawCell = {
  id?: string
  cell_type?: string
  source?: unknown
  execution_count?: number | null
  outputs?: RawOutput[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

type RawNotebook = {
  cells?: RawCell[]
  metadata?: {
    kernelspec?: { display_name?: string; language?: string }
    language_info?: { name?: string }
    colab?: { gpuType?: string }
    accelerator?: string
  }
  nbformat?: number
  nbformat_minor?: number
  [key: string]: unknown
}

function outputsOf(output: RawOutput): Output[] {
  const type = output.output_type
  if (type === 'stream') {
    const text = clean(joined(output.text)).replace(/\n$/, '')
    return text.trim() === '' ? [] : [{ kind: 'text', text: cut(text, OUTPUT_LIMIT), language: 'text' }]
  }
  if (type === 'error') {
    const trace = Array.isArray(output.traceback)
      ? clean(output.traceback.map(String).join('\n'))
      : `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
    return [{ kind: 'error', text: cut(trace, OUTPUT_LIMIT) }]
  }
  const data = output.data ?? {}
  const found: Output[] = []
  for (const mime of ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif']) {
    if (mime in data) found.push({ kind: 'note', text: `${mime} · ${kb(joined(data[mime]))} · open as HTML to view` })
  }
  if ('text/markdown' in data) {
    found.push({ kind: 'markdown', text: cut(clean(joined(data['text/markdown'])), OUTPUT_LIMIT) })
  } else if ('text/plain' in data) {
    const text = clean(joined(data['text/plain']))
    // A figure's repr ("<Figure size 640x480 with 1 Axes>") adds nothing next to its image note.
    const isFigureRepr = found.length > 0 && /^<.*Figure.*>$/.test(text.trim())
    if (!isFigureRepr && text.trim() !== '') found.push({ kind: 'text', text: cut(text, OUTPUT_LIMIT), language: 'text' })
  } else if ('text/html' in data) {
    found.push({ kind: 'note', text: 'HTML output · open as HTML to view' })
  } else if ('application/vnd.jupyter.widget-view+json' in data) {
    found.push({ kind: 'note', text: 'Widget · only shown in a live notebook' })
  }
  return found
}

function cellType(value: unknown): CellType {
  return value === 'code' || value === 'markdown' ? value : 'raw'
}

export function parseNotebook(text: string, path: string): Doc {
  const nb = JSON.parse(text) as RawNotebook
  const raw = nb.cells ?? []
  const meta = nb.metadata ?? {}
  const language = meta.kernelspec?.language ?? meta.language_info?.name ?? 'python'
  const gpu = meta.colab?.gpuType ?? (meta.accelerator === 'GPU' ? 'GPU' : undefined)
  const kernel = [meta.kernelspec?.display_name ?? language, ...(gpu === undefined ? [] : [gpu])].join(' · ')

  const cells: Cell[] = raw.map((cell, index) => {
    const source = clean(joined(cell.source))
    const type = cellType(cell.cell_type)
    return {
      index,
      type,
      source: cut(source, SOURCE_LIMIT),
      count: typeof cell.execution_count === 'number' ? cell.execution_count : null,
      outputs: type === 'code' ? (cell.outputs ?? []).flatMap(outputsOf) : [],
      isCut: source.length > SOURCE_LIMIT,
    }
  })
  const code = cells.filter(c => c.type === 'code')
  const ran = code.filter(c => c.count !== null).length
  return {
    kind: 'notebook',
    title: basename(path),
    language,
    kernel,
    summary: `${cells.length} cells · ${code.length} code · ${ran} run`,
    cells,
  }
}

/** Markdown sections: split before each heading of level 1 to 3. */
function sectionsOf(text: string): string[] {
  return text.split(/\n(?=#{1,3} )/)
}

export function parseMarkdown(text: string, path: string): Doc {
  const body = text.replace(/\r\n?/g, '\n')
  const cells: Cell[] = sectionsOf(body).map((section, index) => ({
    index,
    type: 'markdown',
    source: cut(clean(section), SOURCE_LIMIT),
    count: null,
    outputs: [],
    isCut: section.length > SOURCE_LIMIT,
  }))
  const lines = body.split('\n').length
  return {
    kind: 'markdown',
    title: basename(path),
    language: 'markdown',
    kernel: 'Markdown',
    summary: `${lines.toLocaleString()} lines · ${cells.length} sections`,
    cells,
  }
}

export function parse(text: string, path: string): Doc {
  return previewKind(path) === 'notebook' ? parseNotebook(text, path) : parseMarkdown(text, path)
}

function cost(cell: Cell, withOutputs: boolean): number {
  const outputs = withOutputs ? cell.outputs.reduce((n, o) => n + o.text.length + 60, 0) : 0
  return cell.source.length + outputs + 200
}

/** Split cells into pages that each stay under the budget. */
export function paginate(cells: Cell[], withOutputs: boolean, budget = PAGE_BUDGET): Cell[][] {
  const pages: Cell[][] = []
  let page: Cell[] = []
  let used = 0
  for (const cell of cells) {
    const size = cost(cell, withOutputs)
    if (page.length > 0 && used + size > budget) {
      pages.push(page)
      page = []
      used = 0
    }
    page.push(cell)
    used += size
  }
  if (page.length > 0) pages.push(page)
  return pages.length > 0 ? pages : [[]]
}

/** Jupyter stores source as lines, each but the last ending in "\n". */
export function toLines(source: string): string[] {
  if (source === '') return []
  const lines = source.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter(line => line !== '')
}

function indentOf(text: string): number {
  const second = text.split('\n', 2)[1] ?? ''
  return /^( +)/.exec(second)?.[1]?.length ?? 1
}

function newCell(type: CellType, nb: RawNotebook): RawCell {
  const hasIds = (nb.nbformat ?? 4) > 4 || (nb.nbformat_minor ?? 0) >= 5
  const id = hasIds ? { id: crypto.randomUUID().slice(0, 8) } : {}
  if (type === 'code') return { ...id, cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [] }
  return { ...id, cell_type: type, metadata: {}, source: [] }
}

function retyped(cell: RawCell, type: CellType): RawCell {
  const { outputs: _outputs, execution_count: _count, ...rest } = cell
  if (type === 'code') return { ...rest, cell_type: 'code', execution_count: null, outputs: [] }
  return { ...rest, cell_type: type }
}

function applyToList<T>(
  list: T[],
  edit: Edit,
  make: (type: CellType) => T,
  set: (item: T, source: string) => T,
  retype: (item: T, type: CellType) => T,
): T[] {
  const next = [...list]
  switch (edit.op) {
    case 'set': {
      const item = next[edit.index]
      if (item !== undefined) next[edit.index] = set(item, edit.source)
      return next
    }
    case 'insert':
      next.splice(edit.after + 1, 0, make(edit.type))
      return next
    case 'delete':
      next.splice(edit.index, 1)
      return next
    case 'move': {
      const to = edit.index + edit.by
      const item = next[edit.index]
      if (item === undefined || to < 0 || to >= next.length) return next
      next.splice(edit.index, 1)
      next.splice(to, 0, item)
      return next
    }
    case 'retype': {
      const item = next[edit.index]
      if (item !== undefined) next[edit.index] = retype(item, edit.type)
      return next
    }
  }
}

/** The notebook's text after one edit, written in the file's own indentation. */
export function editNotebook(text: string, edit: Edit): string {
  const nb = JSON.parse(text) as RawNotebook
  nb.cells = applyToList(
    nb.cells ?? [],
    edit,
    type => newCell(type, nb),
    (cell, source) => ({ ...cell, source: toLines(source) }),
    retyped,
  )
  return `${JSON.stringify(nb, null, indentOf(text))}\n`
}

/** The Markdown file's text after one edit; a new section starts as a heading. */
export function editMarkdown(text: string, edit: Edit): string {
  const body = text.replace(/\r\n?/g, '\n')
  const sections = applyToList(
    sectionsOf(body),
    edit,
    () => '## New section\n',
    (_, source) => source.replace(/\n+$/, ''),
    section => section,
  )
  return sections.join('\n')
}

export function applyEdit(text: string, path: string, edit: Edit): string {
  return previewKind(path) === 'notebook' ? editNotebook(text, edit) : editMarkdown(text, edit)
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function previewKind(path: string): 'notebook' | 'markdown' | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ipynb')) return 'notebook'
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown'
  return undefined
}

/** A path typed after the command, or taken from a file: link. */
export function pathFrom(raw: string): string {
  // "@file.ipynb" is how the prompt box mentions a file.
  let path = raw.trim().replace(/^["']|["']$/g, '').replace(/^@/, '')
  if (path.startsWith('file://')) path = decodeURIComponent(path.slice('file://'.length))
  // A clickable reference can carry a line suffix: notes.md:12
  return path.replace(/:(\d+)(:\d+)?$/, '')
}

const LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g

/**
 * For a reply's markdown: relative file links made absolute `file://` links
 * (so they stay clickable when the plugin redraws the reply), and the hrefs
 * that point at notebooks or Markdown files, which the pane opens.
 */
export function fileLinks(text: string, cwd: string): { text: string; hrefs: string[] } {
  const hrefs: string[] = []
  const rewritten = text.replace(LINK, (whole, label: string, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) return whole
    if (href.startsWith('#')) return whole
    let absolute = href
    if (!href.startsWith('file:')) {
      const path = href.startsWith('/') ? href : `${cwd.replace(/\/$/, '')}/${href.replace(/^\.\//, '')}`
      absolute = `file://${encodeURI(path)}`
    }
    if (previewKind(pathFrom(absolute)) !== undefined) hrefs.push(absolute)
    return `[${label}](${absolute})`
  })
  return { text: rewritten, hrefs }
}

// ---------------------------------------------------------------------------
// ✦ Edit with Claude: find the highlight in a cell, ask for a rewrite, diff it
// ---------------------------------------------------------------------------

export type Span = { start: number; end: number; text: string }

/**
 * Where the person's highlight sits in a cell's source: 1-based first and last
 * line. Whitespace is compared loosely, since a copy of drawn code can differ
 * in indentation and wrapping. Null when the highlight is not in this cell.
 */
export function locate(selection: string, source: string): Span | null {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const wanted = squash(selection)
  if (wanted.length < 2) return null
  const lines = source.split('\n')
  for (let start = 0; start < lines.length; start++) {
    let joined = ''
    for (let end = start; end < lines.length; end++) {
      joined = squash(`${joined} ${lines[end] ?? ''}`)
      if (joined.includes(wanted)) {
        // Shrink from the top while the rest still holds the highlight.
        let first = start
        while (first < end && squash(lines.slice(first + 1, end + 1).join(' ')).includes(wanted)) first++
        return { start: first + 1, end: end + 1, text: lines.slice(first, end + 1).join('\n') }
      }
      if (joined.length > wanted.length + 2000) break
    }
  }
  return null
}

export const QUICK_ASKS = ['Fix the error', 'Simplify', 'Add comments', 'Vectorize with pandas'] as const

export function editPrompt(args: {
  path: string
  cellNumber: number
  cellType: CellType
  language: string
  source: string
  span: Span | null
  instruction: string
  error?: string
}): { system: string; prompt: string } {
  const lang = args.cellType === 'markdown' ? 'markdown' : args.language
  const focus =
    args.span === null
      ? 'Change the whole cell.'
      : `Change only lines ${args.span.start}-${args.span.end}, shown here, and keep every other line exactly as it is:\n\`\`\`${lang}\n${args.span.text}\n\`\`\``
  const error = args.error ? `\n\nThe cell's last run failed with:\n\`\`\`\n${args.error.slice(0, 2000)}\n\`\`\`` : ''
  return {
    system:
      'You edit one cell of a notebook or one section of a Markdown file. Reply with the complete new cell source in a single fenced code block and nothing else: no explanation, no second block.',
    prompt: `File: ${args.path}, cell ${args.cellNumber} (${args.cellType}, ${lang}).\n\nThe cell now:\n\`\`\`${lang}\n${args.source}\n\`\`\`\n\n${focus}${error}\n\nWhat to change: ${args.instruction}`,
  }
}

/** The new source from the model's reply: the first fenced block, else the reply. */
export function extractCode(reply: string): string {
  const fence = /```[^\n]*\n([\s\S]*?)\n?```/.exec(reply)
  return (fence?.[1] ?? reply).replace(/\s+$/, '')
}

/** A unified diff of two texts as one hunk, for `<Code format="diff">`. */
export function lineDiff(before: string, after: string): { diff: string; added: number; removed: number } {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence table, from the end.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as number[]
      row[j] = a[i] === b[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (i < a.length && (j >= b.length || (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) {
      out.push(`-${a[i]}`)
      removed++
      i++
    } else {
      out.push(`+${b[j]}`)
      added++
      j++
    }
  }
  return { diff: `@@ -1,${a.length} +1,${b.length} @@\n${out.join('\n')}`, added, removed }
}

/** The text a chat handoff puts in the prompt box. */
export function chatHandoff(path: string, cellNumber: number, language: string, span: Span | null, source: string, instruction: string): string {
  const where = span === null ? `cell ${cellNumber}` : `cell ${cellNumber}, lines ${span.start}-${span.end}`
  const code = span === null ? source : span.text
  return `In ${path}, ${where}:\n\`\`\`${language}\n${code}\n\`\`\`\n${instruction}`
}
