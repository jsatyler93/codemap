import { DebugWidgetNode, drawAxes, drawEmptyState, flattenNumericValues } from "../debugWidgetNode.js";

export class HistogramWidgetNode extends DebugWidgetNode {
  constructor() {
    super();
    this.size = [320, 220];
  }

  drawWidget(ctx, rect, data, spec, result) {
    const values = flattenNumericValues(data).filter(Number.isFinite);
    if (!values.length) {
      drawEmptyState(ctx, rect, result?.error || "No numeric values available.");
      return;
    }
    const bins = Math.max(4, Math.min(40, Number(spec?.bins) || 18));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const counts = new Array(bins).fill(0);
    values.forEach((value) => {
      const index = max === min ? 0 : Math.min(bins - 1, Math.floor(((value - min) / (max - min)) * bins));
      counts[index] += 1;
    });
    const maxCount = Math.max(...counts, 1);
    const barWidth = rect.width / bins;
    drawAxes(ctx, rect, "bins", "count");
    ctx.save();
    counts.forEach((count, index) => {
      const height = (count / maxCount) * (rect.height - 4);
      ctx.fillStyle = "#a78bfa";
      ctx.fillRect(rect.x + index * barWidth, rect.y + rect.height - height, Math.max(2, barWidth - 2), height);
    });
    ctx.restore();
  }
}
