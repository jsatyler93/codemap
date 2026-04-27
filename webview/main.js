// Webview entry point. Receives GraphDocument JSON from the extension host
// and dispatches to the appropriate view renderer.

import { NS, makeSvgCanvas } from "./shared/panZoom.js";
import { cubicPt } from "./shared/geometry.js";
import { animate as motionAnimate } from "motion";
import { clearCallGraphReactFlow, renderCallGraphReactFlow, resetCallGraphReactView } from "./views/callgraph/reactFlowCallGraphView.js";
import { renderFlowchart } from "./views/flowchart/flowchartView.js";
import { clearFlowchartReactFlow, renderFlowchartReactFlow, resetFlowchartReactView } from "./views/flowchart/reactFlowView.js";
import { createNarrationPanel } from "./views/narration/narrationPanel.js";
import { createOverlayManager } from "./views/debugOverlay/overlayManager.js";
import { decodePackedBase64 } from "./utils/packedTransport.js";
import {
  clearOverlayProbeResults,
  setOverlayActiveNodes,
  setOverlayGraph,
  setOverlayProbeResult,
  setOverlayProbes,
} from "./state/graphOverlayStore.js";
import { renderCallGraph } from "./views/callgraph/callGraphView.js";
import { renderDataflowView, removeDataflowOverlay } from "./views/dataflow/dataflowView.js";
import { clearSuperimposedDataflow, renderSuperimposedDataflow } from "./views/dataflow/superimposedOverlay.js";

const vscode = window.__codemapVscode || acquireVsCodeApi();

const canvasEl   = document.getElementById("canvas");
const tooltip    = document.getElementById("tooltip");
const titleEl    = document.getElementById("title");
const statsEl    = document.getElementById("stats");
const execBtn    = document.getElementById("btn-exec");
const stepBtn    = document.getElementById("btn-step");
const aiToggle   = document.getElementById("toggle-ai");
const functionCallsToggle = document.getElementById("toggle-function-calls");
const probeInteractToggle = document.getElementById("toggle-probe-interact");
const narrateBtn = document.getElementById("btn-narrate");
const resetBtn   = document.getElementById("btn-reset");
const clearBtn   = document.getElementById("btn-clear");
const refreshBtn = document.getElementById("btn-refresh");
const overlayLegacyToggle = document.getElementById("toggle-overlay-legacy");
const overlayModernToggle = document.getElementById("toggle-overlay-modern");
const searchBox  = document.getElementById("search-box");
const canvasControls = document.getElementById("canvas-controls");
const collapseGroupsBtn = document.getElementById("btn-collapse-groups");
const expandGroupsBtn = document.getElementById("btn-expand-groups");
const overlayLegacyLabel = overlayLegacyToggle ? overlayLegacyToggle.closest("label") : null;
const overlayModernLabel = overlayModernToggle ? overlayModernToggle.closest("label") : null;
const breadcrumbEl = document.getElementById("flowchart-breadcrumb");
const narrationRoot = document.getElementById("narration-root");
const debugOverlayRoot = document.getElementById("debug-overlay-root");

const canvas = makeSvgCanvas(canvasEl);
let current = null; // { edgeRecords, nodeRect, nodes, initialView }
let currentGraph = null;
let time = 0;
let uiState = { showEvidence: false, showFunctionCalls: true, narrationEnabled: true, repelStrength: 0.45, attractStrength: 0.32, ambientRepelStrength: 0.18, cohesionStrength: 0.34, layoutMode: "lanes", treeView: false, canvasBrightness: 1.0, canvasThemeMode: "codemap" };
let overlayPrefs = { showLegacyOverlay: true, showModernOverlay: true };
let lastStepParticleAt = 0;
let pendingUiStateRender = null;
let pendingFlowchartRenderSanityCheck = null;
const LAYOUT_STORAGE_PREFIX = "codemap.layout.v3:";
const STEP_PARTICLE_INTERVAL_MS = 1150;
const USE_REACT_FLOW_FLOWCHART = true;
const USE_REACT_FLOW_CALLGRAPH = true;

/** Current breadcrumb trail for progressive flowchart reading. */
let previousFlowchartBreadcrumb = [];
let flowchartBreadcrumb = []; // [{groupId, label}, ...]
let flowchartTransitionToken = 0;
let currentNarrationScript = null;

function showTooltip(e, n) {
  if (n && n.tooltipKind === "edge") {
    const meta = n.metadata || {};
    const sourceTypes = Array.isArray(meta.sourceTypeBits) ? meta.sourceTypeBits : [];
    const targetTypes = Array.isArray(meta.targetTypeBits) ? meta.targetTypeBits : [];
    const edgeLabel = meta.edgeLabel ? `<div class="tt-conn">${escapeHtml(meta.edgeLabel)}</div>` : "";
    const sourceBlock = sourceTypes.length
      ? `<div class="tt-section"><div class="tt-section-title">Known Types Leaving Source</div>${sourceTypes.map((line) => `<div class="tt-section-row">${escapeHtml(line)}</div>`).join("")}</div>`
      : "";
    const targetBlock = targetTypes.length
      ? `<div class="tt-section"><div class="tt-section-title">Known Types At Next Node</div>${targetTypes.map((line) => `<div class="tt-section-row">${escapeHtml(line)}</div>`).join("")}</div>`
      : "";
    tooltip.innerHTML = `
      <div class="tt-type">edge flow</div>
      <div class="tt-func">${escapeHtml(meta.fromLabel || "")} → ${escapeHtml(meta.toLabel || "")}</div>
      ${edgeLabel}
      ${(sourceBlock || targetBlock) ? `${sourceBlock}${targetBlock}` : `<div class="tt-file">No strong type evidence on this edge yet</div>`}
    `;
    tooltip.style.opacity = "1";
    moveTooltip(e);
    return;
  }
  const meta = n.metadata || {};
  const module = n.module || "";
  const sig = meta.params
    ? `<div class="tt-code">(${meta.params.map(formatParam).join(", ")})${meta.returnType ? " -> " + escapeHtml(meta.returnType) : ""}</div>`
    : "";
  const doc = meta.docSummary
    ? `<div style="color:#9ece6a;margin-top:4px">${escapeHtml(meta.docSummary)}</div>`
    : "";
  const connLine = (typeof n._connOut === "number")
    ? `<div class="tt-conn">↗ ${n._connOut} out · ↙ ${n._connIn} in</div>`
    : "";
  const evidence = uiState.showEvidence ? buildEvidenceHtml(meta) : "";
  tooltip.innerHTML = `
    ${module ? `<div class="tt-module">${escapeHtml(module)}</div>` : ""}
    <div class="tt-func">${escapeHtml(n.label || n.id)}</div>
    ${sig}${doc}
    ${n.source ? `<div class="tt-file">${escapeHtml(shortPath(n.source.file))}:${n.source.line}</div>` : ""}
    ${connLine}
    ${evidence}
  `;
  tooltip.style.opacity = "1";
  moveTooltip(e);
}

function formatParam(p) {
  let s = escapeHtml(p.name);
  if (p.vararg) s = "*" + s;
  if (p.kwarg)  s = "**" + s;
  if (p.type)   s += `: <span style="color:#bb9af7">${escapeHtml(p.type)}</span>`;
  if (p.default !== undefined) s += ` = ${escapeHtml(p.default)}`;
  return s;
}

function buildEvidenceHtml(meta) {
  const lines = [];
  const params = Array.isArray(meta.params) ? meta.params : [];
  params.forEach((param) => {
    if (!param.type || (!param.typeSource && !param.typeConfidence)) return;
    lines.push(`${escapeHtml(param.name)}: ${formatEvidenceBits(param.typeSource, param.typeConfidence)}`);
  });
  if (meta.returnType && (meta.returnTypeSource || meta.returnTypeConfidence)) {
    lines.push(`returns: ${formatEvidenceBits(meta.returnTypeSource, meta.returnTypeConfidence)}`);
  }
  appendAttributeEvidence(lines, "class", meta.classAttributes);
  appendAttributeEvidence(lines, "instance", meta.instanceAttributes);
  if (!lines.length) return "";
  const body = lines.slice(0, 5).map((line) => `<div class="tt-evidence-row">${line}</div>`).join("");
  const extra = lines.length > 5
    ? `<div class="tt-evidence-more">+${lines.length - 5} more evidence items</div>`
    : "";
  return `<div class="tt-evidence"><div class="tt-evidence-title">Evidence</div>${body}${extra}</div>`;
}

function appendAttributeEvidence(lines, label, attrs) {
  if (!Array.isArray(attrs)) return;
  attrs.forEach((attr) => {
    if (!attr?.name || !attr?.type || (!attr.typeSource && !attr.typeConfidence)) return;
    lines.push(`${escapeHtml(label)} ${escapeHtml(attr.name)}: ${formatEvidenceBits(attr.typeSource, attr.typeConfidence)}`);
  });
}

function formatEvidenceBits(source, confidence) {
  const bits = [];
  if (source) bits.push(escapeHtml(String(source)));
  if (confidence) bits.push(`<span class="tt-evidence-confidence">${escapeHtml(String(confidence))}</span>`);
  return bits.join(" · ");
}

function moveTooltip(e) {
  tooltip.style.left = (e.clientX + 16) + "px";
  tooltip.style.top  = (e.clientY - 10) + "px";
}
function hideTooltip() { tooltip.style.opacity = "0"; }

function onNodeClick(n) {
  vscode.postMessage({ type: "revealNode", nodeId: n.id, source: n.source });
}

function onNodeDblClick(n) {
  // Request flowchart for this function (cross-layer navigation)
  vscode.postMessage({ type: "requestFlowchart", nodeId: n.id, source: n.source });
}

function applyNarrationAvailability() {
  const enabled = uiState.narrationEnabled !== false;
  if (aiToggle) aiToggle.checked = enabled;
  if (probeInteractToggle) {
    probeInteractToggle.disabled = !enabled;
    if (!enabled) probeInteractToggle.checked = false;
  }
  if (narrateBtn) {
    narrateBtn.hidden = !enabled;
    narrateBtn.disabled = !enabled;
    narrateBtn.title = enabled ? "Generate narration for the current graph" : "Copilot narration is turned off in Controls";
  }
  if (!enabled && currentNarrationScript) {
    currentNarrationScript = null;
    narrationPanel.clear();
  }
  if (!enabled) {
    debugOverlay.clear();
  }
  applyProbeOverlayInteraction();
}

function applyProbeOverlayInteraction() {
  const enabled = uiState.narrationEnabled !== false && !!probeInteractToggle?.checked;
  debugOverlay.setInteractive(enabled);
}

function narrationByNodeId() {
  if (uiState.narrationEnabled === false || !currentNarrationScript || currentNarrationScript.kind !== "flowchart") {
    return {};
  }
  const out = {};
  for (const step of currentNarrationScript.steps || []) {
    if (!step.nodeId || !step.narration) continue;
    out[step.nodeId] = step.narration;
  }
  return out;
}

// Click on empty canvas → reset selection
canvasEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-id]")) return;
  if (renderCtx._resetSelection) renderCtx._resetSelection();
});

// Render context shared across calls — renderers attach helpers here
const renderCtx = {};

// ── Exec trace state ──
let execStep = -1;
let execAutoMode = false;
let execStepMode = false;
let execAutoTimer = null;
let execDots = [];
const EXEC_AUTO_INTERVAL = 1800;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function updateStats(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  titleEl.textContent = graph.title || "CodeMap";
  const parts = [`${nodes.length} nodes`, `${edges.length} edges`];
  const meta = graph.metadata || {};
  const summary = meta.analysisSummary || null;
  if (summary && typeof summary.typeCoveragePct === "number") {
    parts.push(`${summary.typeCoveragePct}% typed`);
  }
  statsEl.textContent = parts.join(" · ");
}

function createSceneRoot(graphType) {
  const scene = document.createElementNS(NS, "g");
  scene.dataset.sceneLayer = "true";
  scene.dataset.graphType = graphType || "graph";
  canvas.root.appendChild(scene);
  return scene;
}

function clearSceneLayers() {
  Array.from(canvas.root.children).forEach((child) => {
    if (child?.dataset?.sceneLayer === "true") {
      canvas.root.removeChild(child);
    }
  });
}

function retainOnlySceneLayer(sceneEl) {
  Array.from(canvas.root.children).forEach((child) => {
    if (child?.dataset?.sceneLayer === "true" && child !== sceneEl) {
      canvas.root.removeChild(child);
    }
  });
}

function clearDefs() {
  while (canvas.defs.firstChild) canvas.defs.removeChild(canvas.defs.firstChild);
}

function shouldAnimateFlowchartTransition(graph, previousGraph, previousRender, options) {
  return !!(
    graph?.graphType === "flowchart"
    && previousGraph?.graphType === "flowchart"
    && previousRender?.sceneEl
    && previousRender.sceneEl.isConnected
    && !options.preserveView
    && !options.disableSceneTransition
  );
}

function collectSceneTransitionElements(sceneEl, selector, attributeName) {
  const result = new Map();
  if (!sceneEl) return result;
  sceneEl.querySelectorAll(selector).forEach((element) => {
    const key = element.dataset?.[attributeName];
    if (!key) return;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(element);
  });
  return result;
}

function elementVisualCenter(element) {
  try {
    const box = element.getBBox();
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

function computeTransitionAnchors(oldNodes, newNodes, oldScene, newScene) {
  // Semantic semantic zooming: if breadcrumb changed, we know where we came from
  // Drilldown (Zoom IN)
  if (flowchartBreadcrumb.length > previousFlowchartBreadcrumb.length) {
    const targetGroup = flowchartBreadcrumb[flowchartBreadcrumb.length - 1];
    if (targetGroup && targetGroup.groupId) {
      const groupKey = `group:${targetGroup.groupId}`;
      if (oldNodes.has(groupKey)) {
        const center = elementVisualCenter(oldNodes.get(groupKey)[0]);
        let newCenter = center;
        try {
          const newBox = newScene?.getBBox();
          if (newBox && Number.isFinite(newBox.width)) {
            newCenter = { x: newBox.x + newBox.width / 2, y: newBox.y + newBox.height / 2 };
          }
        } catch {}
        return { oldAnchor: center, newAnchor: newCenter, hasCommon: false, semanticZoom: "in", focalKey: groupKey };
      }
    }
  }
  // Collapse (Zoom OUT)
  if (flowchartBreadcrumb.length < previousFlowchartBreadcrumb.length) {
    const targetGroup = previousFlowchartBreadcrumb[previousFlowchartBreadcrumb.length - 1];
    if (targetGroup && targetGroup.groupId) {
      const groupKey = `group:${targetGroup.groupId}`;
      if (newNodes.has(groupKey)) {
        const center = elementVisualCenter(newNodes.get(groupKey)[0]);
        let oldCenter = center;
        try {
          const oldBox = oldScene?.getBBox();
          if (oldBox && Number.isFinite(oldBox.width)) {
            oldCenter = { x: oldBox.x + oldBox.width / 2, y: oldBox.y + oldBox.height / 2 };
          }
        } catch {}
        return { oldAnchor: oldCenter, newAnchor: center, hasCommon: false, semanticZoom: "out", focalKey: groupKey };
      }
    }
  }

  const oldCommon = [];
  const newCommon = [];
  newNodes.forEach((elements, key) => {
    if (!oldNodes.has(key)) return;
    oldCommon.push(elementVisualCenter(oldNodes.get(key)[0]));
    newCommon.push(elementVisualCenter(elements[0]));
  });
  if (oldCommon.length && newCommon.length) {
    return {
      oldAnchor: {
        x: oldCommon.reduce((sum, point) => sum + point.x, 0) / oldCommon.length,
        y: oldCommon.reduce((sum, point) => sum + point.y, 0) / oldCommon.length,
      },
      newAnchor: {
        x: newCommon.reduce((sum, point) => sum + point.x, 0) / newCommon.length,
        y: newCommon.reduce((sum, point) => sum + point.y, 0) / newCommon.length,
      },
      hasCommon: true,
      semanticZoom: "none"
    };
  }
  try {
    const newBox = newScene?.getBBox();
    if (newBox && Number.isFinite(newBox.width)) {
      const center = { x: newBox.x + newBox.width / 2, y: newBox.y + newBox.height / 2 };
      return { oldAnchor: center, newAnchor: center, hasCommon: false, semanticZoom: "none" };
    }
  } catch {}
  try {
    const oldBox = oldScene?.getBBox();
    if (oldBox && Number.isFinite(oldBox.width)) {
      const center = { x: oldBox.x + oldBox.width / 2, y: oldBox.y + oldBox.height / 2 };
      return { oldAnchor: center, newAnchor: center, hasCommon: false, semanticZoom: "none" };
    }
  } catch {}
  return { oldAnchor: { x: 0, y: 0 }, newAnchor: { x: 0, y: 0 }, hasCommon: false, semanticZoom: "none" };
}

const activeSceneAnimations = new WeakMap();

function animateSceneElement(element, keyframes, options) {
  element.style.transformBox = "fill-box";
  element.style.transformOrigin = "center";
  const previousAnimation = activeSceneAnimations.get(element);
  if (previousAnimation) {
    if (typeof previousAnimation.stop === "function") previousAnimation.stop();
    else if (typeof previousAnimation.cancel === "function") previousAnimation.cancel();
  }

  const last = keyframes[keyframes.length - 1] || {};
  const finish = () => {
    if (last.opacity !== undefined) element.style.opacity = String(last.opacity);
    if (last.transform !== undefined) element.style.transform = String(last.transform);
    if (activeSceneAnimations.get(element) === animation) {
      activeSceneAnimations.delete(element);
    }
  };

  let animation = null;
  try {
    const properties = {};
    const trackedProps = new Set();
    keyframes.forEach((frame) => {
      Object.keys(frame || {}).forEach((prop) => trackedProps.add(prop));
    });
    trackedProps.forEach((prop) => {
      let previousValue;
      properties[prop] = keyframes.map((frame, index) => {
        if (frame && frame[prop] !== undefined) {
          previousValue = frame[prop];
          return frame[prop];
        }
        if (previousValue !== undefined) return previousValue;
        if (prop === "opacity") return getComputedStyle(element).opacity;
        if (prop === "transform") return element.style.transform || "none";
        return "";
      });
    });

    animation = motionAnimate(element, properties, {
      duration: ((options?.duration ?? 0) / 1000) || 0,
      delay: ((options?.delay ?? 0) / 1000) || 0,
      easing: options?.easing || "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    activeSceneAnimations.set(element, animation);
    if (animation?.finished && typeof animation.finished.then === "function") {
      animation.finished.then(finish, finish);
    } else {
      finish();
    }
    return animation;
  } catch {
    finish();
    return null;
  }
}

function finishWhenAnimationsSettle(animations, onDone) {
  const pending = animations
    .filter(Boolean)
    .map((animation) => animation?.finished && typeof animation.finished.then === "function"
      ? animation.finished.catch(() => undefined)
      : Promise.resolve());
  Promise.allSettled(pending).then(onDone);
}

function animateFlowchartSceneTransition(previousRender, nextRender) {
  const token = ++flowchartTransitionToken;
  const oldScene = previousRender?.sceneEl;
  const newScene = nextRender?.sceneEl;
  if (!oldScene || !newScene) return;

  oldScene.style.pointerEvents = "none";
  newScene.style.pointerEvents = "none";

  const oldNodes = collectSceneTransitionElements(oldScene, "[data-transition-key]", "transitionKey");
  const newNodes = collectSceneTransitionElements(newScene, "[data-transition-key]", "transitionKey");
  const oldEdges = collectSceneTransitionElements(oldScene, "[data-edge-key]", "edgeKey");
  const newEdges = collectSceneTransitionElements(newScene, "[data-edge-key]", "edgeKey");
  const phaseFadeOutMs = 340;
  const phaseMoveMs = 560;
  const phaseFadeInMs = 320;
  const fadeEase = "ease-out";
  const moveEase = "cubic-bezier(0.22, 1, 0.36, 1)";
  const enterEase = "ease-in-out";
  const motionThreshold = 6;
  const animations = [];

  function bbox(element) {
    try { return element.getBBox(); } catch { return null; }
  }
  function centerOf(elements) {
    if (!elements || !elements[0]) return null;
    const b = bbox(elements[0]);
    if (!b) return null;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  // Make sure scene containers have NO transforms — every motion is per-element.
  oldScene.style.transform = "none";
  oldScene.style.opacity = "1";
  newScene.style.transform = "none";
  newScene.style.opacity = "1";

  const sharedNodeKeys = new Set([...newNodes.keys()].filter((k) => oldNodes.has(k)));
  const sharedEdgeKeys = new Set([...newEdges.keys()].filter((k) => oldEdges.has(k)));
  const exitingNodeKeys = [...oldNodes.keys()].filter((key) => !sharedNodeKeys.has(key));
  const enteringNodeKeys = [...newNodes.keys()].filter((key) => !sharedNodeKeys.has(key));

  function phaseDelay(startMs, durationMs) {
    return { delay: startMs, duration: durationMs };
  }

  // Start with only the old frame visible. New-only content stays hidden until phase 3.
  enteringNodeKeys.forEach((key) => {
    newNodes.get(key).forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translate(0px, 8px) scale(0.985)";
    });
  });
  newEdges.forEach((elements) => {
    elements.forEach((el) => {
      el.style.opacity = "0";
    });
  });
  sharedNodeKeys.forEach((key) => {
    newNodes.get(key).forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translate(0px, 0px)";
    });
  });

  // Phase 1: old-only fade. Nothing moves yet.
  exitingNodeKeys.forEach((key) => {
    oldNodes.get(key).forEach((el) => {
      animations.push(animateSceneElement(el, [
        { opacity: 1, transform: "translate(0px, 0px) scale(1)" },
        { opacity: 0, transform: "translate(0px, -4px) scale(0.985)" },
      ], { ...phaseDelay(0, phaseFadeOutMs), easing: fadeEase }));
    });
  });
  oldEdges.forEach((elements) => {
    elements.forEach((el) => {
      animations.push(animateSceneElement(el, [
        { opacity: 1 },
        { opacity: 0 },
      ], { ...phaseDelay(Math.round(phaseFadeOutMs * 0.2), Math.round(phaseFadeOutMs * 0.9)), easing: fadeEase }));
    });
  });

  // Phase 2: only the shared nodes glide from the old frame to the new frame.
  sharedNodeKeys.forEach((key) => {
    const oldC = centerOf(oldNodes.get(key));
    const newC = centerOf(newNodes.get(key));
    const dx = oldC && newC ? oldC.x - newC.x : 0;
    const dy = oldC && newC ? oldC.y - newC.y : 0;
    const distance = Math.hypot(dx, dy);
    const shouldMove = distance > motionThreshold;

    oldNodes.get(key).forEach((el) => {
      animations.push(animateSceneElement(el, [
        { opacity: 1 },
        { opacity: 0 },
      ], { ...phaseDelay(phaseFadeOutMs, 20), easing: "linear" }));
    });

    newNodes.get(key).forEach((el) => {
      el.style.opacity = "1";
      el.style.transform = shouldMove ? `translate(${dx}px, ${dy}px)` : "translate(0px, 0px)";
      animations.push(animateSceneElement(el, [
        { opacity: 1, transform: shouldMove ? `translate(${dx}px, ${dy}px)` : "translate(0px, 0px)" },
        { opacity: 1, transform: "translate(0px, 0px)" },
      ], { ...phaseDelay(phaseFadeOutMs, shouldMove ? phaseMoveMs : 40), easing: moveEase }));
    });
  });

  // Phase 3: new structure fades in after the shared nodes have settled.
  const phase3Start = phaseFadeOutMs + phaseMoveMs;
  enteringNodeKeys.forEach((key) => {
    newNodes.get(key).forEach((el) => {
      el.style.opacity = "1";
      animations.push(animateSceneElement(el, [
        { opacity: 0, transform: "translate(0px, 8px) scale(0.985)" },
        { opacity: 1, transform: "translate(0px, 0px) scale(1)" },
      ], { ...phaseDelay(phase3Start, phaseFadeInMs), easing: enterEase }));
    });
  });
  sharedEdgeKeys.forEach((key) => {
    newEdges.get(key).forEach((el) => {
      el.style.opacity = "1";
      animations.push(animateSceneElement(el, [
        { opacity: 0 },
        { opacity: 1 },
      ], { ...phaseDelay(phase3Start + 40, Math.round(phaseFadeInMs * 0.85)), easing: enterEase }));
    });
  });
  newEdges.forEach((elements, key) => {
    if (sharedEdgeKeys.has(key)) return;
    elements.forEach((el) => {
      el.style.opacity = "1";
      animations.push(animateSceneElement(el, [
        { opacity: 0 },
        { opacity: 1 },
      ], { ...phaseDelay(phase3Start + 80, Math.round(phaseFadeInMs * 0.8)), easing: enterEase }));
    });
  });

  finishWhenAnimationsSettle(animations, () => {
    if (token !== flowchartTransitionToken) return;
    if (oldScene.isConnected) oldScene.remove();
    newScene.style.pointerEvents = "auto";
    newScene.style.opacity = "1";
    newScene.style.transform = "none";
    retainOnlySceneLayer(newScene);
  });
}

function renderGraph(graph, options = {}) {
  if (!graph || typeof graph !== "object") return;
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.edges)) graph.edges = [];
  const previousGraph = currentGraph;
  const previousRender = current;
  currentGraph = graph;
  updateOverlayControls(graph);
  const animateFlowchartTransition = shouldAnimateFlowchartTransition(graph, previousGraph, previousRender, options);
  const preservedView = (options.preserveView || animateFlowchartTransition)
    ? { scale: canvas.state.scale, panX: canvas.state.panX, panY: canvas.state.panY }
    : null;

  // Compute progressive mode: use explicit option when provided (initial renders),
  // otherwise derive from current breadcrumb state so requestRender re-renders
  // inside the flowchart get the correct mode automatically.
  const progressiveMode = options.progressiveMode !== undefined
    ? options.progressiveMode
    : graph.graphType === "flowchart"
      ? (flowchartBreadcrumb.length > 0 ? "drilldown" : "overview")
      : "none";

  // Reset exec trace state
  execStep = -1;
  execAutoMode = false;
  execStepMode = false;
  if (execAutoTimer) { clearInterval(execAutoTimer); execAutoTimer = null; }
  execDots = [];
  execBtn.classList.remove("active");
  stepBtn.classList.remove("active");
  // Reset runtime debug state
  runtimeHighlightedIds = [];
  runtimePrevPrimaryNodeId = null;
  // Reset shared context
  Object.keys(renderCtx).forEach((k) => delete renderCtx[k]);

  try {
    const useReactFlowForFlowchart = USE_REACT_FLOW_FLOWCHART && !options.forceLegacyFlowchart && graph.graphType === "flowchart";
    const useReactFlowForCallGraph = USE_REACT_FLOW_CALLGRAPH && (graph.graphType === "callgraph" || graph.graphType === "workspace" || graph.graphType === "trace");
    removeDataflowOverlay();
    clearSuperimposedDataflow(canvas.root);
    if (!useReactFlowForFlowchart) {
      clearFlowchartReactFlow();
    }
    if (!useReactFlowForCallGraph) {
      clearCallGraphReactFlow();
    }
    if (canvas.clearScaleListeners) canvas.clearScaleListeners();
    if (animateFlowchartTransition) {
      retainOnlySceneLayer(previousRender?.sceneEl || null);
      clearDefs();
    } else {
      if (!useReactFlowForFlowchart && !useReactFlowForCallGraph) {
        canvas.clear();
      } else {
        clearSceneLayers();
        clearDefs();
      }
    }
    const sceneRoot = (useReactFlowForFlowchart || useReactFlowForCallGraph) ? null : createSceneRoot(graph.graphType);
    const layoutKey = buildLayoutStorageKey(graph, uiState.layoutMode || (uiState.treeView ? "tree" : "lanes"));
    const ctx = {
      root: sceneRoot,
      defs: canvas.defs,
      canvas: canvas,
      uiState,
      layoutSnapshot: loadLayoutSnapshot(layoutKey),
      onLayoutChanged: (snapshot) => saveLayoutSnapshot(layoutKey, snapshot),
      requestRender: () => {
        if (currentGraph) renderGraph(currentGraph, { preserveView: true });
      },
      showTooltip, moveTooltip, hideTooltip, onNodeClick,
      onNodeDblClick,
      // Progressive flowchart reading mode: "overview" | "drilldown" | "none"
      progressiveMode,
      // Called by flowchartView when the user triggers a drilldown on a group.
      onDrilldownGroup(groupId, label) {
        vscode.postMessage({ type: "drilldownFlowchart", groupId, label });
      },
    };

    let result;
    if (graph.graphType === "dataflow") {
      result = renderDataflowView(graph);
      current = result || { edgeRecords: [], nodeRect: new Map(), nodes: graph.nodes };
      updateStats(graph);
      updateLegend(graph);
      updateCanvasControls(graph);
      debugOverlay.sync();
      return;
    }

    if (useReactFlowForFlowchart) {
      result = renderFlowchartReactFlow(graph, {
        mount: canvasEl,
        preserveView: !!options.preserveView,
        layoutSnapshot: ctx.layoutSnapshot,
        flowchartViewMode: uiState.flowchartViewMode || "grouped",
        showFunctionCalls: uiState.showFunctionCalls !== false,
        narrationByNodeId: narrationByNodeId(),
        callbacks: {
          onNodeClick,
          onNodeDblClick,
          showTooltip,
          moveTooltip,
          hideTooltip,
          onLayoutChanged: ctx.onLayoutChanged,
          onDrilldownGroup: ctx.onDrilldownGroup,
          flowchartBreadcrumb,
          onNavigateBreadcrumb: (breadcrumbIndex) => {
            vscode.postMessage({ type: "flowchartBreadcrumbNavigate", breadcrumbIndex });
          },
          onPaneClick: () => {
            if (renderCtx._resetSelection) renderCtx._resetSelection();
          },
        },
      });
      renderCtx._resetView = () => resetFlowchartReactView();
      scheduleFlowchartRenderSanityCheck(graph, options);
    } else if (graph.graphType === "flowchart") {
      result = renderFlowchart(graph, ctx);
    } else if (useReactFlowForCallGraph) {
      result = renderCallGraphReactFlow(graph, {
        mount: canvasEl,
        preserveView: !!options.preserveView,
        layoutSnapshot: ctx.layoutSnapshot,
        uiState,
        callbacks: {
          onNodeClick,
          onNodeDblClick,
          showTooltip,
          moveTooltip,
          hideTooltip,
          onLayoutChanged: ctx.onLayoutChanged,
          onPaneClick: () => {
            if (renderCtx._resetSelection) renderCtx._resetSelection();
          },
        },
      });
      renderCtx._resetView = () => resetCallGraphReactView();
    } else {
      result = renderCallGraph(graph, ctx);
    }
    current = {
      ...(result || { edgeRecords: [], nodeRect: new Map(), nodes: graph.nodes }),
      sceneEl: sceneRoot,
      renderer: (useReactFlowForFlowchart || useReactFlowForCallGraph) ? "reactflow" : "svg",
    };

    // Copy renderer-attached helpers into shared renderCtx
    Object.keys(ctx).forEach((k) => { if (k.startsWith("_")) renderCtx[k] = ctx[k]; });
    if (result) {
      Object.keys(result).forEach((k) => { if (k.startsWith("_")) renderCtx[k] = result[k]; });
    }

    updateStats(graph);

    // Inject exec timeline from graph metadata if present
    const timeline = graph.metadata && graph.metadata.execTimeline;
    if (timeline && Array.isArray(timeline) && timeline.length > 0) {
      renderCtx._execTimeline = timeline;
    }

    if (!useReactFlowForFlowchart && !useReactFlowForCallGraph) {
      if (preservedView) {
        canvas.reset(preservedView);
      } else if (current.initialView) {
        canvas.reset(current.initialView);
      } else {
        canvas.reset();
      }
    }

    if (animateFlowchartTransition && !useReactFlowForFlowchart && !useReactFlowForCallGraph) {
      animateFlowchartSceneTransition(previousRender, current);
    } else if (sceneRoot) {
      sceneRoot.style.pointerEvents = "auto";
    }

    updateExecPanel(graph);
    updateLegend(graph);
    updateCanvasControls(graph);
    debugOverlay.sync();
    // Refresh the breadcrumb bar in case graph type changed.
    updateBreadcrumbUi();
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    vscode.postMessage({ type: "debug", message: "[render-error] " + msg });
  }
}

function scheduleFlowchartRenderSanityCheck(graph, options = {}) {
  if (pendingFlowchartRenderSanityCheck) {
    clearTimeout(pendingFlowchartRenderSanityCheck);
    pendingFlowchartRenderSanityCheck = null;
  }
  if (!graph || graph.graphType !== "flowchart" || options.forceLegacyFlowchart) return;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return;
  pendingFlowchartRenderSanityCheck = window.setTimeout(() => {
    pendingFlowchartRenderSanityCheck = null;
    if (currentGraph !== graph) return;
    // React Flow flowchart host is created inside #canvas by reactFlowView.js
    // with id="react-flow-host". Look it up via that id OR via the
    // .react-flow-host class so we stay resilient to future renames.
    const host =
      document.getElementById("react-flow-host") ||
      canvasEl.querySelector(".react-flow-host");
    const viewport = host?.querySelector(".react-flow__viewport");
    const nodeEls = host?.querySelectorAll(".react-flow__node") || [];
    if (viewport && nodeEls.length > 0) return;
    vscode.postMessage({
      type: "debug",
      message: `[render-fallback] flowchart React Flow did not mount visible nodes for ${graph.title}; retrying with SVG`,
    });
    renderGraph(graph, { ...options, preserveView: true, forceLegacyFlowchart: true });
  }, 140);
}

function safeRenderSuperimposed(graph, result, ctx) {
  if (graph.graphType !== "flowchart") return;
  try {
    renderSuperimposedDataflow(graph, ctx.root, result || {}, overlayPrefs);
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    vscode.postMessage({ type: "debug", message: "[overlay-error] " + msg });
  }
}

function updateOverlayControls(graph) {
  const isFlowchart = !!graph && graph.graphType === "flowchart";
  const showFlowchartOverlays = isFlowchart && !USE_REACT_FLOW_FLOWCHART;
  if (overlayLegacyLabel) {
    overlayLegacyLabel.style.display = showFlowchartOverlays ? "inline-flex" : "none";
  }
  if (overlayModernLabel) {
    overlayModernLabel.style.display = showFlowchartOverlays ? "inline-flex" : "none";
  }
}

function scheduleUiStateRender() {
  if (!currentGraph) return;
  if (pendingUiStateRender) clearTimeout(pendingUiStateRender);
  pendingUiStateRender = setTimeout(() => {
    pendingUiStateRender = null;
    const mode = flowchartBreadcrumb.length > 0 ? "drilldown"
      : currentGraph.graphType === "flowchart" ? "overview" : "none";
    renderGraph(currentGraph, { preserveView: true, progressiveMode: mode });
  }, 70);
}

function updateLegend(graph) {
  const lgItems = document.getElementById("lg-items");
  const lgTitle = document.getElementById("lg-title");
  const legendEl = document.getElementById("legend");
  if (!lgItems) return;
  lgItems.innerHTML = "";
  let itemCount = 0;
  if (graph.graphType === "flowchart") {
    lgTitle.textContent = "Node Types";
    const types = [
      { color: "#9ece6a", label: "entry / exit" },
      { color: "#7aa2f7", label: "process" },
      { color: "#e0af68", label: "decision" },
      { color: "#7dcfff", label: "loop" },
      { color: "#ff9e64", label: "break" },
      { color: "#73daca", label: "continue" },
      { color: "#c0caf5", label: "loop else" },
      { color: "#f7768e", label: "error / raise" },
      { color: "#bb9af7", label: "compute" },
      { color: "#73daca", label: "output" },
    ];
    for (const t of types) {
      const d = document.createElement("div");
      d.className = "lg-item";
      d.innerHTML = `<span class="lg-shape" style="background:${t.color}20;border:1px solid ${t.color}"></span>${t.label}`;
      lgItems.appendChild(d);
      itemCount += 1;
    }
  } else {
    lgTitle.textContent = "Modules";
    // Build legend from module colors in graph metadata
    const colors = (graph.metadata && graph.metadata.moduleColors) || {};
    for (const [mod, color] of Object.entries(colors)) {
      const d = document.createElement("div");
      d.className = "lg-item";
      d.innerHTML = `<span class="lg-shape" style="background:${color}20;border:1px solid ${color}"></span>${escapeHtml(mod)}`;
      lgItems.appendChild(d);
      itemCount += 1;
    }
  }
  if (legendEl) {
    legendEl.classList.toggle("scrollable", itemCount > 6);
  }
}

function updateCanvasControls(graph) {
  if (!canvasControls || !collapseGroupsBtn || !expandGroupsBtn) return;
  const enabled = !!renderCtx._hasGroupControls;
  canvasControls.style.display = enabled ? "flex" : "none";
  collapseGroupsBtn.disabled = !enabled;
  expandGroupsBtn.disabled = !enabled;
}

function applyCanvasThemeMode() {
  const mode = uiState.canvasThemeMode === "vscode" ? "vscode" : "codemap";
  document.body.dataset.canvasThemeMode = mode;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "setGraph") {
    // Top-level graph: reset breadcrumb and render in overview mode.
    previousFlowchartBreadcrumb = flowchartBreadcrumb;
    flowchartBreadcrumb = [];
    updateBreadcrumbUi();
    renderGraph(msg.graph, { progressiveMode: msg.graph.graphType === "flowchart" ? "overview" : "none" });
    setOverlayGraph(msg.graph);
    narrationPanel.setGraph(msg.graph);
  } else if (msg && msg.type === "flowchartLayer") {
    previousFlowchartBreadcrumb = flowchartBreadcrumb;
    flowchartBreadcrumb = msg.breadcrumb || [];
    updateBreadcrumbUi();
    const mode = flowchartBreadcrumb.length === 0 ? "overview" : "drilldown";
    renderGraph(msg.graph, { progressiveMode: mode });
    setOverlayGraph(msg.graph);
    narrationPanel.setGraph(msg.graph);
  } else if (msg && msg.type === "setRuntimeFrame") {
    renderRuntimeFrame(msg.frame, msg.highlightNodeIds || [], msg.breakpointNodeIds || []);
    setOverlayActiveNodes([...(msg.highlightNodeIds || []), ...(msg.breakpointNodeIds || [])]);
  } else if (msg && msg.type === "setNarrationScript") {
    currentNarrationScript = msg.script || null;
    narrationPanel.load(currentNarrationScript, currentGraph);
    if (currentGraph?.graphType === "flowchart") {
      const mode = flowchartBreadcrumb.length === 0 ? "overview" : "drilldown";
      renderGraph(currentGraph, { preserveView: true, progressiveMode: mode });
    }
  } else if (msg && msg.type === "clearNarration") {
    currentNarrationScript = null;
    narrationPanel.clear();
    if (currentGraph?.graphType === "flowchart") {
      const mode = flowchartBreadcrumb.length === 0 ? "overview" : "drilldown";
      renderGraph(currentGraph, { preserveView: true, progressiveMode: mode });
    }
  } else if (msg && msg.type === "setDebugProbes") {
    const probes = msg.probesPacked ? decodePackedBase64(msg.probesPacked) : (msg.probes || []);
    setOverlayProbes(probes || []);
    debugOverlay.setProbes(probes || []);
  } else if (msg && msg.type === "probeResult") {
    const result = msg.resultPacked ? decodePackedBase64(msg.resultPacked) : msg.result;
    if (result) {
      setOverlayProbeResult(result);
      debugOverlay.updateProbe(result);
    }
  } else if (msg && msg.type === "clearDebugProbes") {
    clearOverlayProbeResults(msg.nodeId);
    debugOverlay.clearProbes(msg.nodeId);
  } else if (msg && msg.type === "highlightProbeNode") {
    debugOverlay.flashNode(msg.nodeId);
  } else if (msg && msg.type === "setUiState") {
    uiState = { ...uiState, ...(msg.state || {}) };
    if (functionCallsToggle) functionCallsToggle.checked = uiState.showFunctionCalls !== false;
    const bv = typeof uiState.canvasBrightness === "number" ? uiState.canvasBrightness : 1.0;
    canvasEl.style.filter = bv === 1.0 ? "" : `brightness(${bv})`;
    applyCanvasThemeMode();
    applyNarrationAvailability();
    hideTooltip();
    scheduleUiStateRender();
  }
});

applyCanvasThemeMode();

/**
 * Rebuild the breadcrumb bar DOM from the current flowchartBreadcrumb state.
 * The bar is always visible when a flowchart is active so users can see that
 * progressive reading mode is in effect.
 */
function updateBreadcrumbUi() {
  if (!breadcrumbEl) return;
  breadcrumbEl.style.display = "none";
  breadcrumbEl.innerHTML = "";
}

// ── Toolbar buttons ──
execBtn.addEventListener("click", () => {
  toggleAutoTrace();
});

stepBtn.addEventListener("click", () => {
  toggleStepMode();
});

resetBtn.addEventListener("click", () => {
  if (renderCtx._resetView) {
    renderCtx._resetView();
    return;
  }
  canvas.reset(current?.initialView);
});

clearBtn.addEventListener("click", () => {
  clearExecTrace();
  if (renderCtx._resetSelection) renderCtx._resetSelection();
});

refreshBtn.addEventListener("click", () => {
  clearStoredLayouts();
  vscode.postMessage({ type: "requestRefresh" });
});

narrateBtn?.addEventListener("click", () => {
  if (uiState.narrationEnabled === false) return;
  vscode.postMessage({
    type: "requestNarration",
    kind: currentGraph?.graphType === "flowchart" ? "flowchart" : "trace",
    regenerate: false,
  });
});

aiToggle?.addEventListener("change", () => {
  vscode.postMessage({ type: "toggleAiAssistance", enabled: aiToggle.checked });
});

functionCallsToggle?.addEventListener("change", () => {
  vscode.postMessage({ type: "toggleFunctionCalls", enabled: functionCallsToggle.checked });
});

overlayLegacyToggle?.addEventListener("change", () => {
  overlayPrefs.showLegacyOverlay = overlayLegacyToggle.checked;
  if (currentGraph) {
    renderGraph(currentGraph, { preserveView: true });
  }
});

overlayModernToggle?.addEventListener("change", () => {
  overlayPrefs.showModernOverlay = overlayModernToggle.checked;
  if (currentGraph) {
    renderGraph(currentGraph, { preserveView: true });
  }
});

probeInteractToggle?.addEventListener("change", () => {
  applyProbeOverlayInteraction();
});

collapseGroupsBtn?.addEventListener("click", () => {
  renderCtx._collapseAllGroups?.();
});

expandGroupsBtn?.addEventListener("click", () => {
  renderCtx._expandAllGroups?.();
});

searchBox.addEventListener("input", () => {
  if (!current) return;
  const q = searchBox.value.trim().toLowerCase();
  const groups = canvasEl.querySelectorAll("[data-id]");
  if (!q) {
    groups.forEach((g) => g.classList.remove("search-dim", "search-hit"));
    return;
  }
  for (const g of groups) {
    const id = g.dataset.id;
    const n = current.nodes.find((nn) => nn.id === id);
    const hit = n && (n.label?.toLowerCase().includes(q)
                   || n.id.toLowerCase().includes(q)
                   || (n.detail || "").toLowerCase().includes(q));
    g.classList.toggle("search-dim", !hit);
    g.classList.toggle("search-hit", !!hit);
  }
});

// Click on empty canvas → reset selection
canvasEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-id]")) return;
  if (renderCtx._resetSelection) renderCtx._resetSelection();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    clearExecTrace();
    if (renderCtx._resetSelection) renderCtx._resetSelection();
    canvas.reset(current?.initialView);
  }
  const timeline = renderCtx._execTimeline;
  if (timeline && timeline.length > 0) {
    if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      if (execAutoMode) stopAutoTrace();
      if (!execStepMode) toggleStepMode();
      execStep = Math.min(execStep + 1, timeline.length - 1);
      highlightExecStep();
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (execAutoMode) stopAutoTrace();
      execStep = Math.max(execStep - 1, 0);
      highlightExecStep();
    }
    if (e.key === "a" || e.key === "A") {
      toggleAutoTrace();
    }
  }
});

// ── Exec Trace Panel ──
function updateExecPanel(graph) {
  const panel = document.getElementById("exec-panel");
  if (!panel) return;
  const timeline = renderCtx._execTimeline;
  if (!timeline || timeline.length === 0) {
    panel.style.display = "none";
    execBtn.style.display = "none";
    stepBtn.style.display = "none";
    return;
  }
  panel.style.display = "block";
  execBtn.style.display = "";
  stepBtn.style.display = "";
  resetExecPanelDisplay();
}

function resetExecPanelDisplay() {
  const epFunc = document.getElementById("ep-func");
  const epDesc = document.getElementById("ep-desc");
  const epStep = document.getElementById("ep-step");
  const epHint = document.getElementById("ep-hint");
  const panel  = document.getElementById("exec-panel");
  if (epFunc) epFunc.textContent = "—";
  if (epDesc) epDesc.textContent = "";
  if (epStep) epStep.textContent = "";
  if (epHint) epHint.textContent = "Auto or step mode";
  if (panel) {
    panel.classList.remove("active-exec", "active-step");
  }
  dispatchExecStepEvent();
}

function highlightExecStep() {
  const timeline = renderCtx._execTimeline;
  if (!timeline || execStep < 0 || execStep >= timeline.length) return;
  if (renderCtx._highlightStep) renderCtx._highlightStep(execStep);
  spawnCurrentStepParticle(true);
  updateExecStepDisplay();
}

function updateExecStepDisplay() {
  const timeline = renderCtx._execTimeline;
  if (!timeline) return;
  const panel  = document.getElementById("exec-panel");
  const epFunc = document.getElementById("ep-func");
  const epDesc = document.getElementById("ep-desc");
  const epStep = document.getElementById("ep-step");
  const epHint = document.getElementById("ep-hint");
  if (execStep < 0) {
    resetExecPanelDisplay();
    return;
  }
  const step = timeline[execStep];
  if (epFunc) epFunc.textContent = step.label || "—";
  if (epDesc) epDesc.textContent = step.desc || "";
  if (epStep) epStep.textContent = `Step ${execStep + 1} / ${timeline.length}`;
  if (epHint) epHint.textContent = execAutoMode ? "Auto tracing" : "← back  → next";
  if (panel) {
    panel.classList.toggle("active-exec", execAutoMode);
    panel.classList.toggle("active-step", execStepMode && !execAutoMode);
  }
  dispatchExecStepEvent();
}

function toggleAutoTrace() {
  if (execAutoMode) {
    stopAutoTrace();
    return;
  }
  execStepMode = false;
  stepBtn.classList.remove("active");
  execAutoMode = true;
  execBtn.classList.add("active");
  execStep = -1;
  lastStepParticleAt = 0;
  if (renderCtx._clearExecDots) renderCtx._clearExecDots();
  execDots = [];
  advanceAutoTrace();
  execAutoTimer = setInterval(advanceAutoTrace, EXEC_AUTO_INTERVAL);
}

function stopAutoTrace() {
  execAutoMode = false;
  execBtn.classList.remove("active");
  if (execAutoTimer) { clearInterval(execAutoTimer); execAutoTimer = null; }
  updateExecStepDisplay();
}

function toggleStepMode() {
  if (execStepMode) {
    execStepMode = false;
    lastStepParticleAt = 0;
    stepBtn.classList.remove("active");
    return;
  }
  if (execAutoMode) stopAutoTrace();
  execStepMode = true;
  stepBtn.classList.add("active");
  execStep = -1;
  lastStepParticleAt = 0;
  updateExecStepDisplay();
}

function clearExecTrace() {
  stopAutoTrace();
  execStepMode = false;
  stepBtn.classList.remove("active");
  execStep = -1;
  lastStepParticleAt = 0;
  execDots = [];
  if (renderCtx._clearExecDots) renderCtx._clearExecDots();
  resetExecPanelDisplay();
}

function advanceAutoTrace() {
  const timeline = renderCtx._execTimeline;
  if (!timeline || timeline.length === 0) { stopAutoTrace(); return; }
  execStep++;
  if (execStep >= timeline.length) {
    stopAutoTrace();
    if (renderCtx._resetSelection) renderCtx._resetSelection();
    execStep = -1;
    updateExecStepDisplay();
    return;
  }
  highlightExecStep();
  const step = timeline[execStep];
  if (step.edge) {
    const key = step.edge[0] + "->" + step.edge[1];
    const edgeIdx = renderCtx._edgeMap ? renderCtx._edgeMap[key] : undefined;
    if (edgeIdx !== undefined && renderCtx._spawnExecDot) {
      const d = renderCtx._spawnExecDot(edgeIdx, "#bb9af7");
      if (d) execDots.push(d);
    }
  }
}

function dispatchExecStepEvent() {
  const timeline = renderCtx._execTimeline;
  const step = timeline && execStep >= 0 && execStep < timeline.length ? timeline[execStep] : null;
  document.dispatchEvent(new CustomEvent("codemap:execStep", {
    detail: {
      stepIndex: execStep,
      step,
    },
  }));
}

function setExecStepIndex(stepIndex) {
  const timeline = renderCtx._execTimeline;
  if (!timeline || !timeline.length) return false;
  if (execAutoMode) stopAutoTrace();
  execStepMode = true;
  stepBtn.classList.add("active");
  execStep = Math.max(0, Math.min(stepIndex, timeline.length - 1));
  highlightExecStep();
  return true;
}

function spawnCurrentStepParticle(force = false) {
  if (!execStepMode || execAutoMode || execStep < 0) return;
  const timeline = renderCtx._execTimeline;
  const spawnFn = renderCtx._spawnExecDot;
  const edgeMap = renderCtx._edgeMap;
  if (!timeline || !spawnFn || !edgeMap) return;
  const step = timeline[execStep];
  if (!step?.edge) return;
  const now = performance.now();
  if (!force && now - lastStepParticleAt < STEP_PARTICLE_INTERVAL_MS) return;
  const edgeIdx = edgeMap[step.edge[0] + "->" + step.edge[1]];
  if (typeof edgeIdx !== "number") return;
  const d = spawnFn(edgeIdx, "#f7e76d", { radius: 6.5, speed: 0.0048, trailScale: 1.15 });
  if (d) {
    execDots.push(d);
    lastStepParticleAt = now;
  }
}

// Animation loop
function loop() {
  time++;
  if (current) {
    for (const r of current.edgeRecords) {
      if (r.ambDots) {
        for (const ad of r.ambDots) {
          ad.el.setAttribute("opacity", String(ad.opacity || 0.3));
          const t = (((time * ad.speed) + ad.offset) % 1 + 1) % 1;
          const pt = cubicPt(r.sx, r.sy, r.c1x, r.c1y, r.c2x, r.c2y, r.tx, r.ty, t);
          ad.el.setAttribute("cx", pt.x);
          ad.el.setAttribute("cy", pt.y);
        }
      } else if (r.dot) {
        r.dot.setAttribute("opacity", "0.3");
        const t = (((time * r.speed) + r.offset) % 1 + 1) % 1;
        const pt = cubicPt(r.sx, r.sy, r.c1x, r.c1y, r.c2x, r.c2y, r.tx, r.ty, t);
        r.dot.setAttribute("cx", pt.x);
        r.dot.setAttribute("cy", pt.y);
      }
    }
  }
  spawnCurrentStepParticle(false);
  for (let i = execDots.length - 1; i >= 0; i--) {
    const d = execDots[i];
    if (!d.alive) continue;
    d.t += d.speed;
    if (d.t >= 1) {
      d.el.setAttribute("opacity", "0");
      d.trails.forEach((tr) => tr.el.setAttribute("opacity", "0"));
      d.alive = false;
      continue;
    }
    const e = d.edge;
    const pt = cubicPt(e.sx, e.sy, e.c1x, e.c1y, e.c2x, e.c2y, e.tx, e.ty, d.t);
    d.el.setAttribute("cx", pt.x);
    d.el.setAttribute("cy", pt.y);
    // Trailing circles
    d.trails.forEach((tr, ti) => {
      const tt = Math.max(0, d.t - (ti + 1) * 0.025);
      const tp = cubicPt(e.sx, e.sy, e.c1x, e.c1y, e.c2x, e.c2y, e.tx, e.ty, tt);
      tr.el.setAttribute("cx", tp.x);
      tr.el.setAttribute("cy", tp.y);
    });
  }
  if (time % 120 === 0) {
    execDots = execDots.filter((d) => d.alive);
  }
  requestAnimationFrame(loop);
}
loop();

const narrationPanel = createNarrationPanel({
  rootEl: narrationRoot,
  vscode,
  getCurrentGraph: () => currentGraph,
  resolveNodeElement: (nodeId) => canvasEl.querySelector(`[data-id="${cssEscape(nodeId)}"]`),
  setExecStepIndex,
  motionAnimate,
  canvasEl,
});

const debugOverlay = createOverlayManager({
  rootEl: debugOverlayRoot,
  canvasEl,
  resolveNodeElement: (nodeId) => canvasEl.querySelector(`[data-id="${cssEscape(nodeId)}"]`),
  onDismissProbe: (probeId) => vscode.postMessage({ type: "dismissProbe", probeId }),
  onRegenerateProbes: (nodeId) => vscode.postMessage({ type: "regenerateProbes", nodeId }),
  onSelectNode: (nodeId) => {
    debugOverlay.flashNode(nodeId);
    const node = currentGraph?.nodes?.find((entry) => entry.id === nodeId);
    if (node) onNodeClick(node);
  },
});

applyProbeOverlayInteraction();

vscode.postMessage({ type: "ready" });

// ── Runtime / debug live overlay ──
let runtimeHighlightedIds = [];
let runtimeBreakpointIds = [];
let runtimePrevFrame = null;
let runtimePrevPrimaryNodeId = null;
let runtimeFlashTimer = null;

function renderRuntimeFrame(frame, highlightIds, breakpointIds = []) {
  const panel = document.getElementById("runtime-panel");
  if (!panel) return;
  // Clear previous static highlights.
  for (const prevId of runtimeHighlightedIds) {
    const g = canvasEl.querySelector('[data-id="' + cssEscape(prevId) + '"]');
    if (!g) continue;
    g.classList.remove("runtime-active");
    g.classList.remove("runtime-ancestor");
    g.classList.remove("runtime-breakpoint-hit");
  }
  for (const prevId of runtimeBreakpointIds) {
    const g = canvasEl.querySelector('[data-id="' + cssEscape(prevId) + '"]');
    if (g) g.classList.remove("runtime-breakpoint-hit");
  }
  runtimeHighlightedIds = [];
  runtimeBreakpointIds = [];

  if (!frame) {
    panel.style.display = "none";
    runtimePrevFrame = null;
    runtimePrevPrimaryNodeId = null;
    return;
  }
  panel.style.display = "block";

  // ── Compute touched variables (changed value or new since last frame) ──
  const touched = computeTouchedVarNames(frame, runtimePrevFrame);

  // ── Header / source / call stack (no values) ──
  const frameEl  = document.getElementById("rt-frame");
  const sourceEl = document.getElementById("rt-source");
  const varsEl   = document.getElementById("rt-vars");
  const stackEl  = document.getElementById("rt-stack");

  if (frameEl)  frameEl.textContent  = frame.name || "(frame)";
  if (sourceEl) {
    sourceEl.textContent = frame.source
      ? shortPath(frame.source.file) + ":" + frame.source.line
      : "";
  }

  // ── Variable list: name + type only, with touched ones flashed ──
  if (varsEl) {
    if (!frame.variables || frame.variables.length === 0) {
      varsEl.innerHTML = '<div style="color:#454a60">no variables</div>';
    } else {
      const grouped = {};
      for (const v of frame.variables) {
        const scope = v.scope || "Locals";
        if (!grouped[scope]) grouped[scope] = [];
        grouped[scope].push(v);
      }
      const html = [];
      for (const scope of Object.keys(grouped)) {
        html.push('<div style="color:#7d8590;font-size:10px;margin-top:4px">' + escapeHtml(scope) + '</div>');
        for (const v of grouped[scope].slice(0, 16)) {
          const isTouched = touched.has(varKey(scope, v.name));
          const typeStr = v.type
            ? ' <span style="color:#bb9af7">: ' + escapeHtml(v.type) + '</span>'
            : '';
          const cls = isTouched ? ' class="rt-var-touched"' : '';
          html.push(
            '<div' + cls + '>' +
              '<span style="color:#7aa2f7">' + escapeHtml(v.name) + '</span>' +
              typeStr +
            '</div>'
          );
        }
        if (grouped[scope].length > 16) {
          html.push('<div style="color:#454a60">+' + (grouped[scope].length - 16) + ' more</div>');
        }
      }
      varsEl.innerHTML = html.join("");
    }
  }

  // ── Call stack (no values, just function names + locations) ──
  if (stackEl) {
    if (!frame.callStack || frame.callStack.length === 0) {
      stackEl.textContent = "";
    } else {
      const items = frame.callStack.slice(0, 8).map((sf, i) => {
        const arrow = i === 0 ? "▶" : " ";
        const where = sf.file ? shortPath(sf.file) + ":" + (sf.line || "?") : "";
        return arrow + " " + escapeHtml(sf.name) + (where ? "  " + where : "");
      });
      stackEl.innerHTML = items.join("<br>");
    }
  }

  // ── Resolve current node + flash touched-var occurrences in graph ──
  const primaryNodeId = resolvePrimaryNodeId(frame, highlightIds);
  if (primaryNodeId) {
    const g = canvasEl.querySelector('[data-id="' + cssEscape(primaryNodeId) + '"]');
    if (g) {
      g.classList.add("runtime-active");
      runtimeHighlightedIds.push(primaryNodeId);
    }
  }
  // Highlight ancestors from the call stack as a softer pulse.
  if (currentGraph?.graphType !== "flowchart" && Array.isArray(highlightIds)) {
    for (const id of highlightIds) {
      if (id === primaryNodeId) continue;
      const g = canvasEl.querySelector('[data-id="' + cssEscape(id) + '"]');
      if (g) {
        g.classList.add("runtime-ancestor");
        runtimeHighlightedIds.push(id);
      }
    }
  }

  if (Array.isArray(breakpointIds)) {
    for (const id of breakpointIds) {
      const g = canvasEl.querySelector('[data-id="' + cssEscape(id) + '"]');
      if (!g) continue;
      g.classList.add("runtime-breakpoint-hit");
      runtimeBreakpointIds.push(id);
      if (!runtimeHighlightedIds.includes(id)) runtimeHighlightedIds.push(id);
    }
  }

  // ── Spawn bright execution particle on node transitions ──
  if (primaryNodeId && primaryNodeId !== runtimePrevPrimaryNodeId) {
    spawnRuntimeParticle(runtimePrevPrimaryNodeId, primaryNodeId);
  }
  runtimePrevPrimaryNodeId = primaryNodeId;

  // ── Briefly flash any node that mentions a touched variable name ──
  if (touched.size > 0 && currentGraph && currentGraph.graphType !== "flowchart") {
    flashNodesMentioningVars(touched);
  }

  runtimePrevFrame = frame;
}

function varKey(scope, name) {
  return scope + "::" + name;
}

function computeTouchedVarNames(frame, prevFrame) {
  const touched = new Set();
  if (!frame || !frame.variables) return touched;
  const prevMap = new Map();
  if (prevFrame && prevFrame.variables) {
    for (const v of prevFrame.variables) {
      prevMap.set(varKey(v.scope || "Locals", v.name), v.value);
    }
  }
  // If we're in the same call frame as last time, diff. If we stepped into
  // a new frame entirely (different name + source), treat all new locals as
  // touched so the user sees what came in.
  const sameFrame = prevFrame
    && prevFrame.name === frame.name
    && prevFrame.source && frame.source
    && prevFrame.source.file === frame.source.file;
  for (const v of frame.variables) {
    const key = varKey(v.scope || "Locals", v.name);
    if (!sameFrame) {
      touched.add(key);
      touched.add(v.name); // also raw name for graph-text matching
      continue;
    }
    const prevVal = prevMap.get(key);
    if (prevVal === undefined || prevVal !== v.value) {
      touched.add(key);
      touched.add(v.name);
    }
  }
  return touched;
}

function resolvePrimaryNodeId(frame, highlightIds) {
  if (Array.isArray(highlightIds) && highlightIds.length > 0) {
    return highlightIds[0];
  }
  if (frame.source && currentGraph) {
    return findNodeIdByLocation(currentGraph, frame.source);
  }
  return null;
}

function spawnRuntimeParticle(fromId, toId) {
  if (!toId) return;
  const edgeMap = renderCtx._edgeMap;
  const spawnFn = renderCtx._spawnExecDot;
  if (!spawnFn) return;
  // 1) Direct edge fromId -> toId
  if (fromId && edgeMap) {
    const idx = edgeMap[fromId + "->" + toId];
    if (typeof idx === "number") {
      const d = spawnFn(idx, "#f7e76d");
      if (d) {
        d.speed = Math.max(d.speed || 0.01, 0.012);
        execDots.push(d);
        return;
      }
    }
    // 2) Reverse edge (e.g. return path)
    const idxRev = edgeMap[toId + "->" + fromId];
    if (typeof idxRev === "number") {
      const d = spawnFn(idxRev, "#f7e76d");
      if (d) {
        d.speed = Math.max(d.speed || 0.01, 0.012);
        execDots.push(d);
        return;
      }
    }
  }
  // 3) No edge: pulse the destination node so user still sees a "step happened"
  const g = canvasEl.querySelector('[data-id="' + cssEscape(toId) + '"]');
  if (g) {
    g.classList.add("runtime-step-pulse");
    setTimeout(() => g.classList.remove("runtime-step-pulse"), 700);
  }
}

function flashNodesMentioningVars(touchedNames) {
  if (!currentGraph || !currentGraph.nodes) return;
  // Build a quick set of plain variable names to look for in node text.
  const names = [];
  for (const k of touchedNames) {
    const idx = k.indexOf("::");
    const name = idx >= 0 ? k.slice(idx + 2) : k;
    if (name && name.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      names.push(name);
    }
  }
  if (names.length === 0) return;
  const nameSet = new Set(names);
  const flashed = [];
  for (const n of currentGraph.nodes) {
    const haystack = collectNodeText(n);
    if (!haystack) continue;
    let hit = false;
    for (const nm of nameSet) {
      // Word-boundary-ish check
      const re = new RegExp("(^|[^A-Za-z0-9_])" + escapeRegex(nm) + "($|[^A-Za-z0-9_])");
      if (re.test(haystack)) { hit = true; break; }
    }
    if (hit) {
      const g = canvasEl.querySelector('[data-id="' + cssEscape(n.id) + '"]');
      if (g) {
        g.classList.add("runtime-var-flash");
        flashed.push(g);
      }
    }
  }
  if (runtimeFlashTimer) clearTimeout(runtimeFlashTimer);
  runtimeFlashTimer = setTimeout(() => {
    for (const g of flashed) g.classList.remove("runtime-var-flash");
    runtimeFlashTimer = null;
  }, 800);
}

function collectNodeText(n) {
  const parts = [n.label || "", n.detail || ""];
  const m = n.metadata || {};
  if (m.typeLabel) parts.push(String(m.typeLabel));
  if (m.signature) parts.push(String(m.signature));
  if (Array.isArray(m.displayLines)) parts.push(m.displayLines.join(" "));
  if (Array.isArray(m.params)) {
    for (const p of m.params) parts.push(p && p.name ? p.name : "");
  }
  return parts.join(" ");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findNodeIdByLocation(graph, source) {
  if (!graph || !graph.nodes || !source) return null;
  const targetFile = (source.file || "").replace(/\\/g, "/").toLowerCase();
  const targetLine = source.line;
  let best = null;
  let bestDist = Infinity;
  for (const n of graph.nodes) {
    if (!n.source || !n.source.file) continue;
    const nf = n.source.file.replace(/\\/g, "/").toLowerCase();
    if (nf !== targetFile) continue;
    const start = n.source.line || 0;
    const end = n.source.endLine || start;
    if (targetLine >= start && targetLine <= end) {
      const dist = targetLine - start;
      if (dist < bestDist) {
        bestDist = dist;
        best = n.id;
      }
    }
  }
  return best;
}

function shortPath(p) {
  if (!p) return "";
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

function cssEscape(s) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(s);
  }
  return String(s).replace(/(["\\])/g, "\\$1");
}

function buildLayoutStorageKey(graph, layoutMode = "lanes") {
  const meta = graph.metadata || {};
  const nodeIds = Array.isArray(graph.nodes)
    ? graph.nodes.map((node) => node.id).sort()
    : [];
  return LAYOUT_STORAGE_PREFIX + JSON.stringify([
    graph.graphType || "graph",
    layoutMode,
    graph.title || "",
    meta.module || "",
    Array.isArray(graph.rootNodeIds) ? graph.rootNodeIds : [],
    nodeIds,
  ]);
}

function loadLayoutSnapshot(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveLayoutSnapshot(key, snapshot) {
  try {
    if (!snapshot || typeof snapshot !== "object") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Ignore webview storage failures.
  }
}

function clearStoredLayouts() {
  try {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(LAYOUT_STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Ignore webview storage failures.
  }
}
