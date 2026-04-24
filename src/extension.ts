import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GraphWebviewProvider } from "./providers/graphWebviewProvider";
import { PythonWorkspaceIndexer } from "./python/analysis/pythonWorkspaceIndexer";
import { buildFlowchartFor, buildIdlFlowchartFor, resetInterpreterCache } from "./python/analysis/pythonRunner";
import { JavaScriptWorkspaceIndexer } from "./javascript/analysis/javascriptWorkspaceIndexer";
import { buildJavaScriptFlowchartFor } from "./javascript/analysis/javascriptFlowchartBuilder";
import { IdlWorkspaceIndexer } from "./idl/analysis/idlWorkspaceIndexer";
import { DebugSyncService, RuntimeFrame } from "./live/debugSync";
import { NavigationController } from "./navigation/navigationController";
import { ActionsViewProvider } from "./providers/actionsViewProvider";
import { FileTreeProvider } from "./providers/fileTreeProvider";
import { buildWorkspaceGraph } from "./python/analysis/pythonCallGraphBuilder";
import { GraphDocument } from "./python/model/graphTypes";
import { computeModuleColorMap } from "./python/analysis/hierarchicalGraphBuilder";
import { resolveNarrationModel } from "./ai/copilotBridge";
import { NarrationKind } from "./ai/narrationTypes";
import { generateSingleDebugProbe, getCachedOrGenerateDebugProbes } from "./debug/debugProbeAgent";
import { injectProbe } from "./debug/debugInjector";
import { ProbeResultStore } from "./debug/probeResultStore";
import { DebugProbe } from "./debug/debugProbeTypes";
import {
  getCachedOrGenerateFlowchartScript,
  getCachedOrGenerateTraceScript,
  renderScriptAsMarkdown,
} from "./ai/traceScriptGenerator";

export function activate(context: vscode.ExtensionContext): void {
  const pythonIndexer = new PythonWorkspaceIndexer(context.extensionPath);
  const javascriptIndexer = new JavaScriptWorkspaceIndexer();
  const idlIndexer = new IdlWorkspaceIndexer(context.extensionPath);
  context.subscriptions.push(pythonIndexer, javascriptIndexer, idlIndexer);
  const output = vscode.window.createOutputChannel("CodeMap");
  context.subscriptions.push(output);
  let provider: GraphWebviewProvider;
  const probeResultStore = new ProbeResultStore();
  let lastRuntimeFrame: RuntimeFrame | null = null;
  let lastProbeTriggerKey = "";

  function presentGraph(graph: GraphDocument): void {
    logGraph(graph);
    provider.show(graph);
    if (!actionsViewProvider.isNarrationEnabled()) return;
    const autoGenerate = vscode.workspace.getConfiguration("codemap").get<boolean>("narration.autoGenerate", false);
    if (!autoGenerate) return;
    void generateAndPostNarration(graph, {
      interactive: false,
      forceRegenerate: false,
    }).catch((error) => {
      output.appendLine(`[narration:auto] ${(error as Error).message}`);
    });
  }

  const actionsViewProvider = new ActionsViewProvider(context, (state) => {
    provider.updateUiState(state);
    if (state.narrationEnabled === false) {
      provider.clearNarration();
      provider.clearDebugProbes();
    }
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
          presentGraph(graph);
        } else {
          output.appendLine(`[requestFlowchart] no flowchart for ${nodeId} at ${source.file}:${source.line}`);
          vscode.window.showInformationMessage(`CodeMap: no flowchart available for ${nodeId}`);
        }
      } catch (e) {
        output.appendLine(`[requestFlowchart] error: ${(e as Error).message}`);
      }
    },
    (kind, regenerate) => {
      const graph = provider.getCurrentGraph();
      if (!graph) {
        vscode.window.showInformationMessage("CodeMap: no graph is open to narrate.");
        return;
      }
      void generateAndPostNarration(graph, {
        requestedKind: kind,
        forceRegenerate: regenerate,
        interactive: true,
      }).catch(showError);
    },
    () => {
      void exportNarrationScript().catch(showError);
    },
    (enabled) => {
      actionsViewProvider.setNarrationEnabled(enabled);
      if (!enabled) {
        provider.clearNarration();
        provider.clearDebugProbes();
      }
    },
    (nodeId) => {
      const graph = provider.getCurrentGraph();
      if (!graph || !lastRuntimeFrame) return;
      void generateAndPostDebugProbes(graph, lastRuntimeFrame, nodeId, true).catch(showError);
    },
    (probeId) => {
      const probe = findProbeById(probeId);
      if (!probe) return;
      probeResultStore.clearNode(probe.nodeId);
      provider.clearDebugProbes(probe.nodeId);
    },
  );
  provider.updateUiState(actionsViewProvider.getUiState());

  const navController = new NavigationController(
    context.extensionPath,
    pythonIndexer,
    (graph) => presentGraph(graph),
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
    vscode.commands.registerCommand("codemap.narrateCurrentGraph", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph) {
        vscode.window.showInformationMessage("CodeMap: no graph is open to narrate.");
        return;
      }
      await generateAndPostNarration(graph, { interactive: true, forceRegenerate: false });
    }),
    vscode.commands.registerCommand("codemap.narrateTrace", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph) {
        vscode.window.showInformationMessage("CodeMap: no graph is open to narrate.");
        return;
      }
      if (!getGraphCapabilities(graph).traceNarration) {
        vscode.window.showWarningMessage("CodeMap: trace narration needs a call graph with an execution timeline.");
        return;
      }
      await generateAndPostNarration(graph, {
        interactive: true,
        forceRegenerate: false,
        requestedKind: "trace",
      });
    }),
    vscode.commands.registerCommand("codemap.narrateFlowchart", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph) {
        vscode.window.showInformationMessage("CodeMap: no graph is open to narrate.");
        return;
      }
      if (graph.graphType !== "flowchart") {
        vscode.window.showWarningMessage("CodeMap: flowchart narration requires an open flowchart.");
        return;
      }
      await generateAndPostNarration(graph, {
        interactive: true,
        forceRegenerate: false,
        requestedKind: "flowchart",
      });
    }),
    vscode.commands.registerCommand("codemap.regenerateNarration", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph) {
        vscode.window.showInformationMessage("CodeMap: no graph is open to narrate.");
        return;
      }
      await generateAndPostNarration(graph, {
        interactive: true,
        forceRegenerate: true,
      });
    }),
    vscode.commands.registerCommand("codemap.exportScript", async () => {
      await exportNarrationScript();
    }),
    vscode.commands.registerCommand("codemap.generateProbes", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph || !lastRuntimeFrame) {
        vscode.window.showInformationMessage("CodeMap: stop at a breakpoint in an open graph before generating probes.");
        return;
      }
      const capabilities = getGraphCapabilities(graph);
      if (!capabilities.runtimeProbes) {
        vscode.window.showWarningMessage(`CodeMap: runtime probes are not supported for ${capabilities.language} graphs yet.`);
        return;
      }
      const nodeId = lastRuntimeFrame.source ? findGraphNodeByLocation(graph, lastRuntimeFrame.source) : undefined;
      if (!nodeId) {
        vscode.window.showInformationMessage("CodeMap: the current frame does not map to a graph node.");
        return;
      }
      await generateAndPostDebugProbes(graph, lastRuntimeFrame, nodeId, true);
    }),
    vscode.commands.registerCommand("codemap.askProbe", async () => {
      const graph = provider.getCurrentGraph();
      if (!graph || !lastRuntimeFrame?.source) {
        vscode.window.showInformationMessage("CodeMap: stop at a breakpoint in an open graph before asking for a probe.");
        return;
      }
      const capabilities = getGraphCapabilities(graph);
      if (!capabilities.runtimeProbes) {
        vscode.window.showWarningMessage(`CodeMap: runtime probes are not supported for ${capabilities.language} graphs yet.`);
        return;
      }
      const nodeId = findGraphNodeByLocation(graph, lastRuntimeFrame.source);
      const node = nodeId ? graph.nodes.find((entry) => entry.id === nodeId) : undefined;
      if (!node) {
        vscode.window.showInformationMessage("CodeMap: the current frame does not map to a graph node.");
        return;
      }
      const question = await vscode.window.showInputBox({
        prompt: "What do you want to inspect at this breakpoint?",
        placeHolder: "e.g. show the phase PSD or summarize the current tensor state",
      });
      if (!question?.trim()) return;
      const tokenSource = new vscode.CancellationTokenSource();
      try {
        const probe = await generateSingleDebugProbe({
          context,
          graph,
          node,
          runtimeFrame: lastRuntimeFrame,
          narrationScript: provider.getCurrentNarration() || null,
          token: tokenSource.token,
          question,
        });
        if (!probe) return;
        probeResultStore.setProbes(node.id, [...probeResultStore.getProbes(node.id), probe]);
        provider.postDebugProbes(probeResultStore.getProbes(node.id));
        const session = vscode.debug.activeDebugSession;
        if (!session) return;
        const result = await injectProbe(probe, lastRuntimeFrame, session, probeResultStore.nextHitCount(probe.id));
        probeResultStore.recordResult(result);
        provider.postProbeResult(result);
      } finally {
        tokenSource.dispose();
      }
    }),
    vscode.commands.registerCommand("codemap.clearProbes", async () => {
      provider.clearDebugProbes();
      lastProbeTriggerKey = "";
    }),
    vscode.commands.registerCommand("codemap.exportProbes", async () => {
      const probes = probeResultStore.getAllProbes();
      if (!probes.length) {
        vscode.window.showInformationMessage("CodeMap: generate probes before exporting them.");
        return;
      }
      // Choose extension/comment syntax based on the dominant probe language.
      const langCounts = new Map<string, number>();
      for (const probe of probes) {
        langCounts.set(probe.language, (langCounts.get(probe.language) || 0) + 1);
      }
      let dominantLanguage: "python" | "javascript" | "idl" = "python";
      let bestCount = -1;
      for (const [lang, count] of langCounts) {
        if (count > bestCount) {
          bestCount = count;
          dominantLanguage = lang as "python" | "javascript" | "idl";
        }
      }
      const exportFormat = PROBE_EXPORT_FORMATS[dominantLanguage];
      const uri = await vscode.window.showSaveDialog({
        filters: exportFormat.filters,
        saveLabel: "Export Debug Probes",
        defaultUri: vscode.Uri.file(path.join(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath,
          `codemap_debug_probes.${exportFormat.extension}`,
        )),
      });
      if (!uri) return;
      const headerComment = exportFormat.comment(`CodeMap Debug Probes - generated ${new Date().toISOString()}`);
      const lines = [headerComment, ""];
      probes.forEach((probe, index) => {
        const probeFormat = PROBE_EXPORT_FORMATS[probe.language] || exportFormat;
        lines.push(probeFormat.comment(`Probe ${index + 1}: ${probe.label}`));
        lines.push(probeFormat.comment(`Node: ${probe.nodeId} @ ${probe.breakpointFile}:${probe.breakpointLine}`));
        lines.push(probeFormat.comment(`Language: ${probe.language}`));
        lines.push(probe.snippet);
        lines.push("");
      });
      fs.writeFileSync(uri.fsPath, lines.join("\n"), "utf8");
      vscode.window.showInformationMessage(`CodeMap: exported debug probes to ${uri.fsPath}`);
    }),
  );

  // Debug sync wiring: when active, push runtime frames + computed highlights
  // to whatever graph is currently shown in the webview.
  context.subscriptions.push(
    debugSync.onRuntime((frame) => {
      lastRuntimeFrame = frame;
      if (!provider.isVisible()) return;
      const graph = provider.getCurrentGraph();
      const highlights: string[] = [];
      const breakpointHighlights: string[] = [];
      let matchedNodeId: string | undefined;
      if (frame && graph && frame.source) {
        const matchId = findGraphNodeByLocation(graph, frame.source);
        matchedNodeId = matchId;
        if (matchId) highlights.push(matchId);
        if (matchId && isActiveSourceBreakpointHit(frame.source.file, frame.source.line)) {
          breakpointHighlights.push(matchId);
        }
        // Flowcharts should mirror editor-style current-line focus.
        if (graph.graphType !== "flowchart") {
          for (const sf of frame.callStack) {
            if (!sf.file || !sf.line) continue;
            const id = findGraphNodeByLocation(graph, { file: sf.file, line: sf.line });
            if (id && !highlights.includes(id)) highlights.push(id);
          }
        }
      }
      provider.postRuntimeFrame(frame, highlights, breakpointHighlights);
      if (!frame || !graph || !matchedNodeId || !breakpointHighlights.includes(matchedNodeId) || !actionsViewProvider.isNarrationEnabled()) {
        return;
      }
      const triggerKey = `${frame.sessionId}:${frame.frameId}:${matchedNodeId}:${frame.source?.file}:${frame.source?.line}`;
      if (triggerKey === lastProbeTriggerKey) return;
      lastProbeTriggerKey = triggerKey;
      void generateAndPostDebugProbes(graph, frame, matchedNodeId, false).catch((error) => {
        output.appendLine(`[debug-probes] ${(error as Error).message}`);
      });
    }),
  );

  function isActiveSourceBreakpointHit(file: string, line: number): boolean {
    const normalizedFile = file.replace(/\\/g, "/").toLowerCase();
    return vscode.debug.breakpoints.some((breakpoint) => {
      if (!(breakpoint instanceof vscode.SourceBreakpoint)) return false;
      if (!breakpoint.enabled) return false;
      const breakpointFile = breakpoint.location.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      return breakpointFile === normalizedFile && breakpoint.location.range.start.line + 1 === line;
    });
  }

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
        presentGraph(graph);
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
        presentGraph(graph);
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
      presentGraph(graph);
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
      presentGraph(jsWorkspaceGraphCache);
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
      presentGraph(idlWorkspaceGraphCache);
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

      presentGraph(graph);
    } catch (e) {
      showError(e);
    }
  }

  async function generateAndPostNarration(
    graph: GraphDocument,
    options: {
      requestedKind?: NarrationKind;
      forceRegenerate?: boolean;
      interactive: boolean;
    },
  ): Promise<void> {
    if (!actionsViewProvider.isNarrationEnabled()) {
      if (options.interactive) {
        vscode.window.showInformationMessage("CodeMap: Copilot narration is turned off in Controls > Display Settings.");
      }
      provider.clearNarration();
      return;
    }

    const kind = resolveNarrationKind(graph, options.requestedKind);
    const modelChoice = await resolveNarrationModel(context, options.interactive);
    if (!modelChoice) return;

    const runGeneration = async (token: vscode.CancellationToken): Promise<void> => {
      const script = kind === "flowchart"
        ? await getCachedOrGenerateFlowchartScript({
            context,
            graph,
            model: modelChoice.model,
            token,
            forceRegenerate: options.forceRegenerate,
          })
        : await getCachedOrGenerateTraceScript({
            context,
            graph,
            model: modelChoice.model,
            token,
            forceRegenerate: options.forceRegenerate,
          });
      provider.postNarrationScript(script);
    };

    if (options.interactive) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodeMap: Generating ${kind === "flowchart" ? "flowchart annotations" : "narration"} with ${modelChoice.model.name}...`,
        },
        async (_progress, token) => runGeneration(token),
      );
      return;
    }

    const source = new vscode.CancellationTokenSource();
    try {
      await runGeneration(source.token);
    } finally {
      source.dispose();
    }
  }

  async function generateAndPostDebugProbes(
    graph: GraphDocument,
    frame: RuntimeFrame,
    nodeId: string,
    forceRegenerate: boolean,
  ): Promise<void> {
    if (!actionsViewProvider.isNarrationEnabled()) {
      provider.clearDebugProbes(nodeId);
      return;
    }
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node) return;
    const session = vscode.debug.activeDebugSession;
    if (!session) return;
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const probes = await getCachedOrGenerateDebugProbes({
        context,
        graph,
        node,
        runtimeFrame: frame,
        narrationScript: provider.getCurrentNarration() || null,
        token: tokenSource.token,
        forceRegenerate,
      });
      if (!probes.length) return;
      probeResultStore.setProbes(nodeId, probes);
      provider.postDebugProbes(probes);
      provider.highlightProbeNode(nodeId);
      for (const probe of probes) {
        void injectProbe(probe, frame, session, probeResultStore.nextHitCount(probe.id))
          .then((result) => {
            probeResultStore.recordResult(result);
            provider.postProbeResult(result);
            provider.highlightProbeNode(result.nodeId);
          })
          .catch((error) => {
            provider.postProbeResult({
              probeId: probe.id,
              nodeId: probe.nodeId,
              hitCount: probeResultStore.nextHitCount(probe.id),
              timestamp: Date.now(),
              data: null,
              error: (error as Error).message,
            });
          });
      }
    } finally {
      tokenSource.dispose();
    }
  }

  function findProbeById(probeId: string): DebugProbe | undefined {
    return probeResultStore.getProbe(probeId);
  }

  async function exportNarrationScript(): Promise<void> {
    const script = provider.getCurrentNarration();
    if (!script) {
      vscode.window.showInformationMessage("CodeMap: generate narration before exporting a script.");
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      filters: { Markdown: ["md"] },
      saveLabel: "Export Narration Script",
      defaultUri: vscode.Uri.file(path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath,
        `${script.graphId}-narration.md`,
      )),
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, renderScriptAsMarkdown(script), "utf8");
    vscode.window.showInformationMessage(`CodeMap: exported narration script to ${uri.fsPath}`);
  }
}

function resolveNarrationKind(graph: GraphDocument, requestedKind?: NarrationKind): NarrationKind {
  if (requestedKind) return requestedKind;
  return graph.graphType === "flowchart" ? "flowchart" : "trace";
}

/** Single source of truth for whether a given graph supports each capability. */
export interface GraphCapabilities {
  language: "python" | "javascript" | "idl" | "unknown";
  flowchartNarration: boolean;
  traceNarration: boolean;
  /** Whether the runtime probe pipeline (LLM-generated snippets injected via DAP) is supported. */
  runtimeProbes: boolean;
}

export function getGraphCapabilities(graph: GraphDocument): GraphCapabilities {
  const language = inferGraphLanguage(graph);
  const hasTimeline = Array.isArray(graph.metadata?.execTimeline) && graph.metadata!.execTimeline!.length > 0;
  const isFlowchart = graph.graphType === "flowchart";
  // Probes are wired for Python and JavaScript via DAP `evaluate`. IDL probe support is best-effort
  // and not yet validated end-to-end, so we keep it disabled to avoid surprising users.
  const runtimeProbes = language === "python" || language === "javascript";
  return {
    language,
    flowchartNarration: isFlowchart,
    traceNarration: !isFlowchart && hasTimeline,
    runtimeProbes,
  };
}

function inferGraphLanguage(graph: GraphDocument): GraphCapabilities["language"] {
  const metaLang = (graph.metadata as { language?: unknown } | undefined)?.language;
  if (typeof metaLang === "string") {
    if (metaLang === "python" || metaLang === "javascript" || metaLang === "idl") return metaLang;
  }
  for (const node of graph.nodes) {
    const file = node.source?.file;
    if (!file) continue;
    const lang = languageForPath(file);
    if (lang) return lang;
  }
  return "unknown";
}

function supportsTraceNarration(graph: GraphDocument): boolean {
  return getGraphCapabilities(graph).traceNarration;
}

/** Per-language formatting for the probe export file. */
const PROBE_EXPORT_FORMATS: Record<"python" | "javascript" | "idl", {
  extension: string;
  filters: { [name: string]: string[] };
  comment: (text: string) => string;
}> = {
  python: { extension: "py", filters: { Python: ["py"] }, comment: (text) => `# ${text}` },
  javascript: { extension: "js", filters: { JavaScript: ["js"], TypeScript: ["ts"] }, comment: (text) => `// ${text}` },
  idl: { extension: "pro", filters: { IDL: ["pro"] }, comment: (text) => `; ${text}` },
};

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
