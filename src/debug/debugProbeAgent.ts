import * as vscode from "vscode";
import * as path from "path";
import { resolveNarrationModel } from "../ai/copilotBridge";
import { GraphDocument, GraphNode } from "../python/model/graphTypes";
import { RuntimeFrame } from "../live/debugSync";
import { NarrationScript } from "../ai/narrationTypes";
import { buildProbeContext } from "./probeContextBuilder";
import { DebugProbe, ProbeLanguage, ProbeOutputSchema, WidgetSpec } from "./debugProbeTypes";
import { parseDebugProbeList } from "./probeSchemas";

const LANGUAGE_RULES: Record<ProbeLanguage, string> = {
  python: [
    "Target language: Python.",
    "Snippets are evaluated as a Python expression at the breakpoint frame.",
    "Multi-line snippets are allowed; the LAST line MUST be a single expression that produces a JSON-serializable value.",
    "Do not import os, subprocess, socket; do not call open(), eval(), exec(), __import__(); do not call print(); no file or network IO.",
    "Prefer numpy summaries (shape, dtype, mean/std, downsampled .tolist()) over raw arrays.",
  ].join(" "),
  javascript: [
    "Target language: JavaScript / TypeScript.",
    "The snippet is evaluated as a single JavaScript expression in the current debugger frame (Node.js or browser).",
    "Use only ONE expression (no statements, no `;`, no `let`/`const`, no `function` declarations).",
    "You may use IIFE arrow functions, ternaries, spread, optional chaining, Array methods, JSON, Math, Object.keys/entries.",
    "Do not use require(), import, eval, Function, fs, child_process, fetch, XMLHttpRequest, process.exit; no IO; no assignments to live variables.",
    "Result MUST be JSON-serializable. For typed arrays / large arrays, downsample (e.g. Array.from(arr).filter((_,i)=>i%16===0)) and report length/min/max.",
  ].join(" "),
  idl: [
    "Target language: IDL.",
    "Snippets are evaluated as a single IDL expression returning a JSON-serializable value.",
    "Prefer compact summaries (size, min, max, mean) over raw arrays.",
    "Do not perform file or network IO; do not modify variables.",
  ].join(" "),
};

function buildSystemPrompt(language: ProbeLanguage): string {
  return [
    "You are a surgical debugging assistant for scientific code.",
    "You will receive function signature, docstring, type metadata, live debugger variables, call position, and optional narration.",
    "Generate 2 to 4 targeted debug probes as a JSON array.",
    "Every probe object must include: label, rationale, snippet, widgetSpec, expectedOutputSchema.",
    "Snippets must be read-only and end with a JSON-serializable result expression.",
    LANGUAGE_RULES[language],
    "Prefer compact summaries over raw arrays. For multidimensional arrays, prefer shape and statistics or a downsampled heatmap.",
    "For rich scientific visualization, you may emit widgetSpec.type='plotly' with chartType in: auto|line|scatter|bar|histogram|box|heatmap|surface3d.",
    "Return only valid JSON. No markdown fences. No preamble.",
  ].join(" ");
}

interface RawProbe {
  label?: unknown;
  rationale?: unknown;
  snippet?: unknown;
  /** Legacy field name from earlier versions; still accepted from the model. */
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
  const language = inferProbeLanguage(options.node, options.runtimeFrame, options.graph);
  // Cache key bumped to v2 because probe schema changed (snippetPython -> snippet, +language).
  const cacheKey = `codemap.debug.probes.v2.${options.graph.graphType}.${options.node.id}.${modelChoice.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<DebugProbe[]>(cacheKey);
    if (cached?.length) return cached;
  }

  const serializedContext = buildProbeContext(options.node, options.runtimeFrame, options.narrationScript, options.graph);
  const response = await sendDebugProbeRequest(modelChoice.model, language, serializedContext, options.token);
  const probes = normalizeProbes(response, options.node, options.runtimeFrame, language);
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
  const language = inferProbeLanguage(options.node, options.runtimeFrame, options.graph);
  const serializedContext = `${buildProbeContext(options.node, options.runtimeFrame, options.narrationScript, options.graph)}\n\nUSER QUESTION:\n${options.question.trim()}`;
  const response = await sendDebugProbeRequest(modelChoice.model, language, serializedContext, options.token);
  return normalizeProbes(response, options.node, options.runtimeFrame, language)[0];
}

async function sendDebugProbeRequest(
  model: vscode.LanguageModelChat,
  language: ProbeLanguage,
  serializedContext: string,
  token: vscode.CancellationToken,
): Promise<unknown> {
  const response = await model.sendRequest([
    vscode.LanguageModelChatMessage.User(buildSystemPrompt(language)),
    vscode.LanguageModelChatMessage.User(serializedContext),
  ], {}, token);
  let raw = "";
  for await (const chunk of response.text) {
    raw += chunk;
  }
  return safeParseJSON(raw);
}

function normalizeProbes(raw: unknown, node: GraphNode, runtimeFrame: RuntimeFrame, language: ProbeLanguage): DebugProbe[] {
  const items = Array.isArray(raw) ? raw : [];
  const normalized = items
    .map((entry, index) => normalizeProbe(entry as RawProbe, node, runtimeFrame, language, index))
    .filter((entry): entry is DebugProbe => !!entry);
  if (normalized.length) {
    try {
      return parseDebugProbeList(normalized);
    } catch {
      return [fallbackProbe(node, runtimeFrame, language, 0)];
    }
  }
  return [fallbackProbe(node, runtimeFrame, language, 0)];
}

function normalizeProbe(raw: RawProbe, node: GraphNode, runtimeFrame: RuntimeFrame, language: ProbeLanguage, index: number): DebugProbe | undefined {
  const rawSnippet = typeof raw.snippet === "string" && raw.snippet.trim()
    ? raw.snippet
    : typeof raw.snippetPython === "string" ? raw.snippetPython : "";
  const snippet = rawSnippet.trim();
  if (!snippet) return undefined;
  return {
    id: `${node.id}:probe:${index + 1}`,
    nodeId: node.id,
    breakpointFile: runtimeFrame.source?.file || node.source?.file || "",
    breakpointLine: runtimeFrame.source?.line || node.source?.line || 0,
    language,
    snippet,
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

function fallbackProbe(node: GraphNode, runtimeFrame: RuntimeFrame, language: ProbeLanguage, index: number): DebugProbe {
  const candidate = runtimeFrame.variables.find((variable) => /shape|size|dtype|count|len/i.test(variable.name)) || runtimeFrame.variables[0];
  const snippet = buildFallbackSnippet(language, candidate?.name);
  return {
    id: `${node.id}:probe:${index + 1}`,
    nodeId: node.id,
    breakpointFile: runtimeFrame.source?.file || node.source?.file || "",
    breakpointLine: runtimeFrame.source?.line || node.source?.line || 0,
    language,
    snippet,
    expectedOutputSchema: { kind: "dict", keys: candidate ? [candidate.name] : ["frame"] },
    widgetSpec: { type: "table", title: "Live Snapshot" },
    label: "Live Snapshot",
    rationale: "Capture a small read-only view of the current frame when model output is unavailable.",
    generatedAt: Date.now(),
  };
}

function buildFallbackSnippet(language: ProbeLanguage, candidateName: string | undefined): string {
  if (!candidateName) {
    if (language === "javascript") return "({frame: 'no variables available'})";
    if (language === "idl") return "{frame: 'no variables available'}";
    return "{\"frame\": \"no variables available\"}";
  }
  if (language === "javascript") {
    return `({"${candidateName}": ${candidateName}})`;
  }
  if (language === "idl") {
    return `{"${candidateName}": ${candidateName}}`;
  }
  return `{"${candidateName}": ${candidateName}}`;
}

function inferProbeLanguage(node: GraphNode, runtimeFrame: RuntimeFrame, graph: GraphDocument): ProbeLanguage {
  const candidateFiles = [
    node.source?.file,
    runtimeFrame.source?.file,
    ...graph.nodes.map((entry) => entry.source?.file),
  ];
  for (const file of candidateFiles) {
    if (!file) continue;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".py") return "python";
    if (ext === ".pro") return "idl";
    if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext)) return "javascript";
  }
  return "python";
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