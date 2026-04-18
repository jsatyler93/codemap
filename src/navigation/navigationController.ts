import * as vscode from "vscode";
import { GraphDocument } from "../python/model/graphTypes";
import { PythonWorkspaceIndexer } from "../python/analysis/pythonWorkspaceIndexer";
import { computeModuleColorMap } from "../python/analysis/hierarchicalGraphBuilder";
import { buildWorkspaceGraph } from "../python/analysis/pythonCallGraphBuilder";
import { PyAnalysisResult } from "../python/model/symbolTypes";

interface ShowGraph {
  (graph: GraphDocument): void;
}

/**
 * NavigationController coordinates the two views: workspace call graph
 * and function flowchart drill-downs.
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

  /**
   * Workspace call graph: all modules and symbols.
   * This is the default and primary view.
   */
  async showWorkspaceCallGraph(forceRefresh = false): Promise<void> {
    const analysis = await this.ensureAnalysis(forceRefresh);
    const cacheKey = "workspace:root";
    let graph = this.cache.get(cacheKey);
    if (!graph || forceRefresh) {
      graph = buildWorkspaceGraph(analysis, this.moduleColorMap);
      this.cache.set(cacheKey, graph);
    }
    this.log(`[nav] workspace call graph · ${graph.nodes.length} symbols / ${graph.edges.length} edges`);
    this.showGraph(graph);
  }
}
