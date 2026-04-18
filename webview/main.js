// Webview entry point. Receives GraphDocument JSON from the extension host
// and dispatches to the appropriate view renderer.

import { makeSvgCanvas } from "./shared/panZoom.js";
import { cubicPt } from "./shared/geometry.js";
import { renderFlowchart } from "./views/flowchart/flowchartView.js";
import { renderCallGraph } from "./views/callgraph/callGraphView.js";

const vscode = window.__codemapVscode || acquireVsCodeApi();

const canvasEl   = document.getElementById("canvas");
const tooltip    = document.getElementById("tooltip");
const titleEl    = document.getElementById("title");
const statsEl    = document.getElementById("stats");
const ambientBtn = document.getElementById("btn-ambient");
const execBtn    = document.getElementById("btn-exec");
const stepBtn    = document.getElementById("btn-step");
const resetBtn   = document.getElementById("btn-reset");
const clearBtn   = document.getElementById("btn-clear");
const refreshBtn = document.getElementById("btn-refresh");
const searchBox  = document.getElementById("search-box");

const canvas = makeSvgCanvas(canvasEl);
let current = null; // { edgeRecords, nodeRect, nodes, initialView }
let currentGraph = null;
let flowOn = true;
let time = 0;

function showTooltip(e, n) {
  const kind = n.kind || "node";
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
  tooltip.innerHTML = `
    ${module ? `<div class="tt-module">${escapeHtml(module)}</div>` : ""}
    <div class="tt-func">${escapeHtml(n.label || n.id)}</div>
    ${sig}${doc}
    ${n.source ? `<div class="tt-file">${escapeHtml(shortPath(n.source.file))}:${n.source.line}</div>` : ""}
    ${connLine}
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

// Click on empty canvas → reset selection
canvasEl.addEventListener("click", (e) => {
  if (e.target.closest("g[data-id]")) return;
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

function renderGraph(graph) {
  if (!graph || typeof graph !== "object") return;
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.edges)) graph.edges = [];
  currentGraph = graph;

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
    canvas.clear();
    if (canvas.clearScaleListeners) canvas.clearScaleListeners();
    const ctx = {
      root: canvas.root,
      defs: canvas.defs,
      canvas: canvas,
      showTooltip, moveTooltip, hideTooltip, onNodeClick,
      onNodeDblClick,
    };

    let result;
    if (graph.graphType === "flowchart") {
      result = renderFlowchart(graph, ctx);
    } else {
      result = renderCallGraph(graph, ctx);
    }
    current = result || { edgeRecords: [], nodeRect: new Map(), nodes: graph.nodes };

    // Copy renderer-attached helpers into shared renderCtx
    Object.keys(ctx).forEach((k) => { if (k.startsWith("_")) renderCtx[k] = ctx[k]; });

    updateStats(graph);

    // Inject exec timeline from graph metadata if present
    const timeline = graph.metadata && graph.metadata.execTimeline;
    if (timeline && Array.isArray(timeline) && timeline.length > 0) {
      renderCtx._execTimeline = timeline;
    }

    if (current.initialView) {
      canvas.reset(current.initialView);
    } else {
      canvas.reset();
    }

    updateExecPanel(graph);
    updateLegend(graph);
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    vscode.postMessage({ type: "debug", message: "[render-error] " + msg });
  }
}

function updateLegend(graph) {
  const lgItems = document.getElementById("lg-items");
  const lgTitle = document.getElementById("lg-title");
  if (!lgItems) return;
  lgItems.innerHTML = "";
  if (graph.graphType === "flowchart") {
    lgTitle.textContent = "Node Types";
    const types = [
      { color: "#9ece6a", label: "entry / exit" },
      { color: "#7aa2f7", label: "process" },
      { color: "#e0af68", label: "decision" },
      { color: "#f7768e", label: "error / raise" },
      { color: "#bb9af7", label: "compute" },
      { color: "#73daca", label: "output" },
    ];
    for (const t of types) {
      const d = document.createElement("div");
      d.className = "lg-item";
      d.innerHTML = `<span class="lg-shape" style="background:${t.color}20;border:1px solid ${t.color}"></span>${t.label}`;
      lgItems.appendChild(d);
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
    }
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "setGraph") {
    renderGraph(msg.graph);
  } else if (msg && msg.type === "setRuntimeFrame") {
    renderRuntimeFrame(msg.frame, msg.highlightNodeIds || []);
  }
});

// ── Toolbar buttons ──
ambientBtn.addEventListener("click", () => {
  flowOn = !flowOn;
  ambientBtn.classList.toggle("active", flowOn);
  if (!flowOn && current) {
    for (const r of current.edgeRecords) {
      if (r.ambDots) r.ambDots.forEach((ad) => ad.el.setAttribute("opacity", "0"));
      else r.dot.setAttribute("opacity", "0");
    }
  }
});

execBtn.addEventListener("click", () => {
  toggleAutoTrace();
});

stepBtn.addEventListener("click", () => {
  toggleStepMode();
});

resetBtn.addEventListener("click", () => {
  canvas.reset(current?.initialView);
});

clearBtn.addEventListener("click", () => {
  clearExecTrace();
  if (renderCtx._resetSelection) renderCtx._resetSelection();
});

refreshBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "requestRefresh" });
});

searchBox.addEventListener("input", () => {
  if (!current) return;
  const q = searchBox.value.trim().toLowerCase();
  const groups = canvasEl.querySelectorAll("g[data-id]");
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
  if (e.target.closest("g[data-id]")) return;
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
  const epBar  = document.getElementById("ep-bar");
  const panel  = document.getElementById("exec-panel");
  if (epFunc) epFunc.textContent = "—";
  if (epDesc) epDesc.textContent = "";
  if (epStep) epStep.textContent = "";
  if (epHint) epHint.textContent = "Press ▶ auto trace or ⏭ step-by-step";
  if (epBar)  epBar.style.width = "0%";
  if (panel) {
    panel.classList.remove("active-exec", "active-step");
  }
}

function highlightExecStep() {
  const timeline = renderCtx._execTimeline;
  if (!timeline || execStep < 0 || execStep >= timeline.length) return;
  if (renderCtx._highlightStep) renderCtx._highlightStep(execStep);
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
  const epBar  = document.getElementById("ep-bar");
  if (execStep < 0) {
    resetExecPanelDisplay();
    return;
  }
  const step = timeline[execStep];
  if (epFunc) epFunc.textContent = step.label || "—";
  if (epDesc) epDesc.textContent = step.desc || "";
  if (epStep) epStep.textContent = `Step ${execStep + 1} / ${timeline.length}`;
  if (epHint) epHint.textContent = execAutoMode ? "Auto-tracing..." : "→ next · ← back · A auto";
  if (epBar)  epBar.style.width = ((execStep + 1) / timeline.length * 100) + "%";
  if (panel) {
    panel.classList.toggle("active-exec", execAutoMode);
    panel.classList.toggle("active-step", execStepMode && !execAutoMode);
  }
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
    stepBtn.classList.remove("active");
    return;
  }
  if (execAutoMode) stopAutoTrace();
  execStepMode = true;
  stepBtn.classList.add("active");
  execStep = -1;
  updateExecStepDisplay();
}

function clearExecTrace() {
  stopAutoTrace();
  execStepMode = false;
  stepBtn.classList.remove("active");
  execStep = -1;
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
  if (renderCtx._highlightStep) renderCtx._highlightStep(execStep);
  updateExecStepDisplay();
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

// Animation loop
function loop() {
  time++;
  if (flowOn && current) {
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

vscode.postMessage({ type: "ready" });

// ── Runtime / debug live overlay ──
let runtimeHighlightedIds = [];
let runtimePrevFrame = null;
let runtimePrevPrimaryNodeId = null;
let runtimeFlashTimer = null;

function renderRuntimeFrame(frame, highlightIds) {
  const panel = document.getElementById("runtime-panel");
  if (!panel) return;
  // Clear previous static highlights.
  for (const prevId of runtimeHighlightedIds) {
    const g = canvasEl.querySelector('g[data-id="' + cssEscape(prevId) + '"]');
    if (g) g.classList.remove("runtime-active");
  }
  runtimeHighlightedIds = [];

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
    const g = canvasEl.querySelector('g[data-id="' + cssEscape(primaryNodeId) + '"]');
    if (g) {
      g.classList.add("runtime-active");
      runtimeHighlightedIds.push(primaryNodeId);
    }
  }
  // Highlight ancestors from the call stack as a softer pulse.
  if (Array.isArray(highlightIds)) {
    for (const id of highlightIds) {
      if (id === primaryNodeId) continue;
      const g = canvasEl.querySelector('g[data-id="' + cssEscape(id) + '"]');
      if (g) {
        g.classList.add("runtime-ancestor");
        runtimeHighlightedIds.push(id);
      }
    }
  }

  // ── Spawn bright execution particle on node transitions ──
  if (primaryNodeId && primaryNodeId !== runtimePrevPrimaryNodeId) {
    spawnRuntimeParticle(runtimePrevPrimaryNodeId, primaryNodeId);
  }
  runtimePrevPrimaryNodeId = primaryNodeId;

  // ── Briefly flash any node that mentions a touched variable name ──
  if (touched.size > 0 && currentGraph) {
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
  const g = canvasEl.querySelector('g[data-id="' + cssEscape(toId) + '"]');
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
      const g = canvasEl.querySelector('g[data-id="' + cssEscape(n.id) + '"]');
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
