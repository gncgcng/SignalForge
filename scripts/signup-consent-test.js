// DB-backed: proves consent and 18+ confirmation are enforced and *stored* on both account
// creation paths (email/password and Google OAuth), and that pre-existing accounts with NULL
// consent columns keep working.
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
const { hashPassword, registerOrLogin } = await import("../src/modules/auth/authService.js");
const { startGoogleOAuth, completeGoogleOAuth } = await import("../src/modules/auth/googleOAuthService.js");
const { handleAuthRoutes } = await import("../src/modules/auth/authController.js");
const { CURRENT_LEGAL_CONSENT_VERSION } = await import("../src/modules/auth/authPolicy.js");
const { appConfig } = await import("../src/config/appConfig.js");
const { cleanupTestUsers } = await import("./account-deletion-fixtures.js");

const run = Date.now().toString(36);
const createdEmails = [];
let ipCounter = 0;
// A random /16 per run keeps the signup velocity limits (per IP, per day) from carrying over
// between repeated runs against the same local database.
const ipPrefix = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

function freshReq() {
  ipCounter += 1;
  return { headers: {}, socket: { remoteAddress: `${ipPrefix}.${ipCounter}` } };
}

function email(tag) {
  const value = `consent-${tag}-${run}@example.test`;
  createdEmails.push(value);
  return value;
}

async function userRow(address) {
  return (await query(`
    SELECT id, legal_consent_accepted_at, legal_consent_version, age_confirmed_at
    FROM users WHERE email = $1
  `, [address])).rows[0] || null;
}

let usernameCounter = 0;
const nextUsername = () => `c${run}${(usernameCounter += 1)}`.slice(0, 20);

const signup = (fields) => registerOrLogin({
  password: "consent-password-1",
  deviceFingerprint: `device-${run}-${ipCounter + 1}`,
  username: nextUsername(),
  ...fields
}, freshReq());

const recent = (date) => date instanceof Date && Math.abs(Date.now() - date.getTime()) < 60_000;
const result = {};

// --- Google OAuth plumbing: real start/callback code, with only Google's token and JWKS
// endpoints answered locally. The id_token is signed with a throwaway key.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "consent-test-key", alg: "RS256", use: "sig" };
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

async function googleSignup(tag, confirmations) {
  const address = email(`google-${tag}`);
  const started = await startGoogleOAuth(freshReq(), `gdevice-${tag}-${run}`, "", confirmations);
  const nonce = new URL(started.authorizationUrl).searchParams.get("nonce");
  const now = Math.floor(Date.now() / 1000);
  pendingIdToken = idToken({
    iss: "https://accounts.google.com",
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: `google-sub-${tag}-${run}`,
    email: address,
    email_verified: true,
    name: `Consent ${tag}`,
    nonce,
    iat: now,
    exp: now + 3600
  });
  return { address, complete: () => completeGoogleOAuth({ code: "test-code", state: started.state }) };
}

function fakeHttp(method, path, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const req = {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
    socket: { remoteAddress: "127.1.250.1" },
    async *[Symbol.asyncIterator]() { yield payload; }
  };
  const res = {
    statusCode: null,
    body: "",
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    end(chunk = "") { this.body += chunk; }
  };
  return { req, res };
}

try {
  // 1. Email signup: each confirmation is required on its own; nothing is created when missing.
  {
    const noAge = email("noage");
    await assert.rejects(signup({ email: noAge, legalConsentAccepted: true }), (error) => error.statusCode === 400 && /18 or older/.test(error.message));
    const noLegal = email("nolegal");
    await assert.rejects(signup({ email: noLegal, ageConfirmed: true }), (error) => error.statusCode === 400 && /Terms/.test(error.message));
    const stringTrue = email("stringtrue");
    await assert.rejects(signup({ email: stringTrue, legalConsentAccepted: true, ageConfirmed: "true" }), (error) => error.statusCode === 400);
    result.emailSignupBlockedWithoutEitherConfirmation =
      !(await userRow(noAge)) && !(await userRow(noLegal)) && !(await userRow(stringTrue));
  }

  // 2. Email signup with both: all three columns written, together, against the current version.
  {
    const address = email("ok");
    const session = await signup({ email: address, legalConsentAccepted: true, ageConfirmed: true });
    const row = await userRow(address);
    result.emailSignupStoresConsent =
      typeof session.sessionId === "string" &&
      recent(row.legal_consent_accepted_at) &&
      recent(row.age_confirmed_at) &&
      row.legal_consent_accepted_at.getTime() === row.age_confirmed_at.getTime() &&
      row.legal_consent_version === CURRENT_LEGAL_CONSENT_VERSION;
  }

  // 3. Accounts created before the migration (all three NULL) still sign in, with no boxes ticked,
  //    and signing in does not backfill a consent they never gave.
  {
    const address = email("legacy");
    const password = hashPassword("legacy-password-1");
    await query(`
      INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
      VALUES ($1, 'legacy', $2, $3, $4, 'free', now())
    `, [`usr_consent_legacy_${run}`, address, password.salt, password.hash]);
    const session = await registerOrLogin({ email: address, password: "legacy-password-1" }, freshReq());
    const row = await userRow(address);
    result.preMigrationUsersStillLogIn =
      typeof session.sessionId === "string" &&
      row.legal_consent_accepted_at === null &&
      row.legal_consent_version === null &&
      row.age_confirmed_at === null;
  }

  // 4. Demo sessions bypass verification and must not be stamped as having consented.
  {
    const address = email("bypass");
    await registerOrLogin({ email: address, password: "bypass-password-1", username: nextUsername() }, freshReq(), { bypassVerification: true });
    const row = await userRow(address);
    result.bypassAccountsAreNotStampedAsConsenting =
      row.legal_consent_accepted_at === null && row.legal_consent_version === null && row.age_confirmed_at === null;
  }

  // 5. Google: confirmations given at /start survive Google's redirect and are stored when the
  //    callback creates the account. This fails if the state record ever drops either field.
  {
    const flow = await googleSignup("ok", { legalConsentAccepted: true, ageConfirmed: true });
    await flow.complete();
    const row = await userRow(flow.address);
    result.googleCallbackStoresConsentFromState =
      Boolean(row) &&
      recent(row.legal_consent_accepted_at) &&
      recent(row.age_confirmed_at) &&
      row.legal_consent_version === CURRENT_LEGAL_CONSENT_VERSION;
  }

  // 6. Google: a state without the confirmations (e.g. created before migration 059, or by any
  //    caller that skips the controller check) cannot create an account.
  {
    const missingAge = await googleSignup("noage", { legalConsentAccepted: true, ageConfirmed: false });
    await assert.rejects(missingAge.complete(), (error) => error.oauthCode === "consent_required");
    const missingLegal = await googleSignup("nolegal", { legalConsentAccepted: false, ageConfirmed: true });
    await assert.rejects(missingLegal.complete(), (error) => error.oauthCode === "consent_required");
    result.googleCallbackRefusesStateWithoutConfirmations =
      !(await userRow(missingAge.address)) && !(await userRow(missingLegal.address));
  }

  // 7. Google: existing linked users sign in through the callback regardless of the state flags.
  {
    const flow = await googleSignup("ok", { legalConsentAccepted: false, ageConfirmed: false });
    const outcome = await flow.complete();
    result.googleReturningUserNotBlocked = typeof outcome.sessionId === "string";
  }

  // 8. The /google/start route itself rejects a missing age confirmation before any state is made.
  {
    const before = Number((await query(`SELECT count(*) FROM oauth_login_states`)).rows[0].count);
    const { req, res } = fakeHttp("POST", "/api/auth/google/start", { legalConsentAccepted: true });
    await handleAuthRoutes(req, res, "/api/auth/google/start");
    const after = Number((await query(`SELECT count(*) FROM oauth_login_states`)).rows[0].count);
    result.googleStartRouteRequiresAge = res.statusCode === 400 && /18 or older/.test(res.body) && after === before;
  }

  // 9. Refund policy: linked from the three static spots plus the deletion panel, never from the
  //    JS-rendered billing grids (their [data-legal-doc] wiring runs once at page load).
  {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const section = (startMarker, endMarker) => html.slice(html.indexOf(startMarker), html.indexOf(endMarker, html.indexOf(startMarker)));
    const refundLink = 'data-legal-doc="refund"';
    const billingView = section('id="billing-view"', "</section>\n        </div>");
    const planGridRenderer = app.slice(app.indexOf("billingPlanGrid.innerHTML"), app.indexOf("billingPackGrid.innerHTML"));
    const packGridRenderer = app.slice(app.indexOf("billingPackGrid.innerHTML"), app.indexOf("billingPackGrid.innerHTML") + 2000);
    result.refundLinkInStaticSpotsOnly =
      section('class="landing-footer"', "</footer>").includes(refundLink) &&
      section('class="pricing-trust-links"', "</div>").includes(refundLink) &&
      billingView.slice(billingView.indexOf('class="signal-disclaimer"'), billingView.indexOf("</div>", billingView.indexOf('class="signal-disclaimer"'))).includes(refundLink) &&
      !planGridRenderer.includes("data-legal-doc") &&
      !packGridRenderer.includes("data-legal-doc") &&
      /refund: \{\s+title: "Refund Policy"/.test(app) &&
      !html.includes("no refund for the current period") &&
      section("Permanently deletes your signals", "</p>").includes(refundLink);
  }
} finally {
  globalThis.fetch = realFetch;
  const ids = (await query(`SELECT id FROM users WHERE email = ANY($1)`, [createdEmails])).rows.map((row) => row.id);
  await query(`DELETE FROM oauth_accounts WHERE user_id = ANY($1)`, [ids]);
  await cleanupTestUsers(ids);
  await getPool().end();
}

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Signup consent check failed: ${name}`);
}
assert.equal(Object.keys(result).length, 9, "every scenario must report");

console.log(JSON.stringify(result, null, 2));
