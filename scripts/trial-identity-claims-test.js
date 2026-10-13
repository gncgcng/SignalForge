// DB-backed: one free trial per email / Google account, surviving account deletion. Pivot phase 3: the free trial is
// the 7-day card trial. Signing up or verifying grants nothing and claims nothing; starting a card trial claims the
// account's email and Google identities, and any later account with one of them checks out without a trial.
// Drives the real signup, verification-link, Google OAuth and account-deletion code against local Postgres (only
// Google's token/JWKS endpoints are stubbed).
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
process.env.TRIAL_IDENTITY_SECRET = "trial-identity-test-secret";
process.env.GOOGLE_AUTH_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "trial-test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "trial-test-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:4173/api/auth/google/callback";
process.env.EMAIL_FEATURES_ENABLED = "false";
delete process.env.STRIPE_SECRET_KEY;

const { appConfig } = await import("../src/config/appConfig.js");
const { getPool, query } = await import("../src/db/client.js");
const { findUserById, claimTrialIdentities } = await import("../src/db/repositories.js");
const { normalizeTrialEmail, trialIdentities } = await import("../src/modules/auth/trialIdentity.js");
const { getTrialEligibility } = await import("../src/modules/subscriptions/stripeService.js");
const fixtures = await import("./account-deletion-fixtures.js");
const h = await import("./test-support/trial-signup-helpers.js");

const tag = h.runTag;
let deviceCount = 0;
const freshDevice = () => h.device(`fresh${deviceCount += 1}`);
const claimHashes = new Set();
const remember = (identity) => {
  for (const { hash } of trialIdentities(identity)) claimHashes.add(hash);
};
const claimCount = async (identity) => {
  const hashes = trialIdentities(identity).map((item) => item.hash);
  return (await query(`SELECT COUNT(*)::integer AS n FROM trial_identity_claims WHERE identity_hash = ANY($1)`, [hashes])).rows[0].n;
};
const eligibility = async (userId) => getTrialEligibility(await findUserById(userId));
// What the webhook does when a card trial starts (customer.subscription.created, status trialing).
const startCardTrial = async (userId, identity) => {
  await claimTrialIdentities(trialIdentities(identity));
  await query(`UPDATE subscriptions SET first_subscribed_at = now(), status = 'trialing', provider_subscription_id = $2 WHERE user_id = $1`,
    [userId, `sub_trial_${userId}`]);
};
const results = {};

try {
  // Normalization rules.
  assert.equal(normalizeTrialEmail("  First.Last+promo@GMAIL.com "), "firstlast@gmail.com");
  assert.equal(normalizeTrialEmail("first.last@googlemail.com"), "firstlast@gmail.com");
  assert.equal(normalizeTrialEmail("Bob.Smith+news@Example.com"), "bob.smith@example.com");
  results.normalization = true;

  // Signing up and verifying grants no unlocks and claims nothing; the account is eligible for the card trial.
  const email = `trial-claims-${tag}@example.com`;
  remember({ email });
  const first = await h.emailSignup({ email, deviceFingerprint: freshDevice() });
  assert.equal(first.signup.trialAlreadyUsed, false);
  assert.equal(first.unlocks, 0, "no free unlocks");
  assert.equal(first.verified.trialGranted, false);
  assert.equal(await claimCount({ email }), 0, "verification claims nothing");
  assert.deepEqual(await eligibility(first.userId), { eligible: true, reason: null });
  results.signupGrantsNothingAndIsEligible = true;

  // Starting the card trial claims the email; the claim holds no email and survives account deletion.
  await startCardTrial(first.userId, { email });
  const claim = (await query(`SELECT * FROM trial_identity_claims WHERE identity_hash = ANY($1)`,
    [trialIdentities({ email }).map((item) => item.hash)])).rows;
  assert.equal(claim.length, 1);
  assert.equal(claim[0].kind, "email");
  assert.ok(!JSON.stringify(claim).includes(email.split("@")[0]), "claim row contains the email");
  assert.deepEqual(await eligibility(first.userId), { eligible: false, reason: "previous_subscription" });
  await h.deleteUser(first.userId);
  assert.equal(await claimCount({ email }), 1, "claim removed by account deletion");
  const again = await h.emailSignup({ email, deviceFingerprint: freshDevice() });
  assert.equal(again.signup.trialAlreadyUsed, true, "signup response doesn't report the used trial");
  assert.deepEqual(await eligibility(again.userId), { eligible: false, reason: "trial_used" });
  results.deleteAndResignupSameEmailHasNoTrial = true;

  // Gmail dot / +alias / googlemail variants of one mailbox share one trial.
  const gmailBase = `trial.claims.${tag}`;
  remember({ email: `${gmailBase}@gmail.com` });
  const gmail = await h.emailSignup({ email: `${gmailBase}+first@gmail.com`, deviceFingerprint: freshDevice() });
  await startCardTrial(gmail.userId, { email: `${gmailBase}+first@gmail.com` });
  for (const variant of [
    `${gmailBase.replaceAll(".", "")}@gmail.com`,
    `${gmailBase}@googlemail.com`,
    `  ${gmailBase.toUpperCase()}@GMAIL.COM  `
  ]) {
    const attempt = await h.emailSignup({ email: variant, deviceFingerprint: freshDevice() });
    assert.equal(attempt.signup.trialAlreadyUsed, true, variant);
    assert.equal((await eligibility(attempt.userId)).eligible, false, `${variant} would get a second trial`);
  }
  results.gmailVariantsShareOneTrial = true;

  // Google: the same Google account (subject) after deletion has no trial, even with a new email on it.
  const google = { sub: `g-claims-${tag}`, email: `trial-claims-g-${tag}@example.com` };
  remember({ email: google.email, googleSubjects: [google.sub] });
  const g1 = await h.googleSignup({ ...google, deviceFingerprint: freshDevice() });
  assert.equal(g1.unlocks, 0);
  assert.equal(g1.session.trialAlreadyUsed, false);
  assert.equal((await eligibility(g1.userId)).eligible, true);
  await startCardTrial(g1.userId, { email: google.email, googleSubjects: [google.sub] });
  assert.equal(await claimCount({ email: google.email, googleSubjects: [google.sub] }), 2);
  await h.deleteUser(g1.userId);
  const renamed = `trial-claims-g2-${tag}@example.com`;
  remember({ email: renamed });
  const g2 = await h.googleSignup({ sub: google.sub, email: renamed, deviceFingerprint: freshDevice() });
  assert.deepEqual(await eligibility(g2.userId), { eligible: false, reason: "trial_used" }, "same Google subject would get a second trial");
  results.googleResignupSameSubjectHasNoTrial = true;

  // An account that had a subscription but whose claim is missing (e.g. no secret at the time): deletion writes it.
  const legacyEmail = `trial-claims-legacy-${tag}@example.com`;
  remember({ email: legacyEmail });
  const legacy = await h.emailSignup({ email: legacyEmail, deviceFingerprint: freshDevice() });
  await query(`UPDATE subscriptions SET first_subscribed_at = now() WHERE user_id = $1`, [legacy.userId]);
  assert.equal(await claimCount({ email: legacyEmail }), 0);
  await h.deleteUser(legacy.userId);
  assert.equal(await claimCount({ email: legacyEmail }), 1, "deletion didn't record the earlier subscription's trial");
  results.earlierSubscriptionClaimedOnDeletion = true;

  // TRIAL_IDENTITY_SECRET unset: no identity check (logged), so the card and earlier-subscription rules still apply.
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  const secret = appConfig.trialIdentitySecret;
  appConfig.trialIdentitySecret = "";
  try {
    assert.deepEqual(await eligibility(again.userId), { eligible: true, reason: null });
  } finally {
    appConfig.trialIdentitySecret = secret;
    console.error = consoleError;
  }
  assert.ok(errors.some((line) => line.includes("TRIAL_IDENTITY_SECRET is not set")), "no error logged");
  results.secretUnsetSkipsIdentityCheckAndLogs = true;

  console.log(JSON.stringify({ trialIdentityClaims: "ok", results }, null, 2));
} finally {
  h.restoreFetch();
  if (!process.argv.includes("--keep")) {
    await query(`DELETE FROM trial_identity_claims WHERE identity_hash = ANY($1)`, [[...claimHashes]]);
    await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [h.createdUserIds]);
    await fixtures.cleanupTestUsers([...h.createdUserIds]);
  }
  await getPool().end();
}
