# CodeMap Data-Flow Overlay — Complete Implementation Plan

## Goal

Add a data-flow visualization layer on top of the existing Python flowchart view. Users see the same flowchart they see today, plus variable-flow edges (arcs connecting where a variable is written to where it is read). The data-flow edges are formally correct, extracted using Python's `symtable` module combined with the existing AST walk.

No existing functionality is removed or changed. This is purely additive.

---

## Architecture Overview

```
Existing pipeline (unchanged):
  flowchart.py → GraphDocument (graphType: "flowchart") → flowchartView.js

New pipeline (added alongside):
  dataflow.py → GraphDocument (graphType: "dataflow") → dataflowView.js

Shared:
  - GraphDocument / GraphNode / GraphEdge schemas (unchanged, new data in metadata)
  - graphWebviewProvider.ts (add dispatch for "dataflow")
  - main.js (add dispatch for "dataflow")
  - extension.ts (add command registration)
```

---

## Implementation Steps

There are 5 steps. Each step is self-contained and testable.

---

### Step 1: Create `python/dataflow.py`

This is the backend adapter. It takes a file path + line number (same as flowchart.py), finds the target function, and emits a GraphDocument with per-line nodes carrying reads/writes metadata.

#### 1.1 Entry point

File: `python/dataflow.py`

The entry point mirrors flowchart.py exactly:

```python
import sys
import json
import ast
import symtable

def main():
    request = json.loads(sys.stdin.read())
    file_path = request["file"]
    target_line = request["line"]
    
    with open(file_path, "r", encoding="utf-8") as f:
        source = f.read()
    
    tree = ast.parse(source, filename=file_path)
    
    # Find the innermost function containing target_line
    func_node = find_function_at_line(tree, target_line)
    if func_node is None:
        print(json.dumps({"error": "No function found at line"}))
        return
    
    # Build the dataflow graph
    graph = build_dataflow_graph(func_node, source, file_path)
    print(json.dumps(graph))

if __name__ == "__main__":
    main()
```

#### 1.2 Function finder

Same logic as flowchart.py. Walk the AST, find the innermost FunctionDef or AsyncFunctionDef whose line range contains target_line.

```python
def find_function_at_line(tree, target_line):
    """Find the innermost function/method containing target_line."""
    best = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.lineno <= target_line <= node.end_lineno:
                if best is None or node.lineno > best.lineno:
                    best = node
    return best
```

#### 1.3 Reads/writes extraction using symtable + AST

This is the core new logic. For each line in the function body, determine which names are written and which are read.

Strategy: use `symtable` for scope-correct symbol classification, and AST walk for line-level placement.

```python
def extract_line_effects(func_node, source, filename):
    """
    For each line in the function body, return:
    {
        line_number: {
            "reads": [name, ...],
            "writes": [name, ...],
        }
    }
    """
    # Get the function's source for symtable analysis
    func_source = ast.get_source_segment(source, func_node)
    
    # Build symtable for the function
    try:
        table = symtable.symtable(func_source, filename, 'exec')
        # Find the function's own symbol table (first child of module-level table)
        func_table = None
        for child in table.get_children():
            if child.get_name() == func_node.name:
                func_table = child
                break
        if func_table is None:
            func_table = table
    except SyntaxError:
        func_table = None
    
    # Build set of known local/param symbols from symtable
    known_symbols = set()
    if func_table:
        for sym in func_table.get_symbols():
            known_symbols.add(sym.get_name())
    
    # Walk AST to get per-line reads and writes
    line_effects = {}
    
    for node in ast.walk(func_node):
        if not hasattr(node, 'lineno'):
            continue
        
        line = node.lineno
        if line not in line_effects:
            line_effects[line] = {"reads": set(), "writes": set()}
        
        effects = line_effects[line]
        
        # --- WRITES ---
        if isinstance(node, ast.Assign):
            for target in node.targets:
                _collect_write_targets(target, effects["writes"])
        
        elif isinstance(node, ast.AugAssign):
            _collect_write_targets(node.target, effects["writes"])
            # AugAssign also reads the target
            _collect_read_names(node.target, effects["reads"])
        
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            if node.target:
                _collect_write_targets(node.target, effects["writes"])
        
        elif isinstance(node, ast.For):
            _collect_write_targets(node.target, effects["writes"])
        
        elif isinstance(node, ast.With):
            for item in node.items:
                if item.optional_vars:
                    _collect_write_targets(item.optional_vars, effects["writes"])
        
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node != func_node:  # nested function
                effects["writes"].add(node.name)
        
        elif isinstance(node, ast.ClassDef):
            effects["writes"].add(node.name)
        
        elif isinstance(node, ast.Import):
            for alias in node.names:
                effects["writes"].add(alias.asname or alias.name.split('.')[0])
        
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                effects["writes"].add(alias.asname or alias.name)
        
        elif isinstance(node, ast.NamedExpr):  # walrus operator
            _collect_write_targets(node.target, effects["writes"])
        
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                effects["writes"].add(node.name)
        
        # --- READS ---
        # Collect Name nodes in Load context
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            effects["reads"].add(node.id)
    
    # Convert sets to sorted lists and filter to known symbols
    result = {}
    for line, effects in line_effects.items():
        # Remove built-in names and names not in scope
        reads = sorted(effects["reads"])
        writes = sorted(effects["writes"])
        result[line] = {"reads": reads, "writes": writes}
    
    return result


def _collect_write_targets(node, writes_set):
    """Recursively collect write target names from assignment targets."""
    if isinstance(node, ast.Name):
        writes_set.add(node.id)
    elif isinstance(node, ast.Tuple) or isinstance(node, ast.List):
        for elt in node.elts:
            _collect_write_targets(elt, writes_set)
    elif isinstance(node, ast.Starred):
        _collect_write_targets(node.value, writes_set)
    # ast.Attribute and ast.Subscript targets: we track the root object
    elif isinstance(node, ast.Attribute):
        # obj.attr = val → reads obj (mutation), but does not create new binding
        # Optionally: track as write to "obj.attr" or skip
        pass
    elif isinstance(node, ast.Subscript):
        # arr[i] = val → reads arr (mutation), not a new binding
        pass


def _collect_read_names(node, reads_set):
    """Collect Name nodes in Load context from an expression subtree."""
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
        reads_set.add(node.id)
    for child in ast.iter_child_nodes(node):
        _collect_read_names(child, reads_set)
```

#### 1.4 Build the GraphDocument

Assemble the per-line information into a GraphDocument that matches the existing schema.

```python
def build_dataflow_graph(func_node, source, file_path):
    """Build a GraphDocument with graphType='dataflow' for the target function."""
    
    source_lines = source.splitlines()
    line_effects = extract_line_effects(func_node, source, file_path)
    
    nodes = []
    edges = []
    group_stack = []  # stack of (groupId, parentGroup) for scope tracking
    
    # Determine function line range
    start_line = func_node.lineno
    end_line = func_node.end_lineno
    
    # Emit function signature as first node
    func_params = [arg.arg for arg in func_node.args.args]
    nodes.append({
        "id": f"L{start_line}",
        "kind": "func_def",
        "label": source_lines[start_line - 1].strip(),
        "source": {
            "file": file_path,
            "line": start_line,
            "endLine": start_line
        },
        "metadata": {
            "line": start_line,
            "depth": 0,
            "code": source_lines[start_line - 1],
            "reads": [],
            "writes": func_params,
            "lang": "py",
            "groupId": "func-body",
            "groupRole": "start",
            "summary": f"def {func_node.name}({', '.join(func_params)})"
        }
    })
    
    # Walk body lines
    prev_node_id = f"L{start_line}"
    
    for lineno in range(start_line + 1, end_line + 1):
        if lineno - 1 >= len(source_lines):
            break
        
        raw_line = source_lines[lineno - 1]
        stripped = raw_line.strip()
        node_id = f"L{lineno}"
        
        # Determine depth from indentation relative to function body
        func_indent = len(source_lines[start_line - 1]) - len(source_lines[start_line - 1].lstrip())
        line_indent = len(raw_line) - len(raw_line.lstrip()) if stripped else 0
        depth = max(0, (line_indent - func_indent - 4) // 4 + 1)  # 4-space indent assumed
        
        # Determine node kind and scope behavior
        kind, group_info = classify_line(stripped, lineno, group_stack)
        
        # Get reads/writes for this line
        effects = line_effects.get(lineno, {"reads": [], "writes": []})
        
        # Build metadata
        metadata = {
            "line": lineno,
            "depth": depth,
            "code": raw_line,
            "reads": effects["reads"],
            "writes": effects["writes"],
            "lang": "py"
        }
        
        # Add group info if this line opens a scope
        if group_info:
            metadata["groupId"] = group_info["groupId"]
            if group_info.get("role") == "start":
                metadata["groupRole"] = "start"
                metadata["summary"] = group_info.get("summary", stripped)
            if group_info.get("parentGroup"):
                metadata["parentGroup"] = group_info["parentGroup"]
        elif group_stack:
            # Line is inside a scope but doesn't open one
            metadata["groupId"] = group_stack[-1]["groupId"]
        
        node = {
            "id": node_id,
            "kind": kind,
            "label": stripped if stripped else "",
            "source": {
                "file": file_path,
                "line": lineno,
                "endLine": lineno
            },
            "metadata": metadata
        }
        nodes.append(node)
        
        # Control flow edge from previous node
        if kind not in ("blank", "comment") and prev_node_id:
            edges.append({
                "id": f"cf-{prev_node_id}-{node_id}",
                "from": prev_node_id,
                "to": node_id,
                "kind": "control_flow"
            })
            prev_node_id = node_id
        elif kind not in ("blank", "comment"):
            prev_node_id = node_id
    
    # Build GraphDocument
    return {
        "graphType": "dataflow",
        "title": f"{func_node.name}()",
        "subtitle": f"Data flow — {file_path}",
        "nodes": nodes,
        "edges": edges,
        "rootNodeIds": [f"L{start_line}"],
        "metadata": {
            "function": func_node.name,
            "params": func_params,
            "file": file_path,
            "startLine": start_line,
            "endLine": end_line
        }
    }


def classify_line(stripped, lineno, group_stack):
    """
    Classify a source line into a node kind and detect scope boundaries.
    Returns (kind, group_info_or_None).
    
    group_info shape: {
        "groupId": "loop-L42",
        "role": "start",
        "summary": "for i in range(N)",
        "parentGroup": "if-L30" or None
    }
    """
    parent_group = group_stack[-1]["groupId"] if group_stack else None
    
    if not stripped or stripped.isspace():
        return "blank", None
    
    if stripped.startswith("#"):
        return "comment", None
    
    if stripped.startswith("@"):
        return "decorator", None
    
    # Scope-opening constructs
    if stripped.startswith("for ") and stripped.endswith(":"):
        gid = f"loop-L{lineno}"
        group_stack.append({"groupId": gid, "indent": len(stripped) - len(stripped.lstrip())})
        return "loop", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("while ") and stripped.endswith(":"):
        gid = f"while-L{lineno}"
        group_stack.append({"groupId": gid})
        return "loop", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("if ") and stripped.endswith(":"):
        gid = f"if-L{lineno}"
        group_stack.append({"groupId": gid})
        return "branch", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("elif ") and stripped.endswith(":"):
        gid = f"elif-L{lineno}"
        return "branch", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped == "else:" or stripped.startswith("else:"):
        gid = f"else-L{lineno}"
        return "branch", {
            "groupId": gid,
            "role": "start",
            "summary": "else",
            "parentGroup": parent_group
        }
    
    if stripped.startswith("try") and stripped.endswith(":"):
        gid = f"try-L{lineno}"
        group_stack.append({"groupId": gid})
        return "try_block", {
            "groupId": gid,
            "role": "start",
            "summary": "try",
            "parentGroup": parent_group
        }
    
    if stripped.startswith("except") and stripped.endswith(":"):
        gid = f"except-L{lineno}"
        return "try_block", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("finally") and stripped.endswith(":"):
        gid = f"finally-L{lineno}"
        return "try_block", {
            "groupId": gid,
            "role": "start",
            "summary": "finally",
            "parentGroup": parent_group
        }
    
    if stripped.startswith("with ") and stripped.endswith(":"):
        gid = f"with-L{lineno}"
        group_stack.append({"groupId": gid})
        return "assign", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("def ") and stripped.endswith(":"):
        gid = f"def-L{lineno}"
        group_stack.append({"groupId": gid})
        return "func_def", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("class ") and stripped.endswith(":"):
        gid = f"class-L{lineno}"
        group_stack.append({"groupId": gid})
        return "class_def", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("match ") and stripped.endswith(":"):
        gid = f"match-L{lineno}"
        group_stack.append({"groupId": gid})
        return "branch", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    if stripped.startswith("case ") and stripped.endswith(":"):
        gid = f"case-L{lineno}"
        return "match_arm", {
            "groupId": gid,
            "role": "start",
            "summary": stripped.rstrip(":"),
            "parentGroup": parent_group
        }
    
    # Non-scope statements
    if stripped.startswith("return"):
        return "return", None
    
    if stripped.startswith("import ") or stripped.startswith("from "):
        return "import", None
    
    if any(op in stripped for op in ["+=", "-=", "*=", "/=", "//=", "**=", "%=", "&=", "|=", "^=", "<<=", ">>="]):
        return "augassign", None
    
    if "=" in stripped and not stripped.startswith("=") and "==" not in stripped.split("=")[0]:
        return "assign", None
    
    return "call", None  # default: expression or function call
```

#### 1.5 Important notes for the coding agent

- `classify_line` uses simple string matching. This is intentional — it's for node kind classification and scope detection only. The reads/writes come from the formal AST+symtable analysis, not from string matching.
- The `group_stack` tracking in `classify_line` is approximate. A more robust implementation should use AST node nesting (checking whether each AST node is a child of a scope-opening node). The string-based approach works for most Python code but can be confused by multi-line statements.
- The depth calculation assumes 4-space indentation. A production version should detect the file's actual indentation unit.
- `$` line continuation does not apply to Python. No merging needed.

#### 1.6 Testing

Create a test file `python/test_dataflow.py`:

```python
import json
import sys

# Pipe a test request
test_request = {
    "file": "test_samples/sample1.py",
    "line": 1
}

# Run: echo '{"file":"test_samples/sample1.py","line":1}' | python python/dataflow.py
```

Create `test_samples/sample1.py`:

```python
def simulate(N, r0, L0, method='sinc'):
    delta = 0.02
    cn = np.random.randn(N, N)
    
    if method == 'sinc':
        stencil = build_stencil(delta, L0)
        phi = sinc_generate(stencil, cn)
        phi *= np.sqrt(r0)
    else:
        PSD = von_karman(r0, L0)
        phi = np.fft.ifft2(cn * np.sqrt(PSD)).real
    
    psf = np.abs(np.fft.fft2(phi))**2
    psf /= psf.sum()
    return psf
```

Expected output validation:
- Line 2 (delta = 0.02): writes=["delta"], reads=[]
- Line 3 (cn = ...): writes=["cn"], reads=["N"]  (np is a global, N is a param)
- Line 6 (stencil = ...): writes=["stencil"], reads=["delta", "L0"]
- Line 7 (phi = ...): writes=["phi"], reads=["cn", "stencil"]
- Line 8 (phi *= ...): writes=["phi"], reads=["phi", "r0"]
- Line 11 (phi = ...): writes=["phi"], reads=["cn", "PSD"]
- Line 13 (psf = ...): writes=["psf"], reads=["phi"]
- Line 15 (return): writes=[], reads=["psf"]

---

### Step 2: Wire the host to call `dataflow.py`

#### 2.1 Add runner function

File: `src/python/analysis/pythonRunner.ts`

Add a new function alongside the existing `buildFlowchartFor`:

```typescript
export async function buildDataflowFor(
    file: string,
    line: number,
    analysis?: PyAnalysisResult
): Promise<GraphDocument> {
    const request = { file, line };
    if (analysis) {
        request.analysis = analysis;
    }
    
    const result = await runPythonScript('dataflow.py', request);
    return result as GraphDocument;
}
```

The `runPythonScript` helper already exists in your codebase (it's what calls flowchart.py). Use the same helper.

#### 2.2 Add command registration

File: `src/extension.ts`

Add a new command alongside the existing flowchart command:

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('codemap.showDataflow', async (uri?: vscode.Uri) => {
        // Same logic as codemap.showFlowchart but calls buildDataflowFor
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        const file = uri?.fsPath || editor.document.uri.fsPath;
        const line = editor.selection.active.line + 1;
        
        const graph = await buildDataflowFor(file, line);
        graphWebviewProvider.show(graph);
    })
);
```

#### 2.3 Add to package.json

```json
{
    "commands": [
        {
            "command": "codemap.showDataflow",
            "title": "CodeMap: Show Data Flow",
            "category": "CodeMap"
        }
    ],
    "menus": {
        "editor/context": [
            {
                "command": "codemap.showDataflow",
                "when": "editorLangId == python",
                "group": "codemap"
            }
        ]
    }
}
```

---

### Step 3: Add webview dispatch for "dataflow" graph type

#### 3.1 Update main.js dispatch

File: `webview/main.js`

In the message handler where setGraph is received and dispatched by graphType, add:

```javascript
case 'dataflow':
    renderDataflowView(graph, container);
    break;
```

This sits alongside the existing `case 'flowchart'` and `case 'callgraph'` dispatches.

#### 3.2 Import the new view

```javascript
import { renderDataflowView } from './views/dataflow/dataflowView.js';
```

---

### Step 4: Build the dataflow renderer

This is the main new webview code. It renders the script-as-graph view.

#### 4.1 File structure

```
webview/views/dataflow/
    dataflowView.js       — main renderer
    edgeDerivation.js     — derives data-flow edges from visible nodes
    edgeRenderer.js       — SVG arc rendering on right margin
    syntaxHighlight.js    — Python syntax coloring
    variableSidebar.js    — variable list panel
```

#### 4.2 dataflowView.js — Main renderer

```javascript
/**
 * Renders a dataflow GraphDocument as a script-as-graph view.
 * 
 * Layout: each node is one source line, rendered top-to-bottom.
 * Left: line numbers. Center: indented syntax-highlighted code.
 * Right margin: data-flow edge arcs.
 * 
 * Interactions:
 * - Click scope headers to collapse/expand
 * - Hover lines to highlight connected edges
 * - Hover/click variables in sidebar to trace lifetime
 */

export function renderDataflowView(graph, container) {
    const state = {
        nodes: graph.nodes,
        edges: graph.edges,  // control_flow edges from adapter
        collapsedGroups: new Set(),
        hoveredNodeId: null,
        selectedVariable: null,
        showAllEdges: false,
        showControlFlow: true,
    };
    
    // Initial state: collapse all scopes except func body
    const allGroups = new Set();
    graph.nodes.forEach(n => {
        if (n.metadata?.groupRole === 'start' && n.metadata?.groupId !== 'func-body') {
            allGroups.add(n.metadata.groupId);
            state.collapsedGroups.add(n.metadata.groupId);
        }
    });
    
    // Build DOM
    const wrapper = document.createElement('div');
    wrapper.className = 'dataflow-wrapper';
    
    // Toolbar
    const toolbar = buildToolbar(state, () => render());
    wrapper.appendChild(toolbar);
    
    // Main area: code panel + sidebar
    const mainArea = document.createElement('div');
    mainArea.className = 'dataflow-main';
    
    const codePanel = document.createElement('div');
    codePanel.className = 'dataflow-code-panel';
    
    const sidebar = document.createElement('div');
    sidebar.className = 'dataflow-sidebar';
    
    mainArea.appendChild(codePanel);
    mainArea.appendChild(sidebar);
    wrapper.appendChild(mainArea);
    
    container.innerHTML = '';
    container.appendChild(wrapper);
    
    function render() {
        const visibleNodes = computeVisibleNodes(state.nodes, state.collapsedGroups);
        const dataFlowEdges = deriveDataFlowEdges(visibleNodes);
        const activeEdges = computeActiveEdges(dataFlowEdges, state);
        
        renderCodePanel(codePanel, visibleNodes, state, dataFlowEdges, activeEdges, () => render());
        renderEdgeOverlay(codePanel, dataFlowEdges, activeEdges);
        renderVariableSidebar(sidebar, visibleNodes, state, () => render());
    }
    
    render();
}
```

#### 4.3 edgeDerivation.js — Edge derivation algorithm

This is the critical algorithm. It derives data-flow edges from visible nodes' metadata.reads and metadata.writes.

```javascript
/**
 * Derive data-flow edges from visible nodes.
 * 
 * Algorithm:
 * 1. Maintain lastWriter map: variable name → node id
 * 2. For each visible node in source order:
 *    a. For each name in reads[]: if lastWriter[name] exists, emit edge
 *    b. For each name in writes[]: set lastWriter[name] = this node
 * 3. For collapsed scope headers: aggregate all descendant reads/writes
 * 
 * Returns: Array<{ from, to, variable }>
 */

export function deriveDataFlowEdges(visibleNodes) {
    const lastWriter = {};  // variable name → node id
    const edges = [];
    
    for (const node of visibleNodes) {
        const meta = node.metadata;
        if (!meta || node.kind === 'blank' || node.kind === 'comment') continue;
        
        const reads = meta._aggregatedReads || meta.reads || [];
        const writes = meta._aggregatedWrites || meta.writes || [];
        
        // Step 2a: for each read, connect to last writer
        for (const name of reads) {
            if (lastWriter[name] && lastWriter[name] !== node.id) {
                edges.push({
                    from: lastWriter[name],
                    to: node.id,
                    variable: name
                });
            }
        }
        
        // Step 2b: register writes
        for (const name of writes) {
            lastWriter[name] = node.id;
        }
    }
    
    return edges;
}


/**
 * Compute visible nodes, handling collapse.
 * 
 * When a scope is collapsed:
 * - Only the scope header node is visible
 * - The header gets _aggregatedReads and _aggregatedWrites
 *   which are the union of all descendant reads/writes
 */
export function computeVisibleNodes(allNodes, collapsedGroups) {
    const visible = [];
    const skipGroups = new Set();  // groups whose children should be hidden
    
    for (const node of allNodes) {
        const meta = node.metadata;
        if (!meta) {
            visible.push(node);
            continue;
        }
        
        const groupId = meta.groupId;
        
        // Check if this node is inside a collapsed group
        if (groupId && skipGroups.has(groupId)) {
            continue;
        }
        
        // Check parentGroup chain
        let hidden = false;
        let pg = meta.parentGroup;
        while (pg) {
            if (skipGroups.has(pg)) {
                hidden = true;
                break;
            }
            // Walk up parentGroup chain
            const parentNode = allNodes.find(n => 
                n.metadata?.groupId === pg && n.metadata?.groupRole === 'start'
            );
            pg = parentNode?.metadata?.parentGroup;
        }
        if (hidden) continue;
        
        // If this is a collapsed scope header, aggregate descendants
        if (meta.groupRole === 'start' && collapsedGroups.has(meta.groupId)) {
            const aggregated = aggregateGroupEffects(allNodes, meta.groupId);
            const enrichedNode = {
                ...node,
                metadata: {
                    ...meta,
                    _aggregatedReads: aggregated.reads,
                    _aggregatedWrites: aggregated.writes,
                    _descendantCount: aggregated.count,
                    _isCollapsed: true
                }
            };
            visible.push(enrichedNode);
            skipGroups.add(meta.groupId);
            continue;
        }
        
        visible.push(node);
    }
    
    return visible;
}


/**
 * Aggregate all reads/writes from descendants of a group.
 */
function aggregateGroupEffects(allNodes, groupId) {
    const reads = new Set();
    const writes = new Set();
    let count = 0;
    
    for (const node of allNodes) {
        const meta = node.metadata;
        if (!meta) continue;
        
        // Check if this node belongs to groupId or a child group of groupId
        if (meta.groupId === groupId && !(meta.groupRole === 'start' && meta.groupId === groupId)) {
            (meta.reads || []).forEach(r => reads.add(r));
            (meta.writes || []).forEach(w => writes.add(w));
            count++;
        }
        
        // Also check nodes in child groups (parentGroup chain leads to groupId)
        if (meta.parentGroup === groupId || isDescendantGroup(allNodes, meta.groupId, groupId)) {
            (meta.reads || []).forEach(r => reads.add(r));
            (meta.writes || []).forEach(w => writes.add(w));
            count++;
        }
    }
    
    return {
        reads: [...reads].sort(),
        writes: [...writes].sort(),
        count
    };
}


function isDescendantGroup(allNodes, childGroupId, ancestorGroupId) {
    if (!childGroupId) return false;
    const header = allNodes.find(n => 
        n.metadata?.groupId === childGroupId && n.metadata?.groupRole === 'start'
    );
    if (!header) return false;
    if (header.metadata?.parentGroup === ancestorGroupId) return true;
    return isDescendantGroup(allNodes, header.metadata?.parentGroup, ancestorGroupId);
}


/**
 * Determine which edges are "active" (highlighted) based on current hover/selection state.
 */
export function computeActiveEdges(dataFlowEdges, state) {
    if (state.selectedVariable) {
        return dataFlowEdges.filter(e => e.variable === state.selectedVariable);
    }
    if (state.hoveredNodeId) {
        return dataFlowEdges.filter(e => 
            e.from === state.hoveredNodeId || e.to === state.hoveredNodeId
        );
    }
    return [];
}
```

#### 4.4 edgeRenderer.js — SVG edge arcs on right margin

```javascript
/**
 * Render data-flow edges as SVG arcs on the right margin of the code panel.
 * 
 * Each edge is drawn as a vertical bracket-style connector:
 *   from node → horizontal to lane → vertical to target row → horizontal to target node
 * 
 * Lanes are assigned per variable to minimize crossing.
 * Edges are color-coded by variable name (deterministic hash).
 */

const VARIABLE_COLORS = [
    '#22d3ee', '#f97316', '#a78bfa', '#34d399', '#fbbf24',
    '#f472b6', '#38bdf8', '#fb923c', '#e879f9', '#a3e635',
    '#ef4444', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'
];

function getVariableColor(varName) {
    let hash = 0;
    for (let i = 0; i < varName.length; i++) {
        hash = ((hash << 5) - hash + varName.charCodeAt(i)) | 0;
    }
    return VARIABLE_COLORS[Math.abs(hash) % VARIABLE_COLORS.length];
}

export function renderEdgeOverlay(codePanel, allEdges, activeEdges) {
    // Remove existing SVG overlay if present
    const existing = codePanel.querySelector('.dataflow-edge-svg');
    if (existing) existing.remove();
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('dataflow-edge-svg');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
    
    const panelRect = codePanel.getBoundingClientRect();
    const activeSet = new Set(activeEdges.map(e => `${e.from}-${e.to}-${e.variable}`));
    
    // Assign lanes per variable
    const variables = [...new Set(allEdges.map(e => e.variable))].sort();
    const laneMap = {};
    variables.forEach((v, i) => { laneMap[v] = i; });
    
    const rightEdge = panelRect.width - 16;
    const laneWidth = 12;
    
    for (const edge of allEdges) {
        const fromEl = codePanel.querySelector(`[data-node-id="${edge.from}"]`);
        const toEl = codePanel.querySelector(`[data-node-id="${edge.to}"]`);
        if (!fromEl || !toEl) continue;
        
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        
        const fromY = fromRect.top + fromRect.height / 2 - panelRect.top;
        const toY = toRect.top + toRect.height / 2 - panelRect.top;
        
        const lane = laneMap[edge.variable] || 0;
        const laneX = rightEdge - 20 - lane * laneWidth;
        
        const edgeKey = `${edge.from}-${edge.to}-${edge.variable}`;
        const isActive = activeSet.has(edgeKey);
        const color = getVariableColor(edge.variable);
        
        // Draw bracket-style path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${rightEdge - 4} ${fromY} L ${laneX} ${fromY} L ${laneX} ${toY} L ${rightEdge - 4} ${toY}`;
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', isActive ? '1.5' : '0.7');
        path.setAttribute('opacity', isActive ? '0.75' : '0.12');
        path.setAttribute('stroke-dasharray', '4 3');
        svg.appendChild(path);
        
        // Dot at source
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', rightEdge - 4);
        dot.setAttribute('cy', fromY);
        dot.setAttribute('r', isActive ? '2.5' : '1.5');
        dot.setAttribute('fill', color);
        dot.setAttribute('opacity', isActive ? '0.8' : '0.2');
        svg.appendChild(dot);
        
        // Variable label (only when active)
        if (isActive) {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', laneX - 4);
            text.setAttribute('y', (fromY + toY) / 2);
            text.setAttribute('fill', color);
            text.setAttribute('font-size', '9');
            text.setAttribute('font-family', 'monospace');
            text.setAttribute('text-anchor', 'end');
            text.setAttribute('dominant-baseline', 'middle');
            text.setAttribute('opacity', '0.85');
            text.textContent = edge.variable;
            svg.appendChild(text);
        }
    }
    
    codePanel.style.position = 'relative';
    codePanel.appendChild(svg);
}
```

#### 4.5 variableSidebar.js — Variable list panel

```javascript
/**
 * Render variable sidebar showing all variables with hover/click interaction.
 */

export function renderVariableSidebar(container, visibleNodes, state, rerender) {
    container.innerHTML = '';
    
    // Collect all variables from visible nodes
    const variables = new Set();
    visibleNodes.forEach(n => {
        const meta = n.metadata;
        if (!meta) return;
        const reads = meta._aggregatedReads || meta.reads || [];
        const writes = meta._aggregatedWrites || meta.writes || [];
        reads.forEach(v => variables.add(v));
        writes.forEach(v => variables.add(v));
    });
    
    // Remove common noise
    const skip = new Set(['True', 'False', 'None', 'self', 'cls', 'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'type', 'super', 'isinstance', 'hasattr', 'getattr', 'setattr']);
    
    const sorted = [...variables].filter(v => !skip.has(v)).sort();
    
    // Header
    const header = document.createElement('div');
    header.className = 'sidebar-header';
    header.textContent = 'Variables';
    container.appendChild(header);
    
    // Variable entries
    sorted.forEach(varName => {
        const entry = document.createElement('div');
        entry.className = 'sidebar-variable';
        if (state.selectedVariable === varName) {
            entry.classList.add('selected');
        }
        entry.style.color = getVariableColor(varName);
        entry.textContent = varName;
        
        entry.addEventListener('mouseenter', () => {
            state.selectedVariable = varName;
            state.hoveredNodeId = null;
            rerender();
        });
        
        entry.addEventListener('mouseleave', () => {
            state.selectedVariable = null;
            rerender();
        });
        
        entry.addEventListener('click', (e) => {
            e.stopPropagation();
            state.selectedVariable = state.selectedVariable === varName ? null : varName;
            state.hoveredNodeId = null;
            rerender();
        });
        
        container.appendChild(entry);
    });
}

// Import this from edgeRenderer.js or share via a common module
function getVariableColor(varName) {
    const VARIABLE_COLORS = [
        '#22d3ee', '#f97316', '#a78bfa', '#34d399', '#fbbf24',
        '#f472b6', '#38bdf8', '#fb923c', '#e879f9', '#a3e635'
    ];
    let hash = 0;
    for (let i = 0; i < varName.length; i++) {
        hash = ((hash << 5) - hash + varName.charCodeAt(i)) | 0;
    }
    return VARIABLE_COLORS[Math.abs(hash) % VARIABLE_COLORS.length];
}
```

#### 4.6 Code panel renderer (the line-by-line view)

```javascript
/**
 * Render the code panel: line numbers, indented code, scope toggles.
 */

export function renderCodePanel(container, visibleNodes, state, allEdges, activeEdges, rerender) {
    container.innerHTML = '';
    
    // Determine connected nodes for dimming
    const connectedNodes = new Set();
    if (state.hoveredNodeId) connectedNodes.add(state.hoveredNodeId);
    if (state.selectedVariable) {
        // All nodes that read or write the selected variable
        visibleNodes.forEach(n => {
            const meta = n.metadata;
            if (!meta) return;
            const r = meta._aggregatedReads || meta.reads || [];
            const w = meta._aggregatedWrites || meta.writes || [];
            if (r.includes(state.selectedVariable) || w.includes(state.selectedVariable)) {
                connectedNodes.add(n.id);
            }
        });
    }
    activeEdges.forEach(e => {
        connectedNodes.add(e.from);
        connectedNodes.add(e.to);
    });
    
    const hasFocus = state.hoveredNodeId || state.selectedVariable;
    
    visibleNodes.forEach(node => {
        const meta = node.metadata || {};
        const line = document.createElement('div');
        line.className = 'dataflow-line';
        line.setAttribute('data-node-id', node.id);
        
        // Dimming
        if (hasFocus && !connectedNodes.has(node.id) && node.kind !== 'blank' && node.kind !== 'comment') {
            line.classList.add('dimmed');
        }
        
        // Hover highlight
        if (state.hoveredNodeId === node.id) {
            line.classList.add('hovered');
        }
        
        // --- Line number ---
        const lineNum = document.createElement('span');
        lineNum.className = 'line-number';
        lineNum.textContent = meta.line || '';
        line.appendChild(lineNum);
        
        // --- Collapse toggle (for scope headers) ---
        const toggle = document.createElement('span');
        toggle.className = 'scope-toggle';
        if (meta.groupRole === 'start') {
            const isCollapsed = meta._isCollapsed || state.collapsedGroups.has(meta.groupId);
            toggle.textContent = isCollapsed ? '\u25B6' : '\u25BC';
            toggle.classList.add('clickable');
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.collapsedGroups.has(meta.groupId)) {
                    state.collapsedGroups.delete(meta.groupId);
                } else {
                    state.collapsedGroups.add(meta.groupId);
                }
                rerender();
            });
        }
        line.appendChild(toggle);
        
        // --- Indentation ---
        const indent = document.createElement('span');
        indent.className = 'indent';
        indent.style.width = (meta.depth || 0) * 24 + 'px';
        line.appendChild(indent);
        
        // --- Code text ---
        const code = document.createElement('span');
        code.className = 'code-text';
        code.textContent = (meta.code || '').trimStart();
        // Apply kind-based color class
        code.classList.add(`kind-${node.kind}`);
        line.appendChild(code);
        
        // --- Collapsed summary ---
        if (meta._isCollapsed && meta.summary) {
            const summary = document.createElement('span');
            summary.className = 'collapsed-summary';
            summary.textContent = `  ${meta.summary} (${meta._descendantCount || '?'} lines)`;
            line.appendChild(summary);
        }
        
        // --- Hover handlers ---
        line.addEventListener('mouseenter', () => {
            state.hoveredNodeId = node.id;
            state.selectedVariable = null;
            rerender();
        });
        line.addEventListener('mouseleave', () => {
            state.hoveredNodeId = null;
            rerender();
        });
        
        container.appendChild(line);
    });
}
```

#### 4.7 CSS styles

Add to `webview/styles.css` (or a new `dataflow.css` loaded alongside):

```css
/* ── Dataflow View ── */

.dataflow-wrapper {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    min-height: 100vh;
}

.dataflow-main {
    display: flex;
    gap: 16px;
    padding: 0 12px;
}

.dataflow-code-panel {
    flex: 1;
    position: relative;
    padding-right: 160px; /* space for edge lanes */
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    overflow: hidden;
}

.dataflow-line {
    display: flex;
    align-items: center;
    min-height: 24px;
    padding: 0 8px 0 0;
    transition: opacity 0.1s, background 0.1s;
    cursor: default;
}

.dataflow-line.hovered {
    background: var(--vscode-list-hoverBackground);
}

.dataflow-line.dimmed {
    opacity: 0.3;
}

.line-number {
    width: 36px;
    text-align: right;
    padding-right: 10px;
    color: var(--vscode-editorLineNumber-foreground);
    font-size: 11px;
    flex-shrink: 0;
    user-select: none;
}

.scope-toggle {
    width: 14px;
    font-size: 9px;
    text-align: center;
    flex-shrink: 0;
    user-select: none;
    opacity: 0.5;
}

.scope-toggle.clickable {
    cursor: pointer;
    opacity: 0.8;
}

.scope-toggle.clickable:hover {
    opacity: 1;
}

.indent {
    flex-shrink: 0;
}

.code-text {
    white-space: pre;
}

.kind-comment { color: var(--vscode-editorLineNumber-foreground); }
.kind-branch { color: var(--vscode-symbolIcon-enumeratorForeground, #d19a66); }
.kind-loop { color: var(--vscode-symbolIcon-enumeratorForeground, #61afef); }
.kind-return { color: var(--vscode-symbolIcon-keywordForeground, #c678dd); }
.kind-import { color: var(--vscode-editorLineNumber-foreground); }

.collapsed-summary {
    color: var(--vscode-editorLineNumber-foreground);
    font-style: italic;
    font-size: 11px;
}

/* ── Sidebar ── */

.dataflow-sidebar {
    width: 120px;
    flex-shrink: 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    align-self: flex-start;
    position: sticky;
    top: 12px;
}

.sidebar-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-editorLineNumber-foreground);
    margin-bottom: 8px;
}

.sidebar-variable {
    padding: 2px 6px;
    margin-bottom: 2px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: background 0.1s;
}

.sidebar-variable:hover {
    background: rgba(255, 255, 255, 0.05);
}

.sidebar-variable.selected {
    background: rgba(255, 255, 255, 0.1);
    outline: 1px solid currentColor;
    outline-offset: -1px;
}

/* ── Toolbar ── */

.dataflow-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-wrap: wrap;
}

.dataflow-toolbar button {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    padding: 2px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
}

.dataflow-toolbar button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.dataflow-toolbar label {
    font-size: 11px;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
}
```

---

### Step 5: Build toolbar and integrate controls

#### 5.1 Toolbar builder

```javascript
function buildToolbar(state, rerender) {
    const toolbar = document.createElement('div');
    toolbar.className = 'dataflow-toolbar';
    
    // Expand all
    const expandBtn = document.createElement('button');
    expandBtn.textContent = 'Expand all';
    expandBtn.addEventListener('click', () => {
        state.collapsedGroups.clear();
        rerender();
    });
    toolbar.appendChild(expandBtn);
    
    // Collapse all
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = 'Collapse all';
    collapseBtn.addEventListener('click', () => {
        state.nodes.forEach(n => {
            if (n.metadata?.groupRole === 'start' && n.metadata?.groupId !== 'func-body') {
                state.collapsedGroups.add(n.metadata.groupId);
            }
        });
        rerender();
    });
    toolbar.appendChild(collapseBtn);
    
    // Show all edges toggle
    const edgeLabel = document.createElement('label');
    const edgeCheck = document.createElement('input');
    edgeCheck.type = 'checkbox';
    edgeCheck.checked = state.showAllEdges;
    edgeCheck.addEventListener('change', () => {
        state.showAllEdges = edgeCheck.checked;
        rerender();
    });
    edgeLabel.appendChild(edgeCheck);
    edgeLabel.appendChild(document.createTextNode(' Show all edges'));
    toolbar.appendChild(edgeLabel);
    
    // Show control flow toggle
    const cfLabel = document.createElement('label');
    const cfCheck = document.createElement('input');
    cfCheck.type = 'checkbox';
    cfCheck.checked = state.showControlFlow;
    cfCheck.addEventListener('change', () => {
        state.showControlFlow = cfCheck.checked;
        rerender();
    });
    cfLabel.appendChild(cfCheck);
    cfLabel.appendChild(document.createTextNode(' Control flow'));
    toolbar.appendChild(cfLabel);
    
    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    toolbar.appendChild(spacer);
    
    // Refresh button (reuse existing refresh mechanism)
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', () => {
        // Post message to host requesting refresh
        if (typeof acquireVsCodeApi !== 'undefined') {
            const vscode = acquireVsCodeApi();
            vscode.postMessage({ type: 'requestRefresh' });
        }
    });
    toolbar.appendChild(refreshBtn);
    
    return toolbar;
}
```

---

## File Checklist

| File | Action | Description |
|------|--------|-------------|
| `python/dataflow.py` | CREATE | New Python adapter for data-flow analysis |
| `src/python/analysis/pythonRunner.ts` | EDIT | Add `buildDataflowFor()` function |
| `src/extension.ts` | EDIT | Register `codemap.showDataflow` command |
| `package.json` | EDIT | Add command definition and menu entry |
| `webview/main.js` | EDIT | Add `case 'dataflow'` dispatch |
| `webview/views/dataflow/dataflowView.js` | CREATE | Main renderer |
| `webview/views/dataflow/edgeDerivation.js` | CREATE | Edge derivation algorithm |
| `webview/views/dataflow/edgeRenderer.js` | CREATE | SVG arc rendering |
| `webview/views/dataflow/variableSidebar.js` | CREATE | Variable sidebar panel |
| `webview/styles.css` | EDIT | Add dataflow CSS (or create dataflow.css) |
| `test_samples/sample1.py` | CREATE | Test sample file |

## Files NOT modified

| File | Reason |
|------|--------|
| `src/python/model/graphTypes.ts` | No changes needed. Level 2 data lives in metadata. |
| `src/python/model/symbolTypes.ts` | No changes needed. Level 1 symbols unchanged. |
| `python/analyzer.py` | No changes needed. Level 1 analysis unchanged. |
| `python/flowchart.py` | No changes needed. Existing flowchart view unchanged. |
| `webview/views/flowchart/flowchartView.js` | No changes. Existing flowchart renderer untouched. |
| `webview/views/callgraph/callGraphView.js` | No changes. Existing call graph renderer untouched. |
| `src/providers/graphWebviewProvider.ts` | No changes needed unless CSP or resource roots need updating for new files. |

---

## Testing Sequence

1. **Unit test dataflow.py**: Run against sample1.py, verify reads/writes per line match expected values.
2. **Integration test**: Trigger `codemap.showDataflow` from VS Code on sample1.py, verify GraphDocument arrives in webview.
3. **Visual test**: Verify code panel renders with line numbers, indentation, syntax coloring.
4. **Edge test**: Hover a line → verify correct edges highlight. Hover a variable in sidebar → verify all its edges highlight.
5. **Collapse test**: Click a scope header → verify children vanish, edges reroute to collapsed header, summary appears.
6. **Expand test**: Click collapsed header → verify children reappear, edges revert to original routing.
7. **Edge case**: Test with empty function, function with no variables, function with only comments, deeply nested function (4+ levels), function with augmented assignment, function with walrus operator, function with unpacking assignment.

---

## Future Extensions (out of scope for this implementation)

- Syntax highlighting using a proper tokenizer instead of kind-based CSS classes
- Layout persistence in localStorage (same pattern as existing flowchart)
- Debug sync integration (highlight current line during debugging)
- Dual view mode: show flowchart and dataflow side by side
- Call site drill-down: double-click a call to show callee's dataflow
- SSA phi nodes at branch join points (requires control flow graph analysis)