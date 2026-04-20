export function scoreSeries(normalized, spikes) {
  if (!normalized.length) return 0;
  const avg = normalized.reduce((acc, p) => acc + p.value, 0) / normalized.length;
  const volatilityPenalty = Math.min(0.45, spikes.length * 0.04);
  return Math.max(0, Math.min(1, avg - volatilityPenalty));
}

export function classifyScore(score) {
  if (score >= 0.78) return "healthy";
  if (score >= 0.58) return "watch";
  if (score >= 0.32) return "warning";
  return "critical";
}
