#!/usr/bin/env node
// Copy non-bundled webview runtime assets into dist/ so the packaged
// extension is self-contained. Anything the webview HTML loads at
// runtime (e.g. webview/styles.css) must live under dist/webview/ so
// that an installed VSIX works without the source `webview/` folder.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function copy(rel, destRel) {
  const src = path.join(root, rel);
  const dest = path.join(root, destRel);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] missing source: ${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] ${rel} -> ${destRel}`);
}

copy("webview/styles.css", "dist/webview/styles.css");

// Ensure litegraph.js is present in dist/webview (esbuild marks it external,
// so it must be shipped as a static asset for the webview <script> tag).
try {
  const litegraphSrc = require.resolve("litegraph.js/build/litegraph.js", {
    paths: [root],
  });
  const litegraphDest = path.join(root, "dist", "webview", "litegraph.js");
  fs.mkdirSync(path.dirname(litegraphDest), { recursive: true });
  fs.copyFileSync(litegraphSrc, litegraphDest);
  console.log(`[copy-assets] litegraph.js -> dist/webview/litegraph.js`);
} catch (err) {
  console.warn(`[copy-assets] could not resolve litegraph.js: ${err.message}`);
}
