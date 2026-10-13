// DB-backed: signup is one step. The create-account form's single submit (email, password, the two
// confirmations; no username) creates the account with consent and 18+ stored; Google new accounts
// likewise. Every new account gets a generated username that is unique under concurrency and
// renamable at once. Existing accounts, their usernames and sign-in are untouched.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:4173/api/auth/google/callback";
process.env.GOOGLE_AUTH_ENABLED = "true";

const { getPool, query } = await import("../src/db/client.js");
const { createUser, randomTraderUsername, GENERATED_USERNAME_ATTEMPTS } = await import("../src/db/repositories.js");
const { hashPassword, registerOrLogin } = await import("../src/modules/auth/authService.js");
const { startGoogleOAuth, completeGoogleOAuth } = await import("../src/modules/auth/googleOAuthService.js");
const { getMyProfile, updateMyProfile } = await import("../src/modules/profiles/profileService.js");
const { CURRENT_LEGAL_CONSENT_VERSION } = await import("../src/modules/auth/authPolicy.js");
const { appConfig } = await import("../src/config/appConfig.js");
const { createId } = await import("../src/shared/ids.js");
const { cleanupTestUsers } = await import("./account-deletion-fixtures.js");

const run = Date.now().toString(36);
const createdEmails = [];
let ipCounter = 0;
// A random /16 per run keeps the per-IP signup velocity limits from carrying over between runs.
const ipPrefix = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
const GENERATED = /^trader_(\d{6}|\d{9})$/;
const recent = (date) => date instanceof Date && Math.abs(Date.now() - date.getTime()) < 60_000;
const passed = [];

function freshReq() {
  ipCounter += 1;
  return { headers: {}, socket: { remoteAddress: `${ipPrefix}.${ipCounter}` } };
}

function email(tag) {
  const value = `freeacct-${tag}-${run}@example.test`;
  createdEmails.push(value);
  return value;
}

async function userRow(address) {
  return (await query(`
    SELECT id, username, username_normalized, username_updated_at, username_generated,
      legal_consent_accepted_at, legal_consent_version, age_confirmed_at
    FROM users WHERE email = $1
  `, [address])).rows[0] || null;
}

// Exactly what the "Create your free account" form posts: no name, no username.
const createAccountSubmit = (address) => registerOrLogin({
  email: address,
  password: "free-account-pw-1",
  legalConsentAccepted: true,
  ageConfirmed: true,
  intent: "signup",
  deviceFingerprint: `device-${run}-${ipCounter + 1}`
}, freshReq());

const newUserFields = (tag) => ({
  id: createId("usr"),
  name: tag,
  email: email(tag),
  password: hashPassword("free-account-pw-1")
});

async function check(name, fn) {
  await fn();
  passed.push(name);
}

// --- Google OAuth plumbing: real start/callback code; only Google's token and JWKS endpoints are
// answered locally, with an id_token signed by a throwaway key.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "free-account-test-key", alg: "RS256", use: "sig" };
let pendingIdToken = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url === appConfig.googleOAuth.tokenUrl) {
    return new Response(JSON.stringify({ id_token: pendingIdToken }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === appConfig.googleOAuth.jwksUrl) {
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
  }
  return realFetch(url, options);
};

function idToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

async function googleSignup(tag) {
  const address = email(`google-${tag}`);
  const started = await startGoogleOAuth(freshReq(), `gdevice-${tag}-${run}`, "", { legalConsentAccepted: true, ageConfirmed: true });
  const nonce = new URL(started.authorizationUrl).searchParams.get("nonce");
  const now = Math.floor(Date.now() / 1000);
  pendingIdToken = idToken({
    iss: "https://accounts.google.com",
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: `google-sub-${tag}-${run}`,
    email: address,
    email_verified: true,
    name: `Free ${tag}`,
    nonce,
    iat: now,
    exp: now + 3600
  });
  return { address, complete: () => completeGoogleOAuth({ code: "test-code", state: started.state }) };
}

try {
  // 1. One submit of the create-account form creates the account: no username step, consent and
  //    18+ stored, a generated username that leaves no "choose a username" prompt behind.
  await check("new email signup: one submit creates the account with consent and age stored", async () => {
    const address = email("email");
    const session = await createAccountSubmit(address);
    assert.equal(typeof session.sessionId, "string");
    const row = await userRow(address);
    assert.ok(recent(row.legal_consent_accepted_at) && recent(row.age_confirmed_at), "consent and age timestamps stored");
    assert.equal(row.legal_consent_version, CURRENT_LEGAL_CONSENT_VERSION);
    assert.match(row.username, GENERATED);
    assert.equal(row.username_normalized, row.username.toLowerCase());
    assert.equal(row.username_generated, true);
    const profile = await getMyProfile({ id: row.id });
    assert.equal(profile.usernameRequired, false, "no username onboarding prompt");
    assert.equal(profile.usernameGenerated, true);
  });

  // 2. "Users can change it later": no 30-day cooldown on the generated name, and the flag clears.
  await check("a generated username can be renamed at once and the rename clears the flag", async () => {
    const row = await userRow(createdEmails[0]);
    assert.equal(row.username_updated_at, null, "a generated name must not start the rename cooldown");
    const chosen = `fa${run}`.slice(0, 20);
    const profile = await updateMyProfile({ id: row.id }, { username: chosen });
    assert.equal(profile.username, chosen);
    assert.equal(profile.usernameGenerated, false);
    const after = await userRow(createdEmails[0]);
    assert.deepEqual([after.username_generated, recent(after.username_updated_at)], [false, true]);
  });

  // 3. Google new account: generated username plus the confirmations carried through the state.
  await check("Google new account stores consent and age and gets a generated username", async () => {
    const flow = await googleSignup("new");
    const outcome = await flow.complete();
    assert.equal(typeof outcome.sessionId, "string");
    const row = await userRow(flow.address);
    assert.ok(recent(row.legal_consent_accepted_at) && recent(row.age_confirmed_at), "consent and age timestamps stored");
    assert.equal(row.legal_consent_version, CURRENT_LEGAL_CONSENT_VERSION);
    assert.match(row.username, GENERATED);
    assert.equal(row.username_generated, true);
    assert.equal((await getMyProfile({ id: row.id })).usernameRequired, false);
  });

  // 4. Concurrency. The unique index decides; losers draw again. Forced collisions make it
  //    deterministic: everyone's first draw is the same name.
  await check("generated usernames are unique under concurrency, including against an existing chosen name", async () => {
    const shared = randomTraderUsername();
    const racers = Array.from({ length: 24 }, (_, index) => createUser({
      ...newUserFields(`race${index}`),
      generateUsername: true,
      usernameCandidate: (attempt) => (attempt === 0 ? shared : randomTraderUsername(attempt))
    }));
    const users = await Promise.all(racers);
    const names = users.map((user) => user.usernameNormalized);
    assert.equal(new Set(names).size, users.length, "all distinct");
    assert.equal(names.filter((name) => name === shared).length, 1, "exactly one racer keeps the shared draw");
    assert.ok(users.every((user) => GENERATED.test(user.username) && user.usernameGenerated));

    // A user who chose the name (any case) already holds it: every racer must move on.
    const taken = randomTraderUsername();
    await createUser({ ...newUserFields("holder"), username: taken.toUpperCase() });
    const second = await Promise.all(Array.from({ length: 12 }, (_, index) => createUser({
      ...newUserFields(`race2-${index}`),
      generateUsername: true,
      usernameCandidate: (attempt) => (attempt < 2 ? taken : randomTraderUsername(attempt))
    })));
    const secondNames = second.map((user) => user.usernameNormalized);
    assert.equal(new Set(secondNames).size, second.length);
    assert.ok(!secondNames.includes(taken), "the existing chosen name is never reused");

    // Real signup path in parallel (default generator), distinct IPs so velocity limits don't interfere.
    const viaSignup = await Promise.all(Array.from({ length: 10 }, (_, index) => createAccountSubmit(email(`par${index}`))));
    const signupNames = viaSignup.map((session) => session.user.username);
    assert.equal(new Set(signupNames).size, signupNames.length);
    assert.ok(signupNames.every((name) => GENERATED.test(name)));
  });

  await check("a generator that never finds a free name fails cleanly, leaving no partial account", async () => {
    const taken = randomTraderUsername();
    await createUser({ ...newUserFields("holder2"), username: taken });
    const fields = newUserFields("exhausted");
    let draws = 0;
    await assert.rejects(
      createUser({ ...fields, generateUsername: true, usernameCandidate: () => { draws += 1; return taken; } }),
      (error) => error.code === "23505"
    );
    assert.equal(draws, GENERATED_USERNAME_ATTEMPTS);
    assert.equal(await userRow(fields.email), null);
  });

  // 5. Existing users: sign-in unchanged, usernames untouched (chosen, or still missing).
  await check("sign-in for an existing user is unchanged and leaves their username alone", async () => {
    const chosenAddress = email("existing");
    const chosen = `ex${run}`.slice(0, 20);
    const password = hashPassword("existing-pw-1");
    await query(`
      INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at,
        username, username_normalized, username_updated_at)
      VALUES ($1, 'existing', $2, $3, $4, 'free', now(), $5, lower($5), now() - interval '90 days')
    `, [`usr_freeacct_ex_${run}`, chosenAddress, password.salt, password.hash, chosen]);
    const noUsernameAddress = email("nousername");
    await query(`
      INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
      VALUES ($1, 'legacy', $2, $3, $4, 'free', now())
    `, [`usr_freeacct_nu_${run}`, noUsernameAddress, password.salt, password.hash]);
    const before = await userRow(chosenAddress);

    for (const intent of ["signin", undefined]) {
      const session = await registerOrLogin({ email: chosenAddress, password: "existing-pw-1", intent }, freshReq());
      assert.equal(session.user.username, chosen);
      await assert.rejects(registerOrLogin({ email: chosenAddress, password: "wrong-pw-1", intent }, freshReq()), (error) => error.statusCode === 401);
    }
    assert.deepEqual(await userRow(chosenAddress), before, "nothing about the existing row changes");

    await registerOrLogin({ email: noUsernameAddress, password: "existing-pw-1", intent: "signin" }, freshReq());
    const legacy = await userRow(noUsernameAddress);
    assert.deepEqual([legacy.username, legacy.username_generated], [null, false], "existing users are not backfilled");
    assert.equal((await getMyProfile({ id: legacy.id })).usernameRequired, true, "they keep the existing username prompt");
  });

  await check("the sign-in form never creates an account; an API client's chosen username is still honoured", async () => {
    const stranger = email("stranger");
    await assert.rejects(
      registerOrLogin({ email: stranger, password: "stranger-pw-1", legalConsentAccepted: true, ageConfirmed: true, intent: "signin", deviceFingerprint: "d" }, freshReq()),
      (error) => error.statusCode === 401 && error.message === "Invalid email or password."
    );
    assert.equal(await userRow(stranger), null);

    const address = email("apiname");
    const name = `an${run}`.slice(0, 20);
    await registerOrLogin({ email: address, password: "api-name-pw-1", username: name, legalConsentAccepted: true, ageConfirmed: true, deviceFingerprint: `device-apiname-${run}` }, freshReq());
    const row = await userRow(address);
    assert.deepEqual([row.username, row.username_generated], [name, false]);
  });

  // 6. The form itself: every create-account CTA opens "Create your free account" with only email,
  //    password and the two confirmations; sign-in links across.
  await check("create-account CTAs open the free-account form; no username or name field on it", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const bootstrap = readFileSync(new URL("../public/auth-bootstrap.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const form = html.slice(html.indexOf('<form class="auth-card" id="auth-form"'), html.indexOf("</form>", html.indexOf('id="auth-form"')));
    const fields = [...form.matchAll(/<input[^>]*name="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(fields, ["email", "password", "legalConsentAccepted", "ageConfirmed"]);
    assert.match(form, /data-auth-mode="signin">New here\? <a href="#signup"[^>]*>Create a free account<\/a>/);
    assert.match(form, /data-auth-mode="signup">Already have an account\? <a href="#signin"[^>]*>Sign in<\/a>/);
    assert.match(app, /heading\.textContent = mode === "signup" \? "Create your free account" : "Sign in"/);
    assert.match(app, /"Create free account"/);
    assert.match(app, /document\.querySelector\("#start-free-button"\)\.addEventListener\("click", \(\) => \{\n  openAuthMode\("signup"\);/);
    assert.match(app, /button\.addEventListener\("click", \(\) => \{\n    openAuthMode\("signup"\);/);
    assert.match(app, /credentials\.intent = getAuthMode\(\);/);
    assert.match(bootstrap, /credentials\.intent = getAuthMode\(\);/);
    assert.match(bootstrap, /showAuthRoute\("signup"\)/);
  });
} finally {
  globalThis.fetch = realFetch;
  const ids = (await query(`SELECT id FROM users WHERE email = ANY($1)`, [createdEmails])).rows.map((row) => row.id);
  await query(`DELETE FROM oauth_accounts WHERE user_id = ANY($1)`, [ids]);
  await cleanupTestUsers(ids);
  await getPool().end();
}

console.log(`Signup free-account tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
