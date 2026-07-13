import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNextConditions } from "../src/modules/signals/setupCandidateService.js";
import { summarizeScanBatch } from "../src/modules/signals/signalService.js";

const nextConditions = buildNextConditions(
  ["Price is too far from ideal entry.", "Volume confirmation is missing."],
  ["Volume"],
  "15m"
);
assert.ok(nextConditions.some((item) => item.includes("closer to the ideal entry zone")));
assert.ok(nextConditions.some((item) => item.includes("volume")));

const summary = summarizeScanBatch(
  [
    { symbol: "BTC-USD", timeframe: "15m", valid: true },
    { symbol: "ETH-USD", timeframe: "15m", valid: false },
    { symbol: "SOL-USD", timeframe: "1h", valid: false },
    { symbol: "XRP-USD", timeframe: "1h", valid: false }
  ],
  [{ symbol: "BTC-USD" }],
  [
    { id: "watch", status: "watching" },
    { id: "almost", status: "almost_ready" },
    { id: "reject", status: "rejected" }
  ],
  { topReasons: [{ reason: "poor RR", count: 2 }], topCodes: [{ code: "poor_rr", count: 2 }] }
);
assert.deepEqual(summary, {
  ready: 1,
  watching: 2,
  almostReady: 1,
  avoidTrade: 0,
  rejected: 1,
  expired: 0,
  topAvoidReason: null,
  topRejectionReason: "poor RR",
  topRejectionCode: "poor_rr"
});

const migration = readFileSync("migrations/036_candidate_explanations.sql", "utf8");
const repository = readFileSync("src/modules/signals/setupCandidateRepository.js", "utf8");
const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const autoScan = readFileSync("src/modules/alerts/autoScanService.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const candidateRenderer = app.slice(app.indexOf("function renderCandidates"), app.indexOf("async function loadPaperPortfolio"));

assert.match(migration, /ADD COLUMN IF NOT EXISTS next_conditions/);
assert.match(repository, /next_conditions = EXCLUDED\.next_conditions/);
assert.match(repository, /rejection_reason = \$2/);
assert.match(signalService, /candidatesById/);
assert.match(signalService, /\[scanner\] ready=/);
assert.match(signalService, /top_rejection_reason=/);
assert.match(signalService, /return "Data is stale\."/);
assert.match(signalService, /return "Provider unavailable\."/);
assert.match(signalService, /recordDiscoveryUsage\(\s*user,\s*allowedSetups\.length/);
assert.match(autoScan, /const setup = detailed\.fullSetup/);
assert.match(autoScan, /if \(!setup \|\| !telegramPreferenceMatchesSetup/);
assert.match(html, /Watching Setups/);
assert.match(html, /Watching setups are not signals yet/);
assert.match(html, /View scan diagnostics/);
assert.match(app, /Why not a signal yet:/);
assert.match(app, /Next condition needed/);
assert.match(app, /Last checked/);
assert.match(app, /data-scan-again/);
assert.doesNotMatch(candidateRenderer, /entryPrice|stopLoss|takeProfit/);
assert.match(css, /max-width: 100%; overflow-x: hidden/);

console.log("Watching setup explanations and scan summary tests passed.");
