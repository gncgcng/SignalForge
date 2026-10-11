// DB-backed: drives the real auth and account-deletion handlers over HTTP (session cookies, OAuth
// state cookies, the shared Google callback) against the local Postgres. Only Google's token and
// JWKS endpoints are stubbed; the "Google account" a user picks is chosen by the test.
// Requires DATABASE_URL (local docker-compose Postgres) with migrations applied.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

process.env.NODE_ENV = "development";
process.env.GOOGLE_AUTH_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "reauth-test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "reauth-test-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:4173/api/auth/google/callback";
process.env.EMAIL_FEATURES_ENABLED = "false";
delete process.env.STRIPE_SECRET_KEY;

const { appConfig } = await import("../src/config/appConfig.js");
const { getPool, query } = await import("../src/db/client.js");
const { attachAuth, requiresAuthAttachment } = await import("../src/middleware/authMiddleware.js");
const { handleAuthRoutes } = await import("../src/modules/auth/authController.js");
const { handleAccountDeletionRoutes } = await import("../src/modules/account-deletion/accountDeletionController.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const fixtures = await import("./account-deletion-fixtures.js");

// --- Fake Google: signs ID tokens for whichever account the "user" picks on the consent screen.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "reauth-test-key", alg: "RS256", use: "sig" };
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

function signIdToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}

// The user picks `account` on Google's chooser; Google redirects back with a code for it.
function googleConsent(authorizationUrl, account) {
  const params = new URL(authorizationUrl).searchParams;
  assert.equal(params.get("prompt"), "select_account");
  const code = `code_${randomBytes(12).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  issuedCodes.set(code, {
    iss: "https://accounts.google.com",
    aud: appConfig.googleOAuth.clientId,
    sub: account.sub,
    email: account.email,
    email_verified: true,
    name: "Reauth Tester",
    nonce: params.get("nonce"),
    iat: now,
    exp: now + 3600
  });
  return `/api/auth/google/callback?${new URLSearchParams({ code, state: params.get("state") })}`;
}

// --- The app, routed the way server.js routes these endpoints.
const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (requiresAuthAttachment(pathname)) {
      await attachAuth(req);
    } else {
      req.user = null;
      req.sessionId = null;
    }
    const handled = (await handleAuthRoutes(req, res, pathname)) ||
      (await handleAccountDeletionRoutes(req, res, pathname));
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const runTag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let browserCount = 0;

// A browser: its own cookie jar, IP and device fingerprint.
function browser() {
  browserCount += 1;
  const jar = new Map();
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${browserCount}`;
  const device = `reauth-device-${runTag}-${browserCount}`;
  return {
    jar,
    async request(path, { method = "GET", body } = {}) {
      const response = await realFetch(`${base}${path}`, {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          "x-device-fingerprint": device,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const name = pair.slice(0, pair.indexOf("=")).trim();
        const value = pair.slice(pair.indexOf("=") + 1);
        if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* redirects have no body */ }
      return { status: response.status, json, location: response.headers.get("location") || "" };
    }
  };
}

async function signInWithGoogle(client, account) {
  const start = await client.request("/api/auth/google/start", {
    method: "POST",
    body: { legalConsentAccepted: true, ageConfirmed: true }
  });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const callback = await client.request(googleConsent(start.json.authorizationUrl, account));
  assert.equal(callback.status, 302);
  assert.match(callback.location, /\?oauth=success/, `Google sign-in failed: ${callback.location}`);
  const session = await client.request("/api/auth/session");
  assert.equal(session.status, 200);
  return session.json.user;
}

async function confirmWithGoogle(client, account) {
  const start = await client.request("/api/auth/google/reauth/start", { method: "POST", body: {} });
  assert.equal(start.status, 200, `re-auth start: ${JSON.stringify(start.json)}`);
  const callback = await client.request(googleConsent(start.json.authorizationUrl, account));
  assert.equal(callback.status, 302);
  return callback.location;
}

const deleteAccount = (client, body) => client.request("/api/account", { method: "DELETE", body });
const setPassword = (client, password) => client.request("/api/auth/password/set", { method: "POST", body: { password } });
const emailLogin = (client, email, password) => client.request("/api/auth/login", {
  method: "POST",
  body: { email, password, intent: "signin" }
});
const userRow = async (id) => (await query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
const sessionReauthAt = async (client) => (await query(
  `SELECT recent_reauth_at FROM sessions WHERE id = $1`,
  [decodeURIComponent(client.jar.get(appConfig.sessionCookieName))]
)).rows[0]?.recent_reauth_at ?? null;
const errorCode = (response) => response.json?.error?.details?.code;

const createdUserIds = [];
const results = {};

try {
  const alice = { sub: `g-alice-${runTag}`, email: `reauth-alice-${runTag}@example.com` };
  const mallory = { sub: `g-mallory-${runTag}`, email: `reauth-mallory-${runTag}@example.com` };

  // A Google signup has no password.
  const aliceBrowser = browser();
  const aliceUser = await signInWithGoogle(aliceBrowser, alice);
  createdUserIds.push(aliceUser.id);
  assert.equal(aliceUser.hasPassword, false, "Google signup should have no password");
  assert.equal((await userRow(aliceUser.id)).password_hash, "");
  results.googleSignupHasNoPassword = true;

  // Deletion without a re-auth is refused and changes nothing.
  let response = await deleteAccount(aliceBrowser, { confirmation: "DELETE" });
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_required");
  assert.equal((await userRow(aliceUser.id)).account_status, "active");
  results.deletionRefusedWithoutReauth = true;

  // Set-password without a re-auth is refused.
  response = await setPassword(aliceBrowser, "alice-new-password");
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_required");
  assert.equal((await userRow(aliceUser.id)).password_hash, "");
  results.setPasswordRefusedWithoutReauth = true;

  // Picking a different Google account on the chooser is refused and changes nothing:
  // no stamp, no new link, no session for the other account.
  const oauthBefore = (await query(`SELECT provider_subject FROM oauth_accounts WHERE user_id = $1`, [aliceUser.id])).rows;
  const mismatch = await confirmWithGoogle(aliceBrowser, mallory);
  assert.match(mismatch, /reauth_error=reauth_account_mismatch/, mismatch);
  assert.equal(await sessionReauthAt(aliceBrowser), null, "mismatched account stamped the session");
  assert.deepEqual((await query(`SELECT provider_subject FROM oauth_accounts WHERE user_id = $1`, [aliceUser.id])).rows, oauthBefore);
  assert.equal((await query(`SELECT 1 FROM oauth_accounts WHERE provider_subject = $1`, [mallory.sub])).rowCount, 0);
  assert.equal((await query(`SELECT 1 FROM users WHERE email = $1`, [mallory.email])).rowCount, 0);
  response = await deleteAccount(aliceBrowser, { confirmation: "DELETE" });
  assert.equal(errorCode(response), "reauth_required", "deletion allowed after a mismatched re-auth");
  results.wrongGoogleAccountRefused = true;

  // A re-auth state is not a login state: even presented with a matching login-state cookie, the
  // login branch refuses it and signs nobody in.
  const reauthStart = await aliceBrowser.request("/api/auth/google/reauth/start", { method: "POST", body: {} });
  const outsider = browser();
  outsider.jar.set("signalforge_google_oauth", new URL(reauthStart.json.authorizationUrl).searchParams.get("state"));
  const replay = await outsider.request(googleConsent(reauthStart.json.authorizationUrl, alice));
  assert.match(replay.location, /oauth_error=invalid_state/, replay.location);
  assert.equal(outsider.jar.has(appConfig.sessionCookieName), false, "re-auth state signed someone in");
  assert.equal(await sessionReauthAt(aliceBrowser), null);
  results.reauthStateIsNotALoginState = true;

  // Correct account: the session is stamped. Then the stamp ages past 10 minutes and is refused.
  assert.match(await confirmWithGoogle(aliceBrowser, alice), /\?reauth=success/);
  assert.ok(await sessionReauthAt(aliceBrowser), "re-auth did not stamp the session");
  await query(`UPDATE sessions SET recent_reauth_at = now() - interval '10 minutes 1 second' WHERE id = $1`,
    [decodeURIComponent(aliceBrowser.jar.get(appConfig.sessionCookieName))]);
  response = await deleteAccount(aliceBrowser, { confirmation: "DELETE" });
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_required");
  response = await setPassword(aliceBrowser, "alice-new-password");
  assert.equal(errorCode(response), "reauth_required");
  assert.equal((await userRow(aliceUser.id)).account_status, "active");
  results.reauthExpiresAfterTenMinutes = true;

  // A re-auth belongs to the session that did it, not to the user's other sessions.
  assert.match(await confirmWithGoogle(aliceBrowser, alice), /\?reauth=success/);
  const aliceSecondDevice = browser();
  await signInWithGoogle(aliceSecondDevice, alice);
  response = await setPassword(aliceSecondDevice, "alice-new-password");
  assert.equal(errorCode(response), "reauth_required", "re-auth leaked to another session");
  results.reauthIsPerSession = true;

  // Set a password after a fresh re-auth (too-short passwords still follow the usual rule).
  response = await setPassword(aliceBrowser, "short");
  assert.equal(response.status, 400);
  response = await setPassword(aliceBrowser, "alice-new-password");
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.match((await userRow(aliceUser.id)).password_hash, /^scrypt\$/);
  response = await setPassword(aliceBrowser, "another-password");
  assert.equal(response.status, 409);
  assert.equal(errorCode(response), "password_already_set");
  assert.equal((await aliceBrowser.request("/api/auth/session")).json.user.hasPassword, true);
  results.setPasswordAfterReauth = true;

  // Afterwards email + password sign-in works, and Google sign-in still works.
  response = await emailLogin(browser(), alice.email, "alice-new-password");
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.user.id, aliceUser.id);
  response = await emailLogin(browser(), alice.email, "wrong-password");
  assert.equal(response.status, 401);
  assert.equal((await signInWithGoogle(browser(), alice)).id, aliceUser.id);
  results.emailAndGoogleLoginAfterSetPassword = true;

  // A Google-only user deletes after re-auth (the typed confirmation is still required).
  const carol = { sub: `g-carol-${runTag}`, email: `reauth-carol-${runTag}@example.com` };
  const carolBrowser = browser();
  const carolUser = await signInWithGoogle(carolBrowser, carol);
  createdUserIds.push(carolUser.id);
  assert.match(await confirmWithGoogle(carolBrowser, carol), /\?reauth=success/);
  response = await deleteAccount(carolBrowser, { confirmation: "delete" });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response), "confirmation_required");
  response = await deleteAccount(carolBrowser, { confirmation: "DELETE" });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json, { deleted: true });
  const carolAfter = await userRow(carolUser.id);
  assert.equal(carolAfter.account_status, "deleted");
  assert.notEqual(carolAfter.email, carol.email);
  results.googleOnlyUserDeletesAfterReauth = true;

  // Password users are unchanged: same errors without/with a wrong password, no set-password,
  // no Google re-auth without a linked Google account, and the password deletes the account.
  const paulId = `usr_reauthtest_paul_${runTag}`;
  const paulEmail = `${paulId}@example.com`;
  const paulPassword = hashPassword("paul-password");
  await query(`INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
    VALUES ($1, 'Paul', $2, $3, $4, 'free', now())`, [paulId, paulEmail, paulPassword.salt, paulPassword.hash]);
  createdUserIds.push(paulId);
  const paulBrowser = browser();
  response = await emailLogin(paulBrowser, paulEmail, "paul-password");
  assert.equal(response.status, 200);
  assert.equal(response.json.user.hasPassword, true);
  response = await deleteAccount(paulBrowser, { confirmation: "DELETE" });
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_failed");
  response = await deleteAccount(paulBrowser, { password: "wrong-password", confirmation: "DELETE" });
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_failed");
  response = await setPassword(paulBrowser, "paul-other-password");
  assert.equal(response.status, 409);
  response = await paulBrowser.request("/api/auth/google/reauth/start", { method: "POST", body: {} });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response), "no_google_identity");
  assert.equal((await userRow(paulId)).password_hash, paulPassword.hash);
  response = await deleteAccount(paulBrowser, { password: "paul-password", confirmation: "DELETE" });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  results.passwordUsersUnchanged = true;

  // Migration 065's backfill clears only the random password of accounts created through Google.
  const legacyRandom = { salt: "abcd", hash: "f".repeat(64) };
  const backfill = {
    googleCreated: `usr_reauthtest_bfg_${runTag}`,
    emailCreatedLinked: `usr_reauthtest_bfe_${runTag}`,
    googleCreatedLaterReset: `usr_reauthtest_bfr_${runTag}`
  };
  for (const [kind, id] of Object.entries(backfill)) {
    const record = kind === "googleCreatedLaterReset" ? hashPassword("reset-password") : legacyRandom;
    await query(`INSERT INTO users (id, name, email, password_salt, password_hash, plan)
      VALUES ($1, 'Backfill', $1 || '@example.com', $2, $3, 'free')`, [id, record.salt, record.hash]);
    createdUserIds.push(id);
    await query(`INSERT INTO oauth_accounts (provider, provider_subject, user_id, provider_email)
      VALUES ('google', 'g-' || $1, $1, $1 || '@example.com')`, [id]);
    await query(`INSERT INTO product_analytics_events (id, event_type, user_id, auth_provider)
      VALUES ('pae_' || $1, 'signup', $1, $2)`, [id, kind === "emailCreatedLinked" ? "email" : "google"]);
  }
  await query(readFileSync(new URL("../migrations/065_google_reauth.sql", import.meta.url), "utf8"));
  assert.equal((await userRow(backfill.googleCreated)).password_hash, "");
  assert.equal((await userRow(backfill.emailCreatedLinked)).password_hash, legacyRandom.hash);
  assert.match((await userRow(backfill.googleCreatedLaterReset)).password_hash, /^scrypt\$/);
  results.backfillClearsOnlyGoogleCreatedRandomPasswords = true;

  console.log(JSON.stringify({ googleReauth: "ok", results }, null, 2));
} finally {
  globalThis.fetch = realFetch;
  server.close();
  if (!process.argv.includes("--keep")) {
    await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [createdUserIds]);
    await fixtures.cleanupTestUsers(createdUserIds);
  }
  await getPool().end();
}
