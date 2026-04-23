// Generic SVG canvas with pan/zoom. Used by both view modes.
export const NS = "http://www.w3.org/2000/svg";

export function makeSvgCanvas(canvasEl) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  canvasEl.appendChild(svg);

  const root = document.createElementNS(NS, "g");
  svg.appendChild(root);

  const defs = document.createElementNS(NS, "defs");
  svg.appendChild(defs);

  const state = { scale: 0.85, panX: 30, panY: 20, panning: false, psx: 0, psy: 0 };

  const apply = () => {
    root.setAttribute("transform",
      `translate(${state.panX},${state.panY}) scale(${state.scale})`);
  };
  apply();

  canvasEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rc = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rc.left;
    const my = e.clientY - rc.top;
    const old = state.scale;
    state.scale = Math.min(4, Math.max(0.1, state.scale * (e.deltaY < 0 ? 1.08 : 0.93)));
    state.panX = mx - (mx - state.panX) * (state.scale / old);
    state.panY = my - (my - state.panY) * (state.scale / old);
    apply();
  }, { passive: false });

  canvasEl.addEventListener("mousedown", (e) => {
    if (e.target.closest("g[data-id]")) return;
    state.panning = true;
    state.psx = e.clientX - state.panX;
    state.psy = e.clientY - state.panY;
    canvasEl.classList.add("grabbing");
  });
  window.addEventListener("mousemove", (e) => {
    if (!state.panning) return;
    state.panX = e.clientX - state.psx;
    state.panY = e.clientY - state.psy;
    apply();
  });
  window.addEventListener("mouseup", () => {
    state.panning = false;
    canvasEl.classList.remove("grabbing");
  });

  function reset(initial = { scale: 0.85, panX: 30, panY: 20 }) {
    state.scale = initial.scale;
    state.panX  = initial.panX;
    state.panY  = initial.panY;
    apply();
  }

  function clear() {
    while (root.firstChild) root.removeChild(root.firstChild);
    while (defs.firstChild) defs.removeChild(defs.firstChild);
  }

  return { svg, root, defs, reset, clear, state };
}

export function mkArrow(defs, id, color) {
  const m = document.createElementNS(NS, "marker");
  m.setAttribute("id", id);
  m.setAttribute("viewBox", "0 0 10 6");
  m.setAttribute("refX", "10");
  m.setAttribute("refY", "3");
  m.setAttribute("markerWidth", "6");
  m.setAttribute("markerHeight", "4");
  m.setAttribute("orient", "auto");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M0,.8 L9,3 L0,5.2 Z");
  p.setAttribute("fill", color);
  m.appendChild(p);
  defs.appendChild(m);
}
