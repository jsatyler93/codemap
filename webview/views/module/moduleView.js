// L1 · Module view. Renders modules (files) inside a single folder as
// rounded-rectangle nodes with function/class badges and top-name previews.
// Edges are aggregated inter-module call counts.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { cubicPt } from "../../shared/geometry.js";
import { theme } from "../../shared/theme.js";

const NODE_W = 240;
const NODE_H = 110;
const COL_GAP = 140;
const ROW_GAP = 60;
const MIN_EDGE_W = 1.0;
const MAX_EDGE_W = 4.5;

const vscode = window.__codemapVscode;

export function renderModuleView(graph, ctx) {
  const { root, defs } = ctx;
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges || [];
  const zoom = (graph.metadata && graph.metadata.zoomContext) || {};
  const colorMap = zoom.moduleColorMap || {};

  const seenColors = new Set();
  for (const n of nodes) {
    const c = (n.metadata && n.metadata.color) || colorMap[n.module] || theme.accent;
    if (!seenColors.has(c)) {
      seenColors.add(c);
      mkArrow(defs, `a-mod-${safeId(n.id)}`, c);
    }
  }
  mkArrow(defs, "a-mod-default", "#454a60");

  nodes.sort((a, b) => a.label.localeCompare(b.label));
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const pos = new Map();
  nodes.forEach((n, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    pos.set(n.id, {
      x: 80 + c * (NODE_W + COL_GAP),
      y: 80 + r * (NODE_H + ROW_GAP),
      w: NODE_W,
      h: NODE_H,
      color: (n.metadata && n.metadata.color) || colorMap[n.module] || theme.accent,
    });
  });

  let maxCount = 1;
  for (const e of edges) {
    const c = (e.metadata && e.metadata.callCount) || 1;
    if (c > maxCount) maxCount = c;
  }

  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer  = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  const edgeRecords = [];
  for (const e of edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;
    const count = (e.metadata && e.metadata.callCount) || 1;
    const width = MIN_EDGE_W + (MAX_EDGE_W - MIN_EDGE_W) * (count / maxCount);
    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = to.x;
    const ty = to.y + to.h / 2;
    const cx = sx + Math.min(220, Math.max(60, (tx - sx) / 2));

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", from.color + "aa");
    path.setAttribute("stroke-width", width.toFixed(2));
    path.setAttribute("marker-end", `url(#a-mod-${safeId(e.from)})`);
    path.setAttribute("opacity", "0.8");
    edgeLayer.appendChild(path);

    if (e.label) {
      const mid = cubicPt(sx, sy, cx, sy, cx, ty, tx, ty, 0.5);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", mid.x);
      t.setAttribute("y", mid.y - 5);
      t.setAttribute("fill", from.color);
      t.setAttribute("font-size", "10");
      t.setAttribute("font-weight", "600");
      t.setAttribute("text-anchor", "middle");
      t.textContent = e.label;
      edgeLayer.appendChild(t);
    }

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "2.4");
    dot.setAttribute("fill", from.color);
    dot.setAttribute("opacity", "0.9");
    dotLayer.appendChild(dot);
    edgeRecords.push({
      dot,
      sx, sy, c1x: cx, c1y: sy, c2x: cx, c2y: ty, tx, ty,
      offset: Math.random(),
      speed: 0.0005 + Math.random() * 0.0004,
    });
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const meta = n.metadata || {};
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    g.dataset.id = n.id;
    g.dataset.kind = "module";
    g.style.cursor = "pointer";

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", p.w);
    rect.setAttribute("height", p.h);
    rect.setAttribute("rx", 10);
    rect.setAttribute("ry", 10);
    rect.setAttribute("fill", "#111420");
    rect.setAttribute("stroke", p.color);
    rect.setAttribute("stroke-width", "1.4");
    g.appendChild(rect);

    // Header strip
    const headerBg = document.createElementNS(NS, "rect");
    headerBg.setAttribute("width", p.w);
    headerBg.setAttribute("height", 28);
    headerBg.setAttribute("rx", 10);
    headerBg.setAttribute("ry", 10);
    headerBg.setAttribute("fill", p.color + "28");
    g.appendChild(headerBg);

    const icon = document.createElementNS(NS, "text");
    icon.setAttribute("x", "12");
    icon.setAttribute("y", "19");
    icon.setAttribute("fill", p.color);
    icon.setAttribute("font-size", "13");
    icon.textContent = "◎";
    g.appendChild(icon);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "30");
    label.setAttribute("y", "19");
    label.setAttribute("fill", "#d8dcf0");
    label.setAttribute("font-size", "12");
    label.setAttribute("font-weight", "600");
    label.textContent = n.label;
    g.appendChild(label);

    const counts = document.createElementNS(NS, "text");
    counts.setAttribute("x", p.w - 10);
    counts.setAttribute("y", "19");
    counts.setAttribute("fill", p.color + "cc");
    counts.setAttribute("font-size", "11");
    counts.setAttribute("text-anchor", "end");
    counts.textContent = `${meta.functionCount || 0} fn · ${meta.classCount || 0} cls`;
    g.appendChild(counts);

    // Top names preview (up to ~4 lines)
    const topNames = (meta.topNames || []).slice(0, 4);
    topNames.forEach((name, i) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", "14");
      t.setAttribute("y", 46 + i * 15);
      t.setAttribute("fill", "#8890aa");
      t.setAttribute("font-size", "10");
      t.setAttribute("font-family", "Consolas, monospace");
      t.textContent = "· " + name;
      g.appendChild(t);
    });

    g.addEventListener("mouseenter", (e) => {
      rect.setAttribute("stroke-width", "2.2");
      if (ctx.showTooltip) ctx.showTooltip(e, n);
    });
    g.addEventListener("mousemove", (e) => {
      if (ctx.moveTooltip) ctx.moveTooltip(e);
    });
    g.addEventListener("mouseleave", () => {
      rect.setAttribute("stroke-width", "1.4");
      if (ctx.hideTooltip) ctx.hideTooltip();
    });
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Drill into L2 symbol view for this module.
      vscode.postMessage({ type: "navigateLevel", targetLevel: 2, targetId: n.id });
    });

    nodeLayer.appendChild(g);
  }

  return {
    edgeRecords,
    nodeRect: pos,
    nodes,
    initialView: null,
  };
}

function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}
