import { createStore } from "zustand/vanilla";

export const graphOverlayStore = createStore(() => ({
  graph: null,
  probeIds: [],
  probeById: {},
  resultByProbeId: {},
  activeNodeIds: [],
  viewport: null,
}));

export function setOverlayGraph(graph) {
  graphOverlayStore.setState({ graph: graph || null });
}

export function setOverlayProbes(probes) {
  const safe = Array.isArray(probes) ? probes : [];
  const byId = {};
  const ids = [];
  for (const probe of safe) {
    if (!probe || !probe.id) continue;
    byId[probe.id] = probe;
    ids.push(probe.id);
  }
  graphOverlayStore.setState((state) => ({
    probeIds: ids,
    probeById: byId,
    resultByProbeId: Object.fromEntries(
      Object.entries(state.resultByProbeId).filter(([probeId]) => !!byId[probeId]),
    ),
  }));
}

export function setOverlayProbeResult(result) {
  if (!result?.probeId) return;
  graphOverlayStore.setState((state) => ({
    resultByProbeId: { ...state.resultByProbeId, [result.probeId]: result },
  }));
}

export function clearOverlayProbeResults(nodeId) {
  if (!nodeId) {
    graphOverlayStore.setState({ resultByProbeId: {} });
    return;
  }
  graphOverlayStore.setState((state) => {
    const next = {};
    for (const [probeId, result] of Object.entries(state.resultByProbeId)) {
      if (result?.nodeId !== nodeId) next[probeId] = result;
    }
    return { resultByProbeId: next };
  });
}

export function setOverlayActiveNodes(nodeIds) {
  graphOverlayStore.setState({ activeNodeIds: Array.isArray(nodeIds) ? nodeIds : [] });
}

export function setOverlayViewport(viewport) {
  graphOverlayStore.setState({ viewport: viewport || null });
}