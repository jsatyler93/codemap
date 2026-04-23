// litegraph.js loaded externally via <script> tag - globals set on window
const LGraph = /** @type {any} */ (window).LGraph;
const LGraphCanvas = /** @type {any} */ (window).LGraphCanvas;
import { TableWidgetNode } from "./widgets/tableWidget.js";
import { PlotWidgetNode } from "./widgets/plotWidget.js";
import { HeatmapWidgetNode } from "./widgets/heatmapWidget.js";
import { HistogramWidgetNode } from "./widgets/histogramWidget.js";
import { TensorWidgetNode } from "./widgets/tensorWidget.js";
import { createProbePanel } from "./probePanel.js";
import { createPlotlyViewer } from "./plotlyViewer.js";

const WIDGET_TYPES = {
  table: TableWidgetNode,
  plot: PlotWidgetNode,
  heatmap: HeatmapWidgetNode,
  histogram: HistogramWidgetNode,
  tensor: TensorWidgetNode,
};

export function createOverlayManager({ rootEl, canvasEl, resolveNodeElement, onDismissProbe, onRegenerateProbes, onSelectNode }) {
  if (!rootEl || !canvasEl) {
    return {
      setProbes() {},
      updateProbe() {},
      clearProbes() {},
      sync() {},
      flashNode() {},
      setInteractive() {},
      clear() {},
    };
  }

  rootEl.innerHTML = "";
  const overlayEl = document.createElement("div");
  overlayEl.className = "cm-debug-overlay";
  const canvasNode = document.createElement("canvas");
  canvasNode.className = "cm-debug-overlay-canvas";
  overlayEl.appendChild(canvasNode);
  const panelHost = document.createElement("div");
  panelHost.className = "cm-probe-panel-host";
  rootEl.append(overlayEl, panelHost);

  const probeById = new Map();
  const resultById = new Map();
  const plotlyViewer = createPlotlyViewer({ rootEl, onClose: () => {} });
  const widgetNodeByProbeId = new Map();
  const graph = new LGraph();
  const graphCanvas = new LGraphCanvas(canvasNode, graph, { skip_render: true, autoresize: false });
  const panel = createProbePanel({
    rootEl: panelHost,
    onSelectNode,
    onDismissProbe,
    onRegenerateProbes,
    onOpenPlot: (probeId) => {
      const probe = probeById.get(probeId);
      const result = resultById.get(probeId);
      if (!probe || !result || result.error || result.data == null) return;
      plotlyViewer.show({ probe, result });
    },
  });
  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(rootEl);
  let interactive = false;
  let frameHandle = 0;
  let lastPanelSignature = "";

  configureCanvas(graphCanvas);
  resizeCanvas();
  scheduleFrame();

  function setProbes(probes) {
    const nextIds = new Set(probes.map((probe) => probe.id));
    for (const [probeId, node] of widgetNodeByProbeId.entries()) {
      if (!nextIds.has(probeId)) {
        graph.remove(node);
        widgetNodeByProbeId.delete(probeId);
        probeById.delete(probeId);
        resultById.delete(probeId);
      }
    }
    for (const probe of probes) {
      probeById.set(probe.id, probe);
      let node = widgetNodeByProbeId.get(probe.id);
      if (!node) {
        node = createWidgetNode(probe);
        widgetNodeByProbeId.set(probe.id, node);
        graph.add(node);
      }
      node.setProbe(probe);
      node.setResult(resultById.get(probe.id) || null);
    }
    sync();
  }

  function updateProbe(result) {
    resultById.set(result.probeId, result);
    widgetNodeByProbeId.get(result.probeId)?.setResult(result);
    sync();
  }

  function clearProbes(nodeId) {
    if (!nodeId) {
      for (const node of widgetNodeByProbeId.values()) {
        graph.remove(node);
      }
      widgetNodeByProbeId.clear();
      probeById.clear();
      resultById.clear();
      lastPanelSignature = "";
      panel.clear();
      return;
    }
    for (const [probeId, probe] of probeById.entries()) {
      if (probe.nodeId !== nodeId) continue;
      const node = widgetNodeByProbeId.get(probeId);
      if (node) graph.remove(node);
      widgetNodeByProbeId.delete(probeId);
      probeById.delete(probeId);
      resultById.delete(probeId);
    }
    sync();
  }

  function clear() {
    plotlyViewer.hide();
    clearProbes();
  }

  function sync() {
    const hostRect = canvasEl.getBoundingClientRect();
    const entries = [];
    for (const [probeId, node] of widgetNodeByProbeId.entries()) {
      const probe = probeById.get(probeId);
      if (!probe) continue;
      const result = resultById.get(probeId);
      const nodeEl = resolveNodeElement?.(probe.nodeId);
      if (!nodeEl) {
        node.pos = [-10000, -10000];
        continue;
      }
      const rect = nodeEl.getBoundingClientRect();
      const anchorX = clamp(rect.right - hostRect.left + 18, 16, Math.max(16, rootEl.clientWidth - node.size[0] - 16));
      const anchorY = clamp(rect.top - hostRect.top, 10, Math.max(10, rootEl.clientHeight - node.size[1] - 10));
      node.updateAnchor(anchorX, anchorY);
      entries.push({
        probeId: probe.id,
        nodeId: probe.nodeId,
        label: probe.label,
        meta: `${probe.widgetSpec.type} · ${result?.hitCount ? `hit ${result.hitCount}` : "waiting"}`,
        error: result?.error || "",
        canPlot: !!result && !result.error && result.data != null,
      });
    }

    const signature = JSON.stringify(entries);
    if (signature !== lastPanelSignature) {
      lastPanelSignature = signature;
      panel.setEntries(entries);
    }
    graphCanvas.draw(true, true);
  }

  function flashNode(nodeId) {
    const nodeEl = resolveNodeElement?.(nodeId);
    if (!nodeEl) return;
    nodeEl.classList.add("cm-probe-flash");
    window.setTimeout(() => nodeEl.classList.remove("cm-probe-flash"), 900);
  }

  function setInteractive(enabled) {
    interactive = !!enabled;
    canvasNode.style.pointerEvents = interactive ? "auto" : "none";
    rootEl.classList.toggle("is-interactive", interactive);
    graphCanvas.read_only = !interactive;
  }

  function createWidgetNode(probe) {
    const WidgetNodeCtor = WIDGET_TYPES[probe?.widgetSpec?.type] || TableWidgetNode;
    const node = new WidgetNodeCtor();
    node.setProbe(probe);
    return node;
  }

  function resizeCanvas() {
    const width = Math.max(1, rootEl.clientWidth || canvasEl.clientWidth || 1);
    const height = Math.max(1, rootEl.clientHeight || canvasEl.clientHeight || 1);
    canvasNode.width = width;
    canvasNode.height = height;
    canvasNode.style.width = `${width}px`;
    canvasNode.style.height = `${height}px`;
    if (graphCanvas.ds) {
      graphCanvas.ds.scale = 1;
      graphCanvas.ds.offset[0] = 0;
      graphCanvas.ds.offset[1] = 0;
    }
    graphCanvas.setDirty(true, true);
  }

  function scheduleFrame() {
    cancelAnimationFrame(frameHandle);
    const tick = () => {
      sync();
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
  }

  return { setProbes, updateProbe, clearProbes, sync, flashNode, setInteractive, clear };
}

function configureCanvas(graphCanvas) {
  graphCanvas.allow_dragcanvas = false;
  graphCanvas.allow_dragnodes = true;
  graphCanvas.allow_interaction = true;
  graphCanvas.render_shadows = false;
  graphCanvas.live_mode = true;
  graphCanvas.show_info = false;
  graphCanvas.background_image = null;
  graphCanvas.clear_background = false;
  graphCanvas.clear_background_color = null;
  if (graphCanvas.ds) {
    graphCanvas.ds.scale = 1;
    graphCanvas.ds.offset[0] = 0;
    graphCanvas.ds.offset[1] = 0;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}