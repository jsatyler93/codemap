import { analyzeFleet } from "./pipeline.js";

function pickSensors(region) {
  const base = ["north-1", "north-2", "south-1", "south-9", "east-2", "west-4"];
  if (region === "north") {
    return base.filter((s) => s.startsWith("north") || s.startsWith("east"));
  }
  if (region === "south") {
    return base.filter((s) => s.startsWith("south") || s.startsWith("west"));
  }
  return base;
}

function printReport(result) {
  console.log("Fleet Summary:", result.summary);
  for (const report of result.reports) {
    console.log(
      `${report.sensorId} | score=${report.score.toFixed(3)} | ${report.classification} | ${report.narrative}`,
    );
  }
}

async function main() {
  const region = process.argv[2] || "all";
  const sensors = pickSensors(region);
  const result = await analyzeFleet(sensors);
  printReport(result);
}

main().catch((err) => {
  console.error("pipeline failed", err);
  process.exitCode = 1;
});
