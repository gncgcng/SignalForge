import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Creates real users through createUser on a real local Postgres, via both signup paths.
// Mocked-DB auth tests could not catch the 42P08 "could not determine data type of parameter"
// that broke every signup from 7d34e22 until this test was added: only real Postgres type
// inference reproduces it. It also covers the "" username_normalized that made every
// username-less signup after the first collide on idx_users_username_normalized.
// Google's token and JWKS endpoints are the only things stubbed.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

process.env.EMAIL_FEATURES_ENABLED = "false";
process.env.GOOGLE_AUTH_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "create-user-test-client";
process.env.GOOGLE_CLIENT_SECRET = "create-user-test-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/auth/google/callback";

const { query, getPool } = await import("../src/db/client.js");
const { createUser, findUserByEmail } = await import("../src/db/repositories.js");
const { hashPassword, registerOrLogin } = await import("../src/modules/auth/authService.js");
const { startGoogleOAuth, completeGoogleOAuth } = await import("../src/modules/auth/googleOAuthService.js");
const { createId } = await import("../src/shared/ids.js");

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdEmails = [];
const fakeReq = (n) => ({ headers: { "x-forwarded-for": `10.77.${n}.${Math.floor(Math.random() * 250) + 1}` } });

async function assertCreatedRow(email, { username = null } = {}) {
  const row = (await query(`
    SELECT u.username, u.username_normalized, u.username_updated_at, u.password_hash,
      (SELECT COUNT(*)::int FROM subscriptions s WHERE s.user_id = u.id) AS subscriptions,
      (SELECT COUNT(*)::int FROM credit_balances c WHERE c.user_id = u.id) AS balances
    FROM users u WHERE u.email = $1
  `, [email])).rows[0];
  assert.ok(row, `${email} was not inserted`);
  assert.equal(row.subscriptions, 1);
  assert.equal(row.balances, 1);
  assert.equal(row.username, username);
  assert.equal(row.username_normalized, username);
  assert.equal(row.username_updated_at === null, username === null, "username_updated_at must be set iff a username is");
  return row;
}

try {
  const server = (await query("SHOW server_version")).rows[0].server_version;

  // 1. createUser directly: two without a username (must not collide), one with.
  for (const [index, username] of [null, null, `cu${run}`.slice(0, 20)].entries()) {
    const email = `create-user-${index}-${run}@example.test`;
    createdEmails.push(email);
    await createUser({ id: createId("usr"), name: "Create User Test", email, password: hashPassword("create-user-pass"), username });
    await assertCreatedRow(email, { username });
  }

  // 2. Email signup: the real registerOrLogin path a new user hits from the login form.
  const emailSignup = `email-signup-${run}@example.test`;
  const emailUsername = `es${run}`.slice(0, 20);
  createdEmails.push(emailSignup);
  const session = await registerOrLogin({
    name: "Email Signup",
    email: emailSignup,
    password: "email-signup-pass",
    deviceFingerprint: `create-user-test-device-${run}-email`,
    legalConsentAccepted: true,
    username: emailUsername
  }, fakeReq(1));
  assert.ok(session?.user?.id || session?.sessionId || session?.token, "email signup did not return a session");
  assert.equal(session.user.email, emailSignup);
  await assertCreatedRow(emailSignup, { username: emailUsername });

  // 3. Google: real state store, ID-token verification, createGoogleUser and linkOAuthIdentity.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `create-user-test-${run}`;
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  async function googleSignIn(email, n) {
    const { state } = await startGoogleOAuth(fakeReq(10 + n), `create-user-test-device-${run}-google-${n}`, null);
    const { nonce } = (await query("SELECT nonce FROM oauth_login_states ORDER BY created_at DESC LIMIT 1")).rows[0];
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64({
      iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, sub: `google-sub-${n}-${run}`,
      email, email_verified: true, name: `Google User ${n}`, nonce, iat: now, exp: now + 600
    })}`;
    const idToken = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") return Response.json({ id_token: idToken });
      if (href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(jwks);
      throw new Error(`Unexpected network request in create-user test: ${href}`);
    };
    try {
      return await completeGoogleOAuth({ code: `code-${n}-${run}`, state });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // New Google users, twice: Google never sends a username, so the second is the one "" broke.
  // The first attempt also used to crash after creating the user (linkOAuthIdentity returned undefined).
  for (const n of [1, 2]) {
    const googleEmail = `google-signup-${n}-${run}@example.test`;
    createdEmails.push(googleEmail);
    const googleSession = await googleSignIn(googleEmail, n);
    assert.equal(googleSession.user.email, googleEmail);
    await assertCreatedRow(googleEmail);
    assert.ok((await findUserByEmail(googleEmail)).emailVerifiedAt, "Google signup should be email-verified");
  }

  // An existing verified email account signing in with Google for the first time.
  const linkedEmail = `google-link-${run}@example.test`;
  createdEmails.push(linkedEmail);
  await createUser({ id: createId("usr"), name: "Link Test", email: linkedEmail, password: hashPassword("link-pass-123"), emailVerifiedAt: new Date() });
  const linkedSession = await googleSignIn(linkedEmail, 3);
  assert.equal(linkedSession.user.email, linkedEmail);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE u.email = $1", [linkedEmail])).rows[0].n, 1);

  console.log(JSON.stringify({ createUser: "ok", postgres: server, paths: ["direct x3", "email", "google new x2", "google link existing"], users: createdEmails.length }, null, 2));
} finally {
  if (createdEmails.length) await query("DELETE FROM users WHERE email = ANY($1)", [createdEmails]);
  await getPool().end();
}
