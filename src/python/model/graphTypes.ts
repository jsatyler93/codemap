// Shared graph data model. Both flowchart and call-graph builders emit
// serializable GraphDocument objects that the webview consumes as JSON.

export type NodeKind =
  | "function"
  | "method"
  | "class"
  | "module"
  | "entry"
  | "return"
  | "decision"
  | "process"
  | "compute"
  | "output"
  | "error"
  | "package";

export type EdgeKind =
  | "calls"
  | "imports"
  | "contains"
  | "inherits"
  | "control_flow"
  | "execution_step"
  | "cross_package";

export type Resolution = "resolved" | "likely" | "unresolved";

export interface SourceRef {
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  module?: string;
  className?: string;
  source?: SourceRef;
  styleCategory?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  resolution?: Resolution;
  metadata?: Record<string, unknown>;
}

export type GraphType = "flowchart" | "callgraph" | "workspace" | "trace" | "package" | "module_view" | "unified";

export interface GraphDocument {
  graphType: GraphType;
  title: string;
  subtitle?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootNodeIds?: string[];
  metadata?: Record<string, unknown>;
}

// ── Semantic zoom types ───────────────────────────────────────────────

export type ZoomLevel = 0 | 1 | 2 | 3;

export interface NavigationPathEntry {
  level: ZoomLevel;
  label: string;
  id: string;
}

export interface PeripheralRef {
  id: string;
  label: string;
  direction: "incoming" | "outgoing";
  callCount: number;
  targetLevel: ZoomLevel;
  color?: string;
}

export interface ZoomContext {
  level: ZoomLevel;
  navigationPath: NavigationPathEntry[];
  peripherals: PeripheralRef[];
  parentId?: string;
  moduleColorMap?: Record<string, string>;
}
