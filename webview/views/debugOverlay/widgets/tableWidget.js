import { DebugWidgetNode, drawEmptyState, objectEntriesFrom } from "../debugWidgetNode.js";

export class TableWidgetNode extends DebugWidgetNode {
  constructor() {
    super();
    this.size = [300, 210];
  }

  drawWidget(ctx, rect, data, _spec, result) {
    const entries = objectEntriesFrom(data);
    if (!entries.length) {
      drawEmptyState(ctx, rect, result?.error || "No structured data available.");
      return;
    }
    ctx.save();
    ctx.font = "10px Consolas";
    let y = rect.y + 12;
    entries.slice(0, 10).forEach(([key, value]) => {
      ctx.fillStyle = "#7aa2f7";
      ctx.fillText(String(key), rect.x, y);
      ctx.fillStyle = "#d9e1f5";
      ctx.fillText(formatValue(value), rect.x + 92, y);
      y += 16;
    });
    ctx.restore();
  }
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return `[${value.slice(0, 4).map((entry) => JSON.stringify(entry)).join(", ")}${value.length > 4 ? ", ..." : ""}]`;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value).slice(0, 40);
  }
  return String(value);
}
