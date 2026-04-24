// Flowchart view. Supports free-form node layout plus collapsible
// compound groups such as loops, branches, and function bodies.

import { NS, mkArrow } from "../../shared/panZoom.js";
import { theme } from "../../shared/theme.js";
import { cubicPt } from "../../shared/geometry.js";

const NODE_W = 32;
const NODE_MIN_H = 32;
const LINE_H = 12;
const ROW_GAP = 28;
const BRANCH_GAP = 40;
const GROUP_PAD_X = 24;
const GROUP_PAD_Y = 32;
const GROUP_SUMMARY_W = 32;
const GROUP_SUMMARY_MIN_H = 32;
const GROUP_TOGGLE_R = 7;
const NODE_CIRCLE_D = 32;
const TREE_INDENT_X = 40;
const TREE_BASE_X = 60;

const STROKE = "#111";
const BG = "#efefef";
const LABEL = "#111";
const NODE_R = 16;


function unitVector(x, y) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function pointFromCircleToward(cx, cy, tx, ty, r = 0) {
  const u = unitVector(tx - cx, ty - cy);
  return { x: cx + u.x * r, y: cy + u.y * r };
}

function buildArrowGeometry(x1, y1, x2, y2, bendX = 0, bendY = 0, r1 = 0, r2 = 0) {
  if (bendX === 0 && bendY === 0) {
    const start = pointFromCircleToward(x1, y1, x2, y2, r1);
    const end = pointFromCircleToward(x2, y2, x1, y1, r2);
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    return {
      d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      end,
      angle,
    };
  }

  const cx = (x1 + x2) / 2 + bendX;
  const cy = (y1 + y2) / 2 + bendY;

  const start = pointFromCircleToward(x1, y1, cx, cy, r1);
  const end = pointFromCircleToward(x2, y2, cx, cy, r2);

  const angle = Math.atan2(end.y - cy, end.x - cx);

  return {
    d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
    end,
    angle,
  };
}

function pointOnArrowGeometry(x1, y1, x2, y2, bendX = 0, bendY = 0, r1 = 0, r2 = 0, t = 0.5) {
  if (bendX === 0 && bendY === 0) {
    const start = pointFromCircleToward(x1, y1, x2, y2, r1);
    const end = pointFromCircleToward(x2, y2, x1, y1, r2);
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
  }

  const cx = (x1 + x2) / 2 + bendX;
  const cy = (y1 + y2) / 2 + bendY;
  const start = pointFromCircleToward(x1, y1, cx, cy, r1);
  const end = pointFromCircleToward(x2, y2, cx, cy, r2);
  const omt = 1 - t;
  return {
    x: omt * omt * start.x + 2 * omt * t * cx + t * t * end.x,
    y: omt * omt * start.y + 2 * omt * t * cy + t * t * end.y,
  };
}

function routeGeometry(route) {
  if (route?.d && Number.isFinite(route.tx) && Number.isFinite(route.ty)) {
    return {
      d: route.d,
      end: { x: route.tx, y: route.ty },
      angle: Math.atan2(route.ty - route.c2y, route.tx - route.c2x),
    };
  }
  return buildArrowGeometry(route.sx, route.sy, route.tx, route.ty, route.bendX || 0, route.bendY || 0, 0, 0);
}

function pointOnRoute(route, t = 0.5) {
  if (route?.d && Number.isFinite(route.tx) && Number.isFinite(route.ty)) {
    return cubicPt(route.sx, route.sy, route.c1x, route.c1y, route.c2x, route.c2y, route.tx, route.ty, t);
  }
  return pointOnArrowGeometry(route.sx, route.sy, route.tx, route.ty, route.bendX || 0, route.bendY || 0, 0, 0, t);
}

function projectControlOutward(anchor, control, minDistance) {
  if (!Number.isFinite(anchor?.dx) || !Number.isFinite(anchor?.dy)) return control;
  const projection = (control.x - anchor.x) * anchor.dx + (control.y - anchor.y) * anchor.dy;
  if (projection >= minDistance) return control;
  const adjust = minDistance - projection;
  return {
    x: control.x + anchor.dx * adjust,
    y: control.y + anchor.dy * adjust,
  };
}

function outwardHandleDistance(start, end, minDistance = 10, maxDistance = 28, scale = 0.2) {
  return Math.max(minDistance, Math.min(maxDistance, Math.hypot(end.x - start.x, end.y - start.y) * scale));
}

function circleAnchorToward(rect, tx, ty) {
  const cx = rect.x + NODE_R;
  const cy = rect.y + NODE_R;
  const point = pointFromCircleToward(cx, cy, tx, ty, NODE_R);
  const direction = unitVector(point.x - cx, point.y - cy);
  return { x: point.x, y: point.y, dx: direction.x, dy: direction.y };
}

const TREE_ROW_GAP = 26;
const FLOW_LANE_BASE_X = 188;
const FLOW_LANE_STEP_X = 182;
const FLOW_LANE_BASE_Y = 30;
const EDGE_HIT_W = 16;
const NODE_TEXT_PAD_X = 14;

export function renderFlowchart(graph, ctx) {
  const simplifiedGraph = simplifyAlphabetFlowGraph(graph);
  const { root, defs } = ctx;
  const canvasState = ctx.canvas?.state;
  const layoutMode = ctx.uiState?.layoutMode || (ctx.uiState?.treeView ? "tree" : "lanes");
  const treeView = layoutMode === "tree";
  const freeformView = layoutMode === "freeform";
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

  const nodes = simplifiedGraph.nodes.map((node) => ({ ...node }));
  const edges = simplifiedGraph.edges || [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const hasPersistedNodeCircleState = nodes.some((node) => typeof savedNodes[node.id]?.circleCollapsed === "boolean");
  const groups = normalizeGroups(simplifiedGraph.metadata?.groups || []);
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodeGroupChains = buildNodeGroupChains(groups);
  const groupDepth = buildGroupDepthMap(groups);
  const nodeMetaById = new Map(nodes.map((node) => [node.id, node.metadata || {}]));
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
  const entry = (simplifiedGraph.rootNodeIds && simplifiedGraph.rootNodeIds[0])
    || (nodes.find((node) => node.kind === "entry") || nodes[0])?.id;
  if (!entry) {
    return { edgeRecords: [], nodeRect: new Map(), nodes, initialView: { scale: 1, panX: 0, panY: 0 } };
  }

  applyFlowAlphabetLayout(positions, nodes, edges, prepared, entry);
  for (const node of nodes) {
    if (!positions.has(node.id)) {
      const preparedNode = prepared.get(node.id);
      positions.set(node.id, { x: 100, y: cursorY, h: preparedNode ? preparedNode.h : NODE_MIN_H });
      cursorY += (preparedNode ? preparedNode.h : NODE_MIN_H) + ROW_GAP;
    }
  }
  const progressiveMode = ctx.progressiveMode || "none"; 
  const hasPersistedGroupState = groups.some((g) => typeof savedGroups[g.id]?.collapsed === "boolean");
  const groupState = new Map(groups.map((group) => [group.id, {
    collapsed: (groupDepth.get(group.id) || 0) > 0 || isLoopGroupKind(group.kind)
      ? true
      : hasPersistedGroupState
        ? !!savedGroups[group.id]?.collapsed
        : false,
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
      nodeMetaById,
      isNodeCircleCollapsed,
      visibility,
      groupState,
      nodeOffset,
      treeBaseNodePos,
      treeBaseGroupPos,
      forceOptions,
    );
  } else if (freeformView) {
    for (const [nodeId, saved] of Object.entries(savedNodes)) {
      const pos = positions.get(nodeId);
      if (!pos || typeof saved?.x !== "number" || typeof saved?.y !== "number") continue;
      pos.x = saved.x;
      pos.y = saved.y;
    }
    applyFlowForceLayout(positions, prepared, outgoing, incoming, forceOptions);
  } else {
    applyFlowAlphabetLayout(positions, nodes, edges, prepared, entry, visibility.visibleNodeIds);
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
  if (freeformView) resolveFlowNodeSeparation(new Set(), visibility.visibleNodeIds);
  const allNodesCircleCollapsed = nodes.every((node) => isNodeCircleCollapsed(node.id));
  let loopLaneRanks = buildLoopLaneRanks(nodes, positions, visibility.visibleNodeIds, groupDepth);

  const groupLayer = document.createElementNS(NS, "g"); root.appendChild(groupLayer);
  const edgeLayer = document.createElementNS(NS, "g"); root.appendChild(edgeLayer);
  const dotLayer = document.createElementNS(NS, "g"); root.appendChild(dotLayer);
  const collapsedLayer = document.createElementNS(NS, "g"); root.appendChild(collapsedLayer);
  const nodeLayer = document.createElementNS(NS, "g"); root.appendChild(nodeLayer);

  let collapsedGroupRects = computeCollapsedGroupRects(visibility.visibleCollapsedGroupIds, groupById, groupState, nodeRectAll);
  // For loop body groups at any depth, position the chip to the right of the loop condition node (alphabet layout rule)
  for (const groupId of visibility.visibleCollapsedGroupIds) {
    const group = groupById.get(groupId);
    if (!group || !isLoopGroupKind(group.kind)) continue;
    const state = groupState.get(groupId);
    if (state && typeof state.x === "number") continue; // user has manually moved it
    const loopCondNode = nodes.find((n) =>
      n.kind === "loop" &&
      simplifiedGraph.edges.some((e) => e.from === n.id && group.nodeSet.has(e.to))
    );
    if (!loopCondNode) continue;
    const loopRect = nodeRectAll.get(loopCondNode.id);
    if (!loopRect) continue;
    collapsedGroupRects.set(groupId, { x: loopRect.x + 90, y: loopRect.y, w: NODE_CIRCLE_D, h: NODE_CIRCLE_D });
  }
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
    region.setAttribute("fill", "transparent");
    region.setAttribute("stroke", "transparent");
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
    chip.setAttribute("fill", "transparent");
    chip.setAttribute("stroke", "transparent");
    wrapper.appendChild(chip);

    const title = document.createElementNS(NS, "text");
    title.setAttribute("x", String(bounds.x + 34));
    title.setAttribute("y", String(bounds.y + 2));
    title.setAttribute("fill", "transparent");
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
    wrapper.dataset.transitionKey = `group:${group.id}`;
    wrapper.style.cursor = "grab";

    // Render collapsed group as an alphabet circle
    const cx = rect.x + NODE_R;
    const cy = rect.y + NODE_R;
    const box = document.createElementNS(NS, "circle");
    box.setAttribute("cx", String(cx));
    box.setAttribute("cy", String(cy));
    box.setAttribute("r", String(NODE_R));
    box.setAttribute("fill", color + "1b");
    box.setAttribute("stroke", color + "86");
    box.setAttribute("stroke-width", "1.4");
    wrapper.appendChild(box);

    // Top label: abbreviated kind
    let gTop = "S"; let gBot = "body";
    ({ top: gTop, bottom: gBot } = groupChipText(group));
    const topText = document.createElementNS(NS, "text");
    topText.setAttribute("x", String(cx));
    topText.setAttribute("y", String(cy - 1.5));
    topText.setAttribute("text-anchor", "middle");
    topText.setAttribute("fill", color + "dd");
    topText.setAttribute("font-size", "6.1");
    topText.style.fontFamily = "serif";
    topText.textContent = gTop;
    wrapper.appendChild(topText);
    const botText = document.createElementNS(NS, "text");
    botText.setAttribute("x", String(cx));
    botText.setAttribute("y", String(cy + 6.6));
    botText.setAttribute("text-anchor", "middle");
    botText.setAttribute("fill", color + "88");
    botText.setAttribute("font-size", "5.4");
    botText.style.fontFamily = "serif";
    botText.style.letterSpacing = "0.2px";
    botText.textContent = gBot;
    wrapper.appendChild(botText);

    const toggle = makeGroupToggle(wrapper, color, true, () => {
      // Always drilldown into the group when the toggle is clicked — alphabet rule:
      // collapsed chips are nodes, clicking reveals the next layer as its own alphabet view.
      if (ctx.onDrilldownGroup) {
        ctx.onDrilldownGroup(group.id, group.label || group.kind);
      } else {
        toggleGroup(group.id);
      }
    });
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
    const lowerLabel = String(edge.label || "").toLowerCase();
    const syntheticLoopBack = !!edge.synthetic && (lowerLabel === "repeat" || lowerLabel === "continue") && toKind === "loop";
    const route = computeEdgeRoute({ label: edge.label || "", src: srcEndpoint, tgt: tgtEndpoint }, fromRect, toRect, fromKind, toKind, loopLaneRanks);
    const color = syntheticLoopBack
      ? (lowerLabel === "continue" ? theme.nodeColor.continue : theme.nodeColor.loop)
      : (theme.nodeColor[fromKind] || "#454a60");

    const geom = routeGeometry(route);
    const d = geom.d;
    const end = geom.end;
    const angle = geom.angle;

    const ah = 6.3;
    const aw = 3.3;
    const back = 0.6;
    const tipX = end.x;
    const tipY = end.y;
    const baseX = tipX - (ah + back) * Math.cos(angle);
    const baseY = tipY - (ah + back) * Math.sin(angle);
    const ax1 = baseX + aw * Math.sin(angle);
    const ay1 = baseY - aw * Math.cos(angle);
    const ax2 = baseX - aw * Math.sin(angle);
    const ay2 = baseY + aw * Math.cos(angle);

    const pathGroup = document.createElementNS(NS, "g");
    pathGroup.dataset.edgeKey = buildFlowTransitionEdgeKey({ from: srcEndpoint, to: tgtEndpoint, label: edge.label || "" });

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color + "4f");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    pathGroup.appendChild(path);

    const arrowHead = document.createElementNS(NS, "path");
    arrowHead.setAttribute("d", `M ${ax1} ${ay1} L ${tipX} ${tipY} L ${ax2} ${ay2}`);
    arrowHead.setAttribute("fill", "none");
    arrowHead.setAttribute("stroke", color + "4f");
    arrowHead.setAttribute("stroke-width", "1.4");
    arrowHead.setAttribute("stroke-linecap", "round");
    arrowHead.setAttribute("stroke-linejoin", "round");
    pathGroup.appendChild(arrowHead);
    
    const hitPath = document.createElementNS(NS, "path");
    hitPath.setAttribute("d", d);
    hitPath.setAttribute("fill", "none");
    hitPath.setAttribute("stroke", "transparent");
    hitPath.setAttribute("stroke-width", String(EDGE_HIT_W));
    hitPath.setAttribute("pointer-events", "stroke");
    pathGroup.appendChild(hitPath);

    let labelEl = null;
    if (edge.label) {
      const mid = pointOnRoute(route, route.labelT ?? 0.5);
      labelEl = document.createElementNS(NS, "text");
      labelEl.setAttribute("x", String(mid.x + (route.labelDx || 0)));
      labelEl.setAttribute("y", String(mid.y + (route.labelDy || 0)));
      labelEl.setAttribute("fill", color + "a2");
      labelEl.setAttribute("font-size", "8.5");
      labelEl.style.fontFamily = "serif";
      labelEl.textContent = edge.label;
      pathGroup.appendChild(labelEl);
    }

    edgeLayer.appendChild(pathGroup);

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "1.3");
    dot.setAttribute("fill", color);
    dot.setAttribute("opacity", "0");
    dotLayer.appendChild(dot);
    edgeMap[`${edge.from}->${edge.to}`] = edgeRecords.length;
    const edgeRecord = {
      el: path,
      arrowHeadEl: arrowHead,
      hitEl: hitPath,
      src: srcEndpoint,
      tgt: tgtEndpoint,
      fromKind,
      toKind,
      label: edge.label || "",
      rawEdge: edge,
      labelEl,
      sx: route.sx,
      sy: route.sy,
      c1x: route.c1x,
      c1y: route.c1y,
      c2x: route.c2x,
      c2y: route.c2y,
      tx: route.tx,
      ty: route.ty,
      labelT: route.labelT ?? 0.5,
      labelDx: route.labelDx ?? 0,
      labelDy: route.labelDy ?? 0,
      dot,
      offset: Math.random(),
      speed: 0.0006 + Math.random() * 0.0004,
    };
    const edgeTooltip = buildEdgeTooltipPayload(edgeRecord, nodesById, groupById, simplifiedGraph.metadata?.language || "");
    const setEdgeHover = (active) => {
      path.setAttribute("stroke", color + (active ? "88" : "33"));
      arrowHead.setAttribute("stroke", color + (active ? "88" : "33"));
      path.setAttribute("stroke-width", active ? "1.8" : "1.4");
      arrowHead.setAttribute("stroke-width", active ? "1.8" : "1.4");
      if (labelEl) labelEl.setAttribute("fill", color + (active ? "dd" : "88"));
    };
    hitPath.addEventListener("mouseenter", (event) => {
      setEdgeHover(true);
      ctx.showTooltip(event, edgeTooltip);
    });
    hitPath.addEventListener("mousemove", (event) => ctx.moveTooltip(event));
    hitPath.addEventListener("mouseleave", () => {
      setEdgeHover(false);
      ctx.hideTooltip();
    });
    edgeRecords.push(edgeRecord);
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
    if (freeformView) resolveFlowNodeSeparation(new Set(), new Set(nodes.map((node) => node.id)));
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
        nodeMetaById,
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
    } else if (freeformView) {
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
    if (!freeformView) return;
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
        nodeMetaById,
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
    } else if (freeformView) {
      resolveFlowNodeSeparation(fixedIds, activeNodeIds);
    }
    collapsedGroupRects = computeCollapsedGroupRects(visibility.visibleCollapsedGroupIds, groupById, groupState, nodeRectAll);
    // Re-apply loop body chip positioning after recalc (same as initial render pass)
    for (const groupId of visibility.visibleCollapsedGroupIds) {
      const group = groupById.get(groupId);
      if (!group || !isLoopGroupKind(group.kind)) continue;
      const state = groupState.get(groupId);
      if (state && typeof state.x === "number") continue;
      const loopCondNode = nodes.find((n) =>
        n.kind === "loop" &&
        simplifiedGraph.edges.some((e) => e.from === n.id && group.nodeSet.has(e.to))
      );
      if (!loopCondNode) continue;
      const loopRect = nodeRectAll.get(loopCondNode.id);
      if (!loopRect) continue;
      collapsedGroupRects.set(groupId, { x: loopRect.x + 90, y: loopRect.y, w: NODE_CIRCLE_D, h: NODE_CIRCLE_D });
    }
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
      // box is a <circle>: update cx/cy
      const circleCx = rect.x + NODE_R;
      const circleCy = rect.y + NODE_R;
      elements.box.setAttribute("cx", String(circleCx));
      elements.box.setAttribute("cy", String(circleCy));
      // Update text positions
      const texts = Array.from(elements.wrapper.querySelectorAll("text"));
      if (texts[0]) { texts[0].setAttribute("x", String(circleCx)); texts[0].setAttribute("y", String(circleCy - 1.5)); }
      if (texts[1]) { texts[1].setAttribute("x", String(circleCx)); texts[1].setAttribute("y", String(circleCy + 6.6)); }
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
    if (expanding) {
      // Reopen just this group. Keep nested groups collapsed so the user can
      // drill down one level at a time and preserve hierarchy.
      for (const descendantId of groupDescendants.get(groupId) || []) {
        const descendantState = groupState.get(descendantId);
        if (!descendantState) continue;
        descendantState.collapsed = true;
      }
    }
    if (treeView && expanding) {
      for (const nodeId of group.nodeIds) {
        const nodeEntry = nodeState.get(nodeId);
        if (!nodeEntry) continue;
        nodeEntry.treeDx = (nodeEntry.treeDx || 0) + (state.treeDx || 0);
        nodeEntry.treeDy = (nodeEntry.treeDy || 0) + (state.treeDy || 0);
      }
      state.treeDx = 0;
      state.treeDy = 0;
    } else if (freeformView && expanding) {
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

    const geom = routeGeometry(route);
    const d = geom.d;
    const end = geom.end;
    const angle = geom.angle;

    const ah = 6.3;
    const aw = 3.3;
    const back = 0.6;
    const tipX = end.x;
    const tipY = end.y;
    const baseX = tipX - (ah + back) * Math.cos(angle);
    const baseY = tipY - (ah + back) * Math.sin(angle);
    const ax1 = baseX + aw * Math.sin(angle);
    const ay1 = baseY - aw * Math.cos(angle);
    const ax2 = baseX - aw * Math.sin(angle);
    const ay2 = baseY + aw * Math.cos(angle);
    
    edge.sx = route.sx;
    edge.sy = route.sy;
    edge.tx = route.tx;
    edge.ty = route.ty;
    edge.c1x = route.c1x;
    edge.c1y = route.c1y;
    edge.c2x = route.c2x;
    edge.c2y = route.c2y;
    edge.labelT = route.labelT ?? 0.5;
    edge.labelDx = route.labelDx ?? 0;
    edge.labelDy = route.labelDy ?? -6;

    edge.el.setAttribute("d", d);
    edge.arrowHeadEl.setAttribute("d", `M ${ax1} ${ay1} L ${tipX} ${tipY} L ${ax2} ${ay2}`);
    if (edge.hitEl) edge.hitEl.setAttribute("d", d);
    if (edge.labelEl) {
      const mid = pointOnRoute(route, edge.labelT);
      edge.labelEl.setAttribute("x", String(mid.x + edge.labelDx));
      edge.labelEl.setAttribute("y", String(mid.y + edge.labelDy));
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
  group.dataset.transitionKey = `node:${node.id}`;
  group.style.cursor = "pointer";

  let { top: t, bottom: b } = nodeChipText(node);

  const cx = 16;
  const cy = 16;

  const shape = document.createElementNS(NS, "circle");
  shape.setAttribute("cx", String(cx));
  shape.setAttribute("cy", String(cy));
  shape.setAttribute("r", "16");
  shape.setAttribute("fill", color + "1b");
  shape.setAttribute("stroke", color + "86");
  shape.setAttribute("stroke-width", "1.4");
  group.appendChild(shape);

  const topT = document.createElementNS(NS, "text");
  topT.setAttribute("x", String(cx));
  topT.setAttribute("y", String(cy - 1.5));
  topT.setAttribute("text-anchor", "middle");
  topT.setAttribute("fill", color + "dd");
  topT.setAttribute("font-size", "6.1");
  topT.style.fontFamily = "serif";
  topT.textContent = t;
  group.appendChild(topT);

  const botT = document.createElementNS(NS, "text");
  botT.setAttribute("x", String(cx));
  botT.setAttribute("y", String(cy + 6.6));
  botT.setAttribute("text-anchor", "middle");
  botT.setAttribute("fill", color + "88");
  botT.setAttribute("font-size", "5.4");
  botT.style.fontFamily = "serif";
  botT.style.letterSpacing = "0.2px";
  botT.textContent = b;
  group.appendChild(botT);

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

function simplifyAlphabetFlowGraph(graph) {
  const originalNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const originalEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const groups = Array.isArray(graph?.metadata?.groups) ? graph.metadata.groups : [];
  const removedNodeIds = new Set();
  let edges = originalEdges.map((edge) => ({ ...edge }));

  const shouldContractNode = (node) => {
    if (!node) return false;
    if (node.metadata?.boundaryProxy) return false;
    if (node.kind === "loop_else") return true;
    if (node.kind !== "process") return false;
    const label = String(node.label || "").trim().toLowerCase();
    return label === "•" || label === "after loop";
  };

  const buildAdjacency = () => {
    const incoming = new Map();
    const outgoing = new Map();
    originalNodes.forEach((node) => {
      incoming.set(node.id, []);
      outgoing.set(node.id, []);
    });
    edges.forEach((edge) => {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      incoming.get(edge.to).push(edge);
      outgoing.get(edge.from).push(edge);
    });
    return { incoming, outgoing };
  };

  const combineLabels = (incomingLabel, outgoingLabel) => {
    const inLabel = String(incomingLabel || "").trim();
    const outLabel = String(outgoingLabel || "").trim();
    const inLower = inLabel.toLowerCase();
    const outLower = outLabel.toLowerCase();
    if (outLower === "repeat") return "repeat";
    if (outLower === "continue") return "continue";
    if (!outLabel && inLower === "repeat") return "repeat";
    if (!outLabel && inLower === "continue") return "continue";
    if (inLabel && outLabel) return `${inLabel}/${outLabel}`;
    return inLabel || outLabel || "";
  };

  const nodeKindMap = new Map(originalNodes.map((n) => [n.id, n.kind]));

  const normalizeAlphabetLoopEdge = (edge) => {
    const targetKind = nodeKindMap.get(edge.to);
    const label = String(edge.label || "").trim();
    const lower = label.toLowerCase();
    if (targetKind === "loop") {
      if (lower === "continue" || lower.endsWith("/continue")) return { ...edge, label: "continue" };
      if (lower === "repeat" || lower.endsWith("/repeat")) return { ...edge, label: "repeat" };
    }
    return edge;
  };

  originalNodes.forEach((node) => {
    if (!shouldContractNode(node)) return;
    const { incoming, outgoing } = buildAdjacency();
    const inEdges = incoming.get(node.id) || [];
    const outEdges = outgoing.get(node.id) || [];
    const label = String(node.label || "").trim().toLowerCase();
    if (label === "after loop" && inEdges.length && !outEdges.length) {
      edges = edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
      removedNodeIds.add(node.id);
      return;
    }
    if (!inEdges.length || !outEdges.length) return;

    const rewired = [];
    inEdges.forEach((inEdge) => {
      outEdges.forEach((outEdge) => {
        if (inEdge.from === outEdge.to) return;
        rewired.push({
          id: `e_${inEdge.from}_${outEdge.to}_${edges.length + rewired.length}`,
          from: inEdge.from,
          to: outEdge.to,
          kind: inEdge.kind || outEdge.kind || "control_flow",
          label: combineLabels(inEdge.label, outEdge.label),
        });
      });
    });

    edges = edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
    edges.push(...rewired);
    removedNodeIds.add(node.id);
  });

  const dedupedEdges = [];
  const seen = new Set();
  edges.forEach((edge) => {
    if (removedNodeIds.has(edge.from) || removedNodeIds.has(edge.to)) return;
    const normalizedEdge = normalizeAlphabetLoopEdge(edge);
    const key = `${normalizedEdge.from}->${normalizedEdge.to}::${normalizedEdge.label || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    dedupedEdges.push(normalizedEdge);
  });

  const nodes = originalNodes.filter((node) => !removedNodeIds.has(node.id));
  const baseGroups = groups
    .map((group) => ({
      ...group,
      nodeIds: (group.nodeIds || []).filter((nodeId) => !removedNodeIds.has(nodeId)),
    }))
    .filter((group) => group.nodeIds.length > 0);

  // Strip the loop-condition header node from its own loop group so it remains
  // visible at the parent scope when the loop group is collapsed. The header is
  // identified as the loop-kind node with at least one incoming edge from outside
  // the group (i.e. it is the entry point, not a nested inner loop inside).
  // Prefer promoting a concrete body node that actually owns the loop-back edge;
  // if no such visible node exists, keep the summary conservative instead of
  // inventing a repeat/continue edge from the wrong source node.
  const incomingEdgeMap = new Map(nodes.map((n) => [n.id, []]));
  const outgoingEdgeMap = new Map(nodes.map((n) => [n.id, []]));
  dedupedEdges.forEach((e) => { if (incomingEdgeMap.has(e.to)) incomingEdgeMap.get(e.to).push(e.from); });
  dedupedEdges.forEach((e) => { if (outgoingEdgeMap.has(e.from)) outgoingEdgeMap.get(e.from).push(e); });
  const mutableGroups = new Map(baseGroups.map((group) => [group.id, { ...group, nodeIds: [...group.nodeIds] }]));

  function removePromotedNodes(groupId, promotedNodeIds) {
    let currentId = groupId;
    while (currentId) {
      const currentGroup = mutableGroups.get(currentId);
      if (!currentGroup) break;
      currentGroup.nodeIds = currentGroup.nodeIds.filter((id) => !promotedNodeIds.has(id));
      const parentId = currentGroup.parentGroupId || null;
      if (!parentId) break;
      const parentGroup = mutableGroups.get(parentId);
      if (!parentGroup || isLoopGroupKind(parentGroup.kind)) break;
      currentId = parentId;
    }
  }

  baseGroups.forEach((group) => {
      if (!isLoopGroupKind(group.kind)) return;
      const mutableGroup = mutableGroups.get(group.id);
      if (!mutableGroup) return;
      const nodeSet = new Set(mutableGroup.nodeIds);
      const headerIds = new Set(
        mutableGroup.nodeIds.filter((id) => {
          if (nodeKindMap.get(id) !== "loop") return false;
          return (incomingEdgeMap.get(id) || []).some((fromId) => !nodeSet.has(fromId));
        }),
      );
      const loopBackSourceIds = new Set(
        mutableGroup.nodeIds.filter((id) => {
          if (headerIds.has(id)) return false;
          const outgoing = outgoingEdgeMap.get(id) || [];
          return outgoing.some((edge) => edge.to !== id && headerIds.has(edge.to) && (edge.label === "repeat" || edge.label === "continue"));
        }),
      );
      const bodyEntryIds = new Set(
        mutableGroup.nodeIds.filter((id) => {
          if (headerIds.has(id)) return false;
          const kind = nodeKindMap.get(id);
          if (kind === "break" || kind === "continue" || kind === "return") return false;
          return (incomingEdgeMap.get(id) || []).some((fromId) => headerIds.has(fromId));
        }),
      );
      let promotedBodyId = null;
      if (bodyEntryIds.size) {
        promotedBodyId = mutableGroup.nodeIds.find((id) => bodyEntryIds.has(id)) || null;
        if (promotedBodyId && nodeKindMap.get(promotedBodyId) === "decision") {
          const preferredConcreteLoopBack = mutableGroup.nodeIds.find((id) => {
            if (!loopBackSourceIds.has(id)) return false;
            const kind = nodeKindMap.get(id);
            return kind !== "decision" && kind !== "continue" && kind !== "break" && kind !== "return";
          });
          if (preferredConcreteLoopBack) promotedBodyId = preferredConcreteLoopBack;
        }
      }
      if (!headerIds.size && !promotedBodyId) return group;
      const promotedNodeIds = new Set(headerIds);
      if (promotedBodyId) promotedNodeIds.add(promotedBodyId);
      removePromotedNodes(group.id, promotedNodeIds);
    });

  const visibleEdges = dedupedEdges.slice();

  const nextGroups = Array.from(mutableGroups.values())
    .map((group) => ({ ...group, nodeSet: new Set(group.nodeIds) }))
    .filter((group) => group.nodeIds.length > 0);

  return {
    ...graph,
    nodes,
    edges: visibleEdges,
    metadata: {
      ...(graph.metadata || {}),
      groups: nextGroups,
    },
  };
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
    // Skip this group if any ancestor group is currently collapsed – it is hidden inside that chip
    let hasCollapsedAncestor = false;
    let parentId = group.parentGroupId;
    while (parentId) {
      if (groupState.get(parentId)?.collapsed) { hasCollapsedAncestor = true; break; }
      parentId = groupById.get(parentId)?.parentGroupId ?? null;
    }
    if (hasCollapsedAncestor) continue;
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
  // chain is sorted deepest-first; we want the outermost (shallowest) collapsed ancestor
  const chain = nodeGroupChains.get(nodeId) || [];
  let outermost = null;
  for (const groupId of chain) {
    if (groupState.get(groupId)?.collapsed) outermost = groupKey(groupId);
  }
  return outermost || nodeId;
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
    if (isLoopGroupKind(group.kind)) return "loop";
    return "process";
  }
  return nodesById.get(endpointId)?.kind || "process";
}

function isLoopGroupKind(kind) {
  return kind === "loop" || kind === "loop_body";
}

function groupColor(kind) {
  if (kind === "branch") return theme.nodeColor.decision;
  if (isLoopGroupKind(kind)) return theme.nodeColor.loop;
  if (kind === "function_body") return theme.nodeColor.compute;
  return theme.accent;
}

function groupChipText(group) {
  const label = String(group.label || "").toLowerCase();
  if (isLoopGroupKind(group.kind)) return { top: "for", bottom: "body" };
  if (group.kind === "branch") {
    if (label.startsWith("then:")) return { top: "then", bottom: "block" };
    if (label.startsWith("else:")) return { top: "else", bottom: "block" };
    return { top: "if", bottom: "block" };
  }
  if (group.kind === "function_body") return { top: "fn", bottom: "body" };
  return { top: "S", bottom: "body" };
}

function nodeChipText(node) {
  const primary = primaryNodeLine(node);
  if (node.kind === "entry") return { top: "fn", bottom: abbreviateChipText(primary || "enter") };
  if (node.kind === "return") return { top: "ret", bottom: abbreviateChipText(primary.replace(/^return\s+/i, "") || "value") };
  if (node.kind === "decision") return { top: "if", bottom: abbreviateChipText(primary.replace(/^if\s+/i, "").replace(/\?$/, "") || "cond") };
  if (node.kind === "loop") {
    if (/^for each\s+/i.test(primary)) {
      const tail = primary.replace(/^for each\s+/i, "");
      const target = tail.split(/\s+in\s+/i)[0] || "iter";
      return { top: "for", bottom: abbreviateChipText(target) };
    }
    return { top: "loop", bottom: abbreviateChipText(primary.replace(/^while\s+/i, "") || "cond") };
  }
  if (node.kind === "break") return { top: "break", bottom: "exit" };
  if (node.kind === "continue") return { top: "cont", bottom: "next" };
  if (node.kind === "error") return { top: "exc", bottom: abbreviateChipText(primary.replace(/^raise\s+/i, "") || "throw") };
  return { top: "S", bottom: abbreviateChipText(primary || "stmt") };
}

function primaryNodeLine(node) {
  const displayLines = Array.isArray(node?.metadata?.displayLines)
    ? node.metadata.displayLines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  if (displayLines.length) return displayLines[0];
  return String(node?.label || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function abbreviateChipText(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "stmt";
  const cleaned = source
    .replace(/^for each\s+/i, "")
    .replace(/^implicit\s+/i, "")
    .replace(/^loop\s+/i, "")
    .replace(/^total\s*=\s*/i, "total=")
    .replace(/^matches\s*=\s*/i, "matches=");
  return cleaned.length > 12 ? `${cleaned.slice(0, 11)}.` : cleaned;
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
  const label = String(edge.label || "").toLowerCase();

  if (label === "repeat" && toKind === "loop") return makeRepeatLoopBackRoute(edge, fromRect, toRect, loopLaneRanks);
  if (label === "continue" && toKind === "loop") return makeContinueLoopBackRoute(edge, fromRect, toRect, loopLaneRanks);
  if (fromKind === "loop") {
    if (label === "done" || label === "else" || toKind === "loop_else") return makeLoopExitRoute(edge, fromRect, toRect, toKind === "loop_else", loopLaneRanks);
    return makeLoopBodyRoute(fromRect, toRect, label);
  }

  if (fromKind === "decision") return makeDecisionBranchRoute(fromRect, toRect, label);

  return makeDefaultRoute(edge, fromRect, toRect);
}

function makeDefaultRoute(edge, fromRect, toRect) {
  const fromCx = fromRect.x + fromRect.w / 2;
  const fromCy = fromRect.y + fromRect.h / 2;
  const toCx = toRect.x + toRect.w / 2;
  const toCy = toRect.y + toRect.h / 2;
  const start = circleAnchorToward(fromRect, toCx, toCy);
  const end = circleAnchorToward(toRect, fromCx, fromCy);

  return buildLineRoute(start, end, { labelT: 0.5, labelDx: 8, labelDy: -6 });
}

function makeLoopBodyRoute(fromRect, toRect, label) {
  const toRight = toRect.x + toRect.w / 2 >= fromRect.x + fromRect.w / 2;
  const start = anchorOnRect(fromRect, toRight ? "right" : "left", 0.52);
  const end = anchorOnRect(toRect, toRight ? "left" : "right", 0.52);
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.min(start.y, end.y) - Math.max(46, Math.abs(end.x - start.x) * 0.42),
  };
  return buildQuadraticRoute(start, control, end, { labelT: 0.42, labelDx: 10, labelDy: -8 });
}

function makeDecisionBranchRoute(fromRect, toRect, label) {
  const fromCx = fromRect.x + fromRect.w / 2;
  const toCx = toRect.x + toRect.w / 2;
  const positive = /^(yes|true|ok|then|body|do)$/i.test(label);
  const negative = /^(no|false|else|done|exit)$/i.test(label);
  const branchRight = positive ? true : negative ? false : toCx >= fromCx;
  const targetBelow = toRect.y >= fromRect.y;
  if (targetBelow && Math.abs(toCx - fromCx) < fromRect.w * 0.45) {
    const start = anchorOnRect(fromRect, branchRight ? "bottom" : "bottom", branchRight ? 0.74 : 0.26);
    const end = anchorOnRect(toRect, "top", 0.5);
    const control = {
      x: branchRight ? Math.min(start.x, end.x) - 54 : Math.max(start.x, end.x) + 54,
      y: (start.y + end.y) / 2,
    };
    return buildQuadraticRoute(start, control, end, {
      labelT: branchRight ? 0.42 : 0.48,
      labelDx: branchRight ? -16 : 14,
      labelDy: -6,
    });
  }

  const start = anchorOnRect(fromRect, branchRight ? "right" : "left", 0.62);
  const end = targetBelow
    ? anchorOnRect(toRect, "top", branchRight ? 0.28 : 0.72)
    : anchorOnRect(toRect, branchRight ? "left" : "right", 0.52);
  return buildLineRoute(start, end, {
    labelT: branchRight ? 0.42 : 0.46,
    labelDx: branchRight ? 10 : -14,
    labelDy: -6,
  });
}

function makeRepeatLoopBackRoute(edge, fromRect, toRect, loopLaneRanks) {
  const loopId = edge.tgt.replace(/^group:/, "");
  const loopRank = loopLaneRanks.get(loopId) || 0;
  const start = anchorOnRect(fromRect, "right", 0.5);
  const end = anchorOnRect(toRect, "left", 0.5);
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.max(start.y, end.y) + 54 + loopRank * 10,
  };
  return buildQuadraticRoute(start, control, end, { labelT: 0.58, labelDx: 14, labelDy: -8 });
}

function makeContinueLoopBackRoute(edge, fromRect, toRect, loopLaneRanks) {
  const loopId = edge.tgt.replace(/^group:/, "");
  const loopRank = loopLaneRanks.get(loopId) || 0;
  const start = anchorOnRect(fromRect, "right", 0.5);
  const end = anchorOnRect(toRect, "left", 0.5);
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.max(start.y, end.y) + 34 + loopRank * 8,
  };
  return buildQuadraticRoute(start, control, end, { labelT: 0.54, labelDx: 12, labelDy: -8 });
}

function makeLoopExitRoute(edge, fromRect, toRect, isLoopElse, loopLaneRanks) {
  const loopId = edge.src.replace(/^group:/, "");
  if (!isLoopElse && toRect.y > fromRect.y && Math.abs((toRect.x + toRect.w / 2) - (fromRect.x + fromRect.w / 2)) < fromRect.w * 0.45) {
    const start = anchorOnRect(fromRect, "bottom", 0.5);
    const end = anchorOnRect(toRect, "top", 0.5);
    return buildLineRoute(start, end, { labelT: 0.5, labelDx: 10, labelDy: -6 });
  }
  const start = anchorOnRect(fromRect, "bottom", 0.62);
  const end = isLoopElse ? anchorOnRect(toRect, "top", 0.5) : anchorOnRect(toRect, "left", 0.34);
  const control = {
    x: (start.x + end.x) / 2 + Math.max(24, Math.abs(end.x - start.x) * 0.12),
    y: (start.y + end.y) / 2,
  };
  return buildQuadraticRoute(start, control, end, { labelT: 0.42, labelDx: 12, labelDy: -6 });
}

function buildLineRoute(start, end, options = {}) {
  const minHandle = outwardHandleDistance(start, end, 9, 26, 0.18);
  const c1 = projectControlOutward(start, {
    x: start.x + (end.x - start.x) / 3,
    y: start.y + (end.y - start.y) / 3,
  }, minHandle);
  const c2 = projectControlOutward(end, {
    x: start.x + ((end.x - start.x) * 2) / 3,
    y: start.y + ((end.y - start.y) * 2) / 3,
  }, minHandle);
  return {
    sx: start.x,
    sy: start.y,
    c1x: c1.x,
    c1y: c1.y,
    c2x: c2.x,
    c2y: c2.y,
    tx: end.x,
    ty: end.y,
    d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
    labelT: options.labelT ?? 0.5,
    labelDx: options.labelDx ?? 6,
    labelDy: options.labelDy ?? -4,
  };
}

function buildQuadraticRoute(start, control, end, options = {}) {
  const minHandle = outwardHandleDistance(start, end, 10, 30, 0.2);
  const c1 = projectControlOutward(start, {
    x: start.x + ((control.x - start.x) * 2) / 3,
    y: start.y + ((control.y - start.y) * 2) / 3,
  }, minHandle);
  const c2 = projectControlOutward(end, {
    x: end.x + ((control.x - end.x) * 2) / 3,
    y: end.y + ((control.y - end.y) * 2) / 3,
  }, minHandle);
  return {
    sx: start.x,
    sy: start.y,
    c1x: c1.x,
    c1y: c1.y,
    c2x: c2.x,
    c2y: c2.y,
    tx: end.x,
    ty: end.y,
    d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
    labelT: options.labelT ?? 0.45,
    labelDx: options.labelDx ?? 6,
    labelDy: options.labelDy ?? -4,
  };
}

function buildAnchorRoute(sourceAnchor, targetAnchor, options = {}) {
  const sx = sourceAnchor.x;
  const sy = sourceAnchor.y;
  const tx = targetAnchor.x;
  const ty = targetAnchor.y;
  const bend = typeof options.bend === "number"
    ? options.bend
    : Math.max(
      options.bendMin ?? 24,
      Math.min(options.bendMax ?? 120, Math.hypot(tx - sx, ty - sy) * (options.bendScale ?? 0.35)),
    );
  const c1x = sx + sourceAnchor.dx * bend + (options.c1xOffset || 0);
  const c1y = sy + sourceAnchor.dy * bend + (options.c1yOffset || 0);
  const c2x = tx + targetAnchor.dx * bend + (options.c2xOffset || 0);
  const c2y = ty + targetAnchor.dy * bend + (options.c2yOffset || 0);
  return {
    sx,
    sy,
    c1x,
    c1y,
    c2x,
    c2y,
    tx,
    ty,
    d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`,
    labelT: options.labelT ?? 0.35,
    labelDx: options.labelDx ?? 6,
    labelDy: options.labelDy ?? -4,
  };
}

function buildLoopArcRoute(sourceAnchor, targetAnchor, excursion, options = {}) {
  return buildAnchorRoute(sourceAnchor, targetAnchor, {
    bend: excursion,
    labelT: options.labelT ?? 0.55,
    labelDx: options.labelDx ?? 12,
    labelDy: options.labelDy ?? -8,
  });
}

function anchorOnRect(rect, side, bias = 0.5, offset = 0) {
  const clampedBias = clamp(Number.isFinite(bias) ? bias : 0.5, 0.18, 0.82);
  let targetX = rect.x + rect.w / 2;
  let targetY = rect.y + rect.h / 2;
  if (side === "left") {
    targetX = rect.x - NODE_R;
    targetY = rect.y + rect.h * clampedBias + offset;
  } else if (side === "right") {
    targetX = rect.x + rect.w + NODE_R;
    targetY = rect.y + rect.h * clampedBias + offset;
  } else if (side === "top") {
    targetX = rect.x + rect.w * clampedBias + offset;
    targetY = rect.y - NODE_R;
  } else {
    targetX = rect.x + rect.w * clampedBias + offset;
    targetY = rect.y + rect.h + NODE_R;
  }
  return circleAnchorToward(rect, targetX, targetY);
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
  // For collapsed alphabet circles: place toggle at top-right of the circle
  const circleCx = bounds.x + NODE_R;
  const circleCy = bounds.y + NODE_R;
  const cx = options.headerChip ? bounds.x + GROUP_TOGGLE_R + 8 : circleCx + NODE_R - GROUP_TOGGLE_R;
  const cy = options.headerChip ? bounds.y - 1 : circleCy - NODE_R + GROUP_TOGGLE_R;
  toggle.hit.setAttribute("cx", String(cx));
  toggle.hit.setAttribute("cy", String(cy));
  toggle.glyph.setAttribute("x", String(cx));
  toggle.glyph.setAttribute("y", String(cy + 0.5));
}

function prepareNode(node) {
  const meta = node.metadata || {};
  return {
    lines: [],
    typeLines: [],
    h: 32,
    align: "center",
  };
}

function wrapNodeLines(lines, kind, isTypeLine) {
  const maxChars = maxCharsForNode(kind, isTypeLine);
  const wrapped = [];
  lines.forEach((line) => {
    wrapCodeLikeLine(String(line || ""), maxChars).forEach((part) => wrapped.push(part));
  });
  if (wrapped.length > 8) return [...wrapped.slice(0, 7), "..."];
  return wrapped;
}

function maxCharsForNode(kind, isTypeLine) {
  const base = kind === "decision"
    ? 22
    : kind === "loop"
      ? 24
      : kind === "entry" || kind === "return"
        ? 26
        : kind === "error"
          ? 28
          : 30;
  return Math.max(12, base - (isTypeLine ? 4 : 0));
}

function textAlignForNode(kind, lineCount) {
  if (kind === "decision" || kind === "loop" || kind === "entry" || kind === "return") return "center";
  return lineCount > 1 ? "start" : "center";
}

function wrapCodeLikeLine(text, maxChars) {
  const source = String(text || "").trim();
  if (!source) return [""];
  if (source.length <= maxChars) return [source];
  const tokens = source.split(/(\s+|[(){}\[\],.:;+\-*/%<>=!?|&]+)/).filter((token) => token.length);
  const lines = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) lines.push(current.trim());
    current = "";
  };
  tokens.forEach((token) => {
    if (token.length > maxChars) {
      if (current.trim()) pushCurrent();
      for (let index = 0; index < token.length; index += maxChars) {
        lines.push(token.slice(index, index + maxChars));
      }
      return;
    }
    const candidate = current ? `${current}${token}` : token;
    if (candidate.trim().length > maxChars && current.trim()) {
      pushCurrent();
      current = token.trimStart();
      return;
    }
    current = candidate;
  });
  if (current.trim()) pushCurrent();
  return lines.length ? lines : [source];
}

function buildEdgeTooltipPayload(edge, nodesById, groupById, language) {
  const sourceNode = edge.src.startsWith("group:") ? null : nodesById.get(edge.src);
  const targetNode = edge.tgt.startsWith("group:") ? null : nodesById.get(edge.tgt);
  const sourceTypeBits = collectNodeTypeBits(sourceNode, language);
  const targetTypeBits = collectNodeTypeBits(targetNode, language);
  return {
    tooltipKind: "edge",
    label: edge.label || "control flow",
    metadata: {
      edgeLabel: edge.label || "control flow",
      fromLabel: formatFlowEndpoint(edge.src, nodesById, groupById),
      toLabel: formatFlowEndpoint(edge.tgt, nodesById, groupById),
      sourceTypeBits,
      targetTypeBits,
      language,
    },
  };
}

function formatFlowEndpoint(endpointId, nodesById, groupById) {
  if (endpointId.startsWith("group:")) {
    const group = groupById.get(endpointId.slice(6));
    return group?.label || endpointId;
  }
  const node = nodesById.get(endpointId);
  return node?.label || endpointId;
}

function collectNodeTypeBits(node, language) {
  if (!node) return [];
  const meta = node.metadata || {};
  const bits = [];
  if (Array.isArray(meta.flowTypeBits)) bits.push(...meta.flowTypeBits.map(String));
  if (meta.typeLabel) bits.push(...splitTypeBits(String(meta.typeLabel)));
  if (Array.isArray(meta.params)) {
    meta.params.forEach((param) => {
      if (param && param.name && param.type) bits.push(`${param.name}: ${param.type}`);
    });
  }
  if (meta.returnType) bits.push(`returns ${String(meta.returnType)}`);
  const displayLines = Array.isArray(meta.displayLines) && meta.displayLines.length
    ? meta.displayLines.map(String)
    : String(node.label || "").split("\n");
  bits.push(...inferTypeBitsFromLines(displayLines, language, node.kind));
  return Array.from(new Set(bits.filter(Boolean))).slice(0, 6);
}

function splitTypeBits(label) {
  return String(label)
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function inferTypeBitsFromLines(lines, language, kind) {
  const bits = [];
  lines.forEach((line) => {
    const text = String(line || "").trim();
    if (!text || text === "•") return;
    if (/^return\b/i.test(text)) {
      const expr = text.replace(/^return\b\s*,?\s*/i, "").trim();
      const inferred = inferExprTypeFromText(expr, language);
      if (inferred) bits.push(`returns ${inferred}`);
      return;
    }
    const assignment = text.match(/^(?:const|let|var\s+)?([A-Za-z_][\w.$]*)\s*=\s*(.+)$/);
    if (assignment) {
      const inferred = inferExprTypeFromText(assignment[2], language);
      if (inferred) bits.push(`${assignment[1]}: ${inferred}`);
      return;
    }
    if (kind === "decision") bits.push("condition: boolean");
  });
  return bits;
}

function inferExprTypeFromText(expr, language) {
  const text = String(expr || "").trim();
  if (!text) return "";
  if (/^['"`].*['"`]$/.test(text)) return language === "idl" ? "string" : "str";
  if (/^(true|false)$/i.test(text)) return language === "python" ? "bool" : "boolean";
  if (/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return text.includes(".") ? "float" : "int";
  if (/^\d+[lusb]?$/i.test(text)) return "int";
  if (/^\[.*\]$/.test(text)) return language === "python" ? "list" : "array";
  if (/^\{.*\}$/.test(text)) return language === "idl" ? "struct" : "object";
  if (/^(new\s+)?[A-Z][A-Za-z0-9_]*(?:\.|::[A-Za-z0-9_]+)?/.test(text)) {
    const match = text.match(/^(?:new\s+)?([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)/);
    return match ? match[1] : "object";
  }
  if (/\b(len|n_elements|count|size)\s*\(/i.test(text)) return "int";
  if (/\b(mean|float|double|sqrt|sin|cos|max|min)\s*\(/i.test(text)) return "float";
  if (/\bstring\s*\(/i.test(text)) return language === "python" ? "str" : "string";
  if (/\b(Array\.isArray|map|filter|reduce|slice)\b/.test(text)) return "array";
  if (/[<>!=]=|\b(in|not in|and|or|eq|ne|gt|lt|ge|le)\b/i.test(text)) return language === "python" ? "bool" : "boolean";
  return "";
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
  nodeMetaById,
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
      depth: treeIndentDepth(node.id, nodeGroupChains, groupById, groupDepth, nodeMetaById),
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

function applyFlowAlphabetLayout(positions, nodes, edges, prepared, entryId, visibleNodeIds = null) {
  const visible = visibleNodeIds instanceof Set ? visibleNodeIds : new Set(nodes.map((node) => node.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  nodes.forEach((node) => {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  });
  edges.forEach((edge) => {
    if (!visible.has(edge.from) || !visible.has(edge.to)) return;
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  });

  const V_STEP = 60;
  const BRANCH_X = 50;
  const LOOP_X = 90;
  const CASE_X = 50;
  const START_X = 220;
  const START_Y = 30;

  const centerById = new Map();
  const processed = new Set();
  const queue = [];

  function setCenter(nodeId, centerX, centerY) {
    const preparedNode = prepared.get(nodeId);
    if (!preparedNode) return false;
    const existing = centerById.get(nodeId);
    if (!existing) {
      centerById.set(nodeId, { x: centerX, y: centerY });
      positions.set(nodeId, { x: centerX - NODE_R, y: centerY - NODE_R, h: preparedNode.h });
      return true;
    }
    const placedPreds = (incoming.get(nodeId) || [])
      .map((edge) => centerById.get(edge.from))
      .filter(Boolean);
    const nextX = placedPreds.length > 1
      ? placedPreds.reduce((sum, pos) => sum + pos.x, 0) / placedPreds.length
      : existing.x;
    const nextY = Math.max(existing.y, centerY);
    centerById.set(nodeId, { x: nextX, y: nextY });
    positions.set(nodeId, { x: nextX - NODE_R, y: nextY - NODE_R, h: preparedNode.h });
    return false;
  }

  function classifyDecisionEdges(fromNode, outs) {
    const scored = outs.map((edge) => {
      const target = nodesById.get(edge.to);
      const label = String(edge.label || "").toLowerCase();
      let side = 0;
      if (/false|else|done|exit/.test(label)) side = -1;
      else if (/true|then|ok|body/.test(label)) side = 1;
      else if (target?.kind === "return" || target?.kind === "break" || target?.kind === "error") side = -1;
      else if (target?.kind === "continue" || target?.kind === "loop") side = 1;
      else side = edge.to < fromNode.id ? -1 : 1;
      return { edge, side };
    });
    scored.sort((left, right) => left.side - right.side || String(left.edge.to).localeCompare(String(right.edge.to)));
    return scored.map((entry) => entry.edge);
  }

  function layoutSuccessors(nodeId) {
    const fromNode = nodesById.get(nodeId);
    const center = centerById.get(nodeId);
    if (!fromNode || !center) return;
    let outs = (outgoing.get(nodeId) || []).filter((edge) => visible.has(edge.to));
    if (!outs.length) return;

    if (fromNode.kind === "decision") {
      const ordered = classifyDecisionEdges(fromNode, outs);
      if (ordered.length === 1) {
        setCenter(ordered[0].to, center.x + BRANCH_X, center.y + V_STEP);
        return;
      }
      const span = (ordered.length - 1) * CASE_X;
      ordered.forEach((edge, index) => {
        const offset = index * CASE_X - span / 2;
        setCenter(edge.to, center.x + offset, center.y + V_STEP);
      });
      return;
    }

    if (fromNode.kind === "loop") {
      const ordered = outs.slice().sort((left, right) => String(left.label || "").localeCompare(String(right.label || "")));
      let bodyEdge = ordered.find((edge) => !/done|else|exit/i.test(String(edge.label || "")) && nodesById.get(edge.to)?.kind !== "loop_else");
      let exitEdge = ordered.find((edge) => edge !== bodyEdge);
      if (!bodyEdge) {
        bodyEdge = ordered[0];
        exitEdge = ordered[1];
      }
      if (bodyEdge) setCenter(bodyEdge.to, center.x + LOOP_X, center.y);
      if (exitEdge) setCenter(exitEdge.to, center.x, center.y + V_STEP + 20);
      ordered.forEach((edge) => {
        if (edge !== bodyEdge && edge !== exitEdge) setCenter(edge.to, center.x, center.y + V_STEP + 20);
      });
      return;
    }

    const forward = outs
      .slice()
      .sort((left, right) => (Number(nodesById.get(left.to)?.source?.line || Number.MAX_SAFE_INTEGER) - Number(nodesById.get(right.to)?.source?.line || Number.MAX_SAFE_INTEGER)) || String(left.to).localeCompare(String(right.to)));
    if (forward.length === 1) {
      const targetId = forward[0].to;
      const mergePreds = (incoming.get(targetId) || []).filter((edge) => centerById.has(edge.from));
      if (mergePreds.length > 1) {
        const mergedX = mergePreds.reduce((sum, edge) => sum + centerById.get(edge.from).x, 0) / mergePreds.length;
        const mergedY = Math.max(...mergePreds.map((edge) => centerById.get(edge.from).y)) + V_STEP;
        setCenter(targetId, mergedX, mergedY);
        return;
      }
      setCenter(targetId, center.x, center.y + V_STEP);
      return;
    }

    const span = (forward.length - 1) * CASE_X;
    forward.forEach((edge, index) => {
      const offset = index * CASE_X - span / 2;
      setCenter(edge.to, center.x + offset, center.y + V_STEP);
    });
  }

  if (entryId && visible.has(entryId)) {
    setCenter(entryId, START_X, START_Y);
    queue.push(entryId);
  }

  while (queue.length) {
    const nodeId = queue.shift();
    if (!nodeId || processed.has(nodeId)) continue;
    processed.add(nodeId);
    layoutSuccessors(nodeId);
    (outgoing.get(nodeId) || []).forEach((edge) => {
      if (!visible.has(edge.to) || processed.has(edge.to)) return;
      if (centerById.has(edge.to)) queue.push(edge.to);
    });
  }

  let cursorY = Math.max(START_Y + V_STEP, ...Array.from(centerById.values()).map((pos) => pos.y + V_STEP));
  nodes
    .filter((node) => visible.has(node.id))
    .sort((left, right) => (Number(left.source?.line || Number.MAX_SAFE_INTEGER) - Number(right.source?.line || Number.MAX_SAFE_INTEGER)) || String(left.id).localeCompare(String(right.id)))
    .forEach((node) => {
      if (centerById.has(node.id)) return;
      setCenter(node.id, START_X, cursorY);
      cursorY += V_STEP;
    });
}

function applyFlowLaneLayout(
  positions,
  nodes,
  prepared,
  nodeGroupChains,
  groupById,
  groupDepth,
  nodeMetaById,
  isNodeCircleCollapsed,
  visibility,
  forceOptions,
) {
  const overlapRepel = clamp01(forceOptions?.overlapRepel ?? 0.35);
  const ambientRepel = clamp01(forceOptions?.ambientRepel ?? 0.18);
  const cohesion = clamp01(forceOptions?.cohesion ?? 0.34);
  const laneStep = FLOW_LANE_STEP_X + overlapRepel * 56 + ambientRepel * 14;
  const laneRowGap = 8 + overlapRepel * 8 + cohesion * 5;
  const units = [];

  nodes.forEach((node, index) => {
    if (!visibility.visibleNodeIds.has(node.id)) return;
    const preparedNode = prepared.get(node.id);
    if (!preparedNode) return;
    const depth = treeIndentDepth(node.id, nodeGroupChains, groupById, groupDepth, nodeMetaById);
    const line = Number(node.source?.line || Number.MAX_SAFE_INTEGER);
    const height = isNodeCircleCollapsed?.(node.id) ? NODE_CIRCLE_D : preparedNode.h;
    units.push({
      id: node.id,
      depth,
      line,
      index,
      h: height,
      kind: node.kind,
      ...flowLaneScopeKeys(node.id, depth, nodeGroupChains, groupById, groupDepth),
    });
  });

  units.sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.index - right.index;
  });

  const laneCursorY = new Map();
  units.forEach((unit) => {
    const pos = positions.get(unit.id);
    if (!pos) return;
    const initialY = laneCursorY.get(unit.parentLaneKey) ?? FLOW_LANE_BASE_Y;
    const laneY = laneCursorY.get(unit.laneKey) ?? initialY;
    const y = laneY;
    const centerX = FLOW_LANE_BASE_X + unit.depth * laneStep + flowLaneKindOffset(unit.kind);
    pos.x = centerX - NODE_W / 2;
    pos.y = y;
    pos.h = unit.h;
    laneCursorY.set(unit.laneKey, y + unit.h + laneRowGap);
  });
}

function flowLaneKindOffset(kind) {
  if (kind === "decision") return 8;
  if (kind === "loop") return 16;
  if (kind === "error") return 12;
  return 0;
}

function flowLaneScopeKeys(nodeId, depth, nodeGroupChains, groupById, groupDepth) {
  if (depth <= 0) {
    const rootGroupId = flowLaneGroupAtDepth(nodeId, 0, nodeGroupChains, groupById, groupDepth);
    return {
      laneKey: rootGroupId ? `0:${rootGroupId}` : "root",
      parentLaneKey: "root",
    };
  }
  const ownerGroupId = flowLaneGroupAtDepth(nodeId, depth, nodeGroupChains, groupById, groupDepth);
  const parentGroupId = flowLaneGroupAtDepth(nodeId, depth - 1, nodeGroupChains, groupById, groupDepth);
  const parentLaneKey = parentGroupId ? `${depth - 1}:${parentGroupId}` : "root";
  return {
    laneKey: ownerGroupId ? `${depth}:${ownerGroupId}` : `${depth}:indent:${parentLaneKey}`,
    parentLaneKey,
  };
}

function flowLaneGroupAtDepth(nodeId, depth, nodeGroupChains, groupById, groupDepth) {
  const chain = nodeGroupChains.get(nodeId) || [];
  for (const groupId of chain) {
    if (treeGroupIndentDepth(groupId, groupById, groupDepth) === depth) return groupId;
  }
  return null;
}

function treeIndentDepth(nodeId, nodeGroupChains, groupById, groupDepth, nodeMetaById) {
  const chain = nodeGroupChains.get(nodeId) || [];
  let maxDepth = 0;
  chain.forEach((groupId) => {
    const group = groupById.get(groupId);
    if (!group) return;
    const baseDepth = group.kind === "function_body" ? 0 : 1;
    maxDepth = Math.max(maxDepth, (groupDepth.get(groupId) || 0) + baseDepth);
  });
  const meta = nodeMetaById?.get(nodeId) || {};
  const sourceDepth = Number.isFinite(Number(meta.indentLevel)) ? Math.max(0, Number(meta.indentLevel)) : 0;
  return Math.max(maxDepth, sourceDepth);
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

function buildFlowTransitionEdgeKey(edge) {
  return `edge:${edge.from}->${edge.to}::${String(edge.label || "")}`;
}