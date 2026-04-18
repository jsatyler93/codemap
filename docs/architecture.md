# CodeMap architecture

## Why this base

The repository was bootstrapped from the spirit of the
[CodeVisualizer](https://github.com/DucPhamNgoc08/CodeVisualizer) extension
(extension-shell pattern, command + webview separation), but reimplemented
to be **Python-first** and to host two unified views — function flowcharts
and call graphs — driven from one shared graph data model.

The [callGraph](https://github.com/koknat/callGraph) project was studied
**only for ideas** (centered-neighborhood graphs, ambient flow animation,
trace narration). No code was copied.

## Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                       VS Code extension host                    │
│                                                                 │
│   src/extension.ts  ────▶  PythonWorkspaceIndexer (caching)     │
│        │                      │                                 │
│        │                      ▼                                 │
│        │            python/analyzer.py  (AST, stdlib only)      │
│        │                                                        │
│        ├───────────▶ buildSymbolCallGraph / buildWorkspaceGraph │
│        │             buildStaticTrace   (TS, in-process)        │
│        │                                                        │
│        └───────────▶ python/flowchart.py  (per-function CFG-ish)│
│                                                                 │
│        ──── GraphDocument JSON ────▶  GraphWebviewProvider      │
└─────────────────────────────────────────────┬───────────────────┘
                                              │ webview.postMessage
                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Webview (ES modules)                      │
│                                                                 │
│   webview/main.js  ── dispatches by graphType ──▶ flowchartView │
│                                              └──▶ callGraphView │
│   shared/  panZoom · geometry · theme                           │
└─────────────────────────────────────────────────────────────────┘
```

## Data flow contract

Every analysis step produces a `GraphDocument` (see
[`src/python/model/graphTypes.ts`](../src/python/model/graphTypes.ts)):

```ts
{ graphType, title, subtitle?, nodes, edges, rootNodeIds?, metadata? }
```

The webview never sees AST data. This keeps renderers decoupled from
analyzers and lets us swap or extend either side.

## Process boundary

Python AST work runs in a **subprocess** spawned per request, communicating
JSON over stdin/stdout. We deliberately use only the Python stdlib so the
extension works against any Python 3.8+ interpreter the user already has.
The TypeScript side does graph shaping and resolution-aware rendering.

## Adding a new view

1. Define a new `graphType` literal in
   [`graphTypes.ts`](../src/python/model/graphTypes.ts).
2. Build a `GraphDocument` in `pythonCallGraphBuilder.ts` (or a new
   module).
3. Dispatch on `graph.graphType` in `webview/main.js` and render with a new
   module under `webview/views/<name>/`.
4. Reuse `webview/shared/panZoom.js`, `theme.js`, `geometry.js`.

## Performance guardrails

- `PythonWorkspaceIndexer` caches the last analysis and invalidates on
  `*.py` file changes via a debounced `FileSystemWatcher`.
- `codemap.workspace.maxFiles` caps the indexer.
- Symbol-centric graphs default to depth 1 to keep neighborhoods readable.
- Trace mode caps at 200 steps and labels the result as "truncated" if
  reached.
