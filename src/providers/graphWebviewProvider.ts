import * as path from "path";
import * as vscode from "vscode";
import { GraphDocument } from "../python/model/graphTypes";
import { FromWebviewMessage } from "../messaging/protocol";

export class GraphWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private lastGraph: GraphDocument | undefined;

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
  <div id="boot-status" style="position:fixed;top:12px;right:14px;z-index:300;padding:8px 12px;border:1px solid #2a3042;border-radius:8px;background:rgba(10,12,18,0.96);color:#f7e76d;font-family:Consolas, monospace;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.35)">CodeMap booting...</div>
  <div id="debug-shell" style="position:fixed;top:56px;left:14px;z-index:300;max-width:520px;padding:10px 12px;border:1px solid #2a3042;border-radius:8px;background:rgba(10,12,18,0.96);color:#c0caf5;font-family:Consolas, monospace;font-size:12px;line-height:1.45;white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.35)">CodeMap shell created.
Waiting for graph message...</div>
  <div id="toolbar">
    <span id="title" class="title">CodeMap</span>
    <span id="subtitle" class="subtitle"></span>
    <span class="sep"></span>
    <button class="btn active" id="btn-flow" data-toggle="flow">ambient flow</button>
    <button class="btn" id="btn-reset">reset</button>
    <button class="btn" id="btn-refresh">refresh</button>
    <input id="search-box" type="text" placeholder="Search..." />
  </div>
  <div id="canvas"></div>
  <div id="tooltip"></div>
  <div id="info-panel">
    <div class="ip-title" id="ip-mode">Graph</div>
    <div class="ip-func" id="ip-func">\u2014</div>
    <div class="ip-file" id="ip-file"></div>
    <div class="ip-stats" id="ip-stats"></div>
  </div>
  <div id="legend">
    <div class="lg-title" id="lg-title">Legend</div>
    <div id="lg-items"></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      window.__codemapVscode = vscode;
      const boot = document.getElementById("boot-status");
      const shell = document.getElementById("debug-shell");
      function setBoot(message) {
        if (boot) boot.textContent = message;
        vscode.postMessage({ type: "debug", message: "[boot] " + message });
      }
      function setShell(message) {
        if (shell) shell.textContent = message;
        const msgStr = typeof message === "string" ? message.replace(/\\n/g, " | ") : "";
        vscode.postMessage({ type: "debug", message: "[shell] " + msgStr });
      }
      window.__codemapSetBoot = setBoot;
      window.__codemapSetShell = setShell;
      window.addEventListener("error", function (event) {
        setBoot("runtime error: " + event.message);
      });
      window.addEventListener("unhandledrejection", function (event) {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        setBoot("promise rejection: " + reason);
      });
      window.addEventListener("message", function (event) {
        var msg = event.data;
        if (!msg || msg.type !== "setGraph" || !msg.graph) return;
        var graph = msg.graph;
        var meta = graph.metadata || {};
        var summary = meta.analysisSummary || null;
        var nodesArr = Array.isArray(graph.nodes) ? graph.nodes : [];
        var edgesArr = Array.isArray(graph.edges) ? graph.edges : [];
        var lines = [
          "Graph message received.",
          "type: " + graph.graphType,
          "title: " + (graph.title || "(none)"),
          "nodes: " + nodesArr.length,
          "edges: " + edgesArr.length,
        ];
        if (summary) {
          lines.push("typed: " + summary.typeCoveragePct + "%");
          lines.push("jedi: " + (summary.jediEnabled ? "+" + summary.jediResolved : "off"));
        }
        setShell(lines.join("\\n"));
      });
      setBoot("shell loaded");
      setShell("CodeMap shell loaded.\\nWaiting for graph message...");
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
