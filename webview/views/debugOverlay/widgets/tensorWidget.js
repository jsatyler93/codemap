import { DebugWidgetNode, drawEmptyState, objectEntriesFrom } from "../debugWidgetNode.js";

export class TensorWidgetNode extends DebugWidgetNode {
  constructor() {
    super();
    this.size = [300, 220];
  }

  drawWidget(ctx, rect, data, _spec, result) {
    const entries = objectEntriesFrom(data);
    if (!entries.length) {
      drawEmptyState(ctx, rect, result?.error || "No tensor summary available.");
      return;
    }
    ctx.save();
    ctx.font = "10px Consolas";
    let y = rect.y + 12;
    entries.slice(0, 12).forEach(([key, value]) => {
      ctx.fillStyle = "#73daca";
      ctx.fillText(String(key), rect.x, y);
      ctx.fillStyle = "#d9e1f5";
      ctx.fillText(String(value), rect.x + 110, y);
      y += 15;
    });
    ctx.restore();
  }
}
