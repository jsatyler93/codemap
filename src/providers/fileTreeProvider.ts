import * as path from "path";
import * as vscode from "vscode";

/**
 * In-memory representation of one node in the file scope tree.
 * Folders have children; files do not. Both can be checked or unchecked.
 */
interface FileNode {
  /** Absolute fs path. */
  fsPath: string;
  /** Display name (basename). */
  name: string;
  /** True if this node is a directory. */
  isDirectory: boolean;
  /** Parent node, or undefined for workspace roots. */
  parent: FileNode | undefined;
  /** Child nodes (folders first, then files), keyed by basename for lookup. */
  children: Map<string, FileNode>;
  /** Number of .py files contained in this subtree (1 for a .py file). */
  pythonFileCount: number;
}

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".git",
  "build",
  "dist",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

const STORAGE_KEY_UNCHECKED = "codemap.uncheckedFiles";

function toPathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * TreeDataProvider that mirrors the workspace file tree, restricted to folders
 * containing Python files and the .py files themselves. Each item exposes a
 * checkbox; checked files form the analysis scope for the rest of CodeMap.
 *
 * Checkbox propagation (parent → descendants and child → ancestors) is managed
 * manually so that mixed states on folders behave intuitively.
 */
export class FileTreeProvider implements vscode.TreeDataProvider<FileNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FileNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeCheckedFiles = new vscode.EventEmitter<string[]>();
  /** Emitted whenever the set of checked .py files changes. */
  readonly onDidChangeCheckedFiles = this._onDidChangeCheckedFiles.event;

  /** Synthetic root holding all workspace folder nodes as children. */
  private root: FileNode = this.makeNode("", "", true, undefined);

  /** Set of absolute fs paths the user has unchecked. Persisted. */
  private uncheckedPaths: Set<string> = new Set();

  private treeView: vscode.TreeView<FileNode> | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private rebuildTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<string[]>(STORAGE_KEY_UNCHECKED, []);
    this.uncheckedPaths = new Set(stored.map((p) => toPathKey(p)));
  }

  /** Build the initial tree and start watching for .py file changes. */
  async initialize(): Promise<void> {
    await this.rebuildTree();
    this._onDidChangeTreeData.fire();
    this.updateBadge();
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    const schedule = (): void => this.scheduleRebuild();
    this.disposables.push(
      this.watcher,
      this.watcher.onDidChange(schedule),
      this.watcher.onDidCreate(schedule),
      this.watcher.onDidDelete(schedule),
    );
  }

  /** Attach the TreeView so we can listen for checkbox events. */
  attachTreeView(treeView: vscode.TreeView<FileNode>): void {
    this.treeView = treeView;
    this.disposables.push(
      treeView.onDidChangeCheckboxState((e) => {
        // VS Code can report both a directly toggled file and ancestor folders
        // whose visual checked state changed as a consequence. Apply only the
        // deepest changed nodes to avoid accidental subtree-wide selection.
        const changedNodes = e.items.map(([node]) => node);
        const effectiveItems = e.items.filter(([node]) => {
          for (const other of changedNodes) {
            if (other === node) continue;
            let parent = other.parent;
            while (parent) {
              if (parent === node) return false;
              parent = parent.parent;
            }
          }
          return true;
        });
        for (const [node, state] of effectiveItems) {
          this.applyCheckboxChange(node, state === vscode.TreeItemCheckboxState.Checked);
        }
        this.persistAndEmit();
        this._onDidChangeTreeData.fire();
        this.updateBadge();
      }),
    );
    this.updateBadge();
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
    this._onDidChangeCheckedFiles.dispose();
  }

  // --- Public API -------------------------------------------------------

  /** All currently-checked .py files (absolute paths). */
  getCheckedFiles(): string[] {
    const out: string[] = [];
    this.collectCheckedFiles(this.root, out);
    return out;
  }

  /** {checked, total} summary across all .py files in the tree. */
  getSelectionSummary(): { checked: number; total: number } {
    const total = this.root.pythonFileCount;
    const checked = this.getCheckedFiles().length;
    return { checked, total };
  }

  /** Check every file/folder in the tree. */
  selectAll(): void {
    this.uncheckedPaths.clear();
    this.persistAndEmit();
    this._onDidChangeTreeData.fire();
    this.updateBadge();
  }

  /** Uncheck every file/folder in the tree. */
  deselectAll(): void {
    this.uncheckedPaths.clear();
    this.collectAllPaths(this.root, this.uncheckedPaths);
    // The synthetic root is included by collectAllPaths but its key is "" — drop it.
    this.uncheckedPaths.delete(toPathKey(""));
    this.persistAndEmit();
    this._onDidChangeTreeData.fire();
    this.updateBadge();
  }

  // --- TreeDataProvider implementation ----------------------------------

  getTreeItem(element: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      element.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.fsPath;
    item.resourceUri = vscode.Uri.file(element.fsPath);
    item.contextValue = element.isDirectory ? "folder" : "pythonFile";
    if (element.isDirectory) {
      item.description = `(${element.pythonFileCount})`;
    } else {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [item.resourceUri],
      };
    }
    item.checkboxState = this.isChecked(element)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  getChildren(element?: FileNode): FileNode[] {
    const parent = element ?? this.root;
    return Array.from(parent.children.values()).sort(this.compareNodes);
  }

  getParent(element: FileNode): FileNode | undefined {
    return element.parent === this.root ? undefined : element.parent;
  }

  // --- Internal: tree construction -------------------------------------

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuildTree()
        .then(() => {
          this._onDidChangeTreeData.fire();
          this.updateBadge();
        })
        .catch(() => {
          /* swallow: tree rebuild errors are non-fatal */
        });
    }, 300);
  }

  private async rebuildTree(): Promise<void> {
    const excludeGlob =
      "**/{" + Array.from(EXCLUDED_DIRS).join(",") + "}/**";
    const files = await vscode.workspace.findFiles("**/*.py", excludeGlob);
    const folders = vscode.workspace.workspaceFolders ?? [];

    this.root = this.makeNode("", "", true, undefined);

    // Seed workspace folder roots so empty-but-relevant roots still appear.
    for (const wf of folders) {
      this.ensureFolder(wf.uri.fsPath, wf.name);
    }

    for (const file of files) {
      const fsPath = file.fsPath;
      const owner = folders.find((wf) => isInside(fsPath, wf.uri.fsPath));
      if (!owner) continue; // skip files outside any workspace folder
      const rootPath = owner.uri.fsPath;
      const rootNode = this.ensureFolder(rootPath, owner.name);
      const rel = path.relative(rootPath, fsPath);
      const segments = rel.split(/[\\/]+/).filter(Boolean);
      // Drop excluded segments (defensive; findFiles already excludes).
      if (segments.some((s) => EXCLUDED_DIRS.has(s))) continue;

      let current = rootNode;
      let currentPath = rootPath;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        currentPath = path.join(currentPath, seg);
        let next = current.children.get(seg);
        if (!next) {
          next = this.makeNode(currentPath, seg, true, current);
          current.children.set(seg, next);
        }
        current = next;
      }
      const fileName = segments[segments.length - 1];
      if (!current.children.has(fileName)) {
        const fileNode = this.makeNode(fsPath, fileName, false, current);
        fileNode.pythonFileCount = 1;
        current.children.set(fileName, fileNode);
      }
    }

    // Compute folder pythonFileCount bottom-up and prune empty folders.
    this.finalize(this.root);

    // Drop any persisted-unchecked entries for paths that no longer exist.
    const surviving = new Set<string>();
    this.collectAllPaths(this.root, surviving);
    for (const p of Array.from(this.uncheckedPaths)) {
      if (!surviving.has(p)) this.uncheckedPaths.delete(p);
    }
  }

  private ensureFolder(fsPath: string, name: string): FileNode {
    let node = this.root.children.get(fsPath);
    if (!node) {
      node = this.makeNode(fsPath, name, true, this.root);
      this.root.children.set(fsPath, node);
    }
    return node;
  }

  private makeNode(
    fsPath: string,
    name: string,
    isDirectory: boolean,
    parent: FileNode | undefined,
  ): FileNode {
    return {
      fsPath,
      name,
      isDirectory,
      parent,
      children: new Map(),
      pythonFileCount: 0,
    };
  }

  /** Recursively compute pythonFileCount and remove folders with no .py files. */
  private finalize(node: FileNode): number {
    if (!node.isDirectory) return node.pythonFileCount;
    let total = 0;
    for (const [key, child] of Array.from(node.children.entries())) {
      const count = this.finalize(child);
      if (child.isDirectory && count === 0) {
        node.children.delete(key);
      } else {
        total += count;
      }
    }
    node.pythonFileCount = total;
    return total;
  }

  // --- Internal: checkbox state ----------------------------------------

  private isChecked(node: FileNode): boolean {
    if (!node.isDirectory) {
      return !this.uncheckedPaths.has(toPathKey(node.fsPath));
    }
    // A folder is checked iff at least one descendant .py file is checked.
    // (We display Checked for fully-checked folders too. Mixed state is shown
    // as Checked since the TreeView checkbox is binary; user can drill in.)
    for (const child of node.children.values()) {
      if (this.isChecked(child)) return true;
    }
    return false;
  }

  /** Apply a user-driven checkbox change to a node and propagate to descendants. */
  private applyCheckboxChange(node: FileNode, checked: boolean): void {
    if (node.isDirectory) {
      this.collectAllFilePaths(node, (filePath) => {
        const key = toPathKey(filePath);
        if (checked) this.uncheckedPaths.delete(key);
        else this.uncheckedPaths.add(key);
      });
    } else {
      const key = toPathKey(node.fsPath);
      if (checked) this.uncheckedPaths.delete(key);
      else this.uncheckedPaths.add(key);
    }
  }

  private collectCheckedFiles(node: FileNode, out: string[]): void {
    if (!node.isDirectory) {
      if (!this.uncheckedPaths.has(toPathKey(node.fsPath))) out.push(node.fsPath);
      return;
    }
    for (const child of node.children.values()) {
      this.collectCheckedFiles(child, out);
    }
  }

  private collectAllFilePaths(node: FileNode, visit: (p: string) => void): void {
    if (!node.isDirectory) {
      visit(node.fsPath);
      return;
    }
    for (const child of node.children.values()) {
      this.collectAllFilePaths(child, visit);
    }
  }

  private collectAllPaths(node: FileNode, out: Set<string>): void {
    out.add(toPathKey(node.fsPath));
    for (const child of node.children.values()) {
      this.collectAllPaths(child, out);
    }
  }

  private persistAndEmit(): void {
    void this.context.workspaceState.update(
      STORAGE_KEY_UNCHECKED,
      Array.from(this.uncheckedPaths),
    );
    this._onDidChangeCheckedFiles.fire(this.getCheckedFiles());
  }

  private updateBadge(): void {
    if (!this.treeView) return;
    const { checked, total } = this.getSelectionSummary();
    this.treeView.badge = {
      tooltip: `${checked} of ${total} Python files selected for analysis`,
      value: total - checked,
    };
    this.treeView.description = `${checked} / ${total} files`;
  }

  private compareNodes = (a: FileNode, b: FileNode): number => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
