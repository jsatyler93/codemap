// DebugSyncService listens to the active VS Code debug session and emits
// runtime events (current frame, locals, call stack) that the webview can
// use to highlight nodes/blocks in real time.

import * as vscode from "vscode";

export interface RuntimeFrame {
  frameId: number;
  name: string;
  source?: { file: string; line: number; column?: number };
  callStack: { name: string; file?: string; line?: number }[];
  variables: { name: string; type?: string; value: string; scope: string }[];
  threadId?: number;
  sessionId: string;
}

export type RuntimeListener = (frame: RuntimeFrame | null) => void;

const MAX_VARS_PER_SCOPE = 40;
const MAX_VALUE_LEN = 200;

export class DebugSyncService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly listeners = new Set<RuntimeListener>();
  private active = false;
  private fetchTokenSeq = 0;

  start(): void {
    if (this.active) return;
    this.active = true;

    // Modern API: onDidChangeActiveStackItem (VS Code 1.84+)
    const anyDebug = vscode.debug as unknown as {
      onDidChangeActiveStackItem?: (
        listener: (item: unknown) => void,
      ) => vscode.Disposable;
      activeStackItem?: unknown;
    };

    if (anyDebug.onDidChangeActiveStackItem) {
      this.disposables.push(
        anyDebug.onDidChangeActiveStackItem(() => {
          void this.refresh();
        }),
      );
    }

    this.disposables.push(
      vscode.debug.onDidStartDebugSession(() => void this.refresh()),
      vscode.debug.onDidTerminateDebugSession(() => this.emit(null)),
      vscode.debug.onDidChangeActiveDebugSession(() => void this.refresh()),
    );

    // Kick once in case a session is already active.
    void this.refresh();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emit(null);
  }

  isActive(): boolean {
    return this.active;
  }

  onRuntime(listener: RuntimeListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private emit(frame: RuntimeFrame | null): void {
    for (const l of this.listeners) {
      try {
        l(frame);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private async refresh(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      this.emit(null);
      return;
    }
    const myToken = ++this.fetchTokenSeq;
    try {
      const frame = await this.fetchTopFrame(session);
      if (myToken !== this.fetchTokenSeq) return; // superseded
      this.emit(frame);
    } catch {
      if (myToken !== this.fetchTokenSeq) return;
      this.emit(null);
    }
  }

  private async fetchTopFrame(session: vscode.DebugSession): Promise<RuntimeFrame | null> {
    // Determine the active stack item if available.
    const anyDebug = vscode.debug as unknown as { activeStackItem?: unknown };
    const stackItem = anyDebug.activeStackItem as
      | { threadId?: number; frameId?: number; session?: vscode.DebugSession }
      | undefined;

    let threadId: number | undefined = stackItem?.threadId;
    let frameId: number | undefined = stackItem?.frameId;

    if (threadId === undefined) {
      const threadsResp = await safeRequest<{ threads: { id: number; name: string }[] }>(
        session,
        "threads",
        {},
      );
      const firstThread = threadsResp?.threads?.[0];
      if (!firstThread) return null;
      threadId = firstThread.id;
    }

    if (frameId === undefined) {
      const stackResp = await safeRequest<{
        stackFrames: { id: number; name: string; line: number; column: number; source?: { path?: string } }[];
      }>(session, "stackTrace", { threadId, startFrame: 0, levels: 20 });
      const top = stackResp?.stackFrames?.[0];
      if (!top) return null;
      frameId = top.id;
      const callStack = (stackResp?.stackFrames ?? []).map((sf) => ({
        name: sf.name,
        file: sf.source?.path,
        line: sf.line,
      }));
      const variables = await this.fetchVariables(session, frameId);
      return {
        frameId,
        name: top.name,
        source: top.source?.path
          ? { file: top.source.path, line: top.line, column: top.column }
          : undefined,
        callStack,
        variables,
        threadId,
        sessionId: session.id,
      };
    }

    // We have a specific frameId: look it up in the stack trace.
    const stackResp = await safeRequest<{
      stackFrames: { id: number; name: string; line: number; column: number; source?: { path?: string } }[];
    }>(session, "stackTrace", { threadId, startFrame: 0, levels: 20 });
    const frames = stackResp?.stackFrames ?? [];
    const target = frames.find((f) => f.id === frameId) ?? frames[0];
    if (!target) return null;
    const callStack = frames.map((sf) => ({
      name: sf.name,
      file: sf.source?.path,
      line: sf.line,
    }));
    const variables = await this.fetchVariables(session, target.id);
    return {
      frameId: target.id,
      name: target.name,
      source: target.source?.path
        ? { file: target.source.path, line: target.line, column: target.column }
        : undefined,
      callStack,
      variables,
      threadId,
      sessionId: session.id,
    };
  }

  private async fetchVariables(
    session: vscode.DebugSession,
    frameId: number,
  ): Promise<RuntimeFrame["variables"]> {
    const scopesResp = await safeRequest<{
      scopes: { name: string; variablesReference: number; expensive?: boolean }[];
    }>(session, "scopes", { frameId });
    if (!scopesResp || !scopesResp.scopes) return [];

    const out: RuntimeFrame["variables"] = [];
    for (const scope of scopesResp.scopes) {
      if (scope.expensive) continue;
      if (scope.variablesReference <= 0) continue;
      const varsResp = await safeRequest<{
        variables: { name: string; value: string; type?: string }[];
      }>(session, "variables", { variablesReference: scope.variablesReference });
      if (!varsResp || !varsResp.variables) continue;
      for (const v of varsResp.variables.slice(0, MAX_VARS_PER_SCOPE)) {
        out.push({
          name: v.name,
          type: v.type,
          value: truncate(v.value, MAX_VALUE_LEN),
          scope: scope.name,
        });
      }
    }
    return out;
  }
}

async function safeRequest<T>(
  session: vscode.DebugSession,
  command: string,
  args: unknown,
): Promise<T | undefined> {
  try {
    return (await session.customRequest(command, args)) as T;
  } catch {
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "..." : s;
}
