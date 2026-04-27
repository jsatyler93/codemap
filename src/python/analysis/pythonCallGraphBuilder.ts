import { GraphDocument, GraphEdge, GraphNode, NavigationPathEntry, ZoomContext } from "../model/graphTypes";
import { PyAnalysisResult, PySymbol } from "../model/symbolTypes";

interface ExternalCallNodeSeed {
  id: string;
  label: string;
  detail: string;
  module: string;
}

/**
 * Locate the symbol whose source range contains the given file/line.
 * Prefers the innermost function/method.
 */
export function findSymbolAt(
  analysis: PyAnalysisResult,
  file: string,
  line: number,
): PySymbol | undefined {
  let best: PySymbol | undefined;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const sym of Object.values(analysis.symbols)) {
    if (sym.kind === "module") {
      continue;
    }
    if (sym.file !== file) {
      continue;
    }
    const start = sym.source.line;
    const end = sym.source.endLine ?? start;
    if (line < start || line > end) {
      continue;
    }
    const size = end - start;
    if (
      size < bestSize ||
      // tie-break: prefer functions/methods over classes
      (size === bestSize && (sym.kind === "function" || sym.kind === "method"))
    ) {
      best = sym;
      bestSize = size;
    }
  }
  return best;
}

interface BuildOptions {
  depth?: number;          // default 1
  includeCallers?: boolean; // default true
  includeCallees?: boolean; // default true
}

/** Symbol-centric call graph rooted at `rootId`. */
export function buildSymbolCallGraph(
  analysis: PyAnalysisResult,
  rootId: string,
  opts: BuildOptions = {},
): GraphDocument {
  const depth = opts.depth ?? 1;
  const includeCallers = opts.includeCallers ?? true;
  const includeCallees = opts.includeCallees ?? true;

  const root = analysis.symbols[rootId];
  if (!root) {
    return emptyGraph("callgraph", "Unknown symbol");
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const addNode = (sym: PySymbol) => {
    if (nodes.has(sym.id)) return;
    nodes.set(sym.id, symbolToNode(sym));
  };
  const addEdge = (from: string, to: string, resolution: "resolved" | "likely" | "unresolved") => {
    const key = `${from}->${to}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({
      id: `e_${edges.length}`,
      from,
      to,
      kind: "calls",
      resolution,
    });
  };

  addNode(root);

  if (includeCallees) {
    expandCallees(analysis, root, depth, addNode, addEdge);
  }
  if (includeCallers) {
    expandCallers(analysis, root, depth, addNode, addEdge);
  }

  return {
    graphType: "callgraph",
    title: root.qualifiedName,
    subtitle: `${root.module} · depth=${depth}`,
    nodes: Array.from(nodes.values()),
    edges,
    rootNodeIds: [root.id],
    metadata: {
      module: root.module,
      analysisSummary: analysis.summary,
    },
  };
}

function expandCallees(
  analysis: PyAnalysisResult,
  root: PySymbol,
  depth: number,
  addNode: (s: PySymbol) => void,
  addEdge: (from: string, to: string, r: "resolved" | "likely" | "unresolved") => void,
): void {
  const queue: { sym: PySymbol; d: number }[] = [{ sym: root, d: 0 }];
  const visited = new Set<string>([root.id]);
  while (queue.length) {
    const { sym, d } = queue.shift()!;
    if (d >= depth) continue;
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target) continue;
      addNode(target);
      addEdge(sym.id, target.id, call.resolution);
      if (!visited.has(target.id)) {
        visited.add(target.id);
        queue.push({ sym: target, d: d + 1 });
      }
    }
  }
}

function expandCallers(
  analysis: PyAnalysisResult,
  root: PySymbol,
  depth: number,
  addNode: (s: PySymbol) => void,
  addEdge: (from: string, to: string, r: "resolved" | "likely" | "unresolved") => void,
): void {
  // Build reverse index lazily.
  const rev = buildReverseIndex(analysis);
  const queue: { id: string; d: number }[] = [{ id: root.id, d: 0 }];
  const visited = new Set<string>([root.id]);
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (d >= depth) continue;
    const callers = rev.get(id) ?? [];
    for (const callerId of callers) {
      const caller = analysis.symbols[callerId];
      if (!caller) continue;
      addNode(caller);
      addEdge(callerId, id, "resolved");
      if (!visited.has(callerId)) {
        visited.add(callerId);
        queue.push({ id: callerId, d: d + 1 });
      }
    }
  }
}

function buildReverseIndex(analysis: PyAnalysisResult): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const sym of Object.values(analysis.symbols)) {
    for (const call of sym.calls) {
      if (call.resolvedTo) {
        const arr = rev.get(call.resolvedTo) ?? [];
        arr.push(sym.id);
        rev.set(call.resolvedTo, arr);
      }
    }
  }
  return rev;
}

/** Workspace-wide module/symbol graph. Attaches a ZoomContext at level 2 (symbol scope)
 * so the webview can navigate up to packages (L0) or drill into flowcharts (L3). */
export function buildWorkspaceGraph(
  analysis: PyAnalysisResult,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  for (const sym of Object.values(analysis.symbols)) {
    if (sym.kind === "module") continue;
    nodes.push(symbolToNode(sym));
  }

  for (const sym of Object.values(analysis.symbols)) {
    if (sym.kind === "module") continue;
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      if (!analysis.symbols[call.resolvedTo]) continue;
      const key = `${sym.id}->${call.resolvedTo}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({
        id: `e_${edges.length}`,
        from: sym.id,
        to: call.resolvedTo,
        kind: "calls",
        resolution: call.resolution,
      });
    }
  }

  const colorMap = moduleColorMap ?? {};
  const navigationPath: NavigationPathEntry[] = [
    { level: 0, label: "Workspace", id: "root" },
  ];
  const zoomContext: ZoomContext = {
    level: 2,
    navigationPath,
    peripherals: [],
    moduleColorMap: colorMap,
  };

  // ── Embed execution timeline via DFS from best entry point ──
  const execTimeline: { edge: [string, string]; label: string; desc: string }[] = [];
  const incomingCount: Record<string, number> = {};
  const outgoingCount: Record<string, number> = {};
  for (const n of nodes) { incomingCount[n.id] = 0; outgoingCount[n.id] = 0; }
  for (const e of edges) {
    incomingCount[e.to] = (incomingCount[e.to] || 0) + 1;
    outgoingCount[e.from] = (outgoingCount[e.from] || 0) + 1;
  }
  // Prefer a node named "main", else zero-incoming with most outgoing
  const nodeIds = nodes.map((n) => n.id);
  let entryId = nodeIds.find((id) => {
    const sym = analysis.symbols[id];
    return sym && (sym.name === "main" || sym.qualifiedName?.endsWith(".main"));
  });
  if (!entryId) {
    const zeroIncoming = nodeIds.filter((id) => (incomingCount[id] || 0) === 0);
    if (zeroIncoming.length > 0) {
      zeroIncoming.sort((a, b) => (outgoingCount[b] || 0) - (outgoingCount[a] || 0));
      entryId = zeroIncoming[0];
    } else if (nodeIds.length > 0) {
      entryId = nodeIds[0];
    }
  }
  if (entryId) {
    const adj: Record<string, { to: string; label: string }[]> = {};
    for (const e of edges) {
      if (!adj[e.from]) adj[e.from] = [];
      adj[e.from].push({ to: e.to, label: e.label || "" });
    }
    const visiting = new Set<string>();
    const maxSteps = 200;
    function traceWalk(nodeId: string): void {
      if (execTimeline.length >= maxSteps) return;
      visiting.add(nodeId);
      for (const child of (adj[nodeId] || [])) {
        if (execTimeline.length >= maxSteps) break;
        const targetNode = nodes.find((n) => n.id === child.to);
        const label = targetNode ? (targetNode.label || child.to) : child.to;
        const desc = targetNode?.metadata?.docSummary as string || "";
        execTimeline.push({ edge: [nodeId, child.to], label, desc });
        if (!visiting.has(child.to)) {
          traceWalk(child.to);
        }
      }
      visiting.delete(nodeId);
    }
    traceWalk(entryId);
  }

  return {
    graphType: "workspace",
    title: "Python workspace",
    subtitle: `${nodes.length} symbols · ${edges.length} call edges`,
    nodes,
    edges,
    metadata: {
      zoomContext,
      moduleCount: Object.keys(analysis.modules).length,
      analysisSummary: analysis.summary,
      execTimeline,
      moduleColors: colorMap,
    },
  };
}

export function buildFileCallGraph(
  analysis: PyAnalysisResult,
  file: string,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const targetFile = normalizePath(file);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const localNodeIds = new Set<string>();
  const dependencyNodeIds = new Set<string>();

  const moduleSymbol = Object.values(analysis.symbols).find(
    (sym) => sym.kind === "module" && normalizePath(sym.file) === targetFile,
  );

  const addNode = (node: GraphNode, local = false) => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
    if (local) {
      localNodeIds.add(node.id);
    }
  };

  const addSymbolNode = (sym: PySymbol, local = false) => {
    addNode(symbolToNode(sym), local);
  };

  const addExternalNode = (targetText: string) => {
    const seed = externalNodeSeed(targetText);
    if (!nodes.has(seed.id)) {
      nodes.set(seed.id, {
        id: seed.id,
        kind: "function",
        label: seed.label,
        detail: seed.detail,
        module: seed.module,
        styleCategory: seed.module,
        metadata: {
          external: true,
          externalTarget: seed.detail,
          docSummary: "External dependency",
        },
      });
    }
    dependencyNodeIds.add(seed.id);
    return seed.id;
  };

  const addEdge = (
    from: string,
    to: string,
    resolution: "resolved" | "likely" | "unresolved",
    label?: string,
    metadata?: Record<string, unknown>,
  ) => {
    const key = `${from}->${to}::${resolution}::${label || ""}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({
      id: `e_${edges.length}`,
      from,
      to,
      kind: "calls",
      resolution,
      label,
      metadata,
    });
  };

  for (const sym of Object.values(analysis.symbols)) {
    if (normalizePath(sym.file) === targetFile) {
      addSymbolNode(sym, true);
    }
  }

  const localSymbolIds = new Set(localNodeIds);

  for (const sym of Object.values(analysis.symbols)) {
    const isLocalSource = localSymbolIds.has(sym.id);
    const isExternalSource = !isLocalSource;
    for (const call of sym.calls) {
      const externalTarget = typeof call.externalTarget === "string" ? call.externalTarget.trim() : "";
      const shouldIncludeIncomingResolved = !!call.resolvedTo && localSymbolIds.has(call.resolvedTo) && isExternalSource;
      const shouldIncludeOutgoingFromLocal = isLocalSource;
      if (!shouldIncludeOutgoingFromLocal && !shouldIncludeIncomingResolved) {
        continue;
      }

      if (call.resolvedTo) {
        const target = analysis.symbols[call.resolvedTo];
        if (!target) continue;
        addSymbolNode(sym, isLocalSource);
        addSymbolNode(target, localSymbolIds.has(target.id));
        if (!localSymbolIds.has(target.id)) {
          dependencyNodeIds.add(target.id);
        }
        addEdge(sym.id, target.id, call.resolution, call.text, {
          resolutionSource: call.resolutionSource,
          confidence: call.confidence,
        });
        continue;
      }

      if (!shouldIncludeOutgoingFromLocal) continue;
      if (!externalTarget || call.resolutionSource === "builtin") continue;
      addSymbolNode(sym, true);
      const externalId = addExternalNode(externalTarget);
      addEdge(sym.id, externalId, call.resolution, call.text, {
        resolutionSource: call.resolutionSource,
        confidence: call.confidence,
        externalTarget,
      });
    }
  }

  const graphNodes = Array.from(nodes.values());
  const rootNodeIds = moduleSymbol ? [moduleSymbol.id] : computeFileRoots(graphNodes, edges, localSymbolIds);
  const execTimeline = buildExecutionTimeline(graphNodes, edges, rootNodeIds[0]);
  const moduleColors = filterModuleColors(moduleColorMap ?? {}, graphNodes);

  return {
    graphType: "callgraph",
    title: `File call graph: ${file.split(/[\\/]/).pop() || file}`,
    subtitle: `${file} · ${Math.max(0, localSymbolIds.size - (moduleSymbol ? 1 : 0))} local symbols + ${dependencyNodeIds.size} external deps · ${edges.length} call edges`,
    nodes: graphNodes,
    edges,
    rootNodeIds,
    metadata: {
      analysisSummary: analysis.summary,
      fileScope: file,
      includeExternalDependencies: true,
      moduleColors,
      execTimeline,
    },
  };
}

/** Approximate static execution trace rooted at a function. */
export function buildStaticTrace(
  analysis: PyAnalysisResult,
  rootId: string,
  maxSteps = 200,
): GraphDocument {
  const root = analysis.symbols[rootId];
  if (!root) return emptyGraph("trace", "Unknown symbol");

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const stepOrder: string[] = [];
  const visiting = new Set<string>();

  function visit(sym: PySymbol, parent: string | null): void {
    if (stepOrder.length >= maxSteps) return;
    if (visiting.has(sym.id)) {
      // Cycle: still record the edge but don't recurse.
      if (parent) {
        edges.push({
          id: `e_${edges.length}`,
          from: parent,
          to: sym.id,
          kind: "execution_step",
          label: `${stepOrder.length + 1} (cycle)`,
        });
      }
      return;
    }
    nodes.set(sym.id, symbolToNode(sym));
    if (parent) {
      edges.push({
        id: `e_${edges.length}`,
        from: parent,
        to: sym.id,
        kind: "execution_step",
        label: String(stepOrder.length + 1),
      });
    }
    stepOrder.push(sym.id);
    visiting.add(sym.id);
    // Calls are already in source order in the AST output.
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target) continue;
      if (target.kind !== "function" && target.kind !== "method") continue;
      visit(target, sym.id);
      if (stepOrder.length >= maxSteps) break;
    }
    visiting.delete(sym.id);
  }

  visit(root, null);

  return {
    graphType: "trace",
    title: `Static trace: ${root.qualifiedName}`,
    subtitle: "Approximate ordered traversal · Based on static analysis",
    nodes: Array.from(nodes.values()),
    edges,
    rootNodeIds: [root.id],
    metadata: {
      steps: stepOrder.length,
      truncated: stepOrder.length >= maxSteps,
      analysisSummary: analysis.summary,
    },
  };
}

function symbolToNode(sym: PySymbol): GraphNode {
  return {
    id: sym.id,
    kind: sym.kind === "module" ? "module" : sym.kind === "class" ? "class" : sym.kind === "method" ? "method" : "function",
    label: sym.name,
    detail: sym.qualifiedName,
    module: sym.module,
    className: sym.className,
    source: sym.source,
    styleCategory: sym.module,
    metadata: {
      isAsync: sym.isAsync ?? false,
      decorators: sym.decorators ?? [],
      params: sym.params ?? [],
      returnType: sym.returnType,
      returnTypeSource: sym.returnTypeSource,
      returnTypeConfidence: sym.returnTypeConfidence,
      docSummary: sym.docSummary,
      methodKind: sym.methodKind,
      bases: sym.bases,
      classAttributes: sym.classAttributes,
      instanceAttributes: sym.instanceAttributes,
    },
  };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function externalNodeSeed(targetText: string): ExternalCallNodeSeed {
  const detail = targetText.trim();
  const parts = detail.split(".").filter(Boolean);
  const label = parts[parts.length - 1] || detail || "external";
  const module = parts.length > 1 ? parts.slice(0, -1).join(".") : "external";
  return {
    id: `external:${detail}`,
    label,
    detail,
    module,
  };
}

function computeFileRoots(nodes: GraphNode[], edges: GraphEdge[], localSymbolIds: Set<string>): string[] {
  const incoming = new Set(edges.map((edge) => edge.to));
  const roots = nodes
    .filter((node) => localSymbolIds.has(node.id) && !incoming.has(node.id))
    .map((node) => node.id);
  if (roots.length) return roots;
  const firstLocal = nodes.find((node) => localSymbolIds.has(node.id));
  return firstLocal ? [firstLocal.id] : [];
}

function buildExecutionTimeline(
  nodes: GraphNode[],
  edges: GraphEdge[],
  entryId?: string,
  maxSteps = 200,
): Array<{ edge: [string, string]; label: string; desc: string }> {
  if (!entryId) return [];
  const timeline: Array<{ edge: [string, string]; label: string; desc: string }> = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adj = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const arr = adj.get(edge.from) ?? [];
    arr.push(edge);
    adj.set(edge.from, arr);
  }
  const visiting = new Set<string>();
  const visit = (nodeId: string) => {
    if (timeline.length >= maxSteps) return;
    visiting.add(nodeId);
    for (const edge of adj.get(nodeId) ?? []) {
      if (timeline.length >= maxSteps) break;
      const target = byId.get(edge.to);
      timeline.push({
        edge: [edge.from, edge.to],
        label: target?.label || edge.to,
        desc: String(target?.metadata?.docSummary ?? target?.detail ?? ""),
      });
      if (!visiting.has(edge.to)) {
        visit(edge.to);
      }
    }
    visiting.delete(nodeId);
  };
  visit(entryId);
  return timeline;
}

function filterModuleColors(colors: Record<string, string>, nodes: GraphNode[]): Record<string, string> {
  const modules = new Set(nodes.map((node) => node.module).filter((v): v is string => !!v));
  const filtered: Record<string, string> = {};
  for (const [moduleName, color] of Object.entries(colors)) {
    if (modules.has(moduleName)) {
      filtered[moduleName] = color;
    }
  }
  return filtered;
}

function emptyGraph(graphType: GraphDocument["graphType"], title: string): GraphDocument {
  return { graphType, title, nodes: [], edges: [] };
}
