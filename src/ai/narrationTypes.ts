export type NarrationKind = "trace" | "flowchart";

export interface NarrationStep {
  edgeIndex?: number;
  fromNodeId?: string;
  toNodeId?: string;
  nodeId?: string;
  narration: string;
  durationHint: number;
}

export interface NarrationScript {
  kind: NarrationKind;
  graphId: string;
  overview: string;
  steps: NarrationStep[];
  generatedAt: number;
  modelId?: string;
  modelName?: string;
}
