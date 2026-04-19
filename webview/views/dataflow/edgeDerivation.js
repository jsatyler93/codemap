export function deriveDataFlowEdges(visibleNodes) {
  const lastWriter = {};
  const edges = [];
  for (const node of visibleNodes) {
    const meta = node.metadata || {};
    const reads = meta._aggregatedReads || meta.reads || [];
    const writes = meta._aggregatedWrites || meta.writes || [];

    for (const name of reads) {
      const src = lastWriter[name];
      if (src && src !== node.id) {
        edges.push({ from: src, to: node.id, variable: name });
      }
    }
    for (const name of writes) {
      lastWriter[name] = node.id;
    }
  }
  return edges;
}

export function computeVisibleNodes(allNodes, collapsedGroups) {
  const visible = [];
  for (const node of allNodes) {
    const meta = node.metadata || {};
    if (meta.groupRole === "start" && meta.groupId && collapsedGroups.has(meta.groupId)) {
      const aggregated = aggregateGroupEffects(allNodes, meta.groupId);
      visible.push({
        ...node,
        metadata: {
          ...meta,
          _isCollapsed: true,
          _descendantCount: aggregated.count,
          _aggregatedReads: aggregated.reads,
          _aggregatedWrites: aggregated.writes,
        },
      });
      continue;
    }

    if (isNodeHiddenByCollapsedParent(node, allNodes, collapsedGroups)) {
      continue;
    }
    visible.push(node);
  }
  return visible;
}

export function computeActiveEdges(dataFlowEdges, state) {
  if (state.selectedVariable) {
    return dataFlowEdges.filter((e) => e.variable === state.selectedVariable);
  }
  if (state.hoveredNodeId) {
    return dataFlowEdges.filter((e) => e.from === state.hoveredNodeId || e.to === state.hoveredNodeId);
  }
  return [];
}

function isNodeHiddenByCollapsedParent(node, allNodes, collapsedGroups) {
  const meta = node.metadata || {};
  if (meta.groupRole === "start") return false;
  let groupId = meta.groupId;
  while (groupId) {
    if (collapsedGroups.has(groupId)) return true;
    const header = allNodes.find((n) => (n.metadata || {}).groupRole === "start" && (n.metadata || {}).groupId === groupId);
    groupId = header ? (header.metadata || {}).parentGroup : undefined;
  }
  return false;
}

function aggregateGroupEffects(allNodes, groupId) {
  const reads = new Set();
  const writes = new Set();
  let count = 0;
  for (const node of allNodes) {
    const meta = node.metadata || {};
    if ((meta.groupRole === "start" && meta.groupId === groupId)) {
      continue;
    }
    if (!belongsToGroup(node, allNodes, groupId)) continue;
    const r = meta.reads || [];
    const w = meta.writes || [];
    r.forEach((x) => reads.add(x));
    w.forEach((x) => writes.add(x));
    count += 1;
  }
  return { reads: Array.from(reads).sort(), writes: Array.from(writes).sort(), count };
}

function belongsToGroup(node, allNodes, groupId) {
  const meta = node.metadata || {};
  let current = meta.groupId;
  while (current) {
    if (current === groupId) return true;
    const header = allNodes.find((n) => (n.metadata || {}).groupRole === "start" && (n.metadata || {}).groupId === current);
    current = header ? (header.metadata || {}).parentGroup : undefined;
  }
  return false;
}
