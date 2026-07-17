import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");

assert.match(html, /SignalForge build:\s*<strong>AUTH-DEBUG-001<\/strong>/);
assert.match(html, /id="debug-build-page"/);
assert.match(html, /id="clear-session-page"/);
assert.match(html, /Session cleared/);
assert.match(html, /window\.localStorage\.clear\(\)/);
assert.match(html, /window\.sessionStorage\.clear\(\)/);
assert.match(html, /window\.fetch\("\/api\/auth\/logout"/);
assert.match(html, /window\.__SIGNALFORGE_BUILD_VERSION__ = buildVersion/);
assert.match(html, /window\.__SIGNALFORGE_BUILD_TIMESTAMP__ = buildTimestamp/);
assert.match(html, /hash === "#debug-build"/);
assert.match(html, /window\.setTimeout\(function \(\) \{[\s\S]*#signin[\s\S]*\}, 1000\)/);
assert.match(app, /function isDebugBuildRoute\(\)/);
assert.match(app, /function showDebugBuildPage\(\)/);
assert.match(app, /getRegistrations\(\)/);
assert.match(app, /registration\.unregister\(\)/);
assert.match(app, /key\.startsWith\("signalforge-"\)/);
assert.match(css, /\.auth-build-marker/);
assert.match(css, /\.build-debug-page/);
assert.match(server, /url\.pathname === "\/api\/debug\/ping"/);
assert.match(server, /message: "SignalForge backend is running"/);
assert.match(server, /build: appConfig\.debugBuildMarker/);
assert.match(server, /env: appConfig\.nodeEnv/);
assert.match(config, /debugBuildMarker: "AUTH-DEBUG-001"/);

for (const forbidden of ["DATABASE_URL", "STRIPE_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "password"]) {
  const pingBlock = server.slice(server.indexOf('url.pathname === "/api/debug/ping"'), server.indexOf("// Static boot assets"));
  assert.equal(pingBlock.includes(forbidden), false, `debug ping leaks ${forbidden}`);
}

console.log("Deployment build marker, public debug route, ping endpoint, and hard clear flow verified.");
