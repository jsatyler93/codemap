import * as vscode from "vscode";
import { resolveNarrationModel } from "../ai/copilotBridge";
import { GraphDocument, GraphNode } from "../python/model/graphTypes";
import { RuntimeFrame } from "../live/debugSync";
import { NarrationScript } from "../ai/narrationTypes";
import { buildProbeContext } from "./probeContextBuilder";
import { DebugProbe, ProbeOutputSchema, WidgetSpec } from "./debugProbeTypes";
import { parseDebugProbeList } from "./probeSchemas";

const SYSTEM_PROMPT = [
  "You are a surgical debugging assistant for Python, JavaScript, and IDL-oriented scientific code.",
  "You will receive function signature, docstring, type metadata, live debugger variables, call position, and optional narration.",
  "Generate 2 to 4 targeted debug probes as JSON array.",
  "Every probe object must include: label, rationale, snippetPython, widgetSpec, expectedOutputSchema.",
  "Snippets must be read-only, must not print, must not perform file or network IO, and must end with a JSON-serializable result expression.",
  "Prefer compact summaries over raw arrays. For multidimensional arrays, prefer shape and statistics or a downsampled heatmap.",
  "For rich scientific visualization, you may emit widgetSpec.type='plotly' with chartType in: auto|line|scatter|bar|histogram|box|heatmap|surface3d.",
  "Return only valid JSON. No markdown fences. No preamble.",
].join(" ");

interface RawProbe {
  label?: unknown;
  rationale?: unknown;
  snippetPython?: unknown;
  widgetSpec?: unknown;
  expectedOutputSchema?: unknown;
}

export async function getCachedOrGenerateDebugProbes(options: {
  context: vscode.ExtensionContext;
  graph: GraphDocument;
  node: GraphNode;
  runtimeFrame: RuntimeFrame;
  narrationScript: NarrationScript | null;
  token: vscode.CancellationToken;
  forceRegenerate?: boolean;
}): Promise<DebugProbe[]> {
  const modelChoice = await resolveNarrationModel(options.context, false);
  if (!modelChoice) return [];
  const cacheKey = `codemap.debug.probes.${options.graph.graphType}.${options.node.id}.${modelChoice.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<DebugProbe[]>(cacheKey);
    if (cached?.length) return cached;
  }

  const serializedContext = buildProbeContext(options.node, options.runtimeFrame, options.narrationScript, options.graph);
  const response = await sendDebugProbeRequest(modelChoice.model, serializedContext, options.token);
  const probes = normalizeProbes(response, options.node, options.runtimeFrame);
  await options.context.workspaceState.update(cacheKey, probes);
  return probes;
}

export async function generateSingleDebugProbe(options: {
  context: vscode.ExtensionContext;
  graph: GraphDocument;
  node: GraphNode;
  runtimeFrame: RuntimeFrame;
  narrationScript: NarrationScript | null;
  token: vscode.CancellationToken;
  question: string;
}): Promise<DebugProbe | undefined> {
  const modelChoice = await resolveNarrationModel(options.context, true);
  if (!modelChoice) return undefined;
  const serializedContext = `${buildProbeContext(options.node, options.runtimeFrame, options.narrationScript, options.graph)}\n\nUSER QUESTION:\n${options.question.trim()}`;
  const response = await sendDebugProbeRequest(modelChoice.model, serializedContext, options.token);
  return normalizeProbes(response, options.node, options.runtimeFrame)[0];
}

async function sendDebugProbeRequest(
  model: vscode.LanguageModelChat,
  serializedContext: string,
  token: vscode.CancellationToken,
): Promise<unknown> {
  const response = await model.sendRequest([
    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
    vscode.LanguageModelChatMessage.User(serializedContext),
  ], {}, token);
  let raw = "";
  for await (const chunk of response.text) {
    raw += chunk;
  }
  return safeParseJSON(raw);
}

function normalizeProbes(raw: unknown, node: GraphNode, runtimeFrame: RuntimeFrame): DebugProbe[] {
  const items = Array.isArray(raw) ? raw : [];
  const normalized = items
    .map((entry, index) => normalizeProbe(entry as RawProbe, node, runtimeFrame, index))
    .filter((entry): entry is DebugProbe => !!entry);
  if (normalized.length) {
    try {
      return parseDebugProbeList(normalized);
    } catch {
      return [fallbackProbe(node, runtimeFrame, 0)];
    }
  }
  return [fallbackProbe(node, runtimeFrame, 0)];
}

function normalizeProbe(raw: RawProbe, node: GraphNode, runtimeFrame: RuntimeFrame, index: number): DebugProbe | undefined {
  const snippetPython = typeof raw.snippetPython === "string" ? raw.snippetPython.trim() : "";
  if (!snippetPython) return undefined;
  return {
    id: `${node.id}:probe:${index + 1}`,
    nodeId: node.id,
    breakpointFile: runtimeFrame.source?.file || node.source?.file || "",
    breakpointLine: runtimeFrame.source?.line || node.source?.line || 0,
    snippetPython,
    expectedOutputSchema: normalizeSchema(raw.expectedOutputSchema),
    widgetSpec: normalizeWidgetSpec(raw.widgetSpec),
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : `Probe ${index + 1}`,
    rationale: typeof raw.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim() : "Capture a focused snapshot of the current state.",
    generatedAt: Date.now(),
  };
}

function normalizeSchema(raw: unknown): ProbeOutputSchema {
  if (raw && typeof raw === "object") {
    const kind = typeof (raw as { kind?: unknown }).kind === "string" ? (raw as { kind: string }).kind : "dict";
    if (kind === "scalar") {
      return { kind: "scalar", type: normalizeScalarType((raw as { type?: unknown }).type) };
    }
    if (kind === "array1d") {
      return { kind: "array1d", dtype: stringField(raw, "dtype", "float64"), expectedLength: numberField(raw, "expectedLength") };
    }
    if (kind === "array2d") {
      const shape = Array.isArray((raw as { shape?: unknown }).shape) ? (raw as { shape: unknown[] }).shape : undefined;
      return {
        kind: "array2d",
        dtype: stringField(raw, "dtype", "float64"),
        shape: shape && shape.length === 2 ? [Number(shape[0]) || 0, Number(shape[1]) || 0] : undefined,
      };
    }
    if (kind === "string") {
      return { kind: "string" };
    }
    return {
      kind: "dict",
      keys: Array.isArray((raw as { keys?: unknown }).keys) ? (raw as { keys: unknown[] }).keys.map((item) => String(item)) : [],
    };
  }
  return { kind: "dict", keys: [] };
}

function normalizeWidgetSpec(raw: unknown): WidgetSpec {
  if (raw && typeof raw === "object") {
    const type = stringField(raw, "type", "table");
    if (type === "plot") {
      return { type: "plot", title: stringField(raw, "title", "Plot"), xLabel: stringField(raw, "xLabel", ""), yLabel: stringField(raw, "yLabel", "") };
    }
    if (type === "plotly") {
      const chartType = stringField(raw, "chartType", "auto");
      return {
        type: "plotly",
        title: stringField(raw, "title", "Scientific Plot"),
        chartType: isPlotlyChartType(chartType) ? chartType : "auto",
        xLabel: stringField(raw, "xLabel", ""),
        yLabel: stringField(raw, "yLabel", ""),
        zLabel: stringField(raw, "zLabel", ""),
      };
    }
    if (type === "heatmap") {
      return { type: "heatmap", title: stringField(raw, "title", "Heatmap"), colormap: stringField(raw, "colormap", "RdBu") };
    }
    if (type === "histogram") {
      return { type: "histogram", title: stringField(raw, "title", "Histogram"), bins: numberField(raw, "bins") };
    }
    if (type === "tensor") {
      return { type: "tensor", title: stringField(raw, "title", "Tensor Summary") };
    }
    return {
      type: "table",
      title: stringField(raw, "title", "Debug Snapshot"),
      columns: Array.isArray((raw as { columns?: unknown }).columns) ? (raw as { columns: unknown[] }).columns.map((item) => String(item)) : undefined,
    };
  }
  return { type: "table", title: "Debug Snapshot" };
}

function fallbackProbe(node: GraphNode, runtimeFrame: RuntimeFrame, index: number): DebugProbe {
  const candidate = runtimeFrame.variables.find((variable) => /shape|size|dtype|count|len/i.test(variable.name)) || runtimeFrame.variables[0];
  const snippet = candidate
    ? `{"${candidate.name}": ${candidate.name}}`
    : "{\"frame\": \"no variables available\"}";
  return {
    id: `${node.id}:probe:${index + 1}`,
    nodeId: node.id,
    breakpointFile: runtimeFrame.source?.file || node.source?.file || "",
    breakpointLine: runtimeFrame.source?.line || node.source?.line || 0,
    snippetPython: snippet,
    expectedOutputSchema: { kind: "dict", keys: candidate ? [candidate.name] : ["frame"] },
    widgetSpec: { type: "table", title: "Live Snapshot" },
    label: "Live Snapshot",
    rationale: "Capture a small read-only view of the current frame when model output is unavailable.",
    generatedAt: Date.now(),
  };
}

function safeParseJSON(raw: string): unknown {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error("[CodeMap] Probe JSON parse failed:", raw);
    return [];
  }
}

function stringField(record: unknown, key: string, fallback: string): string {
  const value = record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberField(record: unknown, key: string): number | undefined {
  const value = record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeScalarType(value: unknown): "float" | "int" | "bool" {
  return value === "int" || value === "bool" ? value : "float";
}

function isPlotlyChartType(value: string): value is "auto" | "line" | "scatter" | "bar" | "histogram" | "box" | "heatmap" | "surface3d" {
  return ["auto", "line", "scatter", "bar", "histogram", "box", "heatmap", "surface3d"].includes(value);
}