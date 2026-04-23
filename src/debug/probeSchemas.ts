import { z } from "zod";
import type { DebugProbe, ProbeResult } from "./debugProbeTypes";

const probeOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scalar"), type: z.enum(["float", "int", "bool"]) }),
  z.object({ kind: z.literal("array1d"), dtype: z.string(), expectedLength: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("array2d"), dtype: z.string(), shape: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional() }),
  z.object({ kind: z.literal("dict"), keys: z.array(z.string()) }),
  z.object({ kind: z.literal("string") }),
]);

const widgetSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plot"), title: z.string().min(1), xLabel: z.string().optional(), yLabel: z.string().optional() }),
  z.object({
    type: z.literal("plotly"),
    title: z.string().min(1),
    chartType: z.enum(["auto", "line", "scatter", "bar", "histogram", "box", "heatmap", "surface3d"]).optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    zLabel: z.string().optional(),
  }),
  z.object({ type: z.literal("heatmap"), title: z.string().min(1), colormap: z.string().optional() }),
  z.object({ type: z.literal("histogram"), title: z.string().min(1), bins: z.number().int().positive().optional() }),
  z.object({ type: z.literal("table"), title: z.string().min(1), columns: z.array(z.string()).optional() }),
  z.object({ type: z.literal("tensor"), title: z.string().min(1) }),
]);

export const debugProbeSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  breakpointFile: z.string().min(1),
  breakpointLine: z.number().int().positive(),
  snippetPython: z.string().min(1),
  expectedOutputSchema: probeOutputSchema,
  widgetSpec: widgetSpecSchema,
  label: z.string().min(1),
  rationale: z.string().min(1),
  generatedAt: z.number().int().positive(),
});

export const probeResultSchema = z.object({
  probeId: z.string().min(1),
  nodeId: z.string().min(1),
  hitCount: z.number().int().nonnegative(),
  timestamp: z.number().int().positive(),
  data: z.unknown(),
  error: z.string().optional(),
});

export function parseDebugProbe(value: unknown): DebugProbe {
  return debugProbeSchema.parse(value) as DebugProbe;
}

export function parseProbeResult(value: unknown): ProbeResult {
  return probeResultSchema.parse(value) as ProbeResult;
}

export function parseDebugProbeList(value: unknown): DebugProbe[] {
  return z.array(debugProbeSchema).parse(value) as DebugProbe[];
}