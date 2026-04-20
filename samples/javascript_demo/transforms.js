export function normalizeSeries(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const max = Math.max(...points.map((p) => p.value));
  const min = Math.min(...points.map((p) => p.value));
  const span = Math.max(1, max - min);
  return points.map((p) => ({
    ts: p.ts,
    value: (p.value - min) / span,
    quality: p.quality,
  }));
}

export function smoothSeries(points, window = 3) {
  if (window <= 1 || points.length <= 2) return points;
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = i - window; j <= i + window; j += 1) {
      if (j < 0 || j >= points.length) continue;
      sum += points[j].value;
      count += 1;
    }
    out.push({ ...points[i], value: sum / Math.max(1, count) });
  }
  return out;
}

export function detectSpikes(points, threshold = 0.24) {
  const spikes = [];
  for (let i = 1; i < points.length; i += 1) {
    const delta = Math.abs(points[i].value - points[i - 1].value);
    if (delta > threshold) {
      spikes.push({
        at: points[i].ts,
        delta,
        from: points[i - 1].value,
        to: points[i].value,
      });
    }
  }
  return spikes;
}
