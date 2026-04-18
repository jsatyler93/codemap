import * as vscode from "vscode";
import { GraphWebviewProvider } from "./providers/graphWebviewProvider";
import { PythonWorkspaceIndexer } from "./python/analysis/pythonWorkspaceIndexer";
import { buildFlowchartFor, resetInterpreterCache } from "./python/analysis/pythonRunner";
import {
  buildSymbolCallGraph,
  buildStaticTrace,
  buildWorkspaceGraph,
  findSymbolAt,
} from "./python/analysis/pythonCallGraphBuilder";

export function activate(context: vscode.ExtensionContext): void {
  const indexer = new PythonWorkspaceIndexer(context.extensionPath);
  context.subscriptions.push(indexer);
  const output = vscode.window.createOutputChannel("CodeMap");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codemap.pythonPath")) {
        resetInterpreterCache();
      }
    }),
  );

  let lastCommand: (() => Promise<void>) | undefined;

  const provider = new GraphWebviewProvider(
    context,
    async (_nodeId, source) => {
      if (!source) return;
      try {
        const doc = await vscode.workspace.openTextDocument(source.file);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
        const line = Math.max(0, source.line - 1);
        const col = Math.max(0, source.column ?? 0);
        const pos = new vscode.Position(line, col);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      } catch (e) {
        vscode.window.showErrorMessage(`CodeMap: cannot open ${source.file}: ${(e as Error).message}`);
      }
    },
    () => {
      if (lastCommand) {
        lastCommand().catch((e) => showError(e));
      }
    },
    (message) => {
      output.appendLine(`[webview] ${message}`);
    },
    async (nodeId, source) => {
      // Cross-layer navigation: double-click a call graph node → open its flowchart
      if (!source) {
        output.appendLine(`[requestFlowchart] no source for node ${nodeId}`);
        return;
      }
      try {
        const graph = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
          () => buildFlowchartFor(context.extensionPath, source.file, source.line),
        );
        if (graph && graph.nodes && graph.nodes.length > 0) {
          logGraph(graph);
          provider.show(graph);
        } else {
          output.appendLine(`[requestFlowchart] no flowchart for ${nodeId} at ${source.file}:${source.line}`);
          vscode.window.showInformationMessage(`CodeMap: no flowchart available for ${nodeId}`);
        }
      } catch (e) {
        output.appendLine(`[requestFlowchart] error: ${(e as Error).message}`);
      }
    },
  );

  function showError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`[error] ${msg}`);
    vscode.window.showErrorMessage(`CodeMap: ${msg}`);
  }

  function logAnalysis(analysis: {
    summary?: {
      totalFiles: number;
      totalFunctions: number;
      totalClasses: number;
      totalTypeSlots: number;
      typedSlots: number;
      typeCoveragePct: number;
      jediEnabled: boolean;
      jediResolved: number;
    };
    errors: { file: string; message: string }[];
  }, contextLabel: string): void {
    const summary = analysis.summary;
    if (!summary) {
      output.appendLine(`[${contextLabel}] no analysis summary available`);
      vscode.window.setStatusBarMessage("CodeMap: no analysis summary available", 5000);
      return;
    }
    const line = [
      `[${contextLabel}]`,
      `${summary.totalFiles} files`,
      `${summary.totalFunctions} funcs`,
      `${summary.totalClasses} classes`,
      `${summary.typeCoveragePct}% typed`,
      summary.jediEnabled ? `Jedi +${summary.jediResolved}` : "Jedi off",
      (analysis.errors && analysis.errors.length) ? `${analysis.errors.length} parse errors` : "0 parse errors",
    ].join(" · ");
    output.appendLine(line);
    if (analysis.errors && analysis.errors.length) {
      for (const error of analysis.errors.slice(0, 5)) {
        output.appendLine(`  parse error: ${error.file} :: ${error.message}`);
      }
    }
    vscode.window.setStatusBarMessage(`CodeMap: ${summary.typeCoveragePct}% typed · ${summary.jediEnabled ? `Jedi +${summary.jediResolved}` : "Jedi off"}`, 5000);
  }

  function logGraph(graph: { graphType: string; title: string; nodes: unknown[]; edges: unknown[] }): void {
    const numNodes = graph.nodes ? graph.nodes.length : 0;
    const numEdges = graph.edges ? graph.edges.length : 0;
    output.appendLine(`[graph] ${graph.graphType} :: ${graph.title} :: ${numNodes} nodes / ${numEdges} edges`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("codemap.showFlowchart", async () => {
      lastCommand = runShowFlowchart;
      await runShowFlowchart();
    }),
    vscode.commands.registerCommand("codemap.showCallGraph", async () => {
      lastCommand = runShowCallGraph;
      await runShowCallGraph();
    }),
    vscode.commands.registerCommand("codemap.showWorkspaceGraph", async () => {
      lastCommand = runShowWorkspaceGraph;
      await runShowWorkspaceGraph();
    }),
    vscode.commands.registerCommand("codemap.showStaticTrace", async () => {
      lastCommand = runShowStaticTrace;
      await runShowStaticTrace();
    }),
    vscode.commands.registerCommand("codemap.refresh", async () => {
      await indexer.getAnalysis(true);
      if (lastCommand) {
        await lastCommand();
      } else {
        vscode.window.showInformationMessage("CodeMap: workspace re-indexed.");
      }
    }),
  );

  async function requireActivePython(): Promise<vscode.TextEditor | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "python") {
      vscode.window.showWarningMessage("CodeMap: open a Python file first.");
      return undefined;
    }
    return editor;
  }

  async function runShowFlowchart(): Promise<void> {
    const editor = await requireActivePython();
    if (!editor) return;
    const file = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1;
    try {
      const graph = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
        () => buildFlowchartFor(context.extensionPath, file, line),
      );
      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }

  async function runShowCallGraph(): Promise<void> {
    const editor = await requireActivePython();
    if (!editor) return;
    try {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => indexer.getAnalysis(),
      );
      logAnalysis(analysis, "callgraph");
      const file = editor.document.uri.fsPath;
      const line = editor.selection.active.line + 1;
      const sym = findSymbolAt(analysis, file, line);
      if (!sym) {
        vscode.window.showWarningMessage("CodeMap: no Python symbol found at cursor.");
        return;
      }
      const depth = vscode.workspace.getConfiguration("codemap").get<number>("callGraph.depth", 1);
      const graph = buildSymbolCallGraph(analysis, sym.id, { depth });
      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }

  async function runShowWorkspaceGraph(): Promise<void> {
    try {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => indexer.getAnalysis(),
      );
      logAnalysis(analysis, "workspace");
      const graph = buildWorkspaceGraph(analysis);
      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }

  async function runShowStaticTrace(): Promise<void> {
    const editor = await requireActivePython();
    if (!editor) return;
    try {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => indexer.getAnalysis(),
      );
      logAnalysis(analysis, "trace");
      const file = editor.document.uri.fsPath;
      const line = editor.selection.active.line + 1;
      const sym = findSymbolAt(analysis, file, line);
      if (!sym || (sym.kind !== "function" && sym.kind !== "method")) {
        vscode.window.showWarningMessage("CodeMap: place cursor inside a Python function or method.");
        return;
      }
      const graph = buildStaticTrace(analysis, sym.id);
      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }
}

export function deactivate(): void {
  // Disposables cleaned up by VS Code via context.subscriptions.
}
