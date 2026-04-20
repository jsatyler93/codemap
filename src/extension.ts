import * as vscode from "vscode";
import * as path from "path";
import { GraphWebviewProvider } from "./providers/graphWebviewProvider";
import { PythonWorkspaceIndexer } from "./python/analysis/pythonWorkspaceIndexer";
import { buildFlowchartFor, buildIdlFlowchartFor, resetInterpreterCache } from "./python/analysis/pythonRunner";
import { JavaScriptWorkspaceIndexer } from "./javascript/analysis/javascriptWorkspaceIndexer";
import { buildJavaScriptFlowchartFor } from "./javascript/analysis/javascriptFlowchartBuilder";
import { IdlWorkspaceIndexer } from "./idl/analysis/idlWorkspaceIndexer";
import { DebugSyncService } from "./live/debugSync";
import { NavigationController } from "./navigation/navigationController";
import { ActionsViewProvider } from "./providers/actionsViewProvider";
import { FileTreeProvider } from "./providers/fileTreeProvider";
import { buildWorkspaceGraph } from "./python/analysis/pythonCallGraphBuilder";
import { GraphDocument } from "./python/model/graphTypes";
import { computeModuleColorMap } from "./python/analysis/hierarchicalGraphBuilder";

export function activate(context: vscode.ExtensionContext): void {
  const pythonIndexer = new PythonWorkspaceIndexer(context.extensionPath);
  const javascriptIndexer = new JavaScriptWorkspaceIndexer();
  const idlIndexer = new IdlWorkspaceIndexer(context.extensionPath);
  context.subscriptions.push(pythonIndexer, javascriptIndexer, idlIndexer);
  const output = vscode.window.createOutputChannel("CodeMap");
  context.subscriptions.push(output);
  let provider: GraphWebviewProvider;
  const actionsViewProvider = new ActionsViewProvider(context, (state) => {
    provider.updateUiState(state);
  });
  const fileTreeProvider = new FileTreeProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ActionsViewProvider.viewType, actionsViewProvider),
  );
  const fileTreeView = vscode.window.createTreeView("codemap.files", {
    treeDataProvider: fileTreeProvider,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  fileTreeProvider.attachTreeView(fileTreeView);
  context.subscriptions.push(fileTreeView, fileTreeProvider);

  const debugSync = new DebugSyncService();
  context.subscriptions.push(debugSync);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codemap.pythonPath")) {
        resetInterpreterCache();
        pythonIndexer.invalidate();
        idlIndexer.invalidate();
        jsWorkspaceGraphCache = undefined;
        idlWorkspaceGraphCache = undefined;
        navController.invalidateCache();
      }
    }),
  );

  let lastCommand: (() => Promise<void>) | undefined;

  provider = new GraphWebviewProvider(
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
        const language = languageForPath(source.file);
        const graph = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
          async () => {
            if (language === "javascript") {
              return buildJavaScriptFlowchartFor(source.file, source.line);
            }
            if (language === "idl") {
              return buildIdlFlowchartFor(context.extensionPath, source.file, source.line);
            }
            const analysis = await pythonIndexer.getAnalysis();
            return buildFlowchartFor(context.extensionPath, source.file, source.line, analysis);
          },
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
  provider.updateUiState(actionsViewProvider.getUiState());

  const navController = new NavigationController(
    context.extensionPath,
    pythonIndexer,
    (graph) => {
      logGraph(graph);
      provider.show(graph);
    },
    (message) => output.appendLine(message),
  );

  let jsWorkspaceGraphCache: GraphDocument | undefined;
  let idlWorkspaceGraphCache: GraphDocument | undefined;

  // Workspace call graph is the default view.
  lastCommand = () => runShowWorkspaceGraph();

  // Auto-start debug sync so it's always on.
  debugSync.start();
  void fileTreeProvider.initialize().then(() => {
    const checkedFiles = fileTreeProvider.getCheckedFiles();
    pythonIndexer.setIncludedFiles(checkedFiles);
    javascriptIndexer.setIncludedFiles(checkedFiles);
    idlIndexer.setIncludedFiles(checkedFiles);
    actionsViewProvider.updateSelection(fileTreeProvider.getSelectionSummary());
  }).catch((e) => {
    output.appendLine(`[file-tree] init failed: ${(e as Error).message}`);
  });

  context.subscriptions.push(
    fileTreeProvider.onDidChangeCheckedFiles((checkedFiles) => {
      pythonIndexer.setIncludedFiles(checkedFiles);
      javascriptIndexer.setIncludedFiles(checkedFiles);
      idlIndexer.setIncludedFiles(checkedFiles);
      navController.invalidateCache();
      jsWorkspaceGraphCache = undefined;
      idlWorkspaceGraphCache = undefined;
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
      lastCommand = runShowWorkspaceGraph;
      await runShowWorkspaceGraph().catch(showError);
    }),
    vscode.commands.registerCommand("codemap.showFileGraph", async (resource?: vscode.Uri) => {
      const file = await resolveTargetSourceFile(resource);
      if (!file) return;
      lastCommand = () => runShowFileGraph(file);
      await runShowFileGraph(file);
    }),
    vscode.commands.registerCommand("codemap.refresh", async () => {
      const preferred = preferredWorkspaceLanguage(fileTreeProvider.getCheckedFiles(), vscode.window.activeTextEditor?.document.uri.fsPath);
      if (preferred === "javascript") {
        await javascriptIndexer.getAnalysis(true);
      } else if (preferred === "idl") {
        await idlIndexer.getAnalysis(true);
      } else {
        await pythonIndexer.getAnalysis(true);
      }
      jsWorkspaceGraphCache = undefined;
      idlWorkspaceGraphCache = undefined;
      navController.invalidateCache();
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

  async function requireActiveSupportedEditor(): Promise<vscode.TextEditor | undefined> {
    const editor = vscode.window.activeTextEditor;
    const language = editor ? languageForDocument(editor.document) : undefined;
    if (!editor || !language) {
      vscode.window.showWarningMessage("CodeMap: open a Python, JavaScript/TypeScript, or IDL file first.");
      return undefined;
    }
    return editor;
  }

  async function runShowFlowchart(): Promise<void> {
    const editor = await requireActiveSupportedEditor();
    if (!editor) return;
    const file = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1;
    const language = languageForDocument(editor.document);
    if (!language) {
      vscode.window.showWarningMessage("CodeMap: selected file is not supported.");
      return;
    }

    try {
      if (language === "javascript") {
        const analysis = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
          () => javascriptIndexer.getAnalysis(),
        );
        logAnalysis(analysis, "flowchart-js");
        const graph = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building JavaScript flowchart..." },
          () => Promise.resolve(buildJavaScriptFlowchartFor(file, line)),
        );
        logGraph(graph);
        provider.show(graph);
        return;
      }

      if (language === "idl") {
        const analysis = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing IDL workspace..." },
          () => idlIndexer.getAnalysis(),
        );
        logAnalysis(analysis, "flowchart-idl");
        const graph = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building IDL flowchart..." },
          () => buildIdlFlowchartFor(context.extensionPath, file, line),
        );
        logGraph(graph);
        provider.show(graph);
        return;
      }

      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => pythonIndexer.getAnalysis(),
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

  async function runShowWorkspaceGraph(forceRefresh = false): Promise<void> {
    const preferred = preferredWorkspaceLanguage(
      fileTreeProvider.getCheckedFiles(),
      vscode.window.activeTextEditor?.document.uri.fsPath,
    );
    if (preferred === "javascript") {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing JavaScript workspace..." },
        () => javascriptIndexer.getAnalysis(forceRefresh),
      );
      logAnalysis(analysis, "workspace-js");
      if (!jsWorkspaceGraphCache || forceRefresh) {
        const colors = computeModuleColorMap(analysis);
        jsWorkspaceGraphCache = buildWorkspaceGraph(analysis, colors);
        jsWorkspaceGraphCache = {
          ...jsWorkspaceGraphCache,
          title: "JavaScript workspace",
          subtitle: `${jsWorkspaceGraphCache.nodes.length} symbols · ${jsWorkspaceGraphCache.edges.length} call edges`,
        };
      }
      logGraph(jsWorkspaceGraphCache);
      provider.show(jsWorkspaceGraphCache);
      return;
    }
    if (preferred === "idl") {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing IDL workspace..." },
        () => idlIndexer.getAnalysis(forceRefresh),
      );
      logAnalysis(analysis, "workspace-idl");
      if (!idlWorkspaceGraphCache || forceRefresh) {
        const colors = computeModuleColorMap(analysis);
        idlWorkspaceGraphCache = buildWorkspaceGraph(analysis, colors);
        idlWorkspaceGraphCache = {
          ...idlWorkspaceGraphCache,
          title: "IDL workspace",
          subtitle: `${idlWorkspaceGraphCache.nodes.length} symbols · ${idlWorkspaceGraphCache.edges.length} call edges`,
        };
      }
      logGraph(idlWorkspaceGraphCache);
      provider.show(idlWorkspaceGraphCache);
      return;
    }
    await navController.showWorkspaceCallGraph(forceRefresh);
  }

  async function resolveTargetSourceFile(resource?: vscode.Uri): Promise<string | undefined> {
    const candidate = resource?.scheme === "file" ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!candidate || candidate.scheme !== "file") {
      vscode.window.showWarningMessage("CodeMap: open a Python, JavaScript/TypeScript, or IDL file first.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(candidate);
    if (!languageForDocument(doc)) {
      vscode.window.showWarningMessage("CodeMap: selected file type is not supported.");
      return undefined;
    }
    return candidate.fsPath;
  }

  async function runShowFileGraph(file: string): Promise<void> {
    try {
      const language = languageForPath(file);
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => language === "javascript"
          ? javascriptIndexer.getAnalysis()
          : language === "idl"
            ? idlIndexer.getAnalysis()
            : pythonIndexer.getAnalysis(),
      );
      logAnalysis(
        analysis,
        language === "javascript" ? "file-graph-js" : language === "idl" ? "file-graph-idl" : "file-graph",
      );

      const workspaceGraph = buildWorkspaceGraph(analysis, computeModuleColorMap(analysis));
      const target = normalizePath(file);
      const fileNodeSet = new Set<string>();
      workspaceGraph.nodes.forEach((node) => {
        const nodeFile = node.source?.file;
        if (nodeFile && normalizePath(nodeFile) === target) {
          fileNodeSet.add(node.id);
        }
      });

      const includedNodeSet = new Set<string>(fileNodeSet);
      workspaceGraph.edges.forEach((edge) => {
        if (fileNodeSet.has(edge.from) || fileNodeSet.has(edge.to)) {
          includedNodeSet.add(edge.from);
          includedNodeSet.add(edge.to);
        }
      });

      const nodes = workspaceGraph.nodes.filter((node) => includedNodeSet.has(node.id));
      const edges = workspaceGraph.edges.filter(
        (edge) =>
          includedNodeSet.has(edge.from)
          && includedNodeSet.has(edge.to)
          && (fileNodeSet.has(edge.from) || fileNodeSet.has(edge.to)),
      );

      const edgeSet = new Set(edges.map((edge) => `${edge.from}->${edge.to}`));
      const timeline = extractScopedTimeline(workspaceGraph, edgeSet);
      const moduleColors = extractScopedModuleColors(workspaceGraph, nodes);
      const rootNodeIds = Array.from(fileNodeSet).filter(
        (id) => !edges.some((edge) => edge.to === id && fileNodeSet.has(edge.from)),
      );
      if (!rootNodeIds.length && fileNodeSet.size > 0) {
        rootNodeIds.push(Array.from(fileNodeSet)[0]);
      }

      const dependencyCount = Math.max(0, nodes.length - fileNodeSet.size);

      const graph: GraphDocument = {
        ...workspaceGraph,
        title: `File call graph: ${path.basename(file)}`,
        subtitle: `${file} · ${fileNodeSet.size} file symbols + ${dependencyCount} external deps · ${edges.length} call edges`,
        nodes,
        edges,
        rootNodeIds,
        metadata: {
          ...(workspaceGraph.metadata || {}),
          execTimeline: timeline,
          moduleColors,
          fileScope: file,
          includeExternalDependencies: true,
        },
      };

      logGraph(graph);
      provider.show(graph);
    } catch (e) {
      showError(e);
    }
  }
}

function languageForDocument(doc: vscode.TextDocument): "python" | "javascript" | "idl" | undefined {
  if (doc.languageId === "python") return "python";
  if (isJavaScriptLikeLanguageId(doc.languageId)) return "javascript";
  if (doc.languageId === "idl" || path.extname(doc.uri.fsPath).toLowerCase() === ".pro") return "idl";
  return undefined;
}

function languageForPath(filePath: string): "python" | "javascript" | "idl" | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py") return "python";
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext)) return "javascript";
  if (ext === ".pro") return "idl";
  return undefined;
}

function isJavaScriptLikeLanguageId(languageId: string): boolean {
  return languageId === "javascript"
    || languageId === "javascriptreact"
    || languageId === "typescript"
    || languageId === "typescriptreact";
}

function preferredWorkspaceLanguage(checkedFiles: string[], activeFilePath: string | undefined): "python" | "javascript" | "idl" {
  const activeLanguage = activeFilePath ? languageForPath(activeFilePath) : undefined;
  if (activeLanguage === "javascript") return "javascript";
  if (activeLanguage === "python") return "python";
  if (activeLanguage === "idl") return "idl";

  let hasPython = false;
  let hasJavaScript = false;
  let hasIdl = false;
  for (const filePath of checkedFiles) {
    const lang = languageForPath(filePath);
    if (lang === "python") hasPython = true;
    if (lang === "javascript") hasJavaScript = true;
    if (lang === "idl") hasIdl = true;
    if (hasPython && hasJavaScript && hasIdl) break;
  }

  if (hasIdl && !hasPython && !hasJavaScript) return "idl";
  if (hasJavaScript && !hasPython) return "javascript";
  return "python";
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function extractScopedTimeline(graph: GraphDocument, edgeSet: Set<string>): Array<{ edge: [string, string]; label: string; desc: string }> {
  const timeline = graph.metadata?.execTimeline;
  if (!Array.isArray(timeline)) return [];
  const scoped: Array<{ edge: [string, string]; label: string; desc: string }> = [];
  for (const step of timeline) {
    const edge = Array.isArray((step as { edge?: unknown[] }).edge) ? (step as { edge: unknown[] }).edge : undefined;
    if (!edge || edge.length !== 2) continue;
    const from = String(edge[0]);
    const to = String(edge[1]);
    if (!edgeSet.has(`${from}->${to}`)) continue;
    scoped.push({
      edge: [from, to],
      label: String((step as { label?: unknown }).label ?? ""),
      desc: String((step as { desc?: unknown }).desc ?? ""),
    });
  }
  return scoped;
}

function extractScopedModuleColors(graph: GraphDocument, nodes: GraphDocument["nodes"]): Record<string, string> {
  const colors = graph.metadata?.moduleColors;
  if (!colors || typeof colors !== "object") return {};
  const modules = new Set(nodes.map((node) => node.module).filter((v): v is string => !!v));
  const out: Record<string, string> = {};
  for (const [moduleName, color] of Object.entries(colors as Record<string, unknown>)) {
    if (modules.has(moduleName) && typeof color === "string") {
      out[moduleName] = color;
    }
  }
  return out;
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
