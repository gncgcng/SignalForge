import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleSupportRoutes } from "../src/modules/support/supportController.js";
import { assertPublicRecoverySubmissionAllowed } from "../src/modules/support/supportRepository.js";
import { validatePublicRecoveryInput } from "../src/modules/support/supportService.js";

const migration = readFileSync("migrations/033_public_account_recovery_support.sql", "utf8");
const repository = readFileSync("src/modules/support/supportRepository.js", "utf8");
const controller = readFileSync("src/modules/support/supportController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");

assert.match(migration, /ALTER COLUMN user_id DROP NOT NULL/);
assert.match(migration, /source text NOT NULL DEFAULT 'authenticated_support'/);
assert.match(migration, /requester_fingerprint_hash/);
assert.match(repository, /user_id, username_snapshot, email_snapshot[\s\S]*VALUES \(\$1,NULL/);
assert.match(repository, /source = 'public_account_recovery'/);
assert.match(controller, /pathname === "\/api\/support\/account-recovery"[\s\S]*if \(!req\.user\)/);

const valid = validatePublicRecoveryInput({
  email: "locked@example.com",
  username: "locked_trader",
  issueType: "Can’t sign in",
  subject: "Cannot access account",
  message: "I cannot sign in and email reset is currently unavailable."
});
assert.equal(valid.email, "locked@example.com");
assert.doesNotMatch(valid.message, /[<>]/);
assert.throws(() => validatePublicRecoveryInput({ email: "not-email" }), /valid email/);
assert.equal(assertPublicRecoverySubmissionAllowed(2), true);
assert.throws(() => assertPublicRecoverySubmissionAllowed(3), (error) => error.statusCode === 429);

const anonymousOtherSupport = mockResponse();
await handleSupportRoutes(
  { method: "GET", user: null, headers: {} },
  anonymousOtherSupport,
  "/api/support",
  new URL("http://localhost/api/support")
);
assert.equal(anonymousOtherSupport.statusCode, 401);

assert.match(html, /href="#account-recovery-support" id="password-reset-contact-support"/);
assert.match(html, /id="account-recovery-support-page"/);
assert.match(html, /Account Recovery Support/);
assert.doesNotMatch(html, /We will email a reset link if the account exists/);
assert.match(app, /showAccountRecoverySupport/);
assert.match(app, /\/api\/support\/account-recovery/);
assert.match(app, /Request submitted for review|Account recovery request submitted/);
assert.doesNotMatch(app, /showPasswordResetRequest[\s\S]{0,500}We will email a reset link if the account exists/);

console.log("Public account recovery tests passed.");

function mockResponse() {
  return {
    statusCode: null,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end() {}
  };
}
