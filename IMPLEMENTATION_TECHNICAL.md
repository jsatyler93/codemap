# CodeMap Technical Implementation

This document explains how the extension currently works at runtime, from file scope selection to graph rendering and debug synchronization.

## 0) Concrete IR and adapter internals (actual implementation)

This section documents the real wire formats and adapter behavior implemented in:

- python/analyzer.py
- python/flowchart.py
- src/python/model/graphTypes.ts
- src/python/model/symbolTypes.ts

### 0.1 Analyzer request/response on stdin/stdout

Analyzer entrypoint is python/analyzer.py main(). The host sends JSON over stdin.

Request shape:

```json
{
  "command": "index",
  "files": ["C:/abs/path/a.py", "..."],
  "root": "C:/abs/workspace/root",
  "useJedi": true
}
```

Response shape (PyAnalysisResult):

```json
{
  "symbols": { "module:symbol": { "...": "..." } },
  "modules": { "pkg.mod": "pkg.mod:<module>" },
  "errors": [{ "file": "...", "message": "..." }],
  "summary": {
    "totalFiles": 0,
    "totalFunctions": 0,
    "totalClasses": 0,
    "totalTypeSlots": 0,
    "typedSlots": 0,
    "typeCoveragePct": 0.0,
    "jediEnabled": false,
    "jediResolved": 0,
    "callResolution": {
      "total": 0,
      "resolved": 0,
      "likely": 0,
      "unresolved": 0,
      "builtin": 0,
      "outOfScope": 0,
      "jedi": 0
    }
  }
}
```

### 0.2 Symbol IR fields (actual)

Defined by src/python/model/symbolTypes.ts and produced by python/analyzer.py.

Core symbol fields:

- id
- kind: function | method | class | module
- name
- qualifiedName
- module
- file
- source: { file, line, column, endLine, endColumn }
- calls: PyCallSite[]

Function/method fields:

- params[] with per-param type, typeSource, typeConfidence, default, vararg/kwarg/kwOnly
- returnType, returnTypeSource, returnTypeConfidence
- decorators, isAsync, methodKind, className, docSummary

Class fields:

- bases[]
- members[]
- classAttributes[]
- instanceAttributes[]

Module fields:

- imports[]
- topLevel[]

### 0.3 Callsite IR fields and resolution

Callsite fields (PyCallSite):

- text
- line
- column
- resolvedTo (optional)
- resolution: resolved | likely | unresolved
- resolutionSource (optional)
- confidence (optional)
- externalTarget (optional)

Resolver behavior in python/analyzer.py:

- Local function names resolve as resolved.
- self.method resolves via owning class member map.
- cls.method and Class.method style calls resolve as likely.
- import and from-import aliases resolve when target symbols exist.
- Builtins are marked unresolved with resolutionSource=builtin.
- Out-of-scope imports are marked unresolved with resolutionSource=out-of-scope-import.
- Optional Jedi pass upgrades unresolved/likely calls to resolved when infer/goto maps to known symbols.

### 0.4 Flowchart adapter output (actual)

Flowchart entrypoint is python/flowchart.py main(). It reads:

```json
{
  "file": "C:/abs/path/a.py",
  "line": 42,
  "analysis": { "...optional PyAnalysisResult..." }
}
```

It finds the innermost function containing line, then emits GraphDocument with:

- graphType: flowchart
- title/subtitle
- nodes[]
- edges[]
- rootNodeIds
- metadata: { function, params, returnType, groups }

Flowchart node kinds used in practice:

- entry, process, compute, decision, loop, loop_else, return, error, break, continue

Flowchart edges use kind=control_flow and optional labels such as yes, no, repeat, done, break, continue.

Group metadata is produced for function body / branch / loop regions and used by the webview renderer for compound collapse/expand behavior.

### 0.5 GraphDocument schema (actual)

Defined in src/python/model/graphTypes.ts.

GraphDocument:

- graphType: flowchart | callgraph | workspace | trace | package | module_view | unified
- title
- subtitle (optional)
- nodes: GraphNode[]
- edges: GraphEdge[]
- rootNodeIds (optional)
- metadata (optional)

GraphNode:

- id
- kind
- label
- detail (optional)
- module (optional)
- className (optional)
- source (optional)
- styleCategory (optional)
- metadata (optional)

GraphEdge:

- id
- from
- to
- kind
- label (optional)
- resolution (optional)
- metadata (optional)

### 0.6 What this IR currently does not represent

This is important for spec alignment:

- No explicit read/write variable effect graph is emitted.
- No separate lexical scope tree object is emitted.
- No SSA or dataflow lattice state is emitted.
- Scope is implicit via symbol qualifiedName and source ranges.
- Flowchart variable typing is heuristic and local, used mainly for labels/metadata.

If a spec expects explicit reads/writes/scopes as first-class IR nodes, that is a divergence from the current implementation and would require a new extraction layer.

## 1) Runtime architecture

CodeMap has three runtime contexts:

- Extension host process (TypeScript in src)
- Python helper subprocesses (python/analyzer.py and python/flowchart.py)
- Webview runtime (bundled browser JS in dist/webview/main.js)

The extension host orchestrates commands and state, Python helpers perform AST analysis and return JSON, and the webview runtime performs graph rendering and interaction.

Main control flow:

1. User action (command/menu/scope checkbox/refresh)
2. Extension host updates analysis inputs and requests analysis or graph build
3. Host receives JSON graph data (GraphDocument)
4. Host posts graph to webview
5. Webview renderer builds SVG scene and interaction state

Primary entry point: src/extension.ts

## 2) VS Code integration points

### Activation and registrations

Defined in package.json and wired in src/extension.ts.

Current command surface includes:

- codemap.showFlowchart
- codemap.showWorkspaceGraph
- codemap.showFileGraph
- codemap.refresh

Context menus include Python editor context, editor tab context, and explorer context for file graph.

### APIs used directly

- vscode.commands.registerCommand
- vscode.window.createTreeView
- vscode.window.registerWebviewViewProvider
- vscode.window.createWebviewPanel
- vscode.window.withProgress
- vscode.workspace.findFiles
- vscode.workspace.createFileSystemWatcher
- vscode.workspace.openTextDocument
- vscode.window.showTextDocument
- vscode.debug event hooks and Debug Adapter Protocol customRequest
- workspaceState persistence for UI/scope state

### Views and sidebars

CodeMap uses three VS Code view surfaces:

- codemap.files TreeView for scope file selection
- codemap.actions WebviewView for controls and force/toggle settings
- codemap.graph WebviewPanel for graph rendering

The actions view pushes UI state into the graph panel via provider.updateUiState, and executes extension commands via vscode.commands.executeCommand from its webview message handler.

## 3) Scope selection and workspace ingestion

File scope is implemented by src/providers/fileTreeProvider.ts.

Behavior:

- Tree includes only Python files and containing folders.
- Excludes standard non-source folders (node_modules, .venv, __pycache__, dist, etc.).
- Checkbox state maps to included analysis files.
- Unchecked set is persisted in workspaceState.
- Path keys are normalized for stable behavior across refresh/rebuild.
- Checkbox event handling filters ancestor echo events so direct file toggles do not become subtree toggles.

When checked files change:

1. indexer.setIncludedFiles(checkedFiles)
2. Navigation cache invalidated
3. Selection summary pushed to actions view
4. If graph is visible, last command reruns with new scope

Wiring is in src/extension.ts.

## 4) Analysis pipeline and parsing

### 4.1 Workspace analysis

Indexer: src/python/analysis/pythonWorkspaceIndexer.ts

- Maintains cached PyAnalysisResult.
- Invalidates cache on Python file watcher events (debounced).
- Honors selected scope files from FileTreeProvider.
- Enforces codemap.workspace.maxFiles cap.
- Calls indexWorkspace in pythonRunner.

Runner: src/python/analysis/pythonRunner.ts

- Resolves Python interpreter from:
  1) codemap.pythonPath
  2) Python extension selected interpreter
  3) probe sequence (py -3 / python / python3)
- Spawns helper scripts and exchanges JSON via stdin/stdout.

Helper script:

- python/analyzer.py parses files with Python ast and returns symbols/modules/calls/errors metadata.

### 4.2 Per-function flowchart analysis

- buildFlowchartFor in pythonRunner invokes python/flowchart.py
- Inputs: file + line (+ optional precomputed analysis)
- Output: GraphDocument with flowchart node/edge types and metadata

## 5) Graph model and builders

Shared graph schema: src/python/model/graphTypes.ts

GraphDocument:

- graphType
- title/subtitle
- nodes
- edges
- optional rootNodeIds
- optional metadata

Workspace graph builder:

- src/python/analysis/pythonCallGraphBuilder.ts
- Produces symbol nodes and call edges across selected workspace scope
- Attaches analysis summary and execution timeline metadata

Navigation controller:

- src/navigation/navigationController.ts
- Caches workspace graph and color map
- Rebuilds on force refresh or scope invalidation

File graph command implementation:

- src/extension.ts runShowFileGraph
- Starts from workspace graph and filters to file-centered subgraph:
  - Includes all symbols from target file
  - Adds direct external dependency endpoints connected to that file
  - Filters edges to file-involved boundary
  - Rebuilds scoped exec timeline and scoped module colors

## 6) Webview architecture

Panel provider: src/providers/graphWebviewProvider.ts

- Creates/reuses one webview panel.
- Applies CSP and local resource roots.
- Loads dist/webview/main.js and webview/styles.css.
- Sends graph/state/runtime frames via postMessage.
- Receives messages: ready, revealNode, requestRefresh, requestFlowchart, debug.

Message contract is defined in src/messaging/protocol.ts and includes:

- host -> webview: setGraph, setRuntimeFrame, setUiState
- webview -> host: revealNode, requestRefresh, requestFlowchart, ready, debug

Frontend entry: webview/main.js

Responsibilities:

- Receives setGraph and dispatches by graphType:
  - flowchart -> webview/views/flowchart/flowchartView.js
  - callgraph/workspace/trace -> webview/views/callgraph/callGraphView.js
- Owns top toolbar interactions (refresh/reset/search/exec controls)
- Maintains animation loop (ambient edge particles + execution particles)
- Maintains runtime debug panel rendering
- Stores and restores layout snapshots in localStorage by graph identity key

Refresh behavior in frontend:

- refresh button clears stored layouts first, then requests host refresh
- this resets visual state to current renderer defaults

## 7) Graph rendering details

### 7.1 Flowchart renderer

File: webview/views/flowchart/flowchartView.js

- Renders grouped flowchart regions + nodes + routed edges.
- Supports node circle mode per node.
- Supports global collapse/expand handlers through render context hooks.
- Persists node and group layout state.
- Default initial node presentation is collapse-all (circles) when no persisted node state exists.
- If persisted state exists, persisted state is respected.

### 7.2 Call graph renderer

File: webview/views/callgraph/callGraphView.js

- Groups symbols by module columns and class groups.
- Renders call edges with module-colored arrows and animated ambient flow.
- Supports node circle mode per node.
- Global collapse/expand now aligns with flowchart behavior:
  - collapse all -> all nodes circle mode
  - expand all -> all nodes box mode
- Default initial node presentation is collapse-all (circles) when no persisted node state exists.
- If persisted state exists, persisted state is respected.

## 8) Debug synchronization and runtime highlighting

Runtime bridge: src/live/debugSync.ts

- Subscribes to debug session lifecycle and active stack changes.
- Queries DAP data through session.customRequest:
  - threads
  - stackTrace
  - scopes
  - variables
- Builds RuntimeFrame payload with current frame, call stack, and scoped variables.

Host mapping logic: src/extension.ts

- Receives RuntimeFrame from DebugSyncService.
- Maps frame source location and stack locations to graph nodes via file+line range matching.
- Sends setRuntimeFrame message with highlightNodeIds to webview.

Frontend runtime behavior: webview/main.js

- Highlights current runtime-related nodes.
- Shows runtime panel with frame/source/variables/stack context.
- Clears runtime state when session/frame is absent.

## 9) State persistence model

- Scope selection persisted in workspaceState via unchecked path set.
- Actions view UI state persisted in workspaceState (evidence toggle, forces, tree view).
- Graph layout persisted in webview localStorage per graph key.
- Refresh path intentionally clears localStorage layout snapshots before rebuild.

## 10) Error handling and observability

- Extension output channel: CodeMap
- Logs include graph dimensions, analysis summary, parse errors, webview diagnostics.
- Python helper errors include interpreter/source and stderr payload.
- Webview runtime and promise errors are posted back to host as debug messages.

## 11) Build and output artifacts

NPM scripts in package.json:

- compile: tsc + webview bundle
- bundle:webview: esbuild webview/main.js -> dist/webview/main.js

Runtime loads the bundled webview script from dist/webview/main.js.

## 12) Practical request-to-render sequence examples

### A) Workspace call graph

1. User triggers codemap.showWorkspaceGraph
2. NavigationController gets analysis from PythonWorkspaceIndexer
3. buildWorkspaceGraph produces GraphDocument
4. GraphWebviewProvider.show posts graph
5. main.js dispatches to callGraphView renderer

### B) File call graph from explorer/editor

1. User triggers codemap.showFileGraph with file URI
2. Host validates Python file
3. Host builds workspace graph from current analysis
4. Host filters to file-centered subgraph including direct external dependencies
5. Host scopes execution timeline to included edges
6. Provider posts graph to webview

### C) Flowchart from cursor or node drill-in

1. User triggers codemap.showFlowchart or double-clicks a call graph node
2. Host calls buildFlowchartFor(file, line)
3. flowchart.py returns GraphDocument
4. Provider posts graph, main.js dispatches to flowchartView

This is the current technical implementation as represented by the codebase.
