import * as vscode from "vscode";
import { GraphDocument, ZoomLevel } from "../python/model/graphTypes";
import { PyAnalysisResult } from "../python/model/symbolTypes";
import { PythonWorkspaceIndexer } from "../python/analysis/pythonWorkspaceIndexer";
import {
  buildPackageGraph,
  buildModuleGraph,
  buildSymbolGraph,
  computeModuleColorMap,
  flowchartZoomContext,
  buildUnifiedGraph,
} from "../python/analysis/hierarchicalGraphBuilder";
import { buildFlowchartFor } from "../python/analysis/pythonRunner";
import { buildWorkspaceGraph } from "../python/analysis/pythonCallGraphBuilder";

interface ShowGraph {
  (graph: GraphDocument): void;
}

/**
 * NavigationController coordinates the semantic-zoom navigation stack.
 * It owns a per-analysis cache of built graphs, tracks the current level,
 * and knows how to re-build on invalidation.
 */
export class NavigationController {
  private cache = new Map<string, GraphDocument>();
  private moduleColorMap: Record<string, string> | undefined;
  private currentAnalysis: PyAnalysisResult | undefined;

  constructor(
    private readonly extensionPath: string,
    private readonly indexer: PythonWorkspaceIndexer,
    private readonly showGraph: ShowGraph,
    private readonly log: (message: string) => void,
  ) {}

  /** Drop cached graphs; called after the analysis is re-indexed. */
  invalidateCache(): void {
    this.cache.clear();
    this.moduleColorMap = undefined;
    this.currentAnalysis = undefined;
  }

  /** Ensure we have a current analysis and module color map. */
  private async ensureAnalysis(forceRefresh = false): Promise<PyAnalysisResult> {
    if (!this.currentAnalysis || forceRefresh) {
      const analysis = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "CodeMap: indexing workspace..." },
        () => this.indexer.getAnalysis(forceRefresh),
      );
      if (forceRefresh) this.cache.clear();
      this.currentAnalysis = analysis;
      this.moduleColorMap = computeModuleColorMap(analysis);
    }
    return this.currentAnalysis;
  }

  private key(level: ZoomLevel, id: string): string {
    return `L${level}:${id}`;
  }

  /** L0 entry point: show the package graph for the whole workspace. */
  async showPackageView(forceRefresh = false): Promise<void> {
    const analysis = await this.ensureAnalysis(forceRefresh);
    const cacheKey = this.key(0, "root");
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      graph = buildPackageGraph(analysis, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] L0 package view · ${graph.nodes.length} packages / ${graph.edges.length} edges`);
    this.showGraph(graph);
  }

  /** Backward-compatible entry used by extension workspace command. */
  async showWorkspaceCallGraph(forceRefresh = false): Promise<void> {
    const analysis = await this.ensureAnalysis(forceRefresh);
    const cacheKey = "workspace:root";
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      graph = buildWorkspaceGraph(analysis, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] workspace call graph · ${graph.nodes.length} symbols / ${graph.edges.length} edges`);
    this.showGraph(graph);
  }

  /** Unified view: all packages, modules, and symbols on one canvas. */
  async showUnifiedView(forceRefresh = false): Promise<void> {
    const analysis = await this.ensureAnalysis(forceRefresh);
    const cacheKey = "unified:root";
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      graph = buildUnifiedGraph(analysis, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] unified view · ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
    this.showGraph(graph);
  }

  /** L1: drill into a folder. `folderId` is "pkg:foo" or a bare folder name. */
  async showModuleView(folderId: string): Promise<void> {
    const analysis = await this.ensureAnalysis();
    const normalized = folderId.startsWith("pkg:") ? folderId : `pkg:${folderId}`;
    const cacheKey = this.key(1, normalized);
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      graph = buildModuleGraph(analysis, normalized, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] L1 module view of ${normalized} · ${graph.nodes.length} modules`);
    this.showGraph(graph);
  }

  /** L2: drill into a module's symbol graph. */
  async showSymbolView(moduleId: string): Promise<void> {
    const analysis = await this.ensureAnalysis();
    const cacheKey = this.key(2, moduleId);
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      graph = buildSymbolGraph(analysis, moduleId, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] L2 symbol view of ${moduleId} · ${graph.nodes.length} symbols`);
    this.showGraph(graph);
  }

  /** L3: build and show a flowchart for a function symbol. */
  async showFlowchartView(symbolId: string): Promise<void> {
    const analysis = await this.ensureAnalysis();
    const cacheKey = this.key(3, symbolId);
    let graph = this.cache.get(cacheKey);
    if (!graph) {
      const sym = analysis.symbols[symbolId];
      if (!sym || (sym.kind !== "function" && sym.kind !== "method")) {
        vscode.window.showWarningMessage(`CodeMap: no flowchart available for ${symbolId}`);
        return;
      }
      try {
        const built = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "CodeMap: building flowchart..." },
          () => buildFlowchartFor(this.extensionPath, sym.source.file, sym.source.line, analysis),
        );
        if (!built || !built.nodes || built.nodes.length === 0) {
          vscode.window.showInformationMessage(`CodeMap: no flowchart for ${sym.qualifiedName}`);
          return;
        }
        // Attach a zoom context so the webview knows it's at L3.
        built.metadata = {
          ...(built.metadata || {}),
          zoomContext: flowchartZoomContext(analysis, symbolId, this.moduleColorMap),
        };
        this.cache.set(cacheKey, built);
        graph = built;
      } catch (e) {
        vscode.window.showErrorMessage(`CodeMap: flowchart failed: ${(e as Error).message}`);
        return;
      }
    }
    this.log(`[nav] L3 flowchart of ${symbolId}`);
    this.showGraph(graph);
  }

  /**
   * Navigate to a breadcrumb entry. Level 0→root; Level 1→folder id;
   * Level 2→module id; Level 3→symbol id.
   */
  async navigateToBreadcrumb(level: ZoomLevel, id: string): Promise<void> {
    switch (level) {
      case 0:
        return this.showPackageView();
      case 1:
        return this.showModuleView(id);
      case 2:
        return this.showSymbolView(id);
      case 3:
        return this.showFlowchartView(id);
    }
  }

  /** Click on a peripheral reference: same-level navigation when possible. */
  async navigateToPeripheral(targetLevel: ZoomLevel, targetId: string): Promise<void> {
    return this.navigateToBreadcrumb(targetLevel, targetId);
  }

  /**
   * Drill-into behavior: move down one level from the current context.
   * Caller supplies the target level/id already resolved from the clicked node.
   */
  async drillInto(targetLevel: ZoomLevel, targetId: string): Promise<void> {
    return this.navigateToBreadcrumb(targetLevel, targetId);
  }
}
