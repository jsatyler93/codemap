import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

import { GraphDocument, GraphEdge, GraphNode, NodeKind } from "../../python/model/graphTypes";

interface BuildResult {
  fallthrough: string | null;
  breaks: string[];
  continues: string[];
}

interface GroupInfo {
  id: string;
  kind: string;
  label: string;
  line: number;
  parentGroupId: string | null;
  nodeIds: string[];
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
  private groups: GroupInfo[] = [];
  private groupStack: string[] = [];
  private counter = 0;
  private currentFunctionReturnType: string | undefined;

  constructor(
    private readonly filePath: string,
    private readonly sourceFile: ts.SourceFile,
  ) {}

  build(target: FunctionCandidate): GraphDocument {
    const params = extractFunctionParams(target.node, this.sourceFile);
    const returnType = extractFunctionReturnType(target.node, this.sourceFile);
    this.currentFunctionReturnType = returnType;
    const entry = this.addNode("entry", target.name, target.startLine, {
      displayLines: [target.name],
      ...(params.length ? { params } : {}),
      ...(returnType ? { returnType } : {}),
    });

    const bodyGroup = this.beginGroup("function_body", `${target.name} body`, target.startLine);
    const bodyStart = this.nodes.length;
    const bodyStatements = functionBodyStatements(target.node);
    const result = this.buildBlock(bodyStatements, entry);
    if (result.fallthrough) {
      const implicit = this.addNode("return", "implicit return", target.endLine, {
        displayLines: ["implicit return"],
      });
      this.addEdge(result.fallthrough, implicit);
    }
    this.endGroup(bodyGroup, bodyStart);

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
        groups: this.groups,
      },
    };
  }

  private buildBlock(statements: ts.Statement[], prev: string | null): BuildResult {
    let last = prev;
    let run: ts.Statement[] = [];
    const breaks: string[] = [];
    const continues: string[] = [];

    const flushRun = (): void => {
      if (!run.length) return;
      const label = this.summarizeRun(run);
      const kind: NodeKind = run.some(isComputeStatement) ? "compute" : "process";
      const displayLines = run.slice(0, 3).map((s) => shortText(s, this.sourceFile));
      if (run.length > 3) displayLines.push(`... +${run.length - 3} more`);
      const typeBits = summarizeRunTypeBits(run, this.sourceFile);
      const node = this.addNode(kind, label, lineOf(run[0], this.sourceFile), {
        displayLines,
        ...(typeBits.length ? { typeLabel: typeBits.join("; ") } : {}),
      });
      if (last) this.addEdge(last, node);
      last = node;
      run = [];
    };

    for (const stmt of statements) {
      if (ts.isIfStatement(stmt)) {
        flushRun();
        const branch = this.buildIf(stmt, last);
        last = branch.fallthrough;
        breaks.push(...branch.breaks);
        continues.push(...branch.continues);
        if (!last) return { fallthrough: null, breaks, continues };
        continue;
      }

      if (isLoopStatement(stmt)) {
        flushRun();
        const loop = this.buildLoop(stmt, last);
        last = loop.fallthrough;
        breaks.push(...loop.breaks);
        continues.push(...loop.continues);
        if (!last) return { fallthrough: null, breaks, continues };
        continue;
      }

      if (ts.isSwitchStatement(stmt)) {
        flushRun();
        const sw = this.buildSwitch(stmt, last);
        last = sw.fallthrough;
        breaks.push(...sw.breaks);
        continues.push(...sw.continues);
        if (!last) return { fallthrough: null, breaks, continues };
        continue;
      }

      if (ts.isTryStatement(stmt)) {
        flushRun();
        const tryResult = this.buildTry(stmt, last);
        last = tryResult.fallthrough;
        breaks.push(...tryResult.breaks);
        continues.push(...tryResult.continues);
        if (!last) return { fallthrough: null, breaks, continues };
        continue;
      }

      if (ts.isReturnStatement(stmt)) {
        flushRun();
        const labelExpr = stmt.expression ? ` ${shortText(stmt.expression, this.sourceFile)}` : "";
        const returnType = inferTsExprType(stmt.expression, this.sourceFile) || this.currentFunctionReturnType;
        const ret = this.addNode("return", `return${labelExpr}`, lineOf(stmt, this.sourceFile), {
          displayLines: [`return${labelExpr}`],
          ...(returnType ? { returnType, typeLabel: `returns ${returnType}` } : {}),
        });
        if (last) this.addEdge(last, ret);
        return { fallthrough: null, breaks, continues };
      }

      if (ts.isThrowStatement(stmt)) {
        flushRun();
        const errExpr = stmt.expression ? ` ${shortText(stmt.expression, this.sourceFile)}` : "";
        const err = this.addNode("error", `throw${errExpr}`, lineOf(stmt, this.sourceFile), {
          displayLines: [`throw${errExpr}`],
        });
        if (last) this.addEdge(last, err);
        return { fallthrough: null, breaks, continues };
      }

      if (ts.isBreakStatement(stmt)) {
        flushRun();
        const br = this.addNode("break", "break", lineOf(stmt, this.sourceFile), { displayLines: ["break"] });
        if (last) this.addEdge(last, br);
        breaks.push(br);
        return { fallthrough: null, breaks, continues };
      }

      if (ts.isContinueStatement(stmt)) {
        flushRun();
        const cont = this.addNode("continue", "continue", lineOf(stmt, this.sourceFile), { displayLines: ["continue"] });
        if (last) this.addEdge(last, cont);
        continues.push(cont);
        return { fallthrough: null, breaks, continues };
      }

      run.push(stmt);
    }
    flushRun();
    return { fallthrough: last, breaks, continues };
  }

  private buildIf(stmt: ts.IfStatement, prev: string | null): BuildResult {
    const group = this.beginGroup("branch", `if ${shortText(stmt.expression, this.sourceFile)}`, lineOf(stmt, this.sourceFile));
    const startIndex = this.nodes.length;

    const decision = this.addNode("decision", `if ${shortText(stmt.expression, this.sourceFile)}?`, lineOf(stmt, this.sourceFile), {
      displayLines: [`if ${shortText(stmt.expression, this.sourceFile)}?`],
    });
    if (prev) this.addEdge(prev, decision);

    const thenStatements = statementToBlock(stmt.thenStatement);
    const thenResult = this.buildBlock(thenStatements, decision);
    this.relabelFirstEdge(decision, "yes");

    let elseResult: BuildResult = { fallthrough: decision, breaks: [], continues: [] };
    if (stmt.elseStatement) {
      if (ts.isIfStatement(stmt.elseStatement)) {
        elseResult = this.buildIf(stmt.elseStatement, decision);
      } else {
        elseResult = this.buildBlock(statementToBlock(stmt.elseStatement), decision);
      }
      this.relabelFirstEdge(decision, "no");
    }

    const breaks = [...thenResult.breaks, ...elseResult.breaks];
    const continues = [...thenResult.continues, ...elseResult.continues];

    if (!thenResult.fallthrough && !elseResult.fallthrough) {
      this.endGroup(group, startIndex);
      return { fallthrough: null, breaks, continues };
    }

    const join = this.addNode("process", "•", lineOf(stmt, this.sourceFile));
    if (thenResult.fallthrough) this.addEdge(thenResult.fallthrough, join);
    if (elseResult.fallthrough) {
      if (elseResult.fallthrough === decision) this.addEdge(decision, join, "no");
      else this.addEdge(elseResult.fallthrough, join);
    }
    this.endGroup(group, startIndex);
    return { fallthrough: join, breaks, continues };
  }

  private buildLoop(stmt: ts.IterationStatement, prev: string | null): BuildResult {
    const loopLabel = loopLabelFor(stmt, this.sourceFile);
    const group = this.beginGroup("loop", loopLabel, lineOf(stmt, this.sourceFile));
    const startIndex = this.nodes.length;
    const loopTypeBits = inferLoopTypeBits(stmt, this.sourceFile);

    const loop = this.addNode("loop", loopLabel, lineOf(stmt, this.sourceFile), {
      displayLines: splitLoopLabel(loopLabel),
      ...(loopTypeBits.length ? { typeLabel: loopTypeBits.join("; ") } : {}),
    });
    if (prev) this.addEdge(prev, loop);

    const afterLoop = this.addNode("process", "after loop", endLineOf(stmt, this.sourceFile));
    const body = statementToBlock(stmt.statement);
    const bodyResult = this.buildBlock(body, loop);

    if (bodyResult.fallthrough) this.addEdge(bodyResult.fallthrough, loop, "repeat");
    for (const cont of bodyResult.continues) this.addEdge(cont, loop, "continue");
    for (const br of bodyResult.breaks) this.addEdge(br, afterLoop, "break");
    this.addEdge(loop, afterLoop, "done");
    this.endGroup(group, startIndex, [afterLoop]);
    return { fallthrough: afterLoop, breaks: [], continues: [] };
  }

  private buildSwitch(stmt: ts.SwitchStatement, prev: string | null): BuildResult {
    const exprText = shortText(stmt.expression, this.sourceFile);
    const group = this.beginGroup("branch", `switch ${exprText}`, lineOf(stmt, this.sourceFile));
    const startIndex = this.nodes.length;

    const decision = this.addNode("decision", `switch (${exprText})`, lineOf(stmt, this.sourceFile), {
      displayLines: [`switch (${exprText})`],
    });
    if (prev) this.addEdge(prev, decision);

    const afterSwitch = this.addNode("process", "after switch", endLineOf(stmt, this.sourceFile));
    const breaks: string[] = [];
    const continues: string[] = [];
    let prevCaseFallthrough: string | null = null;

    for (const clause of stmt.caseBlock.clauses) {
      const isDefault = ts.isDefaultClause(clause);
      const caseLabel = isDefault ? "default" : `case ${shortText((clause as ts.CaseClause).expression, this.sourceFile)}`;
      const caseNode = this.addNode("decision", caseLabel, lineOf(clause, this.sourceFile), {
        displayLines: [caseLabel + ":"],
      });
      this.addEdge(decision, caseNode, isDefault ? "default" : "");
      if (prevCaseFallthrough) this.addEdge(prevCaseFallthrough, caseNode, "fall-through");

      const clauseResult = this.buildBlock(clause.statements.slice(), caseNode);
      // Breaks inside a switch target the switch itself (go to afterSwitch)
      for (const br of clauseResult.breaks) this.addEdge(br, afterSwitch, "break");
      continues.push(...clauseResult.continues);

      if (clauseResult.fallthrough && clauseResult.breaks.length === 0) {
        prevCaseFallthrough = clauseResult.fallthrough;
      } else {
        prevCaseFallthrough = null;
      }
    }
    // Last case falls through to afterSwitch
    if (prevCaseFallthrough) this.addEdge(prevCaseFallthrough, afterSwitch);

    this.endGroup(group, startIndex, [afterSwitch]);
    return { fallthrough: afterSwitch, breaks: [], continues };
  }

  private buildTry(stmt: ts.TryStatement, prev: string | null): BuildResult {
    const guard = this.addNode("decision", "try", lineOf(stmt, this.sourceFile), {
      displayLines: ["try"],
    });
    if (prev) this.addEdge(prev, guard);

    const tryResult = this.buildBlock(stmt.tryBlock.statements.slice(), guard);
    const breaks: string[] = [...tryResult.breaks];
    const continues: string[] = [...tryResult.continues];
    const fallthroughs: { id: string; label: string }[] = [];
    if (tryResult.fallthrough) fallthroughs.push({ id: tryResult.fallthrough, label: "ok" });

    if (stmt.catchClause) {
      const paramText = stmt.catchClause.variableDeclaration
        ? shortText(stmt.catchClause.variableDeclaration.name, this.sourceFile)
        : "err";
      const catchNode = this.addNode("error", `catch (${paramText})`, lineOf(stmt.catchClause, this.sourceFile), {
        displayLines: [`catch (${paramText})`],
      });
      this.addEdge(guard, catchNode, "error");
      const catchResult = this.buildBlock(stmt.catchClause.block.statements.slice(), catchNode);
      breaks.push(...catchResult.breaks);
      continues.push(...catchResult.continues);
      if (catchResult.fallthrough) fallthroughs.push({ id: catchResult.fallthrough, label: "" });
    }

    if (!fallthroughs.length) return { fallthrough: null, breaks, continues };

    let last: string;
    if (fallthroughs.length === 1 && !stmt.finallyBlock) {
      last = fallthroughs[0].id;
    } else {
      const join = this.addNode("process", "•", lineOf(stmt, this.sourceFile));
      for (const ft of fallthroughs) this.addEdge(ft.id, join, ft.label);
      last = join;
    }

    if (stmt.finallyBlock) {
      const fin = this.addNode("process", "finally", lineOf(stmt.finallyBlock, this.sourceFile), {
        displayLines: ["finally"],
      });
      this.addEdge(last, fin);
      const finResult = this.buildBlock(stmt.finallyBlock.statements.slice(), fin);
      breaks.push(...finResult.breaks);
      continues.push(...finResult.continues);
      return { fallthrough: finResult.fallthrough, breaks, continues };
    }

    return { fallthrough: last, breaks, continues };
  }

  private beginGroup(kind: string, label: string, line: number): GroupInfo {
    const id = this.id("group");
    const group: GroupInfo = {
      id,
      kind,
      label,
      line,
      parentGroupId: this.groupStack.length ? this.groupStack[this.groupStack.length - 1] : null,
      nodeIds: [],
    };
    this.groupStack.push(id);
    return group;
  }

  private endGroup(group: GroupInfo, startIndex: number, excludeIds: string[] = []): void {
    if (this.groupStack.length && this.groupStack[this.groupStack.length - 1] === group.id) {
      this.groupStack.pop();
    }
    const exclude = new Set(excludeIds);
    group.nodeIds = this.nodes.slice(startIndex).map((n) => n.id).filter((id) => !exclude.has(id));
    if (group.nodeIds.length) this.groups.push(group);
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
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

  private summarizeRun(run: ts.Statement[]): string {
    const lines = run.slice(0, 3).map((s) => shortText(s, this.sourceFile));
    if (run.length > 3) lines.push(`... +${run.length - 3} more`);
    return lines.join("\n");
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

function extractFunctionParams(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): Array<{ name: string; type?: string }> {
  return node.parameters.map((param) => {
    const name = param.name.getText(sourceFile);
    const type = param.type ? compactTypeText(param.type.getText(sourceFile)) : undefined;
    return type ? { name, type } : { name };
  });
}

function extractFunctionReturnType(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): string | undefined {
  return node.type ? compactTypeText(node.type.getText(sourceFile)) : undefined;
}

function summarizeRunTypeBits(run: ts.Statement[], sourceFile: ts.SourceFile): string[] {
  const bits: string[] = [];
  const seen = new Set<string>();
  run.forEach((stmt) => {
    statementTypeBits(stmt, sourceFile).forEach((bit) => {
      if (!bit || seen.has(bit)) return;
      seen.add(bit);
      bits.push(bit);
    });
  });
  return bits.slice(0, 4);
}

function statementTypeBits(stmt: ts.Statement, sourceFile: ts.SourceFile): string[] {
  const bits: string[] = [];
  if (ts.isVariableStatement(stmt)) {
    stmt.declarationList.declarations.forEach((decl) => {
      const names = bindingNames(decl.name, sourceFile);
      const inferredType = decl.type
        ? compactTypeText(decl.type.getText(sourceFile))
        : inferTsExprType(decl.initializer, sourceFile);
      if (!inferredType) return;
      names.forEach((name) => bits.push(`${name}: ${inferredType}`));
    });
  }
  if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
    const op = stmt.expression.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken || isCompoundAssignmentOperator(op)) {
      const inferredType = inferTsExprType(stmt.expression.right, sourceFile);
      if (inferredType) bits.push(`${stmt.expression.left.getText(sourceFile)}: ${inferredType}`);
    }
  }
  return bits;
}

function inferLoopTypeBits(stmt: ts.IterationStatement, sourceFile: ts.SourceFile): string[] {
  if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) {
    const target = stmt.initializer.getText(sourceFile);
    const iterableType = inferTsExprType(stmt.expression, sourceFile);
    const itemType = iterableType ? iterableItemType(iterableType) : "";
    return itemType ? [`${target}: ${itemType}`] : [];
  }
  if (ts.isForStatement(stmt) && stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
    const bits: string[] = [];
    stmt.initializer.declarations.forEach((decl) => {
      const names = bindingNames(decl.name, sourceFile);
      const inferredType = decl.type
        ? compactTypeText(decl.type.getText(sourceFile))
        : inferTsExprType(decl.initializer, sourceFile) || "number";
      names.forEach((name) => bits.push(`${name}: ${inferredType}`));
    });
    return bits;
  }
  return [];
}

function inferTsExprType(expr: ts.Expression | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!expr) return undefined;
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return compactTypeText(expr.type.getText(sourceFile));
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) {
    return inferTsExprType(expr.expression, sourceFile);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) return "string";
  if (ts.isNumericLiteral(expr)) return "number";
  if (ts.isBigIntLiteral(expr)) return "bigint";
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(expr)) {
    if (!expr.elements.length) return "Array<any>";
    const elementTypes = expr.elements.map((element) => inferTsExprType(element as ts.Expression, sourceFile)).filter(Boolean);
    if (!elementTypes.length) return "array";
    const unique = Array.from(new Set(elementTypes));
    return unique.length === 1 ? `Array<${unique[0]}>` : `Array<${unique.join(" | ")}>`;
  }
  if (ts.isObjectLiteralExpression(expr)) return "object";
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return "function";
  if (ts.isNewExpression(expr)) return compactTypeText(expr.expression.getText(sourceFile));
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = inferTsExprType(expr.whenTrue, sourceFile);
    const whenFalse = inferTsExprType(expr.whenFalse, sourceFile);
    if (whenTrue && whenTrue === whenFalse) return whenTrue;
    if (whenTrue && whenFalse) return `${whenTrue} | ${whenFalse}`;
    return whenTrue || whenFalse;
  }
  if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) return "number";
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (isComparisonOperator(op) || isLogicalOperator(op)) return "boolean";
    if (isArithmeticOperator(op)) return "number";
    if (op === ts.SyntaxKind.EqualsToken) return inferTsExprType(expr.right, sourceFile);
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression.getText(sourceFile);
    if (/^(Number|parseInt|parseFloat|Math\.)/.test(callee)) return "number";
    if (/^(String|JSON\.stringify)$/.test(callee)) return "string";
    if (/^(Boolean)$/.test(callee)) return "boolean";
    if (/^(Array\.isArray|includes|startsWith|endsWith)$/.test(callee)) return "boolean";
    if (/^(JSON\.parse)$/.test(callee)) return "object";
    if (/^(Promise\.resolve)$/.test(callee)) return "Promise";
  }
  return undefined;
}

function iterableItemType(typeText: string): string {
  const compact = compactTypeText(typeText);
  const arrayMatch = compact.match(/^Array<(.+)>$/);
  if (arrayMatch) return arrayMatch[1];
  const suffixMatch = compact.match(/^(.+)\[\]$/);
  if (suffixMatch) return suffixMatch[1];
  if (compact === "string") return "string";
  if (compact === "array") return "any";
  return "";
}

function bindingNames(name: ts.BindingName, sourceFile: ts.SourceFile): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return [name.getText(sourceFile)];
}

function compactTypeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.GreaterThanToken
    || kind === ts.SyntaxKind.GreaterThanEqualsToken
    || kind === ts.SyntaxKind.LessThanToken
    || kind === ts.SyntaxKind.LessThanEqualsToken;
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken
    || kind === ts.SyntaxKind.BarBarToken
    || kind === ts.SyntaxKind.QuestionQuestionToken;
}

function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusToken
    || kind === ts.SyntaxKind.MinusToken
    || kind === ts.SyntaxKind.AsteriskToken
    || kind === ts.SyntaxKind.SlashToken
    || kind === ts.SyntaxKind.PercentToken
    || kind === ts.SyntaxKind.AsteriskAsteriskToken;
}

function isCompoundAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.PlusEqualsToken
    || kind === ts.SyntaxKind.MinusEqualsToken
    || kind === ts.SyntaxKind.AsteriskEqualsToken
    || kind === ts.SyntaxKind.SlashEqualsToken
    || kind === ts.SyntaxKind.PercentEqualsToken
    || kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
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
