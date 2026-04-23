export function createProbePanel({ rootEl, onSelectNode, onDismissProbe, onRegenerateProbes, onOpenPlot }) {
  if (!rootEl) {
    return {
      setEntries() {},
      clear() {},
    };
  }
  const panel = document.createElement("aside");
  panel.className = "cm-probe-panel";
  rootEl.appendChild(panel);

  function setEntries(entries) {
    panel.innerHTML = entries.length
      ? `
        <div class="cm-probe-panel-title">surgical probes</div>
        ${entries.map((entry) => `
          <section class="cm-probe-panel-entry${entry.error ? " is-error" : ""}" data-probe-id="${escapeHtml(entry.probeId)}">
            <button class="cm-probe-panel-main" data-node-id="${escapeHtml(entry.nodeId)}" type="button">
              <span class="cm-probe-panel-label">${escapeHtml(entry.label)}</span>
              <span class="cm-probe-panel-meta">${escapeHtml(entry.meta)}</span>
            </button>
            <div class="cm-probe-panel-actions">
              <button type="button" data-action="plot" data-probe-id="${escapeHtml(entry.probeId)}" ${entry.canPlot ? "" : "disabled"}>plot</button>
              <button type="button" data-action="rerun" data-node-id="${escapeHtml(entry.nodeId)}">rerun</button>
              <button type="button" data-action="dismiss" data-probe-id="${escapeHtml(entry.probeId)}">dismiss</button>
            </div>
          </section>
        `).join("")}`
      : "";
    panel.style.display = entries.length ? "grid" : "none";
    for (const button of panel.querySelectorAll(".cm-probe-panel-main[data-node-id]")) {
      button.addEventListener("click", () => onSelectNode?.(button.getAttribute("data-node-id")));
    }
    for (const button of panel.querySelectorAll('[data-action="plot"]')) {
      button.addEventListener("click", () => onOpenPlot?.(button.getAttribute("data-probe-id")));
    }
    for (const button of panel.querySelectorAll('[data-action="rerun"]')) {
      button.addEventListener("click", () => onRegenerateProbes?.(button.getAttribute("data-node-id")));
    }
    for (const button of panel.querySelectorAll('[data-action="dismiss"]')) {
      button.addEventListener("click", () => onDismissProbe?.(button.getAttribute("data-probe-id")));
    }
  }

  function clear() {
    setEntries([]);
  }

  return { setEntries, clear };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (match) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[match]);
}