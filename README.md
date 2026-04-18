# CodeMap

CodeMap is a Python-first VS Code extension that provides interactive
visualizations of your code:

- **Function flowcharts** – control-flow chart for the function under the
  cursor.
- **Symbol-centric call graphs** – callers and callees of the selected
  Python symbol.
- **Workspace graphs** – module/symbol graph for the whole project.
- **Static traces** – approximate ordered traversal of calls reached from a
  function (clearly labelled as static analysis, not runtime truth).

All analysis is performed locally using Python's standard `ast` module; no
network calls, no LLMs, no telemetry.

> The visual style of the two views is borrowed from a pair of HTML
> templates included in `flowchart_interactive.html` and
> `callgraph_interactive.html`. The runtime version of those views lives in
> [`webview/`](webview) as small ES modules driven by JSON.

## Commands

| Command palette                                     | What it does                                               |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `CodeMap: Show Python Flowchart for Current Function` | Builds a flowchart for the function containing the cursor. |
| `CodeMap: Show Call Graph for Current Symbol`         | Symbol-centric call graph (configurable depth).            |
| `CodeMap: Show Python Workspace Graph`                | Whole-project module/symbol graph.                         |
| `CodeMap: Show Static Trace for Current Function`     | Approximate ordered call traversal from a root function.   |
| `CodeMap: Refresh Visualization`                      | Re-index the workspace and re-render the last view.        |

Click any node in the webview to jump to its source location.

## Settings

| Setting                       | Default | Description                                              |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `codemap.pythonPath`          | `""`    | Path to a Python 3 interpreter (else `python` on PATH).  |
| `codemap.callGraph.depth`     | `1`     | Default depth for symbol-centric call graphs.            |
| `codemap.workspace.maxFiles`  | `400`   | Cap on Python files indexed for the workspace graph.     |

## Requirements

- VS Code 1.80+
- Node.js 18+ (for building the extension)
- Python 3.8+ on PATH or set via `codemap.pythonPath`

## Development

```powershell
npm install
npm run compile
```

Then press <kbd>F5</kbd> in VS Code to launch the Extension Development Host.

## Static-analysis limitations

CodeMap is intentionally conservative. Edges are marked with a resolution
quality:

- **resolved** – direct local call or unambiguously imported symbol.
- **likely** – best-effort match (e.g. `Class.method` via alias).
- **unresolved** – call target could not be statically determined.

Things CodeMap does not (yet) attempt:

- runtime tracing
- dynamic dispatch via `getattr` / `exec` / `eval`
- decorator-introduced wrappers changing call shape
- multi-language workspaces (Python only in v1)

The "static trace" mode is an **approximate ordered traversal** – it does
not reflect actual runtime execution.

## Project layout

```
src/                    extension host (TypeScript)
  extension.ts
  commands handled inline in extension.ts
  python/
    analysis/           workspace indexer, call-graph builder, runner
    model/              shared graph & symbol types
  providers/            webview provider
  messaging/            host <-> webview protocol
python/                 stdlib-only Python helpers invoked via subprocess
  analyzer.py           project-wide AST extraction
  flowchart.py          per-function flowchart generation
webview/                front-end (plain ES modules, no bundler)
  main.js               entry, message bus, animation loop
  styles.css
  shared/               theme, geometry, pan/zoom
  views/flowchart/      flowchart renderer
  views/callgraph/      call-graph / workspace / trace renderer
samples/python_demo/    small Python project to try the extension on
docs/                   architecture notes
```

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/python-analysis.md`](docs/python-analysis.md).
