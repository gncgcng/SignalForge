// Exports per-setup track records from a replay-harness run into one small, versioned JSON file the server loads at
// boot. Local only: the harness and its ~750 MB candle cache never run on Railway. See docs/track-records.md.
//
//   node scripts/research/export-track-records.js \
//     --run <harness worktree>/.replay-cache/runs/main \
//     --variant V1 --variant-reason "production blocks shorts (direction:short disabled_by_admin since 2026-10-10)" \
//     --harness-commit 2100547 \
//     [--universe <run>/verdict-universe.json] [--timeframes 5m,15m,1h,4h] [--approximate 5m] [--directions long]
//     [--out data/track-records/track-records.v1.json] [--generated-at <ISO>]
//
// Reads: <run>/*.signals.jsonl (phase 1), <run>/variants.json (accepted setup keys per variant), the verdict
// universe (pairs), <run>/fidelity.json and <run>/verdicts.json. Writes per-record statistics only: no trade rows.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildTrackRecordsFile } from "./track-records/stats.js";

export const DEFAULT_OUT = "data/track-records/track-records.v1.json";

export function parseExportArguments(argv) {
  const options = {
    run: null,
    universe: null,
    variant: null,
    variantReason: "",
    harnessCommit: null,
    timeframes: ["5m", "15m", "1h", "4h"],
    approximate: ["5m"],
    directions: ["long"],
    out: DEFAULT_OUT,
    generatedAt: null
  };
  const list = (value) => String(value).split(",").map((item) => item.trim()).filter(Boolean);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === "--run") options.run = value;
    else if (flag === "--universe") options.universe = value;
    else if (flag === "--variant") options.variant = value;
    else if (flag === "--variant-reason") options.variantReason = value;
    else if (flag === "--harness-commit") options.harnessCommit = value;
    else if (flag === "--timeframes") options.timeframes = list(value);
    else if (flag === "--approximate") options.approximate = list(value);
    else if (flag === "--directions") options.directions = list(value).map((item) => item.toLowerCase());
    else if (flag === "--out") options.out = value;
    else if (flag === "--generated-at") options.generatedAt = new Date(value).toISOString();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const required of ["run", "variant", "harnessCommit"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
  }
  return options;
}

export function readHarnessRun(runDir, universePath) {
  const signals = [];
  for (const file of readdirSync(runDir).filter((name) => name.endsWith(".signals.jsonl")).sort()) {
    for (const line of readFileSync(join(runDir, file), "utf8").split("\n")) if (line.trim()) signals.push(JSON.parse(line));
  }
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  return {
    signals,
    variants: readJson(join(runDir, "variants.json")),
    universe: readJson(universePath || join(runDir, "verdict-universe.json")),
    fidelity: readJson(join(runDir, "fidelity.json")),
    verdicts: readJson(join(runDir, "verdicts.json"))
  };
}

const pct = (value) => (value == null ? null : Number((value * 100).toFixed(1)));

// The replay's agreement with live, as the harness report states it.
export function summarizeFidelity(fidelity, verdicts) {
  const primary = fidelity.primaryPrecisionTest || {};
  const gate = fidelity.gate || {};
  const five = verdicts?.fiveMinuteFidelity || {};
  return {
    recall: pct(fidelity.recall),
    precision: pct(fidelity.precision),
    pass: Boolean(fidelity.pass),
    recallWindow: gate.window ? { from: gate.window.from.slice(0, 10), to: gate.window.to.slice(0, 10), timeframes: gate.window.timeframes } : null,
    recallCounts: gate.live != null ? { liveSignals: gate.live, matched: gate.matched } : null,
    precisionWindow: primary.window ? { from: primary.window.from.slice(0, 10), to: primary.window.to.slice(0, 10), timeframes: primary.window.timeframes } : null,
    precisionCounts: primary.replayWithLiveScanEvidence != null
      ? { replaySignalsOnScannedBars: primary.replayWithLiveScanEvidence, matched: primary.matched }
      : null,
    perTimeframeRecall: Object.fromEntries(Object.entries(fidelity.perTimeframeAccurateEvidence || {})
      .map(([timeframe, value]) => [timeframe, { live: value.live, matched: value.matched, recall: pct(value.recall) }])),
    fiveMinutePrecisionVerified: Boolean(five.verified),
    fiveMinuteNote: five.verified
      ? null
      : "5m precision could not be verified against live (every 5m bar with live scan evidence was a bar where live itself signalled), so 5m records are approximate."
  };
}

// Selects the records to publish: universe pairs, the variant's accepted setups, included timeframes and directions.
export function selectRecords(run, options) {
  const variant = run.variants.variants?.[options.variant];
  if (!variant) throw new Error(`Variant ${options.variant} is not in variants.json.`);
  const accepted = new Set(variant.accepted);
  const pairs = new Set(run.universe.pairs);
  const timeframes = new Set(options.timeframes);
  const directions = new Set(options.directions);
  return {
    variantLabel: variant.label,
    records: run.signals.filter((record) => pairs.has(record.symbol) && accepted.has(record.setupKey) &&
      timeframes.has(record.timeframe) && directions.has(record.direction))
  };
}

export function exportTrackRecords(run, options) {
  const { variantLabel, records } = selectRecords(run, options);
  return buildTrackRecordsFile(records, {
    generatedAt: options.generatedAt || new Date().toISOString(),
    harness: {
      commit: options.harnessCommit,
      branch: "research/replay-harness",
      verdictsGeneratedAt: run.verdicts?.generatedAt || null,
      phase1Signals: run.verdicts?.run?.phase1Signals ?? null
    },
    variant: { id: options.variant, label: variantLabel, reason: options.variantReason || null },
    pairs: run.universe.pairs,
    timeframes: options.timeframes,
    approximateTimeframes: options.approximate.filter((timeframe) => options.timeframes.includes(timeframe)),
    directions: options.directions,
    fidelity: summarizeFidelity(run.fidelity, run.verdicts)
  });
}

async function main() {
  const options = parseExportArguments(process.argv.slice(2));
  const run = readHarnessRun(resolve(options.run), options.universe ? resolve(options.universe) : null);
  const file = exportTrackRecords(run, options);
  const output = `${JSON.stringify(file, null, 2)}\n`;
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(resolve(options.out), output);
  console.log(`Wrote ${options.out}: ${file.records.length} records, ${file.counts.resolvedSetups} resolved setups, ${Buffer.byteLength(output)} bytes`);
  console.log(`Labels: ${JSON.stringify(file.labelCounts)}`);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Track-record export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
