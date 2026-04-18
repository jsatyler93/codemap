import * as vscode from "vscode";
import { GraphWebviewProvider } from "./providers/graphWebviewProvider";
import { PythonWorkspaceIndexer } from "./python/analysis/pythonWorkspaceIndexer";
import { buildFlowchartFor, resetInterpreterCache } from "./python/analysis/pythonRunner";
import { DebugSyncService } from "./live/debugSync";
import { NavigationController } from "./navigation/navigationController";
import { ActionsViewProvider } from "./providers/actionsViewProvider";
import { FileTreeProvider } from "./providers/fileTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const indexer = new PythonWorkspaceIndexer(context.extensionPath);
  context.subscriptions.push(indexer);
  const output = vscode.window.createOutputChannel("CodeMap");
  context.subscriptions.push(output);
  const actionsViewProvider = new ActionsViewProvider(context);
  const fileTreeProvider = new FileTreeProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ActionsViewProvider.viewType, actionsViewProvider),
  );
  const fileTreeView = vscode.window.createTreeView("codemap.files", {
    treeDataProvider: fileTreeProvider,
    showCollapseAll: true,
  });
  fileTreeProvider.attachTreeView(fileTreeView);
  context.subscriptions.push(fileTreeView, fileTreeProvider);

  const debugSync = new DebugSyncService();
  context.subscriptions.push(debugSync);

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
      // Double-click a call graph node → open its flowchart
      if (!source) {
        output.appendLine(`[requestFlowchart] no source for node ${nodeId}`);
        return;
      }
      try {
        const analysis = await indexer.getAnalysis();
        const graph = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
          () => buildFlowchartFor(context.extensionPath, source.file, source.line, analysis),
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

  const navController = new NavigationController(
    context.extensionPath,
    indexer,
    (graph) => {
      logGraph(graph);
      provider.show(graph);
    },
    (message) => output.appendLine(message),
  );

  // Workspace call graph is the default view.
  lastCommand = () => navController.showWorkspaceCallGraph();

  // Auto-start debug sync so it's always on.
  debugSync.start();
  void fileTreeProvider.initialize().then(() => {
    const checkedFiles = fileTreeProvider.getCheckedFiles();
    indexer.setIncludedFiles(checkedFiles);
    actionsViewProvider.updateSelection(fileTreeProvider.getSelectionSummary());
  }).catch((e) => {
    output.appendLine(`[file-tree] init failed: ${(e as Error).message}`);
  });

  context.subscriptions.push(
    fileTreeProvider.onDidChangeCheckedFiles((checkedFiles) => {
      indexer.setIncludedFiles(checkedFiles);
      navController.invalidateCache();
      actionsViewProvider.updateSelection(fileTreeProvider.getSelectionSummary());
      if (provider.isVisible() && lastCommand) {
        lastCommand().catch((e) => showError(e));
      }
    }),
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
    vscode.commands.registerCommand("codemap.showWorkspaceGraph", async () => {
      lastCommand = () => navController.showWorkspaceCallGraph();
      await navController.showWorkspaceCallGraph().catch(showError);
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

  // Debug sync wiring: when active, push runtime frames + computed highlights
  // to whatever graph is currently shown in the webview.
  context.subscriptions.push(
    debugSync.onRuntime((frame) => {
      if (!provider.isVisible()) return;
      const graph = provider.getCurrentGraph();
      const highlights: string[] = [];
      if (frame && graph && frame.source) {
        const matchId = findGraphNodeByLocation(graph, frame.source);
        if (matchId) highlights.push(matchId);
        // Highlight call-stack ancestors that map onto graph nodes too.
        for (const sf of frame.callStack) {
          if (!sf.file || !sf.line) continue;
          const id = findGraphNodeByLocation(graph, { file: sf.file, line: sf.line });
          if (id && !highlights.includes(id)) highlights.push(id);
        }
      }
      provider.postRuntimeFrame(frame, highlights);
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
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => indexer.getAnalysis(),
      );
      logAnalysis(analysis, "flowchart");
      const graph = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
        () => buildFlowchartFor(context.extensionPath, file, line, analysis),
      );
      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }
}

function findGraphNodeByLocation(
  graph: { nodes: { id: string; source?: { file: string; line: number; endLine?: number } }[] },
  source: { file: string; line: number },
): string | undefined {
  if (!graph.nodes || !source.file) return undefined;
  const target = source.file.replace(/\\/g, "/").toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const node of graph.nodes) {
    if (!node.source || !node.source.file) continue;
    const nf = node.source.file.replace(/\\/g, "/").toLowerCase();
    if (nf !== target) continue;
    const start = node.source.line ?? 0;
    const end = node.source.endLine ?? start;
    if (source.line >= start && source.line <= end) {
      const dist = source.line - start;
      if (dist < bestDist) {
        bestDist = dist;
        best = node.id;
      }
    }
  }
  return best;
}

export function deactivate(): void {
  // Disposables cleaned up by VS Code via context.subscriptions.
}
