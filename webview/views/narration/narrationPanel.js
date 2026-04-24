import "./narrationPanel.css";

const DEFAULT_SPEED = 1;
const DEFAULT_MODE = "subtitle";
const LARGE_SCRIPT_STEP_THRESHOLD = 12;
const LARGE_SCRIPT_WINDOW_RADIUS = 2;

export function createNarrationPanel({ rootEl, vscode, getCurrentGraph, resolveNodeElement, setExecStepIndex, motionAnimate, canvasEl }) {
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
    noteOpen: false,
    playing: false,
    timer: null,
    lastRenderKey: "",
    focusedNodeEl: null,
    highlightedElements: [],
  };

  rootEl.innerHTML = `
    <div class="cm-narration-shell">
      <div class="cm-narration-subtitle">
        <div class="cm-narration-progress"><div class="cm-narration-progress-bar"></div></div>
        <div class="cm-narration-subtitle-kicker"></div>
        <div class="cm-narration-subtitle-title"></div>
        <div class="cm-narration-subtitle-text"></div>
        <div class="cm-narration-subtitle-why"></div>
      </div>
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
            <button type="button" data-action="note">Note</button>
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
        <div class="cm-narration-overview-card">
          <div class="cm-narration-overview-kicker">Overview</div>
          <div class="cm-narration-overview-title"></div>
          <div class="cm-narration-opening"></div>
          <div class="cm-narration-overview"></div>
          <div class="cm-narration-takeaways"></div>
        </div>
        <div class="cm-narration-rail"></div>
        <div class="cm-narration-sections"></div>
        <div class="cm-narration-steps"></div>
      </div>
      <div class="cm-narration-tooltip"></div>
      <div class="cm-narration-anchor-note"></div>
    </div>
  `;

  const shell = rootEl.querySelector(".cm-narration-shell");
  const subtitle = rootEl.querySelector(".cm-narration-subtitle");
  const subtitleKickerEl = rootEl.querySelector(".cm-narration-subtitle-kicker");
  const subtitleTitleEl = rootEl.querySelector(".cm-narration-subtitle-title");
  const subtitleTextEl = rootEl.querySelector(".cm-narration-subtitle-text");
  const subtitleWhyEl = rootEl.querySelector(".cm-narration-subtitle-why");
  const progressBarEl = rootEl.querySelector(".cm-narration-progress-bar");
  const sidebar = rootEl.querySelector(".cm-narration-sidebar");
  const tooltip = rootEl.querySelector(".cm-narration-tooltip");
  const anchorNoteEl = rootEl.querySelector(".cm-narration-anchor-note");
  const modelEl = rootEl.querySelector(".cm-narration-model");
  const metaEl = rootEl.querySelector(".cm-narration-meta");
  const overviewTitleEl = rootEl.querySelector(".cm-narration-overview-title");
  const openingEl = rootEl.querySelector(".cm-narration-opening");
  const overviewEl = rootEl.querySelector(".cm-narration-overview");
  const takeawaysEl = rootEl.querySelector(".cm-narration-takeaways");
  const railEl = rootEl.querySelector(".cm-narration-rail");
  const sectionsEl = rootEl.querySelector(".cm-narration-sections");
  const stepsEl = rootEl.querySelector(".cm-narration-steps");
  const playBtn = rootEl.querySelector('[data-action="play"]');
  const noteBtn = rootEl.querySelector('[data-action="note"]');
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
  noteBtn?.addEventListener("click", () => {
    if (!resolveCurrentStep()) return;
    state.noteOpen = !state.noteOpen;
    render();
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

  document.addEventListener("keydown", (event) => {
    if (!state.script?.steps?.length) return;
    const target = event.target;
    const tagName = target && typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stopPlayback();
      moveToStep(state.stepIndex < 0 ? 0 : state.stepIndex + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stopPlayback();
      moveToStep(state.stepIndex <= 0 ? 0 : state.stepIndex - 1);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (state.playing) stopPlayback();
      else startPlayback();
    }
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
    state.noteOpen = false;
    render();
  }

  function clear() {
    stopPlayback();
    state.script = null;
    state.stepIndex = -1;
    state.noteOpen = false;
    syncFocusedNode(null);
    render();
  }

  function advance(stepIndex) {
    if (!state.script || state.script.kind !== "trace") return;
    state.stepIndex = typeof stepIndex === "number" ? stepIndex : -1;
    render();
  }

  function startPlayback() {
    if (!state.script || !state.script.steps.length) return;
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
    if (!state.playing || !state.script || !state.script.steps.length) return;
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
      subtitleKickerEl.textContent = "";
      subtitleTitleEl.textContent = "";
      subtitleTextEl.textContent = "";
      subtitleWhyEl.textContent = "";
      modelEl.textContent = "";
      metaEl.textContent = "";
      overviewTitleEl.textContent = "";
      openingEl.textContent = "";
      overviewEl.textContent = "";
      takeawaysEl.innerHTML = "";
      railEl.innerHTML = "";
      sectionsEl.innerHTML = "";
      stepsEl.innerHTML = "";
      progressBarEl.style.width = "0%";
      tooltip.classList.remove("is-visible");
      anchorNoteEl.classList.remove("is-visible");
      return;
    }

    shell.dataset.mode = state.mode;
    modelEl.textContent = state.script.modelName
      ? `${state.script.modelName}${state.script.modelId ? ` · ${state.script.modelId}` : ""}`
      : "Model unavailable";
    metaEl.textContent = `${state.script.kind === "flowchart" ? "Flowchart annotations" : "Trace walkthrough"} · ${state.script.steps.length} ${state.script.steps.length === 1 ? "beat" : "beats"}`;
    overviewTitleEl.textContent = state.script.title || (state.graph?.title || "Code tour");
    openingEl.textContent = state.script.opening || "";
    overviewEl.textContent = state.script.overview || "";
    renderTakeaways();
    renderBeatRail();
    renderSections();
    renderTransport();
    renderStepsList();

    const currentStep = resolveCurrentStep();
    const text = currentStep?.narration || state.script.opening || state.script.overview || "";
    subtitleKickerEl.textContent = currentStep ? formatStepKicker() : "Overview";
    subtitleTitleEl.textContent = currentStep?.title || state.script.title || (state.graph?.title || "Code tour");
    subtitleTextEl.textContent = text;
    subtitleWhyEl.textContent = currentStep?.whyItMatters || "";
    subtitleWhyEl.style.display = currentStep?.whyItMatters ? "block" : "none";
    renderProgress();
    renderNoteButton(currentStep);
    syncFocusedNode(currentStep);
    positionTooltip(currentStep, text);
    positionAnchorNote(currentStep, text);
    animateStepChange(currentStep);
  }

  function renderTransport() {
    const hasSteps = !!state.script?.steps?.length;
    rootEl.querySelector('[data-action="prev"]').disabled = !hasSteps;
    rootEl.querySelector('[data-action="next"]').disabled = !hasSteps;
    playBtn.disabled = !hasSteps;
    playBtn.textContent = state.playing ? "Pause" : "Play";
    noteBtn.disabled = !hasSteps;
    speedSelect.disabled = !hasSteps;
  }

  function renderNoteButton(currentStep) {
    if (!noteBtn) return;
    const hasNoteTarget = !!resolveStepAnchorTarget(currentStep);
    noteBtn.disabled = !hasNoteTarget;
    noteBtn.textContent = state.noteOpen ? "Hide note" : "Note";
  }

  function renderStepsList() {
    if (!state.script) {
      stepsEl.innerHTML = "";
      return;
    }
    const activeTraceIndex = state.stepIndex;
    const visibleIndexes = getVisibleStepIndexes();
    stepsEl.innerHTML = state.script.steps
      .map((step, index) => {
        if (!visibleIndexes.has(index)) return "";
        const isActive = state.script.kind === "trace"
          ? step.edgeIndex === activeTraceIndex
          : index === state.stepIndex;
        const label = step.title || step.toNodeId || step.nodeId || step.fromNodeId || `Step ${index + 1}`;
        const evidence = Array.isArray(step.evidence)
          ? step.evidence.slice(0, 2).map((item) => `<span class="cm-narration-evidence-pill">${escapeHtml(item.label)}: ${escapeHtml(item.detail)}</span>`).join("")
          : "";
        return `
          <button class="cm-narration-step${isActive ? " is-active" : ""}" data-step-index="${index}" type="button">
            <span class="cm-narration-step-label">${index + 1}. ${escapeHtml(label)}</span>
            <span class="cm-narration-step-text">${escapeHtml(step.narration)}</span>
            ${step.whyItMatters ? `<span class="cm-narration-step-why">${escapeHtml(step.whyItMatters)}</span>` : ""}
            ${evidence ? `<span class="cm-narration-step-evidence">${evidence}</span>` : ""}
          </button>
        `;
      })
      .join("");
    for (const element of stepsEl.querySelectorAll("[data-step-index]")) {
      element.addEventListener("click", () => {
        stopPlayback();
        const nextIndex = Number(element.getAttribute("data-step-index")) || 0;
        const currentIndex = resolveCurrentStepListIndex();
        state.noteOpen = nextIndex === currentIndex ? !state.noteOpen : true;
        moveToStep(nextIndex);
      });
    }
    const activeEl = stepsEl.querySelector(".cm-narration-step.is-active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function renderBeatRail() {
    if (!state.script?.steps?.length) {
      railEl.innerHTML = "";
      railEl.style.display = "none";
      return;
    }
    railEl.style.display = "flex";
    const activeIndex = resolveCurrentStepListIndex();
    railEl.innerHTML = state.script.steps
      .map((step, index) => {
        const active = index === activeIndex;
        const compact = state.script.steps.length > LARGE_SCRIPT_STEP_THRESHOLD;
        const label = compact ? `${index + 1}` : (step.title || `${index + 1}`);
        return `<button class="cm-narration-rail-beat${active ? " is-active" : ""}" data-rail-step="${index}" type="button" title="${escapeHtml(step.title || step.narration || `Beat ${index + 1}`)}">${escapeHtml(label)}</button>`;
      })
      .join("");
    for (const element of railEl.querySelectorAll("[data-rail-step]")) {
      element.addEventListener("click", () => {
        stopPlayback();
        const nextIndex = Number(element.getAttribute("data-rail-step")) || 0;
        const currentIndex = resolveCurrentStepListIndex();
        state.noteOpen = nextIndex === currentIndex ? !state.noteOpen : true;
        moveToStep(nextIndex);
      });
    }
  }

  function getVisibleStepIndexes() {
    if (!state.script?.steps?.length) return new Set();
    if (state.script.steps.length <= LARGE_SCRIPT_STEP_THRESHOLD) {
      return new Set(state.script.steps.map((_step, index) => index));
    }
    const activeIndex = resolveCurrentStepListIndex();
    const indexes = new Set([0, state.script.steps.length - 1]);
    for (let offset = -LARGE_SCRIPT_WINDOW_RADIUS; offset <= LARGE_SCRIPT_WINDOW_RADIUS; offset += 1) {
      const index = activeIndex + offset;
      if (index >= 0 && index < state.script.steps.length) indexes.add(index);
    }
    return indexes;
  }

  function positionTooltip(step, text) {
    if (state.noteOpen || state.mode !== "tooltip" || !text) {
      tooltip.classList.remove("is-visible");
      return;
    }
    const target = resolveStepAnchorTarget(step);
    if (!target) {
      tooltip.classList.remove("is-visible");
      return;
    }
    const rect = target.getBoundingClientRect();
    tooltip.innerHTML = `
      <div class="cm-narration-tooltip-title">${escapeHtml(step?.title || state.script?.title || "Narration")}</div>
      <div class="cm-narration-tooltip-text">${escapeHtml(text)}</div>
      ${step?.whyItMatters ? `<div class="cm-narration-tooltip-why">${escapeHtml(step.whyItMatters)}</div>` : ""}
    `;
    tooltip.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    tooltip.style.top = `${Math.round(rect.top - 12)}px`;
    tooltip.classList.add("is-visible");
  }

  function positionAnchorNote(step, text) {
    if (!state.noteOpen || !text) {
      anchorNoteEl.classList.remove("is-visible");
      return;
    }
    const target = resolveStepAnchorTarget(step);
    if (!target) {
      anchorNoteEl.classList.remove("is-visible");
      return;
    }
    anchorNoteEl.innerHTML = `
      <button type="button" class="cm-narration-anchor-note-close" aria-label="Close note">Close</button>
      <div class="cm-narration-anchor-note-kicker">Beat note</div>
      <div class="cm-narration-anchor-note-title">${escapeHtml(step?.title || state.script?.title || "Narration")}</div>
      <div class="cm-narration-anchor-note-text">${escapeHtml(text)}</div>
      ${step?.whyItMatters ? `<div class="cm-narration-anchor-note-why">${escapeHtml(step.whyItMatters)}</div>` : ""}
    `;
    anchorNoteEl.querySelector(".cm-narration-anchor-note-close")?.addEventListener("click", () => {
      state.noteOpen = false;
      render();
    });
    anchorNoteEl.classList.add("is-visible");
    const rect = target.getBoundingClientRect();
    const noteRect = anchorNoteEl.getBoundingClientRect();
    const preferredLeft = rect.right + 14;
    const fallbackLeft = rect.left - noteRect.width - 14;
    const left = preferredLeft + noteRect.width <= window.innerWidth - 12
      ? preferredLeft
      : Math.max(12, fallbackLeft);
    const top = clamp(rect.top + rect.height / 2 - noteRect.height / 2, 56, window.innerHeight - noteRect.height - 12);
    anchorNoteEl.style.left = `${Math.round(left)}px`;
    anchorNoteEl.style.top = `${Math.round(top)}px`;
  }

  function resolveStepAnchorTarget(step) {
    const nodeId = step?.toNodeId || step?.nodeId || step?.fromNodeId;
    return nodeId ? resolveNodeElement?.(nodeId) : null;
  }

  function renderTakeaways() {
    if (!state.script?.takeaways?.length) {
      takeawaysEl.innerHTML = "";
      takeawaysEl.style.display = "none";
      return;
    }
    takeawaysEl.style.display = "grid";
    takeawaysEl.innerHTML = state.script.takeaways
      .map((item) => `<div class="cm-narration-takeaway">${escapeHtml(item)}</div>`)
      .join("");
  }

  function renderSections() {
    if (!state.script?.sections?.length) {
      sectionsEl.innerHTML = "";
      sectionsEl.style.display = "none";
      return;
    }
    sectionsEl.style.display = "grid";
    sectionsEl.innerHTML = state.script.sections
      .map((section) => `
        <div class="cm-narration-section-card">
          <div class="cm-narration-section-title">${escapeHtml(section.title)}</div>
          <div class="cm-narration-section-summary">${escapeHtml(section.summary)}</div>
        </div>
      `)
      .join("");
  }

  function renderProgress() {
    if (!state.script?.steps?.length) {
      progressBarEl.style.width = "0%";
      return;
    }
    const stepIndex = resolveCurrentStepListIndex();
    const ratio = stepIndex < 0 ? 0 : (stepIndex + 1) / state.script.steps.length;
    progressBarEl.style.width = `${Math.max(0, Math.min(100, Math.round(ratio * 100)))}%`;
  }

  function resolveCurrentStepListIndex() {
    if (!state.script?.steps?.length) return -1;
    if (state.script.kind === "trace") {
      if (state.stepIndex < 0) return -1;
      const index = state.script.steps.findIndex((step) => step.edgeIndex === state.stepIndex);
      return index >= 0 ? index : Math.min(state.stepIndex, state.script.steps.length - 1);
    }
    return Math.max(0, Math.min(state.stepIndex, state.script.steps.length - 1));
  }

  function formatStepKicker() {
    const listIndex = resolveCurrentStepListIndex();
    if (listIndex < 0 || !state.script) return "Overview";
    return `Beat ${listIndex + 1} of ${state.script.steps.length}`;
  }

  function animateStepChange(currentStep) {
    const renderKey = `${state.mode}|${state.script?.graphId || "none"}|${currentStep?.nodeId || currentStep?.toNodeId || currentStep?.edgeIndex || "overview"}`;
    if (!motionAnimate || state.lastRenderKey === renderKey) {
      state.lastRenderKey = renderKey;
      return;
    }
    state.lastRenderKey = renderKey;
    for (const element of [subtitle, subtitleTitleEl, subtitleTextEl, subtitleWhyEl]) {
      if (!element || element.offsetParent === null) continue;
      motionAnimate(
        element,
        { opacity: [0.4, 1], y: [8, 0] },
        { duration: 0.22, easing: "ease-out" },
      );
    }
    const activeEl = stepsEl.querySelector(".cm-narration-step.is-active");
    if (activeEl) {
      motionAnimate(
        activeEl,
        { opacity: [0.6, 1], x: [10, 0] },
        { duration: 0.2, easing: "ease-out" },
      );
    }
  }

  function syncFocusedNode(step) {
    clearNarrationHighlights();
    if (state.focusedNodeEl) {
      state.focusedNodeEl.classList.remove("codemap-narration-focus-node");
      state.focusedNodeEl = null;
    }
    const nodeId = step?.nodeId || step?.toNodeId || step?.fromNodeId;
    if (!nodeId) return;
    const element = resolveNodeElement?.(nodeId);
    if (element) {
      addNarrationClass(element, "codemap-narration-focus-node");
      state.focusedNodeEl = element;
    }
    applyFlowchartChoreography(step, nodeId);
  }

  function applyFlowchartChoreography(step, nodeId) {
    const graph = state.graph || getCurrentGraph?.();
    if (!graph || graph.graphType !== "flowchart") return;
    const nodeById = new Map((graph.nodes || []).map((node) => [node.id, node]));
    const node = nodeById.get(nodeId);
    if (!node) return;

    const groups = normalizeGroups(graph.metadata?.groups);
    const groupDepth = buildGroupDepthMap(groups);
    const groupsForNode = groups
      .filter((group) => group.nodeSet.has(nodeId))
      .sort((left, right) => (groupDepth.get(right.id) || 0) - (groupDepth.get(left.id) || 0));
    const nearestLoopGroup = groupsForNode.find((group) => isLoopLikeGroup(group.kind));
    const nearestBranchGroup = groupsForNode.find((group) => group.kind === "branch");
    const outgoing = (graph.edges || []).filter((edge) => edge.from === nodeId);

    if (node.kind === "decision") {
      addNarrationClass(elementOrNull(nodeId), "codemap-narration-branch-node");
      for (const edge of outgoing) {
        const accent = getBranchAccent(edge.label);
        addNarrationClass(elementOrNull(edge.to), accent.nodeClassName);
        addNarrationClass(resolveEdgeElement(makeRenderedEdgeId(edge.from, edge.to, edge.label || "")), accent.edgeClassName);
      }
    }

    if (nearestBranchGroup) {
      const branchAccent = inferBranchAccentFromGroup(nearestBranchGroup);
      highlightGroupRegion(nearestBranchGroup, graph, branchAccent.nodeClassName, branchAccent.edgeClassName);
      const decisionAncestor = findDecisionAncestor(graph, nearestBranchGroup);
      if (decisionAncestor) addNarrationClass(elementOrNull(decisionAncestor), "codemap-narration-branch-node");
      addNarrationClass(resolveGroupElement(nearestBranchGroup.id), branchAccent.groupClassName);
    }

    if (node.kind === "loop" || nearestLoopGroup) {
      const loopGroup = nearestLoopGroup || findNearestLoopGroup(groups, groupDepth, nodeId);
      if (loopGroup) {
        highlightGroupRegion(loopGroup, graph, "codemap-narration-loop-region-node", "codemap-narration-region-edge");
        addNarrationClass(resolveGroupElement(loopGroup.id), "codemap-narration-loop-group");
        const loopHeaders = loopGroup.nodeIds.filter((candidateId) => nodeById.get(candidateId)?.kind === "loop");
        loopHeaders.forEach((candidateId) => addNarrationClass(elementOrNull(candidateId), "codemap-narration-loop-node"));
      }
      for (const edge of outgoing) {
        const label = String(edge.label || "").toLowerCase();
        if (/repeat|continue|body|done|exit/.test(label) || node.kind === "loop") {
          addNarrationClass(resolveEdgeElement(makeRenderedEdgeId(edge.from, edge.to, edge.label || "")), "codemap-narration-focus-edge");
          addNarrationClass(elementOrNull(edge.to), "codemap-narration-loop-region-node");
        }
      }
    }

    if (!nearestBranchGroup && !nearestLoopGroup && node.kind !== "decision" && node.kind !== "loop") {
      const neighboringIds = outgoing.map((edge) => edge.to).slice(0, 2);
      neighboringIds.forEach((targetId) => addNarrationClass(elementOrNull(targetId), "codemap-narration-region-node"));
    }
  }

  function highlightGroupRegion(group, graph, nodeClassName, edgeClassName) {
    if (!group) return;
    const nodeSet = group.nodeSet;
    for (const groupNodeId of group.nodeIds) {
      addNarrationClass(elementOrNull(groupNodeId), nodeClassName);
    }
    for (const edge of graph.edges || []) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        addNarrationClass(resolveEdgeElement(makeRenderedEdgeId(edge.from, edge.to, edge.label || "")), edgeClassName);
      }
    }
  }

  function resolveGroupElement(groupId) {
    if (!canvasEl || !groupId) return null;
    const safeGroupId = selectorEscape(groupId);
    return canvasEl.querySelector(`[data-id="group:${safeGroupId}"]`)
      || canvasEl.querySelector(`[data-id="groupheader:${safeGroupId}"]`)
      || canvasEl.querySelector(`[data-group-id="${safeGroupId}"]`);
  }

  function resolveEdgeElement(edgeId) {
    if (!canvasEl || !edgeId) return null;
    return canvasEl.querySelector(`.react-flow__edge[data-id="${selectorEscape(edgeId)}"]`)
      || canvasEl.querySelector(`[data-id="${selectorEscape(edgeId)}"]`);
  }

  function elementOrNull(nodeId) {
    return nodeId ? resolveNodeElement?.(nodeId) : null;
  }

  function addNarrationClass(element, className) {
    if (!element || !className) return;
    element.classList.add(className);
    state.highlightedElements.push({ element, className });
  }

  function clearNarrationHighlights() {
    if (!state.highlightedElements.length) return;
    for (const entry of state.highlightedElements) {
      entry.element?.classList?.remove(entry.className);
    }
    state.highlightedElements = [];
  }

  return { setGraph, load, clear, advance };
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];
  return rawGroups
    .filter((group) => group && typeof group.id === "string" && Array.isArray(group.nodeIds) && group.nodeIds.length)
    .map((group) => ({
      id: String(group.id),
      kind: String(group.kind || "branch"),
      label: String(group.label || group.kind || group.id),
      nodeIds: Array.from(new Set(group.nodeIds.map(String))),
      nodeSet: new Set(group.nodeIds.map(String)),
      parentGroupId: group.parentGroupId ? String(group.parentGroupId) : null,
    }));
}

function buildGroupDepthMap(groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const depth = new Map();
  function resolve(id) {
    if (depth.has(id)) return depth.get(id);
    const group = byId.get(id);
    if (!group || !group.parentGroupId) {
      depth.set(id, 0);
      return 0;
    }
    const value = resolve(group.parentGroupId) + 1;
    depth.set(id, value);
    return value;
  }
  groups.forEach((group) => resolve(group.id));
  return depth;
}

function isLoopLikeGroup(kind) {
  return kind === "loop" || kind === "loop_body";
}

function findNearestLoopGroup(groups, groupDepth, nodeId) {
  return groups
    .filter((group) => isLoopLikeGroup(group.kind) && group.nodeSet.has(nodeId))
    .sort((left, right) => (groupDepth.get(right.id) || 0) - (groupDepth.get(left.id) || 0))[0];
}

function findDecisionAncestor(graph, branchGroup) {
  const nodeSet = branchGroup.nodeSet;
  const incoming = (graph.edges || []).filter((edge) => !nodeSet.has(edge.from) && nodeSet.has(edge.to));
  const candidate = incoming.find((edge) => {
    const sourceNode = (graph.nodes || []).find((node) => node.id === edge.from);
    return sourceNode?.kind === "decision";
  });
  return candidate?.from || null;
}

function inferBranchAccentFromGroup(group) {
  return getBranchAccent(group?.label || group?.kind || "");
}

function getBranchAccent(label) {
  const text = String(label || "").trim().toLowerCase();
  if (/yes|true|then|ok|body/.test(text)) {
    return {
      nodeClassName: "codemap-narration-branch-yes-node",
      edgeClassName: "codemap-narration-branch-yes-edge",
      groupClassName: "codemap-narration-branch-yes-group",
    };
  }
  if (/no|false|else|done|exit/.test(text)) {
    return {
      nodeClassName: "codemap-narration-branch-no-node",
      edgeClassName: "codemap-narration-branch-no-edge",
      groupClassName: "codemap-narration-branch-no-group",
    };
  }
  return {
    nodeClassName: "codemap-narration-branch-region-node",
    edgeClassName: "codemap-narration-region-edge",
    groupClassName: "codemap-narration-region-group",
  };
}

function makeRenderedEdgeId(fromId, toId, label) {
  return `${fromId}->${toId}::${label || ""}`;
}

function selectorEscape(value) {
  const text = String(value || "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(text);
  return text.replace(/(["\\])/g, "\\$1");
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
