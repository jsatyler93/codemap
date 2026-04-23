import { GraphDocument, GraphEdge, GraphNode } from "../python/model/graphTypes";

const MAX_TRACE_STEPS = 30;
const MAX_DOC_LEN = 80;
const MAX_GROUPS = 12;
const MAX_GROUP_NODES = 8;

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

  lines.push(`PYTHON CALL GRAPH - ${graph.title}`);
  if (entryNode) {
    lines.push(`Entry: ${entryNode.label || entryNode.id}${formatSource(entryNode)}`);
    const doc = docSummary(entryNode);
    if (doc) lines.push(`  docstring: \"${doc}\"`);
    const returns = returnType(entryNode);
    if (returns) lines.push(`  returns: ${returns}`);
    const params = formatParamSummary(entryNode);
    if (params) lines.push(`  params: ${params}`);
  }
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
    const doc = toNode ? docSummary(toNode) : "";
    if (doc) lines.push(`    callee docstring: \"${doc}\"`);
    const returns = toNode ? returnType(toNode) : "";
    if (returns) lines.push(`    callee returns: ${returns}`);
    const params = toNode ? formatParamSummary(toNode) : "";
    if (params) lines.push(`    callee params: ${params}`);
    if (edge?.resolution) lines.push(`    edge resolution: ${edge.resolution}`);
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
  const lines: string[] = [];
  lines.push(`PYTHON FLOWCHART - ${graph.title}${entryNode ? formatSource(entryNode) : ""}`);
  if (entryNode) {
    const signature = formatSignature(entryNode);
    if (signature) lines.push(`  signature: ${signature}`);
    const doc = docSummary(entryNode);
    if (doc) lines.push(`  docstring: \"${doc}\"`);
  }
  lines.push("");
  lines.push("NODES (control flow order):");
  for (const node of graph.nodes) {
    lines.push(`  [${node.kind}] id=${node.id} ${primaryNodeText(node)}`);
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

export function serializeNodeContext(graph: GraphDocument, nodeId: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return `NODE NOT FOUND: ${nodeId}`;
  const lines = [
    `GRAPH: ${graph.title}`,
    `NODE: ${node.id}`,
    `kind: ${node.kind}`,
    `label: ${node.label || node.id}`,
  ];
  const source = formatSource(node);
  if (source) lines.push(`source: ${source.trim()}`);
  const doc = docSummary(node);
  if (doc) lines.push(`docstring: \"${doc}\"`);
  const returns = returnType(node);
  if (returns) lines.push(`returns: ${returns}`);
  const params = formatParamSummary(node);
  if (params) lines.push(`params: ${params}`);
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
