// Language-agnostic graph builder that uses VS Code's built-in providers
// (call hierarchy, document symbols, hover) instead of our own analyzer.
//
// Works for any language that ships a language server providing those APIs
// (TypeScript, Python via Pylance, Rust, Go, C#, etc.).

import * as path from "path";
import * as vscode from "vscode";
import { GraphDocument, GraphEdge, GraphNode, NodeKind } from "../python/model/graphTypes";

const CALL_HIERARCHY_TIMEOUT_MS = 4000;
const HOVER_TIMEOUT_MS = 1500;
const DEFAULT_DEPTH = 2;
const MAX_NODES = 250;

interface HierarchyVisitState {
  visited: Set<string>;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  hoverPromises: Promise<void>[];
}

function symbolKindToNodeKind(kind: vscode.SymbolKind): NodeKind {
  switch (kind) {
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return "method";
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Struct:
      return "class";
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
    case vscode.SymbolKind.Package:
    case vscode.SymbolKind.File:
      return "module";
    case vscode.SymbolKind.Function:
    default:
      return "function";
  }
}

function makeId(uri: vscode.Uri, name: string, line: number): string {
  return `${uri.fsPath}::${name}::${line}`;
}

function ensureNode(state: HierarchyVisitState, item: vscode.CallHierarchyItem): GraphNode {
  const id = makeId(item.uri, item.name, item.range.start.line);
  let existing = state.nodes.get(id);
  if (existing) return existing;
  const node: GraphNode = {
    id,
    kind: symbolKindToNodeKind(item.kind),
    label: item.name,
    detail: item.detail || "",
    source: {
      file: item.uri.fsPath,
      line: item.range.start.line + 1,
      column: item.range.start.character,
      endLine: item.range.end.line + 1,
      endColumn: item.range.end.character,
    },
    metadata: {
      symbolKind: vscode.SymbolKind[item.kind],
      provider: "vscode-call-hierarchy",
    },
  };
  state.nodes.set(id, node);
  // Kick off hover-based type enrichment in parallel.
  state.hoverPromises.push(
    enrichNodeWithHover(node, item.uri, item.selectionRange.start).catch(() => {
      /* swallow */
    }),
  );
  return node;
}

async function enrichNodeWithHover(
  node: GraphNode,
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<void> {
  const hovers = await withTimeout(
    vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position,
    ),
    HOVER_TIMEOUT_MS,
  );
  if (!Array.isArray(hovers) || hovers.length === 0) return;
  const text = hovers
    .flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value)))
    .join("\n")
    .trim();
  if (!text) return;
  const meta = (node.metadata = node.metadata || {});
  meta.hover = text.length > 800 ? text.slice(0, 800) + "..." : text;
  // Try to extract a one-line signature from the hover.
  const sig = extractSignature(text, node.label);
  if (sig) {
    meta.signature = sig;
    if (!node.detail) node.detail = sig;
  }
}

function extractSignature(hover: string, name: string): string | undefined {
  // Pull out the first fenced code block content if present.
  const fence = /```[\w-]*\n([\s\S]*?)```/m.exec(hover);
  const body = fence ? fence[1] : hover;
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.includes(name) && (line.includes("(") || line.includes(":"))) {
      return line.length > 200 ? line.slice(0, 200) + "..." : line;
    }
  }
  return lines[0];
}

async function visitCalls(
  state: HierarchyVisitState,
  item: vscode.CallHierarchyItem,
  depth: number,
  direction: "out" | "in" | "both",
): Promise<void> {
  if (depth <= 0) return;
  if (state.nodes.size > MAX_NODES) return;
  const nodeKey = makeId(item.uri, item.name, item.range.start.line);
  const visitKey = `${nodeKey}::${direction}`;
  if (state.visited.has(visitKey)) return;
  state.visited.add(visitKey);
  ensureNode(state, item);

  const tasks: Promise<unknown>[] = [];

  if (direction === "out" || direction === "both") {
    tasks.push(
      withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          "vscode.provideOutgoingCalls",
          item,
        ),
        CALL_HIERARCHY_TIMEOUT_MS,
      )
        .then(async (outgoing) => {
          if (!Array.isArray(outgoing)) return;
          for (const call of outgoing) {
            const calleeNode = ensureNode(state, call.to);
            state.edges.push({
              id: `e_${state.edges.length}_${nodeKey}->${calleeNode.id}`,
              from: nodeKey,
              to: calleeNode.id,
              kind: "calls",
              resolution: "resolved",
              metadata: { callCount: call.fromRanges.length },
            });
            await visitCalls(state, call.to, depth - 1, "out");
          }
        })
        .catch(() => {
          /* swallow per-edge failures */
        }),
    );
  }

  if (direction === "in" || direction === "both") {
    tasks.push(
      withTimeout(
        vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          "vscode.provideIncomingCalls",
          item,
        ),
        CALL_HIERARCHY_TIMEOUT_MS,
      )
        .then(async (incoming) => {
          if (!Array.isArray(incoming)) return;
          for (const call of incoming) {
            const callerNode = ensureNode(state, call.from);
            state.edges.push({
              id: `e_${state.edges.length}_${callerNode.id}->${nodeKey}`,
              from: callerNode.id,
              to: nodeKey,
              kind: "calls",
              resolution: "resolved",
              metadata: { callCount: call.fromRanges.length },
            });
            await visitCalls(state, call.from, depth - 1, "in");
          }
        })
        .catch(() => {
          /* swallow */
        }),
    );
  }

  await Promise.all(tasks);
}

export interface LiveCallGraphOptions {
  depth?: number;
  direction?: "out" | "in" | "both";
}

export async function buildLiveCallGraph(
  uri: vscode.Uri,
  position: vscode.Position,
  options: LiveCallGraphOptions = {},
): Promise<GraphDocument> {
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
  const direction = options.direction ?? "both";

  const roots = await withTimeout(
    vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      "vscode.prepareCallHierarchy",
      uri,
      position,
    ),
    CALL_HIERARCHY_TIMEOUT_MS,
  );
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(
      "No call hierarchy at cursor. Place the cursor on a function/method name.",
    );
  }

  const state: HierarchyVisitState = {
    visited: new Set(),
    nodes: new Map(),
    edges: [],
    hoverPromises: [],
  };

  const rootIds: string[] = [];
  for (const root of roots) {
    const rootNode = ensureNode(state, root);
    rootIds.push(rootNode.id);
    rootNode.metadata = { ...(rootNode.metadata || {}), isRoot: true };
    await visitCalls(state, root, depth, direction);
  }

  // Wait briefly for hover enrichment, but don't block forever.
  await Promise.race([
    Promise.all(state.hoverPromises),
    new Promise((res) => setTimeout(res, HOVER_TIMEOUT_MS + 500)),
  ]);

  const rootName = roots[0].name;
  const rootFile = path.basename(roots[0].uri.fsPath);
  return {
    graphType: "callgraph",
    title: rootName,
    subtitle: `${rootFile}:${roots[0].range.start.line + 1} · live (vscode call hierarchy)`,
    nodes: Array.from(state.nodes.values()),
    edges: state.edges,
    rootNodeIds: rootIds,
    metadata: {
      mode: "live",
      provider: "vscode-call-hierarchy",
      depth,
      direction,
      truncated: state.nodes.size > MAX_NODES,
    },
  };
}

export async function buildLiveOutline(uri: vscode.Uri): Promise<GraphDocument> {
  const symbols = await withTimeout(
    vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    ),
    CALL_HIERARCHY_TIMEOUT_MS,
  );
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("No symbols found in this document.");
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileNode: GraphNode = {
    id: `module::${uri.fsPath}`,
    kind: "module",
    label: path.basename(uri.fsPath),
    source: { file: uri.fsPath, line: 1 },
    metadata: { provider: "vscode-document-symbols", isRoot: true },
  };
  nodes.push(fileNode);

  function visit(symbol: vscode.DocumentSymbol, parentId: string): void {
    const id = `${uri.fsPath}::${symbol.name}::${symbol.range.start.line}`;
    const node: GraphNode = {
      id,
      kind: symbolKindToNodeKind(symbol.kind),
      label: symbol.name,
      detail: symbol.detail || vscode.SymbolKind[symbol.kind],
      source: {
        file: uri.fsPath,
        line: symbol.range.start.line + 1,
        column: symbol.range.start.character,
        endLine: symbol.range.end.line + 1,
        endColumn: symbol.range.end.character,
      },
      metadata: {
        symbolKind: vscode.SymbolKind[symbol.kind],
        provider: "vscode-document-symbols",
      },
    };
    nodes.push(node);
    edges.push({
      id: `contain_${edges.length}_${parentId}->${id}`,
      from: parentId,
      to: id,
      kind: "contains",
    });
    if (symbol.children && symbol.children.length > 0) {
      for (const child of symbol.children) {
        visit(child, id);
      }
    }
  }

  // Detect doc-symbol vs symbol-info.
  const first = symbols[0] as { children?: unknown };
  if (Array.isArray(first.children) || first.children === undefined) {
    for (const sym of symbols as vscode.DocumentSymbol[]) {
      visit(sym, fileNode.id);
    }
  } else {
    for (const info of symbols as vscode.SymbolInformation[]) {
      const id = `${uri.fsPath}::${info.name}::${info.location.range.start.line}`;
      nodes.push({
        id,
        kind: symbolKindToNodeKind(info.kind),
        label: info.name,
        detail: info.containerName || vscode.SymbolKind[info.kind],
        source: {
          file: info.location.uri.fsPath,
          line: info.location.range.start.line + 1,
        },
        metadata: { provider: "vscode-document-symbols" },
      });
      edges.push({
        id: `contain_${edges.length}_${fileNode.id}->${id}`,
        from: fileNode.id,
        to: id,
        kind: "contains",
      });
    }
  }

  return {
    graphType: "workspace",
    title: path.basename(uri.fsPath),
    subtitle: `${uri.fsPath} · live outline`,
    nodes,
    edges,
    rootNodeIds: [fileNode.id],
    metadata: {
      mode: "live",
      provider: "vscode-document-symbols",
    },
  };
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`provider timeout after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
