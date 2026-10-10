// The calibration tab must not offer disabled_by_admin for groups a live signal never carries (market_regime,
// source), and the API must refuse it with a 400 so the UI can't be bypassed. DB transport mocked; no network.
process.env.ADMIN_EMAILS = "admin@example.test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

const db = await import("./test-support/admin-disabled-db-transport.mock.js");
const {
  SIGNAL_GROUP_TYPES,
  canDisableGroupType,
  getAdminSignalQualityBreakdown,
  signalGroupTypesFor,
  updateSignalGroupStatus
} = await import("../src/modules/signals/signalConfidenceCalibrationService.js");
const { handleAdminGeneratedSignalRoutes } = await import("../src/modules/admin-signals/generatedSignalController.js");

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const NOT_SIGNAL_GROUPS = ["market_regime:range", "source:auto_crypto_watcher"];

await check("the disable allowlist is exactly the group types a live signal carries", () => {
  const types = signalGroupTypesFor({ symbol: "BTC-USD", timeframe: "15m", direction: "long", setupType: "Momentum breakout", confidenceScore: 85, patternContext: { pattern: "bull flag" } });
  assert.deepEqual([...types].sort(), [...SIGNAL_GROUP_TYPES].sort());
  assert.equal(canDisableGroupType("market_regime"), false);
  assert.equal(canDisableGroupType("source"), false);
  assert.equal(canDisableGroupType("Strategy"), true);
});

// ---------- service ----------
db.clearStatusWrites();
for (const groupKey of [...NOT_SIGNAL_GROUPS, "Market_Regime:Trend Up"]) {
  await check(`updateSignalGroupStatus refuses disabled_by_admin for ${groupKey} with a 400 and writes nothing`, async () => {
    await assert.rejects(
      updateSignalGroupStatus({ groupKey, status: "disabled_by_admin" }),
      (error) => error.statusCode === 400 && /can't be disabled: not a signal group\./.test(error.message)
    );
  });
}
await check("refused updates never reach signal_strategy_statuses", () => assert.deepEqual(db.getStatusWrites(), []));
await check("other statuses for those groups, and disabled_by_admin for signal groups, still save", async () => {
  await updateSignalGroupStatus({ groupKey: "market_regime:range", status: "watchlist" });
  await updateSignalGroupStatus({ groupKey: "source:auto_crypto_watcher", status: "active" });
  await updateSignalGroupStatus({ groupKey: "strategy:momentum-breakout", status: "disabled_by_admin" });
  await updateSignalGroupStatus({ groupKey: "pair:ltc-usd", status: "disabled_by_admin" });
  assert.deepEqual(db.getStatusWrites().map((write) => [write.groupKey, write.status]), [
    ["market_regime:range", "watchlist"],
    ["source:auto_crypto_watcher", "active"],
    ["strategy:momentum-breakout", "disabled_by_admin"],
    ["pair:ltc-usd", "disabled_by_admin"]
  ]);
});

// ---------- API route ----------
async function postStatus(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.user = { id: "admin-1", email: "admin@example.test" };
  const res = { statusCode: null, body: null, writeHead(code) { this.statusCode = code; }, end(payload) { this.body = JSON.parse(payload); } };
  await handleAdminGeneratedSignalRoutes(req, res, "/api/admin/signals/quality/status", new URL("http://localhost/api/admin/signals/quality/status"));
  return res;
}
await check("POST /api/admin/signals/quality/status returns 400 for disabled_by_admin on market_regime and source", async () => {
  for (const groupKey of NOT_SIGNAL_GROUPS) {
    const res = await postStatus({ groupKey, status: "disabled_by_admin" });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error.message, /can't be disabled: not a signal group\./);
  }
});
await check("POST /api/admin/signals/quality/status still returns 200 for disabled_by_admin on a strategy", async () => {
  const res = await postStatus({ groupKey: "strategy:momentum-breakout", status: "disabled_by_admin" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

// ---------- breakdown sent to the tab ----------
db.setAggregateRows([{ group_value: "x", total_signals: 12, active: 0, hit_tp: 4, hit_sl: 6, expired: 2, average_rr: 2, average_confidence: 80, average_realized_r: 0.1, last_7_days: 12, last_30_days: 12 }]);
const breakdown = await getAdminSignalQualityBreakdown();
db.setAggregateRows([]);
await check("every group in the calibration breakdown says whether it can be disabled", () => {
  const byType = Object.fromEntries(breakdown.groups.map((group) => [group.groupType, group.canDisable]));
  assert.deepEqual(byType, {
    strategy: true, pair: true, timeframe: true, direction: true, pattern: true,
    source: false, market_regime: false, confidence_bucket: true, pair_timeframe: true
  });
  assert.ok(breakdown.bestMarketRegimes.every((group) => group.canDisable === false));
  assert.ok(breakdown.bestSources.every((group) => group.canDisable === false));
});

// ---------- calibration tab rendering (the real functions from public/app.js) ----------
const render = loadAppFunctions(["escapeHtml", "titleCase", "renderSignalQualityGroupList", "renderBestSignalQualityActions", "renderWorstSignalQualityActions"]);
const group = (groupType, groupValue) => breakdown.groups.find((item) => item.groupType === groupType) && { ...breakdown.groups.find((item) => item.groupType === groupType), groupKey: `${groupType}:${groupValue}`, groupValue };
await check("tab: market_regime and source rows offer no Disable and show the note, in worst and best lists", () => {
  for (const item of [group("market_regime", "range"), group("source", "auto_crypto_watcher")]) {
    for (const mode of ["worst", "best"]) {
      const html = render.renderSignalQualityGroupList("Groups", [item], mode);
      assert.doesNotMatch(html, /data-signal-quality-status="disabled_by_admin"/);
      assert.match(html, /Can't be disabled: not a signal group\./);
    }
    assert.match(render.renderSignalQualityGroupList("Groups", [item], "worst"), /data-signal-quality-status="quarantined"/, "other actions stay");
  }
});
await check("tab: signal groups still offer Disable and show no note", () => {
  for (const item of [group("strategy", "momentum-breakout"), group("direction", "short"), group("pair", "ltc-usd")]) {
    const html = render.renderSignalQualityGroupList("Groups", [item], "worst");
    assert.match(html, new RegExp(`data-signal-quality-status="disabled_by_admin" data-group-key="${item.groupKey}"`));
    assert.doesNotMatch(html, /Can't be disabled/);
  }
});

console.log(`Calibration disable guard tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);

// Pulls named top-level functions out of public/app.js (a browser script) and evaluates them together.
function loadAppFunctions(names) {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const bodies = names.map((name) => {
    const start = source.indexOf(`\nfunction ${name}(`);
    assert.ok(start >= 0, `public/app.js has no function ${name}`);
    let depth = 0;
    for (let index = source.indexOf("{", start); index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unbalanced braces in ${name}`);
  });
  return new Function(`${bodies.join("\n")}\nreturn { ${names.join(", ")} };`)();
}
