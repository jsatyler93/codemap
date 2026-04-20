import { TTLCache } from "./cache.js";
import { RetryScheduler } from "./scheduler.js";
import { normalizeSeries, smoothSeries, detectSpikes } from "./transforms.js";
import { scoreSeries, classifyScore } from "./metrics.js";

const cache = new TTLCache(1800);
const scheduler = new RetryScheduler({ maxAttempts: 4, baseDelayMs: 50 });

async function fetchSensorFeed(sensorId) {
  // Deterministic synthetic source for visualization/testing.
  const seed = sensorId.length * 17;
  const points = [];
  for (let i = 0; i < 24; i += 1) {
    const wave = Math.sin((i + seed) / 3) * 18;
    const trend = (sensorId.includes("north") ? 12 : -8) + i * 0.6;
    const value = 44 + wave + trend + (i % 5 === 0 ? 7 : 0);
    points.push({
      ts: i,
      value,
      quality: i % 7 === 0 ? "estimated" : "observed",
    });
  }
  return points;
}

function enrichQuality(points) {
  return points.map((p) => ({
    ...p,
    weight: p.quality === "observed" ? 1 : 0.72,
  }));
}

function weightedNormalize(points) {
  const weighted = points.map((p) => ({ ...p, value: p.value * p.weight }));
  const normalized = normalizeSeries(weighted);
  return smoothSeries(normalized, 2);
}

function buildNarrative(classification, spikes) {
  if (classification === "healthy") {
    return `stable signal with ${spikes.length} transient spikes`;
  }
  if (classification === "watch") {
    return `moderate variability; ${spikes.length} potential anomalies`;
  }
  if (classification === "warning") {
    return `elevated volatility with ${spikes.length} spikes; investigate upstream`;
  }
  return `critical trend divergence; immediate investigation advised`;
}

export async function analyzeSensor(sensorId) {
  const cacheKey = `sensor:${sensorId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const raw = await scheduler.run(() => fetchSensorFeed(sensorId), "fetchSensorFeed");
  const enriched = enrichQuality(raw);
  const normalized = weightedNormalize(enriched);
  const spikes = detectSpikes(normalized, 0.18);
  const score = scoreSeries(normalized, spikes);
  const classification = classifyScore(score);
  const narrative = buildNarrative(classification, spikes);

  const result = {
    sensorId,
    score,
    classification,
    narrative,
    spikes,
    sample: normalized.slice(-6),
    fromCache: false,
  };

  cache.set(cacheKey, result);
  cache.clearExpired();
  return result;
}

export async function analyzeFleet(sensorIds) {
  const reports = [];
  for (const sensorId of sensorIds) {
    try {
      const report = await analyzeSensor(sensorId);
      reports.push(report);
    } catch (err) {
      reports.push({
        sensorId,
        score: 0,
        classification: "critical",
        narrative: `analysis failed: ${String(err)}`,
        spikes: [],
        sample: [],
        fromCache: false,
      });
    }
  }

  const byClass = reports.reduce((acc, r) => {
    const key = r.classification || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return { reports, summary: byClass };
}
