import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

import { GraphDocument, GraphEdge, GraphNode, NodeKind } from "../../python/model/graphTypes";

interface BuildResult {
  fallthrough: string | null;
}

interface FunctionCandidate {
  node: ts.FunctionLikeDeclaration;
  name: string;
  startLine: number;
  endLine: number;
}

export function buildJavaScriptFlowchartFor(file: string, line: number): GraphDocument {
  const text = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const target = findTargetFunction(sourceFile, line);
  if (!target) {
    throw new Error("No JavaScript/TypeScript function found at the current cursor line.");
  }

  const builder = new JsFlowBuilder(file, sourceFile);
  return builder.build(target);
}

class JsFlowBuilder {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private counter = 0;

  constructor(
    private readonly filePath: string,
    private readonly sourceFile: ts.SourceFile,
  ) {}

  build(target: FunctionCandidate): GraphDocument {
    const entry = this.addNode("entry", target.name, target.startLine, {
      displayLines: [target.name],
    });

    const bodyStatements = functionBodyStatements(target.node);
    const result = this.buildBlock(bodyStatements, entry);
    if (result.fallthrough) {
      const implicit = this.addNode("return", "implicit return", target.endLine);
      this.addEdge(result.fallthrough, implicit);
    }

    return {
      graphType: "flowchart",
      title: `${target.name}()`,
      subtitle: `${this.filePath}:${target.startLine}`,
      nodes: this.nodes,
      edges: this.edges,
      rootNodeIds: [entry],
      metadata: {
        function: target.name,
        language: "javascript",
      },
    };
  }

  private buildBlock(statements: ts.Statement[], prev: string | null): BuildResult {
    let last = prev;
    for (const stmt of statements) {
      if (ts.isIfStatement(stmt)) {
        const branch = this.buildIf(stmt, last);
        last = branch.fallthrough;
        if (!last) return { fallthrough: null };
        continue;
      }

      if (isLoopStatement(stmt)) {
        const loop = this.buildLoop(stmt, last);
        last = loop.fallthrough;
        if (!last) return { fallthrough: null };
        continue;
      }

      if (ts.isReturnStatement(stmt)) {
        const labelExpr = stmt.expression ? ` ${shortText(stmt.expression, this.sourceFile)}` : "";
        const ret = this.addNode("return", `return${labelExpr}`, lineOf(stmt, this.sourceFile));
        if (last) this.addEdge(last, ret);
        return { fallthrough: null };
      }

      if (ts.isThrowStatement(stmt)) {
        const errExpr = stmt.expression ? ` ${shortText(stmt.expression, this.sourceFile)}` : "";
        const err = this.addNode("error", `throw${errExpr}`, lineOf(stmt, this.sourceFile));
        if (last) this.addEdge(last, err);
        return { fallthrough: null };
      }

      if (ts.isBreakStatement(stmt)) {
        const br = this.addNode("break", "break", lineOf(stmt, this.sourceFile));
        if (last) this.addEdge(last, br);
        return { fallthrough: null };
      }

      if (ts.isContinueStatement(stmt)) {
        const cont = this.addNode("continue", "continue", lineOf(stmt, this.sourceFile));
        if (last) this.addEdge(last, cont);
        return { fallthrough: null };
      }

      const kind: NodeKind = isComputeStatement(stmt) ? "compute" : "process";
      const node = this.addNode(kind, shortText(stmt, this.sourceFile), lineOf(stmt, this.sourceFile));
      if (last) this.addEdge(last, node);
      last = node;
    }
    return { fallthrough: last };
  }

  private buildIf(stmt: ts.IfStatement, prev: string | null): BuildResult {
    const decision = this.addNode("decision", `if ${shortText(stmt.expression, this.sourceFile)}?`, lineOf(stmt, this.sourceFile));
    if (prev) this.addEdge(prev, decision);

    const thenStatements = statementToBlock(stmt.thenStatement);
    const thenResult = this.buildBlock(thenStatements, decision);
    this.relabelFirstEdge(decision, "yes");

    let elseResult: BuildResult = { fallthrough: decision };
    if (stmt.elseStatement) {
      if (ts.isIfStatement(stmt.elseStatement)) {
        elseResult = this.buildIf(stmt.elseStatement, decision);
      } else {
        elseResult = this.buildBlock(statementToBlock(stmt.elseStatement), decision);
      }
      this.relabelFirstEdge(decision, "no");
    }

    if (!thenResult.fallthrough && !elseResult.fallthrough) {
      return { fallthrough: null };
    }

    const join = this.addNode("process", "•", lineOf(stmt, this.sourceFile));
    if (thenResult.fallthrough) this.addEdge(thenResult.fallthrough, join);
    if (elseResult.fallthrough) {
      if (elseResult.fallthrough === decision) this.addEdge(decision, join, "no");
      else this.addEdge(elseResult.fallthrough, join);
    }
    return { fallthrough: join };
  }

  private buildLoop(stmt: ts.IterationStatement, prev: string | null): BuildResult {
    const loopLabel = loopLabelFor(stmt, this.sourceFile);
    const loop = this.addNode("loop", loopLabel, lineOf(stmt, this.sourceFile), {
      displayLines: splitLoopLabel(loopLabel),
    });
    if (prev) this.addEdge(prev, loop);

    const afterLoop = this.addNode("process", "after loop", endLineOf(stmt, this.sourceFile));
    const body = statementToBlock(stmt.statement);
    const bodyResult = this.buildBlock(body, loop);

    if (bodyResult.fallthrough) this.addEdge(bodyResult.fallthrough, loop, "repeat");
    this.addEdge(loop, afterLoop, "done");
    return { fallthrough: afterLoop };
  }

  private addNode(kind: NodeKind, label: string, line: number, metadata: Record<string, unknown> = {}): string {
    this.counter += 1;
    const id = `${kind}_${this.counter}`;
    this.nodes.push({
      id,
      kind,
      label,
      source: {
        file: this.filePath,
        line,
      },
      metadata,
    });
    return id;
  }

  private addEdge(from: string, to: string, label = ""): void {
    this.edges.push({
      id: `e_${from}_${to}_${this.edges.length}`,
      from,
      to,
      kind: "control_flow",
      label,
    });
  }

  private relabelFirstEdge(from: string, label: string): void {
    for (const edge of this.edges) {
      if (edge.from === from && !edge.label) {
        edge.label = label;
        return;
      }
    }
  }
}

function findTargetFunction(sourceFile: ts.SourceFile, line: number): FunctionCandidate | undefined {
  const candidates: FunctionCandidate[] = [];

  const visit = (node: ts.Node, currentClass?: string): void => {
    if (isFunctionLikeDeclaration(node)) {
      const startLine = lineOf(node, sourceFile);
      const endLine = endLineOf(node, sourceFile);
      if (line >= startLine && line <= endLine) {
        candidates.push({
          node,
          name: functionDisplayName(node, sourceFile, currentClass),
          startLine,
          endLine,
        });
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      ts.forEachChild(node, (child) => visit(child, node.name?.text));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, currentClass));
  };

  visit(sourceFile);

  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    const aSize = a.endLine - a.startLine;
    const bSize = b.endLine - b.startLine;
    return aSize - bSize;
  });
  return candidates[0];
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function functionDisplayName(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile, className?: string): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name) {
    const methodName = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
    return className ? `${className}.${methodName}` : methodName;
  }
  if (ts.isConstructorDeclaration(node)) return className ? `${className}.constructor` : "constructor";
  if (ts.isGetAccessorDeclaration(node) && node.name) {
    const n = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
    return className ? `${className}.get ${n}` : `get ${n}`;
  }
  if (ts.isSetAccessorDeclaration(node) && node.name) {
    const n = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
    return className ? `${className}.set ${n}` : `set ${n}`;
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  return "anonymous";
}

function functionBodyStatements(node: ts.FunctionLikeDeclaration): ts.Statement[] {
  if (!node.body) return [];
  if (ts.isBlock(node.body)) return node.body.statements.slice();
  // Arrow function with expression body.
  const ret = ts.factory.createReturnStatement(node.body);
  return [ret];
}

function statementToBlock(statement: ts.Statement): ts.Statement[] {
  if (ts.isBlock(statement)) return statement.statements.slice();
  return [statement];
}

function isLoopStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isForOfStatement(node)
    || ts.isForInStatement(node);
}

function loopLabelFor(node: ts.IterationStatement, sourceFile: ts.SourceFile): string {
  if (ts.isForStatement(node)) {
    const init = node.initializer ? shortText(node.initializer, sourceFile) : "";
    const cond = node.condition ? shortText(node.condition, sourceFile) : "";
    const inc = node.incrementor ? shortText(node.incrementor, sourceFile) : "";
    return `for (${init}; ${cond}; ${inc})`;
  }
  if (ts.isWhileStatement(node)) {
    return `while ${shortText(node.expression, sourceFile)}`;
  }
  if (ts.isDoStatement(node)) {
    return `do while ${shortText(node.expression, sourceFile)}`;
  }
  if (ts.isForOfStatement(node)) {
    return `for each ${shortText(node.initializer, sourceFile)} in ${shortText(node.expression, sourceFile)}`;
  }
  if (ts.isForInStatement(node)) {
    return `for each ${shortText(node.initializer, sourceFile)} in ${shortText(node.expression, sourceFile)}`;
  }
  return "loop";
}

function splitLoopLabel(label: string): string[] {
  if (label.length <= 22) return [label];
  const parts = label.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? `${current} ${part}` : part;
    if (candidate.length > 22 && current) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function shortText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  if (text.length <= 64) return text;
  return `${text.slice(0, 61)}...`;
}

function isComputeStatement(stmt: ts.Statement): boolean {
  if (ts.isExpressionStatement(stmt)) {
    return ts.isBinaryExpression(stmt.expression)
      || ts.isCallExpression(stmt.expression)
      || ts.isPrefixUnaryExpression(stmt.expression)
      || ts.isPostfixUnaryExpression(stmt.expression);
  }
  if (ts.isVariableStatement(stmt)) return true;
  return false;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts": return ts.ScriptKind.TS;
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    default: return ts.ScriptKind.JS;
  }
}
