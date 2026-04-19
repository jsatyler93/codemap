import * as path from "path";
import * as vscode from "vscode";
import { GraphDocument } from "../python/model/graphTypes";
import { FromWebviewMessage, RuntimeFrameView, UiStateView } from "../messaging/protocol";

export class GraphWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private lastGraph: GraphDocument | undefined;
  private lastRuntime: { frame: RuntimeFrameView | null; highlightNodeIds?: string[] } | undefined;
  private uiState: UiStateView = {
    showEvidence: false,
    repelStrength: 0.45,
    attractStrength: 0.32,
    ambientRepelStrength: 0.18,
    cohesionStrength: 0.34,
    treeView: false,
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onRevealNode: (nodeId: string, source?: GraphDocument["nodes"][0]["source"]) => void,
    private readonly onRefreshRequested: () => void,
    private readonly onDebugMessage: (message: string) => void,
    private readonly onRequestFlowchart: (nodeId: string, source?: GraphDocument["nodes"][0]["source"]) => void,
  ) {}

  show(graph: GraphDocument): void {
    this.lastGraph = graph;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "codemap.graph",
        "CodeMap",
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(this.context.extensionPath, "webview")),
            vscode.Uri.file(path.join(this.context.extensionPath, "dist", "webview")),
          ],
        },
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
        if (msg.type === "revealNode") {
          this.onRevealNode(msg.nodeId, msg.source);
        } else if (msg.type === "requestRefresh") {
          this.onRefreshRequested();
        } else if (msg.type === "requestFlowchart") {
          this.onRequestFlowchart(msg.nodeId, msg.source);
        } else if (msg.type === "debug") {
          this.onDebugMessage(msg.message);
        } else if (msg.type === "ready") {
          this.onDebugMessage("webview ready");
          if (this.lastGraph) {
            this.postGraph(this.lastGraph);
          }
          this.postUiState();
          if (this.lastRuntime) {
            this.panel?.webview.postMessage({
              type: "setRuntimeFrame",
              frame: this.lastRuntime.frame,
              highlightNodeIds: this.lastRuntime.highlightNodeIds,
            });
          }
        }
      });
      const html = this.buildHtml(this.panel.webview);
      this.onDebugMessage("webview panel created, html length = " + html.length);
      this.onDebugMessage("html preview: " + html.substring(0, 200));
      this.panel.webview.html = html;
      this.onDebugMessage("webview html assigned");
    }
    this.panel.title = `CodeMap · ${graph.title}`;
    this.panel.reveal(vscode.ViewColumn.Two, false);
    this.postGraph(graph);
  }

  private postGraph(graph: GraphDocument): void {
    const numNodes = graph.nodes ? graph.nodes.length : 0;
    const numEdges = graph.edges ? graph.edges.length : 0;
    this.onDebugMessage(`postGraph ${graph.graphType} ${graph.title} (${numNodes} nodes, ${numEdges} edges)`);
    this.panel?.webview.postMessage({ type: "setGraph", graph });
  }

  postRuntimeFrame(frame: RuntimeFrameView | null, highlightNodeIds?: string[]): void {
    this.lastRuntime = { frame, highlightNodeIds };
    if (!this.panel) return;
    this.panel.webview.postMessage({
      type: "setRuntimeFrame",
      frame,
      highlightNodeIds,
    });
  }

  updateUiState(state: UiStateView): void {
    this.uiState = state;
    this.postUiState();
  }

  isVisible(): boolean {
    return !!this.panel;
  }

  getCurrentGraph(): GraphDocument | undefined {
    return this.lastGraph;
  }

  private postUiState(): void {
    this.panel?.webview.postMessage({ type: "setUiState", state: this.uiState });
  }

  private buildHtml(webview: vscode.Webview): string {
    const webviewRoot = vscode.Uri.file(
      path.join(this.context.extensionPath, "webview"),
    );
    const distRoot = vscode.Uri.file(
      path.join(this.context.extensionPath, "dist", "webview"),
    );
    const asUri = (root: vscode.Uri, rel: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(root, ...rel.split("/")));

    const cssUri = asUri(webviewRoot, "styles.css");
    const mainUri = asUri(distRoot, "main.js");
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>CodeMap</title>
</head>
<body>
  <div id="toolbar">
    <span class="title" id="title">CodeMap</span>
    <span class="sep"></span>
    <span class="info" id="stats"></span>
    <span class="sep"></span>
    <button class="btn exec" id="btn-exec">&#9654; auto trace</button>
    <button class="btn step" id="btn-step">&#9193; step-by-step</button>
    <button class="btn" id="btn-reset">reset</button>
    <button class="btn" id="btn-clear">clear</button>
    <button class="btn" id="btn-refresh">refresh</button>
    <label class="tick"><input id="toggle-overlay-legacy" type="checkbox" checked /> last-writer</label>
    <label class="tick"><input id="toggle-overlay-modern" type="checkbox" checked /> reaching-defs + interproc</label>
    <input id="search-box" type="text" placeholder="Search..." />
  </div>
  <div id="canvas"></div>
  <div id="canvas-controls">
    <button class="canvas-btn" id="btn-collapse-groups">collapse all</button>
    <button class="canvas-btn" id="btn-expand-groups">expand all</button>
  </div>
  <div id="overlay-badge" aria-live="polite"></div>
  <div id="tooltip"></div>
  <div id="legend">
    <div class="lg-title" id="lg-title">Modules</div>
    <div id="lg-items"></div>
  </div>
  <div id="exec-panel">
    <div class="ep-label" id="ep-label">Trace</div>
    <div class="ep-func" id="ep-func">&mdash;</div>
    <div class="ep-desc" id="ep-desc"></div>
    <div class="ep-step" id="ep-step"></div>
    <div class="ep-hint" id="ep-hint"></div>
  </div>
  <div id="runtime-panel" style="display:none;position:fixed;top:56px;right:14px;z-index:200;max-width:340px;padding:10px 12px;border:1px solid #2a3042;border-radius:8px;background:rgba(10,12,18,0.96);color:#c0caf5;font-family:Consolas, monospace;font-size:11px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35)">
    <div style="font-size:10px;color:#7aa2f7;margin-bottom:4px;font-weight:600">DEBUG &middot; LIVE</div>
    <div id="rt-frame" style="color:#9ece6a;font-weight:600;margin-bottom:4px">&mdash;</div>
    <div id="rt-source" style="color:#7d8590;margin-bottom:8px"></div>
    <div id="rt-vars" style="margin-bottom:6px"></div>
    <div id="rt-stack" style="border-top:1px solid #2a3042;padding-top:6px;color:#7d8590;font-size:10px"></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      window.__codemapVscode = vscode;
      window.addEventListener("error", function (event) {
        vscode.postMessage({ type: "debug", message: "runtime error: " + event.message });
      });
      window.addEventListener("unhandledrejection", function (event) {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        vscode.postMessage({ type: "debug", message: "promise rejection: " + reason });
      });
    })();
  </script>
  <script nonce="${nonce}" src="${mainUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
