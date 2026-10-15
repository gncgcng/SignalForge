// End to end: a first visit with ?utm_source=instagram that later signs up is counted under instagram in Admin,
// and its trial shows under instagram too. Trials in the other Stripe mode are not counted.
// DB-backed (local docker-compose Postgres); no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

Object.assign(process.env, {
  NODE_ENV: "development",
  EMAIL_FEATURES_ENABLED: "false",
  STRIPE_SECRET_KEY: "sk_test_fake_signup_source",
  STRIPE_PRICE_MONTHLY: "price_fake_monthly",
  STRIPE_PRICE_ANNUAL: "price_fake_annual"
});

const { getPool, query } = await import("../src/db/client.js");
const { getAdminProductAnalytics } = await import("../src/db/repositories.js");
const { registerOrLogin } = await import("../src/modules/auth/authService.js");
const { trackProductEvent } = await import("../src/modules/analytics/productAnalyticsService.js");
const { captureFirstTouch, getFirstTouch } = await import("../public/attribution.js");

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const createdEmails = [];
const fakeReq = (n) => ({ headers: { "x-forwarded-for": `10.78.${n}.${Math.floor(Math.random() * 250) + 1}` } });

function browser(store, { search = "", referrer = "", pathname = "/" } = {}) {
  return {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value))
    },
    location: { search, hostname: "signalforge.app", pathname },
    document: { referrer }
  };
}

async function sourceRow(source) {
  const rows = (await getAdminProductAnalytics()).signupsBySource;
  return rows.find((row) => row.source === source) || { source, count: 0, trials: 0 };
}

async function signUp(label, attribution, n) {
  const email = `signup-source-${label}-${run}@example.test`;
  createdEmails.push(email);
  const session = await registerOrLogin({
    name: `Signup Source ${label}`,
    email,
    password: "signup-source-pass",
    deviceFingerprint: `signup-source-device-${run}-${label}`,
    legalConsentAccepted: true,
    ageConfirmed: true,
    attribution
  }, fakeReq(n));
  assert.equal(session.user.email, email);
  return session.user.id;
}

try {
  const instagramBefore = await sourceRow("instagram");

  // First visit lands on / from an Instagram link; a later direct visit to /research keeps the first touch.
  const store = new Map();
  captureFirstTouch(browser(store, { search: "?utm_source=instagram&utm_medium=social" }));
  captureFirstTouch(browser(store, { pathname: "/research", referrer: "https://www.reddit.com/r/x" }));
  const attribution = getFirstTouch(browser(store));
  assert.equal(attribution.source, "instagram");

  const instagramUser = await signUp("instagram", attribution, 1);
  const afterSignup = await sourceRow("instagram");
  assert.equal(afterSignup.count, instagramBefore.count + 1, "the signup is counted under instagram");
  assert.equal(afterSignup.trials, instagramBefore.trials, "no trial yet");

  await trackProductEvent({ eventType: "trial_started", userId: instagramUser, metadata: { stripeMode: "test" } });
  const afterTrial = await sourceRow("instagram");
  assert.equal(afterTrial.count, afterSignup.count, "a trial is not another signup");
  assert.equal(afterTrial.trials, instagramBefore.trials + 1, "the trial is counted under instagram");

  // A trial recorded under the other Stripe mode (live) does not count while the key is in test mode.
  const otherSource = `srcdb${run}`.slice(0, 40);
  const otherUser = await signUp("other", { source: otherSource }, 2);
  await trackProductEvent({ eventType: "trial_started", userId: otherUser, metadata: { stripeMode: "live" } });
  const other = await sourceRow(otherSource);
  assert.equal(other.count, 1);
  assert.equal(other.trials, 0, "other-mode trial must not count");

  console.log(JSON.stringify({ instagram: afterTrial, other }, null, 2));
} finally {
  if (createdEmails.length) {
    const ids = (await query("SELECT id FROM users WHERE email = ANY($1)", [createdEmails])).rows.map((row) => row.id);
    await query("DELETE FROM product_analytics_events WHERE user_id = ANY($1)", [ids]);
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  }
  await getPool().end();
}
