import * as vscode from "vscode";

import { PyAnalysisResult } from "../../python/model/symbolTypes";
import { indexJavaScriptWorkspace } from "./javascriptAnalyzer";

declare function setTimeout(handler: () => void, timeout: number): unknown;
declare function clearTimeout(handle: unknown): void;

const JS_FILE_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/i;

export class JavaScriptWorkspaceIndexer implements vscode.Disposable {
  private cache: PyAnalysisResult | undefined;
  private inflight: Promise<PyAnalysisResult> | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private debounceHandle: unknown;
  private includedFiles: string[] | undefined;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.{js,jsx,mjs,cjs,ts,tsx}");
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
    const jsFiles = files?.filter((file) => JS_FILE_RE.test(file));
    const normalized = jsFiles ? [...jsFiles].sort() : undefined;
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
      ? scopedFiles.slice(0, cap)
      : (await vscode.workspace.findFiles(
        "**/*.{js,jsx,mjs,cjs,ts,tsx}",
        "**/{node_modules,.venv,venv,__pycache__,.git,build,dist}/**",
        cap,
      )).map((f) => f.fsPath);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    if (files.length === 0) {
      return { symbols: {}, modules: {}, errors: [] };
    }

    return indexJavaScriptWorkspace(files, root);
  }
}
