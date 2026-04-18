import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

import { GraphDocument } from "../model/graphTypes";
import { PyAnalysisResult } from "../model/symbolTypes";

/** A resolved interpreter command: an executable plus any leading args (e.g. `py -3`). */
export interface InterpreterCommand {
  readonly exe: string;
  readonly baseArgs: readonly string[];
  readonly source: "setting" | "ms-python" | "probe";
}

let cached: InterpreterCommand | undefined;

/** Reset cached interpreter (e.g. when the config changes). */
export function resetInterpreterCache(): void {
  cached = undefined;
}

/** Discover a working Python interpreter. Cached after first success. */
export async function resolveInterpreter(): Promise<InterpreterCommand> {
  if (cached) {
    return cached;
  }

  const cfg = vscode.workspace
    .getConfiguration("codemap")
    .get<string>("pythonPath");
  if (cfg && cfg.trim().length > 0) {
    const cmd: InterpreterCommand = { exe: cfg.trim(), baseArgs: [], source: "setting" };
    if (await probe(cmd)) {
      cached = cmd;
      return cmd;
    }
    throw new Error(
      `CodeMap: configured 'codemap.pythonPath' is not runnable: ${cfg}`,
    );
  }

  // Try the Python extension's selected interpreter, if available.
  const fromMsPython = await msPythonInterpreter();
  if (fromMsPython) {
    const cmd: InterpreterCommand = { exe: fromMsPython, baseArgs: [], source: "ms-python" };
    if (await probe(cmd)) {
      cached = cmd;
      return cmd;
    }
  }

  // Probe likely candidates. On Windows, `py -3` is the launcher.
  const candidates: InterpreterCommand[] = process.platform === "win32"
    ? [
        { exe: "py", baseArgs: ["-3"], source: "probe" },
        { exe: "python", baseArgs: [], source: "probe" },
        { exe: "python3", baseArgs: [], source: "probe" },
      ]
    : [
        { exe: "python3", baseArgs: [], source: "probe" },
        { exe: "python", baseArgs: [], source: "probe" },
      ];
  for (const c of candidates) {
    if (await probe(c)) {
      cached = c;
      return c;
    }
  }

  throw new Error(
    "CodeMap: could not find a Python 3 interpreter. " +
      "Install Python 3.8+, or set 'codemap.pythonPath' in Settings, " +
      "or select an interpreter via the Python extension.",
  );
}

async function msPythonInterpreter(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension("ms-python.python");
  if (!ext) {
    return undefined;
  }
  try {
    if (!ext.isActive) {
      await ext.activate();
    }
    const api = ext.exports as {
      settings?: {
        getExecutionDetails?: (resource?: vscode.Uri) => { execCommand?: string[] };
      };
    };
    const details = api?.settings?.getExecutionDetails?.();
    const exec = details?.execCommand;
    if (exec && exec.length > 0) {
      return exec[0];
    }
  } catch {
    // Ignore and fall through to probing.
  }
  return undefined;
}

function probe(cmd: InterpreterCommand): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    try {
      const child = cp.spawn(cmd.exe, [...cmd.baseArgs, "--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

/** Run a python helper script located in the extension's `python/` folder. */
export async function runPythonHelper<T>(
  extensionPath: string,
  scriptName: string,
  request: unknown,
): Promise<T> {
  const interp = await resolveInterpreter();
  const script = path.join(extensionPath, "python", scriptName);
  return new Promise<T>((resolve, reject) => {
    const child = cp.spawn(interp.exe, [...interp.baseArgs, script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      reject(
        new Error(
          `CodeMap: failed to spawn '${interp.exe}' (${interp.source}): ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${scriptName} exited with code ${code} (interpreter: ${interp.exe} ${interp.baseArgs.join(" ")}): ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (e) {
        reject(
          new Error(
            `Could not parse JSON output of ${scriptName}: ${(e as Error).message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
      }
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export async function indexWorkspace(
  extensionPath: string,
  files: string[],
  root: string,
  useJedi: boolean = true,
): Promise<PyAnalysisResult> {
  return runPythonHelper<PyAnalysisResult>(extensionPath, "analyzer.py", {
    command: "index",
    files,
    root,
    useJedi,
  });
}

export async function buildFlowchartFor(
  extensionPath: string,
  file: string,
  line: number,
): Promise<GraphDocument> {
  return runPythonHelper<GraphDocument>(extensionPath, "flowchart.py", {
    file,
    line,
  });
}
