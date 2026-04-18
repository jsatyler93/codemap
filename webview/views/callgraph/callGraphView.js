// Call graph view (also used for workspace and trace modes).
// Lays out nodes grouped by module in vertical columns.
// Features: glow filters, node selection/highlight, type labels on edges,
// line numbers, class diamonds, connection counts, exec trace + step-by-step.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { theme, moduleColor } from "../../shared/theme.js";
import { cubicPt } from "../../shared/geometry.js";

const NODE_W = 220, NODE_H = 28, NODE_PAD = 4;
const MOD_PAD_TOP = 32, MOD_PAD_BOTTOM = 12, MOD_PAD_X = 16;
const COL_GAP = 130, COL_TOP = 30;

export function renderCallGraph(graph, ctx) {
  const { root, defs } = ctx;
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges;
  const isTrace = graph.graphType === "trace";

  // ── SVG filters (glow) ──
  mkGlow(defs, "glow", 3);
  mkGlow(defs, "glow-big", 8);

  // ── Group nodes by module ──
  const moduleOrder = [];
  const moduleNodes = new Map();
  for (const n of nodes) {
    const mod = n.module || "<unknown>";
    if (!moduleNodes.has(mod)) {
      moduleNodes.set(mod, []);
      moduleOrder.push(mod);
    }
    moduleNodes.get(mod).push(n);
  }

  // ── Column packing ──
  const colCount = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(moduleOrder.length))));
  const cols = Array.from({ length: colCount }, () => []);
  const colH = new Array(colCount).fill(0);
  for (const mod of moduleOrder) {
    const items = moduleNodes.get(mod);
    const h = MOD_PAD_TOP + items.length * (NODE_H + NODE_PAD) + MOD_PAD_BOTTOM;
    let pick = 0;
    for (let i = 1; i < colCount; i++) if (colH[i] < colH[pick]) pick = i;
    cols[pick].push({ mod, items, h });
    colH[pick] += h + 26;
  }

  // ── Arrow markers per module ──
  const seenColors = new Set();
  for (const mod of moduleOrder) {
    const c = moduleColor(mod);
    if (!seenColors.has(c)) {
      seenColors.add(c);
      mkArrow(defs, `a-${cssId(mod)}`, c);
    }
  }
  mkArrow(defs, "a-default", "#454a60");
  mkArrow(defs, "a-dim", "#0e1018");

  // ── Position nodes ──
  const modulePos = new Map();
  const nodePos = new Map();
  let cx = 60;
  for (const col of cols) {
    let cy = COL_TOP;
    for (const { mod, items, h } of col) {
      modulePos.set(mod, { x: cx, y: cy, w: NODE_W + MOD_PAD_X * 2, h, color: moduleColor(mod) });
      items.forEach((it, i) => {
        nodePos.set(it.id, {
          x: cx + MOD_PAD_X,
          y: cy + MOD_PAD_TOP + i * (NODE_H + NODE_PAD),
          w: NODE_W,
          h: NODE_H,
        });
      });
      cy += h + 26;
    }
    cx += NODE_W + MOD_PAD_X * 2 + COL_GAP;
  }

  // ── Connection counts ──
  const connCount = {};
  for (const n of nodes) connCount[n.id] = { out: 0, in_: 0 };
  for (const e of edges) {
    if (connCount[e.from]) connCount[e.from].out++;
    if (connCount[e.to]) connCount[e.to].in_++;
  }

  // ── Node-to-module lookup ──
  const nodeToModule = {};
  for (const n of nodes) nodeToModule[n.id] = n.module || "<unknown>";

  // ── SVG Layers ──
  const modLayer   = document.createElementNS(NS, "g"); root.appendChild(modLayer);
  const edgeLayer  = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer   = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const execLayer  = document.createElementNS(NS, "g"); root.appendChild(execLayer);
  const nodeLayer  = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  // ── Module boxes ──
  const modEls = {};
  for (const [mod, p] of modulePos.entries()) {
    const g = document.createElementNS(NS, "g");
    g.dataset.module = mod;
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", p.x - 6); r.setAttribute("y", p.y - 6);
    r.setAttribute("width", p.w + 12); r.setAttribute("height", p.h + 12);
    r.setAttribute("rx", 12); r.setAttribute("ry", 12);
    r.setAttribute("fill", p.color + "08");
    r.setAttribute("stroke", p.color + "18");
    r.setAttribute("stroke-width", "1");
    g.appendChild(r);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", p.x + 10); t.setAttribute("y", p.y + 14);
    t.setAttribute("fill", p.color + "70");
    t.setAttribute("font-size", "10"); t.setAttribute("font-weight", "600");
    t.setAttribute("letter-spacing", "0.5");
    t.textContent = mod;
    g.appendChild(t);
    modLayer.appendChild(g);
    modEls[mod] = { g, rect: r, text: t };
  }

  // ── Nodes ──
  const nodeRect = new Map();
  const nodeEls = {};
  for (const n of nodes) {
    const p = nodePos.get(n.id);
    if (!p) continue;
    const isClass = n.kind === "class";
    const isRoot = (graph.rootNodeIds || []).includes(n.id);
    const col = moduleColor(n.module || "");
    nodeRect.set(n.id, { ...p, color: col });

    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    g.dataset.id = n.id;
    g.style.cursor = "pointer";

    const r = document.createElementNS(NS, "rect");
    r.setAttribute("width", p.w); r.setAttribute("height", p.h);
    r.setAttribute("rx", 5); r.setAttribute("ry", 5);
    r.setAttribute("fill", isClass ? col + "12" : "#111420");
    r.setAttribute("stroke", isRoot ? col : col + "30");
    r.setAttribute("stroke-width", isRoot ? "2" : "1");
    g.appendChild(r);

    // Label with class diamond prefix
    const lb = document.createElementNS(NS, "text");
    lb.setAttribute("x", "11"); lb.setAttribute("y", String(p.h / 2 + 1));
    lb.setAttribute("dominant-baseline", "middle");
    lb.setAttribute("fill", isClass ? col + "dd" : "#8890aa");
    lb.setAttribute("font-size", "10");
    lb.setAttribute("font-weight", isClass ? "600" : "400");
    lb.textContent = (isClass ? "◆ " : "") + (n.label || n.id);
    g.appendChild(lb);

    // Line number
    const lineNum = n.source && n.source.line ? n.source.line : null;
    const rightText = n.metadata && n.metadata.isAsync ? "async" : (lineNum ? ":" + lineNum : "");
    if (rightText) {
      const rt = document.createElementNS(NS, "text");
      rt.setAttribute("x", String(p.w - 7));
      rt.setAttribute("y", String(p.h / 2 + 1));
      rt.setAttribute("text-anchor", "end");
      rt.setAttribute("dominant-baseline", "middle");
      rt.setAttribute("fill", "#222640");
      rt.setAttribute("font-size", "8");
      rt.textContent = rightText;
      g.appendChild(rt);
    }

    // Tooltip with connection counts
    g.addEventListener("mouseenter", (e) => {
      const cc = connCount[n.id] || { out: 0, in_: 0 };
      const augmented = { ...n, _connOut: cc.out, _connIn: cc.in_ };
      ctx.showTooltip(e, augmented);
    });
    g.addEventListener("mousemove", (e) => ctx.moveTooltip(e));
    g.addEventListener("mouseleave", () => ctx.hideTooltip());

    // Click → select node (highlight connected, dim rest)
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      selectNode(n.id);
      ctx.onNodeClick(n);
    });

    // Double-click → request flowchart for this node
    g.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (ctx.onNodeDblClick) ctx.onNodeDblClick(n);
    });

    nodeLayer.appendChild(g);
    nodeEls[n.id] = { g, rect: r, node: n, col };
  }

  // ── Edges ──
  const edgeRecords = [];
  const edgeMap = {};
  for (const e of edges) {
    const sp = nodePos.get(e.from);
    const tp = nodePos.get(e.to);
    if (!sp || !tp) continue;
    const fromMod = nodeToModule[e.from];
    const toMod = nodeToModule[e.to];
    const sameMod = fromMod && fromMod === toMod;
    const col = moduleColor(fromMod || "");
    const resAlpha = e.resolution === "unresolved" ? "18"
                   : e.resolution === "likely" ? "55" : "80";

    let sx, sy, tx, ty, c1x, c1y, c2x, c2y, dStr;
    if (sameMod) {
      const mp = modulePos.get(fromMod);
      const leftX = mp.x - 20;
      sx = sp.x; sy = sp.y + sp.h / 2;
      tx = tp.x; ty = tp.y + tp.h / 2;
      c1x = leftX; c1y = sy; c2x = leftX; c2y = ty;
      dStr = `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
    } else {
      sx = sp.x + sp.w; sy = sp.y + sp.h / 2;
      tx = tp.x; ty = tp.y + tp.h / 2;
      const dx = tx - sx;
      c1x = sx + dx * 0.42; c1y = sy;
      c2x = tx - dx * 0.42; c2y = ty;
      dStr = `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
    }

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", dStr);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", col + resAlpha);
    path.setAttribute("stroke-width", "1");
    if (e.resolution === "likely") path.setAttribute("stroke-dasharray", "3 3");
    else if (e.resolution === "unresolved") path.setAttribute("stroke-dasharray", "1 4");
    if (!sameMod) path.setAttribute("marker-end", `url(#a-${cssId(fromMod || "default")})`);
    edgeLayer.appendChild(path);

    // Type label on edge (param types → return type)
    const typeLabel = buildEdgeTypeLabel(e, nodes);
    if (e.label || typeLabel) {
      const mid = cubicPt(sx, sy, c1x, c1y, c2x, c2y, tx, ty, 0.5);
      if (e.label) {
        const lt = document.createElementNS(NS, "text");
        lt.setAttribute("x", String(mid.x)); lt.setAttribute("y", String(mid.y - (typeLabel ? 10 : 4)));
        lt.setAttribute("text-anchor", "middle");
        lt.setAttribute("fill", col + "aa"); lt.setAttribute("font-size", "9");
        lt.textContent = e.label;
        edgeLayer.appendChild(lt);
      }
      if (typeLabel) {
        const tt = document.createElementNS(NS, "text");
        tt.setAttribute("x", String(mid.x)); tt.setAttribute("y", String(mid.y + (e.label ? 4 : -4)));
        tt.setAttribute("text-anchor", "middle");
        tt.setAttribute("fill", col + "55"); tt.setAttribute("font-size", "7.5");
        tt.setAttribute("font-style", "italic");
        tt.textContent = typeLabel;
        edgeLayer.appendChild(tt);
      }
    }

    // Ambient dots (2 for cross-module, 1 for same-module)
    const ambDots = [];
    const dotCount = sameMod ? 1 : 2;
    for (let di = 0; di < dotCount; di++) {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "1.2"); dot.setAttribute("fill", col);
      dot.setAttribute("opacity", "0");
      dotLayer.appendChild(dot);
      ambDots.push({ el: dot, offset: di * 0.5, speed: 0.0005 + Math.random() * 0.0004 });
    }

    const idx = edgeRecords.length;
    edgeMap[e.from + "->" + e.to] = idx;
    edgeRecords.push({
      el: path, src: e.from, tgt: e.to, color: col, sameMod,
      sx, sy, c1x, c1y, c2x, c2y, tx, ty,
      dot: ambDots[0]?.el, // compat with main.js animation
      offset: Math.random(), speed: 0.0005 + Math.random() * 0.0004,
      ambDots,
    });
  }

  // ── Node selection (click to highlight) ──
  let selectedNode = null;

  function selectNode(id) {
    if (selectedNode === id) { resetSelection(); return; }
    selectedNode = id;
    const conn = new Set([id]);
    const connEdges = new Set();
    edgeRecords.forEach((e, i) => {
      if (e.src === id || e.tgt === id) {
        conn.add(e.src); conn.add(e.tgt);
        connEdges.add(i);
      }
    });
    const connMods = new Set();
    conn.forEach((nid) => connMods.add(nodeToModule[nid]));

    // Dim/highlight nodes
    Object.entries(nodeEls).forEach(([nid, ne]) => {
      const hit = conn.has(nid);
      const m = moduleColor(ne.node.module || "");
      ne.rect.setAttribute("opacity", hit ? "1" : "0.06");
      ne.g.querySelectorAll("text").forEach((t) => t.setAttribute("opacity", hit ? "1" : "0.06"));
      if (hit && nid === id) {
        ne.rect.setAttribute("stroke", m);
        ne.rect.setAttribute("stroke-width", "2");
        ne.rect.setAttribute("filter", "url(#glow)");
      } else if (hit) {
        ne.rect.setAttribute("stroke", m + "88");
        ne.rect.setAttribute("stroke-width", "1.5");
        ne.rect.removeAttribute("filter");
      } else {
        ne.rect.setAttribute("stroke-width", ".5");
        ne.rect.removeAttribute("filter");
      }
    });

    // Dim/highlight edges
    edgeRecords.forEach((e, i) => {
      if (connEdges.has(i)) {
        e.el.setAttribute("stroke", e.color + "88");
        e.el.setAttribute("stroke-width", "1.5");
        e.ambDots.forEach((d) => d.el.setAttribute("opacity", "0.6"));
      } else {
        e.el.setAttribute("stroke", "#0a0c12");
        e.el.setAttribute("stroke-width", ".3");
        e.ambDots.forEach((d) => d.el.setAttribute("opacity", "0"));
      }
    });

    // Dim/highlight modules
    Object.entries(modEls).forEach(([mk, me]) => {
      const hit = connMods.has(mk);
      me.rect.setAttribute("opacity", hit ? "1" : "0.04");
      me.text.setAttribute("opacity", hit ? "1" : "0.04");
    });
  }

  function resetSelection() {
    selectedNode = null;
    Object.entries(nodeEls).forEach(([nid, ne]) => {
      const m = moduleColor(ne.node.module || "");
      const isRoot = (graph.rootNodeIds || []).includes(nid);
      ne.rect.setAttribute("opacity", "1");
      ne.rect.setAttribute("stroke", isRoot ? m : m + "30");
      ne.rect.setAttribute("stroke-width", isRoot ? "2" : "1");
      ne.rect.removeAttribute("filter");
      ne.g.querySelectorAll("text").forEach((t) => t.setAttribute("opacity", "1"));
    });
    edgeRecords.forEach((e) => {
      e.el.setAttribute("stroke", e.color + "22");
      e.el.setAttribute("stroke-width", "1");
      if (!e.sameMod) e.el.setAttribute("marker-end", `url(#a-${cssId(nodeToModule[e.src] || "default")})`);
      e.ambDots.forEach((d) => d.el.setAttribute("opacity", "0.3"));
    });
    Object.values(modEls).forEach((me) => {
      me.rect.setAttribute("opacity", "1");
      me.text.setAttribute("opacity", "1");
    });
  }

  // Store for external hooks
  ctx._resetSelection = resetSelection;
  ctx._selectNode = selectNode;

  // ── Exec Trace (auto + step-by-step) ──
  let execTimeline = [];
  if (isTrace) {
    execTimeline = edges
      .filter((e) => e.kind === "execution_step")
      .sort((a, b) => {
        const sa = parseInt(a.label) || 0;
        const sb = parseInt(b.label) || 0;
        return sa - sb;
      })
      .map((e) => {
        const targetNode = nodes.find((n) => n.id === e.to);
        return {
          edge: [e.from, e.to],
          label: targetNode ? (targetNode.label || targetNode.id) : e.to,
          desc: targetNode?.metadata?.docSummary || "",
        };
      });
  }

  // Expose trace controls to main.js
  ctx._execTimeline = execTimeline;
  ctx._edgeMap = edgeMap;
  ctx._edgeRecords = edgeRecords;
  ctx._nodeEls = nodeEls;
  ctx._modEls = modEls;
  ctx._nodeToModule = nodeToModule;
  ctx._execLayer = execLayer;

  ctx._highlightStep = function (stepIdx) {
    if (stepIdx < 0 || stepIdx >= execTimeline.length) return;
    const step = execTimeline[stepIdx];
    const key = step.edge[0] + "->" + step.edge[1];
    const ei = edgeMap[key];

    // Dim everything
    Object.entries(nodeEls).forEach(([nid, ne]) => {
      const m = moduleColor(ne.node.module || "");
      ne.rect.setAttribute("opacity", "0.12");
      ne.rect.setAttribute("stroke", m + "15");
      ne.rect.setAttribute("stroke-width", ".5");
      ne.rect.removeAttribute("filter");
      ne.g.querySelectorAll("text").forEach((t) => t.setAttribute("opacity", "0.12"));
    });
    edgeRecords.forEach((e) => {
      e.el.setAttribute("stroke", e.color + "08");
      e.el.setAttribute("stroke-width", ".5");
      e.ambDots.forEach((d) => d.el.setAttribute("opacity", "0"));
    });
    Object.values(modEls).forEach((me) => {
      me.rect.setAttribute("opacity", "0.06");
      me.text.setAttribute("opacity", "0.06");
    });

    // Highlight source + target
    if (ei !== undefined) {
      const e = edgeRecords[ei];
      e.el.setAttribute("stroke", e.color + "cc");
      e.el.setAttribute("stroke-width", "2.5");
      [e.src, e.tgt].forEach((nid) => {
        if (!nodeEls[nid]) return;
        const m = moduleColor(nodeEls[nid].node.module || "");
        nodeEls[nid].rect.setAttribute("opacity", "1");
        nodeEls[nid].rect.setAttribute("stroke", m);
        nodeEls[nid].rect.setAttribute("stroke-width", "2");
        nodeEls[nid].rect.setAttribute("filter", "url(#glow)");
        nodeEls[nid].g.querySelectorAll("text").forEach((t) => t.setAttribute("opacity", "1"));
      });
      const mods = new Set([nodeToModule[e.src], nodeToModule[e.tgt]]);
      Object.entries(modEls).forEach(([mk, me]) => {
        const hit = mods.has(mk);
        me.rect.setAttribute("opacity", hit ? "0.8" : "0.06");
        me.text.setAttribute("opacity", hit ? "1" : "0.06");
      });
    }
  };

  ctx._spawnExecDot = function (edgeIdx, color) {
    const e = edgeRecords[edgeIdx];
    if (!e) return null;
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "5"); dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.9"); dot.setAttribute("filter", "url(#glow-big)");
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
    return { el: dot, trails, t: 0, speed: 0.006, edge: e, alive: true };
  };

  ctx._clearExecDots = function () {
    while (execLayer.firstChild) execLayer.removeChild(execLayer.firstChild);
  };

  // ── Legend ──
  const lg = document.getElementById("lg-items");
  if (lg) {
    lg.innerHTML = "";
    document.getElementById("lg-title").textContent = "Modules";
    for (const mod of moduleOrder) {
      const c = moduleColor(mod);
      const d = document.createElement("div");
      d.className = "lg-item";
      d.innerHTML = `<span class="lg-shape" style="background:${c};width:7px;height:7px;border-radius:2px"></span>${mod}`;
      lg.appendChild(d);
    }
  }

  return {
    edgeRecords, nodeRect, nodes,
    initialView: { scale: 0.82, panX: 30, panY: 10 },
    resetSelection,
  };
}

// ── Helpers ──

function cssId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mkGlow(defs, id, std) {
  const f = document.createElementNS(NS, "filter");
  f.setAttribute("id", id);
  f.setAttribute("x", "-100%"); f.setAttribute("y", "-100%");
  f.setAttribute("width", "300%"); f.setAttribute("height", "300%");
  const gb = document.createElementNS(NS, "feGaussianBlur");
  gb.setAttribute("stdDeviation", String(std));
  gb.setAttribute("result", "b");
  f.appendChild(gb);
  const fm = document.createElementNS(NS, "feMerge");
  ["b", "SourceGraphic"].forEach((inp) => {
    const n = document.createElementNS(NS, "feMergeNode");
    n.setAttribute("in", inp);
    fm.appendChild(n);
  });
  f.appendChild(fm);
  defs.appendChild(f);
}

function buildEdgeTypeLabel(edge, nodes) {
  const targetNode = nodes.find((n) => n.id === edge.to);
  if (!targetNode || !targetNode.metadata) return "";
  const meta = targetNode.metadata;
  const parts = [];
  if (meta.params && meta.params.length > 0) {
    const typed = meta.params.filter((p) => p.type);
    if (typed.length > 0) {
      const paramStr = typed.slice(0, 3).map((p) => p.type).join(", ");
      parts.push(typed.length > 3 ? paramStr + "…" : paramStr);
    }
  }
  if (meta.returnType) {
    parts.push("→ " + meta.returnType);
  }
  return parts.join(" ");
}
