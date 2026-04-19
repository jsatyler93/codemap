// Flowchart view. Supports free-form node layout plus collapsible
// compound groups such as loops, branches, and function bodies.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { theme } from "../../shared/theme.js";
import { cubicPt } from "../../shared/geometry.js";

const NODE_W = 240;
const NODE_MIN_H = 36;
const LINE_H = 12;
const ROW_GAP = 30;
const BRANCH_GAP = 240;
const GROUP_PAD_X = 18;
const GROUP_PAD_Y = 22;
const GROUP_SUMMARY_W = 220;
const GROUP_SUMMARY_MIN_H = 52;
const GROUP_TOGGLE_R = 8;
const NODE_CIRCLE_D = 36;
const TREE_INDENT_X = 104;
const TREE_BASE_X = 176;
const TREE_ROW_GAP = 26;

export function renderFlowchart(graph, ctx) {
  const { root, defs } = ctx;
  const canvasState = ctx.canvas?.state;
  const treeView = !!ctx.uiState?.treeView;
  const forceOptions = {
    overlapRepel: clamp01(ctx.uiState?.repelStrength ?? 0.35),
    linkAttract: clamp01(ctx.uiState?.attractStrength ?? 0.28),
    ambientRepel: clamp01(ctx.uiState?.ambientRepelStrength ?? 0.18),
    cohesion: clamp01(ctx.uiState?.cohesionStrength ?? 0.34),
  };
  const savedSnapshot = ctx.layoutSnapshot || {};
  const savedNodes = savedSnapshot.nodes || {};
  const savedGroups = savedSnapshot.groups || {};
  let suppressPointerClicksUntil = 0;

  Object.entries(theme.nodeColor).forEach(([key, color]) => mkArrow(defs, `a-${key}`, color));
  mkArrow(defs, "a-default", "#454a60");

  const nodes = graph.nodes.map((node) => ({ ...node }));
  const edges = graph.edges || [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const hasPersistedNodeCircleState = nodes.some((node) => typeof savedNodes[node.id]?.circleCollapsed === "boolean");
  const groups = normalizeGroups(graph.metadata?.groups || []);
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodeGroupChains = buildNodeGroupChains(groups);
  const groupDepth = buildGroupDepthMap(groups);
  const nodeState = new Map(nodes.map((node) => [node.id, {
    circleCollapsed: hasPersistedNodeCircleState ? !!savedNodes[node.id]?.circleCollapsed : true,
    treeDx: typeof savedNodes[node.id]?.treeDx === "number" ? savedNodes[node.id].treeDx : 0,
    treeDy: typeof savedNodes[node.id]?.treeDy === "number" ? savedNodes[node.id].treeDy : 0,
  }]));
  const prepared = new Map(nodes.map((node) => [node.id, prepareNode(node)]));
  const treeBaseNodePos = new Map();
  const treeBaseGroupPos = new Map();

  function isNodeCircleCollapsed(nodeId) {
    return !!nodeState.get(nodeId)?.circleCollapsed;
  }

  function nodeOffset(nodeId) {
    return nodeState.get(nodeId) || { treeDx: 0, treeDy: 0 };
  }

  const incoming = new Map();
  const outgoing = new Map();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (outgoing.has(edge.from)) outgoing.get(edge.from).push(edge);
    if (incoming.has(edge.to)) incoming.get(edge.to).push(edge);
  }

  const positions = new Map();
  const visited = new Set();
  const entry = (graph.rootNodeIds && graph.rootNodeIds[0])
    || (nodes.find((node) => node.kind === "entry") || nodes[0])?.id;
  if (!entry) {
    return { edgeRecords: [], nodeRect: new Map(), nodes, initialView: { scale: 1, panX: 0, panY: 0 } };
  }

  let cursorY = 30;
  function place(nodeId, centerX) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const preparedNode = prepared.get(nodeId);
    if (!preparedNode) return;
    positions.set(nodeId, { x: centerX - NODE_W / 2, y: cursorY, h: preparedNode.h });
    cursorY += preparedNode.h + ROW_GAP;
    const outs = outgoing.get(nodeId) || [];
    if (outs.length === 0) return;
    if (outs.length === 1) {
      place(outs[0].to, centerX);
      return;
    }
    const yes = outs.find((edge) => /yes|true|ok/i.test(edge.label || ""));
    const no = outs.find((edge) => /no|false|invalid|raise/i.test(edge.label || ""));
    const ordered = [yes, no, ...outs.filter((edge) => edge !== yes && edge !== no)].filter(Boolean);
    const span = (ordered.length - 1) * BRANCH_GAP;
    ordered.forEach((edge, index) => {
      place(edge.to, centerX - span / 2 + index * BRANCH_GAP);
    });
  }

  place(entry, 480);
  for (const node of nodes) {
    if (!positions.has(node.id)) {
      const preparedNode = prepared.get(node.id);
      positions.set(node.id, { x: 100, y: cursorY, h: preparedNode ? preparedNode.h : NODE_MIN_H });
      cursorY += (preparedNode ? preparedNode.h : NODE_MIN_H) + ROW_GAP;
    }
  }
  const groupState = new Map(groups.map((group) => [group.id, {
    collapsed: !!savedGroups[group.id]?.collapsed,
    x: typeof savedGroups[group.id]?.x === "number" ? savedGroups[group.id].x : undefined,
    y: typeof savedGroups[group.id]?.y === "number" ? savedGroups[group.id].y : undefined,
    treeDx: typeof savedGroups[group.id]?.treeDx === "number" ? savedGroups[group.id].treeDx : 0,
    treeDy: typeof savedGroups[group.id]?.treeDy === "number" ? savedGroups[group.id].treeDy : 0,
  }]));
  const groupDescendants = buildGroupDescendants(groups);
  const visibility = computeVisibility(nodes, groups, groupById, nodeGroupChains, groupState);
  if (treeView) {
    applyFlowTreeLayout(
      positions,
      nodes,
      prepared,
      nodeGroupChains,
      groupById,
      groupDepth,
      isNodeCircleCollapsed,
      visibility,
      groupState,
      nodeOffset,
      treeBaseNodePos,
      treeBaseGroupPos,
      forceOptions,
    );
  } else {
    for (const [nodeId, saved] of Object.entries(savedNodes)) {
      const pos = positions.get(nodeId);
      if (!pos || typeof saved?.x !== "number" || typeof saved?.y !== "number") continue;
      pos.x = saved.x;
      pos.y = saved.y;
    }
    applyFlowForceLayout(positions, prepared, outgoing, incoming, forceOptions);
  }

  const nodeRectAll = new Map();
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const preparedNode = prepared.get(node.id) || prepareNode(node);
    const collapsedNode = isNodeCircleCollapsed(node.id);
    nodeRectAll.set(node.id, {
      x: pos.x,
      y: pos.y,
      w: collapsedNode ? NODE_CIRCLE_D : NODE_W,
      h: collapsedNode ? NODE_CIRCLE_D : preparedNode.h,
      color: theme.nodeColor[node.kind] || theme.nodeColor.process,
    });
  }
  const collisionAnchors = new Map(Array.from(nodeRectAll.entries()).map(([nodeId, rect]) => [nodeId, { x: rect.x, y: rect.y }]));
  if (!treeView) resolveFlowNodeSeparation(new Set(), visibility.visibleNodeIds);
  const allNodesCircleCollapsed = nodes.every((node) => isNodeCircleCollapsed(node.id));
  let loopLaneRanks = buildLoopLaneRanks(nodes, positions, visibility.visibleNodeIds, groupDepth);

  const groupLayer = document.createElementNS(NS, "g"); root.appendChild(groupLayer);
  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const collapsedLayer = document.createElementNS(NS, "g"); root.appendChild(collapsedLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  let collapsedGroupRects = computeCollapsedGroupRects(visibility.visibleCollapsedGroupIds, groupById, groupState, nodeRectAll);
  let expandedGroupBounds = computeExpandedGroupBounds(
    visibility.visibleExpandedGroupIds,
    visibility.visibleNodeIds,
    visibility.visibleCollapsedGroupIds,
    groupById,
    nodeRectAll,
    collapsedGroupRects,
  );

  const groupEls = new Map();
  const collapsedGroupEls = new Map();
  const nodeEls = new Map();
  const visibleNodeRects = new Map();

  for (const groupId of visibility.visibleExpandedGroupIds.sort((left, right) => (groupDepth.get(left) || 0) - (groupDepth.get(right) || 0))) {
    if (allNodesCircleCollapsed) continue;
    const group = groupById.get(groupId);
    const bounds = expandedGroupBounds.get(groupId);
    if (!group || !bounds) continue;
    const color = groupColor(group.kind);
    const wrapper = document.createElementNS(NS, "g");
    wrapper.dataset.groupId = group.id;
    wrapper.style.cursor = "grab";

    const region = document.createElementNS(NS, "rect");
    region.setAttribute("x", String(bounds.x));
    region.setAttribute("y", String(bounds.y));
    region.setAttribute("width", String(bounds.w));
    region.setAttribute("height", String(bounds.h));
    region.setAttribute("rx", "14");
    region.setAttribute("ry", "14");
    region.setAttribute("fill", color + "05");
    region.setAttribute("stroke", color + "44");
    region.setAttribute("stroke-width", "1.2");
    region.setAttribute("stroke-dasharray", "7 5");
    wrapper.appendChild(region);

    const chipWidth = Math.max(94, group.label.length * 6.2 + 34);
    const chip = document.createElementNS(NS, "rect");
    chip.setAttribute("x", String(bounds.x + 10));
    chip.setAttribute("y", String(bounds.y - 10));
    chip.setAttribute("width", String(chipWidth));
    chip.setAttribute("height", "18");
    chip.setAttribute("rx", "9");
    chip.setAttribute("ry", "9");
    chip.setAttribute("fill", color + "15");
    chip.setAttribute("stroke", color + "40");
    wrapper.appendChild(chip);

    const title = document.createElementNS(NS, "text");
    title.setAttribute("x", String(bounds.x + 34));
    title.setAttribute("y", String(bounds.y + 2));
    title.setAttribute("fill", color + "dd");
    title.setAttribute("font-size", "9.5");
    title.setAttribute("font-weight", "600");
    title.textContent = group.label;
    wrapper.appendChild(title);

    const toggle = makeGroupToggle(wrapper, color, false, () => toggleGroup(group.id));
    positionGroupToggle(toggle, bounds, { headerChip: true });

    attachGroupInteractions(wrapper, group);
    groupLayer.appendChild(wrapper);
    groupEls.set(group.id, { wrapper, region, chip, title, toggle });
  }

  for (const node of nodes) {
    if (!visibility.visibleNodeIds.has(node.id)) continue;
    const rect = nodeRectAll.get(node.id);
    if (!rect) continue;
    visibleNodeRects.set(node.id, rect);
    const element = renderNode(
      node,
      rect,
      prepared.get(node.id) || prepareNode(node),
      ctx,
      nodeLayer,
      () => suppressPointerClicksUntil,
      isNodeCircleCollapsed(node.id),
      () => toggleNodeCircle(node.id),
    );
    nodeEls.set(node.id, element);

    let dragState = null;
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: rect.x,
        startY: rect.y,
        startTreeDx: nodeOffset(node.id).treeDx || 0,
        startTreeDy: nodeOffset(node.id).treeDy || 0,
        moved: false,
      };
      element.setPointerCapture?.(event.pointerId);
      element.classList.add("node-dragging");
      ctx.hideTooltip();
      event.stopPropagation();
      event.preventDefault();
    });
    element.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const scale = canvasState?.scale || 1;
      const dx = (event.clientX - dragState.startClientX) / scale;
      const dy = (event.clientY - dragState.startClientY) / scale;
      if (!dragState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        dragState.moved = true;
        nodeLayer.appendChild(element);
      }
      if (!dragState.moved) return;
      if (treeView) {
        const state = nodeState.get(node.id);
        if (!state) return;
        state.treeDx = dragState.startTreeDx + dx;
        state.treeDy = dragState.startTreeDy + dy;
      } else {
        rect.x = dragState.startX + dx;
        rect.y = dragState.startY + dy;
        syncPositionFromRect(node.id);
        updateNodePosition(node.id);
      }
      refreshAllGeometry(new Set([node.id]), visibility.visibleNodeIds);
      event.stopPropagation();
      event.preventDefault();
    });
    element.addEventListener("pointerup", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      if (dragState.moved) {
        suppressPointerClicksUntil = performance.now() + 250;
        persistLayout();
      }
      element.classList.remove("node-dragging");
      element.releasePointerCapture?.(event.pointerId);
      dragState = null;
      event.stopPropagation();
    });
    element.addEventListener("pointercancel", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      element.classList.remove("node-dragging");
      dragState = null;
    });
  }

  for (const groupId of visibility.visibleCollapsedGroupIds) {
    const group = groupById.get(groupId);
    const rect = collapsedGroupRects.get(groupId);
    if (!group || !rect) continue;
    const color = groupColor(group.kind);
    const wrapper = document.createElementNS(NS, "g");
    wrapper.dataset.collapsedGroupId = group.id;
    wrapper.style.cursor = "grab";

    const box = document.createElementNS(NS, "rect");
    box.setAttribute("x", String(rect.x));
    box.setAttribute("y", String(rect.y));
    box.setAttribute("width", String(rect.w));
    box.setAttribute("height", String(rect.h));
    box.setAttribute("rx", "12");
    box.setAttribute("ry", "12");
    box.setAttribute("fill", color + "14");
    box.setAttribute("stroke", color + "70");
    box.setAttribute("stroke-width", "1.4");
    box.setAttribute("stroke-dasharray", "8 5");
    wrapper.appendChild(box);

    const lines = summarizeGroup(group);
    lines.forEach((line, index) => {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(rect.x + 29));
      text.setAttribute("y", String(rect.y + 18 + index * LINE_H));
      text.setAttribute("text-anchor", "start");
      text.setAttribute("fill", index === 0 ? color + "ee" : color + "aa");
      text.setAttribute("font-size", index === 0 ? "10" : "8.5");
      text.setAttribute("font-weight", index === 0 ? "600" : "400");
      text.textContent = line;
      wrapper.appendChild(text);
    });

    const toggle = makeGroupToggle(wrapper, color, true, () => toggleGroup(group.id));
    positionGroupToggle(toggle, rect, { headerChip: false });

    attachGroupInteractions(wrapper, group);
    collapsedLayer.appendChild(wrapper);
    collapsedGroupEls.set(group.id, { wrapper, box, toggle });
  }

  const edgeRecords = [];
  const edgeMap = {};
  const seenEdgeKeys = new Set();
  for (const edge of edges) {
    const srcEndpoint = resolveVisibleEndpoint(edge.from, nodeGroupChains, groupState);
    const tgtEndpoint = resolveVisibleEndpoint(edge.to, nodeGroupChains, groupState);
    if (!srcEndpoint || !tgtEndpoint || srcEndpoint === tgtEndpoint) continue;
    const dedupeKey = `${srcEndpoint}->${tgtEndpoint}::${edge.label || ""}`;
    if (seenEdgeKeys.has(dedupeKey)) continue;
    seenEdgeKeys.add(dedupeKey);
    const fromRect = endpointRect(srcEndpoint);
    const toRect = endpointRect(tgtEndpoint);
    if (!fromRect || !toRect) continue;
    const fromKind = endpointKind(srcEndpoint, nodesById, groupById);
    const toKind = endpointKind(tgtEndpoint, nodesById, groupById);
    const route = computeEdgeRoute({ label: edge.label || "", src: srcEndpoint, tgt: tgtEndpoint }, fromRect, toRect, fromKind, toKind, loopLaneRanks);
    const color = theme.nodeColor[fromKind] || "#454a60";

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", route.d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color + "33");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("marker-end", `url(#a-${fromKind})`);
    edgeLayer.appendChild(path);

    let labelEl = null;
    if (edge.label) {
      const mid = cubicPt(route.sx, route.sy, route.c1x, route.c1y, route.c2x, route.c2y, route.tx, route.ty, route.labelT || 0.35);
      labelEl = document.createElementNS(NS, "text");
      labelEl.setAttribute("x", String(mid.x + (route.labelDx || 6)));
      labelEl.setAttribute("y", String(mid.y + (route.labelDy || -4)));
      labelEl.setAttribute("fill", color + "88");
      labelEl.setAttribute("font-size", "8.5");
      labelEl.textContent = edge.label;
      edgeLayer.appendChild(labelEl);
    }

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "1.3");
    dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0");
    dotLayer.appendChild(dot);
    edgeMap[`${edge.from}->${edge.to}`] = edgeRecords.length;
    edgeRecords.push({
      el: path,
      src: srcEndpoint,
      tgt: tgtEndpoint,
      fromKind,
      toKind,
      label: edge.label || "",
      labelEl,
      sx: route.sx,
      sy: route.sy,
      c1x: route.c1x,
      c1y: route.c1y,
      c2x: route.c2x,
      c2y: route.c2y,
      tx: route.tx,
      ty: route.ty,
      labelT: route.labelT,
      labelDx: route.labelDx,
      labelDy: route.labelDy,
      dot,
      offset: Math.random(),
      speed: 0.0006 + Math.random() * 0.0004,
    });
  }
  assignFlowEdgeSpread(edgeRecords);

  const execLayer = document.createElementNS(NS, "g");
  root.appendChild(execLayer);

  ctx._edgeMap = edgeMap;
  ctx._edgeRecords = edgeRecords;
  ctx._captureLayout = captureLayout;
  ctx._hasGroupControls = groups.length > 0 || nodes.length > 0;
  ctx._expandAllGroups = () => {
    if (!groups.length && !nodes.length) return;
    groups.forEach((group) => {
      const state = groupState.get(group.id);
      if (!state) return;
      state.collapsed = false;
    });
    nodes.forEach((node) => {
      const state = nodeState.get(node.id);
      if (!state) return;
      state.circleCollapsed = false;
    });
    if (!treeView) resolveFlowNodeSeparation(new Set(), new Set(nodes.map((node) => node.id)));
    persistLayout();
    ctx.requestRender?.();
  };
  ctx._collapseAllGroups = () => {
    if (!groups.length && !nodes.length) return;
    groups.forEach((group) => {
      const state = groupState.get(group.id);
      if (!state) return;
      state.collapsed = false;
    });
    nodes.forEach((node) => {
      const state = nodeState.get(node.id);
      if (!state) return;
      state.circleCollapsed = true;
    });
    persistLayout();
    ctx.requestRender?.();
  };
  ctx._spawnExecDot = function (edgeIdx, color, options = {}) {
    const edge = edgeRecords[edgeIdx];
    if (!edge) return null;
    const radius = typeof options.radius === "number" ? options.radius : 5;
    const speed = typeof options.speed === "number" ? options.speed : 0.012;
    const trailScale = typeof options.trailScale === "number" ? options.trailScale : 1;
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", String(radius));
    dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0.95");
    execLayer.appendChild(dot);
    const trails = [];
    for (let i = 0; i < 5; i++) {
      const trail = document.createElementNS(NS, "circle");
      trail.setAttribute("r", String(Math.max(1, (4 - i * 0.7) * trailScale)));
      trail.setAttribute("fill", color);
      trail.setAttribute("opacity", String(0.35 - i * 0.06));
      execLayer.appendChild(trail);
      trails.push({ el: trail });
    }
    return { el: dot, trails, t: 0, speed, edge, alive: true };
  };
  ctx._clearExecDots = function () {
    while (execLayer.firstChild) execLayer.removeChild(execLayer.firstChild);
  };

  updateLegend(nodes);

  return {
    edgeRecords,
    nodeRect: nodeRectAll,
    nodes,
    initialView: { scale: 0.75, panX: 60, panY: 20 },
  };

  function attachGroupInteractions(wrapper, group) {
    let dragState = null;
    wrapper.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
        lastDx: 0,
        lastDy: 0,
      };
      materializeCollapsedPositions(group.id);
      wrapper.setPointerCapture?.(event.pointerId);
      ctx.hideTooltip();
      event.stopPropagation();
      event.preventDefault();
    });
    wrapper.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const scale = canvasState?.scale || 1;
      const dx = (event.clientX - dragState.startClientX) / scale;
      const dy = (event.clientY - dragState.startClientY) / scale;
      if (!dragState.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        dragState.moved = true;
      }
      if (!dragState.moved) return;
      shiftGroup(group.id, dx - dragState.lastDx, dy - dragState.lastDy);
      dragState.lastDx = dx;
      dragState.lastDy = dy;
      refreshAllGeometry();
      event.stopPropagation();
      event.preventDefault();
    });
    wrapper.addEventListener("pointerup", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      if (dragState.moved) {
        suppressPointerClicksUntil = performance.now() + 250;
        persistLayout();
      }
      wrapper.releasePointerCapture?.(event.pointerId);
      dragState = null;
      event.stopPropagation();
    });
    wrapper.addEventListener("pointercancel", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState = null;
    });
  }

  function materializeCollapsedPositions(groupId) {
    const ids = [groupId, ...(groupDescendants.get(groupId) || [])];
    for (const id of ids) {
      const state = groupState.get(id);
      const rect = collapsedGroupRects.get(id);
      if (!state || !rect) continue;
      if (typeof state.x !== "number") state.x = rect.x;
      if (typeof state.y !== "number") state.y = rect.y;
    }
  }

  function shiftGroup(groupId, dx, dy) {
    if (!dx && !dy) return;
    const group = groupById.get(groupId);
    if (!group) return;
    if (treeView) {
      if (groupState.get(groupId)?.collapsed) {
        const state = groupState.get(groupId);
        if (state) {
          state.treeDx = (state.treeDx || 0) + dx;
          state.treeDy = (state.treeDy || 0) + dy;
        }
        return;
      }
      for (const nodeId of group.nodeIds) {
        const state = nodeState.get(nodeId);
        if (!state) continue;
        state.treeDx = (state.treeDx || 0) + dx;
        state.treeDy = (state.treeDy || 0) + dy;
      }
      return;
    }
    for (const nodeId of group.nodeIds) {
      const rect = nodeRectAll.get(nodeId);
      if (!rect) continue;
      rect.x += dx;
      rect.y += dy;
      syncPositionFromRect(nodeId);
    }
    const ids = [groupId, ...(groupDescendants.get(groupId) || [])];
    for (const id of ids) {
      const state = groupState.get(id);
      if (!state) continue;
      if (typeof state.x === "number") state.x += dx;
      if (typeof state.y === "number") state.y += dy;
    }
  }

  function updateNodePosition(nodeId) {
    const rect = nodeRectAll.get(nodeId);
    const group = nodeEls.get(nodeId);
    if (!rect || !group) return;
    group.setAttribute("transform", `translate(${rect.x},${rect.y})`);
  }

  function toggleNodeCircle(nodeId) {
    const state = nodeState.get(nodeId);
    const rect = nodeRectAll.get(nodeId);
    const node = nodesById.get(nodeId);
    const preparedNode = prepared.get(nodeId);
    if (!state || !rect || !node || !preparedNode) return;
    state.circleCollapsed = !state.circleCollapsed;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const nextW = state.circleCollapsed ? NODE_CIRCLE_D : NODE_W;
    const nextH = state.circleCollapsed ? NODE_CIRCLE_D : preparedNode.h;
    rect.x = cx - nextW / 2;
    rect.y = cy - nextH / 2;
    rect.w = nextW;
    rect.h = nextH;
    syncPositionFromRect(nodeId);
    if (treeView) {
      const stateOffset = nodeState.get(nodeId);
      const base = treeBaseNodePos.get(nodeId) || { x: rect.x, y: rect.y };
      if (stateOffset) {
        const nextBaseX = base.x;
        const nextBaseY = base.y;
        stateOffset.treeDx = cx - nextW / 2 - nextBaseX;
        stateOffset.treeDy = cy - nextH / 2 - nextBaseY;
      }
      applyFlowTreeLayout(
        positions,
        nodes,
        prepared,
        nodeGroupChains,
        groupById,
        groupDepth,
        isNodeCircleCollapsed,
        visibility,
        groupState,
        nodeOffset,
        treeBaseNodePos,
        treeBaseGroupPos,
        forceOptions,
      );
      for (const [id, nextRect] of nodeRectAll.entries()) {
        const pos = positions.get(id);
        if (!pos) continue;
        nextRect.x = pos.x;
        nextRect.y = pos.y;
        nextRect.w = isNodeCircleCollapsed(id) ? NODE_CIRCLE_D : NODE_W;
        nextRect.h = isNodeCircleCollapsed(id) ? NODE_CIRCLE_D : (prepared.get(id)?.h || NODE_MIN_H);
      }
    } else {
      resolveFlowNodeSeparation(new Set([nodeId]), visibility.visibleNodeIds);
    }
    persistLayout();
    ctx.requestRender?.();
  }

  function syncPositionFromRect(nodeId) {
    const rect = nodeRectAll.get(nodeId);
    const pos = positions.get(nodeId);
    if (!rect || !pos) return;
    pos.x = rect.x;
    pos.y = rect.y;
  }

  function resolveFlowNodeSeparation(fixedIds = new Set(), activeNodeIds = visibility.visibleNodeIds) {
    if (treeView) return;
    const ids = Array.from(activeNodeIds || []).filter((nodeId) => nodeRectAll.has(nodeId));
    if (ids.length < 2) return;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < ids.length; i++) {
        const leftId = ids[i];
        const left = nodeRectAll.get(leftId);
        if (!left) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const rightId = ids[j];
          const right = nodeRectAll.get(rightId);
          if (!right) continue;
          const overlapX = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
          const overlapY = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const leftFixed = fixedIds.has(leftId);
          const rightFixed = fixedIds.has(rightId);
          if (leftFixed && rightFixed) continue;
          const xDirection = Math.sign((left.x + left.w / 2) - (right.x + right.w / 2))
            || Math.sign((collisionAnchors.get(leftId)?.x || 0) - (collisionAnchors.get(rightId)?.x || 0))
            || (((left.x + left.w / 2) <= (right.x + right.w / 2)) ? -1 : 1);
          const xShift = overlapX / 2 + 10;
          applyFlowHorizontalSeparation(leftId, rightId, xDirection, xShift, leftFixed, rightFixed);
          if (overlapY > 10) {
            const yDirection = Math.sign((collisionAnchors.get(leftId)?.y || 0) - (collisionAnchors.get(rightId)?.y || 0)) || (i % 2 === 0 ? -1 : 1);
            const yShift = Math.min(12, overlapY / 4 + 2);
            applyFlowVerticalSeparation(leftId, rightId, yDirection, yShift, leftFixed, rightFixed);
          }
        }
      }
      const ordered = ids.slice().sort((leftId, rightId) => (nodeRectAll.get(leftId).y - nodeRectAll.get(rightId).y));
      for (let index = 1; index < ordered.length; index++) {
        const prev = nodeRectAll.get(ordered[index - 1]);
        const currId = ordered[index];
        const curr = nodeRectAll.get(currId);
        if (!prev || !curr || fixedIds.has(currId)) continue;
        const minY = prev.y + prev.h + ROW_GAP * 0.35;
        if (curr.y < minY) curr.y = minY;
      }
    }
    ids.forEach((nodeId) => syncPositionFromRect(nodeId));
  }

  function applyFlowHorizontalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed) {
    const left = nodeRectAll.get(leftId);
    const right = nodeRectAll.get(rightId);
    if (!left || !right) return;
    const leftShare = rightFixed ? 1 : leftFixed ? 0 : 0.5;
    const rightShare = leftFixed ? 1 : rightFixed ? 0 : 0.5;
    const leftAnchor = collisionAnchors.get(leftId) || left;
    const rightAnchor = collisionAnchors.get(rightId) || right;
    const travel = Math.sign(direction || 1) * shift;
    if (!leftFixed) left.x = clamp(left.x + travel * leftShare, leftAnchor.x - 160, leftAnchor.x + 160);
    if (!rightFixed) right.x = clamp(right.x - travel * rightShare, rightAnchor.x - 160, rightAnchor.x + 160);
  }

  function applyFlowVerticalSeparation(leftId, rightId, direction, shift, leftFixed, rightFixed) {
    const left = nodeRectAll.get(leftId);
    const right = nodeRectAll.get(rightId);
    if (!left || !right) return;
    const leftShare = rightFixed ? 1 : leftFixed ? 0 : 0.5;
    const rightShare = leftFixed ? 1 : rightFixed ? 0 : 0.5;
    const travel = Math.sign(direction || 1) * shift;
    if (!leftFixed) left.y += travel * leftShare;
    if (!rightFixed) right.y -= travel * rightShare;
  }

  function refreshAllGeometry(fixedIds = new Set(), activeNodeIds = visibility.visibleNodeIds) {
    if (treeView) {
      applyFlowTreeLayout(
        positions,
        nodes,
        prepared,
        nodeGroupChains,
        groupById,
        groupDepth,
        isNodeCircleCollapsed,
        visibility,
        groupState,
        nodeOffset,
        treeBaseNodePos,
        treeBaseGroupPos,
        forceOptions,
      );
      for (const [nodeId, rect] of nodeRectAll.entries()) {
        const pos = positions.get(nodeId);
        if (!pos) continue;
        rect.x = pos.x;
        rect.y = pos.y;
      }
    } else {
      resolveFlowNodeSeparation(fixedIds, activeNodeIds);
    }
    collapsedGroupRects = computeCollapsedGroupRects(visibility.visibleCollapsedGroupIds, groupById, groupState, nodeRectAll);
    expandedGroupBounds = computeExpandedGroupBounds(
      visibility.visibleExpandedGroupIds,
      visibility.visibleNodeIds,
      visibility.visibleCollapsedGroupIds,
      groupById,
      nodeRectAll,
      collapsedGroupRects,
    );
    loopLaneRanks = buildLoopLaneRanks(nodes, positions, visibility.visibleNodeIds, groupDepth);

    visibility.visibleNodeIds.forEach((nodeId) => updateNodePosition(nodeId));
    for (const [groupId, elements] of groupEls.entries()) {
      const bounds = expandedGroupBounds.get(groupId);
      const group = groupById.get(groupId);
      if (!bounds || !group) continue;
      const chipWidth = Math.max(94, group.label.length * 6.2 + 34);
      elements.region.setAttribute("x", String(bounds.x));
      elements.region.setAttribute("y", String(bounds.y));
      elements.region.setAttribute("width", String(bounds.w));
      elements.region.setAttribute("height", String(bounds.h));
      elements.chip.setAttribute("x", String(bounds.x + 10));
      elements.chip.setAttribute("y", String(bounds.y - 10));
      elements.chip.setAttribute("width", String(chipWidth));
      elements.title.setAttribute("x", String(bounds.x + 34));
      elements.title.setAttribute("y", String(bounds.y + 2));
      positionGroupToggle(elements.toggle, bounds, { headerChip: true });
    }
    for (const [groupId, elements] of collapsedGroupEls.entries()) {
      const rect = collapsedGroupRects.get(groupId);
      if (!rect) continue;
      elements.box.setAttribute("x", String(rect.x));
      elements.box.setAttribute("y", String(rect.y));
      elements.box.setAttribute("width", String(rect.w));
      elements.box.setAttribute("height", String(rect.h));
      let index = 0;
      Array.from(elements.wrapper.querySelectorAll("text")).forEach((textNode) => {
        textNode.setAttribute("x", String(rect.x + 29));
        textNode.setAttribute("y", String(rect.y + 18 + index * LINE_H));
        textNode.setAttribute("text-anchor", "start");
        index += 1;
      });
      positionGroupToggle(elements.toggle, rect, { headerChip: false });
    }
    edgeRecords.forEach((edge) => updateEdgeGeometry(edge));
  }

  function toggleGroup(groupId) {
    const state = groupState.get(groupId);
    const group = groupById.get(groupId);
    if (!state) return;
    const expanding = !!state.collapsed;
    if (treeView && !state.collapsed) {
      const samples = group.nodeIds.map((nodeId) => nodeOffset(nodeId));
      if (samples.length) {
        state.treeDx = samples.reduce((sum, entry) => sum + (entry.treeDx || 0), 0) / samples.length;
        state.treeDy = samples.reduce((sum, entry) => sum + (entry.treeDy || 0), 0) / samples.length;
      }
    } else if (!state.collapsed) {
      const rect = expandedGroupBounds.get(groupId);
      if (rect) {
        state.x = rect.x + (rect.w - GROUP_SUMMARY_W) / 2;
        state.y = rect.y + Math.max(18, rect.h * 0.18);
      }
    }
    state.collapsed = !state.collapsed;
    if (treeView && expanding) {
      for (const nodeId of group.nodeIds) {
        const nodeEntry = nodeState.get(nodeId);
        if (!nodeEntry) continue;
        nodeEntry.treeDx = (nodeEntry.treeDx || 0) + (state.treeDx || 0);
        nodeEntry.treeDy = (nodeEntry.treeDy || 0) + (state.treeDy || 0);
      }
      state.treeDx = 0;
      state.treeDy = 0;
    } else if (!treeView && expanding) {
      const nextVisibility = computeVisibility(nodes, groups, groupById, nodeGroupChains, groupState);
      resolveFlowNodeSeparation(new Set(group?.nodeIds || []), nextVisibility.visibleNodeIds);
    }
    persistLayout();
    ctx.requestRender?.();
  }

  function endpointRect(endpointId) {
    if (endpointId.startsWith("group:")) return collapsedGroupRects.get(endpointId.slice(6));
    return nodeRectAll.get(endpointId);
  }

  function updateEdgeGeometry(edge) {
    const fromRect = endpointRect(edge.src);
    const toRect = endpointRect(edge.tgt);
    if (!fromRect || !toRect) return;
    const route = computeEdgeRoute(edge, fromRect, toRect, edge.fromKind, edge.toKind, loopLaneRanks);
    edge.sx = route.sx;
    edge.sy = route.sy;
    edge.tx = route.tx;
    edge.ty = route.ty;
    edge.c1x = route.c1x;
    edge.c1y = route.c1y;
    edge.c2x = route.c2x;
    edge.c2y = route.c2y;
    edge.labelT = route.labelT;
    edge.labelDx = route.labelDx;
    edge.labelDy = route.labelDy;
    edge.el.setAttribute("d", route.d);
    edge.el.setAttribute("marker-end", `url(#a-${edge.fromKind || "default"})`);
    if (edge.labelEl) {
      const mid = cubicPt(route.sx, route.sy, route.c1x, route.c1y, route.c2x, route.c2y, route.tx, route.ty, route.labelT || 0.35);
      edge.labelEl.setAttribute("x", String(mid.x + (route.labelDx || 6)));
      edge.labelEl.setAttribute("y", String(mid.y + (route.labelDy || -4)));
    }
  }

  function captureLayout() {
    const snapshot = { nodes: {}, groups: {} };
    for (const [nodeId, rect] of nodeRectAll.entries()) {
      snapshot.nodes[nodeId] = {
        x: rect.x,
        y: rect.y,
        circleCollapsed: isNodeCircleCollapsed(nodeId),
        treeDx: nodeOffset(nodeId).treeDx || 0,
        treeDy: nodeOffset(nodeId).treeDy || 0,
      };
    }
    for (const group of groups) {
      const state = groupState.get(group.id);
      if (!state) continue;
      snapshot.groups[group.id] = {
        collapsed: !!state.collapsed,
        ...(typeof state.x === "number" ? { x: state.x } : {}),
        ...(typeof state.y === "number" ? { y: state.y } : {}),
        treeDx: state.treeDx || 0,
        treeDy: state.treeDy || 0,
      };
    }
    return snapshot;
  }

  function persistLayout() {
    ctx.onLayoutChanged?.(captureLayout());
  }
}

function renderNode(node, rect, preparedNode, ctx, nodeLayer, getSuppressUntil, collapsedNode, onToggleCircle) {
  const color = theme.nodeColor[node.kind] || theme.nodeColor.process;
  const group = document.createElementNS(NS, "g");
  group.setAttribute("transform", `translate(${rect.x},${rect.y})`);
  group.dataset.id = node.id;
  group.style.cursor = "pointer";

  let shape;
  if (collapsedNode) {
    shape = document.createElementNS(NS, "circle");
    shape.setAttribute("cx", String(rect.w / 2));
    shape.setAttribute("cy", String(rect.h / 2));
    shape.setAttribute("r", String(Math.min(rect.w, rect.h) / 2 - 1.5));
    shape.setAttribute("fill", color + "14");
    shape.setAttribute("stroke", color + "68");
  } else if (node.kind === "decision") {
    shape = document.createElementNS(NS, "polygon");
    shape.setAttribute("points", `${rect.w / 2},0 ${rect.w},${rect.h / 2} ${rect.w / 2},${rect.h} 0,${rect.h / 2}`);
    shape.setAttribute("fill", color + "12");
    shape.setAttribute("stroke", color + "55");
  } else if (node.kind === "loop") {
    shape = document.createElementNS(NS, "polygon");
    shape.setAttribute("points", `18,0 ${rect.w - 18},0 ${rect.w},${rect.h / 2} ${rect.w - 18},${rect.h} 18,${rect.h} 0,${rect.h / 2}`);
    shape.setAttribute("fill", color + "14");
    shape.setAttribute("stroke", color + "65");
  } else if (node.kind === "break") {
    shape = document.createElementNS(NS, "polygon");
    shape.setAttribute("points", `0,0 ${rect.w - 24},0 ${rect.w},${rect.h / 2} ${rect.w - 24},${rect.h} 0,${rect.h}`);
    shape.setAttribute("fill", color + "16");
    shape.setAttribute("stroke", color + "70");
  } else if (node.kind === "continue") {
    shape = document.createElementNS(NS, "polygon");
    shape.setAttribute("points", `20,0 ${rect.w},0 ${rect.w - 20},${rect.h / 2} ${rect.w},${rect.h} 20,${rect.h} 0,${rect.h / 2}`);
    shape.setAttribute("fill", color + "16");
    shape.setAttribute("stroke", color + "70");
  } else if (node.kind === "loop_else") {
    shape = document.createElementNS(NS, "rect");
    shape.setAttribute("width", String(rect.w));
    shape.setAttribute("height", String(rect.h));
    shape.setAttribute("rx", "10");
    shape.setAttribute("ry", "10");
    shape.setAttribute("fill", color + "12");
    shape.setAttribute("stroke", color + "65");
    shape.setAttribute("stroke-dasharray", "6 4");
  } else if (node.kind === "entry" || node.kind === "return") {
    shape = document.createElementNS(NS, "rect");
    shape.setAttribute("width", String(rect.w));
    shape.setAttribute("height", String(rect.h));
    shape.setAttribute("rx", "16");
    shape.setAttribute("ry", "16");
    shape.setAttribute("fill", color + "1c");
    shape.setAttribute("stroke", color + "55");
  } else {
    shape = document.createElementNS(NS, "rect");
    shape.setAttribute("width", String(rect.w));
    shape.setAttribute("height", String(rect.h));
    shape.setAttribute("rx", "5");
    shape.setAttribute("ry", "5");
    shape.setAttribute("fill", color + "10");
    shape.setAttribute("stroke", color + "35");
  }
  shape.setAttribute("stroke-width", "1.2");
  group.appendChild(shape);

  if (collapsedNode) {
    const monogram = document.createElementNS(NS, "text");
    monogram.setAttribute("x", String(rect.w / 2));
    monogram.setAttribute("y", String(rect.h / 2 + 4));
    monogram.setAttribute("text-anchor", "middle");
    monogram.setAttribute("fill", color + "e8");
    monogram.setAttribute("font-size", "12");
    monogram.setAttribute("font-weight", "700");
    monogram.textContent = flowNodeMonogram(node, preparedNode);
    group.appendChild(monogram);
    const toggle = makeFlowNodeCircleToggle(group, color, true, onToggleCircle);
    positionFlowNodeCircleToggle(toggle, rect, true);
  } else {
    const totalLineCount = preparedNode.lines.length + (preparedNode.typeLine ? 1 : 0);
    const totalHeight = totalLineCount * LINE_H;
    preparedNode.lines.forEach((line, index) => {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(rect.w / 2));
      text.setAttribute("y", String(rect.h / 2 - totalHeight / 2 + index * LINE_H + 9));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", color + "dd");
      text.setAttribute("font-size", "10");
      text.textContent = line;
      group.appendChild(text);
    });
    if (preparedNode.typeLine) {
      const typeText = document.createElementNS(NS, "text");
      typeText.setAttribute("x", String(rect.w / 2));
      typeText.setAttribute("y", String(rect.h / 2 - totalHeight / 2 + preparedNode.lines.length * LINE_H + 9));
      typeText.setAttribute("text-anchor", "middle");
      typeText.setAttribute("fill", color + "88");
      typeText.setAttribute("font-size", "8");
      typeText.setAttribute("font-style", "italic");
      typeText.textContent = preparedNode.typeLine;
      group.appendChild(typeText);
    }
    const toggle = makeFlowNodeCircleToggle(group, color, false, onToggleCircle);
    positionFlowNodeCircleToggle(toggle, rect, false);
  }

  group.addEventListener("mouseenter", (event) => ctx.showTooltip(event, node));
  group.addEventListener("mousemove", (event) => ctx.moveTooltip(event));
  group.addEventListener("mouseleave", () => ctx.hideTooltip());
  group.addEventListener("click", (event) => {
    if (performance.now() < getSuppressUntil()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (collapsedNode) {
      event.preventDefault();
      event.stopPropagation();
      onToggleCircle();
      return;
    }
    ctx.onNodeClick(node);
  });

  nodeLayer.appendChild(group);
  return group;
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups
    .filter((group) => group && typeof group.id === "string" && Array.isArray(group.nodeIds) && group.nodeIds.length)
    .map((group) => ({
      ...group,
      kind: String(group.kind || "branch"),
      label: String(group.label || group.kind || "group"),
      nodeIds: Array.from(new Set(group.nodeIds.map(String))),
      nodeSet: new Set(group.nodeIds.map(String)),
      parentGroupId: group.parentGroupId ? String(group.parentGroupId) : null,
    }));
}

function buildNodeGroupChains(groups) {
  const chains = new Map();
  const depth = buildGroupDepthMap(groups);
  for (const group of groups) {
    for (const nodeId of group.nodeIds) {
      if (!chains.has(nodeId)) chains.set(nodeId, []);
      chains.get(nodeId).push(group.id);
    }
  }
  for (const ids of chains.values()) {
    ids.sort((left, right) => (depth.get(right) || 0) - (depth.get(left) || 0));
  }
  return chains;
}

function buildGroupDepthMap(groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const depth = new Map();
  function resolve(groupId) {
    if (depth.has(groupId)) return depth.get(groupId);
    const group = byId.get(groupId);
    if (!group || !group.parentGroupId) {
      depth.set(groupId, 0);
      return 0;
    }
    const value = resolve(group.parentGroupId) + 1;
    depth.set(groupId, value);
    return value;
  }
  groups.forEach((group) => resolve(group.id));
  return depth;
}

function buildGroupDescendants(groups) {
  const children = new Map();
  groups.forEach((group) => children.set(group.id, []));
  groups.forEach((group) => {
    if (!group.parentGroupId || !children.has(group.parentGroupId)) return;
    children.get(group.parentGroupId).push(group.id);
  });
  const descendants = new Map();
  function collect(groupId) {
    const direct = children.get(groupId) || [];
    const all = [];
    direct.forEach((childId) => {
      all.push(childId, ...collect(childId));
    });
    descendants.set(groupId, all);
    return all;
  }
  groups.forEach((group) => collect(group.id));
  return descendants;
}

function computeVisibility(nodes, groups, groupById, nodeGroupChains, groupState) {
  const visibleNodeIds = new Set();
  const visibleCollapsedGroupIds = [];
  const visibleExpandedGroupIds = [];
  for (const group of groups) {
    const nearestCollapsedAncestor = nearestCollapsedGroup(group.id, groupById, groupState);
    if (nearestCollapsedAncestor && nearestCollapsedAncestor !== group.id) continue;
    if (groupState.get(group.id)?.collapsed) visibleCollapsedGroupIds.push(group.id);
    else visibleExpandedGroupIds.push(group.id);
  }
  for (const node of nodes) {
    const endpoint = resolveVisibleEndpoint(node.id, nodeGroupChains, groupState);
    if (!endpoint || endpoint.startsWith("group:")) continue;
    visibleNodeIds.add(node.id);
  }
  return { visibleNodeIds, visibleCollapsedGroupIds, visibleExpandedGroupIds };
}

function nearestCollapsedGroup(groupId, groupById, groupState) {
  let current = groupById.get(groupId);
  while (current) {
    if (groupState.get(current.id)?.collapsed) return current.id;
    current = current.parentGroupId ? groupById.get(current.parentGroupId) : null;
  }
  return null;
}

function resolveVisibleEndpoint(nodeId, nodeGroupChains, groupState) {
  const chain = nodeGroupChains.get(nodeId) || [];
  for (const groupId of chain) {
    if (groupState.get(groupId)?.collapsed) return groupKey(groupId);
  }
  return nodeId;
}

function computeCollapsedGroupRects(groupIds, groupById, groupState, nodeRectAll) {
  const rects = new Map();
  for (const groupId of groupIds) {
    const group = groupById.get(groupId);
    if (!group) continue;
    const bounds = computeBounds(group.nodeIds.map((nodeId) => nodeRectAll.get(nodeId)).filter(Boolean));
    if (!bounds) continue;
    const state = groupState.get(groupId) || {};
    const lines = summarizeGroup(group);
    const h = Math.max(GROUP_SUMMARY_MIN_H, 18 + lines.length * LINE_H + 10);
    const x = typeof state.x === "number" ? state.x : bounds.x + (bounds.w - GROUP_SUMMARY_W) / 2;
    const y = typeof state.y === "number" ? state.y : bounds.y + Math.max(18, bounds.h * 0.18);
    rects.set(groupId, { x, y, w: GROUP_SUMMARY_W, h });
  }
  return rects;
}

function computeExpandedGroupBounds(groupIds, visibleNodeIds, visibleCollapsedGroupIds, groupById, nodeRectAll, collapsedGroupRects) {
  const bounds = new Map();
  for (const groupId of groupIds) {
    const group = groupById.get(groupId);
    if (!group) continue;
    const rects = [];
    visibleNodeIds.forEach((nodeId) => {
      if (!group.nodeSet.has(nodeId)) return;
      const rect = nodeRectAll.get(nodeId);
      if (rect) rects.push(rect);
    });
    visibleCollapsedGroupIds.forEach((childId) => {
      if (childId === groupId) return;
      const child = groupById.get(childId);
      if (!child || !child.nodeIds.some((nodeId) => group.nodeSet.has(nodeId))) return;
      const rect = collapsedGroupRects.get(childId);
      if (rect) rects.push(rect);
    });
    const box = computeBounds(rects);
    if (!box) continue;
    bounds.set(groupId, {
      x: box.x - GROUP_PAD_X,
      y: box.y - GROUP_PAD_Y,
      w: box.w + GROUP_PAD_X * 2,
      h: box.h + GROUP_PAD_Y * 2,
    });
  }
  return bounds;
}

function computeBounds(rects) {
  if (!rects.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  rects.forEach((rect) => {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  });
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function endpointKind(endpointId, nodesById, groupById) {
  if (endpointId.startsWith("group:")) {
    const group = groupById.get(endpointId.slice(6));
    if (!group) return "process";
    if (group.kind === "branch") return "decision";
    if (group.kind === "function_body") return "compute";
    if (group.kind === "loop") return "loop";
    return "process";
  }
  return nodesById.get(endpointId)?.kind || "process";
}

function groupColor(kind) {
  if (kind === "branch") return theme.nodeColor.decision;
  if (kind === "loop") return theme.nodeColor.loop;
  if (kind === "function_body") return theme.nodeColor.compute;
  return theme.accent;
}

function summarizeGroup(group) {
  const count = group.nodeIds.length;
  return [String(group.label || group.kind || "group"), `${count} ${count === 1 ? "node" : "nodes"}`];
}

function updateLegend(nodes) {
  const lgItems = document.getElementById("lg-items");
  if (!lgItems) return;
  lgItems.innerHTML = "";
  document.getElementById("lg-title").textContent = "Node Types";
  const kinds = Array.from(new Set(nodes.map((node) => node.kind)));
  for (const kind of kinds) {
    const color = theme.nodeColor[kind] || "#7aa2f7";
    const div = document.createElement("div");
    div.className = "lg-item";
    div.innerHTML = kind === "decision"
      ? `<span class="lg-diamond" style="background:${color}22;border:1px solid ${color}55"></span>${kind}`
      : kind === "loop"
        ? `<span class="lg-hex" style="background:${color}22;border:1px solid ${color}55"></span>${kind}`
      : kind === "break"
        ? `<span class="lg-break" style="background:${color}22;border:1px solid ${color}55"></span>${kind}`
      : kind === "continue"
        ? `<span class="lg-continue" style="background:${color}22;border:1px solid ${color}55"></span>${kind}`
      : kind === "loop_else"
        ? `<span class="lg-loop-else" style="background:${color}22;border:1px dashed ${color}77"></span>${kind.replace("_", " ")}`
      : `<span class="lg-shape" style="background:${color}22;border:1px solid ${color}55;${kind === "entry" || kind === "return" ? "border-radius:10px" : ""}"></span>${kind}`;
    lgItems.appendChild(div);
  }
}

function buildLoopLaneRanks(nodes, positions, visibleNodeIds, groupDepth) {
  const loops = nodes
    .filter((node) => node.kind === "loop" && visibleNodeIds.has(node.id))
    .map((node) => ({ node, pos: positions.get(node.id) }))
    .filter((entry) => !!entry.pos)
    .sort((left, right) => left.pos.y - right.pos.y || left.pos.x - right.pos.x);
  const ranks = new Map();
  loops.forEach((entry, index) => {
    let rank = groupDepth.get(entry.node.id) || 0;
    for (let i = 0; i < index; i++) {
      const other = loops[i];
      if (Math.abs(other.pos.x - entry.pos.x) < NODE_W * 0.85 && Math.abs(other.pos.y - entry.pos.y) < 340) rank += 1;
    }
    ranks.set(entry.node.id, rank);
  });
  return ranks;
}

function computeEdgeRoute(edge, fromRect, toRect, fromKind, toKind, loopLaneRanks) {
  if (edge.src?.startsWith("group:") || edge.tgt?.startsWith("group:")) {
    return makeDefaultRoute(edge, fromRect, toRect);
  }
  const label = String(edge.label || "").toLowerCase();
  if ((label === "repeat" || label === "continue") && toKind === "loop") {
    return makeLoopBackRoute(edge, fromRect, toRect, label === "continue", loopLaneRanks);
  }
  if (fromKind === "loop" && (label === "done" || toKind === "loop_else")) {
    return makeLoopExitRoute(edge, fromRect, toRect, toKind === "loop_else", loopLaneRanks);
  }
  if (fromKind === "loop") {
    return makeLoopForwardRoute(fromRect, toRect, label);
  }
  return makeDefaultRoute(edge, fromRect, toRect);
}

function makeDefaultRoute(edge, fromRect, toRect) {
  const sourceLane = (edge.sourceLaneOffset || 0) + (edge.bundleLaneOffset || 0);
  const targetLane = (edge.targetLaneOffset || 0) - (edge.bundleLaneOffset || 0);
  const sourceAnchor = pickAnchor(fromRect, toRect, sourceLane);
  const targetAnchor = pickAnchor(toRect, fromRect, targetLane);
  const bend = Math.max(24, Math.min(120, Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y) * 0.35));
  const sx = sourceAnchor.x;
  const sy = sourceAnchor.y;
  const tx = targetAnchor.x;
  const ty = targetAnchor.y;
  const c1x = sx + sourceAnchor.dx * bend;
  const c1y = sy + sourceAnchor.dy * bend;
  const c2x = tx + targetAnchor.dx * bend;
  const c2y = ty + targetAnchor.dy * bend;
  return { sx, sy, c1x, c1y, c2x, c2y, tx, ty, d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, labelT: 0.35, labelDx: 6, labelDy: -4 };
}

function makeLoopForwardRoute(fromRect, toRect, label) {
  const sx = fromRect.x + fromRect.w / 2;
  const sy = fromRect.y + fromRect.h;
  const tx = toRect.x + toRect.w / 2;
  const ty = toRect.y;
  const spread = Math.max(18, Math.min(64, Math.abs(tx - sx) * 0.25));
  const c1x = sx;
  const c1y = sy + 42;
  const c2x = tx + Math.sign(tx - sx || 1) * spread;
  const c2y = ty - 34;
  return { sx, sy, c1x, c1y, c2x, c2y, tx, ty, d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, labelT: label === "done" ? 0.45 : 0.42, labelDx: 8, labelDy: -6 };
}

function makeLoopBackRoute(edge, fromRect, toRect, isContinue, loopLaneRanks) {
  const loopId = edge.tgt.replace(/^group:/, "");
  const loopRank = loopLaneRanks.get(loopId) || 0;
  const sx = fromRect.x;
  const sy = fromRect.y + fromRect.h / 2;
  const tx = toRect.x + toRect.w * 0.22;
  const ty = toRect.y + toRect.h * 0.22;
  const laneX = Math.min(fromRect.x, toRect.x) - (isContinue ? 58 : 74) - loopRank * 26;
  const topY = Math.min(fromRect.y, toRect.y) - (isContinue ? 16 : 26) - Math.min(24, loopRank * 7);
  const c1x = laneX;
  const c1y = sy;
  const c2x = laneX;
  const c2y = topY;
  return { sx, sy, c1x, c1y, c2x, c2y, tx, ty, d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, labelT: 0.48, labelDx: -26, labelDy: -8 };
}

function makeLoopExitRoute(edge, fromRect, toRect, isLoopElse, loopLaneRanks) {
  const loopId = edge.src.replace(/^group:/, "");
  const loopRank = loopLaneRanks.get(loopId) || 0;
  const sx = fromRect.x + fromRect.w;
  const sy = fromRect.y + fromRect.h / 2;
  const tx = isLoopElse ? toRect.x + toRect.w / 2 : toRect.x;
  const ty = isLoopElse ? toRect.y : toRect.y + toRect.h / 2;
  const laneX = Math.max(fromRect.x + fromRect.w, toRect.x + toRect.w) + (isLoopElse ? 26 : 42) + loopRank * 24;
  const c1x = laneX;
  const c1y = sy;
  const c2x = laneX;
  const c2y = ty - (isLoopElse ? 10 : 0);
  return { sx, sy, c1x, c1y, c2x, c2y, tx, ty, d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, labelT: 0.42, labelDx: 12, labelDy: -6 };
}

function pickAnchor(source, target, laneOffset = 0) {
  const sourceCenterX = source.x + source.w / 2;
  const sourceCenterY = source.y + source.h / 2;
  const targetCenterX = target.x + target.w / 2;
  const targetCenterY = target.y + target.h / 2;
  const dx = targetCenterX - sourceCenterX;
  const dy = targetCenterY - sourceCenterY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return { x: source.x + source.w, y: sourceCenterY + laneOffset, dx: 1, dy: 0 };
    return { x: source.x, y: sourceCenterY + laneOffset, dx: -1, dy: 0 };
  }
  if (dy >= 0) return { x: sourceCenterX + laneOffset, y: source.y + source.h, dx: 0, dy: 1 };
  return { x: sourceCenterX + laneOffset, y: source.y, dx: 0, dy: -1 };
}

function assignFlowEdgeSpread(edgeRecords) {
  const bySource = new Map();
  const byTarget = new Map();
  const byBundle = new Map();
  edgeRecords.forEach((edge) => {
    if (!bySource.has(edge.src)) bySource.set(edge.src, []);
    bySource.get(edge.src).push(edge);
    if (!byTarget.has(edge.tgt)) byTarget.set(edge.tgt, []);
    byTarget.get(edge.tgt).push(edge);
    const bundleKey = `${edge.src}->${edge.tgt}`;
    if (!byBundle.has(bundleKey)) byBundle.set(bundleKey, []);
    byBundle.get(bundleKey).push(edge);
  });
  bySource.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.sourceLaneOffset = (index - (bucket.length - 1) / 2) * 13;
    });
  });
  byTarget.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.targetLaneOffset = (index - (bucket.length - 1) / 2) * 13;
    });
  });
  byBundle.forEach((bucket) => {
    bucket.forEach((edge, index) => {
      edge.bundleLaneOffset = (index - (bucket.length - 1) / 2) * 7;
    });
  });
}

function makeGroupToggle(wrapper, color, collapsed, onToggle) {
  const hit = document.createElementNS(NS, "circle");
  hit.setAttribute("r", String(GROUP_TOGGLE_R));
  hit.setAttribute("fill", color + "1e");
  hit.setAttribute("stroke", color + "75");
  hit.setAttribute("stroke-width", "1");
  hit.style.cursor = "pointer";
  wrapper.appendChild(hit);

  const glyph = document.createElementNS(NS, "text");
  glyph.setAttribute("text-anchor", "middle");
  glyph.setAttribute("dominant-baseline", "central");
  glyph.setAttribute("fill", color + "ee");
  glyph.setAttribute("font-size", "10");
  glyph.setAttribute("font-weight", "700");
  glyph.style.cursor = "pointer";
  glyph.textContent = collapsed ? "+" : "-";
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

function positionGroupToggle(toggle, bounds, options = {}) {
  const cx = bounds.x + GROUP_TOGGLE_R + 8;
  const cy = options.headerChip ? bounds.y - 1 : bounds.y + GROUP_TOGGLE_R + 6;
  toggle.hit.setAttribute("cx", String(cx));
  toggle.hit.setAttribute("cy", String(cy));
  toggle.glyph.setAttribute("x", String(cx));
  toggle.glyph.setAttribute("y", String(cy + 0.5));
}

function prepareNode(node) {
  const meta = node.metadata || {};
  const lines = Array.isArray(meta.displayLines) && meta.displayLines.length
    ? meta.displayLines.map(String)
    : String(node.label || "").split("\n");
  const typeLine = meta.typeLabel ? String(meta.typeLabel) : "";
  const totalLineCount = lines.length + (typeLine ? 1 : 0);
  const h = Math.max(NODE_MIN_H, 16 + totalLineCount * LINE_H + 8);
  return { lines, typeLine, h };
}

function groupKey(groupId) {
  return `group:${groupId}`;
}

function applyFlowTreeLayout(
  positions,
  nodes,
  prepared,
  nodeGroupChains,
  groupById,
  groupDepth,
  isNodeCircleCollapsed,
  visibility,
  groupState,
  nodeOffset,
  treeBaseNodePos,
  treeBaseGroupPos,
  forceOptions,
) {
  treeBaseNodePos.clear();
  treeBaseGroupPos.clear();
  const overlapRepel = clamp01(forceOptions?.overlapRepel ?? 0.35);
  const ambientRepel = clamp01(forceOptions?.ambientRepel ?? 0.18);
  const verticalGap = TREE_ROW_GAP + overlapRepel * 30 + ambientRepel * 10;
  const maxDx = 42 + overlapRepel * 74 + ambientRepel * 18;
  const maxDy = 24 + overlapRepel * 58 + ambientRepel * 14;
  const units = [];
  nodes.forEach((node, index) => {
    if (!visibility.visibleNodeIds.has(node.id)) return;
    const preparedNode = prepared.get(node.id);
    if (!preparedNode) return;
    units.push({
      kind: "node",
      id: node.id,
      index,
      line: Number(node.source?.line || Number.MAX_SAFE_INTEGER),
      depth: treeIndentDepth(node.id, nodeGroupChains, groupById, groupDepth),
      h: isNodeCircleCollapsed?.(node.id) ? NODE_CIRCLE_D : preparedNode.h,
    });
  });
  visibility.visibleCollapsedGroupIds.forEach((groupId, index) => {
    const group = groupById.get(groupId);
    if (!group) return;
    const lines = summarizeGroup(group);
    units.push({
      kind: "group",
      id: groupId,
      index: nodes.length + index,
      line: Number(group.line || Number.MAX_SAFE_INTEGER),
      depth: treeGroupIndentDepth(groupId, groupById, groupDepth),
      h: Math.max(GROUP_SUMMARY_MIN_H, 18 + lines.length * LINE_H + 10),
    });
  });
  units.sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.index - right.index;
  });

  let cursorY = 30;
  units.forEach((unit) => {
    const baseX = TREE_BASE_X + unit.depth * TREE_INDENT_X;
    const baseY = cursorY;
    if (unit.kind === "node") {
      const pos = positions.get(unit.id);
      const offset = nodeOffset(unit.id);
      if (pos) {
        treeBaseNodePos.set(unit.id, { x: baseX, y: baseY });
        pos.x = baseX + clamp(offset.treeDx || 0, -maxDx, maxDx);
        pos.y = baseY + clamp(offset.treeDy || 0, -maxDy, maxDy);
        pos.h = unit.h;
      }
    } else {
      const state = groupState.get(unit.id);
      if (state) {
        treeBaseGroupPos.set(unit.id, { x: baseX, y: baseY });
        state.x = baseX + clamp(state.treeDx || 0, -maxDx, maxDx);
        state.y = baseY + clamp(state.treeDy || 0, -maxDy, maxDy);
      }
    }
    cursorY += unit.h + verticalGap;
  });
}

function treeIndentDepth(nodeId, nodeGroupChains, groupById, groupDepth) {
  const chain = nodeGroupChains.get(nodeId) || [];
  let maxDepth = 0;
  chain.forEach((groupId) => {
    const group = groupById.get(groupId);
    if (!group) return;
    const baseDepth = group.kind === "function_body" ? 0 : 1;
    maxDepth = Math.max(maxDepth, (groupDepth.get(groupId) || 0) + baseDepth);
  });
  return maxDepth;
}

function treeGroupIndentDepth(groupId, groupById, groupDepth) {
  const group = groupById.get(groupId);
  if (!group) return 0;
  const baseDepth = group.kind === "function_body" ? 0 : 1;
  return (groupDepth.get(groupId) || 0) + baseDepth;
}

function applyFlowForceLayout(positions, prepared, outgoing, incoming, forceOptions) {
  const overlapRepel = clamp01(forceOptions?.overlapRepel ?? 0.35);
  const linkAttract = clamp01(forceOptions?.linkAttract ?? 0.28);
  const ambientRepel = clamp01(forceOptions?.ambientRepel ?? 0.18);
  const cohesion = clamp01(forceOptions?.cohesion ?? 0.34);
  if (overlapRepel <= 0.001 && linkAttract <= 0.001 && ambientRepel <= 0.001 && cohesion <= 0.001) return;
  const ids = Array.from(positions.keys());
  const anchors = new Map(ids.map((nodeId) => [nodeId, {
    x: positions.get(nodeId).x,
    y: positions.get(nodeId).y,
  }]));
  const order = ids
    .map((nodeId) => ({ nodeId, y: positions.get(nodeId).y }))
    .sort((left, right) => left.y - right.y)
    .map((entry) => entry.nodeId);
  const laneBias = new Map();
  ids.forEach((nodeId) => {
    const outs = outgoing.get(nodeId) || [];
    if (outs.length <= 1) {
      laneBias.set(nodeId, 0);
      return;
    }
    const bias = outs.reduce((sum, edge) => sum + ((positions.get(edge.to)?.x || 0) - positions.get(nodeId).x), 0) / outs.length;
    laneBias.set(nodeId, bias);
  });
  const neighbors = new Map();
  ids.forEach((nodeId) => neighbors.set(nodeId, new Set()));
  outgoing.forEach((outs, nodeId) => {
    outs.forEach((edge) => {
      neighbors.get(nodeId)?.add(edge.to);
      neighbors.get(edge.to)?.add(nodeId);
    });
  });

  const passes = Math.round(4 + Math.max(overlapRepel, linkAttract, ambientRepel, cohesion) * 8);
  const gapX = 28 + overlapRepel * 66 + ambientRepel * 22;
  const gapY = 20 + overlapRepel * 26;
  const ambientRadiusX = NODE_W + 54 + ambientRepel * 110;
  const targetGapY = ROW_GAP * (1.15 - cohesion * 0.55);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < ids.length; i++) {
      const leftId = ids[i];
      const left = positions.get(leftId);
      const leftAnchor = anchors.get(leftId);
      const leftH = prepared.get(leftId)?.h || NODE_MIN_H;
      for (let j = i + 1; j < ids.length; j++) {
        const rightId = ids[j];
        const right = positions.get(rightId);
        const rightAnchor = anchors.get(rightId);
        const rightH = prepared.get(rightId)?.h || NODE_MIN_H;
        const centerDx = (left.x + NODE_W / 2) - (right.x + NODE_W / 2);
        const centerDy = (left.y + leftH / 2) - (right.y + rightH / 2);
        const isLinked = neighbors.get(leftId)?.has(rightId) || false;
        if (isLinked && linkAttract > 0.001) {
          const xPull = ((leftAnchor.x + rightAnchor.x) / 2 - (left.x + right.x) / 2) * (0.018 + linkAttract * 0.042);
          left.x += xPull;
          right.x += xPull;
          const avgY = ((leftAnchor.y + rightAnchor.y) / 2) - ((left.y + right.y) / 2);
          left.y += avgY * (0.01 + linkAttract * 0.015);
          right.y += avgY * (0.01 + linkAttract * 0.015);
        }
        if (!isLinked && ambientRepel > 0.001 && Math.abs(centerDx) < ambientRadiusX && Math.abs(centerDy) < gapY * 1.4) {
          const push = (1 - Math.abs(centerDx) / ambientRadiusX) * (1.2 + ambientRepel * 3.6);
          const signedX = centerDx === 0 ? ((laneBias.get(leftId) || 0) >= (laneBias.get(rightId) || 0) ? -1 : 1) : Math.sign(centerDx);
          left.x += signedX * push;
          right.x -= signedX * push;
        }
        const overlapX = NODE_W + gapX - Math.abs(centerDx);
        const overlapY = (leftH + rightH) / 2 + gapY - Math.abs(centerDy);
        if (overlapX > 0 && overlapY > 0 && overlapRepel > 0.001) {
          const push = Math.min(overlapX, overlapY) * (0.045 + overlapRepel * 0.07);
          const signedX = centerDx === 0 ? ((laneBias.get(leftId) || 0) >= (laneBias.get(rightId) || 0) ? -1 : 1) : Math.sign(centerDx);
          const bias = ((laneBias.get(leftId) || 0) - (laneBias.get(rightId) || 0)) * 0.0025;
          left.x += (signedX + bias) * push;
          right.x -= (signedX + bias) * push;
        }
      }
    }

    ids.forEach((nodeId) => {
      const pos = positions.get(nodeId);
      const anchor = anchors.get(nodeId);
      pos.x = anchor.x + (pos.x - anchor.x) * (0.72 - cohesion * 0.16 + linkAttract * 0.05);
      pos.y += (anchor.y - pos.y) * (0.012 + cohesion * 0.045);
    });

    for (let index = 1; index < order.length; index++) {
      const prevId = order[index - 1];
      const currId = order[index];
      const prev = positions.get(prevId);
      const curr = positions.get(currId);
      const prevH = prepared.get(prevId)?.h || NODE_MIN_H;
      const minY = prev.y + prevH + ROW_GAP * 0.55;
      if (curr.y < minY) curr.y = minY;
      const looseGap = curr.y - (prev.y + prevH);
      if (cohesion > 0.001 && looseGap > targetGapY) {
        curr.y -= (looseGap - targetGapY) * (0.18 + cohesion * 0.24);
      }
    }
  }
}

function flowNodeMonogram(node, preparedNode) {
  const firstLine = preparedNode.lines[0] || node.label || node.kind || "?";
  return String(firstLine).trim().slice(0, 2).toUpperCase() || "?";
}

function makeFlowNodeCircleToggle(wrapper, color, collapsed, onToggle) {
  const hit = document.createElementNS(NS, "circle");
  hit.setAttribute("r", "10");
  hit.setAttribute("fill", "#13192b");
  hit.setAttribute("stroke", color + "88");
  hit.setAttribute("stroke-width", "1.2");
  hit.style.cursor = "pointer";
  const glyph = document.createElementNS(NS, "text");
  glyph.setAttribute("text-anchor", "middle");
  glyph.setAttribute("font-size", "10");
  glyph.setAttribute("font-weight", "700");
  glyph.setAttribute("fill", color + "e0");
  glyph.style.cursor = "pointer";
  glyph.textContent = collapsed ? "+" : "-";
  wrapper.appendChild(hit);
  wrapper.appendChild(glyph);
  const fire = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };
  const capturePointer = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  hit.addEventListener("pointerdown", capturePointer);
  glyph.addEventListener("pointerdown", capturePointer);
  hit.addEventListener("click", fire);
  glyph.addEventListener("click", fire);
  return { hit, glyph };
}

function positionFlowNodeCircleToggle(toggle, rect, collapsed) {
  const cx = collapsed ? rect.w - 9 : 12;
  const cy = collapsed ? 9 : 12;
  toggle.hit.setAttribute("cx", String(cx));
  toggle.hit.setAttribute("cy", String(cy));
  toggle.glyph.setAttribute("x", String(cx));
  toggle.glyph.setAttribute("y", String(cy + 3));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}