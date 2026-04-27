import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { cubicPt } from "../../shared/geometry.js";
import { moduleColor } from "../../shared/theme.js";

const NODE_W = 220;
const NODE_H = 28;
const NODE_PAD = 4;
const MOD_PAD_TOP = 32;
const MOD_PAD_BOTTOM = 12;
const MOD_PAD_X = 16;
const COL_GAP = 130;
const COL_TOP = 30;
const METHOD_INDENT = 18;
const MODULE_SUMMARY_W = 210;
const MODULE_SUMMARY_H = 56;
const NODE_CIRCLE_D = 36;
const MODULE_RANK_SEP = 200;
const MODULE_NODE_SEP = 84;
const CALL_GRAPH_LAYOUT_VERSION = 2;
const CALL_EDGE_RESOLVED_COLOR = "#7aa7ff";
const CALL_EDGE_UNCERTAIN_COLOR = "#ffb347";

const HANDLE_STYLE = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
};

let callRoot = null;
let callHost = null;
let callApi = null;
let lastViewport = null;
let callExecLayer = null;
let callExecGroup = null;

const callSelectionRef = { current: null };
const callHighlightStepRef = { current: null };
const callExpandAllRef = { current: null };
const callCollapseAllRef = { current: null };
const callEdgeMapRef = { current: {} };
const callEdgeRecordsRef = { current: [] };
const callExecTimelineRef = { current: [] };

function ensureCallExecLayer() {
  if (callExecGroup?.isConnected) return callExecGroup;
  const portal = callHost?.querySelector(".react-flow__viewport-portal");
  if (!portal) return null;
  const svgNs = "http://www.w3.org/2000/svg";
  const layer = document.createElementNS(svgNs, "svg");
  layer.setAttribute("width", "1");
  layer.setAttribute("height", "1");
  layer.setAttribute("overflow", "visible");
  layer.style.position = "absolute";
  layer.style.left = "0";
  layer.style.top = "0";
  layer.style.pointerEvents = "none";
  layer.style.overflow = "visible";

  const defs = document.createElementNS(svgNs, "defs");
  const filter = document.createElementNS(svgNs, "filter");
  filter.setAttribute("id", "codemap-callrf-glow-big");
  filter.setAttribute("x", "-200%");
  filter.setAttribute("y", "-200%");
  filter.setAttribute("width", "400%");
  filter.setAttribute("height", "400%");
  const blur = document.createElementNS(svgNs, "feGaussianBlur");
  blur.setAttribute("stdDeviation", "8");
  blur.setAttribute("result", "blur");
  const merge = document.createElementNS(svgNs, "feMerge");
  const mergeBlur = document.createElementNS(svgNs, "feMergeNode");
  mergeBlur.setAttribute("in", "blur");
  const mergeSource = document.createElementNS(svgNs, "feMergeNode");
  mergeSource.setAttribute("in", "SourceGraphic");
  merge.appendChild(mergeBlur);
  merge.appendChild(mergeSource);
  filter.appendChild(blur);
  filter.appendChild(merge);
  defs.appendChild(filter);
  layer.appendChild(defs);

  const group = document.createElementNS(svgNs, "g");
  layer.appendChild(group);
  portal.appendChild(layer);
  callExecLayer = layer;
  callExecGroup = group;
  return callExecGroup;
}

function clearCallExecDots() {
  if (!callExecGroup) return;
  while (callExecGroup.firstChild) callExecGroup.removeChild(callExecGroup.firstChild);
}

function disposeCallExecLayer() {
  if (callExecLayer?.parentElement) {
    callExecLayer.parentElement.removeChild(callExecLayer);
  }
  callExecLayer = null;
  callExecGroup = null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0, Math.min(1, value));
}

function cubicDerivative(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function moduleGroupId(mod) {
  return `module:${mod}::group`;
}

function moduleEndpointKey(mod) {
  return `module:${mod}`;
}

function classFrameId(groupId) {
  return `classframe:${groupId}`;
}

function isModuleEndpoint(endpointId) {
  return typeof endpointId === "string" && endpointId.startsWith("module:") && !endpointId.endsWith("::group");
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
    (methodsByClass.get(classNode.label) || []).forEach((methodNode) => {
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

function applyModuleDagreLayout(moduleOrder, modulePos, edges, nodeModuleLookup) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    align: "UL",
    ranksep: MODULE_RANK_SEP,
    nodesep: MODULE_NODE_SEP,
    marginx: 60,
    marginy: COL_TOP,
  });

  moduleOrder.forEach((mod) => {
    const box = modulePos.get(mod);
    if (!box) return;
    graph.setNode(mod, {
      width: Math.max(box.w, MODULE_SUMMARY_W),
      height: Math.max(box.h, MODULE_SUMMARY_H),
    });
  });

  const seen = new Set();
  edges.forEach((edge) => {
    const fromMod = nodeModuleLookup.get(edge.from);
    const toMod = nodeModuleLookup.get(edge.to);
    if (!fromMod || !toMod || fromMod === toMod || !modulePos.has(fromMod) || !modulePos.has(toMod)) return;
    const key = `${fromMod}->${toMod}`;
    if (seen.has(key)) return;
    seen.add(key);
    graph.setEdge(fromMod, toMod, { weight: 3, minlen: 1 });
  });

  for (let index = 1; index < moduleOrder.length; index++) {
    const left = moduleOrder[index - 1];
    const right = moduleOrder[index];
    const key = `${left}->${right}`;
    if (seen.has(key)) continue;
    graph.setEdge(left, right, { weight: 0.2, minlen: 1 });
  }

  dagre.layout(graph);

  moduleOrder.forEach((mod, index) => {
    const layout = graph.node(mod);
    const box = modulePos.get(mod);
    if (!box) return;
    if (layout) {
      box.x = layout.x - box.w / 2;
      box.y = Math.max(COL_TOP, layout.y - box.h / 2);
      return;
    }
    box.x = 60 + index * (box.w + COL_GAP);
    box.y = COL_TOP;
  });
}

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

function applyCallGraphForceLayout(moduleOrder, moduleNodes, nodePos, edges, forceOptions) {
  const overlapRepel = clamp01(forceOptions?.overlapRepel ?? 0.35);
  const linkAttract = clamp01(forceOptions?.linkAttract ?? 0.28);
  const ambientRepel = clamp01(forceOptions?.ambientRepel ?? 0.18);
  const cohesion = clamp01(forceOptions?.cohesion ?? 0.34);
  if (overlapRepel <= 0.001 && linkAttract <= 0.001 && ambientRepel <= 0.001 && cohesion <= 0.001) return;
  const anchors = new Map();
  nodePos.forEach((pos, nodeId) => anchors.set(nodeId, { x: pos.x, y: pos.y }));
  const neighbors = new Map();
  edges.forEach((edge) => {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
  });
  const passes = Math.round(4 + Math.max(overlapRepel, linkAttract, ambientRepel, cohesion) * 8);
  const minGapY = NODE_H + NODE_PAD + 4 + overlapRepel * 10 + ambientRepel * 8;
  const maxModuleShift = 26 + overlapRepel * 32 + ambientRepel * 26;
  const intraShift = 12 + overlapRepel * 18 + ambientRepel * 8;
  const attractRadiusY = NODE_H + 56 + linkAttract * 60;
  const ambientRadiusY = NODE_H + 30 + ambientRepel * 26;
  const targetGapY = NODE_H + NODE_PAD + 34 - cohesion * 18;

  for (let pass = 0; pass < passes; pass++) {
    for (const mod of moduleOrder) {
      const itemIds = (moduleNodes.get(mod) || []).map((item) => item.id).filter((nodeId) => nodePos.has(nodeId));
      itemIds.sort((left, right) => (nodePos.get(left).y - nodePos.get(right).y));
      for (let i = 1; i < itemIds.length; i++) {
        const prev = nodePos.get(itemIds[i - 1]);
        const curr = nodePos.get(itemIds[i]);
        const overlap = prev.y + minGapY - curr.y;
        if (overlap > 0) curr.y += overlap;
        const looseGap = curr.y - (prev.y + NODE_H);
        if (cohesion > 0.001 && looseGap > targetGapY) {
          curr.y -= (looseGap - targetGapY) * (0.18 + cohesion * 0.22);
        }
      }
      const moduleAnchorX = average(itemIds.map((nodeId) => anchors.get(nodeId)?.x || 0));
      itemIds.forEach((nodeId) => {
        const pos = nodePos.get(nodeId);
        const anchor = anchors.get(nodeId);
        pos.x = clamp(
          moduleAnchorX + (pos.x - moduleAnchorX) * (0.82 - cohesion * 0.14) + (anchor.x - moduleAnchorX) * (0.18 + cohesion * 0.18),
          moduleAnchorX - maxModuleShift,
          moduleAnchorX + maxModuleShift,
        );
        if (cohesion > 0.001) {
          pos.y += (anchor.y - pos.y) * (0.02 + cohesion * 0.05);
        }
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

function orderedLaneOffsets(count) {
  if (count <= 1) return [0];
  if (count === 2) return [-0.55, 0.55];
  if (count <= 4) return [0, -1.05, 1.05, 0.45];
  if (count <= 8) return [0, -1.22, 1.22, -0.45, 0.45, -0.82, 0.82, 0];
  return [0, -1.62, 1.62, -0.68, 0.68, -1.16, 1.16, -0.26, 0.26, -1.9, 1.9];
}

function placeOrderedSpread(items, nodePos, centerX, topY, options = {}) {
  if (!items.length) return topY;
  const visible = items.filter((item) => nodePos.has(item.id));
  if (!visible.length) return topY;
  const maxW = Math.max(...visible.map((item) => nodePos.get(item.id)?.w || NODE_CIRCLE_D));
  const maxH = Math.max(...visible.map((item) => nodePos.get(item.id)?.h || NODE_CIRCLE_D));
  const laneStep = options.laneStep ?? (maxW > NODE_CIRCLE_D * 2 ? 130 : 58);
  const rowGap = options.rowGap ?? Math.max(maxH + 18, 50);
  const offsets = orderedLaneOffsets(visible.length);
  let bottom = topY;
  visible.forEach((item, index) => {
    const pos = nodePos.get(item.id);
    if (!pos) return;
    const offset = offsets[index % offsets.length];
    const taper = visible.length > 8 ? Math.sin(((index + 1) / (visible.length + 1)) * Math.PI) : 1;
    pos.x = centerX + offset * laneStep * (0.72 + taper * 0.28) - pos.w / 2;
    pos.y = topY + index * rowGap;
    bottom = Math.max(bottom, pos.y + pos.h);
  });
  return bottom;
}

function applyBoxAwareInternalLayout(moduleOrder, moduleNodes, modulePos, classGroupByNode, classGroupMap, classCollapsed, nodePos, isNodeVisible) {
  const placed = new Set();
  for (const mod of moduleOrder) {
    const box = modulePos.get(mod);
    if (!box) continue;
    const items = moduleNodes.get(mod) || [];
    const centerX = box.x + box.w / 2;
    let cursorY = box.y + MOD_PAD_TOP + 6;
    let standalone = [];

    const flushStandalone = () => {
      if (!standalone.length) return;
      const bottom = placeOrderedSpread(standalone, nodePos, centerX, cursorY, { laneStep: 72, rowGap: 62 });
      cursorY = bottom + 26;
      standalone = [];
    };

    for (const item of items) {
      if (!isNodeVisible(item.id) || placed.has(item.id)) continue;
      const groupId = classGroupByNode.get(item.id);
      const group = groupId ? classGroupMap.get(groupId) : null;
      const expandedClassGroup = group && !classCollapsed.get(groupId);
      if (expandedClassGroup && item.id !== group.ownerId) continue;
      if (expandedClassGroup) {
        flushStandalone();
        const members = group.memberIds
          .map((memberId) => items.find((candidate) => candidate.id === memberId))
          .filter((member) => member && isNodeVisible(member.id));
        const classCenterX = centerX + (items.length > 8 ? 24 : 0);
        const bottom = placeOrderedSpread(members, nodePos, classCenterX, cursorY, { laneStep: 64, rowGap: 56 });
        members.forEach((member) => placed.add(member.id));
        cursorY = bottom + 34;
        continue;
      }
      standalone.push(item);
      placed.add(item.id);
    }
    flushStandalone();
  }
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

function dominantDirection(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { dx: dx >= 0 ? 1 : -1, dy: 0 };
  }
  return { dx: 0, dy: dy >= 0 ? 1 : -1 };
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

function createInitialState(graph, layoutSnapshot) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const savedNodes = layoutSnapshot?.nodes || {};
  const savedGroups = layoutSnapshot?.groups || {};
  const hasPersistedNodeCircleState = nodes.some((node) => typeof savedNodes[node.id]?.circleCollapsed === "boolean");
  const moduleCollapsed = new Map();
  const moduleNodes = new Map();
  const moduleOrder = [];
  nodes.forEach((node) => {
    const mod = node.module || "<unknown>";
    if (!moduleCollapsed.has(mod)) moduleCollapsed.set(mod, !!savedGroups[moduleGroupId(mod)]?.collapsed);
    if (!moduleNodes.has(mod)) {
      moduleNodes.set(mod, []);
      moduleOrder.push(mod);
    }
    moduleNodes.get(mod).push(node);
  });
  moduleOrder.forEach((mod) => moduleNodes.set(mod, orderModuleNodes(moduleNodes.get(mod))));
  const classGroups = buildClassGroups(moduleOrder, moduleNodes);
  const classCollapsed = new Map(classGroups.map((group) => [group.id, !!savedGroups[group.id]?.collapsed]));
  const nodeCircle = new Map(nodes.map((node) => [node.id, hasPersistedNodeCircleState ? !!savedNodes[node.id]?.circleCollapsed : true]));
  const nodePositions = new Map();
  if (layoutSnapshot?.layoutVersion === CALL_GRAPH_LAYOUT_VERSION) {
    Object.entries(savedNodes).forEach(([nodeId, saved]) => {
      if (typeof saved?.x === "number" && typeof saved?.y === "number") {
        nodePositions.set(nodeId, { x: saved.x, y: saved.y });
      }
    });
  }
  return {
    moduleCollapsed,
    classCollapsed,
    nodeCircle,
    nodePositions,
    selectedNodeId: null,
    highlightedStepIndex: -1,
  };
}

function captureLayout(viewState) {
  const snapshot = { layoutVersion: CALL_GRAPH_LAYOUT_VERSION, nodes: {}, groups: {} };
  viewState.nodePositions.forEach((pos, nodeId) => {
    snapshot.nodes[nodeId] = { x: pos.x, y: pos.y, circleCollapsed: !!viewState.nodeCircle.get(nodeId) };
  });
  viewState.nodeCircle.forEach((collapsed, nodeId) => {
    if (!snapshot.nodes[nodeId]) snapshot.nodes[nodeId] = { circleCollapsed: !!collapsed };
    else snapshot.nodes[nodeId].circleCollapsed = !!collapsed;
  });
  viewState.moduleCollapsed.forEach((collapsed, mod) => {
    snapshot.groups[moduleGroupId(mod)] = { collapsed: !!collapsed };
  });
  viewState.classCollapsed.forEach((collapsed, groupId) => {
    snapshot.groups[groupId] = { collapsed: !!collapsed };
  });
  return snapshot;
}

function deriveExecTimeline(graph, nodes = graph?.nodes || [], edges = graph?.edges || []) {
  if (graph?.metadata && Array.isArray(graph.metadata.execTimeline)) {
    return graph.metadata.execTimeline;
  }
  if (graph?.graphType !== "trace") return [];
  return edges
    .filter((edge) => edge.kind === "execution_step")
    .sort((left, right) => (parseInt(left.label, 10) || 0) - (parseInt(right.label, 10) || 0))
    .map((edge) => {
      const targetNode = nodes.find((node) => node.id === edge.to);
      return {
        edge: [edge.from, edge.to],
        label: targetNode ? (targetNode.label || targetNode.id) : edge.to,
        desc: targetNode?.metadata?.docSummary || "",
      };
    });
}

function buildScene(graph, viewState, uiState) {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).map((node) => ({ ...node }));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const isTrace = graph?.graphType === "trace";
  const forceOptions = {
    overlapRepel: clamp01(uiState?.repelStrength ?? 0.35),
    linkAttract: clamp01(uiState?.attractStrength ?? 0.28),
    ambientRepel: clamp01(uiState?.ambientRepelStrength ?? 0.18),
    cohesion: clamp01(uiState?.cohesionStrength ?? 0.34),
  };

  const moduleOrder = [];
  const moduleNodes = new Map();
  for (const node of nodes) {
    const mod = node.module || "<unknown>";
    if (!moduleNodes.has(mod)) {
      moduleNodes.set(mod, []);
      moduleOrder.push(mod);
    }
    moduleNodes.get(mod).push(node);
  }
  for (const [mod, items] of moduleNodes.entries()) moduleNodes.set(mod, orderModuleNodes(items));

  const classGroups = buildClassGroups(moduleOrder, moduleNodes);
  const classGroupMap = new Map(classGroups.map((group) => [group.id, group]));
  const classGroupByNode = new Map();
  classGroups.forEach((group) => group.memberIds.forEach((nodeId) => classGroupByNode.set(nodeId, group.id)));
  const nodeModuleLookup = new Map(nodes.map((node) => [node.id, node.module || "<unknown>"]));

  const nodeToModule = {};
  function isModuleCollapsed(mod) { return !!viewState.moduleCollapsed.get(mod); }
  function isNodeCircleCollapsed(nodeId) { return !!viewState.nodeCircle.get(nodeId); }
  function isNodeVisible(nodeId) {
    const mod = nodeToModule[nodeId];
    if (mod && isModuleCollapsed(mod)) return false;
    const groupId = classGroupByNode.get(nodeId);
    if (!groupId) return true;
    const group = classGroupMap.get(groupId);
    if (!group) return true;
    return !viewState.classCollapsed.get(groupId) || nodeId === group.ownerId;
  }
  function resolveVisibleEndpoint(nodeId) {
    const mod = nodeToModule[nodeId];
    if (mod && isModuleCollapsed(mod)) return moduleEndpointKey(mod);
    const groupId = classGroupByNode.get(nodeId);
    if (!groupId) return nodeId;
    const group = classGroupMap.get(groupId);
    if (!group) return nodeId;
    return viewState.classCollapsed.get(groupId) ? group.ownerId : nodeId;
  }

  const modulePos = new Map();
  const moduleMembers = new Map();
  const nodePos = new Map();
  moduleOrder.forEach((mod) => {
    const items = moduleNodes.get(mod) || [];
    const visibleCount = Math.max(1, items.filter((item) => isNodeVisible(item.id)).length);
    const collapsed = isModuleCollapsed(mod);
    modulePos.set(mod, {
      x: 0,
      y: 0,
      w: collapsed ? MODULE_SUMMARY_W : NODE_W + MOD_PAD_X * 2,
      h: collapsed ? MODULE_SUMMARY_H + 16 : MOD_PAD_TOP + visibleCount * (NODE_H + NODE_PAD) + MOD_PAD_BOTTOM,
      color: moduleColor(mod),
    });
    moduleMembers.set(mod, items.map((item) => item.id));
  });

  applyModuleDagreLayout(moduleOrder, modulePos, edges, nodeModuleLookup);

  moduleOrder.forEach((mod) => {
    const box = modulePos.get(mod);
    const items = moduleNodes.get(mod) || [];
    if (!box) return;
    items.forEach((item, index) => {
      nodeToModule[item.id] = mod;
      const indent = item.kind === "method" && item.className ? METHOD_INDENT : 0;
      nodePos.set(item.id, {
        x: box.x + MOD_PAD_X + indent,
        y: box.y + MOD_PAD_TOP + index * (NODE_H + NODE_PAD),
        w: NODE_W - indent,
        h: NODE_H,
      });
    });
  });

  function expandedNodeSize(node) {
    const indent = node.kind === "method" && node.className ? METHOD_INDENT : 0;
    return { w: NODE_W - indent, h: NODE_H };
  }

  function applyNodeShapeMetrics(nodeId, preserveCenter = false) {
    const pos = nodePos.get(nodeId);
    const node = nodesById.get(nodeId);
    if (!pos || !node) return;
    const size = isNodeCircleCollapsed(nodeId) ? { w: NODE_CIRCLE_D, h: NODE_CIRCLE_D } : expandedNodeSize(node);
    if (preserveCenter) {
      const centerX = pos.x + pos.w / 2;
      const centerY = pos.y + pos.h / 2;
      pos.x = centerX - size.w / 2;
      pos.y = centerY - size.h / 2;
    }
    pos.w = size.w;
    pos.h = size.h;
  }

  nodes.forEach((node) => applyNodeShapeMetrics(node.id));
  const fixedNodeIds = new Set(viewState.nodePositions.keys());

  function computeModuleBounds(mod) {
    if (isModuleCollapsed(mod)) return computeCollapsedModuleBounds(moduleMembers.get(mod) || [], nodePos);
    return computeModuleBoundsForItems((moduleMembers.get(mod) || []).filter((nodeId) => isNodeVisible(nodeId)), nodePos);
  }

  function refreshModuleBounds() {
    moduleOrder.forEach((mod) => {
      const bounds = computeModuleBounds(mod);
      const box = modulePos.get(mod);
      if (!bounds || !box) return;
      box.x = bounds.x;
      box.y = bounds.y;
      box.w = bounds.w;
      box.h = bounds.h;
    });
  }

  applyBoxAwareInternalLayout(
    moduleOrder,
    moduleNodes,
    modulePos,
    classGroupByNode,
    classGroupMap,
    viewState.classCollapsed,
    nodePos,
    isNodeVisible,
  );
  refreshModuleBounds();
  const previousModuleOrigins = new Map(moduleOrder.map((mod) => {
    const box = modulePos.get(mod);
    return [mod, box ? { x: box.x, y: box.y } : { x: 0, y: 0 }];
  }));
  applyModuleDagreLayout(moduleOrder, modulePos, edges, nodeModuleLookup);
  moduleOrder.forEach((mod) => {
    const before = previousModuleOrigins.get(mod);
    const box = modulePos.get(mod);
    if (!before || !box) return;
    const dx = box.x - before.x;
    const dy = box.y - before.y;
    (moduleMembers.get(mod) || []).forEach((nodeId) => {
      const pos = nodePos.get(nodeId);
      if (!pos) return;
      pos.x += dx;
      pos.y += dy;
    });
  });
  viewState.nodePositions.forEach((saved, nodeId) => {
    const pos = nodePos.get(nodeId);
    if (!pos) return;
    pos.x = saved.x;
    pos.y = saved.y;
  });
  refreshModuleBounds();

  const collisionAnchors = new Map(Array.from(nodePos.entries()).map(([nodeId, pos]) => [nodeId, { x: pos.x, y: pos.y }]));

  function visibleNodeIds() {
    return nodes.map((node) => node.id).filter((nodeId) => nodePos.has(nodeId) && isNodeVisible(nodeId));
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

  function resolveSeparation(fixedIds = new Set()) {
    const ids = visibleNodeIds();
    if (ids.length < 2) return;
    const moduleIndex = new Map(moduleOrder.map((mod, index) => [mod, index]));
    for (let pass = 0; pass < 4; pass++) {
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
            applyVerticalSeparation(leftId, rightId, direction, overlapY / 2 + 6, leftFixed, rightFixed);
          } else {
            const direction = Math.sign((left.x + left.w / 2) - (right.x + right.w / 2))
              || Math.sign((moduleIndex.get(nodeToModule[leftId]) || 0) - (moduleIndex.get(nodeToModule[rightId]) || 0))
              || (i % 2 === 0 ? -1 : 1);
            applyHorizontalSeparation(leftId, rightId, direction, overlapX / 2 + 10, leftFixed, rightFixed);
            if (overlapY > 10) {
              applyVerticalSeparation(leftId, rightId, i % 2 === 0 ? -1 : 1, Math.min(14, overlapY / 3), leftFixed, rightFixed);
            }
          }
        }
      }
    }
  }

  resolveSeparation(fixedNodeIds);
  refreshModuleBounds();

  refreshModuleBounds();

  const connCount = {};
  nodes.forEach((node) => { connCount[node.id] = { out: 0, in_: 0 }; });
  edges.forEach((edge) => {
    if (connCount[edge.from]) connCount[edge.from].out += 1;
    if (connCount[edge.to]) connCount[edge.to].in_ += 1;
  });

  function computeClassFrameBounds(group) {
    return viewState.classCollapsed.get(group.id)
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

  const edgeRecords = [];
  const edgeMap = {};
  const dedupedEdgeIndex = new Map();
  edges.forEach((edge) => {
    const srcId = resolveVisibleEndpoint(edge.from);
    const tgtId = resolveVisibleEndpoint(edge.to);
    if (!srcId || !tgtId || srcId === tgtId) return;
    const dedupeKey = `${srcId}->${tgtId}::${edge.label || ""}::${edge.resolution || ""}`;
    if (dedupedEdgeIndex.has(dedupeKey)) {
      edgeMap[edge.from + "->" + edge.to] = dedupedEdgeIndex.get(dedupeKey);
      return;
    }
    const sp = endpointRect(srcId);
    const tp = endpointRect(tgtId);
    if (!sp || !tp) return;
    const fromMod = endpointModule(srcId);
    const toMod = endpointModule(tgtId);
    const sameMod = fromMod && fromMod === toMod;
    const idx = edgeRecords.length;
    edgeMap[edge.from + "->" + edge.to] = idx;
    dedupedEdgeIndex.set(dedupeKey, idx);
    edgeRecords.push({
      id: `edge:${dedupeKey}`,
      key: `${srcId}->${tgtId}`,
      src: srcId,
      tgt: tgtId,
      label: edge.label || "",
      resolution: edge.resolution || "",
      color: edge.resolution === "resolved" || !edge.resolution
        ? CALL_EDGE_RESOLVED_COLOR
        : CALL_EDGE_UNCERTAIN_COLOR,
      fromMod,
      toMod,
      sameMod,
      ambientCount: 3,
    });
  });
  assignEdgeSpread(edgeRecords);
  edgeRecords.forEach((edge) => {
    const sp = endpointRect(edge.src);
    const tp = endpointRect(edge.tgt);
    if (!sp || !tp) return;
    const sourceLane = (edge.sourceLaneOffset || 0) + (edge.bundleLaneOffset || 0);
    const targetLane = (edge.targetLaneOffset || 0) - (edge.bundleLaneOffset || 0);
    const sx = sp.x + sp.w / 2;
    const sy = sp.y + sp.h / 2;
    const tx = tp.x + tp.w / 2;
    const ty = tp.y + tp.h / 2;
    const dx = tx - sx;
    const dy = ty - sy;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / distance;
    const ny = dx / distance;
    const sourceDir = dominantDirection(dx, dy);
    const targetDir = dominantDirection(-dx, -dy);
    const bend = Math.max(42, Math.min(edge.sameMod ? 176 : 152, distance * (edge.sameMod ? 0.55 : 0.4)));
    const sway = edge.sameMod
      ? sourceLane * 0.55 + (Math.abs(dy) < 40 ? 18 * (sx <= tx ? -1 : 1) : 0)
      : sourceLane;
    const c1x = sx + sourceDir.dx * bend + nx * sway;
    const c1y = sy + sourceDir.dy * bend + ny * sway;
    const c2x = tx + targetDir.dx * bend + nx * sway;
    const c2y = ty + targetDir.dy * bend + ny * sway;
    const mid = cubicPt(sx, sy, c1x, c1y, c2x, c2y, tx, ty, 0.5);
    const tangentX = cubicDerivative(sx, c1x, c2x, tx, 0.5);
    const tangentY = cubicDerivative(sy, c1y, c2y, ty, 0.5);
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    edge.sx = sx;
    edge.sy = sy;
    edge.c1x = c1x;
    edge.c1y = c1y;
    edge.c2x = c2x;
    edge.c2y = c2y;
    edge.tx = tx;
    edge.ty = ty;
    edge.path = `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;
    edge.labelX = mid.x + nx * 8;
    edge.labelY = mid.y + ny * 8 - 4;
    edge.arrowX = mid.x;
    edge.arrowY = mid.y;
    edge.arrowUx = tangentX / tangentLength;
    edge.arrowUy = tangentY / tangentLength;
  });

  let selectedNodeIds = null;
  let selectedEdgeIndexes = null;
  let highlightedEdgeKey = null;
  const baseTimeline = deriveExecTimeline(graph, nodes, edges);
  if (viewState.highlightedStepIndex >= 0) {
    const step = baseTimeline[viewState.highlightedStepIndex];
    if (step?.edge) {
      const edgeIdx = edgeMap[step.edge[0] + "->" + step.edge[1]];
      if (typeof edgeIdx === "number") {
        highlightedEdgeKey = edgeRecords[edgeIdx]?.key || null;
      }
    }
  }
  if (highlightedEdgeKey) {
    selectedNodeIds = new Set();
    selectedEdgeIndexes = new Set();
    edgeRecords.forEach((edge, index) => {
      if (edge.key === highlightedEdgeKey) {
        selectedNodeIds.add(edge.src);
        selectedNodeIds.add(edge.tgt);
        selectedEdgeIndexes.add(index);
      }
    });
  } else if (viewState.selectedNodeId) {
    selectedNodeIds = new Set([viewState.selectedNodeId]);
    selectedEdgeIndexes = new Set();
    edgeRecords.forEach((edge, index) => {
      if (edge.src === viewState.selectedNodeId || edge.tgt === viewState.selectedNodeId) {
        selectedNodeIds.add(edge.src);
        selectedNodeIds.add(edge.tgt);
        selectedEdgeIndexes.add(index);
      }
    });
  }
  const highlightedModules = new Set();
  if (selectedNodeIds) {
    selectedNodeIds.forEach((nodeId) => {
      const mod = endpointModule(nodeId);
      if (mod) highlightedModules.add(mod);
    });
  }

  const rfNodes = [];
  const classFrameBoundsById = new Map();
  moduleOrder.forEach((mod) => {
    const box = modulePos.get(mod);
    if (!box) return;
    rfNodes.push({
      id: moduleEndpointKey(mod),
      type: "codemapCallModuleNode",
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      data: {
        width: box.w,
        height: box.h,
        color: moduleColor(mod),
        label: mod,
        moduleId: mod,
        memberCount: (moduleMembers.get(mod) || []).length,
        collapsed: isModuleCollapsed(mod),
        dimmed: selectedNodeIds ? !highlightedModules.has(mod) : false,
        anchorX: box.x,
        anchorY: box.y,
      },
      style: { width: `${box.w}px`, height: `${box.h}px` },
      draggable: true,
      selectable: false,
      connectable: false,
      zIndex: 1,
    });
  });
  classGroups.forEach((group) => {
    if (isModuleCollapsed(group.module)) return;
    const bounds = computeClassFrameBounds(group);
    if (!bounds) return;
    classFrameBoundsById.set(group.id, bounds);
    rfNodes.push({
      id: classFrameId(group.id),
      type: "codemapCallClassFrameNode",
      position: { x: bounds.x, y: bounds.y },
      width: bounds.w,
      height: bounds.h,
      data: {
        width: bounds.w,
        height: bounds.h,
        color: moduleColor(group.module || ""),
        groupId: group.id,
        memberIds: group.memberIds,
        collapsed: !!viewState.classCollapsed.get(group.id),
        dimmed: selectedNodeIds ? !group.memberIds.some((memberId) => selectedNodeIds.has(memberId)) : false,
        anchorX: bounds.x,
        anchorY: bounds.y,
      },
      style: { width: `${bounds.w}px`, height: `${bounds.h}px` },
      draggable: true,
      selectable: false,
      connectable: false,
      zIndex: 5,
    });
  });

  const nodeRect = new Map();
  nodes.forEach((node) => {
    if (!isNodeVisible(node.id)) return;
    const pos = nodePos.get(node.id);
    if (!pos) return;
    nodeRect.set(node.id, { ...pos, color: moduleColor(node.module || "") });
    rfNodes.push({
      id: node.id,
      type: "codemapCallSymbolNode",
      position: { x: pos.x, y: pos.y },
      width: pos.w,
      height: pos.h,
      data: {
        node,
        width: pos.w,
        height: pos.h,
        color: moduleColor(node.module || ""),
        circleCollapsed: isNodeCircleCollapsed(node.id),
        isRoot: (graph.rootNodeIds || []).includes(node.id),
        rightText: node.metadata?.isAsync ? "async" : (node.source?.line ? `:${node.source.line}` : ""),
        connOut: connCount[node.id]?.out || 0,
        connIn: connCount[node.id]?.in_ || 0,
        selected: selectedNodeIds ? selectedNodeIds.has(node.id) : false,
        dimmed: selectedNodeIds ? !selectedNodeIds.has(node.id) : false,
      },
      style: { width: `${pos.w}px`, height: `${pos.h}px` },
      draggable: true,
      selectable: false,
      connectable: false,
      zIndex: 20,
    });
  });

  const rfEdges = edgeRecords.map((edge, index) => {
    const highlighted = selectedEdgeIndexes ? selectedEdgeIndexes.has(index) : false;
    const dimmed = selectedEdgeIndexes ? !highlighted : false;
    const alpha = highlighted
      ? "b8"
      : dimmed
        ? "0d"
        : edge.resolution === "unresolved"
          ? "56"
          : edge.resolution === "likely"
            ? "70"
            : "84";
    return {
      id: edge.id,
      source: edge.src,
      target: edge.tgt,
      sourceHandle: "center-s",
      targetHandle: "center-t",
      type: "codemapCallEdge",
      data: {
        ...edge,
        highlighted,
        dimmed,
      },
      style: {
        stroke: edge.color + alpha,
        strokeWidth: highlighted ? 2.8 : dimmed ? 0.8 : 1.8,
      },
      selectable: false,
    };
  });

  return {
    rfNodes,
    rfEdges,
    edgeRecords,
    nodeRect,
    nodes,
    edgeMap,
    execTimeline: baseTimeline,
    moduleMembers,
    nodePos,
    classGroups,
    classFrameBoundsById,
  };
}

function CallSymbolNode({ id, data }) {
  const { node, color, circleCollapsed, isRoot, rightText, selected, dimmed, width, height } = data;
  const opacity = dimmed ? 0.12 : 1;
  const stroke = selected ? color : isRoot ? color : color + (circleCollapsed ? "55" : "30");
  const strokeWidth = selected || isRoot ? 2 : circleCollapsed ? 1.2 : 1;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Handle, { id: "center-s", type: "source", position: Position.Top, style: HANDLE_STYLE, isConnectable: false }),
    React.createElement(Handle, { id: "center-t", type: "target", position: Position.Top, style: HANDLE_STYLE, isConnectable: false }),
    React.createElement("div", {
      className: "codemap-callrf-node",
      "data-id": id,
      style: {
        position: "relative",
        width: `${width}px`,
        height: `${height}px`,
        opacity,
        cursor: circleCollapsed ? "pointer" : "default",
        userSelect: "none",
      },
    },
      circleCollapsed
        ? React.createElement("div", {
            style: {
              width: `${width}px`,
              height: `${height}px`,
              borderRadius: "50%",
              background: (node.kind === "class" ? color + "1a" : color + "12"),
              border: `${strokeWidth}px solid ${stroke}`,
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: badgeColor(node, color),
              fontFamily: "Consolas, monospace",
              fontSize: "12px",
              fontWeight: 700,
            },
          }, kindLetter(node))
        : React.createElement("div", {
            style: {
              width: `${width}px`,
              height: `${height}px`,
              borderRadius: "5px",
              background: node.kind === "class" ? color + "12" : "#111420",
              border: `${strokeWidth}px solid ${stroke}`,
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              gap: "6px",
              fontFamily: "Consolas, monospace",
            },
          },
            React.createElement("span", {
              style: {
                color: badgeColor(node, color),
                fontSize: "9px",
                fontWeight: 700,
                minWidth: "9px",
              },
            }, kindLetter(node)),
            React.createElement("span", {
              style: {
                color: node.kind === "class" ? color + "dd" : node.kind === "method" ? "#9aa5ce" : "#8890aa",
                fontSize: "10px",
                fontWeight: node.kind === "class" ? 600 : 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              },
            }, node.label || node.id),
            rightText && React.createElement("span", {
              style: { color: "#222640", fontSize: "8px", whiteSpace: "nowrap" },
            }, rightText),
          ),
      React.createElement("button", {
        title: circleCollapsed ? `Expand ${node.label || node.id}` : `Collapse ${node.label || node.id}`,
        style: {
          position: "absolute",
          top: circleCollapsed ? "1px" : "4px",
          right: circleCollapsed ? "1px" : "auto",
          left: circleCollapsed ? "auto" : "4px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          border: `1px solid ${color}55`,
          background: "#0f1321",
          color: color + "e0",
          fontSize: "9px",
          fontWeight: 700,
          lineHeight: 1,
          padding: 0,
          cursor: "pointer",
        },
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          data.onToggleCircle?.(id);
        },
      }, circleCollapsed ? "+" : "-"),
    ),
  );
}

function CallModuleNode({ data }) {
  const { width, height, color, label, moduleId, memberCount, collapsed, dimmed } = data;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Handle, { id: "center-s", type: "source", position: Position.Top, style: HANDLE_STYLE, isConnectable: false }),
    React.createElement(Handle, { id: "center-t", type: "target", position: Position.Top, style: HANDLE_STYLE, isConnectable: false }),
    React.createElement("div", {
      style: {
        position: "relative",
        width: `${width}px`,
        height: `${height}px`,
        opacity: dimmed ? 0.06 : collapsed ? 0.8 : 1,
        borderRadius: "12px",
        border: `1px solid ${collapsed ? color + "48" : color + "18"}`,
        borderStyle: collapsed ? "dashed" : "solid",
        background: collapsed ? color + "10" : color + "08",
        boxSizing: "border-box",
        fontFamily: "Consolas, monospace",
        userSelect: "none",
      },
    },
      React.createElement("div", {
        style: {
          position: "absolute",
          left: "28px",
          top: collapsed ? "16px" : "12px",
          right: "8px",
          color: collapsed ? color + "d8" : color + "70",
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.5px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
      }, label),
      collapsed && React.createElement("div", {
        style: {
          position: "absolute",
          left: "30px",
          top: "33px",
          color: color + "8a",
          fontSize: "8.5px",
          letterSpacing: "0.25px",
        },
      }, `${memberCount} symbols`),
      React.createElement("button", {
        title: collapsed ? `Expand ${label}` : `Collapse ${label}`,
        style: {
          position: "absolute",
          left: "4px",
          top: "4px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          border: `1px solid ${color}70`,
          background: color + "16",
          color: color + "ee",
          fontSize: "10px",
          fontWeight: 700,
          lineHeight: 1,
          padding: 0,
          cursor: "pointer",
        },
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          data.onToggleModule?.(moduleId);
        },
      }, collapsed ? "+" : "-"),
    ),
  );
}

function CallClassFrameNode({ data }) {
  const { width, height, color, collapsed, dimmed, groupId } = data;
  return React.createElement("div", {
    style: {
      position: "relative",
      width: `${width}px`,
      height: `${height}px`,
      opacity: dimmed ? 0.05 : 1,
      borderRadius: "10px",
      border: `1px dashed ${color + "24"}`,
      background: color + "05",
      boxSizing: "border-box",
      userSelect: "none",
    },
  },
    React.createElement("button", {
      title: collapsed ? "Expand class group" : "Collapse class group",
      style: {
        position: "absolute",
        left: "4px",
        top: "4px",
        width: "14px",
        height: "14px",
        borderRadius: "50%",
        border: `1px solid ${color}70`,
        background: color + "16",
        color: color + "ee",
        fontSize: "10px",
        fontWeight: 700,
        lineHeight: 1,
        padding: 0,
        cursor: "pointer",
      },
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onToggleClass?.(groupId);
      },
    }, collapsed ? "+" : "-"),
  );
}

function CallGraphEdge({ id, style, data }) {
  const color = data?.color || "#7aa2f7";
  const particleCount = Math.max(3, data?.ambientCount || 0);
  const particleOpacity = data.dimmed ? 0 : data.highlighted ? 0.82 : 0.54;
  const s = 5;
  const arrowUx = data?.arrowUx || 1;
  const arrowUy = data?.arrowUy || 0;
  const px = -arrowUy;
  const py = arrowUx;
  const tipX = data.arrowX + s * arrowUx;
  const tipY = data.arrowY + s * arrowUy;
  const base1X = data.arrowX - s * 0.7 * arrowUx + s * 0.55 * px;
  const base1Y = data.arrowY - s * 0.7 * arrowUy + s * 0.55 * py;
  const base2X = data.arrowX - s * 0.7 * arrowUx - s * 0.55 * px;
  const base2Y = data.arrowY - s * 0.7 * arrowUy - s * 0.55 * py;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(BaseEdge, {
      id,
      path: data.path,
      style,
    }),
    data.label && React.createElement("text", {
      x: data.labelX,
      y: data.labelY,
      textAnchor: "middle",
      fill: color + (data.highlighted ? "9c" : "62"),
      fontSize: 9,
      fontFamily: "Consolas, monospace",
      pointerEvents: "none",
    }, data.label),
    React.createElement("polygon", {
      points: `${tipX},${tipY} ${base1X},${base1Y} ${base2X},${base2Y}`,
      fill: color + (data.dimmed ? "10" : data.highlighted ? "92" : "58"),
      pointerEvents: "none",
    }),
    ...Array.from({ length: particleCount }).map((_, index) => React.createElement("g", {
      key: `${id}:amb:${index}`,
      opacity: particleOpacity,
      pointerEvents: "none",
    },
      React.createElement("circle", {
        r: 3.1,
        fill: color,
        opacity: data.highlighted ? 0.12 : 0.08,
      }),
      React.createElement("circle", {
        r: 1.9,
        fill: "#eef3ff",
        stroke: color + (data.highlighted ? "b8" : "8a"),
        strokeWidth: 0.82,
        opacity: data.highlighted ? 0.8 : 0.62,
      }),
      React.createElement("animateMotion", {
        dur: `${13.4 + (index % 3) * 0.95}s`,
        begin: `${index * 1.02}s`,
        repeatCount: "indefinite",
        path: data.path,
      }),
    )),
  );
}

function CaptureApi() {
  const rf = useReactFlow();
  useEffect(() => {
    callApi = rf;
    return () => { if (callApi === rf) callApi = null; };
  }, [rf]);
  return null;
}

function FitViewOnMount({ preserveView }) {
  const rf = useReactFlow();
  useEffect(() => {
    if (preserveView && lastViewport) {
      rf.setViewport(lastViewport, { duration: 0 });
      return;
    }
    rf.fitView({ duration: 280, padding: 0.18 });
  }, [rf, preserveView]);
  return null;
}

function CallGraphReact({ graph, callbacks, preserveView, layoutSnapshot, uiState }) {
  const initialState = useMemo(() => createInitialState(graph, layoutSnapshot), [graph, layoutSnapshot]);
  const [viewState, setViewState] = useState(initialState);
  useEffect(() => {
    setViewState(initialState);
  }, [initialState]);

  const updateState = useCallback((updater, shouldPersist = true) => {
    setViewState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (shouldPersist) callbacks.onLayoutChanged?.(captureLayout(next));
      return next;
    });
  }, [callbacks]);

  const toggleModule = useCallback((mod) => {
    updateState((prev) => {
      const next = { ...prev, moduleCollapsed: new Map(prev.moduleCollapsed), highlightedStepIndex: -1 };
      next.moduleCollapsed.set(mod, !next.moduleCollapsed.get(mod));
      return next;
    });
  }, [updateState]);

  const toggleClass = useCallback((groupId) => {
    updateState((prev) => {
      const next = { ...prev, classCollapsed: new Map(prev.classCollapsed), highlightedStepIndex: -1 };
      next.classCollapsed.set(groupId, !next.classCollapsed.get(groupId));
      return next;
    });
  }, [updateState]);

  const toggleNodeCircle = useCallback((nodeId) => {
    updateState((prev) => {
      const next = { ...prev, nodeCircle: new Map(prev.nodeCircle), highlightedStepIndex: -1 };
      next.nodeCircle.set(nodeId, !next.nodeCircle.get(nodeId));
      return next;
    });
  }, [updateState]);

  const scene = useMemo(() => buildScene(graph, viewState, uiState), [graph, viewState, uiState]);
  callEdgeMapRef.current = scene.edgeMap;
  callEdgeRecordsRef.current = scene.edgeRecords;
  callExecTimelineRef.current = scene.execTimeline;
  const suppressPointerClicksUntilRef = useRef(0);
  const activeNodeDragRef = useRef({ nodeId: null, moved: false, anchorX: 0, anchorY: 0, memberPositions: null, framePositions: null });

  const rfNodes = useMemo(() => scene.rfNodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onToggleModule: toggleModule,
      onToggleClass: toggleClass,
      onToggleCircle: toggleNodeCircle,
    },
  })), [scene.rfNodes, toggleClass, toggleModule, toggleNodeCircle]);

  const [nodes, setNodes] = useNodesState(rfNodes);
  const [edges, setEdges] = useEdgesState(scene.rfEdges);
  useEffect(() => { setNodes(rfNodes); }, [rfNodes, setNodes]);
  useEffect(() => { setEdges(scene.rfEdges); }, [scene.rfEdges, setEdges]);

  const onNodesChange = useCallback(
    (changes) => setNodes((curr) => applyNodeChanges(changes, curr)),
    [setNodes],
  );

  useEffect(() => {
    callSelectionRef.current = () => setViewState((prev) => ({ ...prev, selectedNodeId: null, highlightedStepIndex: -1 }));
    callHighlightStepRef.current = (stepIdx) => setViewState((prev) => ({ ...prev, selectedNodeId: null, highlightedStepIndex: stepIdx }));
    callExpandAllRef.current = () => updateState((prev) => ({
      ...prev,
      moduleCollapsed: new Map(Array.from(prev.moduleCollapsed.keys()).map((mod) => [mod, false])),
      classCollapsed: new Map(Array.from(prev.classCollapsed.keys()).map((groupId) => [groupId, false])),
      nodeCircle: new Map(Array.from(prev.nodeCircle.keys()).map((nodeId) => [nodeId, false])),
      highlightedStepIndex: -1,
    }));
    callCollapseAllRef.current = () => updateState((prev) => ({
      ...prev,
      moduleCollapsed: new Map(Array.from(prev.moduleCollapsed.keys()).map((mod) => [mod, false])),
      classCollapsed: new Map(Array.from(prev.classCollapsed.keys()).map((groupId) => [groupId, false])),
      nodeCircle: new Map(Array.from(prev.nodeCircle.keys()).map((nodeId) => [nodeId, true])),
      highlightedStepIndex: -1,
    }));
    return () => {
      callSelectionRef.current = null;
      callHighlightStepRef.current = null;
      callExpandAllRef.current = null;
      callCollapseAllRef.current = null;
    };
  }, [updateState]);

  const onNodeClick = useCallback((_event, node) => {
    if (node.type !== "codemapCallSymbolNode") return;
    if (performance.now() < suppressPointerClicksUntilRef.current) return;
    if (node.data?.circleCollapsed) {
      toggleNodeCircle(node.id);
      return;
    }
    setViewState((prev) => ({
      ...prev,
      selectedNodeId: prev.selectedNodeId === node.id ? null : node.id,
      highlightedStepIndex: -1,
    }));
    callbacks.onNodeClick?.({ id: node.id, source: node.data?.node?.source });
  }, [callbacks, toggleNodeCircle]);

  const onNodeDoubleClick = useCallback((_event, node) => {
    if (node.type !== "codemapCallSymbolNode") return;
    if (performance.now() < suppressPointerClicksUntilRef.current) return;
    if (node.data?.circleCollapsed) {
      toggleNodeCircle(node.id);
      return;
    }
    callbacks.onNodeDblClick?.({ id: node.id, source: node.data?.node?.source });
  }, [callbacks, toggleNodeCircle]);

  const onNodeDragStart = useCallback((_event, node) => {
    const nextMeta = {
      nodeId: node.id,
      moved: false,
      anchorX: node.position.x,
      anchorY: node.position.y,
      memberPositions: null,
      framePositions: null,
    };
    if (node.type === "codemapCallModuleNode") {
      const memberPositions = new Map();
      (scene.moduleMembers.get(node.data?.moduleId) || []).forEach((memberId) => {
        const pos = scene.nodePos.get(memberId);
        if (!pos) return;
        memberPositions.set(memberId, { x: pos.x, y: pos.y });
      });
      const framePositions = new Map();
      scene.classGroups.forEach((group) => {
        if (group.module !== node.data?.moduleId) return;
        const bounds = scene.classFrameBoundsById.get(group.id);
        if (!bounds) return;
        framePositions.set(classFrameId(group.id), { x: bounds.x, y: bounds.y });
      });
      nextMeta.memberPositions = memberPositions;
      nextMeta.framePositions = framePositions;
    } else if (node.type === "codemapCallClassFrameNode") {
      const memberPositions = new Map();
      (node.data?.memberIds || []).forEach((memberId) => {
        const pos = scene.nodePos.get(memberId);
        if (!pos) return;
        memberPositions.set(memberId, { x: pos.x, y: pos.y });
      });
      nextMeta.memberPositions = memberPositions;
      nextMeta.framePositions = new Map();
    }
    activeNodeDragRef.current = nextMeta;
    callbacks.hideTooltip?.();
  }, [callbacks, scene]);

  const onNodeDrag = useCallback((_event, node) => {
    if (activeNodeDragRef.current.nodeId === node.id) {
      activeNodeDragRef.current.moved = true;
      const memberPositions = activeNodeDragRef.current.memberPositions;
      const framePositions = activeNodeDragRef.current.framePositions;
      if (memberPositions || framePositions) {
        const dx = node.position.x - activeNodeDragRef.current.anchorX;
        const dy = node.position.y - activeNodeDragRef.current.anchorY;
        setNodes((prevNodes) => prevNodes.map((candidate) => {
          const memberPos = memberPositions?.get(candidate.id);
          if (memberPos) {
            return { ...candidate, position: { x: memberPos.x + dx, y: memberPos.y + dy } };
          }
          if (candidate.id !== node.id) {
            const framePos = framePositions?.get(candidate.id);
            if (framePos) {
              return { ...candidate, position: { x: framePos.x + dx, y: framePos.y + dy } };
            }
          }
          return candidate;
        }));
      }
    }
  }, [setNodes]);

  const onNodeDragStop = useCallback((_event, node) => {
    const dragMeta = activeNodeDragRef.current;
    if (dragMeta.nodeId === node.id && dragMeta.moved) {
      suppressPointerClicksUntilRef.current = performance.now() + 250;
    }
    activeNodeDragRef.current = { nodeId: null, moved: false, anchorX: 0, anchorY: 0, memberPositions: null, framePositions: null };
    if (node.type === "codemapCallSymbolNode") {
      updateState((prev) => {
        const next = { ...prev, nodePositions: new Map(prev.nodePositions), highlightedStepIndex: -1 };
        next.nodePositions.set(node.id, { x: node.position.x, y: node.position.y });
        return next;
      });
      return;
    }
    if (node.type === "codemapCallModuleNode") {
      const memberPositions = dragMeta.memberPositions || new Map();
      const dx = node.position.x - dragMeta.anchorX;
      const dy = node.position.y - dragMeta.anchorY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      updateState((prev) => {
        const next = { ...prev, nodePositions: new Map(prev.nodePositions), highlightedStepIndex: -1 };
        memberPositions.forEach((pos, memberId) => {
          next.nodePositions.set(memberId, { x: pos.x + dx, y: pos.y + dy });
        });
        return next;
      });
      return;
    }
    if (node.type === "codemapCallClassFrameNode") {
      const memberPositions = dragMeta.memberPositions || new Map();
      const dx = node.position.x - dragMeta.anchorX;
      const dy = node.position.y - dragMeta.anchorY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      updateState((prev) => {
        const next = { ...prev, nodePositions: new Map(prev.nodePositions), highlightedStepIndex: -1 };
        memberPositions.forEach((pos, memberId) => {
          next.nodePositions.set(memberId, { x: pos.x + dx, y: pos.y + dy });
        });
        return next;
      });
    }
  }, [scene, updateState]);

  const nodeTypes = useMemo(() => ({
    codemapCallSymbolNode: CallSymbolNode,
    codemapCallModuleNode: CallModuleNode,
    codemapCallClassFrameNode: CallClassFrameNode,
  }), []);
  const edgeTypes = useMemo(() => ({ codemapCallEdge: CallGraphEdge }), []);

  return React.createElement(
    "div",
    { style: { position: "relative", width: "100%", height: "100%" } },
    React.createElement(
      ReactFlow,
      {
        className: "codemap-callrf-canvas",
        nodes,
        edges,
        nodeTypes,
        edgeTypes,
        fitView: !preserveView,
        panOnDrag: true,
        zoomOnScroll: true,
        zoomOnPinch: true,
        zoomOnDoubleClick: false,
        minZoom: 0.08,
        maxZoom: 3.0,
        proOptions: { hideAttribution: true },
        nodesDraggable: true,
        nodeDragThreshold: 2,
        onNodesChange,
        onNodeClick,
        onNodeDoubleClick,
        onNodeDragStart,
        onNodeDrag,
        onNodeDragStop,
        onNodeMouseEnter: (event, node) => {
          if (node.type !== "codemapCallSymbolNode") return;
          const baseNode = node.data?.node;
          if (!baseNode) return;
          callbacks.showTooltip?.(event, {
            ...baseNode,
            _connOut: node.data?.connOut || 0,
            _connIn: node.data?.connIn || 0,
          });
        },
        onNodeMouseMove: (event) => callbacks.moveTooltip?.(event),
        onNodeMouseLeave: () => callbacks.hideTooltip?.(),
        onPaneClick: () => callbacks.onPaneClick?.(),
        onMoveEnd: (_event, viewport) => { lastViewport = viewport; },
        elementsSelectable: false,
      },
      React.createElement(Background, { color: "#12182a", gap: 24, size: 1 }),
      React.createElement(MiniMap, {
        pannable: true,
        zoomable: true,
        position: "bottom-right",
        style: { background: "rgba(11, 14, 23, 0.84)", border: "1px solid #1f2640" },
        nodeColor: (node) => node?.data?.color || moduleColor(node?.data?.label || ""),
        nodeStrokeColor: (node) => node?.data?.color || "#7aa2f7",
        nodeStrokeWidth: (node) => node?.type === "codemapCallModuleNode" ? 2 : 1,
        nodeBorderRadius: 3,
        maskColor: "rgba(10, 12, 18, 0.42)",
      }),
      React.createElement(CaptureApi, null),
      React.createElement(FitViewOnMount, { preserveView }),
    ),
  );
}

export function renderCallGraphReactFlow(graph, options = {}) {
  const { mount, callbacks = {}, preserveView = false, layoutSnapshot = null, uiState = {} } = options;
  if (!mount) return null;
  const initialState = createInitialState(graph, layoutSnapshot);
  const initialScene = buildScene(graph, initialState, uiState);
  callEdgeMapRef.current = initialScene.edgeMap;
  callExecTimelineRef.current = initialScene.execTimeline;

  if (!callHost) {
    callHost = document.createElement("div");
    callHost.id = "react-flow-callgraph-host";
    callHost.className = "react-flow-host";
    mount.appendChild(callHost);
  }
  if (!callRoot) {
    callRoot = createRoot(callHost);
  }

  callRoot.render(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(CallGraphReact, {
        graph,
        callbacks,
        preserveView,
        layoutSnapshot,
        uiState,
      }),
    ),
  );

  return {
    edgeRecords: initialScene.edgeRecords,
    nodeRect: initialScene.nodeRect,
    nodes: initialScene.nodes,
    sceneEl: null,
    _hasGroupControls: Array.isArray(graph?.nodes) && graph.nodes.length > 0,
    _execTimeline: initialScene.execTimeline,
    _edgeMap: initialScene.edgeMap,
    _resetSelection: () => callSelectionRef.current?.(),
    _highlightStep: (stepIdx) => callHighlightStepRef.current?.(stepIdx),
    _expandAllGroups: () => callExpandAllRef.current?.(),
    _collapseAllGroups: () => callCollapseAllRef.current?.(),
    _spawnExecDot: (edgeIdx, color, options = {}) => {
      const edge = callEdgeRecordsRef.current[edgeIdx];
      const execGroup = ensureCallExecLayer();
      if (!edge || !execGroup) return null;
      const svgNs = "http://www.w3.org/2000/svg";
      const radius = typeof options.radius === "number" ? options.radius : 5;
      const speed = typeof options.speed === "number" ? options.speed : 0.006;
      const trailScale = typeof options.trailScale === "number" ? options.trailScale : 1;
      const dot = document.createElementNS(svgNs, "circle");
      dot.setAttribute("r", String(radius));
      dot.setAttribute("fill", color);
      dot.setAttribute("opacity", "0.9");
      dot.setAttribute("filter", "url(#codemap-callrf-glow-big)");
      execGroup.appendChild(dot);
      const trails = [];
      for (let i = 0; i < 5; i++) {
        const trail = document.createElementNS(svgNs, "circle");
        trail.setAttribute("r", String(Math.max(1, (4 - i * 0.7) * trailScale)));
        trail.setAttribute("fill", color);
        trail.setAttribute("opacity", String(0.35 - i * 0.06));
        execGroup.appendChild(trail);
        trails.push({ el: trail });
      }
      return { el: dot, trails, t: 0, speed, edge, alive: true };
    },
    _clearExecDots: () => clearCallExecDots(),
    _resetView: () => {
      if (!callApi) return;
      callApi.fitView({ duration: 220, padding: 0.18 });
    },
  };
}

export function clearCallGraphReactFlow() {
  if (callRoot) {
    callRoot.unmount();
    callRoot = null;
  }
  if (callHost && callHost.parentElement) {
    callHost.parentElement.removeChild(callHost);
  }
  callHost = null;
  callApi = null;
  lastViewport = null;
  callSelectionRef.current = null;
  callHighlightStepRef.current = null;
  callExpandAllRef.current = null;
  callCollapseAllRef.current = null;
  callEdgeMapRef.current = {};
  callEdgeRecordsRef.current = [];
  callExecTimelineRef.current = [];
  disposeCallExecLayer();
}

export function resetCallGraphReactView() {
  if (!callApi) return;
  callApi.fitView({ duration: 220, padding: 0.18 });
}