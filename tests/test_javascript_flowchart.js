const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildJavaScriptFileFlowchartFor } = require("../out/javascript/analysis/javascriptFlowchartBuilder.js");

function withTempFile(sourceText, extension, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-js-flow-"));
  const filePath = path.join(dir, `sample${extension}`);
  fs.writeFileSync(filePath, sourceText, "utf8");
  try {
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

withTempFile(
  [
    "function helper(value) {",
    "  return value + 1;",
    "}",
    "",
    "class Greeter {",
    "  greet(name) {",
    "    return helper(name.length);",
    "  }",
    "}",
    "",
    "const result = helper(2);",
    "",
    "export { result, Greeter };",
  ].join("\n"),
  ".js",
  (filePath) => {
    const graph = buildJavaScriptFileFlowchartFor(filePath);
    assert.strictEqual(graph.graphType, "flowchart");
    assert.strictEqual(graph.metadata.language, "javascript");
    assert.strictEqual(graph.metadata.scope, "file");

    const functionRefs = graph.nodes.filter((node) => node.metadata && node.metadata.scope === "file_function_ref");
    assert(functionRefs.length >= 2, "expected local function reference nodes");
    assert(functionRefs.some((node) => node.label === "helper"), "expected helper() reference node");
    assert(functionRefs.some((node) => node.label === "greet"), "expected Greeter.greet reference node");

    const callEdges = graph.edges.filter((edge) => edge.kind === "calls");
    assert(callEdges.length >= 2, "expected top-level and method call edges");
  },
);

console.log("JavaScript file flowchart tests passed");