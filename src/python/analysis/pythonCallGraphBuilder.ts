import { GraphDocument, GraphEdge, GraphNode } from "../model/graphTypes";
import { PyAnalysisResult, PySymbol } from "../model/symbolTypes";

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

/** Workspace-wide module/symbol graph. */
export function buildWorkspaceGraph(analysis: PyAnalysisResult): GraphDocument {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  for (const sym of Object.values(analysis.symbols)) {
    if (sym.kind === "module") continue;
    nodes.push(symbolToNode(sym));
  }

  for (const sym of Object.values(analysis.symbols)) {
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

  return {
    graphType: "workspace",
    title: "Python workspace",
    subtitle: `${nodes.length} symbols · ${edges.length} call edges`,
    nodes,
    edges,
    metadata: {
      moduleCount: Object.keys(analysis.modules).length,
      analysisSummary: analysis.summary,
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
      docSummary: sym.docSummary,
      methodKind: sym.methodKind,
      bases: sym.bases,
      classAttributes: sym.classAttributes,
      instanceAttributes: sym.instanceAttributes,
    },
  };
}

function emptyGraph(graphType: GraphDocument["graphType"], title: string): GraphDocument {
  return { graphType, title, nodes: [], edges: [] };
}
