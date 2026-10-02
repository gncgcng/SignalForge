// Local Twelve Data stand-in for integration tests: a real HTTP server on 127.0.0.1 that the real
// twelveDataMarketDataProvider talks to through TWELVEDATA_API_BASE_URL. Serves /time_series in
// Twelve Data's response shape, enforces a per-minute credit limit the way the free plan does, and
// can inject failures. Every request is logged with its arrival time.
import { createServer } from "node:http";

const intervalMs = { "5min": 300_000, "15min": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

// Default series: gently rising candles ending at `endMs`, newest first as Twelve Data returns them.
export function generateSeries({ interval, endMs = Date.now(), count = 120, startPrice = 100, step = 0.05, overrides = {} }) {
  const stepMs = intervalMs[interval];
  const lastOpen = Math.floor(endMs / stepMs) * stepMs;
  const values = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const openedAt = lastOpen - index * stepMs;
    const price = startPrice + (count - index) * step;
    const candle = { open: price, high: price + 0.5, low: price - 0.5, close: price + 0.2, ...(overrides[openedAt] || {}) };
    values.push({
      datetime: new Date(openedAt).toISOString().replace("T", " ").slice(0, 19),
      open: String(candle.open), high: String(candle.high), low: String(candle.low), close: String(candle.close)
    });
  }
  return values.reverse();
}

export async function startTwelveDataStandIn({
  port = 0,                // 0 = any free port
  creditsPerMinute = Infinity,
  windowMs = 60_000,      // the plan's credit window (Twelve Data: one minute)
  rateLimitStyle = "body", // "body": HTTP 200 + {status:"error",code:429}; "http": HTTP 429
  series = null,           // (symbol, interval) => values array (newest first); default generateSeries
  fail = null              // (symbol, interval, path) => null | { status, body }
} = {}) {
  const requests = [];
  const limits = { creditsPerMinute, windowMs, rateLimitStyle };
  let windowStart = Date.now();
  let used = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const symbol = url.searchParams.get("symbol");
    const interval = url.searchParams.get("interval");
    const entry = {
      at: Date.now(), path: url.pathname, symbol, interval, outcome: "ok",
      apikey: url.searchParams.get("apikey"), timezone: url.searchParams.get("timezone")
    };
    requests.push(entry);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (Date.now() - windowStart >= limits.windowMs) {
      windowStart = Date.now();
      used = 0;
    }
    used += 1;
    if (used > limits.creditsPerMinute) {
      entry.outcome = "rate_limited";
      const body = {
        code: 429,
        message: `You have run out of API credits for the current minute. ${used} API credits were used, with the current limit being ${limits.creditsPerMinute}. Wait for the next minute or consider switching to a higher tier plan at https://twelvedata.com/pricing`,
        status: "error"
      };
      return send(limits.rateLimitStyle === "http" ? 429 : 200, body);
    }

    const injected = fail?.(symbol, interval, url.pathname);
    if (injected) {
      entry.outcome = "injected_failure";
      return send(injected.status || 200, injected.body || { code: 500, message: "Injected failure", status: "error" });
    }

    if (url.pathname === "/api_usage") {
      return send(200, { timestamp: new Date().toISOString(), current_usage: used, plan_limit: limits.creditsPerMinute });
    }
    if (url.pathname !== "/time_series" || !intervalMs[interval]) {
      entry.outcome = "bad_request";
      return send(200, { code: 400, message: `Unsupported request ${url.pathname} ${interval}`, status: "error" });
    }

    const values = series ? series(symbol, interval) : generateSeries({ interval });
    send(200, {
      meta: { symbol, interval, currency_base: symbol, currency_quote: "US Dollar", exchange_timezone: "UTC", type: "Physical Currency" },
      values,
      status: "ok"
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    resetRequests() { requests.length = 0; },
    resetCredits() { windowStart = Date.now(); used = 0; },
    // Change the simulated plan between test phases.
    configure(next) { Object.assign(limits, next); windowStart = Date.now(); used = 0; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
