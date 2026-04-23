import "./narrationPanel.css";

const DEFAULT_SPEED = 1;
const DEFAULT_MODE = "subtitle";

export function createNarrationPanel({ rootEl, vscode, getCurrentGraph, resolveNodeElement, setExecStepIndex }) {
  if (!rootEl) {
    return {
      setGraph() {},
      load() {},
      clear() {},
      advance() {},
    };
  }

  const state = {
    script: null,
    graph: null,
    mode: DEFAULT_MODE,
    speed: DEFAULT_SPEED,
    stepIndex: -1,
    playing: false,
    timer: null,
  };

  rootEl.innerHTML = `
    <div class="cm-narration-shell">
      <div class="cm-narration-subtitle"></div>
      <div class="cm-narration-sidebar">
        <div class="cm-narration-header">
          <div class="cm-narration-header-copy">
            <div class="cm-narration-kicker">Narration</div>
            <div class="cm-narration-model"></div>
            <div class="cm-narration-meta"></div>
          </div>
          <div class="cm-narration-controls">
            <button type="button" data-action="prev">Prev</button>
            <button type="button" data-action="play">Play</button>
            <button type="button" data-action="next">Next</button>
            <select data-action="speed" aria-label="Narration speed">
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
            </select>
            <select data-action="mode" aria-label="Narration mode">
              <option value="subtitle" selected>Subtitle</option>
              <option value="sidebar">Sidebar</option>
              <option value="tooltip">Tooltip</option>
            </select>
            <button type="button" data-action="regenerate">Regenerate</button>
            <button type="button" data-action="export">Export</button>
          </div>
        </div>
        <div class="cm-narration-overview"></div>
        <div class="cm-narration-steps"></div>
      </div>
      <div class="cm-narration-tooltip"></div>
    </div>
  `;

  const shell = rootEl.querySelector(".cm-narration-shell");
  const subtitle = rootEl.querySelector(".cm-narration-subtitle");
  const sidebar = rootEl.querySelector(".cm-narration-sidebar");
  const tooltip = rootEl.querySelector(".cm-narration-tooltip");
  const modelEl = rootEl.querySelector(".cm-narration-model");
  const metaEl = rootEl.querySelector(".cm-narration-meta");
  const overviewEl = rootEl.querySelector(".cm-narration-overview");
  const stepsEl = rootEl.querySelector(".cm-narration-steps");
  const playBtn = rootEl.querySelector('[data-action="play"]');
  const speedSelect = rootEl.querySelector('[data-action="speed"]');
  const modeSelect = rootEl.querySelector('[data-action="mode"]');

  rootEl.querySelector('[data-action="prev"]')?.addEventListener("click", () => {
    stopPlayback();
    const nextIndex = state.stepIndex <= 0 ? 0 : state.stepIndex - 1;
    moveToStep(nextIndex);
  });
  rootEl.querySelector('[data-action="next"]')?.addEventListener("click", () => {
    stopPlayback();
    const nextIndex = state.stepIndex < 0 ? 0 : state.stepIndex + 1;
    moveToStep(nextIndex);
  });
  playBtn?.addEventListener("click", () => {
    if (state.playing) stopPlayback();
    else startPlayback();
  });
  speedSelect?.addEventListener("change", () => {
    state.speed = Number(speedSelect.value) || DEFAULT_SPEED;
    if (state.playing) {
      stopPlayback();
      startPlayback();
    }
  });
  modeSelect?.addEventListener("change", () => {
    state.mode = modeSelect.value || DEFAULT_MODE;
    render();
  });
  rootEl.querySelector('[data-action="regenerate"]')?.addEventListener("click", () => {
    vscode.postMessage({ type: "requestNarration", kind: currentKind(), regenerate: true });
  });
  rootEl.querySelector('[data-action="export"]')?.addEventListener("click", () => {
    vscode.postMessage({ type: "requestExportNarration" });
  });

  document.addEventListener("codemap:execStep", (event) => {
    const detail = event.detail || {};
    advance(typeof detail.stepIndex === "number" ? detail.stepIndex : -1);
  });

  function currentKind() {
    if (state.script?.kind) return state.script.kind;
    const graph = state.graph || getCurrentGraph?.();
    return graph?.graphType === "flowchart" ? "flowchart" : "trace";
  }

  function setGraph(graph) {
    state.graph = graph || null;
    render();
  }

  function load(script, graph) {
    state.script = script || null;
    if (graph) state.graph = graph;
    stopPlayback();
    state.stepIndex = script?.kind === "flowchart" && script.steps?.length ? 0 : -1;
    render();
  }

  function clear() {
    stopPlayback();
    state.script = null;
    state.stepIndex = -1;
    render();
  }

  function advance(stepIndex) {
    if (!state.script || state.script.kind !== "trace") return;
    state.stepIndex = typeof stepIndex === "number" ? stepIndex : -1;
    render();
  }

  function startPlayback() {
    if (!state.script || state.script.kind !== "trace" || !state.script.steps.length) return;
    state.playing = true;
    if (state.stepIndex < 0) {
      moveToStep(0);
    }
    scheduleNextTick();
    renderTransport();
  }

  function stopPlayback() {
    state.playing = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    renderTransport();
  }

  function scheduleNextTick() {
    if (!state.playing || !state.script || state.script.kind !== "trace") return;
    const step = resolveCurrentStep() || state.script.steps[0];
    const duration = Math.max(250, Math.round((step?.durationHint || 1600) / state.speed));
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const nextIndex = state.stepIndex < 0 ? 0 : state.stepIndex + 1;
      if (!state.script || nextIndex >= state.script.steps.length) {
        stopPlayback();
        return;
      }
      moveToStep(nextIndex);
      scheduleNextTick();
    }, duration);
  }

  function moveToStep(stepIndex) {
    if (!state.script) return;
    if (state.script.kind === "trace") {
      const bounded = Math.max(0, Math.min(stepIndex, Math.max(0, state.script.steps.length - 1)));
      if (typeof setExecStepIndex === "function" && setExecStepIndex(bounded)) {
        return;
      }
      state.stepIndex = bounded;
      render();
      return;
    }
    state.stepIndex = Math.max(0, Math.min(stepIndex, Math.max(0, state.script.steps.length - 1)));
    render();
  }

  function resolveCurrentStep() {
    if (!state.script) return null;
    if (state.script.kind === "trace") {
      if (state.stepIndex < 0) return null;
      return state.script.steps.find((step) => step.edgeIndex === state.stepIndex) || state.script.steps[state.stepIndex] || null;
    }
    if (state.stepIndex < 0) return state.script.steps[0] || null;
    return state.script.steps[state.stepIndex] || null;
  }

  function render() {
    const hasScript = !!state.script;
    shell.classList.toggle("is-visible", hasScript);
    if (!hasScript) {
      subtitle.textContent = "";
      modelEl.textContent = "";
      metaEl.textContent = "";
      overviewEl.textContent = "";
      stepsEl.innerHTML = "";
      tooltip.classList.remove("is-visible");
      return;
    }

    shell.dataset.mode = state.mode;
    modelEl.textContent = state.script.modelName
      ? `${state.script.modelName}${state.script.modelId ? ` · ${state.script.modelId}` : ""}`
      : "Model unavailable";
    metaEl.textContent = `${state.script.kind === "flowchart" ? "Flowchart annotations" : "Trace walkthrough"} · ${state.script.steps.length} ${state.script.steps.length === 1 ? "beat" : "beats"}`;
    overviewEl.textContent = state.script.overview || "";
    renderTransport();
    renderStepsList();

    const currentStep = resolveCurrentStep();
    const text = currentStep?.narration || state.script.overview || "";
    subtitle.textContent = text;
    positionTooltip(currentStep, text);
  }

  function renderTransport() {
    const isTrace = state.script?.kind === "trace";
    rootEl.querySelector('[data-action="prev"]').disabled = !isTrace || !state.script?.steps?.length;
    rootEl.querySelector('[data-action="next"]').disabled = !isTrace || !state.script?.steps?.length;
    playBtn.disabled = !isTrace || !state.script?.steps?.length;
    playBtn.textContent = state.playing ? "Pause" : "Play";
    speedSelect.disabled = !isTrace || !state.script?.steps?.length;
  }

  function renderStepsList() {
    if (!state.script) {
      stepsEl.innerHTML = "";
      return;
    }
    const activeTraceIndex = state.stepIndex;
    stepsEl.innerHTML = state.script.steps
      .map((step, index) => {
        const isActive = state.script.kind === "trace"
          ? step.edgeIndex === activeTraceIndex
          : index === state.stepIndex;
        const label = step.toNodeId || step.nodeId || step.fromNodeId || `Step ${index + 1}`;
        return `
          <button class="cm-narration-step${isActive ? " is-active" : ""}" data-step-index="${index}" type="button">
            <span class="cm-narration-step-label">${index + 1}. ${escapeHtml(label)}</span>
            <span class="cm-narration-step-text">${escapeHtml(step.narration)}</span>
          </button>
        `;
      })
      .join("");
    for (const element of stepsEl.querySelectorAll("[data-step-index]")) {
      element.addEventListener("click", () => {
        stopPlayback();
        moveToStep(Number(element.getAttribute("data-step-index")) || 0);
      });
    }
  }

  function positionTooltip(step, text) {
    if (state.mode !== "tooltip" || !text) {
      tooltip.classList.remove("is-visible");
      return;
    }
    const nodeId = step?.toNodeId || step?.nodeId || step?.fromNodeId;
    const target = nodeId ? resolveNodeElement?.(nodeId) : null;
    if (!target) {
      tooltip.classList.remove("is-visible");
      return;
    }
    const rect = target.getBoundingClientRect();
    tooltip.textContent = text;
    tooltip.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    tooltip.style.top = `${Math.round(rect.top - 12)}px`;
    tooltip.classList.add("is-visible");
  }

  return { setGraph, load, clear, advance };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '\"': "&quot;",
    "'": "&#39;",
  })[char]);
}
