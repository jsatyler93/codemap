const VARIABLE_COLORS = [
  "#22d3ee", "#f97316", "#a78bfa", "#34d399", "#fbbf24",
  "#f472b6", "#38bdf8", "#fb923c", "#e879f9", "#a3e635",
  "#ef4444", "#06b6d4", "#8b5cf6", "#10b981", "#f59e0b",
];

export function getVariableColor(varName) {
  let hash = 0;
  for (let i = 0; i < varName.length; i++) {
    hash = ((hash << 5) - hash + varName.charCodeAt(i)) | 0;
  }
  return VARIABLE_COLORS[Math.abs(hash) % VARIABLE_COLORS.length];
}

export function renderEdgeOverlay(rootEl, allEdges, activeEdges) {
  const old = rootEl.querySelector(".df-edge-svg");
  if (old) old.remove();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("df-edge-svg");
  svg.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:visible;";

  const panelRect = rootEl.getBoundingClientRect();
  const activeSet = new Set(activeEdges.map((e) => `${e.from}-${e.to}-${e.variable}`));
  const vars = Array.from(new Set(allEdges.map((e) => e.variable))).sort();
  const laneMap = {};
  vars.forEach((v, i) => {
    laneMap[v] = i;
  });

  const rightEdge = panelRect.width - 12;
  const laneWidth = 12;

  for (const edge of allEdges) {
    const fromEl = rootEl.querySelector(`[data-node-id="${cssEscape(edge.from)}"]`);
    const toEl = rootEl.querySelector(`[data-node-id="${cssEscape(edge.to)}"]`);
    if (!fromEl || !toEl) continue;

    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    const fromY = fr.top + fr.height / 2 - panelRect.top;
    const toY = tr.top + tr.height / 2 - panelRect.top;
    const lane = laneMap[edge.variable] || 0;
    const laneX = rightEdge - 22 - lane * laneWidth;

    const key = `${edge.from}-${edge.to}-${edge.variable}`;
    const isActive = activeSet.has(key);
    const color = getVariableColor(edge.variable);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${rightEdge - 4} ${fromY} L ${laneX} ${fromY} L ${laneX} ${toY} L ${rightEdge - 4} ${toY}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", isActive ? "1.4" : "0.8");
    path.setAttribute("opacity", isActive ? "0.8" : "0.16");
    path.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(path);

    if (isActive) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(laneX - 4));
      text.setAttribute("y", String((fromY + toY) / 2));
      text.setAttribute("fill", color);
      text.setAttribute("font-size", "9");
      text.setAttribute("font-family", "Consolas, monospace");
      text.setAttribute("text-anchor", "end");
      text.setAttribute("dominant-baseline", "middle");
      text.textContent = edge.variable;
      svg.appendChild(text);
    }
  }

  rootEl.appendChild(svg);
}

function cssEscape(id) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(id);
  return String(id).replace(/[\"\\]/g, "\\$&");
}
