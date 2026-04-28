# Change Log

## 0.1.3
- Packaged all webview runtime assets inside the VSIX so installed users get working flowcharts and call graph views without needing source-side `webview/` files.

## 0.1.2
- Bundled the extension host with esbuild so all runtime dependencies ship inside the VSIX. Fixes activation failure on installed builds where the Scope view stayed empty and right-click commands did nothing.

## 0.1.1
- Fixed the Scope view failing to populate reliably on install.
- Fixed explorer right-click graph commands matching supported files by extension.

## 0.1.0
- Initial public release
- Flowcharts for Python, JavaScript/TypeScript, and IDL
- File and workspace call graphs
- Copilot-powered narration
- Debug probe generation for Python and JavaScript