// Seeds a disposable user with rows across both the hard-delete and retained lists,
// and verifies the post-deletion state directly against the database.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { query } from "../src/db/client.js";
import { hashIdentifier } from "../src/modules/auth/abuseProtectionService.js";
import { hashPassword } from "../src/modules/auth/authService.js";
import {
  deletedUserEmail,
  HARD_DELETE_TABLES,
  RETAINED_TABLES
} from "../src/modules/account-deletion/accountDeletionRepository.js";

export async function createHelperUser(tag, role = "user") {
  const id = `usr_deltest_${tag}_${Date.now().toString(36)}`;
  const password = hashPassword("helper-password");
  await query(`
    INSERT INTO users (id, name, email, password_salt, password_hash, plan, role, affiliate_code)
    VALUES ($1, $2, $3, $4, $5, 'free', $6, $7)
  `, [id, `Helper ${tag}`, `${id}@example.test`, password.salt, password.hash, role, `aff${id.slice(-10)}`]);
  return id;
}

// userId must already exist (created by real signup in the e2e test, or by createHelperUser).
export async function seedAccountData(userId, { affiliateId, adminId }) {
  const s = (suffix) => `${suffix}_${userId}`;
  const user = (await query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  const email = user.email;
  const deviceHash = s("devhash");

  await query(`UPDATE users SET signup_ip_hash = 'iphash', device_fingerprint_hash = $3,
    username = $2, username_normalized = lower($2), public_profile_enabled = true,
    public_leaderboard_enabled = true, email_verified_at = now() WHERE id = $1`,
  [userId, `del${userId.slice(-12).replace(/[^a-z0-9]/gi, "")}`.slice(0, 20), deviceHash]);
  await query(`INSERT INTO subscriptions (id, user_id, status, provider_customer_id, provider_subscription_id, stripe_mode)
    VALUES ($1, $2, 'canceled', 'cus_' || $2, NULL, 'test')
    ON CONFLICT (user_id) DO UPDATE SET provider_customer_id = 'cus_' || $2, status = 'canceled', stripe_mode = 'test'`,
  [s("sub"), userId]);
  await query(`INSERT INTO credit_balances (user_id, unlock_credits_balance) VALUES ($1, 5)
    ON CONFLICT (user_id) DO UPDATE SET unlock_credits_balance = 5`, [userId]);

  // Hard-delete list
  await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [s("sess"), userId]);
  await query(`INSERT INTO auth_restore_tokens (id, user_id, token_hash, device_fingerprint_hash, expires_at) VALUES ($1, $2, $3, 'dh', now() + interval '1 day')`, [s("art"), userId, s("th")]);
  await query(`INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [s("prt"), userId]);
  await query(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [s("evt"), userId]);
  await query(`INSERT INTO oauth_accounts (provider, provider_subject, user_id, provider_email) VALUES ('google', $1, $2, $3)`, [s("gsub"), userId, email]);
  await query(`INSERT INTO telegram_notification_settings (user_id, chat_id) VALUES ($1, '12345')`, [userId]);
  await query(`INSERT INTO telegram_notification_queue (id, user_id, setup_key, chat_id, payload) VALUES ($1, $2, 'k', '12345', '{}')`, [s("tq"), userId]);
  await query(`INSERT INTO telegram_connection_codes (code, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [s("tc"), userId]);
  await query(`INSERT INTO watchlist_markets (user_id, symbol) VALUES ($1, 'BTC-USD')`, [userId]);
  await query(`INSERT INTO alert_preferences (id, user_id, symbol, timeframe, direction, minimum_confidence) VALUES ($1, $2, 'BTC-USD', '1h', 'long', 70)`, [s("ap"), userId]);
  await query(`INSERT INTO detected_alerts (id, user_id, setup_id, symbol, timeframe, direction, confidence_score, risk_reward_ratio, reasoning) VALUES ($1, $2, 'setup', 'BTC-USD', '1h', 'long', 80, 2, 'r')`, [s("da"), userId]);

  const signal = (id, validUntil) => query(`INSERT INTO saved_signals (id, user_id, symbol, timeframe, direction, entry_price, stop_loss, take_profit,
      risk_reward_ratio, confidence_score, reasoning, market_source, generated_at, valid_until)
    VALUES ($1, $2, 'BTC-USD', '1h', 'long', 100, 90, 120, 2, 80, 'r', 'test', now(), ${validUntil})`, [id, userId]);
  const ledgerSignal = s("sig_ledger");     // charged + refunded: must survive (ledger cascade)
  const activeLedgerSignal = s("sig_live"); // charged, still active, validity passed: trackers must skip it
  const plainSignal = s("sig_plain");       // no ledger rows: hard-deleted
  await signal(ledgerSignal, "now() + interval '1 day'");
  await signal(activeLedgerSignal, "now() - interval '1 minute'");
  await signal(plainSignal, "now() + interval '1 day'");
  await query(`INSERT INTO signal_outcomes (saved_signal_id, status) VALUES ($1, 'Hit SL'), ($2, 'Active'), ($3, 'Active')`, [ledgerSignal, activeLedgerSignal, plainSignal]);
  await query(`INSERT INTO signal_credit_transactions (id, idempotency_key, user_id, saved_signal_id, transaction_type, quantity, balance_delta, credit_pool, reason)
    VALUES ($1, $1, $2, $3, 'unlock_charge', 1, -1, 'unlock_credits_balance', 'unlock'),
           ($4, $4, $2, $5, 'unlock_charge', 1, -1, 'unlock_credits_balance', 'unlock')`,
  [s("ct_charge"), userId, ledgerSignal, s("ct_charge_live"), activeLedgerSignal]);
  await query(`INSERT INTO signal_credit_transactions (id, idempotency_key, user_id, saved_signal_id, transaction_type, quantity, balance_delta, credit_pool, reason, original_transaction_id)
    VALUES ($1, $1, $2, $3, 'terminal_refund', 1, 1, 'unlock_credits_balance', 'Stop Loss', $4)`,
  [s("ct_refund"), userId, ledgerSignal, s("ct_charge")]);
  await query(`INSERT INTO unlocked_signals (id, user_id, saved_signal_id) VALUES ($1, $2, $3)`, [s("us"), userId, ledgerSignal]);
  await query(`INSERT INTO signal_snapshots (saved_signal_id, user_id, snapshot) VALUES ($1, $2, '{}')`, [plainSignal, userId]);
  await query(`INSERT INTO signal_learning_events (id, signal_id, user_id, pair, timeframe, direction, strategy, outcome, created_at, closed_at)
    VALUES ($1, $2, $3, 'BTC-USD', '1h', 'long', 'test', 'Hit SL', now(), now())`, [s("sle"), ledgerSignal, userId]);
  await query(`INSERT INTO signal_validation_rejections (id, user_id, symbol, timeframe, strategy) VALUES ($1, $2, 'BTC-USD', '1h', 'test')`, [s("svr"), userId]);
  await query(`INSERT INTO paper_accounts (user_id) VALUES ($1)`, [userId]);
  await query(`INSERT INTO paper_orders (id, user_id, symbol, timeframe, direction, order_type, status, quantity, position_size_usd, stop_loss, take_profit)
    VALUES ($1, $2, 'BTC-USD', '1h', 'long', 'market', 'Open', 1, 100, 90, 120)`, [s("po"), userId]);
  await query(`INSERT INTO paper_trades (id, user_id, saved_signal_id) VALUES ($1, $2, $3)`, [s("pt"), userId, plainSignal]);
  await query(`INSERT INTO trade_journals (paper_trade_id, user_id) VALUES ($1, $2)`, [s("pt"), userId]);
  await query(`INSERT INTO tester_access_requests (id, user_id) VALUES ($1, $2)`, [s("tar"), userId]);
  await query(`INSERT INTO scan_result_cache (user_id, scan_key, result_json, expires_at) VALUES ($1, 'k', '{}', now() + interval '1 hour')`, [userId]);
  await query(`INSERT INTO setup_discovery_usage (id, user_id, scan_key, quantity) VALUES ($1, $2, 'k', 1)`, [s("sdu"), userId]);
  await query(`INSERT INTO affiliate_clicks (id, affiliate_user_id, visitor_id) VALUES ($1, $2, 'v1')`, [s("ac"), userId]);
  await query(`INSERT INTO login_attempts (id, email_hash, ip_hash, successful) VALUES ($1, $2, 'ip', false)`,
    [s("la"), hashIdentifier(`email:${email.toLowerCase()}`)]);

  // Support: one unaudited ticket (deleted), one audited (scrubbed + kept),
  // one public recovery ticket with no user_id, matched by email (deleted).
  const ticket = (id, uid) => query(`INSERT INTO support_tickets (id, user_id, username_snapshot, email_snapshot, topic, issue, subject, message, user_agent, page_url, requester_fingerprint_hash)
    VALUES ($1, $2, 'someone', $3, 'account', 'login', 'Help me', 'My name is Private Person', 'UA', '/x', 'fp')`, [id, uid, email]);
  await ticket(s("tk_plain"), userId);
  await ticket(s("tk_audited"), userId);
  await ticket(s("tk_public"), null);
  await query(`INSERT INTO admin_support_audit_log (id, admin_user_id, target_user_id, ticket_id, action) VALUES ($1, $2, $3, $4, 'account_lookup')`,
    [s("audit"), adminId, userId, s("tk_audited")]);

  // Retained list
  await query(`INSERT INTO device_trial_history (device_fingerprint_hash, first_user_id, trial_used, trial_used_at) VALUES ($1, $2, true, now())`,
    [deviceHash, userId]);
  await query(`INSERT INTO billing_credit_grants (id, user_id, external_reference, source, quantity) VALUES ($1, $2, $1, 'test', 10)`, [s("bcg"), userId]);
  await query(`INSERT INTO billing_entitlement_grants (id, user_id, external_reference, plan, scan_credits, unlock_credits) VALUES ($1, $2, $1, 'pro', 1, 1)`, [s("beg"), userId]);
  await query(`INSERT INTO affiliate_referrals (id, affiliate_user_id, referred_user_id, subscription_plan, monthly_commission_cents, lifetime_commission_cents, active)
    VALUES ($1, $2, $3, 'pro', 870, 870, true)`, [s("ref"), affiliateId, userId]);
  await query(`INSERT INTO affiliate_commissions (id, referral_id, stripe_invoice_id, stripe_event_id, subscription_plan, gross_amount_cents, commission_amount_cents)
    VALUES ($1, $2, $1, $1, 'pro', 2900, 870)`, [s("comm"), s("ref")]);
  await query(`INSERT INTO affiliate_payout_requests (id, affiliate_user_id, amount_cents, payout_method, payout_destination, status)
    VALUES ($1, $2, 2500, 'paypal', $3, 'approved')`, [s("payout"), userId, email]);
  await query(`INSERT INTO stripe_webhook_events (event_id, event_type, status, user_id, stripe_object_id, payload_json)
    VALUES ($1, 'checkout.session.completed', 'processed', $2, 'cs_test', $3)`,
  [s("evt"), userId, JSON.stringify({ id: s("evt"), data: { object: {
    id: "cs_test", amount_total: 2900, customer: `cus_${userId}`, customer_email: email,
    customer_details: { email, name: "Private Person", address: { line1: "1 Main St" } },
    metadata: { user_id: userId }
  } } })]);
  await query(`INSERT INTO product_analytics_events (id, event_type, user_id, amount_cents) VALUES ($1, 'checkout_completed', $2, 2900)`, [s("pae"), userId]);
  const promo = s("promo");
  await query(`INSERT INTO promo_codes (id, code, type, max_redemptions, created_by_admin_id, credit_quantity) VALUES ($1, $2, 'credit_grant', 10, $3, 5)`,
    [promo, promo.slice(-20).toUpperCase(), adminId]);
  await query(`INSERT INTO promo_code_redemptions (id, promo_code_id, user_id) VALUES ($1, $2, $3)`, [s("pcr"), promo, userId]);

  return { email, deviceHash, ledgerSignal, activeLedgerSignal, plainSignal, auditedTicket: s("tk_audited"), publicTicket: s("tk_public"), plainTicket: s("tk_plain") };
}

export async function countRows(userId) {
  const counts = {};
  for (const [table, column] of [...HARD_DELETE_TABLES, ...RETAINED_TABLES]) {
    const result = await query(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE ${column} = $1`, [userId]);
    counts[`${table}.${column}`] = result.rows[0].n;
  }
  return counts;
}

export async function verifyDeletedAccount(userId, seeded) {
  const report = { hardDeleted: {}, retained: {} };

  for (const [table, column] of HARD_DELETE_TABLES) {
    const n = (await query(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE ${column} = $1`, [userId])).rows[0].n;
    report.hardDeleted[table] = n;
    assert.equal(n, 0, `${table} still has rows for the deleted user`);
  }
  const loginAttempts = (await query(`SELECT COUNT(*)::integer AS n FROM login_attempts WHERE email_hash = $1`,
    [hashIdentifier(`email:${seeded.email.toLowerCase()}`)])).rows[0].n;
  assert.equal(loginAttempts, 0, "login_attempts for the old email hash remain");

  const signals = (await query(`SELECT id FROM saved_signals WHERE user_id = $1 ORDER BY id`, [userId])).rows.map((r) => r.id);
  assert.deepEqual(signals.sort(), [seeded.ledgerSignal, seeded.activeLedgerSignal].sort(), "only ledger-referenced signals retained");
  report.hardDeleted.saved_signals_unreferenced = signals.includes(seeded.plainSignal) ? 1 : 0;

  const tickets = (await query(`SELECT * FROM support_tickets WHERE id = ANY($1)`,
    [[seeded.auditedTicket, seeded.publicTicket, seeded.plainTicket]])).rows;
  assert.equal(tickets.length, 1, "only the audited ticket survives");
  const kept = tickets[0];
  assert.equal(kept.id, seeded.auditedTicket);
  assert.equal(kept.user_id, null);
  assert.equal(kept.email_snapshot, deletedUserEmail(userId));
  assert.equal(kept.message, "[deleted]");
  assert.equal(kept.subject, "[deleted]");
  assert.equal(kept.username_snapshot, null);
  assert.equal(kept.requester_fingerprint_hash, null);
  const audit = (await query(`SELECT COUNT(*)::integer AS n FROM admin_support_audit_log WHERE ticket_id = $1`, [seeded.auditedTicket])).rows[0].n;
  assert.equal(audit, 1, "admin audit entry retained");
  report.retained.support_tickets_audited = { email_snapshot: kept.email_snapshot, message: kept.message };

  const u = (await query(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0];
  assert.ok(u, "users row retained");
  assert.equal(u.email, deletedUserEmail(userId));
  assert.equal(u.name, "Deleted user");
  assert.equal(u.password_hash, "");
  assert.equal(u.password_salt, "");
  assert.equal(u.signup_ip_hash, null);
  assert.equal(u.device_fingerprint_hash, null);
  assert.equal(u.username, null);
  assert.equal(u.username_normalized, null);
  assert.equal(u.public_profile_enabled, false);
  assert.equal(u.public_leaderboard_enabled, false);
  assert.equal(u.affiliate_code, null);
  assert.equal(u.account_status, "deleted");
  assert.ok(u.deleted_at instanceof Date);
  report.retained.users = { email: u.email, name: u.name, account_status: u.account_status, deleted_at: u.deleted_at };

  // The seeded charges/refund must all survive. A live server's expiry job may legitimately add a
  // refund while the account is still active, but nothing may be written after deletion.
  const ledger = (await query(`SELECT t.id, t.created_at > u.deleted_at AS after_deletion,
      t.original_transaction_id IS NULL OR EXISTS (SELECT 1 FROM signal_credit_transactions o WHERE o.id = t.original_transaction_id) AS chain_ok
    FROM signal_credit_transactions t JOIN users u ON u.id = t.user_id WHERE t.user_id = $1`, [userId])).rows;
  const ledgerIds = ledger.map((row) => row.id);
  for (const id of [`ct_charge_${userId}`, `ct_charge_live_${userId}`, `ct_refund_${userId}`]) {
    assert.ok(ledgerIds.includes(id), `ledger row ${id} lost`);
  }
  assert.ok(ledger.every((row) => !row.after_deletion), "ledger row written after deletion");
  assert.ok(ledger.every((row) => row.chain_ok), "refund chain broken");
  report.retained.signal_credit_transactions = ledger.length;

  const sub = (await query(`SELECT status, provider_customer_id, provider_subscription_id FROM subscriptions WHERE user_id = $1`, [userId])).rows[0];
  assert.equal(sub.status, "canceled");
  assert.equal(sub.provider_subscription_id, null);
  assert.equal(sub.provider_customer_id, null, "Stripe customer id cleared");

  // Device trial history is retained unchanged: same hash, still used, pointing at the anonymized user.
  const trial = (await query(`SELECT * FROM device_trial_history WHERE device_fingerprint_hash = $1`, [seeded.deviceHash])).rows[0];
  assert.ok(trial, "device_trial_history row retained");
  assert.equal(trial.first_user_id, userId);
  assert.equal(trial.trial_used, true);
  assert.deepEqual(Object.keys(trial).sort(),
    ["device_fingerprint_hash", "first_user_id", "trial_granted_at", "trial_used", "trial_used_at", "updated_at"],
    "device_trial_history gained a column; check it for identifying data");
  report.retained.device_trial_history = { first_user_id: trial.first_user_id, trial_used: trial.trial_used };
  report.retained.subscriptions = sub;

  const ref = (await query(`SELECT r.active, r.lifetime_commission_cents, COUNT(c.id)::integer AS commissions
    FROM affiliate_referrals r LEFT JOIN affiliate_commissions c ON c.referral_id = r.id
    WHERE r.referred_user_id = $1 GROUP BY r.id`, [userId])).rows[0];
  assert.equal(ref.active, false);
  assert.equal(ref.lifetime_commission_cents, 870, "affiliate's earned commission preserved");
  assert.equal(ref.commissions, 1, "commission row preserved");
  report.retained.affiliate_referrals = ref;

  const payout = (await query(`SELECT payout_destination, amount_cents FROM affiliate_payout_requests WHERE affiliate_user_id = $1`, [userId])).rows[0];
  assert.equal(payout.payout_destination, "[deleted]");
  report.retained.affiliate_payout_requests = payout;

  const hook = (await query(`SELECT payload_json FROM stripe_webhook_events WHERE user_id = $1`, [userId])).rows[0];
  const obj = hook.payload_json.data.object;
  assert.equal(obj.customer_email, null);
  assert.equal(obj.customer_details, null);
  assert.equal(obj.amount_total, 2900, "non-PII billing facts kept");
  assert.equal(obj.customer, `cus_${userId}`);
  assert.ok(!JSON.stringify(hook.payload_json).includes(seeded.email), "old email absent from webhook payload");
  report.retained.stripe_webhook_events = { customer_email: obj.customer_email, amount_total: obj.amount_total };

  const analytics = (await query(`SELECT COUNT(*)::integer AS n FROM product_analytics_events WHERE user_id = $1`, [userId])).rows[0].n;
  assert.equal(analytics, 0, "analytics unlinked");

  for (const [table, column] of RETAINED_TABLES) {
    const n = (await query(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE ${column} = $1`, [userId])).rows[0].n;
    report.retained[`${table}.${column} rows`] = n;
  }
  for (const table of ["billing_credit_grants", "billing_entitlement_grants", "promo_code_redemptions", "credit_balances"]) {
    assert.equal(report.retained[`${table}.user_id rows`], 1, `${table} retained`);
  }
  assert.equal(report.retained["device_trial_history.first_user_id rows"], 1, "device_trial_history retained");

  // No trace of the old email anywhere in retained user-scoped text.
  const leaks = (await query(`
    SELECT 'users' AS t FROM users WHERE id = $1 AND (email = $2 OR name ILIKE '%Private%')
    UNION ALL SELECT 'support_tickets' FROM support_tickets WHERE lower(email_snapshot) = lower($2)
    UNION ALL SELECT 'oauth_accounts' FROM oauth_accounts WHERE provider_email = $2
    UNION ALL SELECT 'affiliate_payout_requests' FROM affiliate_payout_requests WHERE payout_destination = $2
    UNION ALL SELECT 'stripe_webhook_events' FROM stripe_webhook_events WHERE payload_json::text ILIKE '%' || $2 || '%'
  `, [userId, seeded.email])).rows;
  assert.deepEqual(leaks, [], "old email found in retained rows");

  return report;
}

export async function cleanupTestUsers(userIds) {
  await query(`DELETE FROM admin_support_audit_log WHERE admin_user_id = ANY($1) OR target_user_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM support_tickets WHERE email_snapshot LIKE 'deleted-user-usr_deltest_%' OR user_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM promo_code_redemptions WHERE user_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM promo_codes WHERE created_by_admin_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM stripe_webhook_events WHERE user_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM device_trial_history WHERE first_user_id = ANY($1)`, [userIds]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
}
