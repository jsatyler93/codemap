# CodeMap — Copilot Narration Feature: Implementation Plan

This document is a complete implementation plan for coupling CodeMap's call graphs and
flowcharts to GitHub Copilot, producing a narrated "living script" that animates
alongside the execution trace. No external API key is required — the feature runs
entirely on the user's existing Copilot Pro+ subscription via `vscode.lm`.

---

## Architecture Overview

```
User clicks "Narrate"
  └─► webview posts message → extension host
        └─► vscode.lm.selectChatModels()   (Copilot Pro+, no extra cost)
              └─► serialize graph context → build prompt
                    └─► model.sendRequest() → parse JSON response
                          └─► host posts setNarrationScript → webview
                                └─► narration panel animates in sync with execution timeline
```

The Copilot call always happens on the **extension host side** (TypeScript). The webview
only receives the finished narration data and renders it. This is mandatory because
`vscode.lm` is not available inside webview sandboxes.

---

## New Files to Create

```
src/
  ai/
    copilotBridge.ts          ← vscode.lm wrapper, three query types
    graphContextSerializer.ts ← converts GraphDocument → prompt string
    traceScriptGenerator.ts   ← calls bridge, parses response → NarrationScript

webview/
  views/
    narration/
      narrationPanel.js       ← subtitle bar, side panel, tooltip overlay modes
      narrationPanel.css      ← typewriter animation, panel styles
```

---

## Phase 1 — Copilot Bridge (`src/ai/copilotBridge.ts`)

This file is the only place that touches `vscode.lm`. Everything else calls through it.

### Model selection

```typescript
import * as vscode from 'vscode';

async function getModel(): Promise<vscode.LanguageModelChat> {
  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4o'
  });
  if (!models.length) {
    throw new Error('GitHub Copilot is not available. Make sure you are signed in.');
  }
  return models[0];
}
```

No API key. No fetch call. The model object handles authentication transparently.

### Three query entry points

```typescript
// 1. Narrate the full execution trace for a workspace / file call graph
export async function narrateTrace(
  serializedContext: string,
  token: vscode.CancellationToken
): Promise<string>

// 2. Annotate individual nodes in a flowchart
export async function narrateFlowchart(
  serializedContext: string,
  token: vscode.CancellationToken
): Promise<string>

// 3. Narrate a single node on demand (hover / right-click)
export async function narrateNode(
  serializedContext: string,
  token: vscode.CancellationToken
): Promise<string>
```

### Sending a request

```typescript
const messages = [
  vscode.LanguageModelChatMessage.User(systemPrompt),
  vscode.LanguageModelChatMessage.User(serializedContext)
];

const response = await model.sendRequest(messages, {}, token);

let result = '';
for await (const chunk of response.text) {
  result += chunk;
}
return result;
```

### System prompts

**For `narrateTrace`:**
```
You are a code documentation assistant. You will receive a structured summary of a
Python function call graph including function names, docstrings, call order, and type
information. Produce a JSON array called "steps" where each element has:
  - "edgeIndex": integer (0-based, matches the input step order)
  - "narration": a single clear sentence (max 25 words) explaining what that call does
    in the context of the overall pipeline
  - "durationHint": suggested display time in milliseconds (800–2500)
Also produce a top-level "overview" field: one paragraph summarising the entire pipeline.
Return only valid JSON. No markdown fences. No preamble.
```

**For `narrateFlowchart`:**
```
You are a code documentation assistant. You will receive a structured description of
a Python function's control flow including node kinds (decision, loop, process, error)
and any available type or docstring information. For each node produce:
  - "nodeId": the id field from the input
  - "annotation": one sentence explaining what this node does in plain English
Return only a JSON array. No markdown fences. No preamble.
```

---

## Phase 2 — Context Serializer (`src/ai/graphContextSerializer.ts`)

The serializer converts a `GraphDocument` into a compact human-readable string that fits
well inside a Copilot prompt. It deliberately does NOT send raw source code — it sends
the structured metadata that CodeMap has already extracted.

### For a trace / call graph

```typescript
export function serializeTraceContext(
  graph: GraphDocument,
  symbols: Map<string, PySymbol>
): string
```

Output format example:
```
PYTHON CALL GRAPH — atmospheric_sim
Entry: run_simulation()  [sim/main.py:42]
  docstring: "Main simulation entry point for uplink AO scenario"
  returns: None

EXECUTION STEPS (static trace, source order):
  step 0: run_simulation → load_cn2_profile
    callee docstring: "Loads C_n² vertical profile from HV57 model"
    callee returns: NDArray[float64]
    edge resolution: resolved

  step 1: run_simulation → generate_phase_screens
    callee docstring: "Sinc-method phase screen generator per Cubillos 2024"
    callee returns: NDArray[complex128]
    callee params: r0: float, L0: float, N: int, dx: float
    edge resolution: resolved

  step 2: generate_phase_screens → _apply_subharmonics
    callee docstring: "Adds low-frequency energy via subharmonic compensation"
    callee returns: NDArray[complex128]
    edge resolution: likely

GRAPH STATS:
  total nodes: 12 | total edges: 9 | type coverage: 67%
  resolved edges: 7 | likely edges: 2
```

Pull each field from what already exists in the graph:
- `node.metadata.docSummary` → callee docstring lines
- `node.metadata.params` → callee params line
- `node.metadata.returnType` → callee returns line
- `edge.resolution` → edge resolution line
- `graph.metadata.execTimeline` → step ordering

### For a flowchart

```typescript
export function serializeFlowchartContext(graph: GraphDocument): string
```

Output format example:
```
PYTHON FLOWCHART — propagate_field()  [optics/propagation.py:87]
  signature: propagate_field(field: NDArray, layers: list[Layer], dz: float) -> NDArray
  docstring: "Split-step Fresnel propagation through turbulent atmosphere"

NODES (control flow order):
  [entry]     id=entry_0       propagate_field(field, layers, dz)
  [process]   id=proc_1        Initialize output field and phase accumulator
  [loop]      id=loop_2        for layer in layers  (N iterations)
  [decision]  id=dec_3         if layer.cn2 > threshold
  [process]   id=proc_4        apply_phase_screen(field, layer)
  [process]   id=proc_5        fresnel_propagate(field, dz)
  [return]    id=ret_6         return field  → NDArray[complex128]

GROUPS:
  loop body: [proc_4, dec_3, proc_5]
  branch true: [proc_4]
  branch false: (skip)
```

---

## Phase 3 — Script Generator (`src/ai/traceScriptGenerator.ts`)

This is the orchestrator. It calls the serializer, calls the bridge, and parses the
response into a typed `NarrationScript` object.

### Types

```typescript
export interface NarrationScript {
  kind: 'trace' | 'flowchart';
  graphId: string;           // hash of graph title + node count, used as cache key
  overview: string;          // one-paragraph summary of the whole graph
  steps: NarrationStep[];
  generatedAt: number;       // Date.now()
}

export interface NarrationStep {
  // For trace narration:
  edgeIndex?: number;        // maps to execTimeline[edgeIndex]
  fromNodeId?: string;
  toNodeId?: string;

  // For flowchart narration:
  nodeId?: string;

  narration: string;         // the sentence to display
  durationHint: number;      // ms to hold before advancing
}
```

### Generation flow

```typescript
export async function generateTraceScript(
  graph: GraphDocument,
  symbols: Map<string, PySymbol>,
  token: vscode.CancellationToken
): Promise<NarrationScript> {
  const context = serializeTraceContext(graph, symbols);
  const raw = await narrateTrace(context, token);
  const parsed = safeParseJSON(raw);   // strips accidental fences, catches malformed JSON

  return {
    kind: 'trace',
    graphId: computeGraphId(graph),
    overview: parsed.overview ?? '',
    steps: (parsed.steps ?? []).map(mapTraceStep),
    generatedAt: Date.now()
  };
}
```

### JSON parsing safety

Copilot occasionally wraps output in markdown fences despite instructions. Strip them:

```typescript
function safeParseJSON(raw: string): any {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[CodeMap] Narration JSON parse failed. Raw response:', raw);
    return { overview: '', steps: [] };
  }
}
```

### Caching

```typescript
// Key: graphId (hash). Stored in workspaceState.
// Narration is only regenerated when the user explicitly clicks "Regenerate".

const cacheKey = `codemap.narration.${graphId}`;
const cached = context.workspaceState.get<NarrationScript>(cacheKey);
if (cached) return cached;

const script = await generateTraceScript(...);
await context.workspaceState.update(cacheKey, script);
return script;
```

---

## Phase 4 — Webview Narration Panel (`webview/views/narration/`)

### Message protocol (host → webview)

Add to the existing message handler in `webview/main.js`:

```javascript
case 'setNarrationScript':
  narrationPanel.load(message.script);
  break;

case 'advanceNarration':
  narrationPanel.advance(message.stepIndex);
  break;

case 'clearNarration':
  narrationPanel.clear();
  break;
```

### Display modes

The panel supports three modes toggled by a button in the narration panel header:

| Mode | Description |
|------|-------------|
| `subtitle` | Fixed bar at the bottom of the canvas, full width, 2–3 lines max |
| `sidebar` | Right-aligned panel alongside the graph, scrollable, all steps visible |
| `tooltip` | Floating tooltip that moves to the currently active node |

Default is `subtitle`.

### Typewriter animation

Each narration step fades in with a typewriter effect:

```javascript
function typewriterReveal(element, text, msPerChar = 18) {
  element.textContent = '';
  let i = 0;
  const interval = setInterval(() => {
    element.textContent += text[i++];
    if (i >= text.length) clearInterval(interval);
  }, msPerChar);
}
```

### Sync with execution timeline

The narration panel listens to the same step-advance event that drives the particle
animation. When `execTimeline` advances to step N, the panel advances to
`NarrationStep` where `edgeIndex === N`.

```javascript
document.addEventListener('codemap:execStep', (e) => {
  const { stepIndex } = e.detail;
  narrationPanel.advance(stepIndex);
});
```

### Flowchart annotation chips

For flowchart mode, narration does not animate — instead each node gets an annotation
chip rendered below its label. The chip is collapsed by default (shows a `?` icon) and
expands on click:

```javascript
// Injected into each React Flow node component in the flowchart renderer
function AnnotationChip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="annotation-chip" onClick={() => setOpen(!open)}>
      {open ? text : '?'}
    </div>
  );
}
```

The narration text is passed via `node.data.metadata.narration`, which the script
generator writes before the graph is posted to the webview.

### Controls

Add a compact controls bar to the narration panel:

```
[◀ Prev]  [▶ Play / ⏸ Pause]  [Next ▶]  [Speed ▼]  [Mode ▼]  [↻ Regenerate]
```

Play/pause auto-advances through steps using each step's `durationHint`. Speed
multiplier applies to all `durationHint` values (0.5×, 1×, 2×).

---

## Phase 5 — Host-Side Integration in `src/extension.ts`

### New commands to register

```typescript
vscode.commands.registerCommand('codemap.narrateTrace', async () => {
  const graph = graphProvider.lastGraph;
  if (!graph) return;
  const token = new vscode.CancellationTokenSource().token;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CodeMap: Generating narration…' },
    async () => {
      const script = await getCachedOrGenerate(graph, context, token);
      graphProvider.postMessage({ type: 'setNarrationScript', script });
    }
  );
});

vscode.commands.registerCommand('codemap.narrateFlowchart', async () => { /* same pattern */ });

vscode.commands.registerCommand('codemap.exportScript', async () => {
  const script = /* get cached script */;
  const md = renderScriptAsMarkdown(script);
  const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] } });
  if (uri) fs.writeFileSync(uri.fsPath, md);
});
```

### Hook into `buildWorkspaceGraph`

Add an optional auto-narrate setting:

```typescript
// package.json contribution
"codemap.narration.autoGenerate": {
  "type": "boolean",
  "default": false,
  "description": "Automatically generate Copilot narration when a graph is built."
}
```

In `buildWorkspaceGraph`, after posting the graph:

```typescript
if (config.get('narration.autoGenerate')) {
  // fire-and-forget, don't block graph display
  generateAndPostNarration(graph, context).catch(console.error);
}
```

---

## Phase 6 — `package.json` Changes

### Commands

```json
{
  "command": "codemap.narrateTrace",
  "title": "CodeMap: Narrate Execution Trace"
},
{
  "command": "codemap.narrateFlowchart",
  "title": "CodeMap: Annotate Flowchart with Copilot"
},
{
  "command": "codemap.exportScript",
  "title": "CodeMap: Export Narration Script"
}
```

### Extension dependencies

```json
"extensionDependencies": [
  "GitHub.copilot"
]
```

This ensures Copilot is installed and the user gets a clear error if it is not.

### `languageModels` permission (required by VS Code)

```json
"contributes": {
  "languageModels": {}
}
```

Without this entry VS Code will reject `vscode.lm` calls.

---

## Phase 7 — Export: `renderScriptAsMarkdown`

The export command converts the cached `NarrationScript` into a readable `.md` file
that can be used in documentation, presentations, or fed back to an agent.

```typescript
function renderScriptAsMarkdown(script: NarrationScript): string {
  const lines: string[] = [];
  lines.push(`# CodeMap Narration Script`);
  lines.push(`_Generated: ${new Date(script.generatedAt).toISOString()}_\n`);
  lines.push(`## Overview\n\n${script.overview}\n`);
  lines.push(`## Step-by-Step\n`);

  for (const [i, step] of script.steps.entries()) {
    const label = step.fromNodeId
      ? `${step.fromNodeId} → ${step.toNodeId}`
      : step.nodeId ?? `Step ${i}`;
    lines.push(`### ${i + 1}. ${label}`);
    lines.push(`${step.narration}\n`);
  }
  return lines.join('\n');
}
```

---

## Build Order

Work through phases strictly in this order. Each phase is independently testable before
the next begins.

1. **`copilotBridge.ts`** — hardcode a test prompt, `console.log` the response. Confirms
   the `vscode.lm` subscription is working before writing any other code.

2. **`graphContextSerializer.ts`** — call it against a live `GraphDocument` and
   `console.log` the output string. Eyeball the prompt quality. Iterate until the
   serialized context looks like something a reader could understand without seeing the
   code.

3. **`traceScriptGenerator.ts`** — wire bridge + serializer together, log the parsed
   `NarrationScript`. Confirm step count matches `execTimeline` length.

4. **Webview subtitle bar** — the simplest display surface. Hardcode a dummy script,
   confirm the typewriter animation and step-advance sync work before connecting the
   host.

5. **Host command + message round-trip** — wire `codemap.narrateTrace`, post
   `setNarrationScript` to the webview, confirm the live subtitle bar advances with
   the execution timeline.

6. **Flowchart annotation chips** — add `metadata.narration` injection, render chips on
   flowchart nodes.

7. **Caching + regenerate button** — add `workspaceState` caching and the regenerate
   control in the narration panel header.

8. **`exportScript` command** — render to markdown, save dialog.

---

## Integration Map (Existing Code → New Code)

| Existing piece | What the new code reads from it |
|---|---|
| `graph.metadata.execTimeline` | Step ordering and labels for serializer |
| `node.metadata.docSummary` | Callee description lines in trace prompt |
| `node.metadata.params` | Parameter lines in trace prompt |
| `node.metadata.returnType` | Return type lines in trace prompt |
| `edge.resolution` | Edge confidence lines in trace prompt |
| `graph.metadata.moduleColors` | Color-code narration steps by module in sidebar mode |
| `GraphWebviewProvider.show()` | Optionally attach `narrationScript` to graph post |
| `GraphWebviewProvider.postMessage()` | Used directly by `narrateTrace` command |
| `buildWorkspaceGraph()` | Optional auto-narrate hook after graph is built |
| `python/flowchart.py` output | Passed directly to `serializeFlowchartContext` |
| `webview setRuntimeFrame` | Sync live-debug frame position with narration step |
| `workspaceState` | Narration cache keyed by graph hash |

---

## Notes on Copilot Pro+ and Cost

- All calls go through `vscode.lm` which uses the user's existing Copilot Pro+
  subscription. No Anthropic API, no OpenAI API, no extra billing.
- Narration is generated **once per graph** and cached. The cache is only cleared when
  the user explicitly clicks "Regenerate" or when `workspaceState` is cleared.
- `narrateTrace` makes **one** Copilot call per graph (not one per step).
- `narrateFlowchart` makes **one** Copilot call per function.
- `narrateNode` (on-demand hover) makes one call per user request, so use sparingly.

---

## Known Constraints

- `vscode.lm` is only available in VS Code 1.90+ and requires GitHub Copilot to be
  installed and the user to be signed in.
- The model returned by `selectChatModels` may vary (Copilot routes to `gpt-4o` or
  `gpt-4o-mini` depending on load). The narration quality is consistent across both.
- Token limits: the serialized context for a large workspace graph (50+ nodes) can
  approach 2,000 tokens. Stay within this by capping the serializer to the first 30
  timeline steps and truncating docstrings to 80 characters.
- The webview sandbox blocks `vscode.lm` — all AI calls must stay on the extension
  host. Never move `copilotBridge.ts` logic into the webview bundle.