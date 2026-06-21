import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertSignupVelocity,
  calculateSignupAbuseScore,
  getEmailDomain,
  isDisposableEmail
} from "../src/modules/auth/abuseProtectionService.js";

const migration = readFileSync(new URL("../migrations/012_anti_abuse_protection.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const authService = readFileSync(new URL("../src/modules/auth/authService.js", import.meta.url), "utf8");
const authController = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");
const subscriptionService = readFileSync(
  new URL("../src/modules/subscriptions/subscriptionService.js", import.meta.url),
  "utf8"
);
const signalService = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const testerController = readFileSync(
  new URL("../src/modules/tester-access/testerAccessController.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

assert.equal(getEmailDomain("Person@Example.COM"), "example.com");
assert.equal(isDisposableEmail("person@mailinator.com"), true);
assert.equal(isDisposableEmail("person@example.com"), false);

const repeatedDevice = calculateSignupAbuseScore({
  attemptsLastHour: 1,
  accountsLastDay: 1,
  accountsLastWeek: 1,
  repeatedDevice: true,
  disposableEmail: false
});
assert.equal(repeatedDevice.reviewStatus, "flagged");
assert.ok(repeatedDevice.flags.includes("repeated_trial_device"));

assert.throws(
  () => assertSignupVelocity({ attemptsLastHour: 0, accountsLastDay: 3, accountsLastWeek: 3 }),
  (error) => error.statusCode === 429 && /Daily/.test(error.message)
);

const result = {
  safeMigration: migration.includes("ADD COLUMN IF NOT EXISTS email_verified_at") &&
    migration.includes("ADD COLUMN IF NOT EXISTS trial_used") &&
    migration.includes("CREATE TABLE IF NOT EXISTS device_trial_history") &&
    migration.includes("ON DELETE SET NULL") &&
    !migration.includes("DELETE FROM users"),
  freeTrialRequiresVerification: authService.includes("freeSignalAllowance: options.bypassVerification ?") &&
    authService.includes("freeSignalAllowance: 0") === false &&
    subscriptionService.includes("!user.emailVerifiedAt") &&
    repositories.includes("email_verified_at = COALESCE(email_verified_at, now())") &&
    signalService.includes("EMAIL_VERIFICATION_REQUIRED"),
  trialUseIsPermanent: repositories.includes("trial_used = true") &&
    repositories.includes("UPDATE device_trial_history"),
  temporaryRateLimits: authService.includes("assertSignupVelocity") &&
    repositories.includes("created_at >= now() - interval '1 day'") &&
    repositories.includes("created_at >= now() - interval '7 days'"),
  deviceTrialDeduplicated: repositories.includes("ON CONFLICT (device_fingerprint_hash) DO NOTHING") &&
    repositories.includes("repeated_trial_device"),
  disposableEmailBlocked: authService.includes("isDisposableEmail") &&
    authService.includes("Temporary or disposable email addresses are not supported."),
  verificationRoutes: authController.includes("/api/auth/verify-email") &&
    authController.includes("/api/auth/resend-verification"),
  serverSideAdminProtection: testerController.includes('pathname.startsWith("/api/admin/")') &&
    testerController.includes('pathname === "/api/admin/abuse"'),
  adminVisibility: html.includes("Accounts per IP") &&
    html.includes("Repeated devices") &&
    html.includes("Disposable emails") &&
    frontend.includes("state.user.isAdmin"),
  fingerprintNotStoredAsAuth: frontend.includes('"x-device-fingerprint": getDeviceFingerprint()') &&
    frontend.includes("navigator.userAgent") &&
    !frontend.includes('localStorage.setItem("signalforge-device')
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Anti-abuse check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
