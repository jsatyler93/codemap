import * as vscode from "vscode";

const SHOW_EVIDENCE_KEY = "codemap.showEvidence";
const REPEL_STRENGTH_KEY = "codemap.repelStrength";
const ATTRACT_STRENGTH_KEY = "codemap.attractStrength";
const AMBIENT_REPEL_STRENGTH_KEY = "codemap.ambientRepelStrength";
const COHESION_STRENGTH_KEY = "codemap.cohesionStrength";
const TREE_VIEW_KEY = "codemap.treeView";
const FLOWCHART_LAYOUT_MODE_KEY = "codemap.flowchartLayoutMode";

interface ExecuteCommandMessage {
  type: "executeCommand";
  command: string;
}

interface ToggleEvidenceMessage {
  type: "toggleEvidence";
  enabled: boolean;
}

interface SetRepelStrengthMessage {
  type: "setRepelStrength";
  value: number;
}

interface SetAttractStrengthMessage {
  type: "setAttractStrength";
  value: number;
}

interface SetAmbientRepelStrengthMessage {
  type: "setAmbientRepelStrength";
  value: number;
}

interface SetCohesionStrengthMessage {
  type: "setCohesionStrength";
  value: number;
}

interface ToggleTreeViewMessage {
  type: "toggleTreeView";
  enabled: boolean;
}

interface SetLayoutModeMessage {
  type: "setLayoutMode";
  mode: "tree" | "lanes" | "freeform";
}

interface ReadyMessage {
  type: "ready";
}

type ActionsInbound = ExecuteCommandMessage | ToggleEvidenceMessage | SetRepelStrengthMessage | SetAttractStrengthMessage | SetAmbientRepelStrengthMessage | SetCohesionStrengthMessage | ToggleTreeViewMessage | SetLayoutModeMessage | ReadyMessage;

/**
 * Sidebar actions panel: buttons that trigger CodeMap commands plus a small
 * settings block that toggles common configuration values. Renders inline HTML
 * styled with VS Code theme variables.
 */
export class ActionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codemap.actions";

  private view: vscode.WebviewView | undefined;
  private lastSummary: { checked: number; total: number } = { checked: 0, total: 0 };
  private showEvidence: boolean;
  private repelStrength: number;
  private attractStrength: number;
  private ambientRepelStrength: number;
  private cohesionStrength: number;
  private treeView: boolean;
  private layoutMode: "tree" | "lanes" | "freeform";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUiStateChanged: (state: { showEvidence: boolean; repelStrength: number; attractStrength: number; ambientRepelStrength: number; cohesionStrength: number; layoutMode: "tree" | "lanes" | "freeform"; treeView: boolean }) => void,
  ) {
    this.showEvidence = context.workspaceState.get<boolean>(SHOW_EVIDENCE_KEY, false);
    this.repelStrength = clamp01(context.workspaceState.get<number>(REPEL_STRENGTH_KEY, 0.45));
    this.attractStrength = clamp01(context.workspaceState.get<number>(ATTRACT_STRENGTH_KEY, 0.32));
    this.ambientRepelStrength = clamp01(context.workspaceState.get<number>(AMBIENT_REPEL_STRENGTH_KEY, 0.18));
    this.cohesionStrength = clamp01(context.workspaceState.get<number>(COHESION_STRENGTH_KEY, 0.34));
    this.treeView = context.workspaceState.get<boolean>(TREE_VIEW_KEY, false);
    this.layoutMode = context.workspaceState.get<"tree" | "lanes" | "freeform">(
      FLOWCHART_LAYOUT_MODE_KEY,
      this.treeView ? "tree" : "lanes",
    );
    this.treeView = this.layoutMode === "tree";
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ActionsInbound) => {
      if (msg.type === "executeCommand") {
        void vscode.commands.executeCommand(msg.command);
      } else if (msg.type === "toggleEvidence") {
        this.showEvidence = !!msg.enabled;
        void this.context.workspaceState.update(SHOW_EVIDENCE_KEY, this.showEvidence);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setRepelStrength") {
        this.repelStrength = clamp01(msg.value);
        void this.context.workspaceState.update(REPEL_STRENGTH_KEY, this.repelStrength);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setAttractStrength") {
        this.attractStrength = clamp01(msg.value);
        void this.context.workspaceState.update(ATTRACT_STRENGTH_KEY, this.attractStrength);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setAmbientRepelStrength") {
        this.ambientRepelStrength = clamp01(msg.value);
        void this.context.workspaceState.update(AMBIENT_REPEL_STRENGTH_KEY, this.ambientRepelStrength);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setCohesionStrength") {
        this.cohesionStrength = clamp01(msg.value);
        void this.context.workspaceState.update(COHESION_STRENGTH_KEY, this.cohesionStrength);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "toggleTreeView") {
        this.treeView = !!msg.enabled;
        this.layoutMode = this.treeView ? "tree" : "lanes";
        void this.context.workspaceState.update(TREE_VIEW_KEY, this.treeView);
        void this.context.workspaceState.update(FLOWCHART_LAYOUT_MODE_KEY, this.layoutMode);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setLayoutMode") {
        this.layoutMode = msg.mode;
        this.treeView = this.layoutMode === "tree";
        void this.context.workspaceState.update(FLOWCHART_LAYOUT_MODE_KEY, this.layoutMode);
        void this.context.workspaceState.update(TREE_VIEW_KEY, this.treeView);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "ready") {
        this.postSelection(this.lastSummary);
        this.postUiState();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  /** Update the "N / M files selected" badge in the panel. */
  updateSelection(summary: { checked: number; total: number }): void {
    this.lastSummary = summary;
    this.postSelection(summary);
  }

  private postSelection(summary: { checked: number; total: number }): void {
    this.view?.webview.postMessage({
      type: "selectionUpdate",
      checked: summary.checked,
      total: summary.total,
    });
  }

  getShowEvidence(): boolean {
    return this.showEvidence;
  }

  getUiState(): { showEvidence: boolean; repelStrength: number; attractStrength: number; ambientRepelStrength: number; cohesionStrength: number; layoutMode: "tree" | "lanes" | "freeform"; treeView: boolean } {
    return {
      showEvidence: this.showEvidence,
      repelStrength: this.repelStrength,
      attractStrength: this.attractStrength,
      ambientRepelStrength: this.ambientRepelStrength,
      cohesionStrength: this.cohesionStrength,
      layoutMode: this.layoutMode,
      treeView: this.treeView,
    };
  }

  private postUiState(): void {
    this.view?.webview.postMessage({
      type: "uiState",
      showEvidence: this.showEvidence,
      repelStrength: this.repelStrength,
      attractStrength: this.attractStrength,
      ambientRepelStrength: this.ambientRepelStrength,
      cohesionStrength: this.cohesionStrength,
      layoutMode: this.layoutMode,
      treeView: this.treeView,
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body {
    padding: 8px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .badge {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
    padding: 4px 6px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    background: var(--vscode-editor-background);
  }
  .section-title {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin: 12px 0 6px;
  }
  label.toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  label.toggle input {
    accent-color: var(--vscode-focusBorder);
  }
  .slider-block {
    margin-top: 10px;
  }
  details.dropdown {
    margin-top: 12px;
  }
  details.dropdown summary {
    list-style: none;
    cursor: pointer;
    padding: 0;
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  details.dropdown summary::-webkit-details-marker {
    display: none;
  }
  details.dropdown summary::before {
    content: ">";
    color: var(--vscode-descriptionForeground);
    transform: rotate(0deg);
    transition: transform 120ms ease;
  }
  details.dropdown[open] summary::before {
    transform: rotate(90deg);
  }
  .dropdown-content {
    padding: 6px 0 0;
  }
  .preset-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    margin-bottom: 8px;
  }
  button.preset {
    flex: 1;
    padding: 5px 6px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 11px;
  }
  button.preset:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .slider-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }
  .slider-value {
    min-width: 32px;
    text-align: right;
    color: var(--vscode-foreground);
    font-variant-numeric: tabular-nums;
  }
  input[type="range"] {
    width: 100%;
  }
  button.action {
    display: block;
    width: 100%;
    text-align: left;
    margin: 6px 0;
    padding: 8px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 7px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    transition: border-color 120ms ease, transform 90ms ease, background 120ms ease;
  }
  button.action:hover {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.action:active {
    transform: translateY(1px);
  }
</style>
</head>
<body>
  <div class="badge" id="selection-badge">0 / 0 files selected</div>

  <div class="section-title">Visualize</div>
  <button class="action" data-cmd="codemap.showWorkspaceGraph">Workspace Call Graph</button>
  <button class="action" data-cmd="codemap.refresh">&#x21bb; Refresh Analysis</button>

  <details class="dropdown">
    <summary>Display Settings</summary>
    <div class="dropdown-content">
      <label class="toggle"><input id="toggle-evidence" type="checkbox" /> Show Evidence Details</label>
      <div class="slider-block">
        <div class="slider-row"><span>Flowchart Layout</span></div>
        <select id="layout-mode" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--vscode-panel-border);background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);">
          <option value="tree">Tree</option>
          <option value="lanes">Structured Lanes</option>
          <option value="freeform">Freeform</option>
        </select>
      </div>
      <div class="preset-row">
        <button class="preset" data-preset="tidy">Tidy</button>
        <button class="preset" data-preset="balanced">Balanced</button>
        <button class="preset" data-preset="loose">Loose</button>
      </div>
      <div class="slider-block">
        <div class="slider-row"><span>Overlap Repel</span><span class="slider-value" id="repel-value">0.45</span></div>
        <input id="repel-slider" type="range" min="0" max="1" step="0.05" value="0.45" />
      </div>
      <div class="slider-block">
        <div class="slider-row"><span>Link Attract</span><span class="slider-value" id="attract-value">0.32</span></div>
        <input id="attract-slider" type="range" min="0" max="1" step="0.05" value="0.32" />
      </div>
      <div class="slider-block">
        <div class="slider-row"><span>Ambient Repel</span><span class="slider-value" id="ambient-repel-value">0.18</span></div>
        <input id="ambient-repel-slider" type="range" min="0" max="1" step="0.05" value="0.18" />
      </div>
      <div class="slider-block">
        <div class="slider-row"><span>Field Cohesion</span><span class="slider-value" id="cohesion-value">0.34</span></div>
        <input id="cohesion-slider" type="range" min="0" max="1" step="0.05" value="0.34" />
      </div>
    </div>
  </details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const evidenceToggle = document.getElementById('toggle-evidence');
  const layoutModeSelect = document.getElementById('layout-mode');
  const repelSlider = document.getElementById('repel-slider');
  const repelValue = document.getElementById('repel-value');
  const attractSlider = document.getElementById('attract-slider');
  const attractValue = document.getElementById('attract-value');
  const ambientRepelSlider = document.getElementById('ambient-repel-slider');
  const ambientRepelValue = document.getElementById('ambient-repel-value');
  const cohesionSlider = document.getElementById('cohesion-slider');
  const cohesionValue = document.getElementById('cohesion-value');
  let pendingTimer = null;
  const presets = {
    tidy: { repel: 0.72, attract: 0.22, ambient: 0.10, cohesion: 0.58 },
    balanced: { repel: 0.45, attract: 0.32, ambient: 0.18, cohesion: 0.34 },
    loose: { repel: 0.30, attract: 0.42, ambient: 0.30, cohesion: 0.18 },
  };

  document.querySelectorAll('button.action').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'executeCommand', command: btn.dataset.cmd });
    });
  });
  document.querySelectorAll('button.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = presets[btn.dataset.preset];
      if (!preset) return;
      repelSlider.value = String(preset.repel);
      attractSlider.value = String(preset.attract);
      ambientRepelSlider.value = String(preset.ambient);
      cohesionSlider.value = String(preset.cohesion);
      commitForcePreview();
    });
  });

  evidenceToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleEvidence', enabled: evidenceToggle.checked });
  });
  layoutModeSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setLayoutMode', mode: layoutModeSelect.value });
  });

  function updateSliderLabels() {
    repelValue.textContent = Number(repelSlider.value).toFixed(2);
    attractValue.textContent = Number(attractSlider.value).toFixed(2);
    ambientRepelValue.textContent = Number(ambientRepelSlider.value).toFixed(2);
    cohesionValue.textContent = Number(cohesionSlider.value).toFixed(2);
  }

  function postForceState() {
    vscode.postMessage({ type: 'setRepelStrength', value: Number(repelSlider.value) });
    vscode.postMessage({ type: 'setAttractStrength', value: Number(attractSlider.value) });
    vscode.postMessage({ type: 'setAmbientRepelStrength', value: Number(ambientRepelSlider.value) });
    vscode.postMessage({ type: 'setCohesionStrength', value: Number(cohesionSlider.value) });
  }

  function scheduleForcePreview() {
    updateSliderLabels();
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      postForceState();
    }, 85);
  }

  function commitForcePreview() {
    updateSliderLabels();
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    postForceState();
  }

  [repelSlider, attractSlider, ambientRepelSlider, cohesionSlider].forEach((slider) => {
    slider.addEventListener('input', scheduleForcePreview);
    slider.addEventListener('change', commitForcePreview);
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'selectionUpdate') {
      document.getElementById('selection-badge').textContent =
        msg.checked + ' / ' + msg.total + ' files selected';
    } else if (msg.type === 'uiState') {
      evidenceToggle.checked = !!msg.showEvidence;
      layoutModeSelect.value = msg.layoutMode || (msg.treeView ? 'tree' : 'lanes');
      repelSlider.value = String(typeof msg.repelStrength === 'number' ? msg.repelStrength : 0.35);
      attractSlider.value = String(typeof msg.attractStrength === 'number' ? msg.attractStrength : 0.28);
      ambientRepelSlider.value = String(typeof msg.ambientRepelStrength === 'number' ? msg.ambientRepelStrength : 0.18);
      cohesionSlider.value = String(typeof msg.cohesionStrength === 'number' ? msg.cohesionStrength : 0.34);
      updateSliderLabels();
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0, Math.min(1, value));
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
