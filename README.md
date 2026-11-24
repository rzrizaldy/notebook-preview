# notebook-preview

[![Works with Claude Code](https://img.shields.io/badge/Works%20with-Claude%20Code-D97757)](https://code.claude.com/docs/en/plugins)
[![Release](https://img.shields.io/github/v/release/rzrizaldy/notebook-preview?color=D97757)](https://github.com/rzrizaldy/notebook-preview/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Support this project](https://img.shields.io/badge/Support-pay%20what%20you%20want-635BFF?logo=stripe&logoColor=white)](https://buy.stripe.com/00w8wQ6UTaOT006duX6Na02)

A community plugin for Claude Code (not made or endorsed by Anthropic) that opens Jupyter notebooks (`.ipynb`) and Markdown files (`.md`) as cells in a pane beside the chat, in the style of a VS Code notebook. You can edit cells there too. It's for data scientists who work on notebooks with Claude.

By Rizaldy.

Claude Code's file view shows a notebook as raw JSON. This pane shows it the way you'd read it in Jupyter or VS Code:

- Code cells in a box with syntax highlighting, and the execution count in the gutter, e.g. `[3]`
- Markdown cells drawn as Markdown
- Outputs under each cell: printed text, results, and tracebacks in a red box with the terminal colour codes stripped
- A header with the file name, kernel and GPU (from Colab metadata), and how many cells ran
- Long notebooks split into pages, so each drawing stays within the app's limit

## Edit cells

Hover a cell and a small toolbar appears at its top-right corner, as in Cursor and VS Code:

- **✎ Edit**: edit the cell in place. Enter saves; Shift+Enter adds a new line.
- **✦ Ask**: puts "In file.ipynb, cell 12: " in the prompt box, so you can ask Claude to change, explain or fix that cell
- **M↓ / { }**: change the cell to Markdown or to code
- **↑ / ↓ / ✕**: move the cell up or down, or delete it
- **+ Code / + Markdown** under each cell: add a new cell below it

Hovered and edited cells are outlined in Claude orange.

Every change is written to the file straight away, in the file's own JSON layout, and existing outputs are kept. **Undo** (`u`) in the header reverts the last change. In a `.md` file each heading starts a section, and you edit, move and add sections the same way.

## Open files

| What | How |
| --- | --- |
| Open a file | `/notebook path/to/analysis.ipynb` or `/notebook README.md` |
| Click a link | In the desktop app, clicking a `.ipynb` or `.md` link in Claude's reply opens it in the pane. `/notebook-links` turns this on or off. |
| Follow Claude | On by default. When Claude reads, writes or edits a `.ipynb` or `.md` file, the pane switches to it. `/notebook-follow` turns this on or off. |
| Show the pane again | `/notebook` |

Buttons in the pane header. The hotkeys work while the pane has the focus.

- **Prev / Next**: move between pages of a long notebook
- **Hide outputs / Show outputs** (`o`): switch between code only and code with outputs
- **Refresh** (`r`): read the file again. The pane also refreshes by itself when the file changes on disk, for example after Claude, Colab or another editor saves it.
- **Open as HTML** (`h`): writes a full HTML copy next to the file and links it from the pane. For notebooks it runs `jupyter nbconvert --to html`; for Markdown it runs `pandoc`. Use this to see images, plots and HTML tables (e.g. pandas DataFrames).

## Limits

- Images and HTML outputs show as a short note, e.g. "image/png output (34 KB)". The plugin API's desktop elements can't draw a PNG. Use **Open as HTML** for those.
- Files over 4 MB aren't read in the pane. Use **Open as HTML**.
- A single output is cut at 4,000 characters, and a single cell at 20,000. A cut cell can't be edited in the pane, so no text is lost.
- The pane doesn't run code. Run cells in Jupyter, Colab or VS Code; the pane picks up the new outputs when the file is saved.
- Clicking a file in the app's file tree can't be caught by a plugin. Use a link in a reply or `/notebook`.
- In a reply that holds a notebook or Markdown link, relative file links are rewritten to `file://` links so they stay clickable.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install notebook-preview --marketplace rzrizaldy/notebook-preview
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice).

From a shell:

```bash
claude plugin install notebook-preview --marketplace rzrizaldy/notebook-preview
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `rzrizaldy/notebook-preview`, then **Add plugin**.

Or try it from a clone without installing:

```bash
claude --plugin-dir /path/to/notebook-preview
```

## Support

notebook-preview is free and open source. If it saves you time, you can [chip in what you like](https://buy.stripe.com/00w8wQ6UTaOT006duX6Na02). Thank you!

## Develop

```bash
claude plugin validate .
claude plugin test .
```

- `hooks/notebook.ts` holds the parsing, paging and cell-edit code, with no plugin API calls in it.
- `hooks/register.tsx` holds the commands, the follow and link hooks, and the pane.
- `tests/pane.test.tsx` holds the tests.

## License

MIT © Rizaldy
