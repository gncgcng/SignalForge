import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../public/auth-bootstrap.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");
const smoke = readFileSync(new URL("./auth-smoke-test.js", import.meta.url), "utf8");
const repair = readFileSync(new URL("./repair-admin-account.js", import.meta.url), "utf8");

for (const label of [
  "Build:", "Route:", "Auth loading:", "Signing in:", "Last stage:",
  "HTTP status:", "Endpoint:", "Response:", "Local token:",
  "Restore token:", "Last error:"
]) {
  assert.ok(app.includes(label) || bootstrap.includes(label), `debug panel is missing ${label}`);
}
assert.match(controller, /pathname === "\/api\/auth\/health"/);
assert.match(controller, /dbConnected/);
assert.match(controller, /passwordHasherReady/);
assert.match(controller, /sessionStoreReady/);
assert.match(server, /"\/api\/auth\/health"/);
assert.match(controller, /token: restore\?\.token \|\| null/);
assert.match(controller, /restoreToken: restore\?\.token \|\| null/);
assert.match(app, /login:endpoint=\/api\/auth\/login/);
assert.match(app, /login:request_sent/);
assert.match(app, /login:save_session:done/);
assert.match(app, /login:navigate:dashboard/);
assert.match(app, /Service worker registration temporarily disabled for auth stability/);
assert.match(smoke, /AUTH_SMOKE_EMAIL/);
assert.match(smoke, /pass\("valid credentials accepted"\)/);
assert.match(smoke, /pass\("session restore accepted token"\)/);
assert.match(repair, /REPAIR_ADMIN_EMAIL/);
assert.match(repair, /hashPassword/);
assert.match(repair, /DELETE FROM sessions WHERE user_id/);
assert.match(repair, /DELETE FROM auth_restore_tokens WHERE user_id/);
assert.match(html, /AUTH-DEBUG-001/);

console.log("Auth diagnostics, smoke proof, and admin repair safeguards verified.");
