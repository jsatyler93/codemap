// reactFlowView.js
// React Flow flowchart renderer.
// React Flow provides pan/zoom/canvas/drag only.
// ALL layout, node chip text, group state, visibility, and simplification logic
// are exact ports from flowchartView.js — no changes to spacing constants or algorithms.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import {
  BaseEdge,
  Background,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  applyNodeChanges,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import Dagre from "dagre";

// ─── Constants — exact match with flowchartView.js ────────────────────────────
const NODE_R        = 16;
const NODE_CIRCLE_D = 32;
const NODE_MIN_H    = 32;
const ROW_GAP       = 28;

// ─── Inline theme colors (same as theme.js nodeColor) ────────────────────────
const NODE_COLOR = {
  entry:     "#9ece6a",
  return:    "#9ece6a",
  exit:      "#9ece6a",
  decision:  "#e0af68",
  loop:      "#7dcfff",
  break:     "#ff9e64",
  continue:  "#73daca",
  loop_else: "#c0caf5",
  process:   "#7aa2f7",
  compute:   "#bb9af7",
  output:    "#73daca",
  error:     "#f7768e",
};
function nodeKindColor(kind) { return NODE_COLOR[kind] || NODE_COLOR.process; }

function isLoopGroupKind(kind) { return kind === "loop" || kind === "loop_body"; }

function groupKindColor(kind) {
  if (kind === "branch")        return NODE_COLOR.decision;
  if (isLoopGroupKind(kind))    return NODE_COLOR.loop;
  if (kind === "function_body") return NODE_COLOR.compute;
  return "#7aa2f7";
}

// ─── Chip text helpers — exact port from flowchartView.js ────────────────────
function primaryNodeLine(node) {
  const displayLines = Array.isArray(node?.metadata?.displayLines)
    ? node.metadata.displayLines.map((l) => String(l || "").trim()).filter(Boolean)
    : [];
  if (displayLines.length) return displayLines[0];
  return String(node?.label || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
}

function abbreviateChipText(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return "stmt";
  const c = src
    .replace(/^for each\s+/i, "")
    .replace(/^implicit\s+/i, "")
    .replace(/^loop\s+/i, "")
    .replace(/^total\s*=\s*/i, "total=")
    .replace(/^matches\s*=\s*/i, "matches=");
  return c.length > 12 ? `${c.slice(0, 11)}.` : c;
}

function nodeChipText(node) {
  const primary = primaryNodeLine(node);
  if (node.kind === "entry")    return { top: "fn",   bottom: abbreviateChipText(primary || "enter") };
  if (node.kind === "return")   return { top: "ret",  bottom: abbreviateChipText(primary.replace(/^return\s+/i, "") || "value") };
  if (node.kind === "decision") return { top: "if",   bottom: abbreviateChipText(primary.replace(/^if\s+/i, "").replace(/\?$/, "") || "cond") };
  if (node.kind === "loop") {
    if (/^for each\s+/i.test(primary)) {
      const tail   = primary.replace(/^for each\s+/i, "");
      const target = tail.split(/\s+in\s+/i)[0] || "iter";
      return { top: "for", bottom: abbreviateChipText(target) };
    }
    return { top: "loop", bottom: abbreviateChipText(primary.replace(/^while\s+/i, "") || "cond") };
  }
  if (node.kind === "break")    return { top: "break", bottom: "exit" };
  if (node.kind === "continue") return { top: "cont",  bottom: "next" };
  if (node.kind === "error")    return { top: "exc",   bottom: abbreviateChipText(primary.replace(/^raise\s+/i, "") || "throw") };
  return { top: "S", bottom: abbreviateChipText(primary || "stmt") };
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

// ─── simplifyAlphabetFlowGraph — exact port from flowchartView.js ─────────────
function simplifyAlphabetFlowGraph(graph) {
  const originalNodes  = Array.isArray(graph?.nodes)            ? graph.nodes            : [];
  const originalEdges  = Array.isArray(graph?.edges)            ? graph.edges            : [];
  const groups         = Array.isArray(graph?.metadata?.groups) ? graph.metadata.groups  : [];
  const removedNodeIds = new Set();
  let edges = originalEdges.map((e) => ({ ...e }));

  const shouldContractNode = (node) => {
    if (!node) return false;
    if (node.metadata?.boundaryProxy) return false;
    if (node.kind === "loop_else") return true;
    if (node.kind !== "process")   return false;
    const label = String(node.label || "").trim().toLowerCase();
    return label === "•" || label === "after loop";
  };

  const buildAdjacency = () => {
    const incoming = new Map();
    const outgoing = new Map();
    originalNodes.forEach((n) => { incoming.set(n.id, []); outgoing.set(n.id, []); });
    edges.forEach((e) => {
      if (!incoming.has(e.to))   incoming.set(e.to, []);
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      incoming.get(e.to).push(e);
      outgoing.get(e.from).push(e);
    });
    return { incoming, outgoing };
  };

  const combineLabels = (inL, outL) => {
    const i = String(inL || "").trim(), il = i.toLowerCase();
    const o = String(outL || "").trim(), ol = o.toLowerCase();
    if (ol === "repeat")   return "repeat";
    if (ol === "continue") return "continue";
    if (!o && il === "repeat")   return "repeat";
    if (!o && il === "continue") return "continue";
    if (i && o) return `${i}/${o}`;
    return i || o || "";
  };

  const nodeKindMap = new Map(originalNodes.map((n) => [n.id, n.kind]));
  const normalizeAlphabetLoopEdge = (edge) => {
    const targetKind = nodeKindMap.get(edge.to);
    const label      = String(edge.label || "").trim();
    const lower      = label.toLowerCase();
    if (targetKind === "loop") {
      if (lower === "continue" || lower.endsWith("/continue")) return { ...edge, label: "continue" };
      if (lower === "repeat"   || lower.endsWith("/repeat"))   return { ...edge, label: "repeat" };
    }
    return edge;
  };

  originalNodes.forEach((node) => {
    if (!shouldContractNode(node)) return;
    const { incoming, outgoing } = buildAdjacency();
    const inEdges  = incoming.get(node.id) || [];
    const outEdges = outgoing.get(node.id) || [];
    const label    = String(node.label || "").trim().toLowerCase();
    if (label === "after loop" && inEdges.length && !outEdges.length) {
      edges = edges.filter((e) => e.from !== node.id && e.to !== node.id);
      removedNodeIds.add(node.id);
      return;
    }
    if (!inEdges.length || !outEdges.length) return;
    const rewired = [];
    inEdges.forEach((inE) => {
      outEdges.forEach((outE) => {
        if (inE.from === outE.to) return;
        rewired.push({
          id: `e_${inE.from}_${outE.to}_${edges.length + rewired.length}`,
          from: inE.from, to: outE.to,
          kind:  inE.kind || outE.kind || "control_flow",
          label: combineLabels(inE.label, outE.label),
        });
      });
    });
    edges = edges.filter((e) => e.from !== node.id && e.to !== node.id);
    edges.push(...rewired);
    removedNodeIds.add(node.id);
  });

  const dedupedEdges = [];
  const seen = new Set();
  edges.forEach((edge) => {
    if (removedNodeIds.has(edge.from) || removedNodeIds.has(edge.to)) return;
    const ne  = normalizeAlphabetLoopEdge(edge);
    const key = `${ne.from}->${ne.to}::${ne.label || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    dedupedEdges.push(ne);
  });

  const nodes      = originalNodes.filter((n) => !removedNodeIds.has(n.id));
  const baseGroups = groups
    .map((g) => ({ ...g, nodeIds: (g.nodeIds || []).filter((id) => !removedNodeIds.has(id)) }))
    .filter((g) => g.nodeIds.length > 0);

  const incomingEdgeMap = new Map(nodes.map((n) => [n.id, []]));
  const outgoingEdgeMap = new Map(nodes.map((n) => [n.id, []]));
  dedupedEdges.forEach((e) => { if (incomingEdgeMap.has(e.to))   incomingEdgeMap.get(e.to).push(e.from); });
  dedupedEdges.forEach((e) => { if (outgoingEdgeMap.has(e.from)) outgoingEdgeMap.get(e.from).push(e); });

  const mutableGroups           = new Map(baseGroups.map((g) => [g.id, { ...g, nodeIds: [...g.nodeIds] }]));
  const representativeLoopEdges = [];

  function removePromotedNodes(groupId, promotedNodeIds) {
    let currentId = groupId;
    while (currentId) {
      const cg = mutableGroups.get(currentId);
      if (!cg) break;
      cg.nodeIds = cg.nodeIds.filter((id) => !promotedNodeIds.has(id));
      const parentId = cg.parentGroupId || null;
      if (!parentId) break;
      const pg = mutableGroups.get(parentId);
      if (!pg || isLoopGroupKind(pg.kind)) break;
      currentId = parentId;
    }
  }

  baseGroups.forEach((group) => {
    if (!isLoopGroupKind(group.kind)) return;
    const mg = mutableGroups.get(group.id);
    if (!mg) return;
    const nodeSet   = new Set(mg.nodeIds);
    const headerIds = new Set(mg.nodeIds.filter((id) => {
      if (nodeKindMap.get(id) !== "loop") return false;
      return (incomingEdgeMap.get(id) || []).some((fromId) => !nodeSet.has(fromId));
    }));
    const bodyEntryIds = new Set(mg.nodeIds.filter((id) => {
      if (headerIds.has(id)) return false;
      const k = nodeKindMap.get(id);
      if (k === "break" || k === "continue" || k === "return") return false;
      return (incomingEdgeMap.get(id) || []).some((fromId) => headerIds.has(fromId));
    }));
    let promotedBodyId = null;
    if (bodyEntryIds.size) {
      promotedBodyId = mg.nodeIds.find((id) => bodyEntryIds.has(id)) || null;
      if (promotedBodyId) {
        const preferred = mg.nodeIds.find((id) => {
          if (!bodyEntryIds.has(id)) return false;
          const outs = outgoingEdgeMap.get(id) || [];
          return outs.some((e) => e.to !== id && headerIds.has(e.to) && (e.label === "repeat" || e.label === "continue"));
        });
        if (preferred) promotedBodyId = preferred;
      }
    }
    if (!headerIds.size && !promotedBodyId) return;
    const headerId = headerIds.size ? Array.from(headerIds)[0] : null;
    if (headerId && promotedBodyId) {
      const existingDirectLoopBack = dedupedEdges.some((e) =>
        e.from === promotedBodyId && e.to === headerId &&
        (e.label === "repeat" || e.label === "continue"));
      if (!existingDirectLoopBack) {
        const hiddenLoopBack = dedupedEdges.find((e) =>
          e.to === headerId && e.from !== promotedBodyId &&
          nodeSet.has(e.from) && (e.label === "repeat" || e.label === "continue"));
        if (hiddenLoopBack) {
          const loopBackLabel = String(hiddenLoopBack.label || "").trim().toLowerCase() === "continue"
            ? "continue" : "repeat";
          representativeLoopEdges.push({
            ...hiddenLoopBack,
            id: `rep_${promotedBodyId}_${headerId}_${loopBackLabel}`,
            from: promotedBodyId, to: headerId,
            label: loopBackLabel, synthetic: true,
          });
        }
      }
    }
    const promotedNodeIds = new Set(headerIds);
    if (promotedBodyId) promotedNodeIds.add(promotedBodyId);
    removePromotedNodes(group.id, promotedNodeIds);
  });

  const visibleEdges    = dedupedEdges.slice();
  const visibleEdgeKeys = new Set(visibleEdges.map((e) => `${e.from}->${e.to}::${e.label || ""}`));
  representativeLoopEdges.forEach((e) => {
    const key = `${e.from}->${e.to}::${e.label || ""}`;
    if (visibleEdgeKeys.has(key)) return;
    visibleEdgeKeys.add(key);
    visibleEdges.push(e);
  });

  const nextGroups = Array.from(mutableGroups.values())
    .map((g) => ({ ...g, nodeSet: new Set(g.nodeIds) }))
    .filter((g) => g.nodeIds.length > 0);

  return {
    ...graph, nodes, edges: visibleEdges,
    metadata: { ...(graph.metadata || {}), groups: nextGroups },
  };
}

// ─── Group structure helpers — exact port from flowchartView.js ───────────────
function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups
    .filter((g) => g && typeof g.id === "string" && Array.isArray(g.nodeIds) && g.nodeIds.length)
    .map((g) => ({
      ...g,
      kind:          String(g.kind || "branch"),
      label:         String(g.label || g.kind || "group"),
      nodeIds:       Array.from(new Set(g.nodeIds.map(String))),
      nodeSet:       new Set(g.nodeIds.map(String)),
      parentGroupId: g.parentGroupId ? String(g.parentGroupId) : null,
    }));
}

function buildGroupDepthMap(groups) {
  const byId  = new Map(groups.map((g) => [g.id, g]));
  const depth = new Map();
  function resolve(id) {
    if (depth.has(id)) return depth.get(id);
    const g = byId.get(id);
    if (!g || !g.parentGroupId) { depth.set(id, 0); return 0; }
    const v = resolve(g.parentGroupId) + 1;
    depth.set(id, v);
    return v;
  }
  groups.forEach((g) => resolve(g.id));
  return depth;
}

function buildNodeGroupChains(groups) {
  const chains = new Map();
  const depth  = buildGroupDepthMap(groups);
  for (const g of groups)
    for (const nodeId of g.nodeIds) {
      if (!chains.has(nodeId)) chains.set(nodeId, []);
      chains.get(nodeId).push(g.id);
    }
  for (const ids of chains.values())
    ids.sort((a, b) => (depth.get(b) || 0) - (depth.get(a) || 0));
  return chains;
}

function buildGroupDescendants(groups) {
  const children    = new Map(groups.map((g) => [g.id, []]));
  const descendants = new Map();
  groups.forEach((g) => {
    if (!g.parentGroupId || !children.has(g.parentGroupId)) return;
    children.get(g.parentGroupId).push(g.id);
  });
  function collect(id) {
    const direct = children.get(id) || [];
    const all    = [];
    direct.forEach((cid) => { all.push(cid, ...collect(cid)); });
    descendants.set(id, all);
    return all;
  }
  groups.forEach((g) => collect(g.id));
  return descendants;
}

function resolveVisibleEndpoint(nodeId, nodeGroupChains, groupState) {
  const chain = nodeGroupChains.get(nodeId) || [];
  let outermost = null;
  for (const gId of chain)
    if (groupState.get(gId)?.collapsed) outermost = `group:${gId}`;
  return outermost || nodeId;
}

function computeVisibility(nodes, groups, groupById, nodeGroupChains, groupState) {
  const visibleNodeIds           = new Set();
  const visibleCollapsedGroupIds = [];
  const visibleExpandedGroupIds  = [];
  for (const g of groups) {
    let hasCollapsedAncestor = false;
    let parentId = g.parentGroupId;
    while (parentId) {
      if (groupState.get(parentId)?.collapsed) { hasCollapsedAncestor = true; break; }
      parentId = groupById.get(parentId)?.parentGroupId ?? null;
    }
    if (hasCollapsedAncestor) continue;
    if (groupState.get(g.id)?.collapsed) visibleCollapsedGroupIds.push(g.id);
    else                                  visibleExpandedGroupIds.push(g.id);
  }
  for (const node of nodes) {
    const ep = resolveVisibleEndpoint(node.id, nodeGroupChains, groupState);
    if (!ep || ep.startsWith("group:")) continue;
    visibleNodeIds.add(node.id);
  }
  return { visibleNodeIds, visibleCollapsedGroupIds, visibleExpandedGroupIds };
}

// ─── Layout — topological code-structure layout ──────────────────────────────
// Guarantees no node is ever placed at an arbitrary position:
//   1. Build forward-only adjacency (back-edges repeat/continue excluded).
//   2. Topological sort (Kahn's algorithm) — all predecessors placed before successors.
//   3. Place each node using its finalised position; successors inherit from it.
// Rules:
//   • Main flow → downward.
//   • Loop body → RIGHT, same Y as loop node.
//   • Decision false/else/no → downward at same X (main column continues).
//   • Decision true/yes/body → RIGHT, same Y as decision.
//   • Merge point → min(predecessor X) so branches always converge back to main column.
function prepareNode() { return { lines: [], typeLines: [], h: NODE_MIN_H, align: "center" }; }

function applyFlowAlphabetLayout(positions, nodes, edges, prepared, entryId, visibleNodeIds = null) {
  const visible   = visibleNodeIds instanceof Set ? visibleNodeIds : new Set(nodes.map((n) => n.id));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const V_STEP   = 70;
  const BRANCH_X = 110;
  const START_X  = 220;
  const START_Y  = 30;

  // ── Forward-only adjacency (back-edges excluded) ───────────────────────────
  const fwdOut = new Map();
  const fwdIn  = new Map();
  nodes.forEach((n) => { if (visible.has(n.id)) { fwdOut.set(n.id, []); fwdIn.set(n.id, []); } });
  edges.forEach((e) => {
    if (!visible.has(e.from) || !visible.has(e.to)) return;
    const lbl = String(e.label || "").toLowerCase();
    if (lbl === "repeat" || lbl === "continue") return; // back-edges — skip
    fwdOut.get(e.from)?.push(e);
    fwdIn.get(e.to)?.push(e);
  });

  // ── Kahn topological sort ─────────────────────────────────────────────────
  const inDeg = new Map();
  fwdIn.forEach((preds, id) => inDeg.set(id, preds.length));
  const topoQueue = [];
  inDeg.forEach((d, id) => { if (d === 0) topoQueue.push(id); });
  // Stable sort: prefer entry node first, then source-line order
  topoQueue.sort((a, b) => {
    if (a === entryId) return -1;
    if (b === entryId) return  1;
    return Number(nodesById.get(a)?.source?.line || 0) - Number(nodesById.get(b)?.source?.line || 0);
  });
  const topoOrder = [];
  const topoSeen  = new Set();
  while (topoQueue.length) {
    const id = topoQueue.shift();
    if (topoSeen.has(id)) continue;
    topoSeen.add(id);
    topoOrder.push(id);
    const nexts = (fwdOut.get(id) || []).map((e) => e.to);
    nexts.sort((a, b) => Number(nodesById.get(a)?.source?.line || 0) - Number(nodesById.get(b)?.source?.line || 0));
    for (const nxt of nexts) {
      const d = (inDeg.get(nxt) || 1) - 1;
      inDeg.set(nxt, d);
      if (d === 0) topoQueue.push(nxt);
    }
  }
  // Append any remaining nodes (disconnected or part of isolated cycles)
  nodes.forEach((n) => { if (visible.has(n.id) && !topoSeen.has(n.id)) topoOrder.push(n.id); });

  // ── Place helper: first call sets position; subsequent calls merge ────────
  const center = new Map(); // id → {x, y}
  function place(id, x, y) {
    if (!prepared.has(id)) return;
    const ex = center.get(id);
    let nx, ny;
    if (!ex) {
      nx = x; ny = y;
    } else {
      // Merge point: leftmost column (converge back to main), deepest row
      nx = Math.min(ex.x, x);
      ny = Math.max(ex.y, y);
    }
    center.set(id, { x: nx, y: ny });
    const h = prepared.get(id)?.h ?? NODE_MIN_H;
    positions.set(id, { x: nx - NODE_R, y: ny - NODE_R, h });
  }

  function classifyEdges(nodeId, outs) {
    const node = nodesById.get(nodeId);
    return outs.map((edge) => {
      const tgt   = nodesById.get(edge.to);
      const lbl   = String(edge.label || "").toLowerCase();
      let side = 0;
      if (/false|else|done|exit/.test(lbl))                                                       side = -1;
      else if (/true|then|ok|body/.test(lbl))                                                     side =  1;
      else if (tgt?.kind === "return" || tgt?.kind === "break" || tgt?.kind === "error")          side = -1;
      else if (tgt?.kind === "continue" || tgt?.kind === "loop")                                  side =  1;
      else side = String(edge.to) < String(nodeId) ? -1 : 1;
      return { edge, side };
    });
  }

  // Seed entry node
  if (entryId && visible.has(entryId)) place(entryId, START_X, START_Y);

  // ── Process each node in topological order ────────────────────────────────
  let fallbackY = START_Y;
  for (const nodeId of topoOrder) {
    // If not yet placed (disconnected / topo cycle remnant) — stack at bottom
    if (!center.has(nodeId)) {
      fallbackY = Math.max(fallbackY, ...(center.size ? Array.from(center.values()).map((c) => c.y + V_STEP) : [START_Y]));
      place(nodeId, START_X, fallbackY);
      fallbackY += V_STEP;
    }

    const c    = center.get(nodeId);
    const node = nodesById.get(nodeId);
    const outs = fwdOut.get(nodeId) || [];
    if (!outs.length) continue;

    if (node?.kind === "loop") {
      const bodyEdge = outs.find((e) => !/done|else|exit/i.test(String(e.label || "")) && nodesById.get(e.to)?.kind !== "loop_else");
      const exitEdge = outs.find((e) => e !== bodyEdge);
      if (bodyEdge) place(bodyEdge.to, c.x + BRANCH_X, c.y);
      if (exitEdge) place(exitEdge.to, c.x, c.y + V_STEP);
      outs.forEach((e) => { if (e !== bodyEdge && e !== exitEdge) place(e.to, c.x, c.y + V_STEP); });
      continue;
    }

    if (node?.kind === "decision") {
      const scored = classifyEdges(nodeId, outs);
      scored.sort((a, b) => a.side - b.side);
      let falseSlot = 0, trueSlot = 0;
      scored.forEach(({ edge, side }) => {
        if (side < 0) { place(edge.to, c.x,                             c.y + V_STEP * (falseSlot + 1)); falseSlot++; }
        else          { place(edge.to, c.x + BRANCH_X * (trueSlot + 1), c.y);                            trueSlot++;  }
      });
      continue;
    }

    // Regular node — successors go below, sorted by source line
    const sorted = outs.slice().sort((a, b) =>
      Number(nodesById.get(a.to)?.source?.line || 0) - Number(nodesById.get(b.to)?.source?.line || 0));
    sorted.forEach((e, i) => place(e.to, c.x, c.y + V_STEP * (i + 1)));
  }
}



// ─── Group state initialiser — same rules as flowchartView.js ─────────────────
function initGroupState(groups, groupDepth, layoutSnapshot = null) {
  const savedGroups            = layoutSnapshot?.groups || {};
  const hasPersistedGroupState = groups.some((g) => typeof savedGroups[g.id]?.collapsed === "boolean");
  return new Map(groups.map((g) => [g.id, {
    collapsed: (groupDepth.get(g.id) || 0) > 0 || isLoopGroupKind(g.kind)
      ? true
      : hasPersistedGroupState
        ? !!savedGroups[g.id]?.collapsed
        : false,
  }]));
}

// ─── Build React Flow nodes + edges from simplifiedGraph + groupState ─────────
function buildReactFlowGraph(simplifiedGraph, groupState, groupById, groups, nodeGroupChains, groupDepth) {
  const nodes     = simplifiedGraph.nodes || [];
  const edges     = simplifiedGraph.edges || [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const visibility = computeVisibility(nodes, groups, groupById, nodeGroupChains, groupState);

  // Entry node: prefer kind=="entry", fall back to rootNodeIds, then first node.
  const entryId  = nodes.find((n) => n.kind === "entry")?.id
                ?? (simplifiedGraph.rootNodeIds || []).find((id) => nodes.some((n) => n.id === id))
                ?? nodes[0]?.id;
  const prepared = new Map(nodes.map((n) => [n.id, prepareNode()]));

  // ── Pass 1: layout ALL nodes — gives positions to hidden nodes inside collapsed groups.
  const allPositions = new Map();
  applyFlowAlphabetLayout(allPositions, nodes, edges, prepared, entryId);

  // ── Pass 2: layout VISIBLE nodes only — actual displayed positions.
  const positions = new Map();
  applyFlowAlphabetLayout(positions, nodes, edges, prepared, entryId, visibility.visibleNodeIds);

  // Collapsed group positions — loop body chips go to the right of the loop node (flowchartView.js rule).
  // Use allPositions (all nodes) so chips for groups whose members are hidden still get a location.
  const collapsedGroupPositions = new Map();
  for (const groupId of visibility.visibleCollapsedGroupIds) {
    const group = groupById.get(groupId);
    if (!group) continue;
    if (isLoopGroupKind(group.kind)) {
      const loopCondNode = nodes.find((n) =>
        n.kind === "loop" &&
        edges.some((e) => e.from === n.id && group.nodeSet.has(e.to)));
      if (loopCondNode) {
        // Prefer visible position; fall back to allPositions (same as flowchartView.js nodeRectAll)
        const loopPos = positions.get(loopCondNode.id) || allPositions.get(loopCondNode.id);
        if (loopPos) {
          // Collapsed body chip sits to the RIGHT of the loop node at the same Y,
          // matching where applyFlowAlphabetLayout places the first body node (LOOP_X = 110).
          collapsedGroupPositions.set(groupId, { x: loopPos.x + 110, y: loopPos.y });
          continue;
        }
      }
    }
    // Use allPositions for contained nodes — they may be hidden but have positions from pass 1
    const contained = group.nodeIds.map((id) => allPositions.get(id)).filter(Boolean);
    if (contained.length) {
      const cx = contained.reduce((s, p) => s + p.x, 0) / contained.length;
      const cy = contained.reduce((s, p) => s + p.y, 0) / contained.length;
      collapsedGroupPositions.set(groupId, { x: cx, y: cy });
    }
  }

  // ── React Flow nodes ──────────────────────────────────────────────────────
  const rfNodes = [];
  for (const node of nodes) {
    if (!visibility.visibleNodeIds.has(node.id)) continue;
    const pos = positions.get(node.id);
    if (!pos) continue;
    const color           = nodeKindColor(node.kind);
    const { top, bottom } = nodeChipText(node);
    rfNodes.push({
      id:   node.id,
      type: "codemapNode",
      data: { top, bottom, color, kind: node.kind, label: node.label || node.id, detail: node.detail || "", source: node.source },
      position:    { x: pos.x, y: pos.y },
      draggable:   true,
      selectable:  true,
      connectable: false,
    });
  }

  for (const groupId of visibility.visibleCollapsedGroupIds) {
    const group = groupById.get(groupId);
    const pos   = collapsedGroupPositions.get(groupId);
    if (!group || !pos) continue;
    const color           = groupKindColor(group.kind);
    const { top, bottom } = groupChipText(group);
    rfNodes.push({
      id:   `group:${groupId}`,
      type: "codemapGroupNode",
      data: { top, bottom, color, groupId, groupLabel: group.label || group.kind },
      position:    { x: pos.x, y: pos.y },
      draggable:   true,
      selectable:  true,
      connectable: false,
    });
  }

  // ── React Flow edges ──────────────────────────────────────────────────────
  // Build a set of all RF node IDs that were actually added — edges that reference
  // a missing node (e.g. a collapsed group chip without a position) are dropped
  // to prevent React Flow warnings.
  const renderedNodeIds = new Set(rfNodes.map((n) => n.id));

  const rfEdges      = [];
  const seenEdgeKeys = new Set();
  for (const edge of edges) {
    const srcEndpoint = resolveVisibleEndpoint(edge.from, nodeGroupChains, groupState);
    const tgtEndpoint = resolveVisibleEndpoint(edge.to,   nodeGroupChains, groupState);
    if (!srcEndpoint || !tgtEndpoint || srcEndpoint === tgtEndpoint) continue;
    if (!renderedNodeIds.has(srcEndpoint) || !renderedNodeIds.has(tgtEndpoint)) continue;

    const dedupeKey = `${srcEndpoint}->${tgtEndpoint}::${edge.label || ""}`;
    if (seenEdgeKeys.has(dedupeKey)) continue;
    seenEdgeKeys.add(dedupeKey);

    const getKind = (ep) => {
      if (!ep.startsWith("group:")) return nodesById.get(ep)?.kind || "process";
      const k = groupById.get(ep.slice(6))?.kind;
      return k === "branch" ? "decision" : isLoopGroupKind(k) ? "loop" : "process";
    };
    const fromKind = getKind(srcEndpoint);
    const toKind   = getKind(tgtEndpoint);
    const label    = edge.label || "";
    const lower    = label.toLowerCase();
    const loopBack = (lower === "repeat" || lower === "continue") && toKind === "loop";
    const loopBody = fromKind === "loop" && !loopBack && !/done|else|exit/i.test(lower);
    const backArc  = !loopBack && !loopBody && fromKind === "break";
    const isArcEdge = loopBack || loopBody || backArc;
    const color    = nodeKindColor(fromKind);

    // ── Dynamic handle selection based on actual node positions ──────────────
    // Picks the handle that produces an edge perpendicular to the node circle.
    const getPos = (ep) => {
      if (!ep.startsWith("group:")) return positions.get(ep) ?? allPositions.get(ep);
      return collapsedGroupPositions.get(ep.slice(6));
    };
    const srcPos = getPos(srcEndpoint);
    const tgtPos = getPos(tgtEndpoint);

    // All edges connect center-to-center; arc edges form perfect semicircles,
    // straight edges get an exact mid-point tangent for the arrowhead.
    const sourceHandle = "center-s";
    const targetHandle = "center-t";

    rfEdges.push({
      id:           `${srcEndpoint}->${tgtEndpoint}::${label}`,
      source:       srcEndpoint,
      target:       tgtEndpoint,
      sourceHandle,
      targetHandle,
      label:        label || undefined,
      type:         "codemapEdge",
      data:         { label, loopBack, loopBody, backArc, color, fromKind, toKind },
      // No markerEnd on any edge — CodemapEdge renders a mid-path polygon arrowhead instead
      markerEnd:    undefined,
      style:        { stroke: color + (isArcEdge ? "9f" : "4f"), strokeWidth: 1.4 },
    });
  }

  return { rfNodes, rfEdges };
}

// ─── Module-level singletons ──────────────────────────────────────────────────
let flowRoot     = null;
let flowHost     = null;
let lastViewport = null;
let flowApi      = null;
const drilldownRef = { current: null };

const HANDLE_STYLE        = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1 };
// Center handles — positioned at the node's geometric center so arc edges attach there.
const CENTRE_HANDLE_STYLE = { ...HANDLE_STYLE, top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };

// ─── CodemapNode — regular node circle, chip text identical to flowchartView.js
function CodemapNode({ id, data }) {
  const { top, bottom, color, label } = data;
  return React.createElement(
    React.Fragment, null,
    React.createElement(Handle, { id: "top",      type: "target", position: Position.Top,    style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "top-s",    type: "source", position: Position.Top,    style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "left-t",   type: "target", position: Position.Left,   style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "bottom-t", type: "target", position: Position.Bottom, style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "bottom",   type: "source", position: Position.Bottom, style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "right-s",  type: "source", position: Position.Right,  style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "left-s",   type: "source", position: Position.Left,   style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "center-s", type: "source", position: Position.Top,    style: CENTRE_HANDLE_STYLE, isConnectable: false }),
    React.createElement(Handle, { id: "center-t", type: "target", position: Position.Top,    style: CENTRE_HANDLE_STYLE, isConnectable: false }),
    React.createElement("div", {
      className: "codemap-rf-node",
      "data-id": id,
      "data-node-label": label || id,
      style: {
        width: `${NODE_CIRCLE_D}px`,
        height: `${NODE_CIRCLE_D}px`,
        borderRadius: "50%",
        border: `1.4px solid ${color}86`,
        background: color + "1b",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1px",
        userSelect: "none",
        cursor: "pointer",
        boxSizing: "border-box",
      },
    },
      React.createElement("div", { style: { fontSize: "6.1px", fontFamily: "serif", color: color + "dd", lineHeight: 1, letterSpacing: "0.1px" } }, top),
      React.createElement("div", { style: { fontSize: "5.4px", fontFamily: "serif", color: color + "88", lineHeight: 1, letterSpacing: "0.2px" } }, bottom),
    ),
  );
}

// ─── CodemapGroupNode — collapsed group chip, circle + + button ───────────────
function CodemapGroupNode({ id, data }) {
  const { top, bottom, color, groupId, groupLabel } = data;
  return React.createElement(
    React.Fragment, null,
    React.createElement(Handle, { id: "top",      type: "target", position: Position.Top,    style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "top-s",    type: "source", position: Position.Top,    style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "left-t",   type: "target", position: Position.Left,   style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "bottom-t", type: "target", position: Position.Bottom, style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "bottom",   type: "source", position: Position.Bottom, style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "right-s",  type: "source", position: Position.Right,  style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "left-s",   type: "source", position: Position.Left,   style: HANDLE_STYLE,        isConnectable: false }),
    React.createElement(Handle, { id: "center-s", type: "source", position: Position.Top,    style: CENTRE_HANDLE_STYLE, isConnectable: false }),
    React.createElement(Handle, { id: "center-t", type: "target", position: Position.Top,    style: CENTRE_HANDLE_STYLE, isConnectable: false }),
    React.createElement("div", {
      className: "codemap-rf-node codemap-rf-group-node",
      "data-group-id": groupId,
      style: {
        position: "relative",
        width: `${NODE_CIRCLE_D}px`,
        height: `${NODE_CIRCLE_D}px`,
        borderRadius: "50%",
        border: `1.4px solid ${color}86`,
        background: color + "1b",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1px",
        userSelect: "none",
        cursor: "pointer",
        boxSizing: "border-box",
      },
    },
      React.createElement("div", { style: { fontSize: "6.1px", fontFamily: "serif", color: color + "dd", lineHeight: 1 } }, top),
      React.createElement("div", { style: { fontSize: "5.4px", fontFamily: "serif", color: color + "88", lineHeight: 1, letterSpacing: "0.2px" } }, bottom),
      React.createElement("div", {
        className: "codemap-rf-group-toggle",
        title: `Drill into ${groupLabel}`,
        style: {
          position: "absolute",
          top: "-5px",
          right: "-5px",
          width: "14px",
          height: "14px",
          borderRadius: "50%",
          background: color + "1e",
          border: `1px solid ${color}75`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "10px",
          fontWeight: "700",
          color: color + "ee",
          lineHeight: 1,
          cursor: "pointer",
          zIndex: 10,
        },
        onPointerDown: (e) => e.stopPropagation(),
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          drilldownRef.current?.(groupId, groupLabel);
        },
      }, "+"),
    ),
  );
}

// ─── CodemapEdge ─────────────────────────────────────────────────────────────
// Loop edges (loopBody / loopBack) are drawn as the two half-arcs of a CIRCLE
// whose circumference passes through both nodes:
//   loopBody (loop TOP → body TOP):    CW half-circle, bows RIGHT
//   loopBack (body BOTTOM → loop BOTTOM): CCW half-circle, bows LEFT
// Together they form a symmetric closed circle.
// A polygon arrowhead is placed at the geometric midpoint of each arc.
function CodemapEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }) {
  const label    = data?.label || "";
  const loopBack = !!data?.loopBack;
  const loopBody = !!data?.loopBody;
  const backArc  = !!data?.backArc;
  const color    = data?.color || "#7aa2f7";

  let edgePath, arrowX, arrowY, arrowUx, arrowUy, labelX, labelY;

  if (loopBack || loopBody || backArc) {
    // ── Circular arc geometry ──────────────────────────────────────────────
    // R = chord/2 ⇒ both endpoints sit on the circumference of the same circle.
    const dx   = targetX - sourceX;
    const dy   = targetY - sourceY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const R    = dist / 2;

    // sweep is ALWAYS 1 (CW in SVG):
    //   loopBody going DOWN  → right-perp = RIGHT → arc bows RIGHT  (right half)
    //   loopBack going UP    → right-perp = LEFT  → arc bows LEFT   (left half)
    //   loopBody going RIGHT → right-perp = UP    → arc bows UP     (top half)
    //   loopBack going LEFT  → right-perp = DOWN  → arc bows DOWN   (bottom / "lower" half ✓)
    //   break going DOWN     → bows RIGHT (same as loopBody) ✓
    // The two paired arcs always form the two complementary halves of one circle.
    const sweep = 1;
    edgePath = `M${sourceX},${sourceY} A${R} ${R} 0 0 ${sweep} ${targetX},${targetY}`;

    // Mid-arc point: chord-midpoint + R × right-perpendicular (CW side)
    const midCx = (sourceX + targetX) / 2;
    const midCy = (sourceY + targetY) / 2;
    const rpx   =  dy / dist;
    const rpy   = -dx / dist;
    const sign  = 1;  // always CW
    arrowX  = midCx + sign * R * rpx;
    arrowY  = midCy + sign * R * rpy;

    // Tangent at semicircle midpoint = chord direction (A→B)
    arrowUx = dx / dist;
    arrowUy = dy / dist;

    // Label sits outward from the arc midpoint
    labelX = midCx + sign * (R + 14) * rpx;
    labelY = midCy + sign * (R + 14) * rpy;
  } else {
    // Straight center-to-center line — midpoint tangent is exact, arrowhead always aligned.
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const d  = Math.sqrt(dx * dx + dy * dy) || 1;
    edgePath = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
    labelX  = (sourceX + targetX) / 2;
    labelY  = (sourceY + targetY) / 2;
    arrowX  = labelX;
    arrowY  = labelY;
    arrowUx = dx / d;
    arrowUy = dy / d;
  }

  // ── Mid-arc polygon arrowhead ───────────────────────────────────────────
  const s   = 5;
  const px  = -arrowUy;   // perpendicular
  const py  =  arrowUx;
  const tipX    = arrowX + s       * arrowUx;
  const tipY    = arrowY + s       * arrowUy;
  const base1X  = arrowX - s * 0.7 * arrowUx + s * 0.55 * px;
  const base1Y  = arrowY - s * 0.7 * arrowUy + s * 0.55 * py;
  const base2X  = arrowX - s * 0.7 * arrowUx - s * 0.55 * px;
  const base2Y  = arrowY - s * 0.7 * arrowUy - s * 0.55 * py;

  return React.createElement(
    React.Fragment, null,
    React.createElement(BaseEdge, {
      id, path: edgePath, markerEnd, style,
      className: loopBack ? "codemap-rf-edge codemap-rf-edge-loop" : "codemap-rf-edge",
    }),
    React.createElement("polygon", {
      points: `${tipX},${tipY} ${base1X},${base1Y} ${base2X},${base2Y}`,
      fill: color + "9f",
      pointerEvents: "none",
    }),
    label
      ? React.createElement("text", {
          x: labelX, y: labelY - 3,
          textAnchor: "middle",
          style: { fontSize: "8px", fontFamily: "serif", fill: color + "a2", pointerEvents: "none", userSelect: "none" },
        }, label)
      : null,
    React.createElement("g", { pointerEvents: "none" },
      React.createElement("circle", { r: (loopBack || loopBody || backArc) ? 2.2 : 1.9, fill: color, opacity: (loopBack || loopBody || backArc) ? "0.9" : "0.75" },
        React.createElement("animateMotion", { dur: (loopBack || loopBody || backArc) ? "5.8s" : "7.2s", repeatCount: "indefinite", path: edgePath })),
      React.createElement("circle", { r: 1.3, fill: color, opacity: "0.45" },
        React.createElement("animateMotion", { dur: (loopBack || loopBody || backArc) ? "8.6s" : "10.8s", begin: "-2.7s", repeatCount: "indefinite", path: edgePath })),
    ),
  );
}

// ─── GroupHierarchyOverlay — side panel listing all groups with + buttons ─────
function GroupHierarchyOverlay({ groups, onDrilldownGroup }) {
  const ordered = useMemo(() => buildOrderedGroups(groups), [groups]);
  if (!ordered.length) return null;
  return React.createElement(
    "div",
    { className: "codemap-rf-groups", onPointerDown: (e) => e.stopPropagation() },
    React.createElement("div", { className: "codemap-rf-groups-title" }, "GROUP HIERARCHY"),
    ...ordered.map((entry) =>
      React.createElement("div", {
        key: entry.id,
        className: "codemap-rf-group-row",
        style: { paddingLeft: `${10 + entry.depth * 14}px` },
      },
        React.createElement("span", { className: "codemap-rf-group-label", title: entry.label }, entry.label),
        React.createElement("button", {
          className: "codemap-rf-group-plus",
          title: `Drill into ${entry.label}`,
          onClick: () => onDrilldownGroup?.(entry.id, entry.label),
        }, "+"),
      ),
    ),
  );
}

function buildOrderedGroups(groups) {
  const valid = Array.isArray(groups) ? groups.filter((g) => g && typeof g.id === "string" && g.id.length) : [];
  if (!valid.length) return [];
  const byId     = new Map(valid.map((g) => [g.id, g]));
  const children = new Map(valid.map((g) => [g.id, []]));
  valid.forEach((g) => {
    const pid = g.parentGroupId || null;
    if (!pid || !children.has(pid)) return;
    children.get(pid).push(g.id);
  });
  const roots = valid.filter((g) => !g.parentGroupId || !byId.has(g.parentGroupId));
  roots.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
  children.forEach((list) => list.sort((a, b) => String(byId.get(a)?.label || a).localeCompare(String(byId.get(b)?.label || b))));
  const ordered = [];
  function walk(gid, depth) {
    const g = byId.get(gid);
    if (!g) return;
    ordered.push({ id: g.id, label: String(g.label || g.kind || g.id), depth });
    (children.get(g.id) || []).forEach((cid) => walk(cid, depth + 1));
  }
  roots.forEach((r) => walk(r.id, 0));
  return ordered;
}

// ─── React Flow infrastructure ────────────────────────────────────────────────
function CaptureFlowApi() {
  const rf = useReactFlow();
  useEffect(() => {
    flowApi = rf;
    return () => { if (flowApi === rf) flowApi = null; };
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
    rf.fitView({ duration: 280, padding: 0.22 });
  }, [rf, preserveView]);
  return null;
}

// ─── FlowchartGraph — main React component ───────────────────────────────────
function FlowchartGraph({ graph, callbacks, preserveView }) {
  const simplifiedGraph  = useMemo(() => simplifyAlphabetFlowGraph(graph), [graph]);
  const groups           = useMemo(() => normalizeGroups(simplifiedGraph.metadata?.groups || []), [simplifiedGraph]);
  const groupById        = useMemo(() => new Map(groups.map((g) => [g.id, g])),  [groups]);
  const groupDepth       = useMemo(() => buildGroupDepthMap(groups),              [groups]);
  const nodeGroupChains  = useMemo(() => buildNodeGroupChains(groups),            [groups]);

  const layoutSnapshot   = callbacks.layoutSnapshot;

  // Group collapse state — initial rules identical to flowchartView.js
  const [groupState, setGroupState] = useState(() => initGroupState(groups, groupDepth, layoutSnapshot));

  // Reset group state when the underlying graph changes
  const prevSimplifiedRef = useRef(simplifiedGraph);
  useEffect(() => {
    if (prevSimplifiedRef.current !== simplifiedGraph) {
      prevSimplifiedRef.current = simplifiedGraph;
      setGroupState(initGroupState(groups, groupDepth, layoutSnapshot));
    }
  }, [simplifiedGraph, groups, groupDepth, layoutSnapshot]);

  // Keep drilldown callback ref stable
  useEffect(() => {
    drilldownRef.current = callbacks.onDrilldownGroup;
  }, [callbacks.onDrilldownGroup]);

  const { rfNodes, rfEdges } = useMemo(
    () => buildReactFlowGraph(simplifiedGraph, groupState, groupById, groups, nodeGroupChains, groupDepth),
    [simplifiedGraph, groupState, groupById, groups, nodeGroupChains, groupDepth],
  );

  // Apply saved positions from layoutSnapshot
  const computedNodes = useMemo(() => {
    const savedNodes = layoutSnapshot?.nodes || {};
    return rfNodes.map((node) => {
      const saved = savedNodes[node.id];
      if (!saved || typeof saved.x !== "number" || typeof saved.y !== "number") return node;
      return { ...node, position: { x: saved.x, y: saved.y } };
    });
  }, [rfNodes, layoutSnapshot]);

  const [nodes, setNodes] = useNodesState(computedNodes);
  const [edges, setEdges] = useEdgesState(rfEdges);

  useEffect(() => { setNodes(computedNodes); }, [computedNodes, setNodes]);
  useEffect(() => { setEdges(rfEdges); },       [rfEdges, setEdges]);

  const onNodesChange = useCallback(
    (changes) => setNodes((curr) => applyNodeChanges(changes, curr)),
    [setNodes],
  );

  const nodeTypes = useMemo(() => ({ codemapNode: CodemapNode, codemapGroupNode: CodemapGroupNode }), []);
  const edgeTypes = useMemo(() => ({ codemapEdge: CodemapEdge }), []);

  const persistLayout = useCallback((nodeList) => {
    const snapshot = { nodes: {}, groups: {} };
    nodeList.forEach((node) => {
      if (!node?.id || !node?.position) return;
      snapshot.nodes[node.id] = { x: node.position.x, y: node.position.y };
    });
    groups.forEach((g) => {
      const state = groupState.get(g.id);
      if (!state) return;
      snapshot.groups[g.id] = { collapsed: !!state.collapsed };
    });
    callbacks.onLayoutChanged?.(snapshot);
  }, [groups, groupState, callbacks]);

  return React.createElement(
    "div", { className: "codemap-rf-shell" },
    React.createElement(
      ReactFlow, {
        className: "codemap-rf-canvas",
        nodes, edges, nodeTypes, edgeTypes,
        fitView: !preserveView,
        panOnDrag: true,
        zoomOnScroll: true,
        zoomOnPinch: true,
        zoomOnDoubleClick: false,
        minZoom: 0.08,
        maxZoom: 3.0,
        proOptions: { hideAttribution: true },
        onNodesChange,
        onNodeDragStop: (_event, node) => {
          setNodes((list) => {
            const next = list.map((item) => item.id === node.id ? { ...item, position: node.position } : item);
            persistLayout(next);
            return next;
          });
        },
        onNodeClick: (_event, node) => {
          if (node.type === "codemapGroupNode") {
            const { groupId, groupLabel } = node.data;
            if (groupId) callbacks.onDrilldownGroup?.(groupId, groupLabel);
          } else {
            callbacks.onNodeClick?.({ id: node.id, source: node.data?.source });
          }
        },
        onNodeDoubleClick: (_event, node) => {
          callbacks.onNodeDblClick?.({ id: node.id, source: node.data?.source });
        },
        onNodeMouseEnter: (event, node) => {
          callbacks.showTooltip?.(event, {
            id: node.id,
            label: node.data?.label || node.id,
            detail: node.data?.detail || "",
          });
        },
        onNodeMouseMove: (event) => callbacks.moveTooltip?.(event),
        onNodeMouseLeave: () => callbacks.hideTooltip?.(),
        onPaneClick: () => callbacks.onPaneClick?.(),
        onMoveEnd: (_event, viewport) => { lastViewport = viewport; },
        elementsSelectable: true,
      },
      React.createElement(Background, { color: "#12182a", gap: 24, size: 1 }),
      React.createElement(MiniMap, {
        pannable: true,
        zoomable: true,
        style: { background: "rgba(11, 14, 23, 0.84)", border: "1px solid #1f2640" },
        nodeColor: (node) => node?.data?.color || nodeKindColor(node?.data?.kind || "process"),
        maskColor: "rgba(10, 12, 18, 0.42)",
      }),
      React.createElement(CaptureFlowApi, null),
      React.createElement(FitViewOnMount, { preserveView }),
    ),
    React.createElement(GroupHierarchyOverlay, {
      groups,
      onDrilldownGroup: callbacks.onDrilldownGroup,
    }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function renderFlowchartReactFlow(graph, options = {}) {
  const { mount, callbacks = {}, preserveView = false, layoutSnapshot = null } = options;
  if (!mount) return null;

  if (!flowHost) {
    flowHost = document.createElement("div");
    flowHost.id = "react-flow-host";
    flowHost.className = "react-flow-host";
    mount.appendChild(flowHost);
  }
  if (!flowRoot) {
    flowRoot = createRoot(flowHost);
  }

  flowRoot.render(
    React.createElement(
      ReactFlowProvider, null,
      React.createElement(FlowchartGraph, {
        graph,
        callbacks: { ...callbacks, layoutSnapshot },
        preserveView,
      }),
    ),
  );

  return {
    edgeRecords: [],
    nodeRect:    new Map(),
    nodes:       Array.isArray(graph?.nodes) ? graph.nodes : [],
    sceneEl:     null,
  };
}

export function clearFlowchartReactFlow() {
  if (flowRoot) {
    flowRoot.unmount();
    flowRoot = null;
  }
  if (flowHost && flowHost.parentElement) {
    flowHost.parentElement.removeChild(flowHost);
  }
  flowHost             = null;
  lastViewport         = null;
  flowApi              = null;
  drilldownRef.current = null;
}

export function resetFlowchartReactView() {
  if (!flowApi) return;
  flowApi.fitView({ duration: 220, padding: 0.22 });
}
