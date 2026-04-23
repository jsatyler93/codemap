# CodeMap — Surgical Debug Overlay: Implementation Plan

This document describes how to build a Copilot-driven surgical debugging layer on top
of CodeMap's existing call graphs and flowcharts. The agent understands the full
codebase context (call graph, flowcharts, docstrings, type metadata, narration scripts)
and generates on-the-spot debug probes — plots, prints, assertions — that are
superimposed as live visual widgets directly on graph nodes and breakpoints.

The UI layer couples **React Flow** (existing, already in CodeMap) with
**LiteGraph.js** (https://github.com/jagenjo/litegraph.js) for the agent-generated
widget canvas. React Flow owns the graph structure and node layout. LiteGraph owns the
debug widget surface that floats on top of it.

---

## Concept in One Paragraph

When the debugger hits a breakpoint on a node, the agent receives the full context of
that node: its position in the call graph, its flowchart structure, its docstring, its
parameter types, the current live variable values from DAP, and the narration already
generated for it. From that context it produces a `DebugProbe` — a self-contained
Python snippet that, when injected and executed at the breakpoint, captures specific
variables and returns structured data (arrays, scalars, dicts). The host injects the
snippet via the VS Code debug adapter, receives the result, and posts it to the
webview. The webview renders a LiteGraph widget — a plot, a heatmap, a histogram, a
variable table — pinned as an overlay directly on the React Flow node that owns that
breakpoint. The widget stays live and updates on every subsequent hit of the same
breakpoint.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Extension Host (TypeScript)                                                │
│                                                                             │
│  DebugProbeAgent          DebugInjector           ProbeResultStore          │
│  ├─ builds context        ├─ injects snippet      ├─ caches results         │
│  ├─ calls vscode.lm       ├─ via DAP evaluate     ├─ keyed by nodeId+hit    │
│  └─ returns DebugProbe    └─ returns raw result   └─ posted to webview      │
└────────────────────┬──────────────────────────────────────┬─────────────────┘
                     │  postMessage: setDebugProbe           │  postMessage: probeResult
                     ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Webview                                                                    │
│                                                                             │
│  React Flow layer (existing)          LiteGraph overlay layer (new)         │
│  ├─ call graph nodes                  ├─ LGraph canvas, transparent bg      │
│  ├─ flowchart nodes                   ├─ DebugWidgetNode per probe           │
│  ├─ breakpoint highlights             ├─ anchored to React Flow node coords  │
│  └─ runtime highlights                └─ plot / table / histogram widgets   │
└─────────────────────────────────────────────────────────────────────────────┘
```

React Flow and LiteGraph share the same coordinate space. The LiteGraph canvas is an
absolutely-positioned `<canvas>` element overlaid on the React Flow `<div>`. When React
Flow pans or zooms, the LiteGraph canvas transforms are kept in sync via a shared
viewport state object.

---

## New Files to Create

```
src/
  debug/
    debugProbeAgent.ts       ← Copilot context builder + probe generator
    debugInjector.ts         ← DAP evaluate injector + result parser
    probeResultStore.ts      ← per-node result cache, posts to webview
    probeContextBuilder.ts   ← assembles node context for the agent prompt

webview/
  views/
    debugOverlay/
      overlayManager.js      ← mounts LiteGraph canvas, syncs viewport
      debugWidgetNode.js     ← LiteGraph custom node: base widget class
      widgets/
        plotWidget.js        ← line / scatter plot (uses Chart.js or Plotly)
        heatmapWidget.js     ← 2D array heatmap
        histogramWidget.js   ← scalar distribution
        tableWidget.js       ← variable key-value table
        tensorWidget.js      ← shape + stats summary for NDArrays
      probePanel.js          ← sidebar panel listing active probes
```

---

## Data Types

### `DebugProbe` (produced by agent, lives on host)

```typescript
interface DebugProbe {
  id: string;                    // stable id: nodeId + probeIndex
  nodeId: string;                // the React Flow node this probe targets
  breakpointFile: string;
  breakpointLine: number;
  snippetPython: string;         // the Python snippet to inject at the breakpoint
  expectedOutputSchema: ProbeOutputSchema;  // describes what the snippet returns
  widgetSpec: WidgetSpec;        // describes how to render the result
  label: string;                 // human-readable probe title
  rationale: string;             // one sentence: why this probe is useful here
  generatedAt: number;
}
```

### `ProbeOutputSchema`

```typescript
type ProbeOutputSchema =
  | { kind: 'scalar';  type: 'float' | 'int' | 'bool' }
  | { kind: 'array1d'; dtype: string; expectedLength?: number }
  | { kind: 'array2d'; dtype: string; shape?: [number, number] }
  | { kind: 'dict';    keys: string[] }
  | { kind: 'string' }
```

### `WidgetSpec`

```typescript
type WidgetSpec =
  | { type: 'plot';      title: string; xLabel?: string; yLabel?: string }
  | { type: 'heatmap';   title: string; colormap?: string }
  | { type: 'histogram'; title: string; bins?: number }
  | { type: 'table';     title: string; columns: string[] }
  | { type: 'tensor';    title: string }   // shape + min/max/mean/std summary
```

### `ProbeResult` (returned after injection, posted to webview)

```typescript
interface ProbeResult {
  probeId: string;
  nodeId: string;
  hitCount: number;
  timestamp: number;
  data: any;        // the parsed return value of the injected snippet
  error?: string;   // if the snippet threw
}
```

---

## Phase 1 — Probe Context Builder (`src/debug/probeContextBuilder.ts`)

Before calling Copilot, the context builder assembles everything the agent needs to
know about the node being hit. It pulls from all existing CodeMap data sources.

```typescript
export function buildProbeContext(
  node: GraphNode,
  runtimeFrame: RuntimeFrame,
  narrationScript: NarrationScript | null,
  graph: GraphDocument
): string
```

Output format fed to Copilot:

```
BREAKPOINT HIT — generate_phase_screens()
File: optics/phase_screen.py  Line: 87
Node kind: process
Call graph position: called by run_simulation(), calls _apply_subharmonics()

SYMBOL METADATA:
  signature: generate_phase_screens(r0: float, L0: float, N: int, dx: float) -> NDArray[complex128]
  docstring: "Sinc-method phase screen generator per Cubillos & Luna 2024.
              Generates a single frozen-flow phase screen with correct
              Kolmogorov statistics up to outer scale L0."
  return type: NDArray[complex128]
  module: optics.phase_screen

LIVE VARIABLES AT THIS FRAME (from DAP):
  r0       float     0.12
  L0       float     25.0
  N        int       512
  dx       float     0.01
  freq     NDArray   shape=(512, 512) dtype=float64   [not yet populated]
  screen   NDArray   shape=(512, 512) dtype=complex128 [partially computed]

NARRATION FOR THIS STEP:
  "Generates a 512×512 complex phase screen using the sinc interpolation
   method, enforcing Kolmogorov PSD with r0=0.12m and outer scale L0=25m."

CALLEE CONTEXT (what this node calls next):
  → _apply_subharmonics(): "Adds low-frequency energy via subharmonic
                             compensation to correct spectral undersampling"
```

---

## Phase 2 — Debug Probe Agent (`src/debug/debugProbeAgent.ts`)

Calls Copilot via `vscode.lm` with the context above and a structured system prompt.
Returns an array of `DebugProbe` objects (typically 2–4 probes per node).

### System prompt

```
You are a surgical debugging assistant for scientific Python code. You will receive:
- The function signature, docstring, and type metadata
- The current live variable values from the debugger
- The function's position in the call graph
- A plain-English narration of what this function does

Your job is to generate 2-4 targeted debug probes. Each probe is a small Python
snippet (max 8 lines) that captures the most diagnostically useful information at
this exact point in execution.

Rules for snippets:
- Must be a single expression or a block that ends with a dict literal result
- Must not have side effects (no assignment to existing variables, no prints)
- Must return a JSON-serialisable structure: scalars, lists, or dicts of scalars/lists
- For NDArrays: return shape, dtype, min, max, mean, std — not the raw array
- For complex arrays: return separate real and imaginary statistics
- For 2D arrays that are physically meaningful (images, PSFs, phase screens): return a
  downsampled 32×32 version as a nested list for heatmap display

For each probe also provide:
- "label": short title (max 5 words)
- "rationale": one sentence explaining diagnostic value
- "widgetSpec": how to render the result (plot/heatmap/histogram/table/tensor)
- "expectedOutputSchema": the shape/type of the returned data

Return only a JSON array of probe objects. No markdown fences. No preamble.
```

### Probe examples Copilot might generate

For `generate_phase_screens` hitting at line 87 with `screen` partially filled:

```json
[
  {
    "label": "Phase screen PSD",
    "rationale": "Verify the generated screen has correct Kolmogorov power spectrum slope",
    "snippetPython": "import numpy as np\npsd = np.abs(np.fft.fftshift(np.fft.fft2(screen.real)))**2\nfreqs = np.fft.fftshift(np.fft.fftfreq(screen.shape[0], d=dx))\n{'psd_slice': psd[256, :].tolist(), 'freqs': freqs.tolist()}",
    "widgetSpec": { "type": "plot", "title": "PSD slice", "xLabel": "freq (1/m)", "yLabel": "power" },
    "expectedOutputSchema": { "kind": "dict", "keys": ["psd_slice", "freqs"] }
  },
  {
    "label": "Screen heatmap",
    "rationale": "Visual check for spatial structure and absence of numerical artefacts",
    "snippetPython": "import numpy as np\nds = screen.real[::16, ::16]\n{'heatmap': ds.tolist(), 'min': float(ds.min()), 'max': float(ds.max())}",
    "widgetSpec": { "type": "heatmap", "title": "Phase screen (real, downsampled)", "colormap": "RdBu" },
    "expectedOutputSchema": { "kind": "array2d", "dtype": "float64", "shape": [32, 32] }
  },
  {
    "label": "r0 / L0 stats",
    "rationale": "Confirm input parameters are within physically valid ranges",
    "snippetPython": "{'r0': float(r0), 'L0': float(L0), 'N': int(N), 'dx': float(dx), 'sampling_ratio': float(r0/dx)}",
    "widgetSpec": { "type": "table", "title": "Input parameters", "columns": ["parameter", "value"] },
    "expectedOutputSchema": { "kind": "dict", "keys": ["r0", "L0", "N", "dx", "sampling_ratio"] }
  }
]
```

---

## Phase 3 — Debug Injector (`src/debug/debugInjector.ts`)

Injects the snippet Python into the live debug session and retrieves the result.

### Injection via DAP evaluate

```typescript
export async function injectProbe(
  probe: DebugProbe,
  frameId: number,
  session: vscode.DebugSession
): Promise<ProbeResult> {

  // Wrap the snippet in a try/except that always returns a JSON string
  const wrapped = wrapSnippet(probe.snippetPython);

  const response = await session.customRequest('evaluate', {
    expression: wrapped,
    frameId: frameId,
    context: 'repl'
  });

  return parseResult(probe, response.result);
}
```

### Snippet wrapper

The wrapper ensures the snippet never crashes the debug session and always returns
parseable output:

```python
# Template applied around every agent-generated snippet
__import__('json').dumps((lambda: {SNIPPET})())
```

For multi-line snippets:

```python
__import__('json').dumps(
  (lambda: exec(compile('''{ESCAPED_SNIPPET}''', '<probe>', 'exec'), _env := {}, _env) or _env.get('__result__'))()
)
```

### Result parsing

```typescript
function parseResult(probe: DebugProbe, raw: string): ProbeResult {
  // raw is a JSON string returned by the evaluate call
  const cleaned = raw.replace(/^'|'$/g, '');  // strip Python string quotes
  try {
    const data = JSON.parse(cleaned);
    return { probeId: probe.id, nodeId: probe.nodeId, data, hitCount: 1, timestamp: Date.now() };
  } catch {
    return { probeId: probe.id, nodeId: probe.nodeId, data: null,
             error: `Parse failed: ${raw.slice(0, 200)}`, hitCount: 1, timestamp: Date.now() };
  }
}
```

---

## Phase 4 — Overlay Manager (`webview/views/debugOverlay/overlayManager.js`)

This is the most novel piece of the system. It mounts a LiteGraph canvas as a
transparent overlay on top of the React Flow canvas and keeps the two in sync.

### DOM setup

```javascript
// Called once after React Flow mounts
function mountOverlay(reactFlowContainer) {
  const canvas = document.createElement('canvas');
  canvas.id = 'litegraph-overlay';
  canvas.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;   /* pass clicks through to React Flow by default */
    z-index: 10;
  `;
  reactFlowContainer.appendChild(canvas);

  const graph = new LGraph();
  const graphCanvas = new LGraphCanvas(canvas, graph);
  graphCanvas.background_image = null;    // transparent background
  graphCanvas.clear_background = false;   // do not fill background
  graphCanvas.render_shadows = false;

  return { graph, graphCanvas };
}
```

`pointer-events: none` means clicks pass through to React Flow nodes normally. When
the user clicks directly on a LiteGraph widget node, the overlay manager temporarily
sets `pointer-events: auto` to allow widget interaction.

### Viewport sync

React Flow exposes its viewport via `useReactFlow().getViewport()`. When the user pans
or zooms React Flow, mirror the transform onto the LiteGraph canvas:

```javascript
// Called on every React Flow viewport change event
function syncViewport(rfViewport, graphCanvas) {
  graphCanvas.ds.offset[0] = rfViewport.x;
  graphCanvas.ds.offset[1] = rfViewport.y;
  graphCanvas.ds.scale     = rfViewport.zoom;
  graphCanvas.setDirty(true, true);
}
```

### Anchoring widget nodes to React Flow nodes

Each debug widget node in LiteGraph is positioned at the screen coordinates of the
React Flow node it belongs to:

```javascript
function anchorWidgetToNode(lgNode, rfNodeId, graphCanvas) {
  // Get React Flow node position in flow coordinates
  const rfNode = reactFlowInstance.getNode(rfNodeId);
  const { x, y } = rfNode.position;

  // Offset the LiteGraph node to sit below/right of the RF node
  lgNode.pos = [x + rfNode.width + 20, y];
  graphCanvas.setDirty(true);
}
```

On every React Flow `onNodesChange` event, re-anchor all active widget nodes.

---

## Phase 5 — Debug Widget Nodes (`webview/views/debugOverlay/debugWidgetNode.js`)

Each probe result is rendered as a custom LiteGraph node. LiteGraph's custom node API:

```javascript
class DebugWidgetNode extends LGraphNode {
  constructor() {
    super();
    this.title = 'Debug Probe';
    this.size  = [300, 200];
    this.resizable = true;
    this.addInput('data', 'object');
  }

  onDrawForeground(ctx) {
    // ctx is a 2D canvas context — draw whatever you want here
    this.renderWidget(ctx);
  }

  renderWidget(ctx) {
    // Subclasses override this
  }
}

LiteGraph.registerNodeType('debug/widget', DebugWidgetNode);
```

### Plot widget

```javascript
class PlotWidget extends DebugWidgetNode {
  renderWidget(ctx) {
    const { data, spec } = this;
    if (!data?.psd_slice) return;

    const w = this.size[0] - 20;
    const h = this.size[1] - 40;
    const xs = data.freqs ?? data.psd_slice.map((_, i) => i);
    const ys = data.psd_slice;

    // Normalize to widget bounds
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const px = v => 10 + ((v - xMin) / (xMax - xMin)) * w;
    const py = v => 35 + h - ((v - yMin) / (yMax - yMin)) * h;

    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ys.forEach((y, i) => i === 0 ? ctx.moveTo(px(xs[i]), py(y)) : ctx.lineTo(px(xs[i]), py(y)));
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.fillText(spec.xLabel ?? '', this.size[0] / 2, this.size[1] - 4);
  }
}
LiteGraph.registerNodeType('debug/plot', PlotWidget);
```

### Heatmap widget

```javascript
class HeatmapWidget extends DebugWidgetNode {
  renderWidget(ctx) {
    const matrix = this.data?.heatmap;
    if (!matrix) return;
    const rows = matrix.length, cols = matrix[0].length;
    const all = matrix.flat();
    const vMin = Math.min(...all), vMax = Math.max(...all);
    const cw = (this.size[0] - 20) / cols;
    const ch = (this.size[1] - 40) / rows;

    matrix.forEach((row, r) => row.forEach((v, c) => {
      const t = (v - vMin) / (vMax - vMin);
      ctx.fillStyle = rdbu(t);   // rdbu() maps 0→red, 0.5→white, 1→blue
      ctx.fillRect(10 + c * cw, 35 + r * ch, cw, ch);
    }));
  }
}
LiteGraph.registerNodeType('debug/heatmap', HeatmapWidget);
```

### Histogram widget

For scalar distributions, the snippet returns a flat array. The widget bins it:

```javascript
class HistogramWidget extends DebugWidgetNode {
  renderWidget(ctx) {
    const values = this.data?.values;
    if (!values) return;
    const bins = 20;
    const min = Math.min(...values), max = Math.max(...values);
    const counts = new Array(bins).fill(0);
    values.forEach(v => { const b = Math.min(bins-1, Math.floor((v-min)/(max-min)*bins)); counts[b]++; });
    const maxCount = Math.max(...counts);
    const bw = (this.size[0] - 20) / bins;
    counts.forEach((c, i) => {
      const h = (c / maxCount) * (this.size[1] - 50);
      ctx.fillStyle = '#a78bfa';
      ctx.fillRect(10 + i * bw, this.size[1] - 15 - h, bw - 1, h);
    });
  }
}
LiteGraph.registerNodeType('debug/histogram', HistogramWidget);
```

### Table widget

Variable key-value pairs rendered as a compact grid:

```javascript
class TableWidget extends DebugWidgetNode {
  renderWidget(ctx) {
    const data = this.data;
    if (!data) return;
    ctx.font = '11px monospace';
    let y = 40;
    Object.entries(data).forEach(([k, v]) => {
      ctx.fillStyle = '#60a5fa';
      ctx.fillText(k, 10, y);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(String(v).slice(0, 30), 120, y);
      y += 16;
    });
  }
}
LiteGraph.registerNodeType('debug/table', TableWidget);
```

---

## Phase 6 — Message Protocol (Host ↔ Webview)

Add to the existing webview message handler in `main.js`:

```javascript
case 'setDebugProbes':
  // Agent has generated probes for a node — pre-create widgets without data
  overlayManager.registerProbes(message.probes);
  break;

case 'probeResult':
  // Injection returned data — update the widget with live values
  overlayManager.updateProbe(message.result);
  break;

case 'clearDebugProbes':
  // Breakpoint removed or node changed — remove widgets
  overlayManager.clearProbes(message.nodeId);
  break;

case 'highlightProbeNode':
  // Flash the anchor React Flow node to show a probe just updated
  overlayManager.flashNode(message.nodeId);
  break;
```

### Webview → host messages

```javascript
// User clicks "Regenerate probes" button on a widget node
vscode.postMessage({ type: 'regenerateProbes', nodeId });

// User dismisses a specific probe widget
vscode.postMessage({ type: 'dismissProbe', probeId });

// User requests a new probe by typing a natural language question
vscode.postMessage({ type: 'requestProbe', nodeId, question: "show the phase PSD" });
```

---

## Phase 7 — Host Orchestration (`src/extension.ts` additions)

### On breakpoint hit

```typescript
debugSyncService.on('frameChanged', async (frame: RuntimeFrame) => {
  const hitNode = findGraphNodeByLocation(frame, lastGraph);
  if (!hitNode) return;

  // 1. Build context
  const context = buildProbeContext(hitNode, frame, cachedNarration, lastGraph);

  // 2. Generate probes (cached per nodeId unless user requests regeneration)
  const probes = await getCachedOrGenerateProbes(hitNode.id, context, cancellationToken);

  // 3. Send probe specs to webview so widgets appear immediately (empty)
  graphProvider.postMessage({ type: 'setDebugProbes', probes });

  // 4. Inject each probe and send results as they come back
  for (const probe of probes) {
    injectProbe(probe, frame.frameId, debugSession)
      .then(result => graphProvider.postMessage({ type: 'probeResult', result }))
      .catch(err  => console.error(`[CodeMap] Probe injection failed: ${err}`));
  }
});
```

### On user question

```typescript
vscode.commands.registerCommand('codemap.askProbe', async () => {
  const question = await vscode.window.showInputBox({
    prompt: 'What do you want to inspect at this breakpoint?',
    placeHolder: 'e.g. "show the PSF radial profile" or "histogram of phase values"'
  });
  if (!question || !lastHitNode) return;

  const context = buildProbeContext(lastHitNode, lastFrame, cachedNarration, lastGraph);
  const probe = await generateSingleProbe(context, question, cancellationToken);

  graphProvider.postMessage({ type: 'setDebugProbes', probes: [probe] });
  const result = await injectProbe(probe, lastFrame.frameId, activeSession);
  graphProvider.postMessage({ type: 'probeResult', result });
});
```

---

## Phase 8 — Probe Panel (`webview/views/debugOverlay/probePanel.js`)

A sidebar panel listing all active probes for the current debug session. Acts as a
table of contents for the overlay — clicking a probe entry scrolls the graph to the
owning node and brings its widget to the front.

Each row shows:
- probe label
- owning function name
- last hit time
- a mini-status: green tick (data OK), red X (injection error), spinner (pending)
- a dismiss button
- a "re-run" button that forces re-injection without regenerating the snippet

---

## Phase 9 — New Commands

```typescript
// package.json contributions
{
  "command": "codemap.generateProbes",
  "title": "CodeMap: Generate Debug Probes at Breakpoint"
},
{
  "command": "codemap.askProbe",
  "title": "CodeMap: Ask a Debug Question at This Point"
},
{
  "command": "codemap.clearProbes",
  "title": "CodeMap: Clear All Debug Probes"
},
{
  "command": "codemap.exportProbes",
  "title": "CodeMap: Export Debug Probes as Python Script"
}
```

### Export probes as Python script

The export command writes all active probes as standalone Python debug helpers that
can be pasted directly into a REPL or notebook:

```python
# CodeMap Debug Probes — generated 2026-04-23
# Function: generate_phase_screens  [optics/phase_screen.py:87]

# Probe 1: Phase screen PSD
import numpy as np
psd = np.abs(np.fft.fftshift(np.fft.fft2(screen.real)))**2
freqs = np.fft.fftshift(np.fft.fftfreq(screen.shape[0], d=dx))
result_psd = {'psd_slice': psd[256, :].tolist(), 'freqs': freqs.tolist()}

# Probe 2: Screen heatmap
ds = screen.real[::16, ::16]
result_heatmap = {'heatmap': ds.tolist(), 'min': float(ds.min()), 'max': float(ds.max())}
```

---

## LiteGraph vs React Flow — Division of Responsibilities

This is the key design decision. Keep the boundary clean.

| Concern | Owner |
|---------|-------|
| Graph structure, nodes, edges | React Flow |
| Node layout, positions, zoom/pan | React Flow |
| Breakpoint highlights, runtime highlights | React Flow |
| Narration chips, annotation chips | React Flow (inside node components) |
| Debug widget rendering (plots, heatmaps) | LiteGraph |
| Widget node position (anchored to RF nodes) | LiteGraph, driven by RF coordinates |
| Widget resize, widget move by user | LiteGraph |
| Widget internal interaction (scroll, click inside) | LiteGraph |
| Pointer events for graph interaction | React Flow (pointer-events passthrough) |

LiteGraph is chosen here specifically because its `onDrawForeground` gives direct
Canvas 2D API access, which is the most efficient way to render plots and heatmaps at
60fps without importing a heavy charting library into the webview bundle. It also has
built-in node resize handles and a clean custom-node registration API that matches the
dynamic "agent generates a widget spec, webview instantiates it" pattern.

---

## Build Order

1. **`probeContextBuilder.ts`** — log the output, verify prompt quality against your
   actual atmospheric optics codebase before wiring anything else.

2. **`debugProbeAgent.ts`** — hardcode a test context string, call `vscode.lm`, log the
   parsed probes JSON. Iterate the system prompt until probe snippets are correct and
   safe (no side effects, return dicts).

3. **`debugInjector.ts`** — test injection with a known-good snippet against a live
   debug session. Confirm the DAP evaluate round-trip works and JSON comes back clean.

4. **`overlayManager.js`** — mount the LiteGraph canvas overlay on the existing React
   Flow container. Verify transparent background and viewport sync with a hardcoded
   dummy node.

5. **`tableWidget.js`** first — it is the simplest widget (no drawing math). Wire the
   full message round-trip: host generates probe → injects → posts result → webview
   renders table widget anchored to the correct RF node.

6. **`plotWidget.js`** — add 1D line plot. Test against a real PSD snippet result from
   your phase screen code.

7. **`heatmapWidget.js`** — add 2D heatmap. Test against a downsampled phase screen
   array.

8. **`probePanel.js`** — add the sidebar probe list. Wire dismiss and re-run buttons.

9. **`codemap.askProbe` command** — natural language question → single probe → inject →
   widget. This is the highest-value UX feature.

10. **`codemap.exportProbes`** — export to Python script for use outside VS Code.

---

## Integration Map (Existing Code → New Code)

| Existing piece | What new code reads from it |
|---|---|
| `RuntimeFrame` from `debugSync.ts` | `frameId` for DAP evaluate, `sourceLocation` for node mapping |
| `findGraphNodeByLocation()` | Maps live frame → `GraphNode` for context builder |
| `node.metadata.docSummary` | Fed into probe context prompt |
| `node.metadata.params` | Fed into probe context prompt (parameter types) |
| `node.metadata.returnType` | Fed into probe context prompt |
| `NarrationScript.steps[n].narration` | Fed into probe context as plain-English description |
| `graph.metadata.execTimeline` | Upstream/downstream context for the agent |
| `vscode.debug` session | DAP evaluate injection target |
| `GraphWebviewProvider.postMessage()` | Delivers probe specs and results to webview |
| React Flow node positions | LiteGraph widget anchor coordinates |
| React Flow viewport events | LiteGraph canvas transform sync |
| Existing breakpoint highlight system | Triggers probe generation on hit |

---

## Safety Rules for Agent-Generated Snippets

These rules are enforced both in the system prompt and by a validation pass in
`debugInjector.ts` before any snippet is sent to DAP evaluate.

The validator rejects snippets that contain any of the following patterns:

```typescript
const BANNED_PATTERNS = [
  /\bimport\s+os\b/,           // no os module
  /\bimport\s+subprocess\b/,   // no subprocess
  /\bopen\s*\(/,               // no file I/O
  /\bexec\s*\(/,               // no dynamic exec (already wrapped by injector)
  /\beval\s*\(/,               // no eval
  /\b__import__\s*\(/,         // no dynamic imports (injector adds its own)
  /\bsocket\b/,                // no network
  /=\s*[^=]/,                  // no assignment (snippets must be read-only)
];
```

The last rule (no assignment) is the most important. Snippets must only read variables,
not mutate them. Any snippet that tries to assign to a variable in the debug frame is
rejected and the agent is asked to regenerate.

---

## Notes on Performance

- Probe generation (Copilot call) is fire-and-forget. The widget appears immediately
  with a spinner, then fills with data when injection completes.
- Injection via DAP evaluate is fast (< 100ms for simple snippets) but blocks the
  debugger briefly. Keep snippets under 8 lines and avoid heavy computation.
- LiteGraph renders on a `requestAnimationFrame` loop. Cap at 30fps for the overlay
  canvas to avoid competing with React Flow's own rendering.
- Probe results are cached per `(probeId, hitCount)`. Repeated hits of the same
  breakpoint show a history timeline in the widget — the user can scrub through
  previous hit results without re-injecting.
- The LiteGraph canvas is only `pointer-events: auto` when the user explicitly enters
  "widget interaction mode" (a toggle button in the toolbar). Otherwise all clicks fall
  through to React Flow.