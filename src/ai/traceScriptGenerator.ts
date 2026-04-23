import * as vscode from "vscode";
import { GraphDocument } from "../python/model/graphTypes";
import { narrateFlowchart, narrateNode, narrateTrace } from "./copilotBridge";
import { computeGraphId, serializeFlowchartContext, serializeNodeContext, serializeTraceContext } from "./graphContextSerializer";
import { NarrationScript, NarrationStep } from "./narrationTypes";

interface GenerateOptions {
  context: vscode.ExtensionContext;
  graph: GraphDocument;
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  forceRegenerate?: boolean;
}

export async function getCachedOrGenerateTraceScript(options: GenerateOptions): Promise<NarrationScript> {
  const graphId = computeGraphId(options.graph);
  const cacheKey = `codemap.narration.trace.${graphId}.${options.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<NarrationScript>(cacheKey);
    if (cached) return cached;
  }
  const script = await generateTraceScript(options.graph, options.model, options.token);
  await options.context.workspaceState.update(cacheKey, script);
  return script;
}

export async function getCachedOrGenerateFlowchartScript(options: GenerateOptions): Promise<NarrationScript> {
  const graphId = computeGraphId(options.graph);
  const cacheKey = `codemap.narration.flowchart.${graphId}.${options.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<NarrationScript>(cacheKey);
    if (cached) return cached;
  }
  const script = await generateFlowchartScript(options.graph, options.model, options.token);
  await options.context.workspaceState.update(cacheKey, script);
  return script;
}

export async function generateTraceScript(
  graph: GraphDocument,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<NarrationScript> {
  const raw = await narrateTrace(serializeTraceContext(graph), model, token);
  const parsed = safeParseJSON(raw) as { overview?: unknown; steps?: unknown };
  const timeline = normalizeTimeline(graph);
  return {
    kind: "trace",
    graphId: computeGraphId(graph),
    overview: typeof parsed.overview === "string" ? parsed.overview.trim() : graph.title,
    steps: normalizeTraceSteps(parsed.steps, timeline),
    generatedAt: Date.now(),
    modelId: model.id,
    modelName: model.name,
  };
}

export async function generateFlowchartScript(
  graph: GraphDocument,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<NarrationScript> {
  const raw = await narrateFlowchart(serializeFlowchartContext(graph), model, token);
  const parsed = safeParseJSON(raw);
  const annotations = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { steps?: unknown }).steps) ? (parsed as { steps: unknown[] }).steps : [];
  return {
    kind: "flowchart",
    graphId: computeGraphId(graph),
    overview: graph.title,
    steps: normalizeFlowchartSteps(annotations),
    generatedAt: Date.now(),
    modelId: model.id,
    modelName: model.name,
  };
}

export async function generateNodeNarration(
  graph: GraphDocument,
  nodeId: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<NarrationStep | undefined> {
  const raw = await narrateNode(serializeNodeContext(graph, nodeId), model, token);
  const parsed = safeParseJSON(raw) as { narration?: unknown; durationHint?: unknown };
  if (typeof parsed.narration !== "string" || !parsed.narration.trim()) {
    return undefined;
  }
  return {
    nodeId,
    narration: parsed.narration.trim(),
    durationHint: clampDuration(parsed.durationHint),
  };
}

export function renderScriptAsMarkdown(script: NarrationScript): string {
  const lines: string[] = [];
  lines.push("# CodeMap Narration Script");
  lines.push(`_Generated: ${new Date(script.generatedAt).toISOString()}_`);
  if (script.modelName) {
    lines.push(`_Model: ${script.modelName}${script.modelId ? ` (${script.modelId})` : ""}_`);
  }
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(script.overview || "");
  lines.push("");
  lines.push("## Step-by-Step");
  lines.push("");
  script.steps.forEach((step, index) => {
    const label = step.fromNodeId && step.toNodeId
      ? `${step.fromNodeId} -> ${step.toNodeId}`
      : step.nodeId || `Step ${index + 1}`;
    lines.push(`### ${index + 1}. ${label}`);
    lines.push(step.narration);
    lines.push("");
  });
  return lines.join("\n");
}

export function buildFlowchartNarrationMap(script: NarrationScript | undefined): Record<string, string> {
  if (!script || script.kind !== "flowchart") return {};
  const entries = script.steps
    .filter((step) => step.nodeId && step.narration)
    .map((step) => [String(step.nodeId), step.narration] as const);
  return Object.fromEntries(entries);
}

function safeParseJSON(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error("[CodeMap] Narration JSON parse failed. Raw response:", raw);
    return { overview: "", steps: [] };
  }
}

function normalizeTraceSteps(
  rawSteps: unknown,
  timeline: Array<{ edge: [string, string] }>,
): NarrationStep[] {
  const items = Array.isArray(rawSteps) ? rawSteps : [];
  const normalized: NarrationStep[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const edgeIndex = Number((item as { edgeIndex?: unknown }).edgeIndex);
    const narration = typeof (item as { narration?: unknown }).narration === "string"
      ? (item as { narration: string }).narration.trim()
      : "";
    if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= timeline.length || !narration) continue;
    const [fromNodeId, toNodeId] = timeline[edgeIndex].edge;
    normalized.push({
      edgeIndex,
      fromNodeId,
      toNodeId,
      narration,
      durationHint: clampDuration((item as { durationHint?: unknown }).durationHint),
    });
  }
  if (!normalized.length) {
    return timeline.map((step, index) => ({
      edgeIndex: index,
      fromNodeId: step.edge[0],
      toNodeId: step.edge[1],
      narration: `Step ${index + 1}: ${step.edge[0]} calls ${step.edge[1]}.`,
      durationHint: 1600,
    }));
  }
  normalized.sort((left, right) => (left.edgeIndex ?? 0) - (right.edgeIndex ?? 0));
  return normalized;
}

function normalizeFlowchartSteps(rawSteps: unknown[]): NarrationStep[] {
  const normalized: NarrationStep[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== "object") continue;
    const nodeId = typeof (item as { nodeId?: unknown }).nodeId === "string"
      ? (item as { nodeId: string }).nodeId
      : "";
    const narration = typeof (item as { annotation?: unknown }).annotation === "string"
      ? (item as { annotation: string }).annotation.trim()
      : typeof (item as { narration?: unknown }).narration === "string"
        ? (item as { narration: string }).narration.trim()
        : "";
    if (!nodeId || !narration) continue;
    normalized.push({ nodeId, narration, durationHint: 1800 });
  }
  return normalized;
}

function normalizeTimeline(graph: GraphDocument): Array<{ edge: [string, string] }> {
  const timeline = graph.metadata?.execTimeline;
  if (!Array.isArray(timeline)) return [];
  const steps: Array<{ edge: [string, string] }> = [];
  for (const item of timeline) {
    const edge = Array.isArray((item as { edge?: unknown[] }).edge) ? (item as { edge: unknown[] }).edge : undefined;
    if (!edge || edge.length !== 2) continue;
    steps.push({ edge: [String(edge[0]), String(edge[1])] });
  }
  return steps;
}

function clampDuration(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1600;
  return Math.max(800, Math.min(2500, Math.round(numeric)));
}
