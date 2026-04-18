// Flowchart view. Lays out nodes vertically with light branching for
// decision nodes. Driven by GraphDocument JSON (graphType === 'flowchart').

import { NS, mkArrow } from "../../shared/panZoom.js";
import { theme } from "../../shared/theme.js";
import { cubicPt } from "../../shared/geometry.js";

const NODE_W = 220;
const NODE_H = 36;
const ROW_GAP = 30;
const BRANCH_GAP = 240;

export function renderFlowchart(graph, ctx) {
  const { root, defs } = ctx;
  Object.entries(theme.nodeColor).forEach(([k, c]) => mkArrow(defs, `a-${k}`, c));
  mkArrow(defs, "a-default", "#454a60");

  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges;

  const incoming = new Map();
  const outgoing = new Map();
  for (const n of nodes) { incoming.set(n.id, []); outgoing.set(n.id, []); }
  for (const e of edges) {
    if (outgoing.has(e.from)) outgoing.get(e.from).push(e);
    if (incoming.has(e.to))   incoming.get(e.to).push(e);
  }

  // Layout: simple top-down with branching. Identify the entry node, then
  // walk the graph laying nodes out level by level.
  const positions = new Map();
  const visited = new Set();
  const entry = (graph.rootNodeIds && graph.rootNodeIds[0])
    || (nodes.find((n) => n.kind === "entry") || nodes[0])?.id;
  if (!entry) {
    return { edgeRecords: [], nodeRect: new Map(), nodes, initialView: { scale: 1, panX: 0, panY: 0 } };
  }

  let cursorY = 30;
  function place(nodeId, x) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const n = nodes.find((nn) => nn.id === nodeId);
    if (!n) return;
    positions.set(nodeId, { x: x - NODE_W / 2, y: cursorY });
    cursorY += NODE_H + ROW_GAP;
    const outs = (outgoing.get(nodeId) || []);
    if (outs.length === 0) return;
    if (outs.length === 1) {
      place(outs[0].to, x);
      return;
    }
    // Branching: place 'yes' branch left, 'no' branch right where labels exist.
    const yes = outs.find((e) => /yes|true|ok/i.test(e.label || ""));
    const no  = outs.find((e) => /no|false|invalid|raise/i.test(e.label || ""));
    const ordered = [yes, no, ...outs.filter((e) => e !== yes && e !== no)].filter(Boolean);
    const span = (ordered.length - 1) * BRANCH_GAP;
    ordered.forEach((e, i) => {
      const childX = x - span / 2 + i * BRANCH_GAP;
      place(e.to, childX);
    });
  }
  place(entry, 480);

  // Place orphans (nodes not reachable from entry) below.
  for (const n of nodes) {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: 100, y: cursorY });
      cursorY += NODE_H + ROW_GAP;
    }
  }

  // Layers
  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer  = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  // --- nodes ---
  const nodeRect = new Map();
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const col = theme.nodeColor[n.kind] || theme.nodeColor.process;
    const w = NODE_W;
    const h = NODE_H;
    nodeRect.set(n.id, { x: p.x, y: p.y, w, h, color: col });

    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    g.dataset.id = n.id;
    g.style.cursor = "pointer";

    let shape;
    if (n.kind === "decision") {
      shape = document.createElementNS(NS, "polygon");
      shape.setAttribute("points", `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`);
      shape.setAttribute("fill",   col + "12");
      shape.setAttribute("stroke", col + "55");
    } else if (n.kind === "entry" || n.kind === "return") {
      shape = document.createElementNS(NS, "rect");
      shape.setAttribute("width",  w);
      shape.setAttribute("height", h);
      shape.setAttribute("rx", 16); shape.setAttribute("ry", 16);
      shape.setAttribute("fill",   col + "1c");
      shape.setAttribute("stroke", col + "55");
    } else {
      shape = document.createElementNS(NS, "rect");
      shape.setAttribute("width",  w);
      shape.setAttribute("height", h);
      shape.setAttribute("rx", 5); shape.setAttribute("ry", 5);
      shape.setAttribute("fill",   col + "10");
      shape.setAttribute("stroke", col + "35");
    }
    shape.setAttribute("stroke-width", "1.2");
    g.appendChild(shape);

    const lines = String(n.label || "").split("\n");
    lines.forEach((line, i) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(w / 2));
      const totalH = lines.length * 12;
      t.setAttribute("y", String(h / 2 - totalH / 2 + i * 12 + 9));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", col + "dd");
      t.setAttribute("font-size", "10");
      t.textContent = line;
      g.appendChild(t);
    });

    g.addEventListener("mouseenter", (e) => ctx.showTooltip(e, n));
    g.addEventListener("mousemove", (e) => ctx.moveTooltip(e));
    g.addEventListener("mouseleave", () => ctx.hideTooltip());
    g.addEventListener("click", () => ctx.onNodeClick(n));

    nodeLayer.appendChild(g);
  }

  // --- edges ---
  const edgeRecords = [];
  for (const e of edges) {
    const fromR = nodeRect.get(e.from);
    const toR   = nodeRect.get(e.to);
    if (!fromR || !toR) continue;
    const sp = { x: fromR.x + fromR.w / 2, y: fromR.y + fromR.h };
    const tp = { x: toR.x   + toR.w   / 2, y: toR.y };
    let c1x, c1y, c2x, c2y, d;
    if (Math.abs(tp.x - sp.x) < 1) {
      c1x = sp.x; c1y = (sp.y + tp.y) / 2;
      c2x = tp.x; c2y = (sp.y + tp.y) / 2;
    } else {
      const my = (sp.y + tp.y) / 2;
      c1x = sp.x; c1y = my;
      c2x = tp.x; c2y = my;
    }
    d = `M${sp.x},${sp.y} C${c1x},${c1y} ${c2x},${c2y} ${tp.x},${tp.y}`;
    const fromKind = (nodes.find((n) => n.id === e.from) || {}).kind || "process";
    const col = theme.nodeColor[fromKind] || "#454a60";

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", col + "33");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("marker-end", `url(#a-${fromKind})`);
    edgeLayer.appendChild(path);

    if (e.label) {
      const mid = cubicPt(sp.x, sp.y, c1x, c1y, c2x, c2y, tp.x, tp.y, 0.5);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(mid.x + 6));
      t.setAttribute("y", String(mid.y - 4));
      t.setAttribute("fill", col + "88");
      t.setAttribute("font-size", "8.5");
      t.textContent = e.label;
      edgeLayer.appendChild(t);
    }

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "1.3"); dot.setAttribute("fill", col);
    dot.setAttribute("opacity", "0");
    dotLayer.appendChild(dot);
    edgeRecords.push({
      sx: sp.x, sy: sp.y, c1x, c1y, c2x, c2y, tx: tp.x, ty: tp.y,
      dot, offset: Math.random(), speed: 0.0006 + Math.random() * 0.0004,
    });
  }

  // Legend (node kinds present in this graph).
  const lgItems = document.getElementById("lg-items");
  lgItems.innerHTML = "";
  document.getElementById("lg-title").textContent = "Node Types";
  const kinds = Array.from(new Set(nodes.map((n) => n.kind)));
  for (const k of kinds) {
    const c = theme.nodeColor[k] || "#7aa2f7";
    const div = document.createElement("div");
    div.className = "lg-item";
    div.innerHTML = k === "decision"
      ? `<span class="lg-diamond" style="background:${c}22;border:1px solid ${c}55"></span>${k}`
      : `<span class="lg-shape"   style="background:${c}22;border:1px solid ${c}55;${k === "entry" || k === "return" ? "border-radius:10px" : ""}"></span>${k}`;
    lgItems.appendChild(div);
  }

  return {
    edgeRecords,
    nodeRect,
    nodes,
    initialView: { scale: 0.75, panX: 60, panY: 20 },
  };
}
