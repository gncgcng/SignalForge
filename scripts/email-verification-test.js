import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.APP_URL = "http://localhost:4173";

const {
  canDiscoverSetups,
  canGenerateSignal
} = await import("../src/modules/subscriptions/subscriptionService.js");

const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const authService = readFileSync(
  new URL("../src/modules/auth/authService.js", import.meta.url),
  "utf8"
);
const authController = readFileSync(
  new URL("../src/modules/auth/authController.js", import.meta.url),
  "utf8"
);
const googleOAuth = readFileSync(
  new URL("../src/modules/auth/googleOAuthService.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const baseUser = {
  id: "usr_verification_test",
  email: "trader@example.com",
  role: "user",
  plan: "free",
  emailVerifiedAt: null,
  unlockCreditsBalance: 50,
  paidCredits: 50,
  discoveriesToday: 0,
  subscription: {
    status: "trialing",
    providerCustomerId: null,
    stripeMode: null
  }
};

const tester = { ...baseUser, role: "tester" };
const verified = { ...baseUser, emailVerifiedAt: new Date() };

const result = {
  unverifiedCreditsBlocked:
    canGenerateSignal(baseUser) === false &&
    canDiscoverSetups(baseUser) === false,
  verifiedCreditsAllowed:
    canGenerateSignal(verified) === true &&
    canDiscoverSetups(verified) === true,
  testersRemainUnlimited:
    canGenerateSignal(tester) === true &&
    canDiscoverSetups(tester) === true,
  atomicDatabaseGuards:
    repositories.includes("u.email_verified_at, c.unlock_credits_balance") &&
    repositories.includes("Verify your email before using signal unlock credits.") &&
    repositories.includes("SELECT u.role, u.email_verified_at") &&
    repositories.includes("Verify your email before using setup discovery credits."),
  trialGrantedOnlyAfterVerification:
    repositories.includes("verifyEmailToken") &&
    repositories.includes("UPDATE users SET email_verified_at") &&
    repositories.includes("unlock_credits_balance = GREATEST") &&
    authService.includes("emailVerifiedAt: options.bypassVerification ? new Date() : null") &&
    authService.includes("freeSignalAllowance: options.bypassVerification ?"),
  resendSupportedAndThrottled:
    authController.includes("/api/auth/resend-verification") &&
    authService.includes("enforceCooldown: true") &&
    repositories.includes("VERIFICATION_RESEND_LIMIT") &&
    envExample.includes("EMAIL_VERIFICATION_RESEND_SECONDS=60"),
  googleVerifiedAccountsSupported:
    googleOAuth.includes("claims.email_verified !== true") &&
    googleOAuth.includes("verificationWasRequired") &&
    googleOAuth.includes("grantOAuthFreeTrial(user.id, loginState.deviceFingerprintHash)") &&
    repositories.includes("email_verified_at = COALESCE(email_verified_at, now())"),
  callbackFeedbackVisible:
    frontend.includes("showAuthCallback") &&
    frontend.includes("Email verified. Your free signals are active.")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Email verification check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
