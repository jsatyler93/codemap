import { DebugWidgetNode, drawEmptyState, numericMatrixFrom } from "../debugWidgetNode.js";
import { interpolateRdBu, interpolateViridis, interpolatePlasma, interpolateTurbo } from "d3-scale-chromatic";

export class HeatmapWidgetNode extends DebugWidgetNode {
  constructor() {
    super();
    this.size = [280, 250];
  }

  drawWidget(ctx, rect, data, spec, result) {
    const matrix = numericMatrixFrom(data && typeof data === "object" && data.heatmap ? data.heatmap : data);
    if (!matrix.length || !matrix[0]?.length) {
      drawEmptyState(ctx, rect, result?.error || "No matrix data available.");
      return;
    }
    const values = matrix.flat().filter(Number.isFinite);
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    const rows = matrix.length;
    const cols = matrix[0].length;
    const cellW = rect.width / cols;
    const cellH = rect.height / rows;
    ctx.save();
    matrix.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        ctx.fillStyle = colorRamp(normalize(value, vMin, vMax), spec?.colormap || "RdBu");
        ctx.fillRect(rect.x + colIndex * cellW, rect.y + rowIndex * cellH, Math.ceil(cellW), Math.ceil(cellH));
      });
    });
    ctx.restore();
  }
}

function normalize(value, min, max) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function colorRamp(t, name) {
  const cmap = String(name || "").toLowerCase();
  if (cmap === "viridis") {
    return interpolateViridis(t);
  }
  if (cmap === "plasma") {
    return interpolatePlasma(t);
  }
  if (cmap === "turbo") {
    return interpolateTurbo(t);
  }
  return interpolateRdBu(1 - t);
}
