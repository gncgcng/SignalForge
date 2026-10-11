// Real-layout test for the dashboard sidebar: in headless Chrome, with the real index.html, styles.css and
// app.js booted against a stubbed session, every expanded nav section must show every one of its links in
// full — nothing below a height cap or outside the section's visible box. Runs for a regular user and an
// admin at desktop 1024x768 and mobile 375x812; also checks the Administration section is admin-only and
// that collapsing still takes a section to zero height.
//
// Needs Chrome or Edge (CHROME_PATH overrides the lookup). Talks to it over the DevTools protocol with
// Node's built-in WebSocket: no npm dependencies.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const ADMIN_LINKS = ["Admin", "Admin Signals", "Crypto Markets", "Support Tickets", "Affiliate Admin", "Webhook Events", "Promo Codes"];
const VIEWPORTS = [
  { name: "desktop 1024x768", width: 1024, height: 768, mobile: false },
  { name: "mobile 375x812", width: 375, height: 812, mobile: true }
];
const USERS = {
  regular: { id: "usr_layout_regular", email: "layout-regular@example.test", name: "Layout Regular", username: "layout_regular", role: "user", plan: "free", isAdmin: false },
  admin: { id: "usr_layout_admin", email: "layout-admin@example.test", name: "Layout Admin", username: "layout_admin", role: "user", plan: "free", isAdmin: true }
};

const browserPath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].find((path) => path && existsSync(path));
if (!browserPath) {
  console.log("Sidebar layout test SKIPPED: no Chrome/Edge found (set CHROME_PATH to run it).");
  process.exit(0);
}

// ---------- static server for public/ with a stubbed API ----------
let sessionUser = null;
const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (pathname === "/api/auth/session") return json(200, { user: sessionUser });
  if (pathname === "/api/auth/config") return json(200, { googleEnabled: false });
  if (pathname.startsWith("/api/")) return json(404, { ok: false, error: "not stubbed in layout test" });
  const file = normalize(join(publicDir, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(normalize(publicDir)) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": mimeTypes[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- headless Chrome over CDP ----------
const profileDir = mkdtempSync(join(tmpdir(), "sf-sidebar-layout-"));
const chrome = spawn(browserPath, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
const browserWsUrl = await new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${output.slice(-400)}`)), 20000);
  chrome.stderr.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  chrome.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${output.slice(-400)}`)));
});
const socket = new WebSocket(browserWsUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPage({ user, viewport }) {
  sessionUser = user;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile }, sessionId);
  await send("Page.navigate", { url: `${origin}/#scanner` }, sessionId);
  const deadline = Date.now() + 20000;
  for (;;) {
    const booted = await evaluate(`Boolean(document.querySelector("#dashboard") && !document.querySelector("#dashboard").classList.contains("hidden") && document.querySelector("#user-name")?.textContent.trim())`).catch(() => false);
    if (booted) break;
    if (Date.now() > deadline) throw new Error(`dashboard did not boot for ${user.email} at ${viewport.name}`);
    await sleep(150);
  }
  return { evaluate, close: () => send("Target.closeTarget", { targetId }) };
}

// Expands every section, waits out the transition, and reports each rendered link against its section's box.
const MEASURE = `(async () => {
  document.querySelectorAll("[data-nav-section]").forEach((section) => section.classList.remove("collapsed"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sidebar = document.querySelector(".sidebar");
  return {
    sidebarOverflowY: getComputedStyle(sidebar).overflowY,
    sidebarScrolls: sidebar.scrollHeight > sidebar.clientHeight + 1,
    sections: [...document.querySelectorAll("[data-nav-section]")].map((section) => {
      const box = section.querySelector(".nav-section-links");
      const shown = section.getClientRects().length > 0;
      const clip = box.getBoundingClientRect();
      const links = [...box.querySelectorAll("a")].filter((link) => link.getClientRects().length > 0).map((link) => {
        const rect = link.getBoundingClientRect();
        return { label: link.textContent.trim(), clipped: rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5 || rect.height < 1 };
      });
      return { name: section.dataset.navSection, label: section.querySelector("[data-nav-section-toggle]")?.textContent.trim(), shown, overflowing: box.scrollHeight > box.clientHeight + 1, links };
    })
  };
})()`;
const COLLAPSE_FIRST_VISIBLE = `(async () => {
  const section = [...document.querySelectorAll("[data-nav-section]")].filter((item) => item.getClientRects().length).at(-1);
  section.classList.add("collapsed");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const box = section.querySelector(".nav-section-links");
  const style = getComputedStyle(box);
  const result = { name: section.dataset.navSection, height: box.getBoundingClientRect().height, visibility: style.visibility };
  section.classList.remove("collapsed");
  return result;
})()`;

const passed = [];
const failures = [];
try {
  for (const viewport of VIEWPORTS) {
    for (const [role, user] of Object.entries(USERS)) {
      const label = `${role} @ ${viewport.name}`;
      const page = await openPage({ user, viewport });
      try {
        const layout = await page.evaluate(MEASURE);
        const shown = layout.sections.filter((section) => section.shown);
        // 1. Nothing clipped in any expanded section.
        for (const section of shown) {
          const clipped = section.links.filter((link) => link.clipped).map((link) => link.label);
          if (clipped.length || section.overflowing) {
            failures.push(`${label}: "${section.label}" section clips ${clipped.length ? clipped.join(", ") : "its content"} (links box is shorter than its links)`);
          }
        }
        // 2. Administration: only admins see it, with all seven links; nobody sees admin links elsewhere.
        const adminSection = shown.find((section) => section.name === "admin");
        const adminLinksElsewhere = shown.filter((section) => section.name !== "admin").flatMap((section) => section.links.map((link) => link.label)).filter((name) => ADMIN_LINKS.includes(name));
        if (user.isAdmin) {
          if (!adminSection) failures.push(`${label}: no "Administration" sidebar section`);
          else if (JSON.stringify(adminSection.links.map((link) => link.label)) !== JSON.stringify(ADMIN_LINKS)) failures.push(`${label}: Administration shows ${adminSection.links.map((link) => link.label).join(", ")}`);
          if (adminSection && adminSection.label !== "Administration") failures.push(`${label}: admin section is labelled "${adminSection.label}"`);
        } else if (adminSection || adminLinksElsewhere.length) {
          failures.push(`${label}: a regular user sees admin navigation (${adminLinksElsewhere.join(", ") || "Administration section"})`);
        }
        if (user.isAdmin && adminLinksElsewhere.length) failures.push(`${label}: admin links outside Administration: ${adminLinksElsewhere.join(", ")}`);
        // 3. On mobile the drawer must scroll if the nav is taller than the screen.
        if (viewport.mobile && layout.sidebarScrolls && !["auto", "scroll"].includes(layout.sidebarOverflowY)) {
          failures.push(`${label}: the sidebar drawer is taller than the screen but does not scroll`);
        }
        // 4. Collapsing still goes to zero and hides the links.
        const collapsed = await page.evaluate(COLLAPSE_FIRST_VISIBLE);
        if (collapsed.height > 0.5 || collapsed.visibility !== "hidden") {
          failures.push(`${label}: collapsed "${collapsed.name}" section is ${collapsed.height}px tall, visibility ${collapsed.visibility}`);
        }
        passed.push(`${label}: ${shown.map((section) => `${section.label} ${section.links.length}`).join(" · ")}`);
      } finally {
        await page.close();
      }
    }
  }
} finally {
  socket.close();
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

assert.deepEqual(failures, [], `Sidebar layout failures:\n  ${failures.join("\n  ")}`);
console.log(`Sidebar layout tests passed (${passed.length} renders, ${browserPath.split(/[\\/]/).pop()}):\n${passed.map((line) => `  ok ${line}`).join("\n")}`);
process.exit(0);
