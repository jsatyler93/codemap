// litegraph.js loaded externally via <script> tag - globals set on window
const LGraphNode = /** @type {any} */ (window).LGraphNode;
const LiteGraph = /** @type {any} */ (window).LiteGraph;

const TITLE_HEIGHT = 22;
const BODY_PADDING = 10;

export class DebugWidgetNode extends LGraphNode {
  constructor() {
    super();
    this.title = "Debug Probe";
    this.resizable = true;
    this.serialize_widgets = false;
    this.widgets_up = false;
    this.shape = LiteGraph.ROUND_SHAPE;
    this.color = "#e0af68";
    this.bgcolor = "#0d1220";
    this.boxcolor = "#24314f";
    this.size = [320, 210];
    this.probe = null;
    this.result = null;
    this.anchorNodeId = "";
    this.anchorPoint = [0, 0];
    this.anchorOffset = [72, 0];
  }

  setProbe(probe) {
    this.probe = probe;
    this.anchorNodeId = probe?.nodeId || "";
    this.title = probe?.widgetSpec?.title || probe?.label || "Debug Probe";
  }

  setResult(result) {
    this.result = result || null;
  }

  updateAnchor(anchorX, anchorY) {
    if (Number.isFinite(this.anchorPoint[0]) && Number.isFinite(this.anchorPoint[1])) {
      this.anchorOffset = [
        this.pos[0] - this.anchorPoint[0],
        this.pos[1] - this.anchorPoint[1],
      ];
    }
    if (!Number.isFinite(this.anchorOffset[0]) || !Number.isFinite(this.anchorOffset[1])) {
      this.anchorOffset = [72, 0];
    }
    this.anchorPoint = [anchorX, anchorY];
    this.pos = [anchorX + this.anchorOffset[0], anchorY + this.anchorOffset[1]];
  }

  onDrawForeground(ctx) {
    drawNodeChrome(ctx, this, this.probe, this.result);
    const inner = getInnerRect(this.size);
    this.drawWidget(ctx, inner, this.result?.data, this.probe?.widgetSpec || null, this.result);
  }

  drawWidget(ctx, innerRect, data, spec, result) {
    drawEmptyState(ctx, innerRect, result?.error ? result.error : "Waiting for probe data...");
  }
}

export function drawNodeChrome(ctx, node, probe, result) {
  const width = node.size[0];
  const height = node.size[1];
  ctx.save();
  ctx.fillStyle = "rgba(10, 14, 23, 0.96)";
  roundRect(ctx, 0, 0, width, height, 14);
  ctx.fill();
  ctx.strokeStyle = result?.error ? "rgba(247, 118, 142, 0.82)" : "rgba(224, 175, 104, 0.42)";
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 14);
  ctx.stroke();

  ctx.fillStyle = "rgba(224, 175, 104, 0.12)";
  roundRect(ctx, 0, 0, width, TITLE_HEIGHT + 10, 14);
  ctx.fill();

  ctx.fillStyle = "#f5deb2";
  ctx.font = "600 12px Segoe UI";
  ctx.fillText(probe?.label || node.title || "Debug Probe", 12, 16);

  ctx.fillStyle = "#8f9bb8";
  ctx.font = "10px Consolas";
  const meta = probe?.rationale || (result?.hitCount ? `Hit ${result.hitCount}` : "Awaiting result");
  ctx.fillText(truncate(meta, 44), 12, 30);
  ctx.restore();
}

export function getInnerRect(size) {
  return {
    x: BODY_PADDING,
    y: TITLE_HEIGHT + 16,
    width: Math.max(40, size[0] - BODY_PADDING * 2),
    height: Math.max(40, size[1] - (TITLE_HEIGHT + 16) - BODY_PADDING),
  };
}

export function drawAxes(ctx, rect, xLabel, yLabel) {
  ctx.save();
  ctx.strokeStyle = "rgba(143, 155, 184, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rect.x, rect.y + rect.height);
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
  ctx.moveTo(rect.x, rect.y);
  ctx.lineTo(rect.x, rect.y + rect.height);
  ctx.stroke();
  ctx.fillStyle = "#8f9bb8";
  ctx.font = "10px Consolas";
  if (xLabel) ctx.fillText(xLabel, rect.x + rect.width - ctx.measureText(xLabel).width, rect.y + rect.height + 14);
  if (yLabel) ctx.fillText(yLabel, rect.x, rect.y - 4);
  ctx.restore();
}

export function drawEmptyState(ctx, rect, text) {
  ctx.save();
  const hasError = /error|failed/i.test(String(text || ""));
  ctx.fillStyle = hasError ? "#f7768e" : "#8f9bb8";
  ctx.font = "11px Consolas";
  wrapText(ctx, text || "No data", rect.x, rect.y + 18, rect.width, 14);
  ctx.restore();
}

export function numericSeriesFrom(data) {
  if (Array.isArray(data) && data.every((value) => Number.isFinite(Number(value)))) {
    return data.map((value) => Number(value));
  }
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.every((entry) => Number.isFinite(Number(entry)))) {
        return value.map((entry) => Number(entry));
      }
    }
  }
  return [];
}

export function numericMatrixFrom(data) {
  if (Array.isArray(data) && data.every((row) => Array.isArray(row))) {
    return data.map((row) => row.map((value) => Number(value)));
  }
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.every((row) => Array.isArray(row))) {
        return value.map((row) => row.map((entry) => Number(entry)));
      }
    }
  }
  return [];
}

export function flattenNumericValues(data) {
  const series = numericSeriesFrom(data);
  if (series.length) return series;
  const matrix = numericMatrixFrom(data);
  if (matrix.length) return matrix.flat();
  return [];
}

export function objectEntriesFrom(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [["value", data]];
  }
  return Object.entries(data);
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, width, lineHeight) {
  const words = String(text || "").split(/\s+/);
  let line = "";
  let cursorY = y;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      ctx.fillText(line, x, cursorY);
      line = word;
      cursorY += lineHeight;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, cursorY);
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}