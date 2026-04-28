import * as path from "path";
import * as vscode from "vscode";
import { pack } from "msgpackr";
import { NarrationScript } from "../ai/narrationTypes";
import { DebugProbe, ProbeResult } from "../debug/debugProbeTypes";
import { parseDebugProbeList, parseProbeResult } from "../debug/probeSchemas";
import { GraphDocument } from "../python/model/graphTypes";
import { BreadcrumbEntry, FromWebviewMessage, RuntimeFrameView, UiStateView } from "../messaging/protocol";

/** One entry in the layer stack used for flowchart drilldown. */
interface LayerStackEntry {
  groupId: string;
  label: string;
  graph: GraphDocument;
}

export class GraphWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private lastGraph: GraphDocument | undefined;
  private lastRuntime: { frame: RuntimeFrameView | null; highlightNodeIds?: string[]; breakpointNodeIds?: string[] } | undefined;
  private lastNarration: NarrationScript | undefined;
  private lastDebugProbes: DebugProbe[] = [];
  private lastProbeResults = new Map<string, ProbeResult>();
  /** Stack for flowchart progressive reading mode.  Empty = overview layer. */
  private flowchartLayerStack: LayerStackEntry[] = [];
  private uiState: UiStateView = {
    showEvidence: false,
    showFunctionCalls: true,
    narrationEnabled: true,
    repelStrength: 0.45,
    attractStrength: 0.32,
    ambientRepelStrength: 0.18,
    cohesionStrength: 0.34,
    layoutMode: "lanes",
    treeView: false,
    canvasBrightness: 1.0,
    canvasThemeMode: "codemap",
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onRevealNode: (nodeId: string, source?: GraphDocument["nodes"][0]["source"]) => void,
    private readonly onRefreshRequested: () => void,
    private readonly onDebugMessage: (message: string) => void,
    private readonly onRequestFlowchart: (nodeId: string, source?: GraphDocument["nodes"][0]["source"]) => void,
    private readonly onRequestNarration: (kind?: "trace" | "flowchart", regenerate?: boolean) => void,
    private readonly onRequestExportNarration: () => void,
    private readonly onToggleAiAssistance: (enabled: boolean) => void,
    private readonly onToggleFunctionCalls: (enabled: boolean) => void,
    private readonly onRegenerateProbes: (nodeId: string) => void,
    private readonly onDismissProbe: (probeId: string) => void,
  ) {}

  show(graph: GraphDocument): void {
    this.lastGraph = graph;
    this.lastNarration = undefined;
    // Any new top-level graph resets the drilldown stack.
    this.flowchartLayerStack = [];
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "codemap.graph",
        "CodeMap",
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(this.context.extensionPath, "dist", "webview")),
          ],
        },
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
        if (msg.type === "revealNode") {
          this.onRevealNode(msg.nodeId, msg.source);
        } else if (msg.type === "requestRefresh") {
          this.onRefreshRequested();
        } else if (msg.type === "requestFlowchart") {
          this.onRequestFlowchart(msg.nodeId, msg.source);
        } else if (msg.type === "requestNarration") {
          this.onRequestNarration(msg.kind, msg.regenerate);
        } else if (msg.type === "requestExportNarration") {
          this.onRequestExportNarration();
        } else if (msg.type === "toggleAiAssistance") {
          this.onToggleAiAssistance(msg.enabled);
        } else if (msg.type === "toggleFunctionCalls") {
          this.onToggleFunctionCalls(msg.enabled);
        } else if (msg.type === "regenerateProbes") {
          this.onRegenerateProbes(msg.nodeId);
        } else if (msg.type === "dismissProbe") {
          this.onDismissProbe(msg.probeId);
        } else if (msg.type === "debug") {
          this.onDebugMessage(msg.message);
        } else if (msg.type === "drilldownFlowchart") {
          this.handleDrilldownFlowchart(msg.groupId, msg.label);
        } else if (msg.type === "flowchartBreadcrumbNavigate") {
          this.handleBreadcrumbNavigate(msg.breadcrumbIndex);
        } else if (msg.type === "ready") {
          this.onDebugMessage("webview ready");
          if (this.lastGraph) {
            this.postGraph(this.lastGraph);
          }
          this.postUiState();
          if (this.lastRuntime) {
            this.panel?.webview.postMessage({
              type: "setRuntimeFrame",
              frame: this.lastRuntime.frame,
              highlightNodeIds: this.lastRuntime.highlightNodeIds,
              breakpointNodeIds: this.lastRuntime.breakpointNodeIds,
            });
          }
          if (this.lastNarration) {
            this.panel?.webview.postMessage({
              type: "setNarrationScript",
              script: this.lastNarration,
            });
          }
          if (this.lastDebugProbes.length) {
            this.panel?.webview.postMessage({
              type: "setDebugProbes",
              probesPacked: encodePacked(this.lastDebugProbes),
            });
            for (const result of this.lastProbeResults.values()) {
              this.panel?.webview.postMessage({
                type: "probeResult",
                resultPacked: encodePacked(result),
              });
            }
          }
        }
      });
      const html = this.buildHtml(this.panel.webview);
      this.onDebugMessage("webview panel created, html length = " + html.length);
      this.onDebugMessage("html preview: " + html.substring(0, 200));
      this.panel.webview.html = html;
      this.onDebugMessage("webview html assigned");
    }
    this.panel.title = `CodeMap · ${graph.title}`;
    this.panel.reveal(vscode.ViewColumn.Two, false);
    this.clearNarration();
    this.clearDebugProbes();
    this.postGraph(graph);
  }

  private handleDrilldownFlowchart(groupId: string, label: string): void {
    const baseGraph =
      this.flowchartLayerStack.length > 0
        ? this.flowchartLayerStack[this.flowchartLayerStack.length - 1].graph
        : this.lastGraph;
    if (!baseGraph) return;
    const subgraph = extractFlowchartSubgraph(baseGraph, groupId);
    if (!subgraph) {
      this.onDebugMessage(`[drilldown] no subgraph found for group ${groupId}`);
      return;
    }
    this.flowchartLayerStack.push({ groupId, label, graph: subgraph });
    this.postFlowchartLayer();
  }

  private handleBreadcrumbNavigate(breadcrumbIndex: number): void {
    if (breadcrumbIndex < 0 || this.flowchartLayerStack.length === 0) {
      // Back to overview
      this.flowchartLayerStack = [];
      if (this.lastGraph) {
        this.postFlowchartLayer();
      }
      return;
    }
    // Trim stack to the requested depth (0-based index)
    this.flowchartLayerStack = this.flowchartLayerStack.slice(0, breadcrumbIndex + 1);
    this.postFlowchartLayer();
  }

  private postFlowchartLayer(): void {
    const isOverview = this.flowchartLayerStack.length === 0;
    const graph = isOverview
      ? this.lastGraph
      : this.flowchartLayerStack[this.flowchartLayerStack.length - 1].graph;
    if (!graph) return;
    const breadcrumb: BreadcrumbEntry[] = this.flowchartLayerStack.map((e) => ({
      groupId: e.groupId,
      label: e.label,
    }));
    this.panel?.webview.postMessage({
      type: "flowchartLayer",
      graph,
      breadcrumb,
      focusGroupId: isOverview ? null : this.flowchartLayerStack[this.flowchartLayerStack.length - 1].groupId,
    });
  }

  private postGraph(graph: GraphDocument): void {
    const numNodes = graph.nodes ? graph.nodes.length : 0;
    const numEdges = graph.edges ? graph.edges.length : 0;
    this.onDebugMessage(`postGraph ${graph.graphType} ${graph.title} (${numNodes} nodes, ${numEdges} edges)`);
    this.panel?.webview.postMessage({ type: "setGraph", graph });
  }

  postRuntimeFrame(frame: RuntimeFrameView | null, highlightNodeIds?: string[], breakpointNodeIds?: string[]): void {
    this.lastRuntime = { frame, highlightNodeIds, breakpointNodeIds };
    if (!this.panel) return;
    this.panel.webview.postMessage({
      type: "setRuntimeFrame",
      frame,
      highlightNodeIds,
      breakpointNodeIds,
    });
  }

  postNarrationScript(script: NarrationScript): void {
    this.lastNarration = script;
    this.panel?.webview.postMessage({
      type: "setNarrationScript",
      script,
    });
  }

  clearNarration(): void {
    this.lastNarration = undefined;
    this.panel?.webview.postMessage({ type: "clearNarration" });
  }

  postDebugProbes(probes: DebugProbe[]): void {
    const safeProbes = parseDebugProbeList(probes);
    this.lastDebugProbes = safeProbes;
    this.panel?.webview.postMessage({
      type: "setDebugProbes",
      probesPacked: encodePacked(safeProbes),
    });
  }

  postProbeResult(result: ProbeResult): void {
    const safeResult = parseProbeResult(result);
    this.lastProbeResults.set(safeResult.probeId, safeResult);
    this.panel?.webview.postMessage({
      type: "probeResult",
      resultPacked: encodePacked(safeResult),
    });
  }

  clearDebugProbes(nodeId?: string): void {
    if (!nodeId) {
      this.lastDebugProbes = [];
      this.lastProbeResults.clear();
    } else {
      this.lastDebugProbes = this.lastDebugProbes.filter((probe) => probe.nodeId !== nodeId);
      for (const [probeId, result] of this.lastProbeResults.entries()) {
        if (result.nodeId === nodeId) {
          this.lastProbeResults.delete(probeId);
        }
      }
    }
    this.panel?.webview.postMessage({ type: "clearDebugProbes", nodeId });
  }

  highlightProbeNode(nodeId: string): void {
    this.panel?.webview.postMessage({ type: "highlightProbeNode", nodeId });
  }

  updateUiState(state: UiStateView): void {
    this.uiState = state;
    this.postUiState();
  }

  isVisible(): boolean {
    return !!this.panel;
  }

  getCurrentGraph(): GraphDocument | undefined {
    return this.lastGraph;
  }

  getCurrentNarration(): NarrationScript | undefined {
    return this.lastNarration;
  }

  private postUiState(): void {
    this.panel?.webview.postMessage({ type: "setUiState", state: this.uiState });
  }

  private buildHtml(webview: vscode.Webview): string {
    const distRoot = vscode.Uri.file(
      path.join(this.context.extensionPath, "dist", "webview"),
    );
    const asUri = (root: vscode.Uri, rel: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(root, ...rel.split("/")));

    const cssUri = asUri(distRoot, "styles.css");
    const flowCssUri = asUri(distRoot, "main.css");
    const mainUri = asUri(distRoot, "main.js");
    const litegraphUri = asUri(distRoot, "litegraph.js");
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${cssUri}" />
  <link rel="stylesheet" href="${flowCssUri}" />
  <title>CodeMap</title>
</head>
<body>
  <div id="toolbar">
    <span class="title" id="title">CodeMap</span>
    <span class="sep"></span>
    <span class="info" id="stats"></span>
    <span class="sep"></span>
    <button class="btn exec" id="btn-exec">&#9654; auto trace</button>
    <button class="btn step" id="btn-step">&#9193; step-by-step</button>
    <label class="tick"><input id="toggle-ai" type="checkbox" checked /> AI</label>
    <label class="tick"><input id="toggle-function-calls" type="checkbox" checked /> function calls</label>
    <button class="btn" id="btn-narrate">narrate</button>
    <button class="btn" id="btn-reset">reset</button>
    <button class="btn" id="btn-clear">clear</button>
    <button class="btn" id="btn-refresh">&#x21bb; refresh</button>
    <label class="tick"><input id="toggle-overlay-legacy" type="checkbox" checked /> last-writer</label>
    <label class="tick"><input id="toggle-overlay-modern" type="checkbox" checked /> reaching-defs + interproc</label>
    <input id="search-box" type="text" placeholder="Search..." />
  </div>
  <div id="flowchart-breadcrumb" style="display:none;position:sticky;top:0;z-index:120;padding:5px 14px 4px;background:rgba(10,12,18,0.92);border-bottom:1px solid #2a3042;font-size:11px;font-family:Consolas,monospace;color:#7aa2f7;line-height:1.6;"></div>
  <div id="narration-root"></div>
  <div id="debug-overlay-root"></div>
  <div id="canvas"></div>
  <div id="canvas-controls">
    <button class="canvas-btn" id="btn-collapse-groups">collapse all</button>
    <button class="canvas-btn" id="btn-expand-groups">expand all</button>
  </div>
  <div id="tooltip"></div>
  <div id="legend">
    <div class="lg-title" id="lg-title">Modules</div>
    <div id="lg-items"></div>
  </div>
  <div id="exec-panel">
    <div class="ep-label" id="ep-label">Trace</div>
    <div class="ep-func" id="ep-func">&mdash;</div>
    <div class="ep-desc" id="ep-desc"></div>
    <div class="ep-step" id="ep-step"></div>
    <div class="ep-hint" id="ep-hint"></div>
  </div>
  <div id="runtime-panel" style="display:none;position:fixed;top:56px;right:14px;z-index:200;max-width:340px;padding:10px 12px;border:1px solid #2a3042;border-radius:8px;background:rgba(10,12,18,0.96);color:#c0caf5;font-family:Consolas, monospace;font-size:11px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35)">
    <div style="font-size:10px;color:#7aa2f7;margin-bottom:4px;font-weight:600">DEBUG &middot; LIVE</div>
    <div id="rt-frame" style="color:#9ece6a;font-weight:600;margin-bottom:4px">&mdash;</div>
    <div id="rt-source" style="color:#7d8590;margin-bottom:8px"></div>
    <div id="rt-vars" style="margin-bottom:6px"></div>
    <div id="rt-stack" style="border-top:1px solid #2a3042;padding-top:6px;color:#7d8590;font-size:10px"></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      window.__codemapVscode = vscode;
      window.addEventListener("error", function (event) {
        vscode.postMessage({ type: "debug", message: "runtime error: " + event.message });
      });
      window.addEventListener("unhandledrejection", function (event) {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        vscode.postMessage({ type: "debug", message: "promise rejection: " + reason });
      });
    })();
  </script>
  <script nonce="${nonce}" src="${litegraphUri}"></script>
  <script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
  }
}

function encodePacked(value: unknown): string {
  return Buffer.from(pack(value)).toString("base64");
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Group descriptor as stored in GraphDocument.metadata.groups */
interface GroupMeta {
  id: string;
  kind: string;
  label: string;
  nodeIds: string[];
  parentGroupId: string | null;
}

interface FlowchartBoundaryIndicator {
  nodeId: string;
  side: "top" | "bottom";
  direction: "incoming" | "outgoing";
  label?: string;
}

/**
 * Extract a focused subgraph for `groupId` from `graph`.
 * Returns a new GraphDocument containing only the nodes and edges that belong
 * to the selected group (and its nested sub-groups), or null if the group is
 * not found or is empty.
 */
function extractFlowchartSubgraph(graph: GraphDocument, groupId: string): GraphDocument | null {
  const groups: GroupMeta[] = ((graph.metadata?.groups as GroupMeta[]) ?? []);
  const target = groups.find((g) => g.id === groupId);
  if (!target || !target.nodeIds || target.nodeIds.length === 0) return null;

  // Collect this group and all descendant groups recursively
  const descGroupIds = new Set<string>([groupId]);
  function addDescendants(gid: string): void {
    for (const g of groups) {
      if (g.parentGroupId === gid && !descGroupIds.has(g.id)) {
        descGroupIds.add(g.id);
        addDescendants(g.id);
      }
    }
  }
  addDescendants(groupId);

  // Build the node-id set from all collected groups
  const nodeIdSet = new Set<string>();
  for (const g of groups) {
    if (descGroupIds.has(g.id)) {
      for (const nid of g.nodeIds) nodeIdSet.add(nid);
    }
  }

  // For loop body groups: strip the direct header node (the loop-kind entry point with no
  // non-back-edge incoming from within the target group).  This mirrors what the
  // browser's simplifyAlphabetFlowGraph does — the header stays visible at the parent
  // layer; the drilldown shows only the body.
  if (target.kind === "loop" || target.kind === "loop_body") {
    const targetNodeSet = new Set(target.nodeIds);
    for (const nodeId of targetNodeSet) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node?.kind !== "loop") continue;
      const hasNonBackInternalIncoming = graph.edges.some(
        (e) =>
          e.to === nodeId &&
          targetNodeSet.has(e.from) &&
          e.label !== "repeat" &&
          e.label !== "continue",
      );
      if (!hasNonBackInternalIncoming) {
        nodeIdSet.delete(nodeId);
        break; // only one header per loop group
      }
    }
  }

  const subNodes = graph.nodes.filter((n) => nodeIdSet.has(n.id));
  const subEdges = graph.edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));
  const externalIncomingEdges = graph.edges.filter((e) => nodeIdSet.has(e.to) && !nodeIdSet.has(e.from));
  const externalOutgoingEdges = graph.edges.filter((e) => nodeIdSet.has(e.from) && !nodeIdSet.has(e.to));
  const boundaryGraph = buildBoundaryProxyGraph(graph, subNodes, externalIncomingEdges, externalOutgoingEdges);
  // Exclude the target group itself — its contents become the new top-level scope so
  // it does not re-collapse at depth-0 in the drilldown render.
  const subGroups = groups.filter((g) => descGroupIds.has(g.id) && g.id !== groupId);

  if (subNodes.length === 0 && boundaryGraph.nodes.length === 0) return null;

  // Root = first node with no incoming edge within the subgraph
  const nodes = [...boundaryGraph.nodes, ...subNodes];
  const edges = [...boundaryGraph.edges, ...subEdges];
  const hasIncoming = new Set(edges.map((e) => e.to));
  const rootNode = nodes.find((n) => !hasIncoming.has(n.id)) ?? nodes[0];

  return {
    graphType: "flowchart",
    title: target.label ?? groupId,
    subtitle: graph.subtitle,
    nodes,
    edges,
    rootNodeIds: [rootNode.id],
    metadata: {
      ...(graph.metadata ?? {}),
      groups: subGroups,
      focusGroupId: groupId,
    },
  };
}

function buildBoundaryProxyGraph(
  graph: GraphDocument,
  subNodes: GraphDocument["nodes"],
  incomingEdges: GraphDocument["edges"],
  outgoingEdges: GraphDocument["edges"],
): { nodes: GraphDocument["nodes"]; edges: GraphDocument["edges"] } {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoingById = new Map<string, GraphDocument["edges"]>();
  const incomingById = new Map<string, GraphDocument["edges"]>();
  graph.edges.forEach((edge) => {
    if (!outgoingById.has(edge.from)) outgoingById.set(edge.from, []);
    if (!incomingById.has(edge.to)) incomingById.set(edge.to, []);
    outgoingById.get(edge.from)!.push(edge);
    incomingById.get(edge.to)!.push(edge);
  });

  const shouldSkipNode = (node: GraphDocument["nodes"][number] | undefined): boolean => {
    if (!node) return true;
    if (node.kind === "loop_else") return true;
    if (node.kind !== "process") return false;
    const label = String(node.label || "").trim().toLowerCase();
    return label === "after loop" || label === "•";
  };

  const normalizeLoopLabel = (label: string | undefined): string | undefined => {
    const text = String(label || "").trim().toLowerCase();
    if (!text) return undefined;
    if (text === "continue" || text.endsWith("/continue")) return "continue";
    if (text === "repeat" || text.endsWith("/repeat")) return "repeat";
    return String(label).trim();
  };

  const resolveProxyNode = (nodeId: string, direction: "incoming" | "outgoing") => {
    let currentId = nodeId;
    const seen = new Set<string>();
    while (!seen.has(currentId)) {
      seen.add(currentId);
      const current = nodeById.get(currentId);
      if (!shouldSkipNode(current)) return current;
      const nextEdges = direction === "incoming" ? (incomingById.get(currentId) || []) : (outgoingById.get(currentId) || []);
      if (nextEdges.length !== 1) return current;
      currentId = direction === "incoming" ? nextEdges[0].from : nextEdges[0].to;
    }
    return nodeById.get(nodeId);
  };

  const proxyNodes = new Map<string, GraphDocument["nodes"][number]>();
  const proxyEdges: GraphDocument["edges"] = [];
  const seenEdgeKeys = new Set<string>();
  const sourceToProxyId = new Map<string, string>();

  const ensureProxyNode = (externalNodeId: string, direction: "incoming" | "outgoing") => {
    const resolved = resolveProxyNode(externalNodeId, direction);
    const sourceNode = resolved || nodeById.get(externalNodeId);
    if (!sourceNode) return null;
    const proxyId = `boundary:${sourceNode.id}`;
    if (!proxyNodes.has(proxyId)) {
      proxyNodes.set(proxyId, {
        ...sourceNode,
        id: proxyId,
        metadata: {
          ...(sourceNode.metadata || {}),
          boundaryProxy: true,
          boundaryDirection: direction,
          sourceNodeId: sourceNode.id,
        },
      });
    }
    sourceToProxyId.set(sourceNode.id, proxyId);
    return proxyId;
  };

  incomingEdges.forEach((edge) => {
    const proxyId = ensureProxyNode(edge.from, "incoming");
    if (!proxyId) return;
    const label = normalizeLoopLabel(edge.label);
    const key = `${proxyId}->${edge.to}::${label || ""}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    proxyEdges.push({
      ...edge,
      id: `boundary_in_${proxyId}_${edge.to}_${proxyEdges.length}`,
      from: proxyId,
      to: edge.to,
      ...(label ? { label } : {}),
      metadata: { ...(edge.metadata || {}), boundaryProxyEdge: true },
    });
  });

  outgoingEdges.forEach((edge) => {
    const proxyId = ensureProxyNode(edge.to, "outgoing");
    if (!proxyId) return;
    const label = normalizeLoopLabel(edge.label);
    const key = `${edge.from}->${proxyId}::${label || ""}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    proxyEdges.push({
      ...edge,
      id: `boundary_out_${edge.from}_${proxyId}_${proxyEdges.length}`,
      from: edge.from,
      to: proxyId,
      ...(label ? { label } : {}),
      metadata: { ...(edge.metadata || {}), boundaryProxyEdge: true },
    });
  });

  graph.edges.forEach((edge) => {
    const fromProxyId = sourceToProxyId.get(edge.from);
    const toProxyId = sourceToProxyId.get(edge.to);
    if (!fromProxyId || !toProxyId || fromProxyId === toProxyId) return;
    const label = normalizeLoopLabel(edge.label);
    const key = `${fromProxyId}->${toProxyId}::${label || ""}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    proxyEdges.push({
      ...edge,
      id: `boundary_link_${fromProxyId}_${toProxyId}_${proxyEdges.length}`,
      from: fromProxyId,
      to: toProxyId,
      ...(label ? { label } : {}),
      metadata: { ...(edge.metadata || {}), boundaryProxyEdge: true, boundaryProxyLink: true },
    });
  });

  return {
    nodes: Array.from(proxyNodes.values()).filter((node) => !subNodes.some((entry) => entry.id === node.id)),
    edges: proxyEdges,
  };
}
