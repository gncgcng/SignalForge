// Real signup flows for trial tests: email signup + clicking the verification link, Google signup
// through the OAuth service (Google's token/JWKS endpoints stubbed), spending unlocks through the
// credit ledger, and deleting through the account-deletion transaction.
// The importing test must import ./require-local-database.js first and set env before importing.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const { appConfig } = await import("../../src/config/appConfig.js");
const { query, transaction } = await import("../../src/db/client.js");
const { registerOrLogin, verifyEmail } = await import("../../src/modules/auth/authService.js");
const { createVerificationToken } = await import("../../src/modules/auth/emailVerificationService.js");
const { completeGoogleOAuth, startGoogleOAuth } = await import("../../src/modules/auth/googleOAuthService.js");
const { createEmailVerificationToken } = await import("../../src/db/repositories.js");
const { consumeSignalUnlockCredit } = await import("../../src/modules/credits/signalCreditLedgerRepository.js");
const { deleteAccountData } = await import("../../src/modules/account-deletion/accountDeletionRepository.js");

export const runTag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
export const createdUserIds = [];
let requestCount = 0;

// Each signup comes from its own IP so the per-IP signup velocity limits never interfere.
function fakeRequest() {
  requestCount += 1;
  return { headers: { "x-forwarded-for": `10.77.${randomBytes(1)[0]}.${requestCount % 250}` }, socket: {} };
}

export function device(label) {
  return `trial-device-${runTag}-${label}`;
}

export async function unlocks(userId) {
  return Number((await query(`SELECT unlock_credits_balance FROM credit_balances WHERE user_id = $1`, [userId])).rows[0].unlock_credits_balance);
}

// Email signup, then the user clicks the verification link (the only point an email account is
// granted its free unlocks).
export async function emailSignup({ email, deviceFingerprint, password = "trial-test-password" }) {
  const signup = await registerOrLogin({
    email,
    password,
    deviceFingerprint,
    legalConsentAccepted: true,
    ageConfirmed: true,
    intent: "signup"
  }, fakeRequest());
  createdUserIds.push(signup.user.id);
  const token = createVerificationToken();
  await createEmailVerificationToken(signup.user.id, token.tokenHash, token.expiresAt);
  const verified = await verifyEmail(token.token);
  return { userId: signup.user.id, signup, verified, unlocks: await unlocks(signup.user.id) };
}

// --- Google, with only Google's own endpoints stubbed.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "trial-test-key", alg: "RS256", use: "sig" };
const issuedCodes = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === appConfig.googleOAuth.jwksUrl) {
    return Response.json({ keys: [jwk] }, { headers: { "cache-control": "max-age=3600" } });
  }
  if (url === appConfig.googleOAuth.tokenUrl) {
    const claims = issuedCodes.get(new URLSearchParams(String(init.body)).get("code"));
    return claims ? Response.json({ id_token: signIdToken(claims) }) : Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  return realFetch(input, init);
};

export function restoreFetch() {
  globalThis.fetch = realFetch;
}

function signIdToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}

export async function googleSignup({ sub, email, deviceFingerprint }) {
  const { authorizationUrl, state } = await startGoogleOAuth(fakeRequest(), deviceFingerprint, null, {
    legalConsentAccepted: true,
    ageConfirmed: true
  });
  const code = `code_${randomBytes(12).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  issuedCodes.set(code, {
    iss: "https://accounts.google.com",
    aud: appConfig.googleOAuth.clientId,
    sub,
    email,
    email_verified: true,
    name: "Trial Tester",
    nonce: new URL(authorizationUrl).searchParams.get("nonce"),
    iat: now,
    exp: now + 3600
  });
  const session = await completeGoogleOAuth({ code, state });
  createdUserIds.push(session.user.id);
  return { userId: session.user.id, session, unlocks: await unlocks(session.user.id) };
}

// Spends unlocks the way a real signal unlock does: one ledger charge per saved signal.
export async function spendUnlocks(userId, count) {
  await transaction(async (client) => {
    for (let index = 0; index < count; index += 1) {
      const signalId = `sig_trialtest_${userId}_${index}`;
      await client.query(`INSERT INTO saved_signals (id, user_id, symbol, timeframe, direction, entry_price, stop_loss,
          take_profit, risk_reward_ratio, confidence_score, reasoning, market_source, generated_at, valid_until)
        VALUES ($1, $2, 'BTC-USD', '1h', 'long', 100, 90, 120, 2, 80, 'trial test', 'test', now(), now() + interval '1 day')`,
      [signalId, userId]);
      const charge = await consumeSignalUnlockCredit(client, {
        transactionId: `sct_trialtest_${userId}_${index}`,
        userId,
        savedSignalId: signalId
      });
      assert.equal(charge.charged, true, `unlock ${index + 1} was not charged`);
    }
  });
}

// The same transaction DELETE /api/account runs once identity is confirmed.
export async function deleteUser(userId) {
  const email = (await query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email;
  const result = await deleteAccountData({ userId, email });
  assert.equal(result.alreadyDeleted, false);
}
