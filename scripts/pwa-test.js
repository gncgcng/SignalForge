import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8")
);
const serviceWorker = readFileSync(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8"
);
const offline = readFileSync(new URL("../public/offline.html", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

const icon192 = readPng("../public/icons/icon-192.png");
const icon512 = readPng("../public/icons/icon-512.png");
const maskable512 = readPng("../public/icons/icon-maskable-512.png");
const apple180 = readPng("../public/icons/apple-touch-icon.png");

const result = {
  installableManifest:
    manifest.name === "SignalForge" &&
    manifest.start_url === "/?source=pwa" &&
    manifest.scope === "/" &&
    manifest.display === "standalone" &&
    manifest.icons.some((icon) => icon.sizes === "192x192") &&
    manifest.icons.some((icon) => icon.sizes === "512x512") &&
    manifest.icons.some((icon) => icon.purpose === "maskable"),
  desktopAndMobileMetadata:
    html.includes('rel="manifest"') &&
    html.includes('rel="apple-touch-icon"') &&
    html.includes('apple-mobile-web-app-capable') &&
    html.includes('name="theme-color"'),
  validRasterIcons:
    icon192.width === 192 && icon192.height === 192 &&
    icon512.width === 512 && icon512.height === 512 &&
    maskable512.width === 512 && maskable512.height === 512 &&
    apple180.width === 180 && apple180.height === 180,
  staticAssetsCached:
    serviceWorker.includes("caches.open(CACHE_VERSION)") &&
    serviceWorker.includes('"/styles.css"') &&
    serviceWorker.includes('"/app.js"') &&
    serviceWorker.includes('"/manifest.json"'),
  authenticatedApisNeverCached:
    serviceWorker.includes('url.pathname.startsWith("/api/")') &&
    serviceWorker.includes('request.method !== "GET"'),
  offlineFallback:
    serviceWorker.includes('caches.match(OFFLINE_URL)') &&
    offline.includes("SignalForge is offline") &&
    offline.includes("Try again"),
  installPrompt:
    app.includes('"beforeinstallprompt"') &&
    app.includes("deferredInstallPrompt.prompt()") &&
    app.includes('"appinstalled"') &&
    html.includes('id="install-app-button"'),
  splashScreen:
    html.includes('id="app-splash"') &&
    styles.includes(".app-splash") &&
    app.includes(".finally(hideSplash)"),
  pushReady:
    serviceWorker.includes('self.addEventListener("push"') &&
    serviceWorker.includes('self.addEventListener("notificationclick"') &&
    app.includes("window.signalForgePushRegistration = registration"),
  serverSupport:
    server.includes('".png": "image/png"') &&
    server.includes('"service-worker-allowed"') &&
    server.includes('"cache-control"] = "no-cache, no-store, must-revalidate"') &&
    server.includes("Static asset not found.")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `PWA check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));

function readPng(relativePath) {
  const buffer = readFileSync(new URL(relativePath, import.meta.url));
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}
