// DB-backed: one free trial per email / Google account, surviving account deletion. Drives the
// real signup, verification-link, Google OAuth and account-deletion code against local Postgres
// (only Google's token/JWKS endpoints are stubbed). Every scenario that should be refused uses a
// brand-new device fingerprint, so device_trial_history is never what blocks it.
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
const { normalizeTrialEmail, trialIdentities } = await import("../src/modules/auth/trialIdentity.js");
const { redeemCreditGrantCode } = await import("../src/modules/promo-codes/promoCodeRepository.js");
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
const userFlags = async (userId) => (await query(`SELECT abuse_flags FROM users WHERE id = $1`, [userId])).rows[0].abuse_flags;
const results = {};
const helperIds = [];

try {
  // Normalization rules.
  assert.equal(normalizeTrialEmail("  First.Last+promo@GMAIL.com "), "firstlast@gmail.com");
  assert.equal(normalizeTrialEmail("first.last@googlemail.com"), "firstlast@gmail.com");
  assert.equal(normalizeTrialEmail("Bob.Smith+news@Example.com"), "bob.smith@example.com");
  results.normalization = true;

  // A brand-new email gets 3, and leaves a claim that holds no email.
  const email = `trial-claims-${tag}@example.com`;
  remember({ email });
  const first = await h.emailSignup({ email, deviceFingerprint: freshDevice() });
  assert.equal(first.signup.trialAlreadyUsed, false);
  assert.equal(first.unlocks, 3);
  const claim = (await query(`SELECT * FROM trial_identity_claims WHERE identity_hash = ANY($1)`,
    [trialIdentities({ email }).map((item) => item.hash)])).rows;
  assert.equal(claim.length, 1);
  assert.equal(claim[0].kind, "email");
  assert.ok(!JSON.stringify(claim).includes(email.split("@")[0]), "claim row contains the email");
  results.brandNewEmailGetsThree = true;

  // Spend them, delete the account (the claim survives), sign up again with the same email.
  await h.spendUnlocks(first.userId, 3);
  await h.deleteUser(first.userId);
  assert.equal(await claimCount({ email }), 1, "claim removed by account deletion");
  const again = await h.emailSignup({ email, deviceFingerprint: freshDevice() });
  assert.equal(again.signup.trialAlreadyUsed, true, "signup response doesn't report the used trial");
  assert.equal(again.verified.trialGranted, false);
  assert.equal(again.verified.trialBlockedBy, "identity");
  assert.equal(again.unlocks, 0);
  assert.ok((await userFlags(again.userId)).includes("repeated_trial_identity"));
  results.deleteAndResignupSameEmailGetsZero = true;

  // Gmail dot / +alias / googlemail variants of one mailbox share one trial.
  const gmailBase = `trial.claims.${tag}`;
  remember({ email: `${gmailBase}@gmail.com` });
  const gmail = await h.emailSignup({ email: `${gmailBase}+first@gmail.com`, deviceFingerprint: freshDevice() });
  assert.equal(gmail.unlocks, 3);
  for (const variant of [
    `${gmailBase.replaceAll(".", "")}@gmail.com`,
    `${gmailBase.replace("claims", "cl.ai.ms")}+again@gmail.com`,
    `${gmailBase}@googlemail.com`,
    `  ${gmailBase.toUpperCase()}@GMAIL.COM  `
  ]) {
    const attempt = await h.emailSignup({ email: variant, deviceFingerprint: freshDevice() });
    assert.equal(attempt.unlocks, 0, `${variant} got a second trial`);
    assert.equal(attempt.signup.trialAlreadyUsed, true);
  }
  results.gmailVariantsGetZero = true;

  // Other domains: +suffix is stripped, dots are not.
  const bob = `bob.${tag}`;
  remember({ email: `${bob}@example.com` });
  remember({ email: `${bob.replace(".", "")}@example.com` });
  assert.equal((await h.emailSignup({ email: `${bob}@example.com`, deviceFingerprint: freshDevice() })).unlocks, 3);
  assert.equal((await h.emailSignup({ email: `${bob}+again@example.com`, deviceFingerprint: freshDevice() })).unlocks, 0);
  assert.equal((await h.emailSignup({ email: `${bob.replace(".", "")}@example.com`, deviceFingerprint: freshDevice() })).unlocks, 3);
  results.otherDomainsStripPlusOnly = true;

  // Google: the same Google account (subject) after deletion gets 0, even with a new email on it.
  const google = { sub: `g-claims-${tag}`, email: `trial-claims-g-${tag}@example.com` };
  remember({ email: google.email, googleSubjects: [google.sub] });
  const g1 = await h.googleSignup({ ...google, deviceFingerprint: freshDevice() });
  assert.equal(g1.unlocks, 3);
  assert.equal(g1.session.trialAlreadyUsed, false);
  assert.equal(await claimCount({ email: google.email, googleSubjects: [google.sub] }), 2);
  await h.deleteUser(g1.userId);
  const renamed = `trial-claims-g2-${tag}@example.com`;
  remember({ email: renamed });
  const g2 = await h.googleSignup({ sub: google.sub, email: renamed, deviceFingerprint: freshDevice() });
  assert.equal(g2.unlocks, 0, "same Google subject got a second trial");
  assert.equal(g2.session.trialAlreadyUsed, true);
  results.googleResignupSameSubjectGetsZero = true;

  // ...and with no device fingerprint at all (which skips the device check entirely).
  await h.deleteUser(g2.userId);
  assert.equal((await h.googleSignup({ ...google, deviceFingerprint: null })).unlocks, 0);
  results.googleWithoutDeviceFingerprintGetsZero = true;

  // A new Google account whose email already had an email-signup trial (account since deleted)
  // gets 0 too.
  const crossover = `trial-claims-crossover-${tag}@example.com`;
  remember({ email: crossover, googleSubjects: [`g-other-${tag}`] });
  const emailFirst = await h.emailSignup({ email: crossover, deviceFingerprint: freshDevice() });
  assert.equal(emailFirst.unlocks, 3);
  await h.deleteUser(emailFirst.userId);
  const viaGoogle = await h.googleSignup({ sub: `g-other-${tag}`, email: crossover, deviceFingerprint: freshDevice() });
  assert.equal(viaGoogle.unlocks, 0);
  assert.equal(viaGoogle.session.trialAlreadyUsed, true);
  results.googleWithClaimedEmailGetsZero = true;

  // A device block doesn't consume the email: it can still earn its trial on another device.
  const sharedDevice = freshDevice();
  const owner = `trial-claims-owner-${tag}@example.com`;
  const guest = `trial-claims-guest-${tag}@example.com`;
  remember({ email: owner });
  remember({ email: guest });
  assert.equal((await h.emailSignup({ email: owner, deviceFingerprint: sharedDevice })).unlocks, 3);
  const blockedByDevice = await h.emailSignup({ email: guest, deviceFingerprint: sharedDevice });
  assert.equal(blockedByDevice.verified.trialBlockedBy, "device");
  assert.equal(await claimCount({ email: guest }), 0, "a device-blocked signup kept an identity claim");
  await h.deleteUser(blockedByDevice.userId);
  assert.equal((await h.emailSignup({ email: guest, deviceFingerprint: freshDevice() })).unlocks, 3);
  results.deviceBlockLeavesEmailUnclaimed = true;

  // Promo codes still work on an account that was refused the trial.
  const adminId = await fixtures.createHelperUser("trialadmin", "admin");
  helperIds.push(adminId);
  const promoCode = `TRIALPROMO${tag}`.toUpperCase();
  await query(`INSERT INTO promo_codes (id, code, type, max_redemptions, active, created_by_admin_id, credit_quantity)
    VALUES ($1, $2, 'credit_grant', 5, true, $3, 5)`, [`promo_trial_${tag}`, promoCode, adminId]);
  assert.equal((await redeemCreditGrantCode({ code: promoCode, userId: again.userId })).redeemed, true);
  assert.equal(await h.unlocks(again.userId), 5);
  results.promoCodesUnaffected = true;

  // An account granted its trial before claims existed: deleting it writes the claim then.
  const legacyEmail = `trial-claims-legacy-${tag}@example.com`;
  remember({ email: legacyEmail });
  const secret = appConfig.trialIdentitySecret;
  appConfig.trialIdentitySecret = "";
  const legacy = await h.emailSignup({ email: legacyEmail, deviceFingerprint: freshDevice() });
  appConfig.trialIdentitySecret = secret;
  assert.equal(legacy.unlocks, 3);
  assert.equal(await claimCount({ email: legacyEmail }), 0);
  await h.deleteUser(legacy.userId);
  assert.equal(await claimCount({ email: legacyEmail }), 1, "deletion didn't record the legacy trial");
  assert.equal((await h.emailSignup({ email: legacyEmail, deviceFingerprint: freshDevice() })).unlocks, 0);
  results.preExistingTrialClaimedOnDeletion = true;

  // TRIAL_IDENTITY_SECRET unset: behaves exactly as before (claimed email gets 3 on a new device)
  // and logs an error instead of crashing.
  await h.deleteUser(again.userId);
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  appConfig.trialIdentitySecret = "";
  let unsetResult;
  try {
    unsetResult = await h.emailSignup({ email, deviceFingerprint: freshDevice() });
  } finally {
    appConfig.trialIdentitySecret = secret;
    console.error = consoleError;
  }
  assert.equal(unsetResult.unlocks, 3);
  assert.equal(unsetResult.signup.trialAlreadyUsed, false);
  assert.ok(errors.some((line) => line.includes("TRIAL_IDENTITY_SECRET is not set")), "no error logged");
  results.secretUnsetBehavesAsTodayAndLogs = true;

  console.log(JSON.stringify({ trialIdentityClaims: "ok", results }, null, 2));
} finally {
  h.restoreFetch();
  if (!process.argv.includes("--keep")) {
    await query(`DELETE FROM trial_identity_claims WHERE identity_hash = ANY($1)`, [[...claimHashes]]);
    await query(`DELETE FROM promo_code_redemptions WHERE user_id = ANY($1)`, [h.createdUserIds]);
    await query(`DELETE FROM promo_codes WHERE id = $1`, [`promo_trial_${tag}`]);
    await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [h.createdUserIds]);
    await fixtures.cleanupTestUsers([...h.createdUserIds, ...helperIds]);
  }
  await getPool().end();
}
