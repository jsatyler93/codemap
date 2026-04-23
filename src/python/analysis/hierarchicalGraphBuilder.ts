import {
  BreadcrumbEntry,
  GraphDocument,
  GraphEdge,
  GraphNode,
  PeripheralRef,
  ZoomContext,
} from "../model/graphTypes";
import { PyAnalysisResult, PySymbol } from "../model/symbolTypes";

// ─── Color palette (must match webview/shared/theme.js palette). ──────
const PALETTE = [
  "#7aa2f7",
  "#bb9af7",
  "#9ece6a",
  "#73daca",
  "#e0af68",
  "#f7768e",
  "#7dcfff",
  "#c0a8e0",
  "#ff9e64",
  "#a3be8c",
];

const ROOT_PACKAGE = "(root)";

/** Stable folder id scheme: "pkg:{firstSegment}". */
function pkgId(folderName: string): string {
  return `pkg:${folderName}`;
}

/** First segment of a dotted module path (e.g., "a.b.c" → "a"), or ROOT_PACKAGE. */
export function folderOfModule(modulePath: string): string {
  if (!modulePath) return ROOT_PACKAGE;
  const dot = modulePath.indexOf(".");
  return dot >= 0 ? modulePath.slice(0, dot) : ROOT_PACKAGE === modulePath ? ROOT_PACKAGE : modulePath;
}

/**
 * Return a deterministic folder for a symbol. Top-level single-module files
 * (no dots in module path) become siblings under the synthetic "(root)"
 * package so they always have somewhere to live at L0.
 */
function folderOf(sym: PySymbol): string {
  const mod = sym.module || "";
  if (!mod) return ROOT_PACKAGE;
  const dot = mod.indexOf(".");
  return dot < 0 ? ROOT_PACKAGE : mod.slice(0, dot);
}

/**
 * Deterministic color assignment: sort module names alphabetically and take
 * the next palette slot. Stable across runs, stable across level transitions.
 */
export function computeModuleColorMap(analysis: PyAnalysisResult): Record<string, string> {
  const out: Record<string, string> = {};
  const modules = Object.keys(analysis.modules).sort();
  modules.forEach((mod, i) => {
    out[mod] = PALETTE[i % PALETTE.length];
  });
  // Also assign colors per folder (for L0 package nodes).
  const folders = new Set<string>();
  for (const mod of modules) folders.add(mod.indexOf(".") < 0 ? ROOT_PACKAGE : mod.slice(0, mod.indexOf(".")));
  const sortedFolders = Array.from(folders).sort();
  sortedFolders.forEach((f, i) => {
    out[pkgId(f)] = PALETTE[i % PALETTE.length];
  });
  return out;
}

// ─── Level 0: Package View ────────────────────────────────────────────

/**
 * Build the top-level package graph: folders as nodes, aggregated
 * cross-folder call edges as weighted connections.
 */
export function buildPackageGraph(
  analysis: PyAnalysisResult,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const colorMap = moduleColorMap ?? computeModuleColorMap(analysis);

  // Group symbols by folder, counting modules / functions / classes.
  const folders = new Map<
    string,
    { modules: Set<string>; functions: number; classes: number }
  >();
  for (const sym of Object.values(analysis.symbols)) {
    const f = folderOf(sym);
    let entry = folders.get(f);
    if (!entry) {
      entry = { modules: new Set(), functions: 0, classes: 0 };
      folders.set(f, entry);
    }
    if (sym.kind === "module") entry.modules.add(sym.module);
    else if (sym.kind === "function" || sym.kind === "method") entry.functions++;
    else if (sym.kind === "class") entry.classes++;
  }

  // Nodes.
  const nodes: GraphNode[] = [];
  const folderOrder = Array.from(folders.keys()).sort();
  for (const f of folderOrder) {
    const stats = folders.get(f)!;
    nodes.push({
      id: pkgId(f),
      kind: "package",
      label: f,
      detail: `${stats.modules.size} modules · ${stats.functions} functions`,
      styleCategory: pkgId(f),
      metadata: {
        folderName: f,
        moduleCount: stats.modules.size,
        functionCount: stats.functions,
        classCount: stats.classes,
        color: colorMap[pkgId(f)],
      },
    });
  }

  // Aggregate cross-folder call edges.
  const edgeCounts = new Map<string, number>(); // key "fromFolder->toFolder"
  for (const sym of Object.values(analysis.symbols)) {
    const from = folderOf(sym);
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target) continue;
      const to = folderOf(target);
      if (from === to) continue;
      const key = `${from}->${to}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  const edges: GraphEdge[] = [];
  let i = 0;
  for (const [key, count] of edgeCounts) {
    const [from, to] = key.split("->");
    edges.push({
      id: `e_${i++}`,
      from: pkgId(from),
      to: pkgId(to),
      kind: "cross_package",
      label: count > 1 ? `×${count}` : undefined,
      metadata: { callCount: count },
    });
  }

  const zoomContext: ZoomContext = {
    level: 0,
    breadcrumb: [{ level: 0, label: "Workspace", id: "root" }],
    peripherals: [],
    moduleColorMap: colorMap,
  };

  return {
    graphType: "package",
    title: "Workspace packages",
    subtitle: `${nodes.length} packages · ${edges.length} cross-package edges`,
    nodes,
    edges,
    metadata: {
      zoomContext,
      analysisSummary: analysis.summary,
    },
  };
}

// ─── Level 1: Module View ─────────────────────────────────────────────

/**
 * Build the module view for a single folder. `folderId` is either a pkg id
 * ("pkg:foo") or the bare folder name ("foo"). Each `.py` module in the
 * folder becomes a node; edges are aggregated call relationships between
 * modules in the folder. Other folders this folder touches show up as
 * peripheral reference nodes.
 */
export function buildModuleGraph(
  analysis: PyAnalysisResult,
  folderId: string,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const colorMap = moduleColorMap ?? computeModuleColorMap(analysis);
  const folderName = folderId.startsWith("pkg:") ? folderId.slice(4) : folderId;

  // Collect module symbols in this folder.
  const moduleSymbols: PySymbol[] = [];
  const moduleStats = new Map<
    string,
    { functions: number; classes: number; topNames: string[] }
  >();
  for (const sym of Object.values(analysis.symbols)) {
    if (folderOf(sym) !== folderName) continue;
    if (sym.kind !== "module") continue;
    moduleSymbols.push(sym);
    moduleStats.set(sym.id, { functions: 0, classes: 0, topNames: [] });
  }
  // Fill stats from members of those modules.
  for (const sym of Object.values(analysis.symbols)) {
    if (folderOf(sym) !== folderName) continue;
    const modId = analysis.modules[sym.module];
    if (!modId) continue;
    const stats = moduleStats.get(modId);
    if (!stats) continue;
    if (sym.kind === "function" || sym.kind === "method") stats.functions++;
    else if (sym.kind === "class") stats.classes++;
    // Only top-level (no dot beyond module) names contribute to the summary.
    if (
      (sym.kind === "function" || sym.kind === "class") &&
      sym.qualifiedName.indexOf(".") < 0 &&
      stats.topNames.length < 8
    ) {
      stats.topNames.push(sym.name);
    }
  }

  const nodes: GraphNode[] = [];
  for (const mod of moduleSymbols.sort((a, b) => a.module.localeCompare(b.module))) {
    const stats = moduleStats.get(mod.id) ?? { functions: 0, classes: 0, topNames: [] };
    nodes.push({
      id: mod.id,
      kind: "module",
      label: shortModuleName(mod.module),
      detail: mod.module,
      module: mod.module,
      source: mod.source,
      styleCategory: mod.module,
      metadata: {
        functionCount: stats.functions,
        classCount: stats.classes,
        symbolCount: stats.functions + stats.classes,
        topNames: stats.topNames,
        color: colorMap[mod.module],
      },
    });
  }

  // Aggregated inter-module call edges inside this folder, plus peripherals.
  const internalEdgeCounts = new Map<string, number>(); // "fromModId->toModId"
  const peripheralCounts = new Map<
    string,
    { callCount: number; direction: "incoming" | "outgoing" }
  >(); // key "folderName|direction"

  for (const sym of Object.values(analysis.symbols)) {
    const fromFolder = folderOf(sym);
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target) continue;
      const toFolder = folderOf(target);

      if (fromFolder === folderName && toFolder === folderName) {
        // Internal edge between two modules in this folder.
        const fromMod = analysis.modules[sym.module];
        const toMod = analysis.modules[target.module];
        if (!fromMod || !toMod || fromMod === toMod) continue;
        const key = `${fromMod}->${toMod}`;
        internalEdgeCounts.set(key, (internalEdgeCounts.get(key) ?? 0) + 1);
      } else if (fromFolder === folderName && toFolder !== folderName) {
        const key = `${toFolder}|outgoing`;
        const entry = peripheralCounts.get(key) ?? { callCount: 0, direction: "outgoing" as const };
        entry.callCount++;
        peripheralCounts.set(key, entry);
      } else if (toFolder === folderName && fromFolder !== folderName) {
        const key = `${fromFolder}|incoming`;
        const entry = peripheralCounts.get(key) ?? { callCount: 0, direction: "incoming" as const };
        entry.callCount++;
        peripheralCounts.set(key, entry);
      }
    }
  }

  const edges: GraphEdge[] = [];
  let ei = 0;
  for (const [key, count] of internalEdgeCounts) {
    const [from, to] = key.split("->");
    edges.push({
      id: `e_${ei++}`,
      from,
      to,
      kind: "calls",
      label: count > 1 ? `×${count}` : undefined,
      metadata: { callCount: count },
    });
  }

  const peripherals: PeripheralRef[] = [];
  for (const [key, info] of peripheralCounts) {
    const [otherFolder, dir] = key.split("|");
    const arrow = dir === "outgoing" ? "→ " : "← ";
    peripherals.push({
      id: pkgId(otherFolder),
      label: `${arrow}${otherFolder}`,
      direction: info.direction,
      callCount: info.callCount,
      targetLevel: 1,
      color: colorMap[pkgId(otherFolder)],
    });
  }

  const breadcrumb: BreadcrumbEntry[] = [
    { level: 0, label: "Workspace", id: "root" },
    { level: 1, label: folderName, id: pkgId(folderName) },
  ];

  const zoomContext: ZoomContext = {
    level: 1,
    breadcrumb,
    peripherals,
    parentId: pkgId(folderName),
    moduleColorMap: colorMap,
  };

  return {
    graphType: "module_view",
    title: folderName,
    subtitle: `${nodes.length} modules · ${edges.length} internal edges · ${peripherals.length} external`,
    nodes,
    edges,
    rootNodeIds: nodes.length ? [nodes[0].id] : [],
    metadata: {
      zoomContext,
      folderName,
      analysisSummary: analysis.summary,
    },
  };
}

// ─── Level 2: Symbol View (module-scoped) ─────────────────────────────

/**
 * Build the symbol view for a single module: all functions/classes + their
 * call edges, plus peripheral references for calls to/from other modules.
 */
export function buildSymbolGraph(
  analysis: PyAnalysisResult,
  moduleId: string,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const colorMap = moduleColorMap ?? computeModuleColorMap(analysis);
  const modSym = analysis.symbols[moduleId];
  if (!modSym || modSym.kind !== "module") {
    return {
      graphType: "callgraph",
      title: "Unknown module",
      nodes: [],
      edges: [],
      metadata: { zoomContext: { level: 2, breadcrumb: [], peripherals: [], moduleColorMap: colorMap } },
    };
  }
  const moduleName = modSym.module;
  const folderName = folderOfModule(moduleName);

  // Nodes: every non-module symbol inside this module.
  const nodes: GraphNode[] = [];
  const inModule = new Set<string>();
  for (const sym of Object.values(analysis.symbols)) {
    if (sym.module !== moduleName || sym.kind === "module") continue;
    inModule.add(sym.id);
    nodes.push(symbolToNode(sym, colorMap[sym.module]));
  }

  // Edges: calls between in-module symbols. Cross-module calls turn into peripherals.
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const outgoingPeripherals = new Map<string, { callCount: number; label: string }>();
  const incomingPeripherals = new Map<string, { callCount: number; label: string }>();

  for (const sym of Object.values(analysis.symbols)) {
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target) continue;
      const fromIn = inModule.has(sym.id);
      const toIn = inModule.has(target.id);
      if (fromIn && toIn) {
        const key = `${sym.id}->${target.id}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push({
          id: `e_${edges.length}`,
          from: sym.id,
          to: target.id,
          kind: "calls",
          resolution: call.resolution,
        });
      } else if (fromIn && !toIn) {
        const mod = target.module;
        const prev = outgoingPeripherals.get(mod) ?? { callCount: 0, label: `→ ${shortModuleName(mod)}` };
        prev.callCount++;
        outgoingPeripherals.set(mod, prev);
      } else if (!fromIn && toIn) {
        const mod = sym.module;
        const prev = incomingPeripherals.get(mod) ?? { callCount: 0, label: `← ${shortModuleName(mod)}` };
        prev.callCount++;
        incomingPeripherals.set(mod, prev);
      }
    }
  }

  const peripherals: PeripheralRef[] = [];
  for (const [mod, info] of outgoingPeripherals) {
    const modId = analysis.modules[mod];
    if (!modId) continue;
    peripherals.push({
      id: modId,
      label: info.label,
      direction: "outgoing",
      callCount: info.callCount,
      targetLevel: 2,
      color: colorMap[mod],
    });
  }
  for (const [mod, info] of incomingPeripherals) {
    const modId = analysis.modules[mod];
    if (!modId) continue;
    peripherals.push({
      id: modId,
      label: info.label,
      direction: "incoming",
      callCount: info.callCount,
      targetLevel: 2,
      color: colorMap[mod],
    });
  }

  const breadcrumb: BreadcrumbEntry[] = [
    { level: 0, label: "Workspace", id: "root" },
    { level: 1, label: folderName, id: pkgId(folderName) },
    { level: 2, label: shortModuleName(moduleName), id: moduleId },
  ];

  const zoomContext: ZoomContext = {
    level: 2,
    breadcrumb,
    peripherals,
    parentId: moduleId,
    moduleColorMap: colorMap,
  };

  return {
    graphType: "callgraph",
    title: moduleName,
    subtitle: `${nodes.length} symbols · ${edges.length} internal calls · ${peripherals.length} external`,
    nodes,
    edges,
    rootNodeIds: nodes.length ? [nodes[0].id] : [],
    metadata: {
      zoomContext,
      module: moduleName,
      analysisSummary: analysis.summary,
    },
  };
}

// ─── Unified View: all levels on one canvas ───────────────────────────

/**
 * Build a single unified graph containing packages, modules, and symbols
 * with pre-computed hierarchical layout coordinates. The webview renders
 * everything on one SVG canvas and uses zoom-scale thresholds to control
 * which level of detail is visible.
 */
export function buildUnifiedGraph(
  analysis: PyAnalysisResult,
  moduleColorMap?: Record<string, string>,
): GraphDocument {
  const colorMap = moduleColorMap ?? computeModuleColorMap(analysis);

  // Layout constants (SVG coordinate units)
  const SYM_W = 200, SYM_H = 36, SYM_GAP = 6;
  const MOD_HDR = 44, MOD_PAD_X = 24, MOD_PAD_BOT = 20;
  const MOD_W = SYM_W + MOD_PAD_X * 2;
  const MOD_GAP_X = 50, MOD_GAP_Y = 40;
  const PKG_HDR = 56, PKG_PAD_X = 36, PKG_PAD_BOT = 30;
  const PKG_GAP = 200;

  // 1) Group symbols by folder → module
  const folderModules = new Map<
    string,
    Map<string, { modSym?: PySymbol; syms: PySymbol[] }>
  >();

  for (const sym of Object.values(analysis.symbols)) {
    const folder = folderOf(sym);
    if (!folderModules.has(folder)) folderModules.set(folder, new Map());
    const modMap = folderModules.get(folder)!;

    if (sym.kind === "module") {
      const existing = modMap.get(sym.module);
      if (existing) existing.modSym = sym;
      else modMap.set(sym.module, { modSym: sym, syms: [] });
    } else {
      const existing = modMap.get(sym.module);
      if (existing) existing.syms.push(sym);
      else modMap.set(sym.module, { syms: [sym] });
    }
  }

  const folderOrder = Array.from(folderModules.keys()).sort();

  // 2) Compute module and package dimensions
  const folderDims = new Map<
    string,
    {
      w: number;
      h: number;
      modLayouts: Map<string, { rx: number; ry: number; w: number; h: number }>;
    }
  >();

  for (const folder of folderOrder) {
    const modMap = folderModules.get(folder)!;
    const modOrder = Array.from(modMap.keys()).sort();
    const modCols = Math.max(1, Math.ceil(Math.sqrt(modOrder.length)));
    const modRows = Math.ceil(modOrder.length / modCols);

    const modHeights: number[] = [];
    for (const mod of modOrder) {
      const { syms } = modMap.get(mod)!;
      const h = MOD_HDR + syms.length * (SYM_H + SYM_GAP) + MOD_PAD_BOT;
      modHeights.push(Math.max(100, h));
    }

    const rowMaxH: number[] = new Array(modRows).fill(100);
    for (let i = 0; i < modOrder.length; i++) {
      const r = Math.floor(i / modCols);
      rowMaxH[r] = Math.max(rowMaxH[r], modHeights[i]);
    }

    const modLayouts = new Map<
      string,
      { rx: number; ry: number; w: number; h: number }
    >();
    for (let i = 0; i < modOrder.length; i++) {
      const r = Math.floor(i / modCols);
      const c = i % modCols;
      let ry = PKG_HDR;
      for (let rr = 0; rr < r; rr++) ry += rowMaxH[rr] + MOD_GAP_Y;
      modLayouts.set(modOrder[i], {
        rx: PKG_PAD_X + c * (MOD_W + MOD_GAP_X),
        ry,
        w: MOD_W,
        h: modHeights[i],
      });
    }

    const pkgW =
      PKG_PAD_X * 2 +
      modCols * MOD_W +
      Math.max(0, modCols - 1) * MOD_GAP_X;
    let pkgH = PKG_HDR;
    for (let r = 0; r < modRows; r++) pkgH += rowMaxH[r] + MOD_GAP_Y;
    pkgH += PKG_PAD_BOT;

    folderDims.set(folder, { w: pkgW, h: pkgH, modLayouts });
  }

  // 3) Lay out packages in a grid
  const pkgCols = Math.max(1, Math.ceil(Math.sqrt(folderOrder.length)));
  const pkgRows = Math.ceil(folderOrder.length / pkgCols);
  const pkgColMaxW: number[] = new Array(pkgCols).fill(0);
  const pkgRowMaxH: number[] = new Array(pkgRows).fill(0);

  for (let i = 0; i < folderOrder.length; i++) {
    const r = Math.floor(i / pkgCols);
    const c = i % pkgCols;
    const dims = folderDims.get(folderOrder[i])!;
    pkgColMaxW[c] = Math.max(pkgColMaxW[c], dims.w);
    pkgRowMaxH[r] = Math.max(pkgRowMaxH[r], dims.h);
  }

  const pkgPositions = new Map<
    string,
    {
      x: number;
      y: number;
      w: number;
      h: number;
      modLayouts: Map<string, { x: number; y: number; w: number; h: number }>;
    }
  >();

  for (let i = 0; i < folderOrder.length; i++) {
    const r = Math.floor(i / pkgCols);
    const c = i % pkgCols;
    const folder = folderOrder[i];
    const dims = folderDims.get(folder)!;

    let px = 80;
    for (let cc = 0; cc < c; cc++) px += pkgColMaxW[cc] + PKG_GAP;
    let py = 80;
    for (let rr = 0; rr < r; rr++) py += pkgRowMaxH[rr] + PKG_GAP;

    const absModLayouts = new Map<
      string,
      { x: number; y: number; w: number; h: number }
    >();
    for (const [mod, ml] of dims.modLayouts) {
      absModLayouts.set(mod, {
        x: px + ml.rx,
        y: py + ml.ry,
        w: ml.w,
        h: ml.h,
      });
    }

    pkgPositions.set(folder, {
      x: px,
      y: py,
      w: dims.w,
      h: dims.h,
      modLayouts: absModLayouts,
    });
  }

  // 4) Create all nodes with absolute coordinates
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];

  for (const folder of folderOrder) {
    const modMap = folderModules.get(folder)!;
    const pkgLayout = pkgPositions.get(folder)!;
    const pkgColor = colorMap[pkgId(folder)] || "#7aa2f7";

    let totalFunctions = 0;
    let totalClasses = 0;
    for (const { syms } of modMap.values()) {
      for (const s of syms) {
        if (s.kind === "function" || s.kind === "method") totalFunctions++;
        if (s.kind === "class") totalClasses++;
      }
    }

    allNodes.push({
      id: pkgId(folder),
      kind: "package",
      label: folder,
      detail: `${modMap.size} modules`,
      styleCategory: pkgId(folder),
      metadata: {
        level: 0,
        x: pkgLayout.x,
        y: pkgLayout.y,
        w: pkgLayout.w,
        h: pkgLayout.h,
        color: pkgColor,
        moduleCount: modMap.size,
        functionCount: totalFunctions,
        classCount: totalClasses,
      },
    });

    for (const [mod, { modSym, syms }] of modMap) {
      const modLayout = pkgLayout.modLayouts.get(mod);
      if (!modLayout) continue;
      const modColor = colorMap[mod] || pkgColor;
      const moduleId = modSym?.id || `mod:${mod}`;

      const funcs = syms.filter(
        (s) => s.kind === "function" || s.kind === "method",
      );
      const classes = syms.filter((s) => s.kind === "class");

      allNodes.push({
        id: moduleId,
        kind: "module",
        label: shortModuleName(mod),
        detail: mod,
        module: mod,
        source: modSym?.source,
        styleCategory: mod,
        metadata: {
          level: 1,
          parentId: pkgId(folder),
          x: modLayout.x,
          y: modLayout.y,
          w: modLayout.w,
          h: modLayout.h,
          color: modColor,
          functionCount: funcs.length,
          classCount: classes.length,
          topNames: syms.slice(0, 6).map((s) => s.name),
        },
      });

      // Symbol nodes
      const sortedSyms = [...syms].sort(
        (a, b) => (a.source?.line ?? 0) - (b.source?.line ?? 0),
      );
      sortedSyms.forEach((sym, idx) => {
        const symX = modLayout.x + MOD_PAD_X;
        const symY = modLayout.y + MOD_HDR + idx * (SYM_H + SYM_GAP);
        const node = symbolToNode(sym, modColor);
        node.metadata = {
          ...node.metadata,
          level: 2,
          parentId: moduleId,
          x: symX,
          y: symY,
          w: SYM_W,
          h: SYM_H,
        };
        allNodes.push(node);
      });
    }
  }

  // 5) Compute edges at each level
  const l0Counts = new Map<string, number>();
  const l1Counts = new Map<string, number>();
  const l2Seen = new Set<string>();

  for (const sym of Object.values(analysis.symbols)) {
    if (sym.kind === "module") continue;
    const fromFolder = folderOf(sym);
    for (const call of sym.calls) {
      if (!call.resolvedTo) continue;
      const target = analysis.symbols[call.resolvedTo];
      if (!target || target.kind === "module") continue;
      const toFolder = folderOf(target);

      if (fromFolder !== toFolder) {
        const key = `${pkgId(fromFolder)}->${pkgId(toFolder)}`;
        l0Counts.set(key, (l0Counts.get(key) ?? 0) + 1);
      } else if (sym.module !== target.module) {
        const fromModId = analysis.modules[sym.module];
        const toModId = analysis.modules[target.module];
        if (fromModId && toModId) {
          const key = `${fromModId}->${toModId}`;
          l1Counts.set(key, (l1Counts.get(key) ?? 0) + 1);
        }
      } else {
        const key = `${sym.id}->${target.id}`;
        if (!l2Seen.has(key)) {
          l2Seen.add(key);
          allEdges.push({
            id: `e_l2_${allEdges.length}`,
            from: sym.id,
            to: target.id,
            kind: "calls",
            resolution: call.resolution,
            metadata: { level: 2 },
          });
        }
      }
    }
  }

  for (const [key, count] of l0Counts) {
    const [from, to] = key.split("->");
    allEdges.push({
      id: `e_l0_${allEdges.length}`,
      from,
      to,
      kind: "cross_package",
      label: count > 1 ? `×${count}` : undefined,
      metadata: { level: 0, callCount: count },
    });
  }

  for (const [key, count] of l1Counts) {
    const [from, to] = key.split("->");
    allEdges.push({
      id: `e_l1_${allEdges.length}`,
      from,
      to,
      kind: "calls",
      label: count > 1 ? `×${count}` : undefined,
      metadata: { level: 1, callCount: count },
    });
  }

  const zoomContext: ZoomContext = {
    level: 0,
    breadcrumb: [{ level: 0, label: "Workspace", id: "root" }],
    peripherals: [],
    moduleColorMap: colorMap,
  };

  return {
    graphType: "unified",
    title: "Workspace",
    subtitle: `${folderOrder.length} packages · unified view`,
    nodes: allNodes,
    edges: allEdges,
    metadata: {
      unified: true,
      zoomContext,
      analysisSummary: analysis.summary,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function symbolToNode(sym: PySymbol, color?: string): GraphNode {
  return {
    id: sym.id,
    kind:
      sym.kind === "module"
        ? "module"
        : sym.kind === "class"
          ? "class"
          : sym.kind === "method"
            ? "method"
            : "function",
    label: sym.name,
    detail: sym.qualifiedName,
    module: sym.module,
    className: sym.className,
    source: sym.source,
    styleCategory: sym.module,
    metadata: {
      color,
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

function shortModuleName(modulePath: string): string {
  if (!modulePath) return "(module)";
  const idx = modulePath.lastIndexOf(".");
  return idx >= 0 ? modulePath.slice(idx + 1) + ".py" : modulePath + ".py";
}

/** Build a zoom context to attach to an externally-built L3 flowchart. */
export function flowchartZoomContext(
  analysis: PyAnalysisResult,
  symbolId: string,
  moduleColorMap?: Record<string, string>,
): ZoomContext {
  const colorMap = moduleColorMap ?? computeModuleColorMap(analysis);
  const sym = analysis.symbols[symbolId];
  if (!sym) {
    return { level: 3, breadcrumb: [], peripherals: [], moduleColorMap: colorMap };
  }
  const moduleName = sym.module;
  const moduleId = analysis.modules[moduleName];
  const folderName = folderOfModule(moduleName);

  const breadcrumb: BreadcrumbEntry[] = [
    { level: 0, label: "Workspace", id: "root" },
    { level: 1, label: folderName, id: pkgId(folderName) },
  ];
  if (moduleId) {
    breadcrumb.push({ level: 2, label: shortModuleName(moduleName), id: moduleId });
  }
  breadcrumb.push({
    level: 3,
    label: `${sym.name}()`,
    id: sym.id,
  });

  // Peripherals at L3: unique callees that exist as known symbols become
  // portal references the user can drill across to.
  const seen = new Set<string>();
  const peripherals: PeripheralRef[] = [];
  for (const call of sym.calls) {
    if (!call.resolvedTo || seen.has(call.resolvedTo)) continue;
    const target = analysis.symbols[call.resolvedTo];
    if (!target) continue;
    seen.add(call.resolvedTo);
    peripherals.push({
      id: target.id,
      label: `→ ${target.qualifiedName}`,
      direction: "outgoing",
      callCount: 1,
      targetLevel: 3,
      color: colorMap[target.module],
    });
  }

  return {
    level: 3,
    breadcrumb,
    peripherals,
    parentId: sym.id,
    moduleColorMap: colorMap,
  };
}
