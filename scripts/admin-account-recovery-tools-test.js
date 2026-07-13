import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hashPassword } from "../src/modules/auth/authService.js";
import { handleSupportRoutes } from "../src/modules/support/supportController.js";

const migration = readFileSync("migrations/034_support_recovery_admin_tools.sql", "utf8");
const repository = readFileSync("src/modules/support/supportRepository.js", "utf8");
const service = readFileSync("src/modules/support/supportService.js", "utf8");
const controller = readFileSync("src/modules/support/supportController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");

assert.match(migration, /public_response text NOT NULL DEFAULT ''/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_support_audit_log/);
assert.match(repository, /account_lookup/);
assert.match(repository, /temporary_password_set/);
assert.match(repository, /sessions_revoked/);
assert.match(repository, /DELETE FROM sessions WHERE user_id = \$1/);
assert.match(repository, /UPDATE auth_restore_tokens SET revoked_at/);
assert.match(repository, /password_salt = \$2, password_hash = \$3/);
assert.match(repository, /lower\(u\.email\) = lower\(t\.email_snapshot\)/);
assert.match(app, /Username-only match/);
assert.doesNotMatch(repository, /temporaryPassword/);
assert.match(service, /assertAdmin\(admin\)/);
assert.match(controller, /account-recovery\\\/\(lookup\|temporary-password\|revoke-sessions\)/);

const password = hashPassword("TemporaryAccess123");
assert.notEqual(password.hash, "TemporaryAccess123");
assert.equal(password.hash.length, 64);
assert.ok(password.salt.length >= 32);

const nonAdmin = mockResponse();
await handleSupportRoutes(
  { method: "GET", user: { id: "usr_normal", email: "normal@example.com" }, headers: {} },
  nonAdmin,
  "/api/admin/support/ticket_1/account-recovery/lookup",
  new URL("http://localhost/api/admin/support/ticket_1/account-recovery/lookup")
);
assert.equal(nonAdmin.statusCode, 403);

assert.match(html, /class="recovery-brand"/);
assert.match(html, /Do not include your password or security codes/);
assert.match(css, /\.public-recovery-page[\s\S]*overflow-x: hidden/);
assert.match(css, /\.public-recovery-shell[\s\S]*620px/);
assert.match(app, /Account Recovery Tools/);
assert.match(app, /Public response/);
assert.match(app, /Internal admin notes/);
assert.match(app, /Recovery request submitted for admin review/);
assert.doesNotMatch(app, /Recovery request submitted[\s\S]{0,160}(email|inbox|reset link was sent)/i);

console.log("Admin account recovery tool tests passed.");

function mockResponse() {
  return {
    statusCode: null,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end() {}
  };
}
