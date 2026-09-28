import { query, transaction } from "../../db/client.js";

// Tables whose rows are deleted outright, scoped by the named user column.
// Order matters only where noted; everything else has no FKs between these rows.
export const HARD_DELETE_TABLES = [
  ["sessions", "user_id"],
  ["auth_restore_tokens", "user_id"],
  ["password_reset_tokens", "user_id"],
  ["email_verification_tokens", "user_id"],
  ["oauth_accounts", "user_id"],
  ["telegram_notification_queue", "user_id"],
  ["telegram_notification_settings", "user_id"],
  ["telegram_connection_codes", "user_id"],
  ["watchlist_markets", "user_id"],
  ["alert_preferences", "user_id"],
  ["detected_alerts", "user_id"],
  ["unlocked_signals", "user_id"],
  ["paper_trades", "user_id"],
  ["paper_orders", "user_id"],
  ["paper_accounts", "user_id"],
  ["trade_journals", "user_id"],
  ["tester_access_requests", "user_id"],
  ["scan_result_cache", "user_id"],
  ["setup_discovery_usage", "user_id"],
  ["signal_learning_events", "user_id"],
  ["signal_snapshots", "user_id"],
  ["signal_validation_rejections", "user_id"],
  ["affiliate_clicks", "affiliate_user_id"]
];

// Retained rows. Listed here so the verification test checks the same set the code acts on.
// users, subscriptions, support_tickets (audited only), stripe_webhook_events and
// affiliate_payout_requests are scrubbed below; the rest carry no identifying fields
// beyond user_id, which now points at the anonymized users row.
export const RETAINED_TABLES = [
  ["users", "id"],
  ["subscriptions", "user_id"],
  ["credit_balances", "user_id"],
  ["signal_credit_transactions", "user_id"],
  ["billing_credit_grants", "user_id"],
  ["billing_entitlement_grants", "user_id"],
  ["promo_code_redemptions", "user_id"],
  // Only the device hash, trial flags/timestamps and first_user_id (now the anonymized user).
  // Kept so a new signup from the same device is still recognised as a repeat trial.
  ["device_trial_history", "first_user_id"],
  ["affiliate_referrals", "referred_user_id"],
  ["affiliate_referrals", "affiliate_user_id"],
  ["affiliate_payout_requests", "affiliate_user_id"],
  ["stripe_webhook_events", "user_id"]
];

const STRIPE_PII_KEYS = new Set([
  "email", "customer_email", "receipt_email",
  "name", "customer_name",
  "phone", "customer_phone",
  "address", "customer_address",
  "shipping", "customer_shipping", "shipping_details",
  "customer_details", "billing_details"
]);

export function deletedUserEmail(userId) {
  return `deleted-user-${userId}@signalforge.invalid`;
}

export async function deleteAccountData({ userId, email, loginEmailHash }) {
  return transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (!locked.rows[0]) throw notFound();
    if (locked.rows[0].deleted_at) return { alreadyDeleted: true };

    const counts = {};

    for (const [table, column] of HARD_DELETE_TABLES) {
      const result = await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [userId]);
      counts[table] = result.rowCount;
    }
    // Saved signals referenced by the credit ledger stay: signal_credit_transactions.saved_signal_id
    // is ON DELETE CASCADE, so deleting them would erase ledger rows. They hold market data only.
    // Their signal_outcomes rows stay too (the refund path joins on them, and a missing row reads
    // as 'Active'); the outcome trackers skip deleted accounts. Everything else cascades.
    const signals = await client.query(`
      DELETE FROM saved_signals s
      WHERE s.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM signal_credit_transactions t WHERE t.saved_signal_id = s.id)
    `, [userId]);
    counts.saved_signals = signals.rowCount;

    if (loginEmailHash) {
      await client.query(`DELETE FROM login_attempts WHERE email_hash = $1`, [loginEmailHash]);
    }

    // Support tickets with admin audit entries are scrubbed and kept, because
    // admin_support_audit_log.ticket_id is ON DELETE CASCADE. The rest are deleted.
    // Public recovery tickets have no user_id, so they are matched on the email snapshot too.
    const ticketMatch = `(user_id = $1 OR lower(email_snapshot) = lower($2))`;
    const audited = `EXISTS (SELECT 1 FROM admin_support_audit_log a WHERE a.ticket_id = support_tickets.id)`;
    const deletedTickets = await client.query(
      `DELETE FROM support_tickets WHERE ${ticketMatch} AND NOT ${audited}`,
      [userId, email]
    );
    counts.support_tickets = deletedTickets.rowCount;
    await client.query(`
      UPDATE support_tickets
      SET user_id = NULL, username_snapshot = NULL, email_snapshot = $3,
        subject = '[deleted]', message = '[deleted]', public_response = '',
        admin_notes = '', user_agent = NULL, page_url = NULL,
        requester_fingerprint_hash = NULL, updated_at = now()
      WHERE ${ticketMatch} AND ${audited}
    `, [userId, email, deletedUserEmail(userId)]);

    await client.query(`UPDATE product_analytics_events SET user_id = NULL WHERE user_id = $1`, [userId]);

    await client.query(`
      UPDATE affiliate_referrals
      SET active = false, subscription_plan = 'free', monthly_commission_cents = 0, updated_at = now()
      WHERE referred_user_id = $1
    `, [userId]);
    await client.query(`
      UPDATE affiliate_payout_requests
      SET payout_destination = '[deleted]', updated_at = now()
      WHERE affiliate_user_id = $1
    `, [userId]);

    const webhookEvents = await client.query(
      `SELECT event_id, payload_json, result_json FROM stripe_webhook_events WHERE user_id = $1`,
      [userId]
    );
    for (const row of webhookEvents.rows) {
      await client.query(
        `UPDATE stripe_webhook_events SET payload_json = $2, result_json = $3 WHERE event_id = $1`,
        [row.event_id, scrubStripePii(row.payload_json), scrubStripePii(row.result_json)]
      );
    }

    await client.query(`
      UPDATE subscriptions
      SET status = 'canceled', provider_customer_id = NULL, provider_subscription_id = NULL,
        price_id = NULL, cancel_at_period_end = false, updated_at = now()
      WHERE user_id = $1
    `, [userId]);

    await client.query(`
      UPDATE users
      SET name = 'Deleted user', email = $2,
        password_salt = '', password_hash = '',
        signup_ip_hash = NULL, device_fingerprint_hash = NULL,
        username = NULL, username_normalized = NULL, username_updated_at = NULL,
        public_profile_enabled = false, public_leaderboard_enabled = false,
        email_verified_at = NULL, affiliate_code = NULL, affiliate_disabled = true,
        abuse_flags = '[]'::jsonb, plan = 'free',
        account_status = 'deleted', deleted_at = now(), updated_at = now()
      WHERE id = $1
    `, [userId, deletedUserEmail(userId)]);

    return { alreadyDeleted: false, counts };
  });
}

export function scrubStripePii(value) {
  if (Array.isArray(value)) return value.map(scrubStripePii);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    key,
    STRIPE_PII_KEYS.has(key) ? null : scrubStripePii(inner)
  ]));
}

function notFound() {
  const error = new Error("Account not found.");
  error.statusCode = 404;
  return error;
}

export async function countPendingAffiliatePayouts(userId) {
  const result = await query(`
    SELECT COUNT(*)::integer AS count
    FROM affiliate_payout_requests
    WHERE affiliate_user_id = $1 AND status = 'pending'
  `, [userId]);
  return result.rows[0].count;
}
