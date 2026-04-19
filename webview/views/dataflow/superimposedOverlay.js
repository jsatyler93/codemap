import { NS } from "../../shared/panZoom.js";

const OVERLAY_ID = "codemap-superimposed-dataflow";
const MAX_EDGES = 700;

export function clearSuperimposedDataflow(root) {
  const old = root.querySelector(`#${OVERLAY_ID}`);
  if (old) old.remove();
}

export function renderSuperimposedDataflow(graph, root, renderResult, options = {}) {
  clearSuperimposedDataflow(root);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !renderResult?.nodeRect) {
    return;
  }

  const showLegacyOverlay = options.showLegacyOverlay !== false;
  const showModernOverlay = options.showModernOverlay !== false;
  if (!showLegacyOverlay && !showModernOverlay) return;

  const visible = new Set(Array.isArray(renderResult.visibleNodeIds)
    ? renderResult.visibleNodeIds
    : Array.from(renderResult.nodeRect.keys()));

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const rwNodeIds = [];
  for (const nodeId of visible) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const reads = asStringArray(node?.metadata?.reads);
    const writes = asStringArray(node?.metadata?.writes);
    if (reads.length || writes.length) rwNodeIds.push(nodeId);
  }
  if (rwNodeIds.length < 2) return;

  const cfgEdges = graph.edges.filter((e) => e && e.from && e.to && visible.has(e.from) && visible.has(e.to));
  if (!cfgEdges.length) return;

  const modernEdges = showModernOverlay ? deriveReachingDefinitionEdges(rwNodeIds, nodeById, cfgEdges) : [];
  const legacyEdges = showLegacyOverlay ? deriveLegacyLastWriterEdges(rwNodeIds, nodeById) : [];
  const interprocEdges = showModernOverlay ? deriveInterproceduralEdges(graph.edges, visible) : [];

  const overlayEdges = [...legacyEdges, ...modernEdges, ...interprocEdges];
  if (!overlayEdges.length) return;

  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("id", OVERLAY_ID);
  layer.setAttribute("opacity", "0.92");
  root.appendChild(layer);

  const seen = new Set();
  for (let i = 0; i < Math.min(MAX_EDGES, overlayEdges.length); i += 1) {
    const edge = overlayEdges[i];
    const key = `${edge.from}->${edge.to}:${edge.variable}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fromRect = renderResult.nodeRect.get(edge.from);
    const toRect = renderResult.nodeRect.get(edge.to);
    if (!fromRect || !toRect) continue;

    const sx = fromRect.x + fromRect.w / 2;
    const sy = fromRect.y + fromRect.h / 2;
    const tx = toRect.x + toRect.w / 2;
    const ty = toRect.y + toRect.h / 2;
    if (Math.abs(tx - sx) < 1 && Math.abs(ty - sy) < 1) continue;

    const color = variableColor(edge.variable);
    const bend = Math.max(24, Math.min(90, Math.abs(tx - sx) * 0.22));
    const dir = tx >= sx ? 1 : -1;
    const c1x = sx + bend * dir;
    const c1y = sy;
    const c2x = tx - bend * dir;
    const c2y = ty;

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-opacity", edge.mode === "legacy" ? "0.28" : "0.52");
    path.setAttribute("stroke-width", edge.mode === "legacy" ? "0.9" : "1.3");
    path.setAttribute("stroke-dasharray", edge.mode === "legacy" ? "2 4" : "3 3");
    path.setAttribute("pointer-events", "none");
    layer.appendChild(path);

    if (i < 120) {
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", String((sx + tx) / 2));
      label.setAttribute("y", String((sy + ty) / 2 - 3));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", color);
      label.setAttribute("opacity", edge.mode === "legacy" ? "0.45" : "0.72");
      label.setAttribute("font-size", "8");
      label.setAttribute("font-family", "Consolas, monospace");
      label.textContent = edge.variable;
      layer.appendChild(label);
    }
  }
}

function deriveLegacyLastWriterEdges(nodeIds, nodeById) {
  const lastWriter = new Map();
  const out = [];
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const reads = asStringArray(node?.metadata?.reads);
    const writes = asStringArray(node?.metadata?.writes);
    for (const variable of reads) {
      const src = lastWriter.get(variable);
      if (src && src !== nodeId) out.push({ from: src, to: nodeId, variable, mode: "legacy" });
    }
    for (const variable of writes) {
      lastWriter.set(variable, nodeId);
    }
  }
  return out;
}

function deriveInterproceduralEdges(graphEdges, visibleNodeIds) {
  const out = [];
  for (const edge of graphEdges) {
    if (!visibleNodeIds.has(edge.from) || !visibleNodeIds.has(edge.to)) continue;
    const inter = edge?.metadata?.interprocedural;
    if (!inter || typeof inter !== "object") continue;
    const argMappings = Array.isArray(inter.argMappings) ? inter.argMappings : [];
    const returnMappings = Array.isArray(inter.returnMappings) ? inter.returnMappings : [];
    for (const map of argMappings) {
      const fromVar = map?.fromVar;
      const toParam = map?.toParam;
      if (!fromVar || !toParam) continue;
      out.push({ from: edge.from, to: edge.to, variable: `${fromVar}->${toParam}`, mode: "modern" });
    }
    for (const map of returnMappings) {
      const toVar = map?.toVar;
      if (!toVar) continue;
      out.push({ from: edge.to, to: edge.from, variable: `return->${toVar}`, mode: "modern" });
    }
  }
  return out;
}

function deriveReachingDefinitionEdges(nodeIds, nodeById, cfgEdges) {
  const preds = new Map();
  const succs = new Map();
  for (const id of nodeIds) {
    preds.set(id, new Set());
    succs.set(id, new Set());
  }
  for (const edge of cfgEdges) {
    if (!preds.has(edge.to) || !succs.has(edge.from)) continue;
    preds.get(edge.to).add(edge.from);
    succs.get(edge.from).add(edge.to);
  }

  const gen = new Map();
  const killVars = new Map();
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    const writes = asStringArray(node?.metadata?.writes);
    killVars.set(id, new Set(writes));
    gen.set(id, new Set(writes.map((v) => defToken(id, v))));
  }

  const inMap = new Map();
  const outMap = new Map();
  for (const id of nodeIds) {
    inMap.set(id, new Set());
    outMap.set(id, new Set(gen.get(id)));
  }

  let changed = true;
  let guard = 0;
  while (changed && guard < 1000) {
    changed = false;
    guard += 1;
    for (const id of nodeIds) {
      const incoming = new Set();
      for (const p of preds.get(id)) {
        for (const tok of outMap.get(p)) incoming.add(tok);
      }
      const kills = killVars.get(id);
      const nextOut = new Set(gen.get(id));
      for (const tok of incoming) {
        if (!kills.has(varFromToken(tok))) nextOut.add(tok);
      }
      if (!setEq(inMap.get(id), incoming)) {
        inMap.set(id, incoming);
        changed = true;
      }
      if (!setEq(outMap.get(id), nextOut)) {
        outMap.set(id, nextOut);
        changed = true;
      }
    }
  }

  const derived = [];
  for (const id of nodeIds) {
    const node = nodeById.get(id);
    const reads = asStringArray(node?.metadata?.reads);
    if (!reads.length) continue;
    const inDefs = inMap.get(id) || new Set();
    for (const variable of reads) {
      for (const tok of inDefs) {
        if (varFromToken(tok) !== variable) continue;
        const src = srcFromToken(tok);
        if (src !== id) derived.push({ from: src, to: id, variable, mode: "modern" });
      }
    }
  }
  return derived;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.length > 0);
}

function defToken(nodeId, variable) {
  return `${nodeId}::${variable}`;
}

function srcFromToken(token) {
  const idx = token.indexOf("::");
  return idx === -1 ? token : token.slice(0, idx);
}

function varFromToken(token) {
  const idx = token.indexOf("::");
  return idx === -1 ? "" : token.slice(idx + 2);
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function variableColor(name) {
  const palette = [
    "#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#73daca",
    "#f7768e", "#7dcfff", "#ff9e64", "#c0caf5", "#a9b1d6",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}
