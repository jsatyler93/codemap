import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

import { PyAnalysisResult, PyCallSite, PyImport, PySymbol } from "../../python/model/symbolTypes";

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

interface JsDecl {
  symbol: PySymbol;
  node: ts.Node;
  sourceFile: ts.SourceFile;
  moduleName: string;
  className?: string;
  imports: Map<string, string>;
}

interface ModuleIndex {
  functions: Map<string, string>;
  classes: Map<string, string>;
  methods: Map<string, Map<string, string>>;
}

export function indexJavaScriptWorkspace(files: string[], root: string): PyAnalysisResult {
  const symbols: Record<string, PySymbol> = {};
  const modules: Record<string, string> = {};
  const errors: { file: string; message: string }[] = [];
  const decls: JsDecl[] = [];
  const moduleIndexes = new Map<string, ModuleIndex>();

  const supportedFiles = files.filter((file) => JS_EXTENSIONS.has(path.extname(file).toLowerCase()));

  for (const filePath of supportedFiles) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      errors.push({ file: filePath, message: (err as Error).message });
      continue;
    }

    try {
      const sourceFile = ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(filePath),
      );

      const moduleName = toModuleName(filePath, root);
      const imports = buildImportAliasMap(sourceFile, moduleName);
      const moduleId = `${moduleName}:<module>`;
      const topLevel: string[] = [];
      const moduleImports = collectModuleImports(sourceFile, moduleName);
      const moduleSymbol: PySymbol = {
        id: moduleId,
        kind: "module",
        name: path.basename(filePath, path.extname(filePath)),
        qualifiedName: moduleName,
        module: moduleName,
        file: filePath,
        source: sourceRefFromNode(sourceFile, sourceFile),
        calls: [],
        topLevel,
        imports: moduleImports,
      };
      symbols[moduleId] = moduleSymbol;
      modules[moduleName] = moduleId;

      const moduleIndex: ModuleIndex = {
        functions: new Map<string, string>(),
        classes: new Map<string, string>(),
        methods: new Map<string, Map<string, string>>(),
      };
      moduleIndexes.set(moduleName, moduleIndex);

      for (const stmt of sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
          const sym = createFunctionSymbol(stmt.name.text, stmt, moduleName, filePath, undefined);
          symbols[sym.id] = sym;
          topLevel.push(sym.id);
          decls.push({ symbol: sym, node: stmt, sourceFile, moduleName, imports });
          moduleIndex.functions.set(sym.name, sym.id);
          continue;
        }

        if (ts.isClassDeclaration(stmt) && stmt.name) {
          const classSym = createClassSymbol(stmt.name.text, stmt, moduleName, filePath);
          const members: string[] = [];
          symbols[classSym.id] = classSym;
          topLevel.push(classSym.id);
          moduleIndex.classes.set(classSym.name, classSym.id);

          const methodMap = new Map<string, string>();
          for (const member of stmt.members) {
            const methodName = classMemberName(member);
            if (!methodName) continue;
            if (!isCallableClassMember(member)) continue;
            const methodSym = createMethodSymbol(methodName, member, moduleName, filePath, classSym.name);
            symbols[methodSym.id] = methodSym;
            members.push(methodSym.id);
            methodMap.set(methodName, methodSym.id);
            decls.push({
              symbol: methodSym,
              node: member,
              sourceFile,
              moduleName,
              className: classSym.name,
              imports,
            });
          }
          classSym.members = members;
          moduleIndex.methods.set(classSym.name, methodMap);
          continue;
        }

        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
            if (!isFunctionLikeExpression(decl.initializer)) continue;
            const sym = createFunctionSymbol(decl.name.text, decl.initializer, moduleName, filePath, undefined);
            symbols[sym.id] = sym;
            topLevel.push(sym.id);
            decls.push({ symbol: sym, node: decl.initializer, sourceFile, moduleName, imports });
            moduleIndex.functions.set(sym.name, sym.id);
          }
        }
      }
    } catch (err) {
      errors.push({ file: filePath, message: (err as Error).message });
    }
  }

  const allSymbols = Object.values(symbols);
  const byName = buildGlobalNameIndex(allSymbols);

  let totalCalls = 0;
  let resolvedCalls = 0;
  let likelyCalls = 0;
  let unresolvedCalls = 0;

  for (const decl of decls) {
    const calls = collectCallsForDeclaration(decl, moduleIndexes, byName);
    decl.symbol.calls = calls;
    for (const call of calls) {
      totalCalls += 1;
      if (call.resolution === "resolved") resolvedCalls += 1;
      else if (call.resolution === "likely") likelyCalls += 1;
      else unresolvedCalls += 1;
    }
  }

  const functionCount = allSymbols.filter((s) => s.kind === "function" || s.kind === "method").length;
  const classCount = allSymbols.filter((s) => s.kind === "class").length;

  return {
    symbols,
    modules,
    errors,
    summary: {
      totalFiles: supportedFiles.length,
      totalFunctions: functionCount,
      totalClasses: classCount,
      totalTypeSlots: 0,
      typedSlots: 0,
      typeCoveragePct: 0,
      jediEnabled: false,
      jediResolved: 0,
      callResolution: {
        total: totalCalls,
        resolved: resolvedCalls,
        likely: likelyCalls,
        unresolved: unresolvedCalls,
        builtin: 0,
        outOfScope: 0,
        jedi: 0,
      },
    },
  };
}

function collectCallsForDeclaration(
  decl: JsDecl,
  moduleIndexes: Map<string, ModuleIndex>,
  byName: Map<string, string[]>,
): PyCallSite[] {
  const out: PyCallSite[] = [];
  const moduleIndex = moduleIndexes.get(decl.moduleName);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = resolveCall(node.expression, decl, moduleIndex, moduleIndexes, byName);
      out.push({
        text: node.expression.getText(decl.sourceFile),
        line: lineFromPos(decl.sourceFile, node.expression.getStart(decl.sourceFile)),
        column: columnFromPos(decl.sourceFile, node.expression.getStart(decl.sourceFile)),
        resolvedTo: call.resolvedTo,
        resolution: call.resolution,
        resolutionSource: call.source,
        confidence: call.confidence,
        externalTarget: call.externalTarget,
      });
    }
    ts.forEachChild(node, visit);
  };

  const bodyNode = callableBodyNode(decl.node);
  if (bodyNode) {
    ts.forEachChild(bodyNode, visit);
  }

  return out;
}

function resolveCall(
  expr: ts.LeftHandSideExpression,
  decl: JsDecl,
  moduleIndex: ModuleIndex | undefined,
  moduleIndexes: Map<string, ModuleIndex>,
  byName: Map<string, string[]>,
): {
  resolvedTo?: string;
  resolution: "resolved" | "likely" | "unresolved";
  source: string;
  confidence?: "high" | "medium" | "low";
  externalTarget?: string;
} {
  if (ts.isIdentifier(expr)) {
    const name = expr.text;

    if (decl.className && moduleIndex) {
      const classMethods = moduleIndex.methods.get(decl.className);
      const sameClass = classMethods?.get(name);
      if (sameClass) {
        return {
          resolvedTo: sameClass,
          resolution: "resolved",
          source: "same-class-method",
          confidence: "high",
        };
      }
    }

    const localFn = moduleIndex?.functions.get(name);
    if (localFn) {
      return {
        resolvedTo: localFn,
        resolution: "resolved",
        source: "same-module-function",
        confidence: "high",
      };
    }

    const localClass = moduleIndex?.classes.get(name);
    if (localClass) {
      return {
        resolvedTo: localClass,
        resolution: "likely",
        source: "same-module-class",
        confidence: "medium",
      };
    }

    const candidates = byName.get(name) ?? [];
    if (candidates.length === 1) {
      return {
        resolvedTo: candidates[0],
        resolution: "likely",
        source: "global-unique-name",
        confidence: "medium",
      };
    }

    return {
      resolution: "unresolved",
      source: "unresolved",
      confidence: "low",
      externalTarget: name,
    };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const lhs = expr.expression;
    const rhsName = expr.name.text;

    if (lhs.kind === ts.SyntaxKind.ThisKeyword && decl.className && moduleIndex) {
      const classMethods = moduleIndex.methods.get(decl.className);
      const sameClass = classMethods?.get(rhsName);
      if (sameClass) {
        return {
          resolvedTo: sameClass,
          resolution: "resolved",
          source: "this-method",
          confidence: "high",
        };
      }
    }

    if (ts.isIdentifier(lhs)) {
      const lhsText = lhs.text;

      if (moduleIndex) {
        const method = moduleIndex.methods.get(lhsText)?.get(rhsName);
        if (method) {
          return {
            resolvedTo: method,
            resolution: "resolved",
            source: "class-member",
            confidence: "high",
          };
        }
      }

      const importedModule = decl.imports.get(lhsText);
      if (importedModule) {
        const importedIndex = moduleIndexes.get(importedModule);
        const importedMethod = importedIndex?.methods.get(rhsName)?.get(rhsName);
        const importedFn = importedIndex?.functions.get(rhsName);
        const resolvedTo = importedFn ?? importedMethod;
        if (resolvedTo) {
          return {
            resolvedTo,
            resolution: "likely",
            source: "imported-module",
            confidence: "medium",
          };
        }
      }
    }

    return {
      resolution: "unresolved",
      source: "external-member",
      confidence: "low",
      externalTarget: expr.getText(decl.sourceFile),
    };
  }

  return {
    resolution: "unresolved",
    source: "unresolved-expression",
    confidence: "low",
    externalTarget: expr.getText(decl.sourceFile),
  };
}

function createFunctionSymbol(
  name: string,
  node: ts.Node,
  moduleName: string,
  filePath: string,
  className: string | undefined,
): PySymbol {
  const qualifiedName = className ? `${moduleName}.${className}.${name}` : `${moduleName}.${name}`;
  return {
    id: `${moduleName}:${className ? `${className}.` : ""}${name}`,
    kind: className ? "method" : "function",
    name,
    qualifiedName,
    module: moduleName,
    file: filePath,
    source: sourceRefFromNode(node.getSourceFile(), node),
    calls: [],
    className,
  };
}

function createMethodSymbol(
  name: string,
  node: ts.Node,
  moduleName: string,
  filePath: string,
  className: string,
): PySymbol {
  return createFunctionSymbol(name, node, moduleName, filePath, className);
}

function createClassSymbol(
  name: string,
  node: ts.ClassDeclaration,
  moduleName: string,
  filePath: string,
): PySymbol {
  return {
    id: `${moduleName}:${name}`,
    kind: "class",
    name,
    qualifiedName: `${moduleName}.${name}`,
    module: moduleName,
    file: filePath,
    source: sourceRefFromNode(node.getSourceFile(), node),
    calls: [],
    bases: node.heritageClauses?.flatMap((h) => h.types.map((t) => t.expression.getText(node.getSourceFile()))) ?? [],
  };
}

function buildImportAliasMap(sourceFile: ts.SourceFile, moduleName: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const target = resolveImportModule(moduleName, stmt.moduleSpecifier.text);
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      imports.set(clause.name.text, target);
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, target);
    }
  }
  return imports;
}

function collectModuleImports(sourceFile: ts.SourceFile, moduleName: string): PyImport[] {
  const out: PyImport[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const text = stmt.moduleSpecifier.text;
    const isRelative = text.startsWith(".");
    const resolvedModule = isRelative ? resolveImportModule(moduleName, text) : text;
    const line = lineFromPos(sourceFile, stmt.getStart(sourceFile));
    const clause = stmt.importClause;
    if (!clause) {
      out.push({ module: resolvedModule, names: [], line, isFrom: false, level: isRelative ? relativeDepth(text) : 0 });
      continue;
    }
    const names: { name: string; asName?: string }[] = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        names.push({ name: el.propertyName?.text ?? el.name.text, asName: el.propertyName ? el.name.text : undefined });
      }
    }
    out.push({
      module: resolvedModule,
      asName: clause.name?.text,
      names,
      line,
      isFrom: true,
      level: isRelative ? relativeDepth(text) : 0,
    });
  }
  return out;
}

function sourceRefFromNode(sourceFile: ts.SourceFile, node: ts.Node): PySymbol["source"] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: sourceFile.fileName,
    line: start.line + 1,
    column: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
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

function toModuleName(filePath: string, root: string): string {
  const normalizedRoot = root || path.dirname(filePath);
  const rel = path.relative(normalizedRoot, filePath) || path.basename(filePath);
  const noExt = rel.replace(/\.[^.]+$/, "");
  return noExt.split(/[\\/]+/).filter(Boolean).join(".");
}

function lineFromPos(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function columnFromPos(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).character;
}

function isCallableClassMember(member: ts.ClassElement): member is ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isMethodDeclaration(member)
    || ts.isConstructorDeclaration(member)
    || ts.isGetAccessorDeclaration(member)
    || ts.isSetAccessorDeclaration(member);
}

function classMemberName(member: ts.ClassElement): string | undefined {
  if (!("name" in member) || !member.name) {
    if (ts.isConstructorDeclaration(member)) return "constructor";
    return undefined;
  }
  if (ts.isIdentifier(member.name)) return member.name.text;
  if (ts.isStringLiteral(member.name)) return member.name.text;
  return undefined;
}

function isFunctionLikeExpression(node: ts.Node): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function callableBodyNode(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.body;
  }
  return undefined;
}

function buildGlobalNameIndex(symbols: PySymbol[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const sym of symbols) {
    if (sym.kind === "module") continue;
    const arr = out.get(sym.name) ?? [];
    arr.push(sym.id);
    out.set(sym.name, arr);
  }
  return out;
}

function resolveImportModule(moduleName: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const baseParts = moduleName.split(".");
  let idx = 0;
  while (idx < specifier.length && specifier[idx] === ".") idx += 1;
  const up = Math.max(0, idx - 1);
  const trimmedBase = baseParts.slice(0, Math.max(0, baseParts.length - up));
  const remainder = specifier.slice(idx).replace(/^\/+/, "").replace(/\//g, ".");
  if (!remainder) return trimmedBase.join(".");
  return [...trimmedBase, ...remainder.split(".").filter(Boolean)].join(".");
}

function relativeDepth(specifier: string): number {
  let count = 0;
  for (const ch of specifier) {
    if (ch === ".") count += 1;
    else break;
  }
  return count;
}
