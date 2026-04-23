import { DebugWidgetNode, drawAxes, drawEmptyState } from "../debugWidgetNode.js";

export class PlotWidgetNode extends DebugWidgetNode {
  constructor() {
    super();
    this.size = [340, 220];
  }

  drawWidget(ctx, rect, data, spec, result) {
    const ySeries = extractYSeries(data);
    if (!ySeries.length) {
      drawEmptyState(ctx, rect, result?.error || "No numeric series available.");
      return;
    }
    const xSeries = extractXSeries(data, ySeries.length);
    const xMin = Math.min(...xSeries);
    const xMax = Math.max(...xSeries);
    const yMin = Math.min(...ySeries);
    const yMax = Math.max(...ySeries);
    drawAxes(ctx, rect, spec?.xLabel, spec?.yLabel);
    ctx.save();
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ySeries.forEach((value, index) => {
      const px = remap(xSeries[index], xMin, xMax, rect.x + 2, rect.x + rect.width - 2);
      const py = remap(value, yMin, yMax, rect.y + rect.height - 2, rect.y + 2);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }
}

function extractYSeries(data) {
  if (data && typeof data === "object") {
    if (Array.isArray(data.y)) return data.y.map(Number);
    if (Array.isArray(data.values)) return data.values.map(Number);
    if (Array.isArray(data.psd_slice)) return data.psd_slice.map(Number);
    for (const [key, value] of Object.entries(data)) {
      if (key === "x" || key === "freqs") continue;
      if (Array.isArray(value) && value.every((entry) => Number.isFinite(Number(entry)))) {
        return value.map(Number);
      }
    }
  }
  return [];
}

function extractXSeries(data, len) {
  if (data && typeof data === "object") {
    if (Array.isArray(data.x)) return data.x.map(Number);
    if (Array.isArray(data.freqs)) return data.freqs.map(Number);
  }
  return Array.from({ length: len }, (_, index) => index);
}

function remap(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  const t = (value - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}
