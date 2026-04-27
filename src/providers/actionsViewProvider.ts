import * as vscode from "vscode";
import { UiStateView } from "../messaging/protocol";

const SHOW_EVIDENCE_KEY = "codemap.showEvidence";
const SHOW_FUNCTION_CALLS_KEY = "codemap.showFunctionCalls";
const NARRATION_ENABLED_KEY = "codemap.narrationEnabled";
const FLOWCHART_VIEW_MODE_KEY = "codemap.flowchartViewMode";
const CANVAS_BRIGHTNESS_KEY = "codemap.canvasBrightness";
const CANVAS_THEME_MODE_KEY = "codemap.canvasThemeMode";
const DEFAULT_REPEL_STRENGTH = 0.45;
const DEFAULT_ATTRACT_STRENGTH = 0.32;
const DEFAULT_AMBIENT_REPEL_STRENGTH = 0.18;
const DEFAULT_COHESION_STRENGTH = 0.34;
const DEFAULT_LAYOUT_MODE = "lanes" as const;
const DEFAULT_CANVAS_THEME_MODE = "codemap" as const;

interface ExecuteCommandMessage {
  type: "executeCommand";
  command: string;
}

interface ToggleEvidenceMessage {
  type: "toggleEvidence";
  enabled: boolean;
}

interface ToggleFunctionCallsMessage {
  type: "toggleFunctionCalls";
  enabled: boolean;
}

interface ToggleNarrationMessage {
  type: "toggleNarration";
  enabled: boolean;
}

interface SetFlowchartViewModeMessage {
  type: "setFlowchartViewMode";
  mode: "grouped" | "full";
}

interface SetCanvasBrightnessMessage {
  type: "setCanvasBrightness";
  value: number;
}

interface SetCanvasThemeModeMessage {
  type: "setCanvasThemeMode";
  mode: "codemap" | "vscode";
}

interface ReadyMessage {
  type: "ready";
}

type ActionsInbound = ExecuteCommandMessage | ToggleEvidenceMessage | ToggleFunctionCallsMessage | ToggleNarrationMessage | SetFlowchartViewModeMessage | SetCanvasBrightnessMessage | SetCanvasThemeModeMessage | ReadyMessage;

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
  private showFunctionCalls: boolean;
  private narrationEnabled: boolean;
  private flowchartViewMode: "grouped" | "full";
  private canvasBrightness: number;
  private canvasThemeMode: "codemap" | "vscode";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onUiStateChanged: (state: UiStateView) => void,
  ) {
    this.showEvidence = context.workspaceState.get<boolean>(SHOW_EVIDENCE_KEY, false);
    this.showFunctionCalls = context.workspaceState.get<boolean>(SHOW_FUNCTION_CALLS_KEY, true);
    this.narrationEnabled = context.workspaceState.get<boolean>(NARRATION_ENABLED_KEY, true);
    this.flowchartViewMode = context.workspaceState.get<"grouped" | "full">(FLOWCHART_VIEW_MODE_KEY, "grouped");
    this.canvasBrightness = clampCanvasBrightness(context.workspaceState.get<number>(CANVAS_BRIGHTNESS_KEY, 1.0));
    this.canvasThemeMode = context.workspaceState.get<"codemap" | "vscode">(CANVAS_THEME_MODE_KEY, DEFAULT_CANVAS_THEME_MODE);
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
      } else if (msg.type === "toggleFunctionCalls") {
        this.showFunctionCalls = !!msg.enabled;
        void this.context.workspaceState.update(SHOW_FUNCTION_CALLS_KEY, this.showFunctionCalls);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "toggleNarration") {
        this.narrationEnabled = !!msg.enabled;
        void this.context.workspaceState.update(NARRATION_ENABLED_KEY, this.narrationEnabled);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setFlowchartViewMode") {
        this.flowchartViewMode = msg.mode;
        void this.context.workspaceState.update(FLOWCHART_VIEW_MODE_KEY, this.flowchartViewMode);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setCanvasBrightness") {
        this.canvasBrightness = clampCanvasBrightness(msg.value);
        void this.context.workspaceState.update(CANVAS_BRIGHTNESS_KEY, this.canvasBrightness);
        this.postUiState();
        this.onUiStateChanged(this.getUiState());
      } else if (msg.type === "setCanvasThemeMode") {
        this.canvasThemeMode = msg.mode;
        void this.context.workspaceState.update(CANVAS_THEME_MODE_KEY, this.canvasThemeMode);
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

  isNarrationEnabled(): boolean {
    return this.narrationEnabled;
  }

  isFunctionCallsEnabled(): boolean {
    return this.showFunctionCalls;
  }

  setShowFunctionCalls(enabled: boolean): void {
    this.showFunctionCalls = enabled;
    void this.context.workspaceState.update(SHOW_FUNCTION_CALLS_KEY, this.showFunctionCalls);
    this.postUiState();
    this.onUiStateChanged(this.getUiState());
  }

  setNarrationEnabled(enabled: boolean): void {
    this.narrationEnabled = enabled;
    void this.context.workspaceState.update(NARRATION_ENABLED_KEY, this.narrationEnabled);
    this.postUiState();
    this.onUiStateChanged(this.getUiState());
  }

  getUiState(): UiStateView {
    return {
      showEvidence: this.showEvidence,
      showFunctionCalls: this.showFunctionCalls,
      narrationEnabled: this.narrationEnabled,
      repelStrength: DEFAULT_REPEL_STRENGTH,
      attractStrength: DEFAULT_ATTRACT_STRENGTH,
      ambientRepelStrength: DEFAULT_AMBIENT_REPEL_STRENGTH,
      cohesionStrength: DEFAULT_COHESION_STRENGTH,
      layoutMode: DEFAULT_LAYOUT_MODE,
      treeView: false,
      flowchartViewMode: this.flowchartViewMode,
      canvasBrightness: this.canvasBrightness,
      canvasThemeMode: this.canvasThemeMode,
    };
  }

  private postUiState(): void {
    this.view?.webview.postMessage({ type: "uiState", ...this.getUiState() });
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
  <button class="action" data-cmd="codemap.narrateCurrentGraph" data-requires-narration="true">Narrate Current Graph</button>

  <details class="dropdown">
    <summary>Display Settings</summary>
    <div class="dropdown-content">
      <label class="toggle"><input id="toggle-narration" type="checkbox" checked /> Enable Copilot Narration</label>
      <label class="toggle"><input id="toggle-function-calls" type="checkbox" checked /> Show Function Calls</label>
      <div class="slider-block" id="flowchart-view-block" style="display:none;">
        <div class="slider-row" style="margin-bottom:4px"><span>Flowchart View</span></div>
        <div class="preset-row" style="margin-top:0;margin-bottom:0;">
          <button class="preset" id="fv-grouped" data-fv="grouped">Groups</button>
          <button class="preset" id="fv-full" data-fv="full">Full</button>
        </div>
      </div>
      <div class="slider-block">
        <div class="slider-row" style="margin-bottom:4px"><span>Canvas Theme</span></div>
        <div class="preset-row" style="margin-top:0;margin-bottom:0;">
          <button class="preset" id="theme-codemap" data-theme="codemap">CodeMap</button>
          <button class="preset" id="theme-vscode" data-theme="vscode">Match VS Code</button>
        </div>
      </div>
      <div class="slider-block">
        <div class="slider-row"><span>Brightness</span><span class="slider-value" id="brightness-value">1.00</span></div>
        <input id="brightness-slider" type="range" min="0" max="2" step="0.05" value="1" />
      </div>
      <label class="toggle"><input id="toggle-evidence" type="checkbox" /> Show Evidence Details</label>
    </div>
  </details>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const evidenceToggle = document.getElementById('toggle-evidence');
  const functionCallsToggle = document.getElementById('toggle-function-calls');
  const narrationToggle = document.getElementById('toggle-narration');
  const flowchartViewBlock = document.getElementById('flowchart-view-block');
  const fvButtons = document.querySelectorAll('[data-fv]');
  const themeButtons = document.querySelectorAll('[data-theme]');
  const brightnessSlider = document.getElementById('brightness-slider');
  const brightnessValue = document.getElementById('brightness-value');
  const narrationActions = document.querySelectorAll('[data-requires-narration="true"]');

  document.querySelectorAll('button.action').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'executeCommand', command: btn.dataset.cmd });
    });
  });

  evidenceToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleEvidence', enabled: evidenceToggle.checked });
  });
  functionCallsToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleFunctionCalls', enabled: functionCallsToggle.checked });
  });
  narrationToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleNarration', enabled: narrationToggle.checked });
  });
  fvButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setFlowchartViewMode', mode: btn.dataset.fv });
    });
  });
  themeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setCanvasThemeMode', mode: btn.dataset.theme });
    });
  });
  function setActiveFvButton(mode) {
    fvButtons.forEach((btn) => {
      btn.style.background = btn.dataset.fv === mode
        ? 'var(--vscode-focusBorder)'
        : 'var(--vscode-button-secondaryBackground)';
      btn.style.color = btn.dataset.fv === mode
        ? '#fff'
        : 'var(--vscode-button-secondaryForeground)';
      btn.style.borderColor = btn.dataset.fv === mode
        ? 'var(--vscode-focusBorder)'
        : 'var(--vscode-panel-border)';
    });
  }
  function setActiveThemeButton(mode) {
    themeButtons.forEach((btn) => {
      btn.style.background = btn.dataset.theme === mode
        ? 'var(--vscode-focusBorder)'
        : 'var(--vscode-button-secondaryBackground)';
      btn.style.color = btn.dataset.theme === mode
        ? '#fff'
        : 'var(--vscode-button-secondaryForeground)';
      btn.style.borderColor = btn.dataset.theme === mode
        ? 'var(--vscode-focusBorder)'
        : 'var(--vscode-panel-border)';
    });
  }

  function updateSliderLabels() {
    brightnessValue.textContent = Number(brightnessSlider.value).toFixed(2);
  }

  function setNarrationEnabled(enabled) {
    narrationToggle.checked = !!enabled;
    narrationActions.forEach((btn) => {
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.55';
      btn.title = enabled ? '' : 'Enable Copilot Narration in Display Settings to use this action';
    });
  }

  brightnessSlider.addEventListener('input', () => {
    brightnessValue.textContent = Number(brightnessSlider.value).toFixed(2);
    vscode.postMessage({ type: 'setCanvasBrightness', value: Number(brightnessSlider.value) });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'selectionUpdate') {
      document.getElementById('selection-badge').textContent =
        msg.checked + ' / ' + msg.total + ' files selected';
    } else if (msg.type === 'uiState') {
      evidenceToggle.checked = !!msg.showEvidence;
      functionCallsToggle.checked = msg.showFunctionCalls !== false;
      setNarrationEnabled(msg.narrationEnabled !== false);
      const fvm = msg.flowchartViewMode || 'grouped';
      setActiveFvButton(fvm);
      setActiveThemeButton(msg.canvasThemeMode || 'codemap');
      flowchartViewBlock.style.display = '';
      brightnessSlider.value = String(typeof msg.canvasBrightness === 'number' ? msg.canvasBrightness : 1.0);
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

function clampCanvasBrightness(value: number): number {
  if (!Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(2, value));
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
