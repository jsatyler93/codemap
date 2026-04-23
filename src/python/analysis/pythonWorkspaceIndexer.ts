import * as vscode from "vscode";
import { PyAnalysisResult } from "../model/symbolTypes";
import { indexWorkspace } from "./pythonRunner";

/** Caches the latest analysis. Refresh on demand or on file change. */
export class PythonWorkspaceIndexer implements vscode.Disposable {
  private cache: PyAnalysisResult | undefined;
  private inflight: Promise<PyAnalysisResult> | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private debounceHandle: NodeJS.Timeout | undefined;
  private includedFiles: string[] | undefined;

  constructor(private readonly extensionPath: string) {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    const invalidate = () => this.scheduleInvalidate();
    this.watcher.onDidChange(invalidate);
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  dispose(): void {
    this.watcher.dispose();
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
  }

  invalidate(): void {
    this.cache = undefined;
  }

  setIncludedFiles(files: string[] | undefined): void {
    const normalized = files ? [...files].sort() : undefined;
    const prev = this.includedFiles ? this.includedFiles.join("\n") : "";
    const next = normalized ? normalized.join("\n") : "";
    if (prev === next) return;
    this.includedFiles = normalized;
    this.cache = undefined;
  }

  private scheduleInvalidate(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.cache = undefined;
    }, 500);
  }

  async getAnalysis(force = false): Promise<PyAnalysisResult> {
    if (!force && this.cache) {
      return this.cache;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.runAnalysis();
    try {
      this.cache = await this.inflight;
      return this.cache;
    } finally {
      this.inflight = undefined;
    }
  }

  private async runAnalysis(): Promise<PyAnalysisResult> {
    const cap = vscode.workspace
      .getConfiguration("codemap")
      .get<number>("workspace.maxFiles", 400);
    const scopedFiles = this.includedFiles;
    const files = (scopedFiles && scopedFiles.length > 0)
      ? scopedFiles.slice(0, cap).map((filePath) => vscode.Uri.file(filePath))
      : await vscode.workspace.findFiles(
        "**/*.py",
        "**/{node_modules,.venv,venv,__pycache__,.git,build,dist}/**",
        cap,
      );
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (files.length === 0) {
      return { symbols: {}, modules: {}, errors: [] };
    }
    return indexWorkspace(
      this.extensionPath,
      files.map((f) => f.fsPath),
      root,
      vscode.workspace.getConfiguration("codemap").get<boolean>("useJedi", true),
    );
  }
}
