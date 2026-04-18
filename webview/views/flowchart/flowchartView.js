// Flowchart view. Lays out nodes vertically with light branching for
// decision nodes. Driven by GraphDocument JSON (graphType === 'flowchart').

import { NS, mkArrow } from "../../shared/panZoom.js";
import { theme } from "../../shared/theme.js";
import { cubicPt } from "../../shared/geometry.js";

const NODE_W = 240;
const NODE_MIN_H = 36;
const LINE_H = 12;
const ROW_GAP = 30;
const BRANCH_GAP = 240;

export function renderFlowchart(graph, ctx) {
  const { root, defs } = ctx;
  const canvasState = ctx.canvas?.state;
  let suppressPointerClicksUntil = 0;
  Object.entries(theme.nodeColor).forEach(([k, c]) => mkArrow(defs, `a-${k}`, c));
  mkArrow(defs, "a-default", "#454a60");

  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges;
  const prepared = new Map(nodes.map((n) => [n.id, prepareNode(n)]));

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
    const n = prepared.get(nodeId);
    if (!n) return;
    positions.set(nodeId, { x: x - NODE_W / 2, y: cursorY, h: n.h });
    cursorY += n.h + ROW_GAP;
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
      const preparedNode = prepared.get(n.id);
      positions.set(n.id, { x: 100, y: cursorY, h: preparedNode ? preparedNode.h : NODE_MIN_H });
      cursorY += (preparedNode ? preparedNode.h : NODE_MIN_H) + ROW_GAP;
    }
  }

  // Layers
  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer  = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  // --- nodes ---
  const nodeRect = new Map();
  const nodeEls = new Map();
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const col = theme.nodeColor[n.kind] || theme.nodeColor.process;
    const w = NODE_W;
    const preparedNode = prepared.get(n.id) || prepareNode(n);
    const h = preparedNode.h;
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

    const textLines = preparedNode.lines;
    const totalLineCount = textLines.length + (preparedNode.typeLine ? 1 : 0);
    const totalH = totalLineCount * LINE_H;
    textLines.forEach((line, i) => {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(w / 2));
      t.setAttribute("y", String(h / 2 - totalH / 2 + i * LINE_H + 9));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", col + "dd");
      t.setAttribute("font-size", "10");
      t.textContent = line;
      g.appendChild(t);
    });

    if (preparedNode.typeLine) {
      const typeText = document.createElementNS(NS, "text");
      typeText.setAttribute("x", String(w / 2));
      typeText.setAttribute("y", String(h / 2 - totalH / 2 + textLines.length * LINE_H + 9));
      typeText.setAttribute("text-anchor", "middle");
      typeText.setAttribute("fill", col + "88");
      typeText.setAttribute("font-size", "8");
      typeText.setAttribute("font-style", "italic");
      typeText.textContent = preparedNode.typeLine;
      g.appendChild(typeText);
    }

    g.addEventListener("mouseenter", (e) => ctx.showTooltip(e, n));
    g.addEventListener("mousemove", (e) => ctx.moveTooltip(e));
    g.addEventListener("mouseleave", () => ctx.hideTooltip());
    g.addEventListener("click", (e) => {
      if (performance.now() < suppressPointerClicksUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      ctx.onNodeClick(n);
    });

    let dragState = null;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = nodeRect.get(n.id);
      if (!rect) return;
      dragState = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: rect.x,
        startY: rect.y,
        moved: false,
      };
      g.setPointerCapture?.(e.pointerId);
      g.classList.add("node-dragging");
      ctx.hideTooltip();
      e.stopPropagation();
      e.preventDefault();
    });
    g.addEventListener("pointermove", (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      const scale = canvasState?.scale || 1;
      const dx = (e.clientX - dragState.startClientX) / scale;
      const dy = (e.clientY - dragState.startClientY) / scale;
      if (!dragState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        dragState.moved = true;
        nodeLayer.appendChild(g);
      }
      if (!dragState.moved) return;
      const rect = nodeRect.get(n.id);
      if (!rect) return;
      rect.x = dragState.startX + dx;
      rect.y = dragState.startY + dy;
      updateNodePosition(n.id);
      refreshLayoutForNode(n.id);
      e.stopPropagation();
      e.preventDefault();
    });
    g.addEventListener("pointerup", (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      if (dragState.moved) {
        suppressPointerClicksUntil = performance.now() + 250;
      }
      g.classList.remove("node-dragging");
      g.releasePointerCapture?.(e.pointerId);
      dragState = null;
      e.stopPropagation();
    });
    g.addEventListener("pointercancel", (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      g.classList.remove("node-dragging");
      dragState = null;
    });

    nodeLayer.appendChild(g);
    nodeEls.set(n.id, g);
  }

  // --- edges ---
  const edgeRecords = [];
  const edgeMap = {};
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

    let labelEl = null;
    if (e.label) {
      const mid = cubicPt(sp.x, sp.y, c1x, c1y, c2x, c2y, tp.x, tp.y, 0.35);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(mid.x + 6));
      t.setAttribute("y", String(mid.y - 4));
      t.setAttribute("fill", col + "88");
      t.setAttribute("font-size", "8.5");
      t.textContent = e.label;
      edgeLayer.appendChild(t);
      labelEl = t;
    }

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "1.3"); dot.setAttribute("fill", col);
    dot.setAttribute("opacity", "0");
    dotLayer.appendChild(dot);
    edgeMap[e.from + "->" + e.to] = edgeRecords.length;
    edgeRecords.push({
      el: path,
      src: e.from,
      tgt: e.to,
      labelEl,
      sx: sp.x, sy: sp.y, c1x, c1y, c2x, c2y, tx: tp.x, ty: tp.y,
      dot, offset: Math.random(), speed: 0.0006 + Math.random() * 0.0004,
    });
  }

  function updateNodePosition(nodeId) {
    const rect = nodeRect.get(nodeId);
    const group = nodeEls.get(nodeId);
    if (!rect || !group) return;
    group.setAttribute("transform", `translate(${rect.x},${rect.y})`);
  }

  function updateEdgeGeometry(edge) {
    const fromR = nodeRect.get(edge.src);
    const toR = nodeRect.get(edge.tgt);
    if (!fromR || !toR) return;
    const sp = { x: fromR.x + fromR.w / 2, y: fromR.y + fromR.h };
    const tp = { x: toR.x + toR.w / 2, y: toR.y };
    let c1x;
    let c1y;
    let c2x;
    let c2y;
    if (Math.abs(tp.x - sp.x) < 1) {
      c1x = sp.x;
      c1y = (sp.y + tp.y) / 2;
      c2x = tp.x;
      c2y = (sp.y + tp.y) / 2;
    } else {
      const my = (sp.y + tp.y) / 2;
      c1x = sp.x;
      c1y = my;
      c2x = tp.x;
      c2y = my;
    }
    edge.sx = sp.x;
    edge.sy = sp.y;
    edge.tx = tp.x;
    edge.ty = tp.y;
    edge.c1x = c1x;
    edge.c1y = c1y;
    edge.c2x = c2x;
    edge.c2y = c2y;
    edge.el.setAttribute("d", `M${sp.x},${sp.y} C${c1x},${c1y} ${c2x},${c2y} ${tp.x},${tp.y}`);
    if (edge.labelEl) {
      const mid = cubicPt(sp.x, sp.y, c1x, c1y, c2x, c2y, tp.x, tp.y, 0.35);
      edge.labelEl.setAttribute("x", String(mid.x + 6));
      edge.labelEl.setAttribute("y", String(mid.y - 4));
    }
  }

  function refreshLayoutForNode(nodeId) {
    edgeRecords.forEach((edge) => {
      if (edge.src === nodeId || edge.tgt === nodeId) {
        updateEdgeGeometry(edge);
      }
    });
  }

  // Exec dot layer for live debug particle
  const execLayer = document.createElementNS(NS, "g");
  root.appendChild(execLayer);
  ctx._edgeMap = edgeMap;
  ctx._edgeRecords = edgeRecords;
  ctx._spawnExecDot = function (edgeIdx, color) {
    const e = edgeRecords[edgeIdx];
    if (!e) return null;
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "5"); dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.95");
    execLayer.appendChild(dot);
    const trails = [];
    for (let i = 0; i < 5; i++) {
      const tr = document.createElementNS(NS, "circle");
      tr.setAttribute("r", String(4 - i * 0.7));
      tr.setAttribute("fill", color);
      tr.setAttribute("opacity", String(0.35 - i * 0.06));
      execLayer.appendChild(tr);
      trails.push({ el: tr });
    }
    return { el: dot, trails, t: 0, speed: 0.012, edge: e, alive: true };
  };
  ctx._clearExecDots = function () {
    while (execLayer.firstChild) execLayer.removeChild(execLayer.firstChild);
  };

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

function prepareNode(node) {
  const meta = node.metadata || {};
  const rawLines = Array.isArray(meta.displayLines) && meta.displayLines.length
    ? meta.displayLines.map(String)
    : String(node.label || "").split("\n");
  const displayLines = rawLines;
  const typeLine = meta.typeLabel ? String(meta.typeLabel) : "";
  const totalLineCount = displayLines.length + (typeLine ? 1 : 0);
  const h = Math.max(NODE_MIN_H, 16 + totalLineCount * LINE_H + 8);
  return { lines: displayLines, typeLine, h };
}
