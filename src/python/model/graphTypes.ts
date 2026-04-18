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
  | "error";

export type EdgeKind =
  | "calls"
  | "imports"
  | "contains"
  | "inherits"
  | "control_flow"
  | "execution_step";

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

export type GraphType = "flowchart" | "callgraph" | "workspace" | "trace";

export interface GraphDocument {
  graphType: GraphType;
  title: string;
  subtitle?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootNodeIds?: string[];
  metadata?: Record<string, unknown>;
}
