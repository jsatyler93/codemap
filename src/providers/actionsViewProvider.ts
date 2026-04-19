import * as vscode from "vscode";

const SHOW_EVIDENCE_KEY = "codemap.showEvidence";
const REPEL_STRENGTH_KEY = "codemap.repelStrength";
const ATTRACT_STRENGTH_KEY = "codemap.attractStrength";
const AMBIENT_REPEL_STRENGTH_KEY = "codemap.ambientRepelStrength";

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

interface ReadyMessage {
  type: "ready";
}

type ActionsInbound = ExecuteCommandMessage | ToggleEvidenceMessage | SetRepelStrengthMessage | SetAttractStrengthMessage | SetAmbientRepelStrengthMessage | ReadyMessage;

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUiStateChanged: (state: { showEvidence: boolean; repelStrength: number; attractStrength: number; ambientRepelStrength: number }) => void,
  ) {
    this.showEvidence = context.workspaceState.get<boolean>(SHOW_EVIDENCE_KEY, false);
    this.repelStrength = clamp01(context.workspaceState.get<number>(REPEL_STRENGTH_KEY, 0.45));
    this.attractStrength = clamp01(context.workspaceState.get<number>(ATTRACT_STRENGTH_KEY, 0.32));
    this.ambientRepelStrength = clamp01(context.workspaceState.get<number>(AMBIENT_REPEL_STRENGTH_KEY, 0.18));
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

  getUiState(): { showEvidence: boolean; repelStrength: number; attractStrength: number; ambientRepelStrength: number } {
    return {
      showEvidence: this.showEvidence,
      repelStrength: this.repelStrength,
      attractStrength: this.attractStrength,
      ambientRepelStrength: this.ambientRepelStrength,
    };
  }

  private postUiState(): void {
    this.view?.webview.postMessage({
      type: "uiState",
      showEvidence: this.showEvidence,
      repelStrength: this.repelStrength,
      attractStrength: this.attractStrength,
      ambientRepelStrength: this.ambientRepelStrength,
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
    margin: 3px 0;
    padding: 6px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  button.action:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
</style>
</head>
<body>
  <div class="badge" id="selection-badge">0 / 0 files selected</div>

  <div class="section-title">Visualize</div>
  <button class="action" data-cmd="codemap.showWorkspaceGraph">Workspace Call Graph</button>
  <button class="action" data-cmd="codemap.refresh">Refresh Analysis</button>

  <div class="section-title">Display</div>
  <label class="toggle"><input id="toggle-evidence" type="checkbox" /> Show Evidence Details</label>
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

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const evidenceToggle = document.getElementById('toggle-evidence');
  const repelSlider = document.getElementById('repel-slider');
  const repelValue = document.getElementById('repel-value');
  const attractSlider = document.getElementById('attract-slider');
  const attractValue = document.getElementById('attract-value');
  const ambientRepelSlider = document.getElementById('ambient-repel-slider');
  const ambientRepelValue = document.getElementById('ambient-repel-value');
  let pendingTimer = null;
  const presets = {
    tidy: { repel: 0.72, attract: 0.22, ambient: 0.10 },
    balanced: { repel: 0.45, attract: 0.32, ambient: 0.18 },
    loose: { repel: 0.30, attract: 0.42, ambient: 0.30 },
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
      commitForcePreview();
    });
  });

  evidenceToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleEvidence', enabled: evidenceToggle.checked });
  });

  function updateSliderLabels() {
    repelValue.textContent = Number(repelSlider.value).toFixed(2);
    attractValue.textContent = Number(attractSlider.value).toFixed(2);
    ambientRepelValue.textContent = Number(ambientRepelSlider.value).toFixed(2);
  }

  function postForceState() {
    vscode.postMessage({ type: 'setRepelStrength', value: Number(repelSlider.value) });
    vscode.postMessage({ type: 'setAttractStrength', value: Number(attractSlider.value) });
    vscode.postMessage({ type: 'setAmbientRepelStrength', value: Number(ambientRepelSlider.value) });
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

  [repelSlider, attractSlider, ambientRepelSlider].forEach((slider) => {
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
      repelSlider.value = String(typeof msg.repelStrength === 'number' ? msg.repelStrength : 0.35);
      attractSlider.value = String(typeof msg.attractStrength === 'number' ? msg.attractStrength : 0.28);
      ambientRepelSlider.value = String(typeof msg.ambientRepelStrength === 'number' ? msg.ambientRepelStrength : 0.18);
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
