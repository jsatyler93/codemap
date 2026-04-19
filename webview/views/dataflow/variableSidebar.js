import { getVariableColor } from "./edgeRenderer.js";

const SKIP = new Set([
  "True", "False", "None", "self", "cls", "print", "len", "range", "enumerate", "zip", "map", "filter",
  "sorted", "list", "dict", "set", "tuple", "str", "int", "float", "bool", "type", "super", "isinstance",
  "hasattr", "getattr", "setattr",
]);

export function renderVariableSidebar(container, visibleNodes, state, rerender) {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "df-sidebar-header";
  header.textContent = "Variables";
  container.appendChild(header);

  const vars = new Set();
  for (const n of visibleNodes) {
    const meta = n.metadata || {};
    const reads = meta._aggregatedReads || meta.reads || [];
    const writes = meta._aggregatedWrites || meta.writes || [];
    reads.forEach((v) => vars.add(v));
    writes.forEach((v) => vars.add(v));
  }

  const sorted = Array.from(vars).filter((v) => !SKIP.has(v)).sort();
  for (const varName of sorted) {
    const entry = document.createElement("div");
    entry.className = "df-sidebar-variable";
    if (state.selectedVariable === varName) entry.classList.add("selected");
    entry.textContent = varName;
    entry.style.color = getVariableColor(varName);

    entry.addEventListener("mouseenter", () => {
      state.selectedVariable = varName;
      state.hoveredNodeId = null;
      rerender();
    });
    entry.addEventListener("mouseleave", () => {
      state.selectedVariable = null;
      rerender();
    });
    entry.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedVariable = state.selectedVariable === varName ? null : varName;
      state.hoveredNodeId = null;
      rerender();
    });

    container.appendChild(entry);
  }
}
