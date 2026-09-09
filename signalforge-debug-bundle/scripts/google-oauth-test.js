import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:4173/api/auth/google/callback";

const {
  validateGoogleIdToken,
  validateOAuthStateCookie
} = await import("../src/modules/auth/googleOAuthService.js");

const migration = readFileSync(new URL("../migrations/016_google_oauth.sql", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");
const controller = readFileSync(
  new URL("../src/modules/auth/authController.js", import.meta.url),
  "utf8"
);
const service = readFileSync(
  new URL("../src/modules/auth/googleOAuthService.js", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "google-test-key",
  alg: "RS256",
  use: "sig"
};
const nonce = "nonce-from-server-state";
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: "https://accounts.google.com",
  aud: process.env.GOOGLE_CLIENT_ID,
  sub: "google-subject-123",
  email: "trader@example.com",
  email_verified: true,
  name: "Signal Trader",
  nonce,
  iat: now,
  exp: now + 3600
};

function createIdToken(payload) {
  const header = Buffer.from(JSON.stringify({
    alg: "RS256",
    typ: "JWT",
    kid: jwk.kid
  })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${body}`),
    privateKey
  ).toString("base64url");
  return `${header}.${body}.${signature}`;
}

const validated = await validateGoogleIdToken(createIdToken(claims), nonce, [jwk]);
let wrongAudienceRejected = false;
let wrongNonceRejected = false;

try {
  await validateGoogleIdToken(createIdToken({ ...claims, aud: "other-client" }), nonce, [jwk]);
} catch (error) {
  wrongAudienceRejected = error.oauthCode === "invalid_token";
}
try {
  await validateGoogleIdToken(createIdToken(claims), "wrong-nonce", [jwk]);
} catch (error) {
  wrongNonceRejected = error.oauthCode === "invalid_token";
}

const result = {
  safeOAuthMigration:
    migration.includes("CREATE TABLE IF NOT EXISTS oauth_login_states") &&
    migration.includes("CREATE TABLE IF NOT EXISTS oauth_accounts") &&
    migration.includes("PRIMARY KEY (provider, provider_subject)") &&
    !/\bDELETE\s+FROM\b/i.test(migration) &&
    !/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration),
  exactEnvironmentVariables:
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]
      .every((key) => config.includes(`process.env.${key}`) && envExample.includes(`${key}=`)),
  productionAndLocalRedirects:
    config.includes("https://signalforge-app.xyz/api/auth/google/callback") &&
    envExample.includes(
      "GOOGLE_REDIRECT_URI=http://localhost:4173/api/auth/google/callback"
    ),
  backendSignatureValidation:
    validated.sub === claims.sub &&
    service.includes('header.alg !== "RS256"') &&
    service.includes("createPublicKey({ key: jwk, format: \"jwk\" })") &&
    service.includes("verifySignature("),
  claimsValidated:
    wrongAudienceRejected &&
    wrongNonceRejected &&
    service.includes("claims.email_verified !== true") &&
    service.includes("claims.exp"),
  csrfAndReplayProtection:
    migration.includes("used_at timestamptz") &&
    repositories.includes("FOR UPDATE") &&
    repositories.includes("SET used_at = now()") &&
    controller.includes("HttpOnly") &&
    controller.includes("SameSite=Lax") &&
    validateOAuthStateCookie("state", "state") &&
    !validateOAuthStateCookie("", ""),
  existingEmailLinked:
    service.indexOf("findUserByEmail(normalizedEmail)") <
      service.indexOf("createGoogleUser(claims, loginState)") &&
    service.includes("linkOAuthIdentity({") &&
    repositories.includes("UPDATE users") &&
    repositories.includes("email_verified_at = COALESCE"),
  newUserGetsNormalPlan:
    service.includes("freeSignalAllowance: 0") &&
    service.includes("grantOAuthFreeTrial") &&
    repositories.includes("unlock_credits_balance = GREATEST"),
  existingDataPreserved:
    !service.includes("UPDATE saved_signals") &&
    !service.includes("DELETE FROM users") &&
    migration.includes("user_id text NOT NULL REFERENCES users"),
  frontendDoesNotSupplyIdentity:
    html.includes('id="google-auth-button"') &&
    app.includes("Continue with Google") &&
    app.includes("/api/auth/google/start") &&
    app.includes("authorizationUrl") &&
    !app.includes("google.email") &&
    !app.includes("google.sub"),
  clearErrors:
    app.includes("googleOAuthErrorMessage") &&
    app.includes("Google identity verification failed.") &&
    controller.includes("oauth_error=")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Google OAuth check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
