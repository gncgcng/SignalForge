import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIRST_TOUCH_KEY, captureFirstTouch, deriveFirstTouch, getFirstTouch } from "../public/attribution.js";
import { normalizeSignupAttribution } from "../src/modules/analytics/signupAttribution.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// utm_source wins over the referrer; slugs are cleaned and lowercased.
assert.deepEqual(
  deriveFirstTouch({
    search: "?utm_source=Reddit&utm_medium=social&utm_campaign=Know The Odds",
    referrer: "https://www.reddit.com/r/algotrading/comments/abc",
    currentHost: "signalforge.app",
    pathname: "/research"
  }),
  { source: "reddit", medium: "social", campaign: "knowtheodds", referrerHost: "reddit.com", landingPath: "/research" }
);

// No utm: the referring host only (never its path), medium "referral".
assert.deepEqual(
  deriveFirstTouch({ referrer: "https://news.ycombinator.com/item?id=1", currentHost: "signalforge.app", pathname: "/" }),
  { source: "news.ycombinator.com", medium: "referral", campaign: "", referrerHost: "news.ycombinator.com", landingPath: "/" }
);

// Own site, Google sign-in and Stripe are not sources; nothing at all is "direct".
for (const referrer of ["https://www.signalforge.app/research", "https://accounts.google.com/o/oauth2", "https://checkout.stripe.com/c/pay", ""]) {
  const touch = deriveFirstTouch({ referrer, currentHost: "signalforge.app" });
  assert.equal(touch.source, "direct", referrer);
  assert.equal(touch.medium, "none", referrer);
}
assert.equal(deriveFirstTouch({ referrer: "not a url" }).source, "direct");

// First touch: the first landing is kept, a later utm visit does not overwrite it.
function fakeWindow({ search = "", referrer = "", pathname = "/" }, store) {
  return {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value))
    },
    location: { search, hostname: "signalforge.app", pathname },
    document: { referrer }
  };
}
const store = new Map();
captureFirstTouch(fakeWindow({ search: "?utm_source=twitter", pathname: "/research" }, store));
captureFirstTouch(fakeWindow({ search: "?utm_source=newsletter" }, store));
const stored = getFirstTouch(fakeWindow({}, store));
assert.equal(stored.source, "twitter");
assert.equal(stored.landingPath, "/research");
assert.ok(stored.capturedAt);
assert.ok(store.has(FIRST_TOUCH_KEY));

// Blocked storage never throws; nothing stored reads back as null.
const blocked = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } };
assert.doesNotThrow(() => captureFirstTouch(blocked));
assert.equal(getFirstTouch(blocked), null);
assert.equal(getFirstTouch(fakeWindow({}, new Map())), null);

// Server side re-cleans whatever the client sent.
assert.deepEqual(normalizeSignupAttribution(null), {});
assert.deepEqual(normalizeSignupAttribution({ source: "  " }), {});
assert.deepEqual(
  normalizeSignupAttribution({
    source: "Reddit<script>",
    medium: "social",
    campaign: "launch",
    referrerHost: "reddit.com",
    landingPath: "/research?email=a@b.com",
    extra: "dropped"
  }),
  { source: "redditscript", medium: "social", campaign: "launch", referrerHost: "reddit.com", landingPath: "/research" }
);
assert.equal(normalizeSignupAttribution({ source: "x", landingPath: "https://evil.example/" }).landingPath, "");
assert.equal(normalizeSignupAttribution({ source: "a".repeat(200) }).source.length, 64);

// Wiring: both landing pages capture, both signup paths store it, Admin shows counts by source.
const app = read("public/app.js");
const research = read("public/research.js");
const authService = read("src/modules/auth/authService.js");
const google = read("src/modules/auth/googleOAuthService.js");
const controller = read("src/modules/auth/authController.js");
const repositories = read("src/db/repositories.js");
const migration = read("migrations/069_signup_attribution.sql");
const html = read("public/index.html");
const worker = read("public/service-worker.js");

const wiring = {
  researchCaptures: research.includes("captureFirstTouch();"),
  appCapturesBeforeEarlyRoutes: /async function init\(\) \{[\s\S]{0,200}captureFirstTouch\(\);[\s\S]*isPublicProfileRoute\(\)/.test(app),
  emailSignupSends: app.includes("credentials.attribution = getFirstTouch();"),
  googleStartSends: /\/api\/auth\/google\/start[\s\S]{0,200}attribution: getFirstTouch\(\)/.test(app),
  emailSignupStores: /authProvider: "email",\s*metadata: normalizeSignupAttribution\(attribution\)/.test(authService),
  googleStateCarries:
    controller.includes("attribution: body.attribution") &&
    google.includes("signupAttribution: normalizeSignupAttribution(attribution)") &&
    /authProvider: "google",\s*metadata: normalizeSignupAttribution\(loginState\.signupAttribution\)/.test(google),
  oauthStateColumn:
    migration.includes("ADD COLUMN IF NOT EXISTS signup_attribution jsonb") &&
    repositories.includes("signup_attribution") &&
    repositories.includes("signupAttribution: state.signup_attribution || {}"),
  adminCountsBySource:
    repositories.includes("COALESCE(NULLIF(metadata->>'source', ''), 'unknown') AS source") &&
    repositories.includes("signupsBySource: signupSources.rows") &&
    html.includes('id="analytics-signup-sources"') &&
    app.includes('renderMetricRows("#analytics-signup-sources"'),
  cachedOffline: worker.split('"/attribution.js"').length - 1 === 2
};
for (const [name, passed] of Object.entries(wiring)) {
  assert.equal(passed, true, `Signup attribution check failed: ${name}`);
}

console.log(JSON.stringify(wiring, null, 2));
