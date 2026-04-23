// L0 · Package view. Renders folders (packages) as rounded rectangles
// arranged in a force-ish grid, with aggregated cross-package call edges
// as weighted cubic-bezier connectors.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { cubicPt } from "../../shared/geometry.js";
import { theme } from "../../shared/theme.js";

const NODE_W = 240;
const NODE_H = 72;
const COL_GAP = 140;
const ROW_GAP = 80;
const MIN_EDGE_W = 1.2;
const MAX_EDGE_W = 5.5;

const vscode = window.__codemapVscode;

export function renderPackageView(graph, ctx) {
  const { root, defs } = ctx;
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges || [];
  const zoom = (graph.metadata && graph.metadata.zoomContext) || {};
  const colorMap = zoom.moduleColorMap || {};

  // Arrow markers: one per unique color, plus default.
  const seenColors = new Set();
  for (const n of nodes) {
    const c = (n.metadata && n.metadata.color) || colorMap[n.id] || theme.accent;
    if (!seenColors.has(c)) {
      seenColors.add(c);
      mkArrow(defs, `a-pkg-${safeId(n.id)}`, c);
    }
  }
  mkArrow(defs, "a-pkg-default", "#454a60");

  // Layout: grid packing. Keep it deterministic by sorting by label.
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
      color: (n.metadata && n.metadata.color) || colorMap[n.id] || theme.accent,
    });
  });

  // Max callCount → scale edge width.
  let maxCount = 1;
  for (const e of edges) {
    const c = (e.metadata && e.metadata.callCount) || 1;
    if (c > maxCount) maxCount = c;
  }

  // Layers
  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer  = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  // Draw edges (cubic bezier, weighted).
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
    path.setAttribute(
      "d",
      `M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`,
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", from.color + "aa");
    path.setAttribute("stroke-width", width.toFixed(2));
    path.setAttribute("marker-end", `url(#a-pkg-${safeId(e.from)})`);
    path.setAttribute("opacity", "0.85");
    edgeLayer.appendChild(path);

    if (e.label) {
      const mid = cubicPt(0.5, [sx, sy], [cx, sy], [cx, ty], [tx, ty]);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", mid[0]);
      t.setAttribute("y", mid[1] - 6);
      t.setAttribute("fill", from.color);
      t.setAttribute("font-size", "10");
      t.setAttribute("font-weight", "600");
      t.setAttribute("text-anchor", "middle");
      t.textContent = e.label;
      edgeLayer.appendChild(t);
    }

    // Ambient flow dot.
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "2.6");
    dot.setAttribute("fill", from.color);
    dot.setAttribute("opacity", "0.9");
    dotLayer.appendChild(dot);
    edgeRecords.push({
      dot,
      from: [sx, sy], c1: [cx, sy], c2: [cx, ty], to: [tx, ty],
      speed: 0.22 + Math.random() * 0.18,
      phase: Math.random(),
    });
  }

  // Draw nodes.
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const meta = n.metadata || {};
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    g.dataset.id = n.id;
    g.dataset.kind = "package";
    g.style.cursor = "pointer";

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", p.w);
    rect.setAttribute("height", p.h);
    rect.setAttribute("rx", 14);
    rect.setAttribute("ry", 14);
    rect.setAttribute("fill", p.color + "18");
    rect.setAttribute("stroke", p.color);
    rect.setAttribute("stroke-width", "1.5");
    g.appendChild(rect);

    const icon = document.createElementNS(NS, "text");
    icon.setAttribute("x", "14");
    icon.setAttribute("y", "26");
    icon.setAttribute("fill", p.color);
    icon.setAttribute("font-size", "16");
    icon.textContent = "▣";
    g.appendChild(icon);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "36");
    label.setAttribute("y", "28");
    label.setAttribute("fill", "#d8dcf0");
    label.setAttribute("font-size", "15");
    label.setAttribute("font-weight", "600");
    label.textContent = n.label;
    g.appendChild(label);

    const badge = document.createElementNS(NS, "text");
    badge.setAttribute("x", "14");
    badge.setAttribute("y", "52");
    badge.setAttribute("fill", p.color + "cc");
    badge.setAttribute("font-size", "11");
    badge.textContent = `${meta.moduleCount || 0} modules`;
    g.appendChild(badge);

    const fnBadge = document.createElementNS(NS, "text");
    fnBadge.setAttribute("x", p.w - 14);
    fnBadge.setAttribute("y", "52");
    fnBadge.setAttribute("fill", "#606680");
    fnBadge.setAttribute("font-size", "11");
    fnBadge.setAttribute("text-anchor", "end");
    fnBadge.textContent = `${meta.functionCount || 0} fn · ${meta.classCount || 0} cls`;
    g.appendChild(fnBadge);

    // Hover.
    g.addEventListener("mouseenter", (e) => {
      rect.setAttribute("fill", p.color + "2a");
      if (ctx.showTooltip) ctx.showTooltip(e, n);
    });
    g.addEventListener("mousemove", (e) => {
      if (ctx.moveTooltip) ctx.moveTooltip(e);
    });
    g.addEventListener("mouseleave", () => {
      rect.setAttribute("fill", p.color + "18");
      if (ctx.hideTooltip) ctx.hideTooltip();
    });
    // Click → drill into L1.
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: "navigateLevel", targetLevel: 1, targetId: n.id });
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
