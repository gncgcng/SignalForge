import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRouteHash, parseAppHash } from "../public/router.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const route = parseAppHash("#how-it-works");
assert.equal(route.valid, true);
assert.equal(route.route, "how-it-works");
assert.equal(buildRouteHash("how-it-works"), "#how-it-works");

assert.match(html, /id="public-how-it-works-page"/);
assert.match(html, /data-view="how-it-works"/);
assert.match(html, /data-view-link="how-it-works"/);
assert.match(html, /data-public-how-it-works/);
assert.match(html, /Built for structured trading, not hype\./);
assert.match(html, /See how credits and signals work/);

assert.match(app, /function renderHowItWorksContent\(\)/);
assert.match(app, /function showPublicHowItWorks\(/);
assert.match(app, /history\.replaceState\(\{\}, "", `\$\{location\.pathname\}\$\{location\.search\}#scanner`\)/);
assert.match(app, /What it does not do/);
assert.match(app, /Watching setups/);
assert.match(app, /Avoid trade zones/);
assert.match(app, /Unlocks and credits/);
assert.match(app, /Paper trading/);
assert.match(app, /Risk management/);
assert.match(app, /Learning engine/);
assert.match(app, /It is not a probability of profit\./);
assert.match(app, /Confidence reflects rule alignment and setup quality\. It is not a win probability\./);
assert.match(app, /function renderMobileSignalConfidence\(/);
assert.match(app, /New to SignalForge\?[^]*data-how-it-works-link/);
assert.match(app, /SignalForge is an educational market analysis tool\. It is not financial advice, investment advice, or a guarantee of results\./);

const trustPage = app.slice(app.indexOf("function renderHowItWorksContent"), app.indexOf("function renderTrustCard"));
for (const banned of [
  "guaranteed profits",
  "AI predicts the market",
  "high win rate",
  "safe trade",
  "sure signal",
  "risk-free"
]) {
  assert.equal(trustPage.toLowerCase().includes(banned.toLowerCase()), false, `Trust page contains banned claim: ${banned}`);
}

assert.match(css, /\.public-trust-page\s*\{[^}]*overflow-x:\s*hidden/s);
assert.match(css, /@media \(max-width: 767px\)[^]*\.trust-actions button\s*\{[^}]*width:\s*100%/);
assert.match(css, /\.confidence-tooltip/);

console.log("How SignalForge Works trust page tests passed.");
