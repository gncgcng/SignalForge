// A backtest the Backtesting Lab shows as "Failed" leaves one [backtest] failed line in the logs, with counts and the
// reason but no symbols. The runs below are refused before any candle load, so no database or Coinbase is touched.
import assert from "node:assert/strict";
import { handleBacktestRoutes } from "../src/modules/backtesting/backtestController.js";

const realWarn = console.warn;
const warnings = [];
console.warn = (line) => warnings.push(String(line));

function fakeResponse() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) { this.statusCode = statusCode; },
    setHeader() {},
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; }
  };
}

const user = { id: "usr_test_backtest_log", role: "tester" };
async function postRun(body) {
  const res = fakeResponse();
  const req = {
    method: "POST",
    user,
    headers: { accept: "application/x-ndjson" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); }
  };
  await handleBacktestRoutes(req, res, "/api/backtesting/run", new URL("http://localhost/api/backtesting/run"));
  return res;
}

try {
  const unsupported = await postRun({ symbols: ["NOPE-USD", "BTC-USD"], timeframes: ["1h", "4h"] });
  assert.equal(unsupported.statusCode, 400);
  const line = warnings.find((entry) => entry.startsWith("[backtest] failed"));
  assert.ok(line, "the refused run is logged");
  assert.match(line, /user=usr_test_backtest_log status=400 code=none markets=2 timeframes=2 reason=Choose at least one supported backtesting market\./);
  assert.ok(!line.includes("NOPE-USD") && !line.includes("BTC-USD"), "symbols are not logged");

  warnings.length = 0;
  const badJson = await postRun("{not json");
  assert.equal(badJson.statusCode, 400);
  assert.match(warnings[0] || "", /\[backtest\] failed .*status=400 .*markets=0 timeframes=0 reason=Request body must be valid JSON\./);

  warnings.length = 0;
  const res = fakeResponse();
  await handleBacktestRoutes({ method: "GET", user }, res, "/api/backtesting",
    new URL("http://localhost/api/backtesting?symbol=NOPE-USD&timeframe=1h"));
  assert.equal(res.statusCode, 400);
  assert.match(warnings[0] || "", /\[backtest\] failed .*status=400 .*markets=1 timeframes=1 /);
} finally {
  console.warn = realWarn;
}

console.log("backtest failure log: passed");
process.exit(0);
