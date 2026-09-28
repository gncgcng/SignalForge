import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import {
  CANONICAL_HOST,
  HOST_REDIRECT_STATUS,
  LEGACY_HOSTS,
  REDIRECT_EXEMPT_PATHS,
  REDIRECT_SOURCE_HOSTS,
  WWW_ALIAS_HOST,
  redirectLegacyHost
} from "../src/middleware/legacyHostRedirect.js";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

// Mirrors src/server.js: the redirect runs first, everything else is "served normally".
const server = createServer((req, res) => {
  if (redirectLegacyHost(req, res)) return;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("served");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

function send(host, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

const originalFlag = process.env.LEGACY_HOST_REDIRECT;

try {
  assert.equal(CANONICAL_HOST, "signalforge-app.com");
  assert.equal(WWW_ALIAS_HOST, "www.signalforge-app.com");
  assert.deepEqual([...LEGACY_HOSTS], ["signalforge-app.xyz", "www.signalforge-app.xyz"]);
  assert.deepEqual([...REDIRECT_SOURCE_HOSTS], [...LEGACY_HOSTS, WWW_ALIAS_HOST]);
  assert.ok(!REDIRECT_SOURCE_HOSTS.includes(CANONICAL_HOST), "the canonical host must never be a redirect source");
  assert.equal(HOST_REDIRECT_STATUS, 302);

  // Flag unset (the default) means no redirect, even for the old hosts or the www alias.
  delete process.env.LEGACY_HOST_REDIRECT;
  for (const host of REDIRECT_SOURCE_HOSTS) {
    const response = await send(host, "/?ref=ABC123");
    assert.equal(response.status, 200, `${host} must not redirect with the flag unset`);
    assert.equal(response.location, undefined);
  }

  // Any value other than exactly "true" means no redirect.
  for (const value of ["", "false", "TRUE", "True", " true", "true ", "1", "yes", "on"]) {
    process.env.LEGACY_HOST_REDIRECT = value;
    for (const host of REDIRECT_SOURCE_HOSTS) {
      const response = await send(host, "/?reset=abc");
      assert.equal(response.status, 200, `${host} must not redirect with LEGACY_HOST_REDIRECT=${JSON.stringify(value)}`);
      assert.equal(response.location, undefined);
    }
  }

  // Exactly "true" enables the redirect; every case below runs with it on.
  process.env.LEGACY_HOST_REDIRECT = "true";
  const enabled = await send("signalforge-app.xyz", "/?ref=ABC123");
  assert.equal(enabled.status, 302);
  assert.equal(enabled.location, "https://signalforge-app.com/?ref=ABC123");

  // Old hosts and the www alias redirect (302) with path and query preserved.
  const redirectCases = [
    ["/", "https://signalforge-app.com/"],
    ["/?ref=ABC123", "https://signalforge-app.com/?ref=ABC123"],
    ["/?reset=tok_abc.def-123", "https://signalforge-app.com/?reset=tok_abc.def-123"],
    ["/?verify=v%2Bx%3D&next=%2Fdashboard", "https://signalforge-app.com/?verify=v%2Bx%3D&next=%2Fdashboard"],
    ["/pricing?ref=XYZ&utm_source=tg", "https://signalforge-app.com/pricing?ref=XYZ&utm_source=tg"],
    ["/api/auth/session", "https://signalforge-app.com/api/auth/session"]
  ];
  const sourceHostVariants = [
    ...REDIRECT_SOURCE_HOSTS,
    "SignalForge-App.XYZ", "signalforge-app.xyz:443", "signalforge-app.xyz.",
    "WWW.SignalForge-App.com", "www.signalforge-app.com:443", "www.signalforge-app.com."
  ];
  for (const host of sourceHostVariants) {
    for (const [path, expected] of redirectCases) {
      const response = await send(host, path);
      assert.equal(response.status, 302, `${host}${path} should redirect with 302`);
      assert.equal(response.location, expected, `${host}${path} location`);
    }
  }

  // A protocol-relative request target must not become an off-site redirect.
  for (const host of REDIRECT_SOURCE_HOSTS) {
    const protocolRelative = await send(host, "//evil.example/phish");
    assert.notEqual(protocolRelative.location?.startsWith("https://evil.example"), true);
  }

  // Exempt routes are served on every source host, including POSTs and callbacks with a query.
  for (const host of REDIRECT_SOURCE_HOSTS) {
    for (const path of REDIRECT_EXEMPT_PATHS) {
      const method = path.endsWith("/webhook") ? "POST" : "GET";
      const response = await send(host, `${path}?code=abc&state=xyz`, method);
      assert.equal(response.status, 200, `${host}${path} must not redirect`);
      assert.equal(response.location, undefined);
    }
  }
  for (const path of ["/api/stripe/webhook", "/api/subscriptions/webhook", "/api/auth/google/callback", "/api/auth/health"]) {
    assert.ok(REDIRECT_EXEMPT_PATHS.includes(path), `${path} is exempt`);
  }

  // The bare canonical host is served normally and never redirects (no loop).
  for (const host of [CANONICAL_HOST, `${CANONICAL_HOST}:443`, `${CANONICAL_HOST}.`, "SignalForge-App.com"]) {
    for (const [path] of redirectCases) {
      const response = await send(host, path);
      assert.equal(response.status, 200, `${host}${path} served`);
      assert.equal(response.location, undefined);
    }
  }

  // Unknown or lookalike hosts are never redirected.
  for (const host of [
    "evil.example",
    "signalforge-app.xyz.evil.example",
    "www.signalforge-app.com.evil.example",
    "evilsignalforge-app.xyz",
    "api.signalforge-app.xyz",
    "api.signalforge-app.com",
    "wwwsignalforge-app.com",
    "localhost:4173",
    "127.0.0.1",
    "signalforge-production.up.railway.app",
    ""
  ]) {
    const response = await send(host, "/?reset=abc");
    assert.equal(response.status, 200, `"${host}" must not redirect`);
    assert.equal(response.location, undefined);
  }

  // The real server wires the redirect in before any other handling.
  assert.match(serverSource, /import \{ redirectLegacyHost \} from "\.\/middleware\/legacyHostRedirect\.js";/);
  assert.match(serverSource, /createServer\(async \(req, res\) => \{\s*if \(redirectLegacyHost\(req, res\)\) \{\s*return;\s*\}/);

  console.log(JSON.stringify({ legacyHostRedirect: true }, null, 2));
} finally {
  if (originalFlag === undefined) delete process.env.LEGACY_HOST_REDIRECT;
  else process.env.LEGACY_HOST_REDIRECT = originalFlag;
  server.close();
}
