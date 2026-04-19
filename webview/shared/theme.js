// Shared theme tokens. Picked to match the look of the supplied templates.
export const theme = {
  bg: "#0a0c12",
  panelBg: "#0e1018",
  border: "#181c28",
  textDim: "#606680",
  textMuted: "#454a60",
  accent: "#7aa2f7",

  // Node-kind colors used by both views.
  nodeColor: {
    function: "#7aa2f7",
    method:   "#bb9af7",
    class:    "#e0af68",
    module:   "#73daca",
    entry:    "#9ece6a",
    return:   "#9ece6a",
    decision: "#e0af68",
    loop:     "#7dcfff",
    break:    "#ff9e64",
    continue: "#73daca",
    loop_else:"#c0caf5",
    process:  "#7aa2f7",
    compute:  "#bb9af7",
    output:   "#73daca",
    error:    "#f7768e",
  },

  // Resolution → edge color tint.
  edgeResolution: {
    resolved:   1.0,
    likely:     0.55,
    unresolved: 0.25,
  },
};

// Stable per-module color from a small palette.
const palette = [
  "#7aa2f7", "#bb9af7", "#9ece6a", "#73daca", "#e0af68",
  "#f7768e", "#7dcfff", "#c0a8e0", "#ff9e64", "#a3be8c",
];
const moduleColorCache = new Map();
export function moduleColor(mod) {
  if (!mod) return theme.accent;
  if (moduleColorCache.has(mod)) return moduleColorCache.get(mod);
  let h = 0;
  for (let i = 0; i < mod.length; i++) h = (h * 31 + mod.charCodeAt(i)) >>> 0;
  const c = palette[h % palette.length];
  moduleColorCache.set(mod, c);
  return c;
}
