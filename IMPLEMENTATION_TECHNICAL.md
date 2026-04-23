# CodeMap Technical Implementation

This document describes the current Python implementation of the CodeMap extension as it exists in the codebase today. It is intentionally Python-only. JavaScript, TypeScript, and IDL support exist in the repository, but they are out of scope here.

The goal of this document is to explain, in concrete terms, how CodeMap:

- selects Python files for analysis
- extracts symbols, types, docstrings, imports, and call sites
- builds workspace graphs, file graphs, flowcharts, and static execution traces
- renders those structures in the webview
- synchronizes the visuals with the live VS Code debugger

The emphasis is on actual runtime behavior, actual data shapes, and actual UI behavior.

## 1. Scope of the Python implementation

The Python path in CodeMap is centered around these files:

- `src/extension.ts`
- `src/providers/fileTreeProvider.ts`
- `src/providers/graphWebviewProvider.ts`
- `src/navigation/navigationController.ts`
- `src/live/debugSync.ts`
- `src/python/analysis/pythonWorkspaceIndexer.ts`
- `src/python/analysis/pythonRunner.ts`
- `src/python/analysis/pythonCallGraphBuilder.ts`
- `src/python/analysis/hierarchicalGraphBuilder.ts`
- `src/python/model/symbolTypes.ts`
- `src/python/model/graphTypes.ts`
- `python/analyzer.py`
- `python/flowchart.py`
- `python/dataflow.py`
- `webview/main.js`
- `webview/views/callgraph/*`
- `webview/views/flowchart/*`

At runtime the Python implementation spans three environments:

1. The VS Code extension host, written in TypeScript.
2. Python helper subprocesses, invoked for static analysis and flowchart generation.
3. The webview runtime, which renders the graphs and debug overlays.

The extension host is the orchestrator. It decides when to index, when to build a graph, when to refresh, and when to push debug-state updates into the webview.

## 2. End-to-end architecture

At the highest level, the Python path works like this:

1. The user selects or opens Python files.
2. The extension host determines the active analysis scope from the file tree.
3. The Python workspace indexer produces a `PyAnalysisResult` by invoking `python/analyzer.py`.
4. TypeScript builders convert that analysis into a `GraphDocument`.
5. The graph provider posts the graph JSON into the webview.
6. The webview renders either a call graph or a flowchart.
7. When the VS Code debugger moves, the debug sync service emits a runtime frame.
8. The host maps the runtime source location back onto graph nodes and posts highlight updates to the webview.

That pattern is reused for these user-visible modes:

- workspace call graph
- file-scoped call graph
- flowchart for the current Python function
- static trace metadata embedded into call-graph views
- live runtime highlighting during debug sessions

## 3. VS Code integration points on the Python path

The Python implementation is activated and driven by `src/extension.ts`.

The main command surface used for Python is:

- `codemap.showFlowchart`
- `codemap.showWorkspaceGraph`
- `codemap.showFileGraph`
- `codemap.refresh`

The relevant VS Code APIs in the Python path are:

- `vscode.commands.registerCommand`
- `vscode.window.createTreeView`
- `vscode.window.createWebviewPanel`
- `vscode.window.registerWebviewViewProvider`
- `vscode.window.withProgress`
- `vscode.workspace.findFiles`
- `vscode.workspace.createFileSystemWatcher`
- `vscode.workspace.openTextDocument`
- `vscode.window.showTextDocument`
- `vscode.debug` session and stack-item events
- `DebugSession.customRequest` for DAP requests
- `workspaceState` for persisted UI and scope state

The Python path uses three visible VS Code surfaces:

- the scope tree (`codemap.files`)
- the actions view (`codemap.actions`)
- the graph webview panel (`codemap.graph`)

## 4. Python scope selection and workspace ingestion

File scope selection is handled by `src/providers/fileTreeProvider.ts`.

Although the provider supports multiple languages, the Python behavior is straightforward:

- it scans workspace folders for `.py` files
- it excludes common non-source directories such as `node_modules`, `.venv`, `venv`, `__pycache__`, `.git`, `build`, and `dist`
- it builds a tree of folders and source files
- every folder and file has a checkbox
- the checked Python files become the effective analysis scope

Important behavior in the provider:

- checkbox state is managed manually rather than relying on VS Code defaults
- unchecked paths are persisted in `workspaceState`
- path keys are normalized so Windows path casing does not break persistence
- scope changes immediately invalidate Python analysis caches

When the checked set changes, `src/extension.ts` does the following:

1. passes the checked files to `PythonWorkspaceIndexer.setIncludedFiles`
2. invalidates the navigation cache
3. updates the actions view selection summary
4. reruns the last graph command if a graph is already visible

This means the displayed Python graph is always scoped to the current checkbox selection, not just to the active editor.

## 5. Python interpreter resolution and helper execution

The extension does not parse Python in TypeScript. It shells out to Python helper scripts via `src/python/analysis/pythonRunner.ts`.

Interpreter resolution happens in this order:

1. `codemap.pythonPath` from settings
2. the Python extension's selected interpreter, if available
3. a platform-specific probe sequence

On Windows, the probe sequence is:

- `py -3`
- `python`
- `python3`

The resolved interpreter command is cached until relevant configuration changes.

`runPythonHelper` is the common subprocess bridge. It:

- spawns the resolved interpreter
- runs a helper from the repository's `python/` folder
- writes the JSON request to stdin
- reads stdout as JSON
- captures stderr for diagnostics
- throws a detailed error if the helper exits non-zero or returns invalid JSON

The Python helper entrypoints currently used on the Python path are:

- `analyzer.py` for workspace indexing
- `flowchart.py` for function flowcharts
- `dataflow.py` for dataflow-oriented graph generation

## 6. Python workspace indexing lifecycle

`src/python/analysis/pythonWorkspaceIndexer.ts` owns analysis caching.

Its behavior is intentionally conservative:

- it caches the last successful `PyAnalysisResult`
- it coalesces concurrent requests through a single in-flight promise
- it watches `**/*.py`
- it invalidates the cache on create, change, or delete
- invalidation is debounced by 500 ms
- scope changes clear the cache immediately

When the indexer performs a real run, it:

1. reads `codemap.workspace.maxFiles`
2. uses the checked Python files if the user has a non-empty scope selection
3. otherwise searches the workspace for Python files
4. applies the exclusion glob for generated and dependency directories
5. passes the final file list and workspace root to `indexWorkspace`

If there are no Python files in scope, it returns an empty analysis result rather than failing.

## 7. Analyzer request and response contract

`python/analyzer.py` is the authoritative source of Python analysis.

The extension sends JSON like this:

```json
{
  "command": "index",
  "files": ["C:/abs/path/a.py", "..."],
  "root": "C:/abs/workspace/root",
  "useJedi": true
}
```

The analyzer returns a `PyAnalysisResult`:

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

This is the central static-analysis payload used by the Python UI.

## 8. Python symbol model

The Python symbol schema is defined in `src/python/model/symbolTypes.ts` and produced by `python/analyzer.py`.

### 8.1 Core symbol identity

Each symbol has:

- `id`
- `kind`
- `name`
- `qualifiedName`
- `module`
- `file`
- `source`
- `calls`

Symbol ids are deterministic and module-relative. A typical id looks like:

- `pkg.module:my_function`
- `pkg.module:MyClass`
- `pkg.module:MyClass.method`
- `pkg.module:<module>`

Module names are derived from the file path relative to the workspace root. `__init__.py` is normalized to its package path.

### 8.2 Supported symbol kinds

The Python implementation models four symbol kinds:

- `function`
- `method`
- `class`
- `module`

The analyzer intentionally does not emit local nested scopes as their own first-class scope objects. Scope is encoded indirectly through symbol ids, qualified names, and source ranges.

### 8.3 Source ranges

Every symbol carries a `source` object with line and optional column information.

This source information is used in three important places:

- reveal navigation back into the editor
- file-scoped graph extraction
- live debugger source-to-node mapping

## 9. How Python code is parsed

`python/analyzer.py` uses the standard library `ast` module for the core pipeline.

That choice defines the behavior of the Python implementation:

- parsing is static, not runtime-based
- the extension does not import or execute the target Python modules
- symbol extraction, call extraction, docstring reads, and type extraction all come from syntax trees

The analyzer walks each file through a `FileExtractor`, which is an `ast.NodeVisitor`.

The extractor builds:

- module symbols
- class symbols
- function and method symbols
- imports
- class attributes
- instance attributes
- parameter metadata
- return type metadata
- call-site metadata
- doc summaries

## 10. How docstrings are extracted and used

Docstrings are taken directly from the AST via `ast.get_docstring`.

The current Python implementation uses docstrings in two distinct ways.

### 10.1 Doc summaries

For modules, classes, functions, and methods, the analyzer records a `docSummary`.

This is the short summary text used by the UI. It appears in:

- graph node metadata
- hover tooltips in the webview
- static execution timeline descriptions in workspace and file graphs

In the webview, `webview/main.js` renders `docSummary` as a green secondary line in the node tooltip.

### 10.2 Docstring-derived types

The analyzer also parses parameter and return types from docstrings through `parse_docstring_types`.

The parser currently understands two common conventions:

- NumPy style
- Google style

Supported patterns include:

- NumPy parameter blocks under `Parameters` with `name : type`
- NumPy returns blocks under `Returns` or `Yields`
- Google-style `Args:` or `Parameters:` lines with `name (type): ...`
- Google-style `Returns:` or `Yields:` sections

If a type is obtained from a docstring rather than an annotation, the analyzer records that explicitly via:

- `typeSource: "docstring"`
- `returnTypeSource: "docstring"`

That provenance is surfaced later in the UI evidence view.

## 11. How Python type information is extracted

Type information in the Python path is best-effort and evidence-based. It is not a full type checker.

The analyzer collects type information from several sources.

### 11.1 Parameter types

For function and method parameters, the analyzer records:

- parameter name
- annotation type if present
- docstring type if no annotation is present or as supplemental evidence
- default value source text if available
- whether the parameter is `*args`, `**kwargs`, or keyword-only

Parameter metadata is stored in `params[]`.

### 11.2 Return types

Return types come from:

- function annotations first
- docstring returns blocks second

The analyzer records both the type string and the evidence metadata:

- `returnType`
- `returnTypeSource`
- `returnTypeConfidence`

### 11.3 Class attributes and instance attributes

For classes, two different attribute buckets are produced:

- `classAttributes`
- `instanceAttributes`

`classAttributes` are collected from annotated assignments in the class body.

`instanceAttributes` are collected heuristically from assignments to `self.*`, especially within `__init__`.

Each attribute can carry:

- `name`
- `type`
- `typeSource`
- `typeConfidence`
- `line`

### 11.4 Local variable typing for flowcharts

Flowchart generation goes a step further than the workspace call graph. `python/flowchart.py` builds a local variable-type map for the target function.

That map is assembled from:

- typed parameters
- local assignment inference
- resolved call return types
- resolved member return types
- class attribute type knowledge

The purpose is not to emit a standalone type graph. The purpose is to enrich flowchart nodes with readable type labels and return labels.

## 12. How Python call sites are extracted and resolved

Each function and method symbol carries a `calls` array of `PyCallSite` objects.

Each call site includes:

- `text`
- `line`
- `column`
- `resolvedTo` when available
- `resolution`
- `resolutionSource`
- `confidence`
- `externalTarget` for builtins or out-of-scope targets

The resolver in `python/analyzer.py` follows layered heuristics.

### 12.1 Direct AST-based resolution

The analyzer can resolve these cases with relatively high confidence:

- local function names in the same module
- `self.method(...)` using the enclosing class member map
- import aliases when the imported symbol exists in the analyzed scope
- from-import aliases when the target symbol exists in the analyzed scope

### 12.2 Likely resolution

Some patterns are marked as likely rather than fully resolved, such as:

- `cls.method(...)`
- `Class.method(...)`

This distinction is preserved in the graph edge metadata as `resolution`.

### 12.3 Unresolved calls

Calls remain unresolved when the target cannot be mapped to a known symbol in scope.

Special unresolved categories include:

- builtins, marked with `resolutionSource: "builtin"`
- out-of-scope imports, marked with `resolutionSource: "out-of-scope-import"`

These unresolved calls do not become internal graph edges unless there is a known in-scope target.

### 12.4 Optional Jedi upgrade pass

If `useJedi` is enabled and Jedi is importable in the chosen interpreter, unresolved or likely call sites may be upgraded using Jedi inference and goto behavior.

This is optional. The core analyzer still works without Jedi.

The summary reports:

- whether Jedi was enabled
- how many call sites Jedi resolved
- overall call resolution totals

## 13. What the Python IR does and does not represent

The Python implementation currently represents:

- modules
- classes
- functions
- methods
- imports
- parameter and return type evidence
- class and instance attribute evidence
- best-effort call relationships
- source locations
- lightweight flowchart grouping metadata

It does not currently represent these as first-class IR objects:

- a separate lexical scope tree
- SSA form
- dataflow lattice state
- full read/write effect graphs in the main analysis result
- precise runtime execution order

That matters when interpreting features like the execution trace and dataflow overlay. Those features are intentionally approximate and presentation-oriented rather than compiler-grade IR.

## 14. Graph model shared by Python views

All Python visualizations are emitted as `GraphDocument` objects from `src/python/model/graphTypes.ts`.

`GraphDocument` contains:

- `graphType`
- `title`
- `subtitle`
- `nodes`
- `edges`
- `rootNodeIds`
- `metadata`

Each `GraphNode` contains:

- `id`
- `kind`
- `label`
- `detail`
- `module`
- `className`
- `source`
- `styleCategory`
- `metadata`

Each `GraphEdge` contains:

- `id`
- `from`
- `to`
- `kind`
- `label`
- `resolution`
- `metadata`

This common schema is why the same webview runtime can render both workspace graphs and flowcharts.

## 15. Python workspace call graph construction

The main builder is `buildWorkspaceGraph` in `src/python/analysis/pythonCallGraphBuilder.ts`.

Its behavior is intentionally simple and stable.

### 15.1 Node generation

For the workspace graph:

- module symbols are skipped as visible workspace nodes
- functions, methods, and classes become visible nodes
- each node is populated from the symbol record
- type, decorator, docstring, and class metadata are attached under `metadata`

Important metadata forwarded to the UI includes:

- `isAsync`
- `decorators`
- `params`
- `returnType`
- `returnTypeSource`
- `returnTypeConfidence`
- `docSummary`
- `methodKind`
- `bases`
- `classAttributes`
- `instanceAttributes`

That metadata is how the UI can display signatures, evidence, doc summaries, and class structure without re-querying the analyzer.

### 15.2 Edge generation

The builder emits a `calls` edge only when a call site has a valid in-scope `resolvedTo` symbol.

Each edge preserves the static call classification:

- `resolved`
- `likely`
- `unresolved`

In practice the visible workspace graph is therefore an internal, in-scope call graph rather than a complete graph of every textual call expression.

### 15.3 Module coloring

Module colors are computed by `computeModuleColorMap` in `src/python/analysis/hierarchicalGraphBuilder.ts`.

The assignment is deterministic:

- module names are sorted alphabetically
- colors are assigned from a fixed palette in order
- the same mechanism also assigns stable colors for synthetic package nodes used by higher zoom levels

This makes graph colors stable across refreshes.

## 16. File-scoped Python call graph behavior

There is no separate Python-only file analyzer. The file graph is derived from the workspace graph in `runShowFileGraph` inside `src/extension.ts`.

The host builds the file graph as follows:

1. index the Python workspace
2. build the full workspace graph
3. identify nodes whose `source.file` matches the target file
4. include those nodes as the file's internal symbol set
5. include direct external dependency endpoints connected to those symbols
6. keep only edges where both endpoints are in the included set and at least one endpoint belongs to the file
7. recompute scoped execution timeline and scoped module colors

The resulting graph subtitle reports:

- the file path
- how many symbols belong to the file
- how many external dependency nodes were pulled in
- how many call edges remain in the scoped graph

This means the file graph is not a textual outline of one file. It is a boundary graph showing the file's internal symbols plus its direct static call boundary.

## 17. Symbol-centric graphs and static traces

`src/python/analysis/pythonCallGraphBuilder.ts` also provides additional graph-building helpers.

### 17.1 Symbol call graph

`buildSymbolCallGraph` builds a symbol-centric graph around a root symbol.

It supports:

- configurable traversal depth
- caller expansion
- callee expansion

This is a breadth-first neighborhood view around a selected symbol.

### 17.2 Static execution trace

`buildStaticTrace` constructs an approximate ordered traversal rooted at a function.

The trace:

- walks resolved function and method calls in source order
- labels edges as `execution_step`
- records cycles without recurring infinitely
- stops at a configurable maximum number of steps

This is not live tracing. It is a static approximation of likely execution order based on the call graph.

## 18. How the workspace graph derives an execution timeline

The workspace graph builder also embeds a lighter-weight execution timeline in `metadata.execTimeline`.

That timeline is assembled like this:

1. count incoming and outgoing call edges per node
2. choose an entry symbol
3. prefer a symbol named `main`
4. otherwise choose a zero-incoming node with the largest outgoing fan-out
5. otherwise fall back to the first node
6. walk the graph depth-first, appending ordered edge steps

Each timeline item stores:

- `edge: [fromId, toId]`
- `label`
- `desc`

`desc` comes from the callee node's `docSummary` when available.

This timeline drives the webview's execution panel and animated step progression. It is intentionally heuristic. It is meant to make the call graph readable as a sequence, not to claim exact runtime truth.

## 19. Python flowchart generation

Python flowcharts are built by `python/flowchart.py`.

The request shape is:

```json
{
  "file": "C:/abs/path/a.py",
  "line": 42,
  "analysis": { "...optional PyAnalysisResult..." }
}
```

The helper locates the innermost function or method that contains the requested line and builds a `graphType: "flowchart"` document.

### 19.1 Target selection

`find_target_function` walks the AST and collects functions whose source range contains the line. It then chooses the innermost one by sorting candidates in reverse by starting line.

This is why placing the cursor inside a nested function yields the nested function's flowchart rather than the outer one.

### 19.2 Flowchart node kinds

The Python flowchart path emits these node kinds in practice:

- `entry`
- `process`
- `compute`
- `decision`
- `loop`
- `loop_else`
- `return`
- `error`
- `break`
- `continue`

### 19.3 Granularity rules

The builder intentionally does not emit one node per AST statement in all cases.

Important simplification rules are:

- consecutive simple statements are collapsed into a single `process` or `compute` node
- branches become explicit decision nodes
- loops become loop headers plus body structure
- `raise` becomes an `error` node
- explicit `return` becomes a `return` node
- falling off the end produces an `implicit return` node

This yields a readable structural flowchart instead of a literal CFG.

### 19.4 Statements currently modeled

The flowchart builder has explicit logic for:

- `if` and chained branch structures
- `for`, `async for`, and `while`
- `try/except/finally`
- `with` and `async with`
- `match` on supported Python versions
- `return`
- `raise`
- `break`
- `continue`

### 19.5 Group metadata

The flowchart builder emits `metadata.groups` describing compound regions such as:

- function bodies
- branch bodies
- loop bodies

This group metadata is critical for the renderer. It enables:

- group boxes
- collapse and expand behavior
- drilldown navigation into subgraphs
- stable edge routing against collapsed group summaries

### 19.6 Signature and type display in flowcharts

The entry node is enriched with:

- parameter metadata
- return type
- doc summary
- a formatted signature string

Return nodes may also carry a `typeLabel` such as `returns SomeType` when enough evidence exists.

Process and compute nodes can receive local type labels derived from the function-local inference map.

## 20. Python dataflow support

The repository also contains `python/dataflow.py`, and the webview includes a dataflow overlay path.

The current Python implementation uses this in a secondary way:

- the main Python views remain call graph and flowchart
- flowchart mode can show superimposed dataflow-style overlays
- those overlays can fall back to inferred relationships when explicit read/write metadata is not available

This means Python dataflow visualization currently complements the flowchart. It does not replace the primary analysis pipeline.

## 21. Graph webview panel behavior

`src/providers/graphWebviewProvider.ts` owns the graph panel.

Its responsibilities are:

- create or reuse a single webview panel
- set CSP and resource roots
- load `webview/styles.css` and bundled `dist/webview/main.js`
- post graphs to the webview
- post runtime frames to the webview
- post UI state to the webview
- forward reveal, refresh, debug, and flowchart requests back to the host

The provider keeps these pieces of state:

- `lastGraph`
- `lastRuntime`
- the flowchart drilldown stack
- UI state such as force settings and theme settings

When the webview sends `ready`, the provider replays the current graph, UI state, and runtime frame.

## 22. Python graph rendering architecture in the webview

The frontend entry point is `webview/main.js`.

The current webview runtime uses shared chrome around graph renderers:

- toolbar
- breadcrumb strip for flowchart drilldown
- canvas container
- legend panel
- execution panel
- runtime debug panel
- tooltip layer

`main.js` receives `setGraph`, `flowchartLayer`, `setRuntimeFrame`, and `setUiState` messages and dispatches accordingly.

### 22.1 Current renderer mode

The current defaults are:

- `USE_REACT_FLOW_FLOWCHART = true`
- `USE_REACT_FLOW_CALLGRAPH = true`

So the active Python flowchart and call-graph experience uses the React Flow renderers by default. Legacy SVG rendering logic still exists in the webview for some features and fallback behavior, but the default Python visuals run through the React Flow paths.

### 22.2 Shared tooltip behavior

The tooltip is populated from graph node metadata and shows, when available:

- module name
- node label
- parameter list
- return type
- doc summary
- source file and line
- connection counts
- evidence metadata when the evidence toggle is enabled

Evidence display comes from the same analyzer metadata described earlier. This is where the extracted type provenance becomes user-visible.

## 23. Python workspace and file graph visuals

The call-graph renderer groups Python symbols by module and class.

The visual model includes:

- module grouping and stable module colors
- class groups inside modules
- symbol nodes for functions, methods, and classes
- call edges colored by module styling
- ambient edge particles
- execution-step animation driven by the static timeline

Important interaction behavior:

- nodes can be toggled between expanded box mode and circular summary mode
- modules and classes can be collapsed and expanded
- collapse-all forces every node into circle mode
- expand-all forces every node into box mode
- per-node collapse state is persisted in layout snapshots

The legend in call-graph mode is module-based. It is built from `graph.metadata.moduleColors`.

## 24. Python flowchart visuals

The flowchart renderer presents Python control flow as grouped structural regions.

Visual elements include:

- typed entry node for the selected function
- colored node classes by semantic role
- grouped regions for loops, branches, and function bodies
- collapsible summaries for compound groups
- node circle mode and expanded box mode
- routed control-flow edges with labels such as `yes`, `no`, `repeat`, `done`, `break`, and `continue`

The flowchart legend is semantic rather than module-based. It identifies node categories such as:

- entry and exit
- process
- decision
- loop
- break
- continue
- error
- compute
- output

Important flowchart defaults:

- when there is no persisted node state, nodes start in collapsed circle mode
- nested or loop-related groups tend to start collapsed unless saved state overrides them
- persisted group and node layout state is respected when available

## 25. Progressive flowchart reading and drilldown

The Python flowchart path supports progressive reading through the provider's flowchart layer stack.

This works like this:

1. the top-level flowchart is shown normally
2. the user drills into a group
3. the provider extracts a subgraph for that group
4. the webview receives a `flowchartLayer` message
5. the breadcrumb bar updates
6. the focused subgraph is rendered

This gives Python flowcharts two levels of readability:

- overview of the full function
- focused reading of a collapsed region

## 26. Execution panel behavior

The webview also exposes an execution panel driven by `metadata.execTimeline`.

That panel is not live-debug data. It is the static timeline derived from the Python call graph.

The execution panel and step controls use:

- timeline labels from target node names
- timeline descriptions from target node doc summaries
- animated particles between nodes

This is why docstrings matter beyond tooltips. They are also used to make the static execution panel more descriptive.

## 27. Live Python debug synchronization

Live debug behavior is handled by `src/live/debugSync.ts` and host-side mapping in `src/extension.ts`.

### 27.1 Data collection from the debugger

`DebugSyncService` subscribes to:

- active stack item changes
- debug session starts
- debug session termination
- active debug session changes

When a refresh is triggered, it queries the debug adapter using custom DAP requests:

- `threads`
- `stackTrace`
- `scopes`
- `variables`

It then emits a `RuntimeFrame` containing:

- frame id
- frame name
- current source location
- current call stack
- variables grouped by scope name
- thread id
- session id

The service also applies practical limits:

- at most 40 variables per scope
- variable values truncated to 200 characters

### 27.2 Variable display policy

The runtime panel intentionally displays variables in a compact form:

- variable name
- variable type when present
- scope grouping

The visible panel does not emphasize raw values. The focus is on structure and touched-variable indication rather than becoming a full watch window replacement.

## 28. Mapping live Python frames back to graph nodes

The extension host maps runtime frames to visible nodes with `findGraphNodeByLocation`.

The mapping logic:

- compares the runtime file path to node `source.file`
- checks whether the runtime line falls within the node source range
- prefers the closest containing node by smallest distance from node start line

This is a source-range containment match, not a name-based match.

That detail is important. The runtime highlight system is driven primarily by source coordinates, which makes it robust even when different symbols share similar names.

## 29. Current Python runtime highlighting behavior

The host computes two highlight arrays:

- `highlightNodeIds`
- `breakpointNodeIds`

For the Python path:

- the current frame's source line maps to the primary highlighted node
- if the visible graph is not a flowchart, stack ancestors can also be highlighted
- if the current source line is also an enabled source breakpoint, the node is marked as a breakpoint-hit node

The webview then applies these classes:

- `runtime-active` for the current node
- `runtime-ancestor` for call-stack ancestors in non-flowchart graphs
- `runtime-breakpoint-hit` for a breakpoint stop

The runtime panel also shows:

- frame name
- source file and line
- grouped variables
- compact call stack

Touched variables are computed by comparing the new runtime frame to the previous one. In non-flowchart graphs, nodes mentioning touched variables can be flashed as a secondary cue.

For flowcharts specifically, the behavior is stricter: the current execution node is the primary focus, mirroring an editor-like current-line highlight rather than broadly illuminating unrelated nodes.

## 30. Breakpoint highlighting behavior

Breakpoint highlighting is source-based.

`src/extension.ts` checks whether the current frame location matches an enabled `SourceBreakpoint` by comparing:

- normalized file path
- 1-based source line

When it matches, the mapped node id is added to `breakpointNodeIds`.

The webview renders that node with a temporary red breakpoint-hit accent in addition to the normal runtime highlight.

## 31. Reveal and navigation behavior

When the user clicks a Python graph node, the webview posts `revealNode` with the node source location.

The host then:

1. opens the file
2. moves the editor cursor to the node's source line and column
3. reveals that range in the editor

When the user double-clicks a Python call-graph node, the webview posts `requestFlowchart`, and the host builds a Python flowchart for that node's source location.

This is the main cross-view navigation path from workspace graph to function-level control flow.

## 32. Persistence model on the Python path

The Python implementation persists state at several levels.

### 32.1 Extension host persistence

Stored in `workspaceState`:

- unchecked file paths for scope selection
- actions-view UI state

### 32.2 Webview persistence

Stored in `localStorage`:

- graph layout snapshots
- per-node circle-collapse state
- group collapse state
- saved positions for nodes and groups

Snapshots are keyed by graph identity. Refresh explicitly clears stored layouts before rebuilding so the graph can return to renderer defaults when requested.

## 33. Logging, errors, and observability

The extension writes diagnostics to the `CodeMap` output channel.

Important logged events include:

- analysis summaries
- parse errors
- graph dimensions
- webview debug messages
- request-flowchart failures
- helper execution errors

For Python analysis, the host logs a compact summary showing:

- number of files
- number of functions
- number of classes
- type coverage percentage
- whether Jedi contributed
- parse error count

Helper execution errors include interpreter details and captured stderr, which makes Python environment failures diagnosable from the extension side.

## 34. Build artifacts relevant to the Python experience

The Python analyzer itself is not bundled into JavaScript. It stays as Python source under `python/`.

The extension runtime loads:

- TypeScript output from `out/`
- bundled webview code from `dist/webview/main.js`

The normal build path is:

- `npm run compile`

That compiles the extension host TypeScript and bundles the webview.

## 35. Practical Python request-to-render sequences

### 35.1 Workspace call graph

1. The user triggers `CodeMap: Workspace Call Graph`.
2. `NavigationController` requests Python analysis from `PythonWorkspaceIndexer`.
3. `buildWorkspaceGraph` converts the analysis into nodes, edges, colors, and an execution timeline.
4. `GraphWebviewProvider.show` posts the graph.
5. `webview/main.js` renders the Python workspace graph.

### 35.2 File call graph

1. The user triggers `CodeMap: Call Graph for File`.
2. The host indexes the Python workspace.
3. The host builds the workspace graph.
4. The host filters the graph to file-owned symbols plus direct external dependencies.
5. The host scopes the execution timeline and module colors.
6. The provider posts the filtered graph to the webview.

### 35.3 Flowchart for current function

1. The user places the cursor inside a Python function.
2. The user triggers `CodeMap: Show Flowchart for Current Function`.
3. The host indexes the Python workspace so the flowchart builder can reuse symbol metadata.
4. The host calls `python/flowchart.py` with the file, line, and optional analysis payload.
5. The helper finds the innermost containing function and emits a `flowchart` graph document.
6. The provider posts the graph and the webview renders the flowchart.

### 35.4 Live debug update

1. The user starts debugging Python code in VS Code.
2. `DebugSyncService` detects the active frame change.
3. The service fetches stack, scopes, and variables through DAP requests.
4. The host maps the current source line to visible graph nodes.
5. The provider posts `setRuntimeFrame` with highlight ids.
6. The webview updates the runtime panel and node highlight classes.

## 36. Summary of where each kind of Python information comes from

### 36.1 Docstrings

Source:

- `ast.get_docstring`

Used for:

- `docSummary` on symbols
- tooltip secondary text
- execution timeline descriptions
- flowchart entry metadata
- docstring-derived parameter and return typing

### 36.2 Types

Source:

- function annotations
- parameter annotations
- class-body annotated assignments
- `self.*` assignment heuristics
- docstring parsing
- local flowchart inference from assignments and resolved call return types

Used for:

- node signatures
- evidence panels
- return labels
- flowchart node type labels
- attribute evidence in tooltips

### 36.3 Call graph structure

Source:

- AST call extraction in `python/analyzer.py`
- optional Jedi refinement for unresolved calls

Used for:

- workspace call graph
- file call graph
- symbol-centric neighborhood graphs
- static execution trace generation
- execution timeline heuristics

### 36.4 Execution views

Source:

- static: depth-first walk over resolved call edges
- live: DAP stack frames and source locations from VS Code debug sessions

Used for:

- execution panel controls and step animation
- runtime panel
- current-node highlighting
- ancestor highlighting in non-flowchart graphs
- breakpoint-hit highlighting

## 37. Current limitations of the Python implementation

The current Python implementation is intentionally useful rather than exhaustive.

Known boundaries include:

- call resolution is heuristic and limited to analyzable static structure
- unresolved external library behavior does not become full internal graph structure
- the static execution timeline is only an approximation
- flowcharts are readable control-flow summaries, not exact compiler CFGs
- local variable typing inside flowcharts is heuristic
- the main analysis result does not model a full dataflow IR

Those limitations are design choices in the current codebase, not accidental omissions in this document.

## 38. What is currently true of the Python implementation

As implemented today, the Python path in CodeMap is best described as:

- a static AST-based workspace analyzer
- an evidence-preserving symbol and call extractor
- a graph builder that enriches nodes with docstring and type metadata
- a flowchart builder that turns one Python function into a grouped structural control-flow view
- a webview renderer that uses those metadata fields directly in tooltips, legends, execution panels, and runtime panels
- a debug bridge that maps live VS Code stack frames back onto graph nodes by source range

That is the current Python implementation in the repository.
