# CodeMap JavaScript Support — Call Graph & Flowchart Implementation Plan

## Goal

Add JavaScript (and TypeScript) support to CodeMap, producing the same two views that already work for Python:

1. **Call graph** (Level 1): which functions/methods call which. Same renderer as Python call graph.
2. **Flowchart** (Level 1 drill-down): control flow within a single function. Same renderer as Python flowchart.

Both produce standard `GraphDocument` output. No schema changes. No webview changes. Only new adapter scripts and host routing.

---

## JS/TS Language Summary (what the parser must handle)

### Function definition forms

JavaScript has many ways to define functions. The analyzer must recognize all of them as symbols:

```javascript
// Function declaration
function greet(name) { ... }

// Function expression (named)
const greet = function greet(name) { ... };

// Function expression (anonymous, named by variable)
const greet = function(name) { ... };

// Arrow function (block body)
const greet = (name) => { ... };

// Arrow function (concise body)
const greet = (name) => `Hello ${name}`;

// Method in object literal
const obj = {
    greet(name) { ... },
    farewell: function(name) { ... },
    wave: (name) => { ... }
};

// Class method
class Greeter {
    greet(name) { ... }
    static create() { ... }
    get name() { ... }
    set name(v) { ... }
    #privateMethod() { ... }  // ES2022
}

// Async variants
async function fetchData() { ... }
const fetchData = async () => { ... }

// Generator
function* items() { ... }
async function* stream() { ... }

// Default export
export default function handler() { ... }
export default class Service { ... }

// Named export
export function helper() { ... }
export class Util { ... }
```

### Call syntax

```javascript
// Direct call
greet("Alice");

// Method call
obj.greet("Alice");
obj?.greet("Alice");       // optional chaining

// Chained calls
fetch(url).then(r => r.json()).then(data => process(data));

// Computed call
obj[methodName]();

// Tagged template
html`<div>${content}</div>`;

// new
const x = new MyClass(arg);

// IIFE
(function() { ... })();
(() => { ... })();

// Import call
const mod = await import('./module.js');

// call/apply/bind
func.call(ctx, arg);
func.apply(ctx, [arg]);
const bound = func.bind(ctx);

// Callback passing (function reference, not a call to greet)
arr.forEach(greet);
arr.map(item => transform(item));
```

### Module system

```javascript
// ES modules
import { helper } from './utils.js';
import * as utils from './utils.js';
import defaultExport from './module.js';
export { myFunc, MyClass };
export default function() { ... }

// CommonJS
const utils = require('./utils');
const { helper } = require('./utils');
module.exports = { myFunc };
module.exports.helper = function() { ... };
```

### Control flow constructs

```javascript
if (cond) { ... } else if (cond2) { ... } else { ... }
for (let i = 0; i < n; i++) { ... }
for (const item of iterable) { ... }
for (const key in obj) { ... }
while (cond) { ... }
do { ... } while (cond);
switch (expr) { case val: ... break; default: ... }
try { ... } catch (e) { ... } finally { ... }
```

### TypeScript additions (if .ts files are supported)

```typescript
// Type annotations don't change structure, but parser must skip them
function greet(name: string): void { ... }
const x: number = 5;

// Interfaces, type aliases, enums (not callable, but are symbols)
interface IGreeter { greet(name: string): void; }
type Handler = (event: Event) => void;
enum Status { Active, Inactive }

// Generics
function identity<T>(arg: T): T { return arg; }
class Container<T> { ... }

// Decorators (TypeScript experimental / TC39 stage 3)
@injectable
class Service { ... }
```

---

## Architecture

The JS adapter scripts are written in Python (matching the existing pattern), and shell out to a Node.js subprocess for parsing. This keeps the host integration identical to Python/IDL.

Implementation note: the current repository no longer follows the Python-worker design described below. JavaScript and TypeScript support is implemented directly in the extension host with the TypeScript compiler AST under `src/javascript/analysis/*`, and the existing call graph and flowchart renderers are reused unchanged.

```
New files:
  python/js_analyzer.py       → orchestrates analysis, calls js_parse_worker.js
  python/js_flowchart.py      → orchestrates flowchart, calls js_parse_worker.js
  js/js_parse_worker.js       → Node.js script using acorn for AST parsing
  js/package.json              → declares acorn dependency

Modified files:
  src/python/analysis/pythonRunner.ts  → add runJsAnalyzer(), buildJsFlowchartFor()
  src/extension.ts                     → add JS/TS file detection and routing
  src/providers/fileTreeProvider.ts     → include .js/.ts/.jsx/.tsx files
  package.json                         → add JS/TS to activation events and menus

NOT modified:
  src/python/model/graphTypes.ts       → same schema
  webview/views/callgraph/*            → same renderer
  webview/views/flowchart/*            → same renderer
  webview/main.js                      → already dispatches by graphType
```

### Why a Node.js subprocess instead of pure Python?

Python has no reliable JavaScript parser. Tree-sitter-javascript exists but requires native bindings. Acorn is the standard JS parser (used by ESLint, webpack, rollup), runs in any Node.js environment, and produces a clean ESTree AST. Since VS Code guarantees Node.js is available, this is the most reliable path.

The Python scripts (`js_analyzer.py`, `js_flowchart.py`) handle the orchestration and output formatting (same stdin/stdout JSON contract as Python and IDL adapters). They call `js_parse_worker.js` as a subprocess for the actual AST parsing.

---

## Step 1: Create `js/js_parse_worker.js` — AST Parser

This Node.js script receives a parse request on stdin and returns structured AST information on stdout.

### 1.1 Setup

File: `js/package.json`

```json
{
  "name": "codemap-js-parser",
  "private": true,
  "dependencies": {
    "acorn": "^8.12.0",
    "acorn-jsx": "^5.3.2",
    "acorn-walk": "^8.3.0"
  }
}
```

Install during extension activation or as a postinstall step:
```bash
cd js && npm install
```

### 1.2 Parse worker

File: `js/js_parse_worker.js`

```javascript
/**
 * js_parse_worker.js — Acorn-based JS/JSX parser for CodeMap.
 *
 * Input (stdin JSON):
 * {
 *   "command": "analyze" | "flowchart",
 *   "file": "path/to/file.js",
 *   "source": "...source code...",     // optional, if not provided reads file
 *   "line": 42                          // for flowchart: target line
 * }
 *
 * Output (stdout JSON):
 *   For "analyze": { functions: [...], calls: [...], imports: [...], exports: [...], errors: [...] }
 *   For "flowchart": { function: {...}, body: [...], errors: [...] }
 */

const fs = require('fs');
const acorn = require('acorn');
const jsx = require('acorn-jsx');
const walk = require('acorn-walk');

// Extend walker for JSX nodes
const jsxWalk = Object.assign({}, walk.base, {
    JSXElement(node, st, c) {
        node.children.forEach(child => c(child, st));
        node.openingElement.attributes.forEach(attr => {
            if (attr.value && attr.value.type === 'JSXExpressionContainer') {
                c(attr.value.expression, st);
            }
        });
    },
    JSXFragment(node, st, c) {
        node.children.forEach(child => c(child, st));
    },
    JSXExpressionContainer(node, st, c) {
        if (node.expression.type !== 'JSXEmptyExpression') {
            c(node.expression, st);
        }
    },
    JSXSpreadAttribute(node, st, c) {
        c(node.argument, st);
    },
    JSXText() {},
    JSXEmptyExpression() {},
});

function main() {
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        try {
            const request = JSON.parse(input);
            const source = request.source || fs.readFileSync(request.file, 'utf-8');
            const file = request.file || '<stdin>';

            const isJSX = file.endsWith('.jsx') || file.endsWith('.tsx');
            const isTS = file.endsWith('.ts') || file.endsWith('.tsx');

            let ast;
            try {
                ast = acorn.Parser.extend(jsx()).parse(source, {
                    sourceType: 'module',
                    ecmaVersion: 'latest',
                    locations: true,
                    allowImportExportEverywhere: true,
                    allowAwaitOutsideFunction: true,
                    allowReturnOutsideFunction: true,
                    allowSuperOutsideMethod: true,
                });
            } catch (parseErr) {
                // Retry as script (not module)
                try {
                    ast = acorn.Parser.extend(jsx()).parse(source, {
                        sourceType: 'script',
                        ecmaVersion: 'latest',
                        locations: true,
                        allowReturnOutsideFunction: true,
                    });
                } catch (parseErr2) {
                    console.log(JSON.stringify({
                        error: `Parse error: ${parseErr2.message}`,
                        line: parseErr2.loc?.line,
                        column: parseErr2.loc?.column
                    }));
                    return;
                }
            }

            if (request.command === 'analyze') {
                const result = analyzeAST(ast, source, file);
                console.log(JSON.stringify(result));
            } else if (request.command === 'flowchart') {
                const result = buildFlowchart(ast, source, file, request.line);
                console.log(JSON.stringify(result));
            } else {
                console.log(JSON.stringify({ error: `Unknown command: ${request.command}` }));
            }
        } catch (err) {
            console.log(JSON.stringify({ error: err.message, stack: err.stack }));
        }
    });
}


// ═══════════════════════════════════════════════════════════════
// ANALYZE — Extract functions, calls, imports, exports
// ═══════════════════════════════════════════════════════════════

function analyzeAST(ast, source, file) {
    const functions = [];
    const calls = [];
    const imports = [];
    const exports = [];
    const errors = [];

    // ── Collect function definitions ──

    walk.ancestor(ast, {
        FunctionDeclaration(node, ancestors) {
            functions.push({
                name: node.id?.name || '<anonymous>',
                kind: node.async ? 'async_function' : node.generator ? 'generator' : 'function',
                params: extractParamNames(node.params),
                line: node.loc.start.line,
                endLine: node.loc.end.line,
                column: node.loc.start.column,
                isExported: isExported(node, ancestors),
                className: getEnclosingClassName(ancestors),
            });
        },

        // Variable declarators that hold function expressions or arrow functions
        VariableDeclarator(node, ancestors) {
            if (!node.init) return;
            const init = node.init;
            if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') {
                const name = node.id?.type === 'Identifier' ? node.id.name : '<destructured>';
                functions.push({
                    name,
                    kind: init.async ? 'async_function' : init.type === 'ArrowFunctionExpression' ? 'arrow' : 'function',
                    params: extractParamNames(init.params),
                    line: node.loc.start.line,
                    endLine: init.loc.end.line,
                    column: node.loc.start.column,
                    isExported: isExported(node, ancestors),
                    className: getEnclosingClassName(ancestors),
                });
            }
        },

        // Object method / class method
        MethodDefinition(node, ancestors) {
            const name = node.key?.name || node.key?.value || '<computed>';
            const className = getEnclosingClassName(ancestors);
            const prefix = node.static ? 'static ' : '';
            const kindLabel = node.kind === 'get' ? 'getter' : node.kind === 'set' ? 'setter' : 'method';
            functions.push({
                name: `${prefix}${name}`,
                kind: kindLabel,
                params: extractParamNames(node.value.params),
                line: node.loc.start.line,
                endLine: node.loc.end.line,
                column: node.loc.start.column,
                isExported: false,
                className,
            });
        },

        // Object literal method shorthand
        Property(node, ancestors) {
            if (node.method && node.value.type === 'FunctionExpression') {
                const name = node.key?.name || node.key?.value || '<computed>';
                functions.push({
                    name,
                    kind: 'method',
                    params: extractParamNames(node.value.params),
                    line: node.loc.start.line,
                    endLine: node.loc.end.line,
                    column: node.loc.start.column,
                    isExported: false,
                    className: null,
                });
            }
        },

        // Class declarations
        ClassDeclaration(node, ancestors) {
            functions.push({
                name: node.id?.name || '<anonymous>',
                kind: 'class',
                params: [],
                line: node.loc.start.line,
                endLine: node.loc.end.line,
                column: node.loc.start.column,
                isExported: isExported(node, ancestors),
                className: null,
                superClass: node.superClass?.name || null,
            });
        },

    }, jsxWalk);

    // ── Collect call sites ──

    walk.simple(ast, {
        CallExpression(node) {
            const callInfo = extractCallTarget(node);
            if (callInfo) {
                calls.push({
                    text: callInfo.text,
                    name: callInfo.name,
                    line: node.loc.start.line,
                    column: node.loc.start.column,
                    callType: callInfo.callType,
                });
            }
        },

        NewExpression(node) {
            const name = node.callee.type === 'Identifier'
                ? node.callee.name
                : node.callee.type === 'MemberExpression'
                    ? memberExprName(node.callee)
                    : null;
            if (name) {
                calls.push({
                    text: `new ${name}(...)`,
                    name,
                    line: node.loc.start.line,
                    column: node.loc.start.column,
                    callType: 'constructor',
                });
            }
        },

        TaggedTemplateExpression(node) {
            const name = node.tag.type === 'Identifier'
                ? node.tag.name
                : node.tag.type === 'MemberExpression'
                    ? memberExprName(node.tag)
                    : null;
            if (name) {
                calls.push({
                    text: `${name}\`...\``,
                    name,
                    line: node.loc.start.line,
                    column: node.loc.start.column,
                    callType: 'tagged_template',
                });
            }
        },
    }, jsxWalk);

    // ── Collect imports ──

    walk.simple(ast, {
        ImportDeclaration(node) {
            const source = node.source.value;
            for (const spec of node.specifiers) {
                imports.push({
                    localName: spec.local.name,
                    importedName: spec.type === 'ImportDefaultSpecifier' ? 'default'
                        : spec.type === 'ImportNamespaceSpecifier' ? '*'
                        : spec.imported?.name || spec.local.name,
                    source,
                    line: node.loc.start.line,
                });
            }
        },

        // CommonJS require
        CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'require'
                && node.arguments.length === 1 && node.arguments[0].type === 'Literal') {
                const source = node.arguments[0].value;
                // Find parent: const x = require(...) or const {a,b} = require(...)
                // We can't easily get parent from walk.simple, so just record the require
                imports.push({
                    localName: '<require>',
                    importedName: '*',
                    source,
                    line: node.loc.start.line,
                    isCommonJS: true,
                });
            }
        },
    }, jsxWalk);

    // ── Collect exports ──

    walk.simple(ast, {
        ExportNamedDeclaration(node) {
            if (node.declaration) {
                if (node.declaration.type === 'FunctionDeclaration') {
                    exports.push({ name: node.declaration.id?.name, line: node.loc.start.line });
                } else if (node.declaration.type === 'ClassDeclaration') {
                    exports.push({ name: node.declaration.id?.name, line: node.loc.start.line });
                } else if (node.declaration.type === 'VariableDeclaration') {
                    for (const decl of node.declaration.declarations) {
                        if (decl.id.type === 'Identifier') {
                            exports.push({ name: decl.id.name, line: node.loc.start.line });
                        }
                    }
                }
            }
            if (node.specifiers) {
                for (const spec of node.specifiers) {
                    exports.push({ name: spec.exported.name, line: node.loc.start.line });
                }
            }
        },
        ExportDefaultDeclaration(node) {
            const name = node.declaration?.id?.name || '<default>';
            exports.push({ name, isDefault: true, line: node.loc.start.line });
        },
    }, jsxWalk);

    return { functions, calls, imports, exports, errors };
}


// ═══════════════════════════════════════════════════════════════
// FLOWCHART — Extract control flow for a single function
// ═══════════════════════════════════════════════════════════════

function buildFlowchart(ast, source, file, targetLine) {
    // Find the innermost function containing targetLine
    let targetFunc = null;
    let targetFuncSize = Infinity;

    walk.simple(ast, {
        FunctionDeclaration(node) { checkTarget(node); },
        FunctionExpression(node) { checkTarget(node); },
        ArrowFunctionExpression(node) { checkTarget(node); },
        MethodDefinition(node) { checkTarget(node.value); },
    }, jsxWalk);

    function checkTarget(node) {
        if (!node.loc) return;
        const start = node.loc.start.line;
        const end = node.loc.end.line;
        if (start <= targetLine && targetLine <= end) {
            const size = end - start;
            if (size < targetFuncSize) {
                targetFunc = node;
                targetFuncSize = size;
            }
        }
    }

    if (!targetFunc) {
        return { error: 'No function found at target line' };
    }

    // Get function body
    const body = targetFunc.body;
    if (!body) {
        return { error: 'Function has no body' };
    }

    // For concise arrow functions (no block body), wrap in synthetic block
    const statements = body.type === 'BlockStatement'
        ? body.body
        : [{ type: 'ReturnStatement', argument: body, loc: body.loc }];

    // Walk statements and build flowchart nodes
    const nodes = [];
    let nodeId = 0;

    function nextId() { return `n${++nodeId}`; }

    function walkStatements(stmts) {
        for (const stmt of stmts) {
            walkStatement(stmt);
        }
    }

    function walkStatement(stmt) {
        if (!stmt || !stmt.loc) return;
        const line = stmt.loc.start.line;
        const endLine = stmt.loc.end.line;
        const text = getSourceText(source, line, endLine).trim();

        switch (stmt.type) {
            case 'VariableDeclaration': {
                const id = nextId();
                // Shorten label: just show first line
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'compute', label, line, endLine, structure: 'assign' });
                break;
            }

            case 'ExpressionStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                const expr = stmt.expression;
                const kind = (expr.type === 'CallExpression' || expr.type === 'AwaitExpression')
                    ? 'process' : (expr.type === 'AssignmentExpression') ? 'compute' : 'process';
                nodes.push({ id, kind, label, line, endLine });
                break;
            }

            case 'ReturnStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'return', label, line, endLine });
                break;
            }

            case 'ThrowStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'error', label, line, endLine });
                break;
            }

            case 'IfStatement': {
                const id = nextId();
                const condText = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'decision', label: condText, line, endLine, structure: 'if' });

                // Consequent
                if (stmt.consequent) {
                    if (stmt.consequent.type === 'BlockStatement') {
                        walkStatements(stmt.consequent.body);
                    } else {
                        walkStatement(stmt.consequent);
                    }
                }

                // Alternate (else / else if)
                if (stmt.alternate) {
                    if (stmt.alternate.type === 'IfStatement') {
                        // else if — recurse
                        walkStatement(stmt.alternate);
                    } else {
                        const elseId = nextId();
                        nodes.push({ id: elseId, kind: 'decision', label: 'else', line: stmt.alternate.loc.start.line, structure: 'else' });
                        if (stmt.alternate.type === 'BlockStatement') {
                            walkStatements(stmt.alternate.body);
                        } else {
                            walkStatement(stmt.alternate);
                        }
                    }
                }
                break;
            }

            case 'ForStatement':
            case 'ForInStatement':
            case 'ForOfStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'loop', label, line, endLine, structure: 'for' });
                if (stmt.body.type === 'BlockStatement') {
                    walkStatements(stmt.body.body);
                } else {
                    walkStatement(stmt.body);
                }
                break;
            }

            case 'WhileStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'loop', label, line, endLine, structure: 'while' });
                if (stmt.body.type === 'BlockStatement') {
                    walkStatements(stmt.body.body);
                } else {
                    walkStatement(stmt.body);
                }
                break;
            }

            case 'DoWhileStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'loop', label, line, endLine, structure: 'do_while' });
                if (stmt.body.type === 'BlockStatement') {
                    walkStatements(stmt.body.body);
                } else {
                    walkStatement(stmt.body);
                }
                break;
            }

            case 'SwitchStatement': {
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                nodes.push({ id, kind: 'decision', label, line, endLine, structure: 'switch' });
                for (const sc of stmt.cases) {
                    const caseId = nextId();
                    const caseLabel = sc.test
                        ? `case ${getSourceText(source, sc.test.loc.start.line, sc.test.loc.end.line).trim()}`
                        : 'default';
                    nodes.push({ id: caseId, kind: 'decision', label: caseLabel, line: sc.loc.start.line, structure: 'case' });
                    walkStatements(sc.consequent);
                }
                break;
            }

            case 'TryStatement': {
                const id = nextId();
                nodes.push({ id, kind: 'process', label: 'try', line, endLine, structure: 'try' });
                if (stmt.block) walkStatements(stmt.block.body);

                if (stmt.handler) {
                    const catchId = nextId();
                    const param = stmt.handler.param?.name || '';
                    nodes.push({ id: catchId, kind: 'decision', label: `catch${param ? ` (${param})` : ''}`, line: stmt.handler.loc.start.line, structure: 'catch' });
                    if (stmt.handler.body) walkStatements(stmt.handler.body.body);
                }

                if (stmt.finalizer) {
                    const finId = nextId();
                    nodes.push({ id: finId, kind: 'process', label: 'finally', line: stmt.finalizer.loc.start.line, structure: 'finally' });
                    walkStatements(stmt.finalizer.body);
                }
                break;
            }

            case 'BreakStatement': {
                const id = nextId();
                nodes.push({ id, kind: 'break', label: stmt.label ? `break ${stmt.label.name}` : 'break', line });
                break;
            }

            case 'ContinueStatement': {
                const id = nextId();
                nodes.push({ id, kind: 'continue', label: stmt.label ? `continue ${stmt.label.name}` : 'continue', line });
                break;
            }

            case 'BlockStatement': {
                walkStatements(stmt.body);
                break;
            }

            case 'LabeledStatement': {
                walkStatement(stmt.body);
                break;
            }

            default: {
                // Anything else: generic process node
                const id = nextId();
                const label = getSourceLine(source, line).trim();
                if (label) {
                    nodes.push({ id, kind: 'process', label, line, endLine });
                }
                break;
            }
        }
    }

    walkStatements(statements);

    // Get function name
    let funcName = '<anonymous>';
    if (targetFunc.id?.name) {
        funcName = targetFunc.id.name;
    }
    // Check if it's assigned to a variable
    // (we'd need parent info for this — skip for now)

    return {
        functionName: funcName,
        params: extractParamNames(targetFunc.params),
        line: targetFunc.loc.start.line,
        endLine: targetFunc.loc.end.line,
        isAsync: targetFunc.async || false,
        isGenerator: targetFunc.generator || false,
        nodes,
        errors: [],
    };
}


// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function extractParamNames(params) {
    const names = [];
    for (const p of params) {
        switch (p.type) {
            case 'Identifier':
                names.push(p.name);
                break;
            case 'AssignmentPattern':
                // param = default
                if (p.left.type === 'Identifier') names.push(p.left.name);
                else names.push('<destructured>');
                break;
            case 'RestElement':
                if (p.argument.type === 'Identifier') names.push(`...${p.argument.name}`);
                else names.push('...rest');
                break;
            case 'ObjectPattern':
                names.push('{...}');
                break;
            case 'ArrayPattern':
                names.push('[...]');
                break;
            default:
                names.push('<param>');
        }
    }
    return names;
}

function extractCallTarget(node) {
    const callee = node.callee;

    // Direct call: func(args)
    if (callee.type === 'Identifier') {
        return {
            name: callee.name,
            text: `${callee.name}(...)`,
            callType: 'function',
        };
    }

    // Method call: obj.method(args) or obj?.method(args)
    if (callee.type === 'MemberExpression') {
        const name = memberExprName(callee);
        if (name) {
            return {
                name,
                text: `${name}(...)`,
                callType: 'method',
            };
        }
    }

    // Chained: (await expr).method(args)
    // Just skip these for now
    return null;
}

function memberExprName(node) {
    if (node.type !== 'MemberExpression') return null;
    const prop = node.computed ? null : (node.property.name || node.property.value);
    if (!prop) return null;

    if (node.object.type === 'Identifier') {
        return `${node.object.name}.${prop}`;
    }
    if (node.object.type === 'MemberExpression') {
        const parent = memberExprName(node.object);
        if (parent) return `${parent}.${prop}`;
    }
    if (node.object.type === 'ThisExpression') {
        return `this.${prop}`;
    }
    return prop;
}

function isExported(node, ancestors) {
    if (!ancestors || ancestors.length < 2) return false;
    const parent = ancestors[ancestors.length - 2];
    return parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration';
}

function getEnclosingClassName(ancestors) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const n = ancestors[i];
        if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
            return n.id?.name || '<anonymous class>';
        }
    }
    return null;
}

function getSourceLine(source, line) {
    const lines = source.split('\n');
    return lines[line - 1] || '';
}

function getSourceText(source, startLine, endLine) {
    const lines = source.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
}


main();
```

---

## Step 2: Create `python/js_analyzer.py` — Call Graph Adapter

```python
"""
js_analyzer.py — JavaScript/TypeScript workspace analyzer for CodeMap.

Calls js_parse_worker.js for AST parsing, then assembles
PyAnalysisResult-compatible output.

Input (stdin JSON):
{
    "command": "index",
    "files": ["path/to/file.js", ...],
    "root": "workspace/root"
}

Output (stdout JSON): PyAnalysisResult-compatible
"""

import sys
import json
import os
import subprocess


def find_node():
    """Find Node.js executable."""
    for cmd in ['node', 'node.exe']:
        try:
            result = subprocess.run([cmd, '--version'],
                capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return cmd
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    return None


def parse_js_file(node_cmd, worker_path, file_path, command='analyze'):
    """Call js_parse_worker.js to parse a JS file."""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            source = f.read()
    except Exception as e:
        return {"error": str(e)}
    
    request = json.dumps({
        "command": command,
        "file": file_path,
        "source": source
    })
    
    try:
        result = subprocess.run(
            [node_cmd, worker_path],
            input=request,
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            return {"error": f"Parser error: {result.stderr}"}
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {"error": "Parser timeout"}
    except json.JSONDecodeError:
        return {"error": f"Invalid parser output: {result.stdout[:200]}"}


def main():
    request = json.loads(sys.stdin.read())
    files = request.get("files", [])
    root = request.get("root", "")
    
    node_cmd = find_node()
    if not node_cmd:
        print(json.dumps({"error": "Node.js not found"}))
        return
    
    # Resolve worker script path (relative to this script)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    worker_path = os.path.join(script_dir, '..', 'js', 'js_parse_worker.js')
    worker_path = os.path.normpath(worker_path)
    
    if not os.path.exists(worker_path):
        print(json.dumps({"error": f"Worker not found: {worker_path}"}))
        return
    
    all_symbols = {}
    all_modules = {}
    errors = []
    all_functions = {}  # name -> symbol id, for call resolution
    
    total_functions = 0
    total_classes = 0
    total_files = len(files)
    
    for file_path in files:
        parsed = parse_js_file(node_cmd, worker_path, file_path, 'analyze')
        
        if "error" in parsed:
            errors.append({"file": file_path, "message": parsed["error"]})
            continue
        
        # Determine module name from file path
        rel_path = os.path.relpath(file_path, root) if root else file_path
        module_name = rel_path.replace(os.sep, '/').rsplit('.', 1)[0]
        
        module_id = f"{module_name}:<module>"
        all_modules[module_name] = module_id
        
        # Process functions
        for func in parsed.get("functions", []):
            name = func["name"]
            kind = func.get("kind", "function")
            className = func.get("className")
            
            if kind == "class":
                total_classes += 1
                sym_kind = "class"
            else:
                total_functions += 1
                sym_kind = "method" if className else "function"
            
            # Build qualified name
            if className:
                qualified = f"{module_name}.{className}.{name}"
                sym_id = f"{module_name}:{className}.{name}"
            else:
                qualified = f"{module_name}.{name}"
                sym_id = f"{module_name}:{name}"
            
            symbol = {
                "id": sym_id,
                "kind": sym_kind,
                "name": name,
                "qualifiedName": qualified,
                "module": module_name,
                "file": file_path,
                "source": {
                    "file": file_path,
                    "line": func["line"],
                    "column": func.get("column", 0),
                    "endLine": func.get("endLine", func["line"]),
                    "endColumn": 0
                },
                "params": [{"name": p, "type": None, "typeSource": None}
                           for p in func.get("params", [])],
                "calls": [],
                "decorators": [],
                "isAsync": func.get("kind") == "async_function",
            }
            
            if className:
                symbol["className"] = className
            if func.get("superClass"):
                symbol["bases"] = [func["superClass"]]
            
            all_symbols[sym_id] = symbol
            all_functions[name.upper()] = sym_id
            if className:
                all_functions[f"{className}.{name}".upper()] = sym_id
        
        # Process call sites — attach to enclosing function
        for call in parsed.get("calls", []):
            call_line = call["line"]
            
            # Find the enclosing function for this call
            enclosing_sym_id = None
            best_range = float('inf')
            for sym_id, sym in all_symbols.items():
                if sym["file"] != file_path:
                    continue
                src = sym["source"]
                if src["line"] <= call_line <= src["endLine"]:
                    range_size = src["endLine"] - src["line"]
                    if range_size < best_range:
                        best_range = range_size
                        enclosing_sym_id = sym_id
            
            if enclosing_sym_id is None:
                continue  # top-level call, skip for now
            
            call_entry = {
                "text": call.get("text", ""),
                "line": call_line,
                "column": call.get("column", 0),
                "resolution": "unresolved",
                "_targetName": call.get("name", ""),
            }
            all_symbols[enclosing_sym_id]["calls"].append(call_entry)
    
    # ── Call resolution pass ──
    JS_BUILTINS = {
        'CONSOLE.LOG', 'CONSOLE.ERROR', 'CONSOLE.WARN', 'CONSOLE.INFO', 'CONSOLE.DEBUG',
        'SETTIMEOUT', 'SETINTERVAL', 'CLEARINTERVAL', 'CLEARTIMEOUT',
        'PARSEFLOAT', 'PARSEINT', 'ISNAN', 'ISFINITE', 'EVAL',
        'JSON.PARSE', 'JSON.STRINGIFY',
        'MATH.FLOOR', 'MATH.CEIL', 'MATH.ROUND', 'MATH.ABS', 'MATH.MAX', 'MATH.MIN',
        'MATH.SQRT', 'MATH.POW', 'MATH.LOG', 'MATH.RANDOM',
        'OBJECT.KEYS', 'OBJECT.VALUES', 'OBJECT.ENTRIES', 'OBJECT.ASSIGN',
        'OBJECT.FREEZE', 'OBJECT.CREATE', 'OBJECT.DEFINEPROPERTY',
        'ARRAY.ISARRAY', 'ARRAY.FROM', 'ARRAY.OF',
        'PROMISE.ALL', 'PROMISE.RACE', 'PROMISE.RESOLVE', 'PROMISE.REJECT',
        'PROMISE.ALLSETTLED', 'PROMISE.ANY',
        'STRING.FROMCHARCODE', 'NUMBER.ISINTEGER', 'NUMBER.PARSEFLOAT',
        'DATE.NOW', 'ERROR', 'TYPEERROR', 'RANGEERROR', 'SYNTAXERROR',
        'MAP', 'SET', 'WEAKMAP', 'WEAKSET', 'PROXY', 'REFLECT',
        'SYMBOL', 'BIGINT',
        'FETCH', 'ATOB', 'BTOA', 'STRUCTUREDCLONE',
        'QUEUEMICROTASK', 'REQUESTANIMATIONFRAME', 'CANCELANIMATIONFRAME',
        'REQUIRE', 'IMPORT',
    }
    
    resolved_count = 0
    unresolved_count = 0
    builtin_count = 0
    
    for sym_id, symbol in all_symbols.items():
        for call in symbol["calls"]:
            target_name = call.pop("_targetName", "").upper()
            
            # Try exact match
            if target_name in all_functions:
                call["resolvedTo"] = all_functions[target_name]
                call["resolution"] = "resolved"
                resolved_count += 1
            # Try method match (strip object prefix for resolution)
            elif '.' in target_name:
                method = target_name.split('.')[-1]
                # Search for any method with this name
                matches = [fid for fname, fid in all_functions.items()
                          if fname.endswith('.' + method)]
                if len(matches) == 1:
                    call["resolvedTo"] = matches[0]
                    call["resolution"] = "likely"
                    resolved_count += 1
                elif target_name in JS_BUILTINS:
                    call["resolution"] = "unresolved"
                    call["resolutionSource"] = "builtin"
                    builtin_count += 1
                else:
                    call["resolution"] = "unresolved"
                    unresolved_count += 1
            elif target_name in JS_BUILTINS:
                call["resolution"] = "unresolved"
                call["resolutionSource"] = "builtin"
                builtin_count += 1
            else:
                call["resolution"] = "unresolved"
                unresolved_count += 1
    
    # ── Build output ──
    result = {
        "symbols": all_symbols,
        "modules": all_modules,
        "errors": errors,
        "summary": {
            "totalFiles": total_files,
            "totalFunctions": total_functions,
            "totalClasses": total_classes,
            "totalTypeSlots": 0,
            "typedSlots": 0,
            "typeCoveragePct": 0.0,
            "jediEnabled": False,
            "jediResolved": 0,
            "callResolution": {
                "total": resolved_count + unresolved_count + builtin_count,
                "resolved": resolved_count,
                "likely": 0,
                "unresolved": unresolved_count,
                "builtin": builtin_count,
                "outOfScope": 0,
                "jedi": 0
            }
        }
    }
    
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

---

## Step 3: Create `python/js_flowchart.py` — Flowchart Adapter

```python
"""
js_flowchart.py — JavaScript flowchart builder for CodeMap.

Input (stdin JSON):
{
    "file": "path/to/file.js",
    "line": 42
}

Output (stdout JSON): GraphDocument with graphType "flowchart"
"""

import sys
import json
import os
import subprocess


def find_node():
    for cmd in ['node', 'node.exe']:
        try:
            result = subprocess.run([cmd, '--version'],
                capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return cmd
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    return None


def main():
    request = json.loads(sys.stdin.read())
    file_path = request["file"]
    target_line = request["line"]
    
    node_cmd = find_node()
    if not node_cmd:
        print(json.dumps({"error": "Node.js not found"}))
        return
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    worker_path = os.path.normpath(
        os.path.join(script_dir, '..', 'js', 'js_parse_worker.js')
    )
    
    # Read source
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        source = f.read()
    
    # Call worker
    worker_request = json.dumps({
        "command": "flowchart",
        "file": file_path,
        "source": source,
        "line": target_line
    })
    
    try:
        result = subprocess.run(
            [node_cmd, worker_path],
            input=worker_request,
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            print(json.dumps({"error": f"Parser error: {result.stderr}"}))
            return
        parsed = json.loads(result.stdout)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return
    
    if "error" in parsed:
        print(json.dumps(parsed))
        return
    
    # Build GraphDocument from parsed flowchart data
    func_name = parsed.get("functionName", "<anonymous>")
    params = parsed.get("params", [])
    is_async = parsed.get("isAsync", False)
    
    prefix = "async " if is_async else ""
    entry_label = f"{prefix}{func_name}({', '.join(params)})"
    
    graph_nodes = [{
        "id": "entry",
        "kind": "entry",
        "label": entry_label,
        "source": {
            "file": file_path,
            "line": parsed.get("line", target_line),
            "endLine": parsed.get("line", target_line)
        }
    }]
    
    graph_edges = []
    groups = []
    group_stack = []
    
    prev_id = "entry"
    
    for cf in parsed.get("nodes", []):
        node = {
            "id": cf["id"],
            "kind": cf["kind"],
            "label": cf["label"],
            "source": {
                "file": file_path,
                "line": cf["line"],
                "endLine": cf.get("endLine", cf["line"])
            }
        }
        graph_nodes.append(node)
        
        structure = cf.get("structure", "")
        
        # Build control flow edges
        if structure in ("if", "switch", "try"):
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            group_stack.append({
                "start_id": cf["id"],
                "kind": structure,
                "line": cf["line"]
            })
            prev_id = cf["id"]
        
        elif structure in ("else", "catch", "finally", "case"):
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow",
                "label": structure
            })
            prev_id = cf["id"]
        
        elif structure in ("for", "while", "do_while"):
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            group_stack.append({
                "start_id": cf["id"],
                "kind": "loop",
                "line": cf["line"]
            })
            prev_id = cf["id"]
        
        else:
            # Regular statement
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            prev_id = cf["id"]
    
    # Build GraphDocument
    graph = {
        "graphType": "flowchart",
        "title": f"{func_name}()",
        "subtitle": file_path,
        "nodes": graph_nodes,
        "edges": graph_edges,
        "rootNodeIds": ["entry"],
        "metadata": {
            "function": func_name,
            "params": params,
            "groups": groups
        }
    }
    
    print(json.dumps(graph))


if __name__ == "__main__":
    main()
```

---

## Step 4: Wire the Host

### 4.1 Add JS runner functions

File: `src/python/analysis/pythonRunner.ts`

```typescript
export async function indexJsWorkspace(
    files: string[],
    root: string
): Promise<PyAnalysisResult> {
    const request = { command: 'index', files, root };
    return await runPythonScript('js_analyzer.py', request) as PyAnalysisResult;
}

export async function buildJsFlowchartFor(
    file: string,
    line: number
): Promise<GraphDocument> {
    const request = { file, line };
    return await runPythonScript('js_flowchart.py', request) as GraphDocument;
}
```

### 4.2 Update extension.ts

Add JS/TS file detection alongside existing Python and IDL routing:

```typescript
// In flowchart command handler:
const ext = path.extname(file).toLowerCase();
let graph: GraphDocument;
if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    graph = await buildJsFlowchartFor(file, line);
} else if (ext === '.pro') {
    graph = await buildIdlFlowchartFor(file, line);
} else {
    graph = await buildFlowchartFor(file, line);
}

// In workspace graph handler:
const jsFiles = await vscode.workspace.findFiles(
    '**/*.{js,jsx,ts,tsx,mjs,cjs}',
    '**/node_modules/**'
);
if (jsFiles.length > 0) {
    const jsAnalysis = await indexJsWorkspace(
        jsFiles.map(f => f.fsPath),
        workspaceRoot
    );
    // Merge into workspace graph
}
```

### 4.3 Update fileTreeProvider.ts

Add JS/TS extensions to file inclusion:

```typescript
// Add alongside existing .py filter
const jsPattern = '**/*.{js,jsx,ts,tsx,mjs,cjs}';
// Exclude: node_modules, dist, build, .next, coverage
```

### 4.4 Update package.json

```json
{
    "activationEvents": [
        "onLanguage:python",
        "onLanguage:idl",
        "onLanguage:javascript",
        "onLanguage:typescript",
        "onLanguage:javascriptreact",
        "onLanguage:typescriptreact"
    ],
    "contributes": {
        "menus": {
            "editor/context": [
                {
                    "command": "codemap.showFlowchart",
                    "when": "editorLangId == python || editorLangId == idl || editorLangId == javascript || editorLangId == typescript || editorLangId == javascriptreact || editorLangId == typescriptreact",
                    "group": "codemap"
                }
            ]
        }
    }
}
```

### 4.5 Ensure Node.js worker dependencies

The `js/package.json` must be installed. Options:

**Option A**: Install during extension activation:
```typescript
// In extension.ts activate()
const jsDir = path.join(context.extensionPath, 'js');
if (fs.existsSync(path.join(jsDir, 'package.json')) 
    && !fs.existsSync(path.join(jsDir, 'node_modules'))) {
    await runShell('npm install --production', { cwd: jsDir });
}
```

**Option B**: Bundle acorn with the extension (copy node_modules into dist during build).

**Option C**: Add to `npm postinstall` in the extension's root package.json:
```json
{
    "scripts": {
        "postinstall": "cd js && npm install --production"
    }
}
```

Option B is recommended for a published extension (no install-time network dependency).

---

## Step 5: Test

### Test file

Create `test_samples/sample_js.js`:

```javascript
import { readFile } from 'fs/promises';

const DEFAULT_THRESHOLD = 0.5;

export class DataProcessor {
    constructor(config) {
        this.config = config;
        this.cache = new Map();
    }

    async process(filePath) {
        const raw = await readFile(filePath, 'utf-8');
        const data = this.parse(raw);
        
        const results = [];
        for (const item of data) {
            if (item.value > DEFAULT_THRESHOLD) {
                const transformed = this.transform(item);
                results.push(transformed);
            } else {
                console.log('Skipping item:', item.id);
            }
        }
        
        return this.summarize(results);
    }

    parse(raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            throw new Error(`Parse failed: ${e.message}`);
        }
    }

    transform(item) {
        const { value, weight } = item;
        return {
            ...item,
            score: value * weight,
            normalized: value / DEFAULT_THRESHOLD,
        };
    }

    summarize(results) {
        const total = results.reduce((sum, r) => sum + r.score, 0);
        const avg = results.length > 0 ? total / results.length : 0;
        return { count: results.length, total, avg };
    }
}

export function createProcessor(config) {
    return new DataProcessor(config);
}

// Arrow function with callback
export const processAll = async (files, config) => {
    const processor = createProcessor(config);
    const outputs = await Promise.all(
        files.map(f => processor.process(f))
    );
    return outputs;
};
```

### Expected results

**Analyzer output should contain:**
- Symbols: `DataProcessor` (class), `constructor` (method), `process` (method), `parse` (method), `transform` (method), `summarize` (method), `createProcessor` (function), `processAll` (arrow)
- Calls from `process`: `readFile`, `this.parse`, `this.transform`, `results.push`, `console.log`, `this.summarize`
- Calls from `createProcessor`: `DataProcessor` (constructor)
- Calls from `processAll`: `createProcessor`, `Promise.all`, `files.map`, `processor.process`
- Imports: `readFile` from `fs/promises`
- `this.parse` should resolve to `parse` method, `this.transform` to `transform`, `this.summarize` to `summarize`

**Flowchart output for `process` method should contain:**
- Entry node: `async process(filePath)`
- Compute nodes for `raw`, `data`, `results`
- Loop node for `for (const item of data)`
- Decision node for `if (item.value > DEFAULT_THRESHOLD)`
- Process nodes for `this.transform`, `results.push`, `console.log`
- Return node for `return this.summarize(results)`

---

## File Checklist

| File | Action | Description |
|------|--------|-------------|
| `js/package.json` | CREATE | Declares acorn + acorn-jsx + acorn-walk dependencies |
| `js/js_parse_worker.js` | CREATE | Node.js AST parser worker |
| `python/js_analyzer.py` | CREATE | Call graph adapter (calls worker) |
| `python/js_flowchart.py` | CREATE | Flowchart adapter (calls worker) |
| `src/python/analysis/pythonRunner.ts` | EDIT | Add JS runner functions |
| `src/extension.ts` | EDIT | Add JS/TS file detection and routing |
| `src/providers/fileTreeProvider.ts` | EDIT | Include JS/TS files |
| `package.json` | EDIT | Add JS/TS activation events and menus |
| `test_samples/sample_js.js` | CREATE | Test file |

## Files NOT Modified

| File | Reason |
|------|--------|
| `src/python/model/graphTypes.ts` | Same schema works for JS |
| `webview/views/flowchart/*` | Same renderer |
| `webview/views/callgraph/*` | Same renderer |
| `webview/main.js` | Already dispatches by graphType |
| `python/analyzer.py` | Python-specific, unchanged |
| `python/flowchart.py` | Python-specific, unchanged |
| `python/idl_*.py` | IDL-specific, unchanged |

---

## Known Limitations

1. **TypeScript type syntax**: Acorn does not parse TypeScript. For `.ts`/`.tsx` files, either (a) use `@babel/parser` with the TypeScript plugin instead of acorn, or (b) strip type annotations before parsing. Option (b) is fragile. Recommended: swap acorn for `@babel/parser` in the worker if TS support is needed. The worker's output format stays identical.

2. **Dynamic calls**: `obj[methodName]()`, `func.call(ctx, args)`, `eval('code')` cannot be resolved statically. They appear as unresolved calls.

3. **Callback identity**: In `arr.forEach(greet)`, `greet` is passed as a reference, not called on this line. The analyzer records the call at the `forEach` site. The fact that `greet` will be called inside `forEach` is not tracked (would require higher-order call graph analysis).

4. **Re-exports and barrel files**: `export { thing } from './module'` re-exports without importing. These should be tracked as both import + export but don't create local symbols.

5. **CommonJS interop**: `const x = require('./mod')` followed by `x.method()` — resolving `x.method` to the export of `./mod` requires following the require chain. Currently, require targets are recorded but not followed.

6. **Decorators**: TC39 stage 3 decorators (`@decorator`) are not supported by base acorn. Use `acorn-stage3` plugin or `@babel/parser` if needed.

7. **Private class fields**: `#privateMethod()` calls inside the same class should resolve but the `#` prefix complicates name matching. The analyzer should normalize by stripping `#` for resolution.

8. **JSX components**: `<MyComponent prop={value} />` is a call to `MyComponent`. The worker detects these via JSXElement nodes but they appear as unresolved unless `MyComponent` is defined in scope.

9. **node_modules exclusion**: The file tree provider must exclude `node_modules`, `dist`, `build`, `.next`, `coverage`, and other common non-source directories. The exclude list should be configurable.