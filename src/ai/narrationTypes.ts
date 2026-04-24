export type NarrationKind = "trace" | "flowchart";

export type NarrationConfidence = "high" | "medium" | "low";

export interface NarrationEvidence {
  label: string;
  detail: string;
  confidence?: NarrationConfidence;
  nodeId?: string;
}

export interface NarrationSection {
  id: string;
  title: string;
  summary: string;
  intent?: string;
  stepNodeIds?: string[];
}

export interface NarrationStep {
  edgeIndex?: number;
  fromNodeId?: string;
  toNodeId?: string;
  nodeId?: string;
  title?: string;
  narration: string;
  whyItMatters?: string;
  confidence?: NarrationConfidence;
  evidence?: NarrationEvidence[];
  sectionId?: string;
  durationHint: number;
}

export interface NarrationScript {
  schemaVersion: number;
  kind: NarrationKind;
  graphId: string;
  title?: string;
  overview: string;
  opening?: string;
  sections?: NarrationSection[];
  takeaways?: string[];
  steps: NarrationStep[];
  generatedAt: number;
  modelId?: string;
  modelName?: string;
}
