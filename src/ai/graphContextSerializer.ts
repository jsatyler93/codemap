import { GraphDocument, GraphEdge, GraphNode } from "../python/model/graphTypes";

const MAX_TRACE_STEPS = 40;
const MAX_DOC_LEN = 160;
const MAX_GROUPS = 14;
const MAX_GROUP_NODES = 10;
const MAX_TRANSITIONS_PER_NODE = 4;
const MAX_FLOWCHART_CONTEXT_NODES = 64;

export function computeGraphId(graph: GraphDocument): string {
  const seed = [
    graph.graphType,
    graph.title,
    graph.subtitle || "",
    String(graph.nodes.length),
    String(graph.edges.length),
    ...(graph.rootNodeIds || []),
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `graph-${(hash >>> 0).toString(16)}`;
}

export function serializeTraceContext(graph: GraphDocument): string {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeByPair = new Map<string, GraphEdge>();
  for (const edge of graph.edges) {
    edgeByPair.set(`${edge.from}->${edge.to}`, edge);
  }
  const timeline = normalizeTimeline(graph).slice(0, MAX_TRACE_STEPS);
  const entryNode = resolveEntryNode(graph, nodeById, timeline);
  const summary = graph.metadata?.analysisSummary as Record<string, unknown> | undefined;
  const lines: string[] = [];

  lines.push(`CALL GRAPH WALKTHROUGH REQUEST`);
  lines.push(`Title: ${graph.title}`);
  if (graph.subtitle) lines.push(`Subtitle: ${graph.subtitle}`);
  lines.push(`Graph type: ${graph.graphType}`);
  if (entryNode) {
    lines.push(`Entry: ${formatNodeHeading(entryNode)}`);
    appendNodeFacts(lines, entryNode, "  ");
  }
  lines.push("");
  lines.push("Narration objective: explain the pipeline in a way that gives the reader a strong mental model of how work moves through the call graph.");
  lines.push("");
  lines.push("EXECUTION STEPS (static trace, source order):");

  if (!timeline.length) {
    lines.push("  (no execution timeline available)");
  }

  timeline.forEach((step, index) => {
    const [fromId, toId] = step.edge;
    const fromNode = nodeById.get(fromId);
    const toNode = nodeById.get(toId);
    const edge = edgeByPair.get(`${fromId}->${toId}`);
    lines.push(`  step ${index}: ${(fromNode?.label || fromId)} -> ${(toNode?.label || toId)}`);
    if (fromNode) {
      lines.push(`    caller: ${formatNodeHeading(fromNode)}`);
      appendNodeFacts(lines, fromNode, "      ");
    }
    if (toNode) {
      lines.push(`    callee: ${formatNodeHeading(toNode)}`);
      appendNodeFacts(lines, toNode, "      ");
    }
    if (edge) {
      lines.push(`    edge: kind=${edge.kind}${edge.label ? `, label=${edge.label}` : ""}${edge.resolution ? `, resolution=${edge.resolution}` : ""}`);
      const edgeEvidence = formatEdgeEvidence(edge);
      if (edgeEvidence) lines.push(`    edge evidence: ${edgeEvidence}`);
    }
    if (step.desc) lines.push(`    timeline note: ${truncate(step.desc, MAX_DOC_LEN)}`);
    lines.push("");
  });

  const resolutionStats = countEdgeResolution(graph.edges);
  lines.push("GRAPH STATS:");
  lines.push(
    `  total nodes: ${graph.nodes.length} | total edges: ${graph.edges.length} | type coverage: ${formatTypeCoverage(summary)}`,
  );
  lines.push(
    `  resolved edges: ${resolutionStats.resolved} | likely edges: ${resolutionStats.likely} | unresolved edges: ${resolutionStats.unresolved}`,
  );

  return lines.join("\n");
}

export function serializeFlowchartContext(graph: GraphDocument): string {
  const entryNode = resolveFlowchartEntryNode(graph);
  const groups = Array.isArray(graph.metadata?.groups) ? graph.metadata.groups as Array<Record<string, unknown>> : [];
  const outgoingByNode = buildOutgoingEdgeMap(graph.edges);
  const groupMembership = buildGroupMembershipMap(groups);
  const selectedNodes = selectFlowchartNarrationNodes(graph);
  const lines: string[] = [];
  lines.push("FUNCTION FLOWCHART WALKTHROUGH REQUEST");
  lines.push(`Title: ${graph.title}`);
  if (graph.subtitle) lines.push(`Subtitle: ${graph.subtitle}`);
  lines.push(`Graph type: ${graph.graphType}`);
  if (entryNode) {
    lines.push(`Entry: ${formatNodeHeading(entryNode)}`);
    appendNodeFacts(lines, entryNode, "  ");
  }
  lines.push("");
  lines.push("Narration objective: explain the function as a guided control-flow tour, with attention to decisions, loops, outputs, and notable helper steps.");
  if (graph.nodes.length > selectedNodes.length) {
    lines.push(`Scalability note: only the most important ${selectedNodes.length} of ${graph.nodes.length} nodes are listed below. Prefer a compact narration that summarizes straightforward setup instead of covering every node.`);
  }
  lines.push("");
  lines.push("NODES (control flow order):");
  for (const node of selectedNodes) {
    lines.push(`  [${node.kind}] id=${node.id} ${primaryNodeText(node)}`);
    appendNodeFacts(lines, node, "    ");
    const groupsForNode = groupMembership.get(node.id) || [];
    if (groupsForNode.length) lines.push(`    groups: ${groupsForNode.join(" > ")}`);
    const transitions = (outgoingByNode.get(node.id) || []).slice(0, MAX_TRANSITIONS_PER_NODE);
    if (transitions.length) {
      const rendered = transitions
        .map((edge) => `${edge.label ? `${edge.label} -> ` : ""}${edge.to}`)
        .join(", ");
      lines.push(`    transitions: ${rendered}`);
    }
  }
  lines.push("");
  lines.push("GROUPS:");
  if (!groups.length) {
    lines.push("  (no compound groups)");
  }
  groups.slice(0, MAX_GROUPS).forEach((group) => {
    const ids = Array.isArray(group.nodeIds)
      ? group.nodeIds.slice(0, MAX_GROUP_NODES).map((value) => String(value))
      : [];
    const suffix = Array.isArray(group.nodeIds) && group.nodeIds.length > ids.length
      ? ", ..."
      : "";
    lines.push(`  ${String(group.label || group.kind || "group")}: [${ids.join(", ")}${suffix}]`);
  });
  return lines.join("\n");
}

function selectFlowchartNarrationNodes(graph: GraphDocument): GraphNode[] {
  if (!Array.isArray(graph.nodes) || graph.nodes.length <= MAX_FLOWCHART_CONTEXT_NODES) return graph.nodes || [];
  const scored = graph.nodes.map((node, index) => ({ node, index, score: scoreFlowchartNarrationNode(node, graph, index) }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen = scored.slice(0, MAX_FLOWCHART_CONTEXT_NODES).sort((left, right) => left.index - right.index);
  return chosen.map((entry) => entry.node);
}

function scoreFlowchartNarrationNode(node: GraphNode, graph: GraphDocument, index: number): number {
  let score = 0;
  if (node.kind === "entry" || node.kind === "return") score += 120;
  if (node.kind === "decision") score += 110;
  if (node.kind === "loop") score += 105;
  if (node.kind === "error") score += 100;
  if (node.kind === "output") score += 90;
  if (node.metadata?.boundaryProxy) score += 95;
  if (typeof node.metadata?.docSummary === "string" && node.metadata.docSummary) score += 12;
  if (Array.isArray(node.metadata?.params) && node.metadata.params.length) score += 8;
  if (typeof node.metadata?.returnType === "string" && node.metadata.returnType) score += 8;
  const outgoing = graph.edges.filter((edge) => edge.from === node.id).length;
  const incoming = graph.edges.filter((edge) => edge.to === node.id).length;
  if (outgoing >= 2) score += 14;
  if (incoming >= 2) score += 10;
  score += Math.max(0, 10 - Math.min(10, index / 4));
  return score;
}

export function serializeNodeContext(graph: GraphDocument, nodeId: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return `NODE NOT FOUND: ${nodeId}`;
  const lines = [
    `GRAPH: ${graph.title}`,
    `NODE: ${node.id}`,
    `kind: ${node.kind}`,
    `label: ${node.label || node.id}`,
  ];
  appendNodeFacts(lines, node);
  return lines.join("\n");
}

function resolveEntryNode(
  graph: GraphDocument,
  nodeById: Map<string, GraphNode>,
  timeline: Array<{ edge: [string, string]; label: string; desc: string }>,
): GraphNode | undefined {
  const rootId = graph.rootNodeIds?.[0];
  if (rootId) return nodeById.get(rootId);
  const firstEdge = timeline[0]?.edge?.[0];
  if (firstEdge) return nodeById.get(firstEdge);
  return graph.nodes[0];
}

function resolveFlowchartEntryNode(graph: GraphDocument): GraphNode | undefined {
  const rootId = graph.rootNodeIds?.[0];
  return graph.nodes.find((node) => node.id === rootId) || graph.nodes.find((node) => node.kind === "entry") || graph.nodes[0];
}

function normalizeTimeline(graph: GraphDocument): Array<{ edge: [string, string]; label: string; desc: string }> {
  const timeline = graph.metadata?.execTimeline;
  if (!Array.isArray(timeline)) return [];
  const steps: Array<{ edge: [string, string]; label: string; desc: string }> = [];
  for (const item of timeline) {
    const edge = Array.isArray((item as { edge?: unknown[] }).edge) ? (item as { edge: unknown[] }).edge : undefined;
    if (!edge || edge.length !== 2) continue;
    steps.push({
      edge: [String(edge[0]), String(edge[1])],
      label: String((item as { label?: unknown }).label ?? ""),
      desc: String((item as { desc?: unknown }).desc ?? ""),
    });
  }
  return steps;
}

function formatSource(node: GraphNode): string {
  if (!node.source?.file) return "";
  return `  [${node.source.file.replace(/\\/g, "/")}:${node.source.line}]`;
}

function formatNodeHeading(node: GraphNode): string {
  return `${node.label || node.id}${formatSource(node)}`;
}

function docSummary(node: GraphNode): string {
  const raw = node.metadata && typeof node.metadata.docSummary === "string" ? node.metadata.docSummary : "";
  return truncate(raw, MAX_DOC_LEN);
}

function returnType(node: GraphNode): string {
  return node.metadata && typeof node.metadata.returnType === "string" ? node.metadata.returnType : "";
}

function formatParamSummary(node: GraphNode): string {
  const params = Array.isArray(node.metadata?.params) ? node.metadata.params as Array<Record<string, unknown>> : [];
  if (!params.length) return "";
  return params
    .slice(0, 6)
    .map((param) => {
      const name = String(param.name || "arg");
      const type = typeof param.type === "string" ? `: ${param.type}` : "";
      return `${name}${type}`;
    })
    .join(", ");
}

function formatSignature(node: GraphNode): string {
  const params = formatParamSummary(node);
  const returns = returnType(node);
  return `${node.label || node.id}(${params})${returns ? ` -> ${returns}` : ""}`;
}

function appendNodeFacts(lines: string[], node: GraphNode, indent = ""): void {
  const signature = formatSignature(node);
  if (signature) lines.push(`${indent}signature: ${signature}`);
  const detail = typeof node.detail === "string" ? truncate(node.detail, MAX_DOC_LEN) : "";
  if (detail) lines.push(`${indent}detail: ${detail}`);
  if (node.module) lines.push(`${indent}module: ${node.module}`);
  if (node.className) lines.push(`${indent}class: ${node.className}`);
  const doc = docSummary(node);
  if (doc) lines.push(`${indent}docstring: "${doc}"`);
  const returns = returnType(node);
  if (returns) lines.push(`${indent}returns: ${returns}`);
  const params = formatParamSummary(node);
  if (params) lines.push(`${indent}params: ${params}`);
  const decorators = formatDecoratorSummary(node);
  if (decorators) lines.push(`${indent}decorators: ${decorators}`);
  const traits = formatTraitSummary(node);
  if (traits) lines.push(`${indent}traits: ${traits}`);
}

function formatDecoratorSummary(node: GraphNode): string {
  const decorators = Array.isArray(node.metadata?.decorators) ? node.metadata.decorators : [];
  if (!decorators.length) return "";
  return decorators.slice(0, 5).map((value) => String(value)).join(", ");
}

function formatTraitSummary(node: GraphNode): string {
  const traits: string[] = [];
  if (node.metadata?.isAsync === true) traits.push("async");
  if (typeof node.metadata?.methodKind === "string") traits.push(`method=${String(node.metadata.methodKind)}`);
  if (typeof node.metadata?.returnTypeConfidence === "string") traits.push(`return-confidence=${String(node.metadata.returnTypeConfidence)}`);
  return traits.join(", ");
}

function formatEdgeEvidence(edge: GraphEdge): string {
  const pieces: string[] = [];
  if (typeof edge.metadata?.resolutionSource === "string") pieces.push(`source=${String(edge.metadata.resolutionSource)}`);
  if (typeof edge.metadata?.confidence === "string") pieces.push(`confidence=${String(edge.metadata.confidence)}`);
  if (typeof edge.metadata?.callCount === "number") pieces.push(`call-count=${String(edge.metadata.callCount)}`);
  return pieces.join(", ");
}

function buildOutgoingEdgeMap(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.from) || [];
    list.push(edge);
    map.set(edge.from, list);
  }
  return map;
}

function buildGroupMembershipMap(groups: Array<Record<string, unknown>>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of groups) {
    const label = String(group.label || group.kind || group.id || "group");
    const nodeIds = Array.isArray(group.nodeIds) ? group.nodeIds : [];
    for (const nodeId of nodeIds) {
      const key = String(nodeId);
      const list = map.get(key) || [];
      list.push(label);
      map.set(key, list);
    }
  }
  return map;
}

function primaryNodeText(node: GraphNode): string {
  const displayLines = Array.isArray(node.metadata?.displayLines) ? node.metadata.displayLines : [];
  if (displayLines.length > 1) {
    return displayLines.map((value) => String(value)).join(" | ");
  }
  if (displayLines.length === 1) {
    return String(displayLines[0]);
  }
  const detail = typeof node.detail === "string" ? node.detail : "";
  return truncate(node.label || detail || node.id, MAX_DOC_LEN);
}

function formatTypeCoverage(summary: Record<string, unknown> | undefined): string {
  if (!summary || typeof summary.typeCoveragePct !== "number") return "unknown";
  return `${summary.typeCoveragePct}%`;
}

function countEdgeResolution(edges: readonly GraphEdge[]): { resolved: number; likely: number; unresolved: number } {
  return edges.reduce(
    (acc, edge) => {
      if (edge.resolution === "resolved") acc.resolved += 1;
      else if (edge.resolution === "likely") acc.likely += 1;
      else if (edge.resolution === "unresolved") acc.unresolved += 1;
      return acc;
    },
    { resolved: 0, likely: 0, unresolved: 0 },
  );
}

function truncate(text: string, max: number): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}
