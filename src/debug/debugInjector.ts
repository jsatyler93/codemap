import * as vscode from "vscode";
import { RuntimeFrame } from "../live/debugSync";
import { DebugProbe, ProbeResult } from "./debugProbeTypes";
import { parseProbeResult } from "./probeSchemas";

const PYTHON_BANNED_PATTERNS = [
  /\bimport\s+os\b/,
  /\bimport\s+subprocess\b/,
  /\bopen\s*\(/,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\b__import__\s*\(/,
  /\bsocket\b/,
  /\bprint\s*\(/,
];

const JS_BANNED_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bprocess\s*\.\s*(exit|kill|env)\b/,
  /\b(child_process|fs|net|http|https|dgram|tls|cluster)\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  // Statement-only constructs are not legal in a single-expression evaluate.
  /(^|[^A-Za-z0-9_$])(let|const|var|function|class|return|throw|while|for|if|switch)\s/,
  /;/,
];

export async function injectProbe(
  probe: DebugProbe,
  runtimeFrame: RuntimeFrame,
  session: vscode.DebugSession,
  hitCount: number,
): Promise<ProbeResult> {
  if (probe.language === "javascript") {
    return injectJavaScriptProbe(probe, runtimeFrame, session, hitCount);
  }
  if (probe.language === "idl") {
    return injectIdlProbe(probe, runtimeFrame, session, hitCount);
  }
  return injectPythonProbe(probe, runtimeFrame, session, hitCount);
}

async function injectPythonProbe(
  probe: DebugProbe,
  runtimeFrame: RuntimeFrame,
  session: vscode.DebugSession,
  hitCount: number,
): Promise<ProbeResult> {
  await validatePythonSnippet(
    probe.snippet,
    runtimeFrame.variables.map((variable) => variable.name),
    session,
    runtimeFrame.frameId,
  );
  const response = await session.customRequest("evaluate", {
    expression: wrapPythonSnippet(probe.snippet),
    frameId: runtimeFrame.frameId,
    context: "repl",
  });
  return parseResult(probe, typeof response?.result === "string" ? response.result : String(response?.result ?? ""), hitCount);
}

async function injectJavaScriptProbe(
  probe: DebugProbe,
  runtimeFrame: RuntimeFrame,
  session: vscode.DebugSession,
  hitCount: number,
): Promise<ProbeResult> {
  validateJavaScriptSnippet(
    probe.snippet,
    runtimeFrame.variables.map((variable) => variable.name),
  );
  const response = await session.customRequest("evaluate", {
    expression: wrapJavaScriptSnippet(probe.snippet),
    frameId: runtimeFrame.frameId,
    context: "repl",
  });
  return parseResult(probe, typeof response?.result === "string" ? response.result : String(response?.result ?? ""), hitCount);
}

async function injectIdlProbe(
  probe: DebugProbe,
  runtimeFrame: RuntimeFrame,
  session: vscode.DebugSession,
  hitCount: number,
): Promise<ProbeResult> {
  // IDL DAP support is best-effort: evaluate the snippet directly and return the
  // raw textual result without JSON wrapping.
  const response = await session.customRequest("evaluate", {
    expression: probe.snippet,
    frameId: runtimeFrame.frameId,
    context: "repl",
  });
  const raw = typeof response?.result === "string" ? response.result : String(response?.result ?? "");
  return parseProbeResult({
    probeId: probe.id,
    nodeId: probe.nodeId,
    hitCount,
    timestamp: Date.now(),
    data: raw,
  });
}

async function validatePythonSnippet(
  snippet: string,
  liveVariableNames: string[],
  session: vscode.DebugSession,
  frameId: number,
): Promise<void> {
  for (const pattern of PYTHON_BANNED_PATTERNS) {
    if (pattern.test(snippet)) {
      throw new Error(`Probe snippet rejected by safety filter: ${pattern}`);
    }
  }
  for (const variableName of liveVariableNames) {
    const assignmentPattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(variableName)}\\s*=`, "m");
    if (assignmentPattern.test(snippet)) {
      throw new Error(`Probe snippet attempts to assign to live variable '${variableName}'.`);
    }
  }
  await validateSnippetWithAst(snippet, session, frameId);
}

function validateJavaScriptSnippet(snippet: string, liveVariableNames: string[]): void {
  for (const pattern of JS_BANNED_PATTERNS) {
    if (pattern.test(snippet)) {
      throw new Error(`Probe snippet rejected by safety filter: ${pattern}`);
    }
  }
  for (const variableName of liveVariableNames) {
    // Reject `name =` assignments but allow `name ==`, `name ===`, `name =>`.
    const assignmentPattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(variableName)}\\s*=(?![=>])`, "m");
    if (assignmentPattern.test(snippet)) {
      throw new Error(`Probe snippet attempts to assign to live variable '${variableName}'.`);
    }
  }
}

async function validateSnippetWithAst(snippet: string, session: vscode.DebugSession, frameId: number): Promise<void> {
  const escaped = snippet.replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'");
  const expr = `(__import__('ast').parse('''${escaped}''', mode='exec'), 'ok')[1]`;
  try {
    const response = await session.customRequest("evaluate", {
      expression: expr,
      frameId,
      context: "repl",
    });
    const result = String(response?.result ?? "");
    if (!result.includes("ok")) {
      throw new Error(`AST validation failed: ${result}`);
    }
  } catch (error) {
    throw new Error(`Probe snippet AST parse failed: ${(error as Error).message}`);
  }
}

function wrapPythonSnippet(snippet: string): string {
  const lines = snippet.trim().split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length <= 1) {
    return `__import__('json').dumps(${lines[0] || "None"})`;
  }
  const prefix = lines.slice(0, -1).join("\n");
  const lastExpression = lines[lines.length - 1];
  const block = `${prefix}\n__result__ = (${lastExpression})`;
  const escaped = block.replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'");
  return `(lambda _env={}: __import__('json').dumps((exec(compile('''${escaped}''', '<probe>', 'exec'), _env, _env), _env.get('__result__'))[1]))()`;
}

function wrapJavaScriptSnippet(snippet: string): string {
  // Single-expression contract: wrap with JSON.stringify so the DAP returns a JSON string.
  return `JSON.stringify((${snippet.trim()}))`;
}

function parseResult(probe: DebugProbe, raw: string, hitCount: number): ProbeResult {
  const cleaned = raw.replace(/^['\"]|['\"]$/g, "");
  try {
    return parseProbeResult({
      probeId: probe.id,
      nodeId: probe.nodeId,
      hitCount,
      timestamp: Date.now(),
      data: JSON.parse(cleaned),
    });
  } catch {
    return parseProbeResult({
      probeId: probe.id,
      nodeId: probe.nodeId,
      hitCount,
      timestamp: Date.now(),
      data: null,
      error: `Parse failed: ${raw.slice(0, 240)}`,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}