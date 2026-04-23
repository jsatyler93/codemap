import { RuntimeFrame } from "../live/debugSync";
import { NarrationScript } from "../ai/narrationTypes";
import { GraphDocument, GraphEdge, GraphNode } from "../python/model/graphTypes";

export function buildProbeContext(
  node: GraphNode,
  runtimeFrame: RuntimeFrame,
  narrationScript: NarrationScript | null,
  graph: GraphDocument,
): string {
  const source = node.source
    ? `${node.source.file}:${node.source.line}`
    : runtimeFrame.source
      ? `${runtimeFrame.source.file}:${runtimeFrame.source.line}`
      : "unknown";

  const incoming = graph.edges.filter((edge) => edge.to === node.id);
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const narration = narrationForNode(narrationScript, node.id);
  const signature = formatSignature(node);
  const liveVars = runtimeFrame.variables
    .slice(0, 18)
    .map((variable) => `  ${variable.name.padEnd(12, " ")} ${String(variable.type || "unknown").padEnd(12, " ")} ${truncate(variable.value, 96)}`)
    .join("\n");
  const callees = outgoing
    .slice(0, 6)
    .map((edge) => describeConnectedNode("→", graph, edge.to, edge))
    .join("\n");
  const callers = incoming
    .slice(0, 4)
    .map((edge) => describeConnectedNode("←", graph, edge.from, edge))
    .join("\n");

  return [
    `BREAKPOINT HIT - ${node.label || node.id}`,
    `File: ${source}`,
    `Node kind: ${node.kind}`,
    `Graph type: ${graph.graphType}`,
    `Call graph position: ${callers ? `called by ${incoming.map((edge) => edge.from).join(", ")}` : "entry or unmatched"}${outgoing.length ? `, calls ${outgoing.map((edge) => edge.to).join(", ")}` : ""}`,
    "",
    "SYMBOL METADATA:",
    `  signature: ${signature}`,
    `  docstring: \"${sanitizeText(stringValue(node.metadata?.docSummary) || node.detail || "") || "No docstring summary available."}\"`,
    `  return type: ${stringValue(node.metadata?.returnType) || "unknown"}`,
    `  module: ${node.module || "unknown"}`,
    "",
    "LIVE VARIABLES AT THIS FRAME (from DAP):",
    liveVars || "  No live variables available.",
    "",
    "NARRATION FOR THIS STEP:",
    narration ? `  \"${sanitizeText(narration)}\"` : "  No narration available.",
    "",
    "CALLER CONTEXT:",
    callers || "  None.",
    "",
    "CALLEE CONTEXT:",
    callees || "  None.",
  ].join("\n");
}

function narrationForNode(script: NarrationScript | null, nodeId: string): string {
  if (!script) return "";
  const exact = script.steps.find((step) => step.nodeId === nodeId || step.toNodeId === nodeId || step.fromNodeId === nodeId);
  return exact?.narration || script.overview || "";
}

function describeConnectedNode(prefix: string, graph: GraphDocument, nodeId: string, edge: GraphEdge): string {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  const doc = sanitizeText(stringValue(node?.metadata?.docSummary) || node?.detail || "") || "No summary available";
  return `  ${prefix} ${node?.label || nodeId}${edge.label ? ` [${edge.label}]` : ""}: \"${doc}\"`;
}

function formatSignature(node: GraphNode): string {
  const params = Array.isArray(node.metadata?.params)
    ? (node.metadata?.params as Array<Record<string, unknown>>)
        .map((param) => {
          const name = stringValue(param.name) || "arg";
          const type = stringValue(param.type);
          return type ? `${name}: ${type}` : name;
        })
        .join(", ")
    : "";
  const returns = stringValue(node.metadata?.returnType);
  return `${node.label || node.id}(${params})${returns ? ` -> ${returns}` : ""}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen - 3)}...` : value;
}