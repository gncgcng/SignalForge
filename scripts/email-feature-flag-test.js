import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appConfig } from "../src/config/appConfig.js";
import { requestPasswordReset } from "../src/modules/auth/authService.js";
import { sendTransactionalEmail } from "../src/modules/notifications/transactionalEmailService.js";

assert.equal(appConfig.email.featuresEnabled, false, "Email features must default to disabled.");

let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  providerCalls += 1;
  throw new Error("Email provider must not be called while disabled.");
};

try {
  const delivery = await sendTransactionalEmail({
    to: "trader@example.com",
    subject: "Test",
    text: "Test message",
    category: "test"
  });
  assert.deepEqual(delivery, {
    delivered: false,
    skipped: true,
    reason: "email_features_disabled"
  });
  assert.equal(providerCalls, 0);

  const reset = await requestPasswordReset("trader@example.com");
  assert.equal(reset.available, false);
  assert.match(reset.message, /Password reset by email is not available yet/);
  assert.doesNotMatch(reset.message, /sent/i);
} finally {
  globalThis.fetch = originalFetch;
}

const supportService = readFileSync("src/modules/support/supportService.js", "utf8");
const authController = readFileSync("src/modules/auth/authController.js", "utf8");
const frontend = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const server = readFileSync("src/server.js", "utf8");
const envExample = readFileSync(".env.example", "utf8");

assert.match(supportService, /createSupportTicketRecord[\s\S]*if \(appConfig\.email\.featuresEnabled\)/);
assert.match(supportService, /Support request submitted\. You can check the status here inside SignalForge\./);
assert.match(authController, /emailFeaturesEnabled: appConfig\.email\.featuresEnabled/);
assert.match(frontend, /passwordResetUnavailable/);
assert.match(html, /Password reset by email is not available yet/);
assert.match(html, /id="password-reset-contact-support"/);
assert.match(html, /Email features are currently disabled/);
assert.match(server, /logEmailConfiguration\(\)/);
assert.match(envExample, /^EMAIL_FEATURES_ENABLED=false$/m);

console.log("Email feature flag tests passed.");
