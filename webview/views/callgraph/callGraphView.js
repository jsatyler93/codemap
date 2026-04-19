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
const METHOD_INDENT = 18;
const MODULE_SUMMARY_W = 210;
const MODULE_SUMMARY_H = 56;

export function renderCallGraph(graph, ctx) {
  const { root, defs } = ctx;
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const edges = graph.edges;
  const isTrace = graph.graphType === "trace";
  const canvasState = ctx.canvas?.state;
  const forceOptions = {
    overlapRepel: clamp01(ctx.uiState?.repelStrength ?? 0.35),
    linkAttract: clamp01(ctx.uiState?.attractStrength ?? 0.28),
    ambientRepel: clamp01(ctx.uiState?.ambientRepelStrength ?? 0.18),
  };
  const savedNodes = ctx.layoutSnapshot?.nodes || {};
  const savedGroups = ctx.layoutSnapshot?.groups || {};
  let suppressPointerClicksUntil = 0;

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
  for (const [mod, items] of moduleNodes.entries()) {
    moduleNodes.set(mod, orderModuleNodes(items));
  }
  const moduleState = new Map(moduleOrder.map((mod) => [mod, {
    collapsed: !!savedGroups[moduleGroupId(mod)]?.collapsed,
  }]));
  const classGroups = buildClassGroups(moduleOrder, moduleNodes);
  const classGroupMap = new Map(classGroups.map((group) => [group.id, group]));
  const classGroupByNode = new Map();
  classGroups.forEach((group) => {
    group.memberIds.forEach((nodeId) => classGroupByNode.set(nodeId, group.id));
  });
  const classGroupState = new Map(classGroups.map((group) => [group.id, {
    collapsed: !!savedGroups[group.id]?.collapsed,
  }]));

  function isModuleCollapsed(mod) {
    return !!moduleState.get(mod)?.collapsed;
  }

  function isNodeVisible(nodeId) {
    const mod = nodeToModule[nodeId];
    if (mod && isModuleCollapsed(mod)) return false;
    const groupId = classGroupByNode.get(nodeId);
    if (!groupId) return true;
    const group = classGroupMap.get(groupId);
    if (!group) return true;
    return !classGroupState.get(groupId)?.collapsed || nodeId === group.ownerId;
  }

  function resolveVisibleEndpoint(nodeId) {
    const mod = nodeToModule[nodeId];
    if (mod && isModuleCollapsed(mod)) return moduleEndpointKey(mod);
    const groupId = classGroupByNode.get(nodeId);
    if (!groupId) return nodeId;
    const group = classGroupMap.get(groupId);
    if (!group) return nodeId;
    return classGroupState.get(groupId)?.collapsed ? group.ownerId : nodeId;
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
  const moduleMembers = new Map();
  const nodePos = new Map();
  const nodeToModule = {};
  let cx = 60;
  for (const col of cols) {
    let cy = COL_TOP;
    for (const { mod, items, h } of col) {
      modulePos.set(mod, { x: cx, y: cy, w: NODE_W + MOD_PAD_X * 2, h, color: moduleColor(mod) });
      moduleMembers.set(mod, items.map((it) => it.id));
      items.forEach((it, i) => {
        nodeToModule[it.id] = mod;
        const indent = it.kind === "method" && it.className ? METHOD_INDENT : 0;
        nodePos.set(it.id, {
          x: cx + MOD_PAD_X + indent,
          y: cy + MOD_PAD_TOP + i * (NODE_H + NODE_PAD),
          w: NODE_W - indent,
          h: NODE_H,
        });
      });
      cy += h + 26;
    }
    cx += NODE_W + MOD_PAD_X * 2 + COL_GAP;
  }
  for (const [nodeId, saved] of Object.entries(savedNodes)) {
    const pos = nodePos.get(nodeId);
    if (!pos || typeof saved?.x !== "number" || typeof saved?.y !== "number") continue;
    pos.x = saved.x;
    pos.y = saved.y;
  }
  if (Object.keys(savedNodes).length === 0) {
    applyOrganicLayout(moduleOrder, moduleNodes, nodePos, edges);
  }
  applyCallGraphForceLayout(moduleOrder, moduleNodes, nodePos, moduleMembers, edges, forceOptions);
  const collisionAnchors = new Map(Array.from(nodePos.entries()).map(([nodeId, pos]) => [nodeId, { x: pos.x, y: pos.y }]));
  resolveCallGraphNodeSeparation();
  function computeModuleBounds(mod) {
    if (isModuleCollapsed(mod)) return computeCollapsedModuleBounds(moduleMembers.get(mod) || [], nodePos);
    return computeModuleBoundsForItems((moduleMembers.get(mod) || []).filter((nodeId) => isNodeVisible(nodeId)), nodePos);
  }
  for (const mod of moduleOrder) {
    const bounds = computeModuleBounds(mod);
    const box = modulePos.get(mod);
    if (!bounds || !box) continue;
    box.x = bounds.x;
    box.y = bounds.y;
    box.w = bounds.w;
    box.h = bounds.h;
  }
  // ── Connection counts ──
  const connCount = {};
  for (const n of nodes) connCount[n.id] = { out: 0, in_: 0 };
  for (const e of edges) {
    if (connCount[e.from]) connCount[e.from].out++;
    if (connCount[e.to]) connCount[e.to].in_++;
  }

  // ── SVG Layers ──
  const modLayer   = document.createElementNS(NS, "g"); root.appendChild(modLayer);
  const classLayer = document.createElementNS(NS, "g"); root.appendChild(classLayer);
  const edgeLayer  = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
    const classEls = {};
    for (const group of classGroups) {
      if (isModuleCollapsed(group.module)) continue;
      const bounds = computeClassFrameBounds(group);
      if (!bounds) continue;
      const collapsed = !!classGroupState.get(group.id)?.collapsed;
      const color = moduleColor(group.module || "");
      const g = document.createElementNS(NS, "g");
      g.dataset.classGroup = group.id;
      g.style.cursor = "grab";
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(bounds.x));
      r.setAttribute("y", String(bounds.y));
      r.setAttribute("width", String(bounds.w));
      r.setAttribute("height", String(bounds.h));
      r.setAttribute("rx", "10");
      r.setAttribute("ry", "10");
      r.setAttribute("fill", color + "05");
      r.setAttribute("stroke", color + "24");
      r.setAttribute("stroke-width", "1");
      r.setAttribute("stroke-dasharray", collapsed ? "3 3" : "5 4");
      r.setAttribute("pointer-events", "all");
      g.appendChild(r);

      const toggle = makeClassGroupToggle(g, color, collapsed, () => toggleClassGroup(group.id));
      positionClassGroupToggle(toggle, bounds);

      let dragState = null;
      const beginClassDrag = (e) => {
        if (e.button !== 0) return;
        const members = group.memberIds.map((nodeId) => {
          const pos = nodePos.get(nodeId);
          return pos ? { nodeId, x: pos.x, y: pos.y } : null;
        }).filter(Boolean);
        if (members.length === 0) return;
        dragState = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          members,
          moved: false,
        };
        g.setPointerCapture?.(e.pointerId);
        ctx.hideTooltip();
        e.stopPropagation();
        e.preventDefault();
      };
      const moveClassDrag = (e) => {
        if (!dragState || dragState.pointerId !== e.pointerId) return;
        const scale = canvasState?.scale || 1;
        const dx = (e.clientX - dragState.startClientX) / scale;
        const dy = (e.clientY - dragState.startClientY) / scale;
        if (!dragState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
          dragState.moved = true;
        }
        if (!dragState.moved) return;
        dragState.members.forEach((member) => {
          const pos = nodePos.get(member.nodeId);
          if (!pos) return;
          pos.x = member.x + dx;
          pos.y = member.y + dy;
        });
        resolveCallGraphNodeSeparation(new Set(group.memberIds));
        refreshAllLayoutGeometry();
        e.stopPropagation();
        e.preventDefault();
      };
      const endClassDrag = (e) => {
        if (!dragState || dragState.pointerId !== e.pointerId) return;
        if (dragState.moved) {
          suppressPointerClicksUntil = performance.now() + 250;
          persistLayout();
        }
        g.releasePointerCapture?.(e.pointerId);
        dragState = null;
      };
      r.addEventListener("pointerdown", beginClassDrag);
      g.addEventListener("pointermove", moveClassDrag);
      g.addEventListener("pointerup", endClassDrag);
      g.addEventListener("pointercancel", endClassDrag);
      classLayer.appendChild(g);
      classEls[group.id] = { g, rect: r, color, toggle };
    }
  const dotLayer   = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const execLayer  = document.createElementNS(NS, "g"); root.appendChild(execLayer);
  const nodeLayer  = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  // ── Module boxes ──
  const modEls = {};
  for (const [mod, p] of modulePos.entries()) {
    const color = moduleColor(mod);
    const g = document.createElementNS(NS, "g");
    g.dataset.module = mod;
    g.style.cursor = "grab";
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("rx", 12); r.setAttribute("ry", 12);
    r.setAttribute("stroke-width", "1");
    g.appendChild(r);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("font-size", "10"); t.setAttribute("font-weight", "600");
    t.setAttribute("letter-spacing", "0.5");
    t.textContent = mod;
    g.appendChild(t);
    const meta = document.createElementNS(NS, "text");
    meta.setAttribute("fill", color + "8a");
    meta.setAttribute("font-size", "8.5");
    meta.setAttribute("letter-spacing", "0.25");
    g.appendChild(meta);

    const toggle = makeModuleGroupToggle(g, color, isModuleCollapsed(mod), () => toggleModuleGroup(mod));
    let dragState = null;
    const beginModuleDrag = (e) => {
      if (e.button !== 0) return;
      const members = (moduleMembers.get(mod) || []).map((nodeId) => {
        const pos = nodePos.get(nodeId);
        return pos ? { nodeId, x: pos.x, y: pos.y } : null;
      }).filter(Boolean);
      if (members.length === 0) return;
      dragState = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        members,
        moved: false,
      };
      g.setPointerCapture?.(e.pointerId);
      ctx.hideTooltip();
      e.stopPropagation();
      e.preventDefault();
    };
    const moveModuleDrag = (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      const scale = canvasState?.scale || 1;
      const dx = (e.clientX - dragState.startClientX) / scale;
      const dy = (e.clientY - dragState.startClientY) / scale;
      if (!dragState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        dragState.moved = true;
      }
      if (!dragState.moved) return;
      dragState.members.forEach((member) => {
        const pos = nodePos.get(member.nodeId);
        if (!pos) return;
        pos.x = member.x + dx;
        pos.y = member.y + dy;
      });
      resolveCallGraphNodeSeparation(new Set(moduleMembers.get(mod) || []));
      refreshAllLayoutGeometry();
      e.stopPropagation();
      e.preventDefault();
    };
    const endModuleDrag = (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      if (dragState.moved) {
        suppressPointerClicksUntil = performance.now() + 250;
        persistLayout();
      }
      g.releasePointerCapture?.(e.pointerId);
      dragState = null;
    };
    r.addEventListener("pointerdown", beginModuleDrag);
    t.addEventListener("pointerdown", beginModuleDrag);
    meta.addEventListener("pointerdown", beginModuleDrag);
    g.addEventListener("pointermove", moveModuleDrag);
    g.addEventListener("pointerup", endModuleDrag);
    g.addEventListener("pointercancel", endModuleDrag);
    modLayer.appendChild(g);
    modEls[mod] = { g, rect: r, text: t, meta, toggle };
    updateModuleVisual(mod);
  }

  // ── Nodes ──
  const nodeRect = new Map();
  const nodeEls = {};
  for (const n of nodes) {
    if (!isNodeVisible(n.id)) continue;
    const p = nodePos.get(n.id);
    if (!p) continue;
    const isClass = n.kind === "class";
    const isMethod = n.kind === "method";
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

    const kindBadge = document.createElementNS(NS, "text");
    kindBadge.setAttribute("x", "9");
    kindBadge.setAttribute("y", "14");
    kindBadge.setAttribute("fill", badgeColor(n, col));
    kindBadge.setAttribute("font-size", "9");
    kindBadge.setAttribute("font-weight", "700");
    kindBadge.textContent = kindLetter(n);
    g.appendChild(kindBadge);

    const lb = document.createElementNS(NS, "text");
    lb.setAttribute("x", isMethod ? "25" : "22");
    lb.setAttribute("y", "14");
    lb.setAttribute("fill", isClass ? col + "dd" : isMethod ? "#9aa5ce" : "#8890aa");
    lb.setAttribute("font-size", "10");
    lb.setAttribute("font-weight", isClass ? "600" : "400");
    lb.textContent = (n.label || n.id);
    g.appendChild(lb);

    // Line number
    const lineNum = n.source && n.source.line ? n.source.line : null;
    const rightText = n.metadata && n.metadata.isAsync ? "async" : (lineNum ? ":" + lineNum : "");
    if (rightText) {
      const rt = document.createElementNS(NS, "text");
      rt.setAttribute("x", String(p.w - 7));
      rt.setAttribute("y", "13");
      rt.setAttribute("text-anchor", "end");
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
      if (performance.now() < suppressPointerClicksUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      selectNode(n.id);
      ctx.onNodeClick(n);
    });

    // Double-click → request flowchart for this node
    g.addEventListener("dblclick", (e) => {
      if (performance.now() < suppressPointerClicksUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      if (ctx.onNodeDblClick) ctx.onNodeDblClick(n);
    });

    let dragState = null;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const pos = nodePos.get(n.id);
      if (!pos) return;
      dragState = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: pos.x,
        startY: pos.y,
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
      const pos = nodePos.get(n.id);
      if (!pos) return;
      pos.x = dragState.startX + dx;
      pos.y = dragState.startY + dy;
      resolveCallGraphNodeSeparation(new Set([n.id]));
      refreshAllLayoutGeometry();
      e.stopPropagation();
      e.preventDefault();
    });
    g.addEventListener("pointerup", (e) => {
      if (!dragState || dragState.pointerId !== e.pointerId) return;
      if (dragState.moved) {
        suppressPointerClicksUntil = performance.now() + 250;
        persistLayout();
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
    nodeEls[n.id] = { g, rect: r, node: n, col };
  }

  // ── Edges ──
  const edgeRecords = [];
  const edgeMap = {};
  const dedupedEdgeIndex = new Map();
  for (const e of edges) {
    const srcId = resolveVisibleEndpoint(e.from);
    const tgtId = resolveVisibleEndpoint(e.to);
    if (!srcId || !tgtId || srcId === tgtId) continue;
    const dedupeKey = `${srcId}->${tgtId}::${e.label || ""}::${e.resolution || ""}`;
    if (dedupedEdgeIndex.has(dedupeKey)) {
      edgeMap[e.from + "->" + e.to] = dedupedEdgeIndex.get(dedupeKey);
      continue;
    }
    const sp = endpointRect(srcId);
    const tp = endpointRect(tgtId);
    if (!sp || !tp) continue;
    const fromMod = endpointModule(srcId);
    const toMod = endpointModule(tgtId);
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

    // Edge label
    let labelEl = null;
    if (e.label) {
      const mid = cubicPt(sx, sy, c1x, c1y, c2x, c2y, tx, ty, 0.5);
      const lt = document.createElementNS(NS, "text");
      lt.setAttribute("x", String(mid.x)); lt.setAttribute("y", String(mid.y - 4));
      lt.setAttribute("text-anchor", "middle");
      lt.setAttribute("fill", col + "aa"); lt.setAttribute("font-size", "9");
      lt.textContent = e.label;
      edgeLayer.appendChild(lt);
      labelEl = lt;
    }

    // Ambient dots (2 for cross-module, 1 for same-module)
    const ambDots = [];
    const dotCount = sameMod ? 1 : 2;
    for (let di = 0; di < dotCount; di++) {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "1.2"); dot.setAttribute("fill", col);
      dot.setAttribute("opacity", "0");
      dotLayer.appendChild(dot);
      ambDots.push({ el: dot, offset: di * 0.5, speed: 0.0005 + Math.random() * 0.0004, opacity: 0.3 });
    }

    const idx = edgeRecords.length;
    edgeMap[e.from + "->" + e.to] = idx;
    dedupedEdgeIndex.set(dedupeKey, idx);
    edgeRecords.push({
      el: path, src: srcId, tgt: tgtId, color: col, sameMod,
      fromMod, toMod, labelEl,
      sx, sy, c1x, c1y, c2x, c2y, tx, ty,
      dot: ambDots[0]?.el, // compat with main.js animation
      offset: Math.random(), speed: 0.0005 + Math.random() * 0.0004,
      ambDots,
    });
  }
  assignEdgeSpread(edgeRecords);
  edgeRecords.forEach((edge) => updateEdgeGeometry(edge));

  function updateNodePosition(nodeId) {
    const pos = nodePos.get(nodeId);
    const node = nodeEls[nodeId];
    const rect = nodeRect.get(nodeId);
    if (!pos || !node || !rect) return;
    node.g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    rect.x = pos.x;
    rect.y = pos.y;
  }

  function updateModuleFrame(mod) {
    const bounds = computeModuleBounds(mod);
    if (!bounds) return;
    const box = modulePos.get(mod);
    const el = modEls[mod];
    if (!box || !el) return;
    box.x = bounds.x;
    box.y = bounds.y;
    box.w = bounds.w;
    box.h = bounds.h;
    updateModuleVisual(mod);
  }

  function updateClassFrame(groupId) {
    const group = classGroupMap.get(groupId);
    const el = classEls[groupId];
    if (!group || !el) return;
    const bounds = computeClassFrameBounds(group);
    if (!bounds) return;
    el.rect.setAttribute("x", String(bounds.x));
    el.rect.setAttribute("y", String(bounds.y));
    el.rect.setAttribute("width", String(bounds.w));
    el.rect.setAttribute("height", String(bounds.h));
    el.rect.setAttribute("stroke-dasharray", classGroupState.get(groupId)?.collapsed ? "3 3" : "5 4");
    positionClassGroupToggle(el.toggle, bounds);
  }

  function updateClassFramesForModule(mod) {
    classGroups.forEach((group) => {
      if (group.module === mod) updateClassFrame(group.id);
    });
  }

  function visibleNodeIds() {
    return nodes.map((node) => node.id).filter((nodeId) => nodePos.has(nodeId) && isNodeVisible(nodeId));
  }

  function refreshAllLayoutGeometry() {
    visibleNodeIds().forEach((nodeId) => updateNodePosition(nodeId));
    classGroups.forEach((group) => updateClassFrame(group.id));
    moduleOrder.forEach((mod) => updateModuleFrame(mod));
    edgeRecords.forEach((edge) => updateEdgeGeometry(edge));
  }

  function resolveCallGraphNodeSeparation(fixedIds = new Set()) {
    const ids = visibleNodeIds();
    if (ids.length < 2) return;
    const moduleIndex = new Map(moduleOrder.map((mod, index) => [mod, index]));
    const passes = 4;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < ids.length; i++) {
        const leftId = ids[i];
        const left = nodePos.get(leftId);
        if (!left) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const rightId = ids[j];
          const right = nodePos.get(rightId);
          if (!right) continue;
          const overlapX = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
          const overlapY = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const sameModule = nodeToModule[leftId] === nodeToModule[rightId];
          const leftFixed = fixedIds.has(leftId);
          const rightFixed = fixedIds.has(rightId);
          if (leftFixed && rightFixed) continue;
          if (sameModule) {
            const direction = Math.sign((left.y + left.h / 2) - (right.y + right.h / 2))
              || Math.sign((collisionAnchors.get(leftId)?.y || 0) - (collisionAnchors.get(rightId)?.y || 0))
              || (i % 2 === 0 ? -1 : 1);
            const shift = overlapY / 2 + 6;
            applyVerticalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed);
          } else {
            const direction = Math.sign((left.x + left.w / 2) - (right.x + right.w / 2))
              || Math.sign((moduleIndex.get(nodeToModule[leftId]) || 0) - (moduleIndex.get(nodeToModule[rightId]) || 0))
              || (i % 2 === 0 ? -1 : 1);
            const shift = overlapX / 2 + 10;
            applyHorizontalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed);
            if (overlapY > 10) {
              const vertical = Math.min(14, overlapY / 3);
              applyVerticalSeparation(leftId, rightId, i % 2 === 0 ? -1 : 1, vertical, leftFixed, rightFixed);
            }
          }
        }
      }
    }
  }

  function applyHorizontalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed) {
    const left = nodePos.get(leftId);
    const right = nodePos.get(rightId);
    if (!left || !right) return;
    const leftShare = rightFixed ? 1 : leftFixed ? 0 : 0.5;
    const rightShare = leftFixed ? 1 : rightFixed ? 0 : 0.5;
    const leftAnchor = collisionAnchors.get(leftId) || left;
    const rightAnchor = collisionAnchors.get(rightId) || right;
    const travel = Math.sign(direction || 1) * shift;
    if (!leftFixed) left.x = clamp(left.x + travel * leftShare, leftAnchor.x - 70, leftAnchor.x + 70);
    if (!rightFixed) right.x = clamp(right.x - travel * rightShare, rightAnchor.x - 70, rightAnchor.x + 70);
  }

  function applyVerticalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed) {
    const left = nodePos.get(leftId);
    const right = nodePos.get(rightId);
    if (!left || !right) return;
    const leftShare = rightFixed ? 1 : leftFixed ? 0 : 0.5;
    const rightShare = leftFixed ? 1 : rightFixed ? 0 : 0.5;
    const travel = Math.sign(direction || 1) * shift;
    if (!leftFixed) left.y += travel * leftShare;
    if (!rightFixed) right.y -= travel * rightShare;
  }

  function updateEdgeGeometry(edge) {
    const sp = endpointRect(edge.src);
    const tp = endpointRect(edge.tgt);
    if (!sp || !tp) return;
    const sourceLane = (edge.sourceLaneOffset || 0) + (edge.bundleLaneOffset || 0);
    const targetLane = (edge.targetLaneOffset || 0) - (edge.bundleLaneOffset || 0);
    const sourceAnchor = pickAnchor(sp, tp, sourceLane * 0.28);
    const targetAnchor = pickAnchor(tp, sp, targetLane * 0.28);
    const sx = sourceAnchor.x;
    const sy = sourceAnchor.y;
    const tx = targetAnchor.x;
    const ty = targetAnchor.y;
    const dx = tx - sx;
    const dy = ty - sy;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / distance;
    const ny = dx / distance;
    const bend = Math.max(42, Math.min(edge.sameMod ? 176 : 152, distance * (edge.sameMod ? 0.55 : 0.4)));
    const laneOffset = sourceLane;
    const sway = edge.sameMod
      ? laneOffset * 0.55 + (Math.abs(dy) < 40 ? 18 * (sx <= tx ? -1 : 1) : 0)
      : laneOffset;
    const c1x = sx + sourceAnchor.dx * bend + nx * sway;
    const c1y = sy + sourceAnchor.dy * bend + ny * sway;
    const c2x = tx + targetAnchor.dx * bend + nx * sway;
    const c2y = ty + targetAnchor.dy * bend + ny * sway;
    edge.sx = sx;
    edge.sy = sy;
    edge.tx = tx;
    edge.ty = ty;
    edge.c1x = c1x;
    edge.c1y = c1y;
    edge.c2x = c2x;
    edge.c2y = c2y;
    edge.el.setAttribute("d", `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`);
    if (edge.labelEl) {
      const mid = cubicPt(sx, sy, c1x, c1y, c2x, c2y, tx, ty, 0.5);
      edge.labelEl.setAttribute("x", String(mid.x + nx * 8));
      edge.labelEl.setAttribute("y", String(mid.y + ny * 8 - 4));
    }
    edge.el.setAttribute("marker-end", `url(#a-${cssId(endpointModule(edge.src) || "default")})`);
  }

  function refreshLayoutForNode(nodeId) {
    const mod = nodeToModule[nodeId];
    const classGroupId = classGroupByNode.get(nodeId);
    if (classGroupId) updateClassFrame(classGroupId);
    updateModuleFrame(mod);
    edgeRecords.forEach((edge) => {
      if (edge.src === nodeId || edge.tgt === nodeId || (edge.sameMod && edge.fromMod === mod)) {
        updateEdgeGeometry(edge);
      }
    });
  }

  function persistLayout() {
    if (!ctx.onLayoutChanged) return;
    ctx.onLayoutChanged(captureLayout());
  }

  function captureLayout() {
    const snapshot = { nodes: {}, groups: {} };
    for (const [nodeId, pos] of nodePos.entries()) {
      snapshot.nodes[nodeId] = { x: pos.x, y: pos.y };
    }
    for (const mod of moduleOrder) {
      snapshot.groups[moduleGroupId(mod)] = { collapsed: isModuleCollapsed(mod) };
    }
    for (const group of classGroups) {
      snapshot.groups[group.id] = { collapsed: !!classGroupState.get(group.id)?.collapsed };
    }
    return snapshot;
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
    conn.forEach((nid) => {
      const mod = endpointModule(nid);
      if (mod) connMods.add(mod);
    });

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
      me.meta.setAttribute("opacity", hit ? "1" : "0.04");
    });
    Object.entries(classEls).forEach(([groupId, ce]) => {
      const group = classGroupMap.get(groupId);
      const hit = !!group && group.memberIds.some((memberId) => conn.has(memberId));
      ce.rect.setAttribute("opacity", hit ? "1" : "0.05");
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
      if (!e.sameMod) e.el.setAttribute("marker-end", `url(#a-${cssId(endpointModule(e.src) || "default")})`);
      e.ambDots.forEach((d) => d.el.setAttribute("opacity", "0.3"));
    });
    Object.values(modEls).forEach((me) => {
      me.rect.setAttribute("opacity", "1");
      me.text.setAttribute("opacity", "1");
      me.meta.setAttribute("opacity", "1");
    });
    Object.values(classEls).forEach((ce) => {
      ce.rect.setAttribute("opacity", "1");
    });
  }

  // Store for external hooks
  ctx._resetSelection = resetSelection;
  ctx._selectNode = selectNode;

  // ── Exec Trace (auto + step-by-step) ──
  let execTimeline = [];
  if (graph.metadata && Array.isArray(graph.metadata.execTimeline)) {
    execTimeline = graph.metadata.execTimeline;
  } else if (isTrace) {
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
  ctx._classEls = classEls;
  ctx._nodeToModule = nodeToModule;
  ctx._execLayer = execLayer;
  ctx._captureLayout = captureLayout;
  ctx._hasGroupControls = moduleOrder.length > 0 || classGroups.length > 0;
  ctx._expandAllGroups = () => {
    if (!moduleOrder.length && !classGroups.length) return;
    moduleOrder.forEach((mod) => {
      const state = moduleState.get(mod);
      if (state) state.collapsed = false;
    });
    classGroups.forEach((group) => {
      const state = classGroupState.get(group.id);
      if (state) state.collapsed = false;
    });
    resolveCallGraphNodeSeparation();
    persistLayout();
    ctx.requestRender?.();
  };
  ctx._collapseAllGroups = () => {
    if (!moduleOrder.length && !classGroups.length) return;
    moduleOrder.forEach((mod) => {
      const state = moduleState.get(mod);
      if (state) state.collapsed = true;
    });
    classGroups.forEach((group) => {
      const state = classGroupState.get(group.id);
      if (state) state.collapsed = true;
    });
    persistLayout();
    ctx.requestRender?.();
  };

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
      me.meta.setAttribute("opacity", "0.06");
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
        me.meta.setAttribute("opacity", hit ? "0.9" : "0.06");
      });
    }
  };

  ctx._spawnExecDot = function (edgeIdx, color, options = {}) {
    const e = edgeRecords[edgeIdx];
    if (!e) return null;
    const radius = typeof options.radius === "number" ? options.radius : 5;
    const speed = typeof options.speed === "number" ? options.speed : 0.006;
    const trailScale = typeof options.trailScale === "number" ? options.trailScale : 1;
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", String(radius)); dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.9"); dot.setAttribute("filter", "url(#glow-big)");
    execLayer.appendChild(dot);
    const trails = [];
    for (let i = 0; i < 5; i++) {
      const tr = document.createElementNS(NS, "circle");
      tr.setAttribute("r", String(Math.max(1, (4 - i * 0.7) * trailScale)));
      tr.setAttribute("fill", color);
      tr.setAttribute("opacity", String(0.35 - i * 0.06));
      execLayer.appendChild(tr);
      trails.push({ el: tr });
    }
    return { el: dot, trails, t: 0, speed, edge: e, alive: true };
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

  function computeClassFrameBounds(group) {
    return classGroupState.get(group.id)?.collapsed
      ? computeCollapsedClassBounds(group.ownerId, nodePos)
      : computeClassBounds(group, nodePos);
  }

  function endpointRect(endpointId) {
    if (isModuleEndpoint(endpointId)) return modulePos.get(endpointId.slice(7)) || null;
    return nodePos.get(endpointId) || null;
  }

  function endpointModule(endpointId) {
    if (isModuleEndpoint(endpointId)) return endpointId.slice(7);
    return nodeToModule[endpointId];
  }

  function updateModuleVisual(mod) {
    const box = modulePos.get(mod);
    const el = modEls[mod];
    if (!box || !el) return;
    const collapsed = isModuleCollapsed(mod);
    const color = moduleColor(mod);
    const memberIds = moduleMembers.get(mod) || [];
    if (collapsed) {
      el.rect.setAttribute("x", String(box.x));
      el.rect.setAttribute("y", String(box.y));
      el.rect.setAttribute("width", String(box.w));
      el.rect.setAttribute("height", String(box.h));
      el.rect.setAttribute("fill", color + "10");
      el.rect.setAttribute("stroke", color + "48");
      el.rect.setAttribute("stroke-dasharray", "4 3");
      el.text.setAttribute("x", String(box.x + 30));
      el.text.setAttribute("y", String(box.y + 22));
      el.text.setAttribute("text-anchor", "start");
      el.text.setAttribute("fill", color + "d8");
      el.meta.setAttribute("x", String(box.x + 30));
      el.meta.setAttribute("y", String(box.y + 38));
      el.meta.setAttribute("text-anchor", "start");
      el.meta.textContent = `${memberIds.length} symbols`;
    } else {
      el.rect.setAttribute("x", String(box.x - 6));
      el.rect.setAttribute("y", String(box.y - 6));
      el.rect.setAttribute("width", String(box.w + 12));
      el.rect.setAttribute("height", String(box.h + 12));
      el.rect.setAttribute("fill", color + "08");
      el.rect.setAttribute("stroke", color + "18");
      el.rect.setAttribute("stroke-dasharray", "");
      el.text.setAttribute("x", String(box.x + 28));
      el.text.setAttribute("y", String(box.y + 14));
      el.text.setAttribute("text-anchor", "start");
      el.text.setAttribute("fill", color + "70");
      el.meta.textContent = "";
    }
    setToggleGlyph(el.toggle, collapsed);
    positionModuleGroupToggle(el.toggle, collapsed ? box : { x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 });
  }

  function toggleModuleGroup(mod) {
    const state = moduleState.get(mod);
    if (!state) return;
    const expanding = !!state.collapsed;
    state.collapsed = !state.collapsed;
    if (expanding) {
      resolveCallGraphNodeSeparation(new Set(moduleMembers.get(mod) || []));
    }
    persistLayout();
    ctx.requestRender?.();
  }

  function toggleClassGroup(groupId) {
    const state = classGroupState.get(groupId);
    if (!state) return;
    const expanding = !!state.collapsed;
    state.collapsed = !state.collapsed;
    if (expanding) {
      const group = classGroupMap.get(groupId);
      resolveCallGraphNodeSeparation(new Set(group?.memberIds || []));
    }
    persistLayout();
    ctx.requestRender?.();
  }
}

// ── Helpers ──

function computeModuleBoundsForItems(memberIds, nodePos) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const nodeId of memberIds) {
    const pos = nodePos.get(nodeId);
    if (!pos) continue;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.w);
    maxY = Math.max(maxY, pos.y + pos.h);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX - MOD_PAD_X,
    y: minY - MOD_PAD_TOP,
    w: (maxX - minX) + MOD_PAD_X * 2,
    h: (maxY - minY) + MOD_PAD_TOP + MOD_PAD_BOTTOM,
  };
}

function computeClassBounds(group, nodePos) {
  const bounds = computeModuleBoundsForItems(group.memberIds, nodePos);
  if (!bounds) return null;
  return {
    x: bounds.x + 12,
    y: bounds.y + 24,
    w: Math.max(80, bounds.w - 24),
    h: Math.max(40, bounds.h - 28),
  };
}

function computeCollapsedClassBounds(ownerId, nodePos) {
  const pos = nodePos.get(ownerId);
  if (!pos) return null;
  return {
    x: pos.x - 10,
    y: pos.y - 8,
    w: pos.w + 20,
    h: pos.h + 16,
  };
}

function computeCollapsedModuleBounds(memberIds, nodePos) {
  const bounds = computeModuleBoundsForItems(memberIds, nodePos);
  if (!bounds) return null;
  return {
    x: bounds.x + Math.max(0, (bounds.w - MODULE_SUMMARY_W) / 2),
    y: bounds.y + 8,
    w: Math.max(MODULE_SUMMARY_W, Math.min(bounds.w, MODULE_SUMMARY_W + 80)),
    h: MODULE_SUMMARY_H,
  };
}

function buildClassGroups(moduleOrder, moduleNodes) {
  const groups = [];
  for (const mod of moduleOrder) {
    const items = moduleNodes.get(mod) || [];
    items.forEach((item) => {
      if (item.kind !== "class") return;
      const memberIds = [item.id];
      items.forEach((candidate) => {
        if (candidate.kind === "method" && candidate.className === item.label) {
          memberIds.push(candidate.id);
        }
      });
      if (memberIds.length <= 1) return;
      groups.push({ id: `${item.id}::group`, module: mod, memberIds, ownerId: item.id, label: item.label || item.id });
    });
  }
  return groups;
}

function applyOrganicLayout(moduleOrder, moduleNodes, nodePos, edges) {
  const neighbors = new Map();
  edges.forEach((edge) => {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, []);
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, []);
    neighbors.get(edge.from).push(edge.to);
    neighbors.get(edge.to).push(edge.from);
  });

  const classOwners = new Map();
  moduleOrder.forEach((mod) => {
    const items = moduleNodes.get(mod) || [];
    const classIdsByName = new Map(items.filter((item) => item.kind === "class").map((item) => [item.label, item.id]));
    items.forEach((item) => {
      if (item.kind === "method" && item.className && classIdsByName.has(item.className)) {
        classOwners.set(item.id, classIdsByName.get(item.className));
      }
    });
  });

  for (let pass = 0; pass < 10; pass++) {
    moduleOrder.forEach((mod) => {
      const items = moduleNodes.get(mod) || [];
      const proposals = new Map();
      items.forEach((item) => {
        const pos = nodePos.get(item.id);
        if (!pos) return;
        let targetY = pos.y;
        const linked = neighbors.get(item.id) || [];
        if (linked.length) {
          const avgCenter = linked.reduce((sum, linkedId) => {
            const linkedPos = nodePos.get(linkedId);
            return sum + (linkedPos ? linkedPos.y + linkedPos.h / 2 : pos.y + pos.h / 2);
          }, 0) / linked.length;
          targetY = avgCenter - pos.h / 2;
        }
        const ownerId = classOwners.get(item.id);
        if (ownerId) {
          const ownerPos = nodePos.get(ownerId);
          if (ownerPos) targetY = (targetY * 0.55) + ((ownerPos.y + NODE_H + NODE_PAD + 2) * 0.45);
        }
        proposals.set(item.id, pos.y + clamp((targetY - pos.y) * 0.22, -18, 18));
      });

      let cursor = Number.NEGATIVE_INFINITY;
      items.forEach((item) => {
        const pos = nodePos.get(item.id);
        if (!pos) return;
        const desired = proposals.get(item.id) ?? pos.y;
        if (!Number.isFinite(cursor)) cursor = desired;
        pos.y = Math.max(desired, cursor);
        cursor = pos.y + NODE_H + NODE_PAD + (item.kind === "class" ? 4 : 0);
      });
    });
  }
}

function orderModuleNodes(items) {
  const sorted = [...items].sort((left, right) => {
    const leftLine = left.source?.line || 0;
    const rightLine = right.source?.line || 0;
    return leftLine - rightLine || String(left.label || left.id).localeCompare(String(right.label || right.id));
  });
  const classes = sorted.filter((item) => item.kind === "class");
  const methodsByClass = new Map();
  const standalone = [];
  for (const item of sorted) {
    if (item.kind === "method" && item.className) {
      if (!methodsByClass.has(item.className)) methodsByClass.set(item.className, []);
      methodsByClass.get(item.className).push(item);
    } else if (item.kind !== "class") {
      standalone.push(item);
    }
  }
  const ordered = [];
  const seenIds = new Set();
  classes.forEach((classNode) => {
    ordered.push(classNode);
    seenIds.add(classNode.id);
    const classMethods = methodsByClass.get(classNode.label) || [];
    classMethods.forEach((methodNode) => {
      ordered.push(methodNode);
      seenIds.add(methodNode.id);
    });
  });
  standalone.forEach((item) => {
    if (!seenIds.has(item.id)) {
      ordered.push(item);
      seenIds.add(item.id);
    }
  });
  sorted.forEach((item) => {
    if (!seenIds.has(item.id)) ordered.push(item);
  });
  return ordered;
}

function assignEdgeSpread(edgeRecords) {
  const bySource = new Map();
  const byTarget = new Map();
  const byBundle = new Map();
  edgeRecords.forEach((edge) => {
    if (!bySource.has(edge.src)) bySource.set(edge.src, []);
    bySource.get(edge.src).push(edge);
    if (!byTarget.has(edge.tgt)) byTarget.set(edge.tgt, []);
    byTarget.get(edge.tgt).push(edge);
    const bundleKey = `${edge.fromMod}->${edge.toMod}`;
    if (!byBundle.has(bundleKey)) byBundle.set(bundleKey, []);
    byBundle.get(bundleKey).push(edge);
  });
  bySource.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.sourceLaneOffset = (index - (bucket.length - 1) / 2) * 16;
    });
  });
  byTarget.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.targetLaneOffset = (index - (bucket.length - 1) / 2) * 16;
    });
  });
  byBundle.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.bundleLaneOffset = (index - (bucket.length - 1) / 2) * (edge.sameMod ? 10 : 14);
    });
  });
}

function moduleGroupId(mod) {
  return `module:${mod}::group`;
}

function moduleEndpointKey(mod) {
  return `module:${mod}`;
}

function isModuleEndpoint(endpointId) {
  return typeof endpointId === "string" && endpointId.startsWith("module:") && !endpointId.endsWith("::group");
}

function makeClassGroupToggle(wrapper, color, collapsed, onToggle) {
  const hit = document.createElementNS(NS, "circle");
  hit.setAttribute("r", "7");
  hit.setAttribute("fill", color + "16");
  hit.setAttribute("stroke", color + "70");
  hit.setAttribute("stroke-width", "1");
  hit.style.cursor = "pointer";
  wrapper.appendChild(hit);

  const glyph = document.createElementNS(NS, "text");
  glyph.setAttribute("text-anchor", "middle");
  glyph.setAttribute("dominant-baseline", "central");
  glyph.setAttribute("fill", color + "ee");
  glyph.setAttribute("font-size", "10");
  glyph.setAttribute("font-weight", "700");
  glyph.textContent = collapsed ? "+" : "-";
  glyph.style.cursor = "pointer";
  wrapper.appendChild(glyph);

  const trigger = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };
  [hit, glyph].forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    node.addEventListener("click", trigger);
  });
  return { hit, glyph };
}

function makeModuleGroupToggle(wrapper, color, collapsed, onToggle) {
  const toggle = makeClassGroupToggle(wrapper, color, collapsed, onToggle);
  toggle.hit.setAttribute("r", "8");
  return toggle;
}

function positionClassGroupToggle(toggle, bounds) {
  const cx = bounds.x + 11;
  const cy = bounds.y + 11;
  toggle.hit.setAttribute("cx", String(cx));
  toggle.hit.setAttribute("cy", String(cy));
  toggle.glyph.setAttribute("x", String(cx));
  toggle.glyph.setAttribute("y", String(cy + 0.5));
}

function positionModuleGroupToggle(toggle, bounds) {
  const cx = bounds.x + 12;
  const cy = bounds.y + 12;
  toggle.hit.setAttribute("cx", String(cx));
  toggle.hit.setAttribute("cy", String(cy));
  toggle.glyph.setAttribute("x", String(cx));
  toggle.glyph.setAttribute("y", String(cy + 0.5));
}

function setToggleGlyph(toggle, collapsed) {
  if (toggle?.glyph) toggle.glyph.textContent = collapsed ? "+" : "-";
}

function kindLetter(node) {
  if (node.kind === "class") return "C";
  if (node.kind === "method") return "M";
  return "F";
}

function badgeColor(node, color) {
  if (node.kind === "class") return color + "ee";
  if (node.kind === "method") return "#9ece6a";
  return "#7dcfff";
}

function pickAnchor(source, target, laneOffset = 0) {
  const sourceCenterX = source.x + source.w / 2;
  const sourceCenterY = source.y + source.h / 2;
  const targetCenterX = target.x + target.w / 2;
  const targetCenterY = target.y + target.h / 2;
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) {
      return { x: source.x + source.w, y: sourceCenterY + laneOffset, dx: 1, dy: 0 };
    }
    return { x: source.x, y: sourceCenterY + laneOffset, dx: -1, dy: 0 };
  }
  if (dy >= 0) {
    return { x: sourceCenterX + laneOffset, y: source.y + source.h, dx: 0, dy: 1 };
  }
  return { x: sourceCenterX + laneOffset, y: source.y, dx: 0, dy: -1 };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0, Math.min(1, value));
}

function applyCallGraphForceLayout(moduleOrder, moduleNodes, nodePos, moduleMembers, edges, forceOptions) {
  const overlapRepel = clamp01(forceOptions?.overlapRepel ?? 0.35);
  const linkAttract = clamp01(forceOptions?.linkAttract ?? 0.28);
  const ambientRepel = clamp01(forceOptions?.ambientRepel ?? 0.18);
  if (overlapRepel <= 0.001 && linkAttract <= 0.001 && ambientRepel <= 0.001) return;
  const anchors = new Map();
  nodePos.forEach((pos, nodeId) => {
    anchors.set(nodeId, { x: pos.x, y: pos.y });
  });
  const neighbors = new Map();
  edges.forEach((edge) => {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
  });
  const passes = Math.round(4 + Math.max(overlapRepel, linkAttract, ambientRepel) * 8);
  const minGapY = NODE_H + NODE_PAD + 4 + overlapRepel * 10 + ambientRepel * 8;
  const maxModuleShift = 26 + overlapRepel * 32 + ambientRepel * 26;
  const intraShift = 12 + overlapRepel * 18 + ambientRepel * 8;
  const attractRadiusY = NODE_H + 56 + linkAttract * 60;
  const ambientRadiusY = NODE_H + 30 + ambientRepel * 26;

  for (let pass = 0; pass < passes; pass++) {
    for (const mod of moduleOrder) {
      const itemIds = (moduleNodes.get(mod) || []).map((item) => item.id).filter((nodeId) => nodePos.has(nodeId));
      itemIds.sort((left, right) => (nodePos.get(left).y - nodePos.get(right).y));
      for (let i = 1; i < itemIds.length; i++) {
        const prev = nodePos.get(itemIds[i - 1]);
        const curr = nodePos.get(itemIds[i]);
        const overlap = prev.y + minGapY - curr.y;
        if (overlap > 0) curr.y += overlap;
      }
      const moduleAnchorX = average(itemIds.map((nodeId) => anchors.get(nodeId)?.x || 0));
      itemIds.forEach((nodeId) => {
        const pos = nodePos.get(nodeId);
        const anchor = anchors.get(nodeId);
        pos.x = clamp(
          moduleAnchorX + (pos.x - moduleAnchorX) * 0.82 + (anchor.x - moduleAnchorX) * 0.18,
          moduleAnchorX - maxModuleShift,
          moduleAnchorX + maxModuleShift,
        );
      });
      for (let i = 0; i < itemIds.length; i++) {
        const leftId = itemIds[i];
        const left = nodePos.get(leftId);
        const leftAnchor = anchors.get(leftId);
        for (let j = i + 1; j < itemIds.length; j++) {
          const rightId = itemIds[j];
          const right = nodePos.get(rightId);
          const rightAnchor = anchors.get(rightId);
          const dy = (left.y + NODE_H / 2) - (right.y + NODE_H / 2);
          const isLinked = neighbors.get(leftId)?.has(rightId) || false;
          if (isLinked && linkAttract > 0.001 && Math.abs(dy) < attractRadiusY) {
            const targetMidY = (leftAnchor.y + rightAnchor.y) / 2;
            left.y += (targetMidY - left.y) * (0.025 + linkAttract * 0.035);
            right.y += (targetMidY - right.y) * (0.025 + linkAttract * 0.035);
            const desiredDeltaX = (leftAnchor.x - rightAnchor.x) * 0.55;
            const currentDeltaX = left.x - right.x;
            const pullX = (desiredDeltaX - currentDeltaX) * (0.02 + linkAttract * 0.03);
            left.x = clamp(left.x + pullX, moduleAnchorX - maxModuleShift, moduleAnchorX + maxModuleShift);
            right.x = clamp(right.x - pullX, moduleAnchorX - maxModuleShift, moduleAnchorX + maxModuleShift);
          }
          if (ambientRepel > 0.001 && !isLinked && Math.abs(dy) <= ambientRadiusY) {
            const push = (1 - Math.abs(dy) / ambientRadiusY) * (1.4 + ambientRepel * 4.2);
            const direction = (leftAnchor.x - rightAnchor.x) || (i % 2 === 0 ? -1 : 1);
            left.x = clamp(left.x + Math.sign(direction) * push, moduleAnchorX - intraShift, moduleAnchorX + intraShift);
            right.x = clamp(right.x - Math.sign(direction) * push, moduleAnchorX - intraShift, moduleAnchorX + intraShift);
          }
          if (overlapRepel > 0.001 && Math.abs(dy) <= NODE_H + 28 + overlapRepel * 14) {
            const push = (1 - Math.abs(dy) / (NODE_H + 28 + overlapRepel * 14)) * (1.8 + overlapRepel * 4.5);
            const direction = (leftAnchor.x - rightAnchor.x) || (i % 2 === 0 ? -1 : 1);
            left.x = clamp(left.x + Math.sign(direction) * push, moduleAnchorX - intraShift, moduleAnchorX + intraShift);
            right.x = clamp(right.x - Math.sign(direction) * push, moduleAnchorX - intraShift, moduleAnchorX + intraShift);
          }
        }
      }
    }
  }
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

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


