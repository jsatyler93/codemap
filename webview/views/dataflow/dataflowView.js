import { computeActiveEdges, computeVisibleNodes, deriveDataFlowEdges } from "./edgeDerivation.js";
import { renderEdgeOverlay } from "./edgeRenderer.js";
import { highlightPythonLine } from "./syntaxHighlight.js";
import { renderVariableSidebar } from "./variableSidebar.js";

const OVERLAY_ID = "codemap-dataflow-overlay";

export function renderDataflowView(graph) {
  const canvas = document.getElementById("canvas");
  removeDataflowOverlay();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "df-overlay";

  const state = {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    collapsedGroups: new Set(),
    hoveredNodeId: null,
    selectedVariable: null,
    showAllEdges: false,
    showControlFlow: true,
  };

  for (const n of state.nodes) {
    const meta = n.metadata || {};
    if (meta.groupRole === "start" && meta.groupId && meta.groupId !== "func-body") {
      state.collapsedGroups.add(meta.groupId);
    }
  }

  const toolbar = buildToolbar(state, rerender);
  const main = document.createElement("div");
  main.className = "df-main";

  const codePanel = document.createElement("div");
  codePanel.className = "df-code-panel";
  const sidebar = document.createElement("div");
  sidebar.className = "df-sidebar";

  main.appendChild(codePanel);
  main.appendChild(sidebar);
  overlay.appendChild(toolbar);
  overlay.appendChild(main);
  canvas.appendChild(overlay);

  function rerender() {
    const visibleNodes = computeVisibleNodes(state.nodes, state.collapsedGroups);
    const dataEdges = deriveDataFlowEdges(visibleNodes);
    const activeEdges = computeActiveEdges(dataEdges, state);
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const controlEdges = state.showControlFlow
      ? state.edges
        .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, variable: "[cf]" }))
      : [];
    const baseEdges = state.showAllEdges ? dataEdges : activeEdges;
    const overlayEdges = baseEdges.concat(controlEdges);
    renderCodePanel(codePanel, visibleNodes, state, activeEdges, rerender);
    renderEdgeOverlay(codePanel, overlayEdges, activeEdges);
    renderVariableSidebar(sidebar, visibleNodes, state, rerender);
  }

  rerender();

  return {
    edgeRecords: [],
    nodeRect: new Map(),
    nodes: state.nodes,
    initialView: { scale: 1, panX: 0, panY: 0 },
  };
}

export function removeDataflowOverlay() {
  const old = document.getElementById(OVERLAY_ID);
  if (old) old.remove();
}

function buildToolbar(state, rerender) {
  const bar = document.createElement("div");
  bar.className = "df-toolbar";

  const expand = document.createElement("button");
  expand.textContent = "Expand all";
  expand.addEventListener("click", () => {
    state.collapsedGroups.clear();
    rerender();
  });
  bar.appendChild(expand);

  const collapse = document.createElement("button");
  collapse.textContent = "Collapse all";
  collapse.addEventListener("click", () => {
    state.collapsedGroups.clear();
    for (const n of state.nodes) {
      const meta = n.metadata || {};
      if (meta.groupRole === "start" && meta.groupId && meta.groupId !== "func-body") {
        state.collapsedGroups.add(meta.groupId);
      }
    }
    rerender();
  });
  bar.appendChild(collapse);

  const allEdgesLabel = document.createElement("label");
  const allEdges = document.createElement("input");
  allEdges.type = "checkbox";
  allEdges.checked = state.showAllEdges;
  allEdges.addEventListener("change", () => {
    state.showAllEdges = allEdges.checked;
    rerender();
  });
  allEdgesLabel.appendChild(allEdges);
  allEdgesLabel.appendChild(document.createTextNode(" Show all edges"));
  bar.appendChild(allEdgesLabel);

  const cfLabel = document.createElement("label");
  const cf = document.createElement("input");
  cf.type = "checkbox";
  cf.checked = state.showControlFlow;
  cf.addEventListener("change", () => {
    state.showControlFlow = cf.checked;
    rerender();
  });
  cfLabel.appendChild(cf);
  cfLabel.appendChild(document.createTextNode(" Control flow"));
  bar.appendChild(cfLabel);

  return bar;
}

function renderCodePanel(container, visibleNodes, state, activeEdges, rerender) {
  container.innerHTML = "";

  const connectedNodes = new Set();
  for (const e of activeEdges) {
    connectedNodes.add(e.from);
    connectedNodes.add(e.to);
  }
  if (state.hoveredNodeId) connectedNodes.add(state.hoveredNodeId);
  const hasFocus = !!state.hoveredNodeId || !!state.selectedVariable;

  for (const node of visibleNodes) {
    const meta = node.metadata || {};
    const row = document.createElement("div");
    row.className = "df-line";
    row.dataset.nodeId = node.id;

    if (hasFocus && !connectedNodes.has(node.id) && node.label) {
      row.classList.add("dimmed");
    }
    if (state.hoveredNodeId === node.id) row.classList.add("hovered");

    const lineNum = document.createElement("span");
    lineNum.className = "df-line-num";
    lineNum.textContent = String(meta.line || "");
    row.appendChild(lineNum);

    const toggle = document.createElement("span");
    toggle.className = "df-toggle";
    if (meta.groupRole === "start" && meta.groupId) {
      const collapsed = !!meta._isCollapsed || state.collapsedGroups.has(meta.groupId);
      toggle.textContent = collapsed ? "[+]" : "[-]";
      toggle.classList.add("clickable");
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.collapsedGroups.has(meta.groupId)) state.collapsedGroups.delete(meta.groupId);
        else state.collapsedGroups.add(meta.groupId);
        rerender();
      });
    }
    row.appendChild(toggle);

    const indent = document.createElement("span");
    indent.className = "df-indent";
    indent.style.width = `${(meta.depth || 0) * 20}px`;
    row.appendChild(indent);

    const code = document.createElement("span");
    code.className = `df-code kind-${node.kind || "process"}`;
    code.innerHTML = highlightPythonLine((meta.code || node.label || "").trimStart());
    row.appendChild(code);

    if (meta._isCollapsed) {
      const summary = document.createElement("span");
      summary.className = "df-collapsed-summary";
      summary.textContent = ` ${meta.summary || "scope"} (${meta._descendantCount || 0} lines)`;
      row.appendChild(summary);
    }

    row.addEventListener("mouseenter", () => {
      state.hoveredNodeId = node.id;
      state.selectedVariable = null;
      rerender();
    });
    row.addEventListener("mouseleave", () => {
      state.hoveredNodeId = null;
      rerender();
    });

    container.appendChild(row);
  }
}
