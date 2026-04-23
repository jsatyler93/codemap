export type ProbeOutputSchema =
  | { kind: "scalar"; type: "float" | "int" | "bool" }
  | { kind: "array1d"; dtype: string; expectedLength?: number }
  | { kind: "array2d"; dtype: string; shape?: [number, number] }
  | { kind: "dict"; keys: string[] }
  | { kind: "string" };

export type WidgetSpec =
  | { type: "plot"; title: string; xLabel?: string; yLabel?: string }
  | {
      type: "plotly";
      title: string;
      chartType?: "auto" | "line" | "scatter" | "bar" | "histogram" | "box" | "heatmap" | "surface3d";
      xLabel?: string;
      yLabel?: string;
      zLabel?: string;
    }
  | { type: "heatmap"; title: string; colormap?: string }
  | { type: "histogram"; title: string; bins?: number }
  | { type: "table"; title: string; columns?: string[] }
  | { type: "tensor"; title: string };

export interface DebugProbe {
  id: string;
  nodeId: string;
  breakpointFile: string;
  breakpointLine: number;
  snippetPython: string;
  expectedOutputSchema: ProbeOutputSchema;
  widgetSpec: WidgetSpec;
  label: string;
  rationale: string;
  generatedAt: number;
}

export interface ProbeResult {
  probeId: string;
  nodeId: string;
  hitCount: number;
  timestamp: number;
  data: unknown;
  error?: string;
}