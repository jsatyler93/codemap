vscode extention name :codemap


You are building a new VS Code extension by evolving an existing codebase and borrowing architectural ideas from another one.

Primary goal:
Create a Python-first VS Code extension that merges:
1. function-level interactive flowcharts
2. project-level and symbol-level interactive call graphs
into one coherent extension and one coherent UI language.

Important licensing / reuse rule:
- Use this repository as the PRIMARY BASE:
  - https://github.com/DucPhamNgoc08/CodeVisualizer.git
- Study this repository only for ideas and feature inspiration:
  - https://github.com/koknat/callGraph
- DO NOT copy code from callGraph into the new extension.
- Reimplement the call graph logic ourselves.
- Keep the project cleanly based on the CodeVisualizer codebase.
- Focus only on Python in this first version.

Context:
I already have two HTML/CSS/JS templates prepared separately:
- one for function flowcharts
- one for call graphs / execution-trace style visualization

Those templates will be provided as files in the working tree.
Do not regenerate them from scratch unless necessary.
Instead, integrate them into a proper VS Code extension architecture and refactor them into maintainable modules.

High-level product vision:
We want one extension that can:
- show a function flowchart for the selected Python function
- show a call graph centered on the selected Python function/symbol
- show a file/module-level Python call/import graph for the workspace
- optionally show an execution-style guided trace for a selected root function using a static ordered approximation
- let the user navigate from graph nodes back to source code
- keep a consistent visual identity between flowchart mode and call-graph mode

Core design decision:
Use CodeVisualizer as the extension/platform base.
Do not try to literally merge two extensions mechanically.
Instead:
- fork CodeVisualizer
- preserve its extension shell, commands, contribution points, build pipeline, and general architecture where useful
- add a new Python call graph subsystem and new view modes
- unify the webview frontend so flowchart and call graph feel like parts of one product

Scope constraints for v1:
- Python only
- static analysis only
- local analysis only
- no LLM dependency
- no multi-language support yet
- no dynamic tracing yet
- no heavy framework rewrite unless needed
- prioritize maintainability and correctness over feature count

Main deliverable:
A working VS Code extension project that can be opened in VS Code, launched in Extension Development Host, and provide:
- “Show Python Flowchart for Current Function”
- “Show Python Call Graph for Current Symbol”
- “Show Python Workspace Graph”
- a toggle inside the webview or command layer to switch between flowchart and call-graph views
- node click -> reveal source location in editor

Non-goals for this iteration:
- perfect handling of all Python metaprogramming
- runtime call tracing
- async instrumentation
- multi-root workspace edge cases beyond reasonable support
- copying callGraph code
- preserving every single original CodeVisualizer feature if it conflicts with a cleaner Python-first architecture

==================================================
PHASE 0 — REPOSITORY STRATEGY
==================================================

1. Clone/fork CodeVisualizer as the starting point.
2. Inspect the current extension structure and identify:
   - extension entrypoint
   - commands
   - webview providers
   - parser / analysis modules
   - build tooling
   - packaging / manifest
3. Create a new branch for the Python-merged visualization work.
4. Create a short architecture note in the repo, for example:
   docs/python-visualization-plan.md
   explaining:
   - why CodeVisualizer is the base
   - why callGraph is reference-only
   - target features for v1
   - analysis pipeline
   - webview/view architecture

Do not skip the architecture note.

==================================================
PHASE 1 — ARCHITECTURE REFACTOR
==================================================

Refactor toward this structure, adapting names if the base repo already has close equivalents:

src/
  extension.ts
  commands/
    showFlowchart.ts
    showCallGraph.ts
    showWorkspaceGraph.ts
    revealNodeInEditor.ts
  python/
    analysis/
      pythonWorkspaceIndexer.ts
      pythonSymbolExtractor.ts
      pythonCallResolver.ts
      pythonImportResolver.ts
      pythonFlowchartBuilder.ts
      pythonCallGraphBuilder.ts
      pythonExecutionApproxBuilder.ts
    model/
      graphTypes.ts
      flowTypes.ts
      symbolTypes.ts
  providers/
    graphWebviewProvider.ts
    sidebarProvider.ts
  messaging/
    protocol.ts
  utils/
    pathUtils.ts
    uriUtils.ts
    debounce.ts

webview/
  src/
    app/
      main.ts
      state.ts
      messageBus.ts
    shared/
      theme.ts
      geometry.ts
      graphModel.ts
    views/
      flowchart/
      callgraph/
    components/
      toolbar/
      search/
      minimap/
      legend/
      infoPanel/

If the existing CodeVisualizer structure is already good, adapt instead of forcing this exact tree.
But keep the separation between:
- extension host logic
- Python analysis logic
- shared graph model
- webview UI

==================================================
PHASE 2 — DATA MODEL
==================================================

Create explicit typed internal models.

Use a shared graph model like:

type NodeKind =
  | "function"
  | "method"
  | "class"
  | "module"
  | "entry"
  | "return"
  | "decision"
  | "process"
  | "compute"
  | "output"
  | "error";

type EdgeKind =
  | "calls"
  | "imports"
  | "contains"
  | "inherits"
  | "control_flow"
  | "execution_step";

interface SourceRef {
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  module?: string;
  className?: string;
  source?: SourceRef;
  styleCategory?: string;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  metadata?: Record<string, unknown>;
}

interface GraphDocument {
  graphType: "flowchart" | "callgraph" | "workspace";
  title: string;
  subtitle?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootNodeIds?: string[];
  metadata?: Record<string, unknown>;
}

Make flowchart generation and call graph generation both emit serializable GraphDocument-like structures.
The webview should consume normalized JSON, not raw AST objects.

==================================================
PHASE 3 — PYTHON ANALYSIS ENGINE
==================================================

Implement a Python-first static analyzer.

Preferred approach:
- use Python AST semantics where possible
- if the existing base uses tree-sitter for Python successfully, that is acceptable
- do NOT use regex-only parsing for the main implementation
- if needed, use a hybrid:
  - AST/tree-sitter for structure
  - lightweight heuristics for resolution

Required extraction abilities:
1. Find Python files in workspace
2. Extract:
   - modules
   - top-level functions
   - classes
   - methods
   - imports
   - calls inside functions/methods
3. Record source locations precisely
4. Build symbol tables:
   - module-local symbols
   - class methods
   - imported names where resolvable
5. Resolve call edges conservatively:
   - direct local function calls
   - self.method() calls inside classes
   - Class.method references where statically resolvable
   - imported function references when mapping is clear
6. Mark ambiguous/unresolved calls separately in metadata instead of inventing false edges

Design resolution quality levels:
- resolved
- likely
- unresolved

Do not overclaim certainty.

Expected Python support in v1:
- def
- async def
- class methods
- nested calls inside if/for/while/try/with
- imports: import x, import x as y, from x import y, from x import y as z
- decorators can be ignored for edge generation in v1 unless easy
- lambda can be ignored or minimally supported
- dynamic getattr/exec/eval should be marked unresolved

==================================================
PHASE 4 — FLOWCHART INTEGRATION
==================================================

Use my provided function flowchart template as the visual basis for function-level visualization.

Requirements:
- integrate the provided flowchart template into the extension webview
- modularize it into maintainable code
- do not leave it as one monolithic HTML file
- preserve the visual style and interaction behavior as much as practical
- drive it from analysis JSON rather than hardcoded nodes

Implement Python flowchart generation for the currently selected function:
- input: a selected Python function/method
- output: flowchart nodes/edges representing:
  - entry
  - decisions
  - loops
  - try/except/finally
  - raises
  - returns
  - important compute/process blocks

Granularity rule:
- group simple linear statements into compact process/compute blocks
- create decision nodes for if/elif/else
- show loop constructs clearly
- show try/except branches
- keep charts readable rather than one-node-per-line

For v1, generate readable approximate flowcharts rather than perfect CFGs.

==================================================
PHASE 5 — CALL GRAPH INTEGRATION
==================================================

Use my provided call graph / execution-flow template as the visual basis for call graph mode.

Requirements:
- integrate the provided call graph template into the extension webview
- modularize it into maintainable code
- preserve:
  - panning / zooming
  - ambient edge animation
  - node selection
  - execution-style trace mode concept
  - search
  - legend/info panels
- make it data-driven from GraphDocument JSON

Implement three call graph modes:

A. Symbol-centric call graph
- center on the currently selected function/method
- show callers and callees within configurable depth, default depth=1
- allow expanding outward

B. File/module graph
- show functions grouped visually by file/module
- draw call edges across files
- optionally show import edges separately or as a filter

C. Workspace graph
- show a higher-level graph of Python files/modules and their import/call relationships
- avoid clutter with simple collapsing/grouping

Important:
- this is NOT just an import graph
- actual function/method call edges are required where resolvable

==================================================
PHASE 6 — EXECUTION-STYLE APPROXIMATION
==================================================

My second template contains an “auto trace” and “step-by-step” visualization idea.

Implement this carefully as a STATIC APPROXIMATION mode, not a runtime truth claim.

For a selected root function:
- generate an approximate ordered call sequence using:
  - body order traversal
  - branch-aware heuristics
  - nested call discovery
- expose it as “static trace” or “approximate execution trace”
- do not label it as actual runtime execution
- show clear UI wording to avoid misleading users

Required UX wording examples:
- “Static Trace”
- “Approximate ordered traversal”
- “Based on static analysis”

Do not imply certainty.

==================================================
PHASE 7 — VS CODE INTEGRATION
==================================================

Add or adapt commands:

1. Python: Show Flowchart for Current Function
2. Python: Show Call Graph for Current Symbol
3. Python: Show Workspace Graph
4. Python: Reveal Graph Node in Editor
5. Python: Refresh Visualization

Context menu integrations:
- editor context menu for Python files/functions if practical
- command palette support

Selection behavior:
- detect current symbol from cursor position in Python file
- map it to extracted symbol
- if multiple possible matches exist, prefer the innermost function/method

Webview interactions:
- clicking a node reveals the symbol/file in the editor
- toolbar toggle between flowchart / call graph / workspace graph
- search/filter works on current graph
- reset view works
- state refreshes when file changes or command reruns

==================================================
PHASE 8 — FRONTEND UNIFICATION
==================================================

Unify the two provided templates into one product language.

Requirements:
- consistent toolbar styling
- consistent color system
- consistent zoom/pan behavior
- shared tooltip conventions
- shared legend/info panels where possible
- shared search and node-selection behavior
- theme compatibility with VS Code dark/light themes if reasonable

Do not leave two unrelated-looking mini apps.
They should feel like two modes of the same extension.

Create reusable frontend modules for:
- svg canvas setup
- pan/zoom
- node rendering
- edge rendering
- animation loop
- tooltips
- search highlight
- source reveal message posting to extension host

==================================================
PHASE 9 — PERFORMANCE AND UX GUARDRAILS
==================================================

Performance rules:
- keep analysis incremental where practical
- cache workspace symbol extraction
- debounce file-change refreshes
- avoid rebuilding the entire workspace graph on every cursor move
- for large workspaces, cap default graph size and offer expansion
- isolate expensive graph layout work

UX rules:
- if graph is too large, show a readable partial graph first
- prefer centered-neighborhood graphs for symbols
- clearly indicate unresolved/ambiguous edges
- provide graceful empty states
- provide readable error messages when analysis fails

==================================================
PHASE 10 — TESTING
==================================================

Add focused tests for the Python analysis layer.

Create small Python fixtures covering:
- simple local function calls
- imported function calls
- class methods and self.method()
- cross-file calls
- nested if/loop/try constructs for flowchart generation
- unresolved dynamic calls

Add tests for:
- symbol extraction
- call edge resolution
- flowchart JSON generation
- graph JSON shape stability

Also add a manual demo workspace under something like:
samples/python_demo/
with a few small Python files that exercise all major features.

==================================================
PHASE 11 — DOCUMENTATION
==================================================

Update README with:
- project purpose
- Python-first scope
- supported analysis guarantees and limitations
- screenshots or placeholders
- how to run in dev mode
- how to package the extension
- static analysis limitations
- note that execution trace mode is approximate

Also add:
docs/architecture.md
docs/python-analysis.md

==================================================
IMPLEMENTATION PRIORITY ORDER
==================================================

Build in this exact order:

1. Get CodeVisualizer-based extension to run unchanged locally
2. Identify the current flowchart and dependency graph entry points
3. Add normalized GraphDocument model
4. Integrate my flowchart template in modular form
5. Make current-function Python flowchart work end-to-end
6. Add Python symbol extraction
7. Add Python call graph builder for current symbol
8. Integrate my call graph template in modular form
9. Make node click reveal source
10. Add module/workspace graph
11. Add static trace mode
12. Add caching, polish, docs, and tests

Do not jump ahead.

==================================================
QUALITY BAR
==================================================

Code requirements:
- TypeScript strictness where practical
- clear interfaces
- minimal hacks
- avoid giant files
- no hardcoded demo graph data in production paths
- keep renderer code separate from analysis code

Product requirements:
- if something is approximate, say so in UI and docs
- if a call edge is unresolved, show it differently or omit it
- prefer trustworthy graphs over flashy but wrong graphs

==================================================
EXPECTED OUTPUT FROM YOU
==================================================

Work in iterative commits/steps and keep a running checklist.

First produce:
1. a concise repo inspection summary
2. a proposed file-by-file implementation plan
3. the architecture note
4. then begin the actual code changes

As you work:
- explain what files you are changing and why
- keep changes small and coherent
- if the base repo structure suggests a better integration path than my proposed tree, adapt intelligently

If you must choose between preserving existing CodeVisualizer internals and building a cleaner Python-first architecture, choose the cleaner architecture, but avoid unnecessary rewrites.

Final target:
A clean, runnable VS Code extension prototype for Python that unifies:
- function flowcharts
- call graphs
- workspace graphs
- approximate static trace mode
using my provided templates as the frontend basis and CodeVisualizer as the extension foundation.


call the extention : codemap
