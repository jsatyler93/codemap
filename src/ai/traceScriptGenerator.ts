import * as vscode from "vscode";
import { GraphDocument } from "../python/model/graphTypes";
import { narrateFlowchart, narrateNode, narrateTrace } from "./copilotBridge";
import { computeGraphId, serializeFlowchartContext, serializeNodeContext, serializeTraceContext } from "./graphContextSerializer";
import { NarrationConfidence, NarrationEvidence, NarrationScript, NarrationSection, NarrationStep } from "./narrationTypes";

const NARRATION_SCHEMA_VERSION = 2;
const NARRATION_CACHE_VERSION = `v${NARRATION_SCHEMA_VERSION}`;
const MAX_FLOWCHART_BEATS = 12;

interface GenerateOptions {
  context: vscode.ExtensionContext;
  graph: GraphDocument;
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  forceRegenerate?: boolean;
}

export async function getCachedOrGenerateTraceScript(options: GenerateOptions): Promise<NarrationScript> {
  const graphId = computeGraphId(options.graph);
  const cacheKey = `codemap.narration.trace.${NARRATION_CACHE_VERSION}.${graphId}.${options.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<NarrationScript>(cacheKey);
    if (cached?.schemaVersion === NARRATION_SCHEMA_VERSION) return cached;
  }
  const script = await generateTraceScript(options.graph, options.model, options.token);
  await options.context.workspaceState.update(cacheKey, script);
  return script;
}

export async function getCachedOrGenerateFlowchartScript(options: GenerateOptions): Promise<NarrationScript> {
  const graphId = computeGraphId(options.graph);
  const cacheKey = `codemap.narration.flowchart.${NARRATION_CACHE_VERSION}.${graphId}.${options.model.id}`;
  if (!options.forceRegenerate) {
    const cached = options.context.workspaceState.get<NarrationScript>(cacheKey);
    if (cached?.schemaVersion === NARRATION_SCHEMA_VERSION) return cached;
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
  const parsed = safeParseJSON(raw) as Record<string, unknown>;
  const timeline = normalizeTimeline(graph);
  const envelope = normalizeScriptEnvelope(parsed, {
    graph,
    kind: "trace",
    fallbackOverview: graph.title,
  });
  return {
    schemaVersion: NARRATION_SCHEMA_VERSION,
    kind: "trace",
    graphId: computeGraphId(graph),
    title: envelope.title,
    overview: envelope.overview,
    opening: envelope.opening,
    sections: envelope.sections,
    takeaways: envelope.takeaways,
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
  const annotations = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { steps?: unknown }).steps)
      ? (parsed as { steps: unknown[] }).steps
      : [];
  const envelope = normalizeScriptEnvelope(Array.isArray(parsed) ? {} : parsed as Record<string, unknown>, {
    graph,
    kind: "flowchart",
    fallbackOverview: graph.title,
  });
  return {
    schemaVersion: NARRATION_SCHEMA_VERSION,
    kind: "flowchart",
    graphId: computeGraphId(graph),
    title: envelope.title,
    overview: envelope.overview,
    opening: envelope.opening,
    sections: envelope.sections,
    takeaways: envelope.takeaways,
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
  const parsed = safeParseJSON(raw) as Record<string, unknown>;
  if (typeof parsed.narration !== "string" || !parsed.narration.trim()) {
    return undefined;
  }
  return {
    nodeId,
    title: normalizeOptionalString(parsed.title),
    narration: parsed.narration.trim(),
    whyItMatters: normalizeOptionalString(parsed.whyItMatters),
    confidence: normalizeConfidence(parsed.confidence),
    evidence: normalizeEvidence(parsed.evidence),
    durationHint: clampDuration(parsed.durationHint),
  };
}

export function renderScriptAsMarkdown(script: NarrationScript): string {
  const lines: string[] = [];
  lines.push(`# ${script.title || "CodeMap Narration Script"}`);
  lines.push(`_Generated: ${new Date(script.generatedAt).toISOString()}_`);
  if (script.modelName) {
    lines.push(`_Model: ${script.modelName}${script.modelId ? ` (${script.modelId})` : ""}_`);
  }
  lines.push(`_Schema: ${script.schemaVersion}_`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  if (script.opening) {
    lines.push(script.opening);
    lines.push("");
  }
  lines.push(script.overview || "");
  lines.push("");
  if (script.takeaways?.length) {
    lines.push("## Key Takeaways");
    lines.push("");
    script.takeaways.forEach((takeaway) => lines.push(`- ${takeaway}`));
    lines.push("");
  }
  if (script.sections?.length) {
    lines.push("## Sections");
    lines.push("");
    script.sections.forEach((section) => {
      lines.push(`### ${section.title}`);
      lines.push(section.summary);
      if (section.intent) lines.push(`Intent: ${section.intent}`);
      lines.push("");
    });
  }
  lines.push("## Step-by-Step");
  lines.push("");
  script.steps.forEach((step, index) => {
    const label = step.fromNodeId && step.toNodeId
      ? `${step.fromNodeId} -> ${step.toNodeId}`
      : step.nodeId || `Step ${index + 1}`;
    lines.push(`### ${index + 1}. ${step.title || label}`);
    lines.push(step.narration);
    if (step.whyItMatters) lines.push(`Why it matters: ${step.whyItMatters}`);
    if (step.evidence?.length) {
      lines.push("");
      step.evidence.forEach((item) => lines.push(`- ${item.label}: ${item.detail}`));
    }
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

function normalizeScriptEnvelope(
  raw: Record<string, unknown>,
  options: { graph: GraphDocument; kind: "trace" | "flowchart"; fallbackOverview: string },
): Pick<NarrationScript, "title" | "overview" | "opening" | "sections" | "takeaways"> {
  return {
    title: normalizeOptionalString(raw.title) || `${options.kind === "flowchart" ? "Function Tour" : "Pipeline Tour"}: ${options.graph.title}`,
    overview: normalizeOptionalString(raw.overview) || options.fallbackOverview,
    opening: normalizeOptionalString(raw.opening),
    sections: normalizeSections(raw.sections),
    takeaways: normalizeStringArray(raw.takeaways),
  };
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
      title: normalizeOptionalString((item as { title?: unknown }).title),
      narration,
      whyItMatters: normalizeOptionalString((item as { whyItMatters?: unknown }).whyItMatters),
      confidence: normalizeConfidence((item as { confidence?: unknown }).confidence),
      evidence: normalizeEvidence((item as { evidence?: unknown }).evidence),
      sectionId: normalizeOptionalString((item as { sectionId?: unknown }).sectionId),
      durationHint: clampDuration((item as { durationHint?: unknown }).durationHint),
    });
  }
  if (!normalized.length) {
    return timeline.map((step, index) => ({
      edgeIndex: index,
      fromNodeId: step.edge[0],
      toNodeId: step.edge[1],
      title: `Beat ${index + 1}`,
      narration: `${step.edge[0]} hands control to ${step.edge[1]} in the current execution path. This is part of the static pipeline order available in the graph.`,
      whyItMatters: "It advances the walkthrough when richer narration is unavailable.",
      durationHint: 2200,
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
    normalized.push({
      nodeId,
      title: normalizeOptionalString((item as { title?: unknown }).title),
      narration,
      whyItMatters: normalizeOptionalString((item as { whyItMatters?: unknown }).whyItMatters),
      confidence: normalizeConfidence((item as { confidence?: unknown }).confidence),
      evidence: normalizeEvidence((item as { evidence?: unknown }).evidence),
      sectionId: normalizeOptionalString((item as { sectionId?: unknown }).sectionId),
      durationHint: clampDuration((item as { durationHint?: unknown }).durationHint),
    });
  }
  if (normalized.length <= MAX_FLOWCHART_BEATS) return normalized;
  return condenseFlowchartSteps(normalized, MAX_FLOWCHART_BEATS);
}

function condenseFlowchartSteps(steps: NarrationStep[], maxSteps: number): NarrationStep[] {
  const scored = steps.map((step, index) => ({ step, index, score: scoreFlowchartStep(step, index) }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const chosenIndexes = new Set(scored.slice(0, maxSteps).map((entry) => entry.index));
  return steps.filter((_step, index) => chosenIndexes.has(index));
}

function scoreFlowchartStep(step: NarrationStep, index: number): number {
  let score = 0;
  const text = `${step.title || ""} ${step.narration || ""} ${step.whyItMatters || ""}`.toLowerCase();
  if (index === 0) score += 120;
  if (/entry|input|setup/.test(text)) score += 30;
  if (/decision|branch|condition|if|else|yes|no/.test(text)) score += 95;
  if (/loop|iterate|repeat|continue|break/.test(text)) score += 90;
  if (/return|output|result|emit/.test(text)) score += 75;
  if (/error|raise|fail|guard/.test(text)) score += 75;
  if (step.evidence?.length) score += 8;
  if (step.confidence === "high") score += 6;
  return score;
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
  if (!Number.isFinite(numeric)) return 2200;
  return Math.max(1000, Math.min(4200, Math.round(numeric)));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeSections(value: unknown): NarrationSection[] {
  if (!Array.isArray(value)) return [];
  const sections: NarrationSection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const title = normalizeOptionalString((item as { title?: unknown }).title);
    const summary = normalizeOptionalString((item as { summary?: unknown }).summary);
    if (!title || !summary) continue;
    sections.push({
      id: normalizeOptionalString((item as { id?: unknown }).id) || `section-${sections.length + 1}`,
      title,
      summary,
      intent: normalizeOptionalString((item as { intent?: unknown }).intent),
      stepNodeIds: normalizeStringArray((item as { stepNodeIds?: unknown }).stepNodeIds),
    });
  }
  return sections;
}

function normalizeEvidence(value: unknown): NarrationEvidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: NarrationEvidence[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      evidence.push({ label: "evidence", detail: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const label = normalizeOptionalString((item as { label?: unknown }).label) || "evidence";
    const detail = normalizeOptionalString((item as { detail?: unknown }).detail)
      || normalizeOptionalString((item as { text?: unknown }).text)
      || "";
    if (!detail) continue;
    evidence.push({
      label,
      detail,
      confidence: normalizeConfidence((item as { confidence?: unknown }).confidence),
      nodeId: normalizeOptionalString((item as { nodeId?: unknown }).nodeId),
    });
  }
  return evidence.slice(0, 5);
}

function normalizeConfidence(value: unknown): NarrationConfidence | undefined {
  if (value !== "high" && value !== "medium" && value !== "low") return undefined;
  return value;
}
