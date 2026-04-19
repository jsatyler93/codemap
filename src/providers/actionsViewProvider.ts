import * as vscode from "vscode";

const SHOW_EVIDENCE_KEY = "codemap.showEvidence";

interface ExecuteCommandMessage {
  type: "executeCommand";
  command: string;
}

interface ToggleEvidenceMessage {
  type: "toggleEvidence";
  enabled: boolean;
}

interface ReadyMessage {
  type: "ready";
}

type ActionsInbound = ExecuteCommandMessage | ToggleEvidenceMessage | ReadyMessage;

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onToggleEvidence: (enabled: boolean) => void,
  ) {
    this.showEvidence = context.workspaceState.get<boolean>(SHOW_EVIDENCE_KEY, false);
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
        this.onToggleEvidence(this.showEvidence);
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

  private postUiState(): void {
    this.view?.webview.postMessage({
      type: "uiState",
      showEvidence: this.showEvidence,
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

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const evidenceToggle = document.getElementById('toggle-evidence');

  document.querySelectorAll('button.action').forEach((btn) => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'executeCommand', command: btn.dataset.cmd });
    });
  });

  evidenceToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleEvidence', enabled: evidenceToggle.checked });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'selectionUpdate') {
      document.getElementById('selection-badge').textContent =
        msg.checked + ' / ' + msg.total + ' files selected';
    } else if (msg.type === 'uiState') {
      evidenceToggle.checked = !!msg.showEvidence;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
