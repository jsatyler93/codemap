# Python analysis details

CodeMap uses Python's standard `ast` module to extract symbols and call
sites. Resolution is intentionally conservative.

The analyzer now attaches explicit provenance and confidence metadata to the
facts it emits so the UI and downstream code can distinguish verified facts
from heuristic ones instead of treating them as equally certain.

## What is extracted

Per file:

- module symbol (one)
- top-level functions (`def`, `async def`)
- classes (and their methods)
- imports (`import x`, `import x as y`, `from x import y`, with relative
  level)
- decorators (recorded but not used to rewrite call edges)
- inside every function/method body, every `ast.Call` is collected with its
  best-effort source-text representation of the callee expression.

Nested functions/classes are still indexed but their containing function
keeps its own `calls` list (i.e. inner `def`s do not pollute the parent
flowchart's call graph).

## Call resolution

For each call site we attempt resolution in this order:

| Pattern                            | Resolution    |
| ---------------------------------- | ------------- |
| local top-level `name()`           | `resolved`    |
| `self.method()` inside a class     | `resolved`    |
| `cls.method()` inside a class      | `likely`      |
| imported alias `x.foo()`           | `resolved` if `module:foo` exists, else dropped |
| `from m import f` then `f()`       | `resolved` if `m:f` exists, else `likely` |
| imported alias `x.Class.method()`  | `likely` if class & method known |
| `Class.method()` in same module    | `likely`      |
| anything else                      | `unresolved`  |

Unresolved calls are intentionally **not added as edges** — we omit them
rather than fabricate. The renderer additionally:

- draws `likely` edges with a 3px dash pattern
- draws `unresolved` edges (when shown) with a sparse dotted pattern
- draws `resolved` edges solid

Each call site also carries:

- `resolutionSource`: where the conclusion came from, such as `ast-local`,
  `ast-import-from`, `ast-self-member`, `ast-class-member`, `jedi`,
  `builtin`, or `out-of-scope-import`
- `confidence`: `high`, `medium`, or `low`
- `externalTarget`: best-known textual target for builtin or out-of-scope calls

Confidence policy:

- `high`: exact local/member/import match or a Jedi-confirmed symbol
- `medium`: class-member style inference (`Class.method`, `cls.method`) or
  imported code outside the analyzed file set
- `low`: unresolved remnants such as import misses where a module was analyzed
  but no matching symbol could be justified

This keeps the analysis falsifiable: we record what was observed, how it was
derived, and how certain the analyzer is, instead of silently upgrading
 guesses into facts.

## Type provenance

Extracted parameter, attribute, and return types now carry source and
confidence information:

- annotations → `typeSource=annotation`, `typeConfidence=high`
- docstrings → `typeSource=docstring`, `typeConfidence=medium`
- inferred instance assignments such as `self.x = []` →
  `typeSource=value-inference`, `typeConfidence=low`

Return types carry the same distinction via `returnTypeSource` and
`returnTypeConfidence`.

## Flowchart granularity

`python/flowchart.py` walks one function's AST and emits:

- one **entry** node
- one **return** node per `return` (and one implicit return if the body
  falls through)
- **decision** diamonds for `if/elif/else`, `for`, `while`, `try`
- **error** nodes for `raise` and `except` handlers
- **process / compute** nodes that merge runs of consecutive simple
  statements into one box (≤ 3 lines, "+N more" suffix beyond)

This produces approximate, readable charts — not full control-flow graphs.

## Limitations

- decorators that change call semantics (e.g. `@functools.lru_cache`) are
  ignored
- `getattr`, `exec`, `eval` are unresolved by design
- dynamic `__getattr__`-based dispatch is not modelled
- `*args` / `**kwargs` forwarding is not tracked
- packages are matched textually, not via import-system resolution; very
  exotic `sys.path` layouts may produce missing edges
- generic `lambda`/comprehension call sites are recorded but their
  containing function still owns them
- out-of-scope imports are classified explicitly, but they are still not
  resolved into internal edges unless the target symbol exists in the
  analyzed file set or Jedi can map it confidently
