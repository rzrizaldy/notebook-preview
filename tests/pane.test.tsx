import { expect, test } from 'claude-code/testing'

import { editMarkdown, editNotebook, fileLinks, paginate, parseMarkdown, parseNotebook, pathFrom, toLines } from '../hooks/notebook'

const NOTEBOOK = JSON.stringify(
  {
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python' }, colab: { gpuType: 'T4' } },
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { id: 'a', cell_type: 'markdown', metadata: {}, source: ['# Section A\n', 'Some *text*.'] },
      {
        id: 'b',
        cell_type: 'code',
        execution_count: 3,
        metadata: {},
        source: ['import torch\n', 'print(torch.cuda.is_available())'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['True\n'] },
          { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': ['<Figure size 640x480 with 1 Axes>'] } },
          { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] },
        ],
      },
      { id: 'c', cell_type: 'code', execution_count: null, metadata: {}, source: [], outputs: [] },
    ],
  },
  null,
  1,
)

const PANE = {
  plugin: 'notebook-preview',
  component: 'Pane',
  requestId: 'notebook-preview',
  props: {
    title: 'demo.ipynb',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('a notebook parses into cells with outputs', () => {
  const doc = parseNotebook(NOTEBOOK, '/x/demo.ipynb')
  expect(doc.title).toBe('demo.ipynb')
  expect(doc.kernel).toBe('Python 3 · T4')
  expect(doc.summary).toBe('3 cells · 2 code · 1 run')
  expect(doc.cells.map(c => c.type)).toEqual(['markdown', 'code', 'code'])
  expect(doc.cells[1]?.outputs.map(o => o.kind)).toEqual(['text', 'note', 'error'])
  expect(doc.cells[1]?.outputs[2]?.text).toBe('ValueError: bad')
})

test('editing a cell keeps the notebook valid and its indentation', () => {
  const edited = editNotebook(NOTEBOOK, { op: 'set', index: 1, source: 'x = 1\ny = 2' })
  const nb = JSON.parse(edited)
  expect(nb.cells[1].source).toEqual(['x = 1\n', 'y = 2'])
  expect(nb.cells[1].outputs.length).toBe(3)
  expect(edited.split('\n')[1]?.startsWith(' "')).toBe(true)

  const added = JSON.parse(editNotebook(NOTEBOOK, { op: 'insert', after: 0, type: 'code' }))
  expect(added.cells.length).toBe(4)
  expect(added.cells[1].cell_type).toBe('code')
  expect(typeof added.cells[1].id).toBe('string')

  const moved = JSON.parse(editNotebook(NOTEBOOK, { op: 'move', index: 0, by: 1 }))
  expect(moved.cells.map((c: { id: string }) => c.id)).toEqual(['b', 'a', 'c'])
  const deleted = JSON.parse(editNotebook(NOTEBOOK, { op: 'delete', index: 2 }))
  expect(deleted.cells.length).toBe(2)
  const retyped = JSON.parse(editNotebook(NOTEBOOK, { op: 'retype', index: 1, type: 'markdown' }))
  expect(retyped.cells[1].outputs).toBeUndefined()
})

test('Markdown edits work by section', () => {
  const md = '# Title\nintro\n## A\none\n## B\ntwo\n'
  expect(parseMarkdown(md, 'n.md').cells.length).toBe(3)
  expect(editMarkdown(md, { op: 'set', index: 1, source: '## A\nchanged\n' })).toBe('# Title\nintro\n## A\nchanged\n## B\ntwo\n')
  expect(editMarkdown(md, { op: 'move', index: 2, by: -1 })).toBe('# Title\nintro\n## B\ntwo\n\n## A\none')
})

test('long content splits into pages', () => {
  const big = Array.from({ length: 5 }, (_, i) => `# S${i}\n${'x'.repeat(15_000)}`).join('\n')
  expect(paginate(parseMarkdown(big, 'notes.md').cells, true).length).toBe(2)
})

test('paths, lines and reply links', () => {
  expect(pathFrom('file:///Users/me/My%20nb.ipynb')).toBe('/Users/me/My nb.ipynb')
  expect(pathFrom('"notes.md:12"')).toBe('notes.md')
  expect(pathFrom('@analysis.ipynb')).toBe('analysis.ipynb')
  expect(toLines('a\nb\n')).toEqual(['a\n', 'b\n'])
  const links = fileLinks('See [nb](work/a.ipynb), [code](src/x.py:3) and [site](https://x.dev/a.md).', '/home/me')
  expect(links.hrefs).toEqual(['file:///home/me/work/a.ipynb'])
  expect(links.text).toContain('[code](file:///home/me/src/x.py:3)')
  expect(links.text).toContain('[site](https://x.dev/a.md)')
})

test('/notebook opens the pane, and a cell is edited and saved', async ($, on) => {
  let disk = NOTEBOOK
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x' }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('demo.ipynb') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: disk.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: disk }))
  on('fs.write', (_, e) => {
    disk = e.text
    return { value: undefined }
  })

  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'notebook', args: 'demo.ipynb' } as never)
  expect(ran.text).toBe('Opened demo.ipynb')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /2 code/ }))?.text).toBe('3 cells · 2 code · 1 run')
    expect(await ui.find({ key: 'edit-1' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit-1' })
  await ui.input({ key: 'input-1', text: 'print("hi")' })
  expect(JSON.parse(disk).cells[1].source).toEqual(['print("hi")'])

  await ui.press({ key: 'undo' })
  expect(JSON.parse(disk).cells[1].source).toEqual(['import torch\n', 'print(torch.cuda.is_available())'])
  await ui.unmount()
})

test('the empty pane says how to start', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No file open/ }))?.text).toContain('/notebook')
  await ui.unmount()
})

test('a reply with a notebook link is redrawn so the link opens the pane', async ($, on) => {
  on('session.cwd', () => ({ value: '/x' }))
  const reply = {
    plugin: 'notebook-preview',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text: 'Open [demo](demo.ipynb) or [code](a.py).', isFirstOfReply: true },
  } as const
  const ui = await $.ui.mount({ ...reply, surface: 'desktop' })
  const drawn = await ui.find({ key: 'reply-m1' })
  expect(drawn?.text).toContain('file:///x/demo.ipynb')
  await ui.unmount()
})
