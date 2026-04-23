// Unified semantic zoom renderer. Renders packages, modules, and symbols
// on a single SVG canvas. Zoom-scale thresholds control which level of
// detail is visible via CSS classes on the root <g> element.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { cubicPt } from "../../shared/geometry.js";
import { theme } from "../../shared/theme.js";

const vscode = window.__codemapVscode;

// ── SVG helpers ──

function mkG(parent, cls) {
  const el = document.createElementNS(NS, "g");
  if (cls) el.setAttribute("class", cls);
  parent.appendChild(el);
  return el;
}

function mkRect(parent, x, y, w, h, rx, fill, stroke, sw) {
  const el = document.createElementNS(NS, "rect");
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("width", w);
  el.setAttribute("height", h);
  if (rx) {
    el.setAttribute("rx", rx);
    el.setAttribute("ry", rx);
  }
  el.setAttribute("fill", fill || "none");
  if (stroke) {
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", sw || 1);
  }
  parent.appendChild(el);
  return el;
}

function mkText(parent, x, y, fill, size, content, opts) {
  const el = document.createElementNS(NS, "text");
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.setAttribute("fill", fill);
  el.setAttribute("font-size", size);
  if (opts && opts.weight) el.setAttribute("font-weight", opts.weight);
  if (opts && opts.anchor) el.setAttribute("text-anchor", opts.anchor);
  if (opts && opts.family) el.setAttribute("font-family", opts.family);
  el.textContent = content;
  parent.appendChild(el);
  return el;
}

function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}

// ── Edge drawing ──

function drawEdges(edges, pos, layer, records, level) {
  let maxCount = 1;
  for (const e of edges) {
    const c = (e.metadata && e.metadata.callCount) || 1;
    if (c > maxCount) maxCount = c;
  }

  for (const e of edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue;

    const count = (e.metadata && e.metadata.callCount) || 1;
    const width = level === 2 ? 0.8 : 1.2 + 3.5 * (count / maxCount);
    const color = from.color + "88";

    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = to.x;
    const ty = to.y + to.h / 2;
    const cx = sx + Math.min(200, Math.max(50, Math.abs(tx - sx) / 2));

    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      `M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`,
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", width.toFixed(2));
    path.setAttribute("opacity", "0.8");
    layer.appendChild(path);

    if (e.label) {
      const mid = cubicPt(sx, sy, cx, sy, cx, ty, tx, ty, 0.5);
      mkText(layer, mid.x, mid.y - 5, from.color, 10, e.label, {
        anchor: "middle",
        weight: "600",
      });
    }

    // Ambient flow dot
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", level === 2 ? "1" : "2.2");
    dot.setAttribute("fill", from.color);
    dot.setAttribute("opacity", "0");
    layer.appendChild(dot);

    records.push({
      sx,
      sy,
      c1x: cx,
      c1y: sy,
      c2x: cx,
      c2y: ty,
      tx,
      ty,
      dot,
      offset: Math.random(),
      speed: 0.0004 + Math.random() * 0.0003,
    });
  }
}

// ── Main renderer ──

export function renderUnifiedView(graph, ctx) {
  const { root, defs, canvas } = ctx;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];

  // Separate by level
  const pkgNodes = nodes.filter((n) => n.metadata && n.metadata.level === 0);
  const modNodes = nodes.filter((n) => n.metadata && n.metadata.level === 1);
  const symNodes = nodes.filter((n) => n.metadata && n.metadata.level === 2);
  const l0Edges = edges.filter((e) => e.metadata && e.metadata.level === 0);
  const l1Edges = edges.filter((e) => e.metadata && e.metadata.level === 1);
  const l2Edges = edges.filter((e) => e.metadata && e.metadata.level === 2);

  // Position lookup
  const pos = new Map();
  for (const n of nodes) {
    const m = n.metadata || {};
    if (m.x !== undefined) {
      pos.set(n.id, {
        x: m.x,
        y: m.y,
        w: m.w,
        h: m.h,
        color: m.color || theme.accent,
      });
    }
  }

  // Arrow markers
  mkArrow(defs, "a-uni", "#454a60");
  const seenColors = new Set();
  for (const n of pkgNodes.concat(modNodes)) {
    const c = n.metadata && n.metadata.color;
    if (c && !seenColors.has(c)) {
      seenColors.add(c);
      mkArrow(defs, "a-uni-" + safeId(n.id), c);
    }
  }

  // Layer groups
  const eG0 = mkG(root, "sem-edge-0");
  const eG1 = mkG(root, "sem-edge-1");
  const eG2 = mkG(root, "sem-edge-2");
  const nodeG = mkG(root);

  const edgeRecords = [];

  drawEdges(l0Edges, pos, eG0, edgeRecords, 0);
  drawEdges(l1Edges, pos, eG1, edgeRecords, 1);
  drawEdges(l2Edges, pos, eG2, edgeRecords, 2);

  // ── Package containers ──
  for (const n of pkgNodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const meta = n.metadata || {};
    const pg = mkG(nodeG, "sem-pkg");
    pg.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
    pg.dataset.id = n.id;
    pg.dataset.kind = "package";
    pg.style.cursor = "pointer";

    const bgRect = mkRect(
      pg,
      0,
      0,
      p.w,
      p.h,
      16,
      p.color + "14",
      p.color,
      1.2,
    );

    const det = mkG(pg, "sem-l0-detail");
    mkText(det, 16, 32, p.color, 18, "\u25A3");
    mkText(det, 42, 34, "#d8dcf0", 17, n.label, { weight: "600" });
    mkText(
      det,
      16,
      56,
      p.color + "cc",
      12,
      (meta.moduleCount || 0) + " modules",
    );
    mkText(
      det,
      p.w - 16,
      56,
      "#606680",
      11,
      (meta.functionCount || 0) + " fn \u00b7 " + (meta.classCount || 0) + " cls",
      { anchor: "end" },
    );

    pg.addEventListener("mouseenter", function () {
      bgRect.setAttribute("fill", p.color + "22");
    });
    pg.addEventListener("mouseleave", function () {
      bgRect.setAttribute("fill", p.color + "14");
    });

    pg.addEventListener("dblclick", function (ev) {
      ev.stopPropagation();
      if (!canvas || !canvas.animateZoomTo) return;
      var rc = canvas.svg.getBoundingClientRect();
      var ts = Math.min(rc.width / (p.w + 80), rc.height / (p.h + 80));
      canvas.animateZoomTo(
        p.x + p.w / 2,
        p.y + p.h / 2,
        Math.max(0.5, ts),
      );
    });
  }

  // ── Module containers ──
  for (const n of modNodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const meta = n.metadata || {};
    const mg = mkG(nodeG, "sem-l1");
    mg.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
    mg.dataset.id = n.id;
    mg.dataset.kind = "module";
    mg.style.cursor = "pointer";

    const modRect = mkRect(mg, 0, 0, p.w, p.h, 10, "#111420", p.color, 1.2);
    mkRect(mg, 0, 0, p.w, 28, 10, p.color + "22", null, 0);

    const lbl = mkG(mg, "sem-l1-label");
    mkText(lbl, 12, 19, p.color, 12, "\u25CE");
    mkText(lbl, 28, 19, "#d8dcf0", 11, n.label, { weight: "600" });
    mkText(lbl, p.w - 10, 19, p.color + "cc", 10, (meta.functionCount || 0) + " fn", {
      anchor: "end",
    });

    mg.addEventListener("mouseenter", function () {
      modRect.setAttribute("stroke-width", "2");
    });
    mg.addEventListener("mouseleave", function () {
      modRect.setAttribute("stroke-width", "1.2");
    });

    mg.addEventListener("dblclick", function (ev) {
      ev.stopPropagation();
      if (!canvas || !canvas.animateZoomTo) return;
      var rc = canvas.svg.getBoundingClientRect();
      var ts = Math.min(rc.width / (p.w + 60), rc.height / (p.h + 60));
      canvas.animateZoomTo(
        p.x + p.w / 2,
        p.y + p.h / 2,
        Math.max(1.3, ts),
      );
    });
  }

  // ── Symbol nodes ──
  for (const n of symNodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const sg = mkG(nodeG, "sem-l2");
    sg.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
    sg.dataset.id = n.id;
    sg.dataset.kind = n.kind;
    sg.style.cursor = "pointer";

    const icon =
      n.kind === "class" ? "\u25C6" : n.kind === "method" ? "\u25C7" : "\u0192";
    mkRect(sg, 0, 0, p.w, p.h, 6, p.color + "18", p.color + "66", 0.8);
    mkText(sg, 8, p.h * 0.65, p.color, 11, icon);
    mkText(sg, 22, p.h * 0.65, "#c8cce0", 10, n.label);

    sg.addEventListener("mouseenter", function (e) {
      if (ctx.showTooltip) ctx.showTooltip(e, n);
    });
    sg.addEventListener("mousemove", function (e) {
      if (ctx.moveTooltip) ctx.moveTooltip(e);
    });
    sg.addEventListener("mouseleave", function () {
      if (ctx.hideTooltip) ctx.hideTooltip();
    });

    sg.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (ctx.onNodeClick) ctx.onNodeClick(n);
    });

    sg.addEventListener("dblclick", function (ev) {
      ev.stopPropagation();
      if (n.kind === "function" || n.kind === "method") {
        vscode.postMessage({
          type: "navigateLevel",
          targetLevel: 3,
          targetId: n.id,
        });
      }
    });
  }

  // ── Scale watcher: toggle zoom-level CSS class ──
  function updateZoomClass(scale) {
    root.classList.remove("zoom-pkg", "zoom-mod", "zoom-sym");
    if (scale < 0.45) root.classList.add("zoom-pkg");
    else if (scale < 1.3) root.classList.add("zoom-mod");
    else root.classList.add("zoom-sym");
  }

  if (canvas && canvas.onScaleChange) {
    canvas.onScaleChange(updateZoomClass);
  }
  updateZoomClass(canvas && canvas.state ? canvas.state.scale : 0.3);

  // ── Compute initial view to fit all packages ──
  const allP = pkgNodes.map((n) => pos.get(n.id)).filter(Boolean);
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const p of allP) {
    bx0 = Math.min(bx0, p.x);
    by0 = Math.min(by0, p.y);
    bx1 = Math.max(bx1, p.x + p.w);
    by1 = Math.max(by1, p.y + p.h);
  }
  const cw = bx1 - bx0 + 160;
  const ch = by1 - by0 + 160;
  const svgRect =
    canvas && canvas.svg && canvas.svg.getBoundingClientRect
      ? canvas.svg.getBoundingClientRect()
      : { width: 1200, height: 800 };
  const fitS = Math.min(svgRect.width / cw, svgRect.height / ch, 0.4);
  const s = Math.max(0.1, fitS);

  return {
    edgeRecords: edgeRecords,
    nodeRect: pos,
    nodes: nodes,
    initialView: {
      scale: s,
      panX: (svgRect.width - cw * s) / 2 - (bx0 - 80) * s,
      panY: (svgRect.height - ch * s) / 2 - (by0 - 80) * s,
    },
  };
}
