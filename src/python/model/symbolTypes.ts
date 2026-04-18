import { SourceRef } from "./graphTypes";

export type PySymbolKind = "function" | "method" | "class" | "module";

export interface PyCallSite {
  // Best-effort textual representation of the callee expression as it appears
  // in source (e.g. "foo", "self.bar", "mod.baz", "Class.method").
  text: string;
  line: number;
  column: number;
  // The candidate symbol id this call resolves to, if any.
  resolvedTo?: string;
  resolution: "resolved" | "likely" | "unresolved";
}

export interface PyParam {
  name: string;
  /** Best-known type string. May come from an annotation or a docstring. */
  type?: string;
  /** Where the type came from. */
  typeSource?: "annotation" | "docstring";
  /** Default value as source text, if any. */
  default?: string;
  /** True for `*args`. */
  vararg?: boolean;
  /** True for `**kwargs`. */
  kwarg?: boolean;
  /** True if declared after `*` (keyword-only). */
  kwOnly?: boolean;
}

export interface PyAttr {
  name: string;
  type?: string;
  line: number;
}

export interface PySymbol {
  id: string;            // unique id, e.g. "pkg.module:Class.method"
  kind: PySymbolKind;
  name: string;          // short name
  qualifiedName: string; // dotted path within file
  module: string;        // dotted module path (relative to workspace)
  file: string;          // absolute path
  source: SourceRef;
  className?: string;
  decorators?: string[];
  isAsync?: boolean;
  calls: PyCallSite[];
  // For classes, the list of method ids defined inside.
  members?: string[];
  // For classes: base class expressions as source text.
  bases?: string[];
  // For classes: annotated class-level attributes.
  classAttributes?: PyAttr[];
  // For classes: attributes assigned in __init__ (heuristic typing).
  instanceAttributes?: PyAttr[];
  // For modules, the list of top-level symbol ids.
  topLevel?: string[];
  // Imports recorded in the module this symbol belongs to.
  // (only populated for module symbols)
  imports?: PyImport[];
  // For functions/methods: parameter list with type info.
  params?: PyParam[];
  // For functions/methods: return type string if known.
  returnType?: string;
  returnTypeSource?: "annotation" | "docstring";
  // First line of the docstring, if any.
  docSummary?: string;
  // Refined sub-kind for methods.
  methodKind?: "instance" | "static" | "class" | "property";
}

export interface PyImport {
  // Examples:
  //   import x          -> { module: "x", asName: undefined, names: [] }
  //   import x as y     -> { module: "x", asName: "y", names: [] }
  //   from x import y   -> { module: "x", names: [{name:"y"}] }
  //   from x import y as z -> { module: "x", names: [{name:"y", asName:"z"}] }
  module: string;
  asName?: string;
  names: { name: string; asName?: string }[];
  line: number;
  isFrom: boolean;
  // For "from .pkg import x", level is the number of leading dots.
  level: number;
}

export interface PyAnalysisResult {
  // All extracted symbols indexed by id.
  symbols: Record<string, PySymbol>;
  // module path -> module symbol id
  modules: Record<string, string>;
  // Files that failed to parse.
  errors: { file: string; message: string }[];
  // Aggregate stats useful for the UI.
  summary?: {
    totalFiles: number;
    totalFunctions: number;
    totalClasses: number;
    totalTypeSlots: number;
    typedSlots: number;
    typeCoveragePct: number;
    jediEnabled: boolean;
    jediResolved: number;
  };
}
