// Semantic-zoom controller: dispatches GraphDocument rendering based on the
// ZoomContext attached to graph.metadata. Also manages the breadcrumb bar
// and peripheral docks.

import { renderBreadcrumb } from "./breadcrumb.js";
import { renderPeripherals } from "./peripheralDock.js";
import { renderPackageView } from "../views/package/packageView.js";
import { renderModuleView } from "../views/module/moduleView.js";
import { renderUnifiedView } from "../views/unified/unifiedView.js";

/**
 * Check if a graph is a unified (continuous-zoom) graph.
 */
export function isUnifiedGraph(graph) {
  return !!(graph && graph.metadata && graph.metadata.unified);
}

/**
 * Inspect a graph for a zoomContext. Returns the level (0..3) or null if
 * this is a legacy graph that should fall through to the old dispatcher.
 */
export function getZoomLevel(graph) {
  const z = graph && graph.metadata && graph.metadata.zoomContext;
  if (!z || typeof z.level !== "number") return null;
  return z.level;
}

/**
 * Render a graph that already carries a zoomContext. Returns whatever the
 * level-specific renderer returns (same shape as the legacy renderers:
 * { edgeRecords, nodeRect, nodes, initialView }), or null if the level has
 * no dedicated renderer and the caller should fall through to the legacy
 * path (L2 → callgraph, L3 → flowchart).
 */
export function renderZoomGraph(graph, ctx) {
  if (isUnifiedGraph(graph)) return renderUnifiedView(graph, ctx);
  const level = getZoomLevel(graph);
  if (level === 0) return renderPackageView(graph, ctx);
  if (level === 1) return renderModuleView(graph, ctx);
  return null; // L2/L3 → fall through
}

/**
 * Update chrome (breadcrumb + peripheral docks) for the current graph.
 * Always safe to call; no-ops for graphs without a zoomContext.
 */
export function updateZoomChrome(elements, graph) {
  const zoom = graph && graph.metadata && graph.metadata.zoomContext;

  // Hide breadcrumb + peripheral docks for unified (continuous zoom) view
  if (isUnifiedGraph(graph)) {
    if (elements.breadcrumbBar) elements.breadcrumbBar.style.display = "none";
    if (elements.leftDock) elements.leftDock.style.display = "none";
    if (elements.rightDock) elements.rightDock.style.display = "none";
    return;
  }

  renderBreadcrumb(elements.breadcrumbBar, zoom);
  renderPeripherals(elements.leftDock, elements.rightDock, zoom);
}
