// Probe, not part of the suite: prints what a deleted account's owner gets on re-signup (email,
// same/new device, Google, +alias). Set TRIAL_IDENTITY_SECRET to see the identity guard's effect.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL

process.env.NODE_ENV = "development";
process.env.GOOGLE_AUTH_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "trial-test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "trial-test-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:4173/api/auth/google/callback";
process.env.EMAIL_FEATURES_ENABLED = "false";

const { getPool, query } = await import("../src/db/client.js");
const fixtures = await import("./account-deletion-fixtures.js");
const h = await import("./test-support/trial-signup-helpers.js");

const rows = [];
const flags = async (userId) => (await query(`SELECT abuse_flags, abuse_review_status FROM users WHERE id = $1`, [userId])).rows[0];
const record = async (scenario, result) => rows.push({ scenario, unlocks: result.unlocks, ...(await flags(result.userId)) });

try {
  const email = `trial-probe-${h.runTag}@example.com`;
  const d1 = h.device("d1");

  let account = await h.emailSignup({ email, deviceFingerprint: d1 });
  await record("1. email signup, device D1, verified", account);
  await h.spendUnlocks(account.userId, account.unlocks);
  rows.at(-1).afterSpending = await h.unlocks(account.userId);
  await h.deleteUser(account.userId);

  account = await h.emailSignup({ email, deviceFingerprint: d1 });
  await record("2. deleted -> same email, same device D1", account);
  await h.deleteUser(account.userId);

  account = await h.emailSignup({ email, deviceFingerprint: h.device("d2") });
  await record("3. deleted -> same email, new device D2", account);
  await h.deleteUser(account.userId);

  const google = { sub: `g-probe-${h.runTag}`, email: `trial-probe-g-${h.runTag}@example.com` };
  const d3 = h.device("d3");
  account = await h.googleSignup({ ...google, deviceFingerprint: d3 });
  await record("4. Google signup, device D3", account);
  await h.spendUnlocks(account.userId, account.unlocks);
  await h.deleteUser(account.userId);

  account = await h.googleSignup({ ...google, deviceFingerprint: d3 });
  await record("5. deleted -> same Google account, same device D3", account);
  await h.deleteUser(account.userId);

  account = await h.googleSignup({ ...google, deviceFingerprint: h.device("d4") });
  await record("6. deleted -> same Google account, new device D4", account);
  await h.deleteUser(account.userId);

  account = await h.googleSignup({ ...google, deviceFingerprint: null });
  await record("7. deleted -> same Google account, no device fingerprint", account);

  const plus = await h.emailSignup({ email: `trial-probe-${h.runTag}+x@example.com`, deviceFingerprint: h.device("d5") });
  await record("8. email +alias of #1, new device D5", plus);

  console.table(rows.map(({ scenario, unlocks, afterSpending, abuse_flags, abuse_review_status }) => ({
    scenario, unlocks, afterSpending, flags: JSON.stringify(abuse_flags), review: abuse_review_status
  })));
} finally {
  h.restoreFetch();
  const { trialIdentities } = await import("../src/modules/auth/trialIdentity.js");
  const probeIdentities = trialIdentities({
    email: `trial-probe-${h.runTag}@example.com`,
    googleSubjects: [`g-probe-${h.runTag}`]
  }).concat(trialIdentities({ email: `trial-probe-g-${h.runTag}@example.com` }));
  await query(`DELETE FROM trial_identity_claims WHERE identity_hash = ANY($1)`, [probeIdentities.map((item) => item.hash)]);
  await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [h.createdUserIds]);
  await fixtures.cleanupTestUsers(h.createdUserIds);
  await getPool().end();
}
