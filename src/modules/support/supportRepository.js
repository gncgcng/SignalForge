import { query, transaction } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

const ticketSelect = `
  SELECT
    t.*,
    COALESCE(u.username, t.username_snapshot) AS current_username,
    COALESCE(u.email, t.email_snapshot) AS current_email,
    COALESCE(u.plan, t.subscription_tier_snapshot) AS current_plan,
    COALESCE(c.unlock_credits_balance, t.credit_balance_snapshot) AS current_credit_balance,
    CASE WHEN t.source = 'public_account_recovery' THEN EXISTS (
      SELECT 1 FROM users ru
      WHERE lower(ru.email) = lower(t.email_snapshot)
        OR (t.username_snapshot IS NOT NULL AND ru.username_normalized = lower(t.username_snapshot))
    ) ELSE false END AS recovery_account_found
  FROM support_tickets t
  LEFT JOIN users u ON u.id = t.user_id
  LEFT JOIN credit_balances c ON c.user_id = t.user_id
`;

export async function createSupportTicketRecord(user, input, context) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`support:${user.id}`]);
    const limits = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS hourly,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day') AS daily
      FROM support_tickets
      WHERE user_id = $1 AND created_at >= now() - interval '1 day'
    `, [user.id]);
    const hourly = Number(limits.rows[0]?.hourly || 0);
    const daily = Number(limits.rows[0]?.daily || 0);
    assertSupportSubmissionAllowed(hourly, daily);

    const result = await client.query(`
      INSERT INTO support_tickets (
        id, user_id, username_snapshot, email_snapshot,
        subscription_tier_snapshot, credit_balance_snapshot,
        topic, issue, subject, message, priority,
        related_signal_id, related_subscription_id, user_agent, page_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      createId("ticket"),
      user.id,
      user.username || null,
      user.email,
      user.plan || "free",
      Number(user.unlockCreditsBalance || 0),
      input.topic,
      input.issue,
      input.subject,
      input.message,
      input.priority,
      input.relatedSignalId || null,
      input.relatedSubscriptionId || user.subscription?.providerSubscriptionId || null,
      context.userAgent || null,
      context.pageUrl || null
    ]);
    return mapTicket(result.rows[0], { admin: false });
  });
}

export async function createPublicRecoveryTicketRecord(input, context) {
  return transaction(async (client) => {
    const fingerprint = context.requesterFingerprintHash;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`recovery:${fingerprint}`]);
    const limits = await client.query(`
      SELECT COUNT(*) AS hourly
      FROM support_tickets
      WHERE source = 'public_account_recovery'
        AND requester_fingerprint_hash = $1
        AND created_at >= now() - interval '1 hour'
    `, [fingerprint]);
    assertPublicRecoverySubmissionAllowed(Number(limits.rows[0]?.hourly || 0));

    const result = await client.query(`
      INSERT INTO support_tickets (
        id, user_id, username_snapshot, email_snapshot,
        topic, issue, subject, message, priority,
        user_agent, page_url, source, requester_fingerprint_hash
      )
      VALUES ($1,NULL,$2,$3,'Account / Login','Account recovery',$4,$5,'normal',$6,$7,'public_account_recovery',$8)
      RETURNING *
    `, [
      createId("ticket"),
      input.username || null,
      input.email,
      input.subject,
      input.message,
      context.userAgent || null,
      context.pageUrl || null,
      fingerprint
    ]);
    return mapTicket(result.rows[0], { admin: false });
  });
}

export async function listSupportTicketsByUser(userId) {
  const result = await query(`
    SELECT * FROM support_tickets
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 100
  `, [userId]);
  return result.rows.map((row) => mapTicket(row, { admin: false }));
}

export async function findSupportTicketByUser(userId, ticketId) {
  const result = await query(`
    SELECT * FROM support_tickets
    WHERE id = $1 AND user_id = $2
    LIMIT 1
  `, [ticketId, userId]);
  return result.rows[0] ? mapTicket(result.rows[0], { admin: false }) : null;
}

export async function listAllSupportTickets(filters = {}) {
  const values = [];
  const clauses = [];
  const add = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.status) clauses.push(`t.status = ${add(filters.status)}`);
  if (filters.topic) clauses.push(`t.topic = ${add(filters.topic)}`);
  if (filters.priority) clauses.push(`t.priority = ${add(filters.priority)}`);
  if (filters.source) clauses.push(`t.source = ${add(filters.source)}`);
  if (filters.from) clauses.push(`t.created_at >= ${add(filters.from)}`);
  if (filters.to) clauses.push(`t.created_at < ${add(filters.to)}`);
  if (filters.search) {
    const term = add(`%${filters.search}%`);
    clauses.push(`(
      COALESCE(u.username, t.username_snapshot, '') ILIKE ${term}
      OR COALESCE(u.email, t.email_snapshot, '') ILIKE ${term}
      OR t.subject ILIKE ${term}
      OR t.message ILIKE ${term}
    )`);
  }
  const limit = Math.min(250, Math.max(1, Number(filters.limit || 100)));
  values.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(`
    ${ticketSelect}
    ${where}
    ORDER BY
      CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      t.created_at DESC
    LIMIT $${values.length}
  `, values);
  return result.rows.map((row) => mapTicket(row, { admin: true }));
}

export async function findSupportTicketForAdmin(ticketId) {
  const result = await query(`${ticketSelect} WHERE t.id = $1 LIMIT 1`, [ticketId]);
  return result.rows[0] ? mapTicket(result.rows[0], { admin: true }) : null;
}

export async function updateSupportTicketRecord(ticketId, adminId, update) {
  const updated = await transaction(async (client) => {
    const current = await client.query("SELECT status, priority FROM support_tickets WHERE id = $1 FOR UPDATE", [ticketId]);
    if (!current.rows[0]) return false;
    await client.query(`
      UPDATE support_tickets
      SET status = $2, priority = $3, admin_notes = $4, public_response = $5,
        assigned_to = $6,
        resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) ELSE NULL END,
        updated_at = now()
      WHERE id = $1
    `, [ticketId, update.status, update.priority, update.adminNotes, update.publicResponse, adminId]);
    const changes = [];
    if (current.rows[0].status !== update.status) changes.push("status_changed");
    if (current.rows[0].priority !== update.priority) changes.push("priority_changed");
    for (const action of changes) await insertAudit(client, { adminId, ticketId, action });
    return true;
  });
  return updated ? findSupportTicketForAdmin(ticketId) : null;
}

export async function lookupRecoveryAccount(ticketId, adminId) {
  return transaction(async (client) => {
    const ticketResult = await client.query("SELECT * FROM support_tickets WHERE id = $1", [ticketId]);
    const ticket = ticketResult.rows[0];
    if (!ticket) return null;
    if (ticket.source !== "public_account_recovery") {
      const error = new Error("Account recovery tools are only available for recovery tickets.");
      error.statusCode = 400;
      throw error;
    }
    const accountResult = await client.query(`
      SELECT u.id, u.username, u.email, u.plan, u.created_at,
        CASE WHEN lower(u.email) = lower($1) THEN 'email' ELSE 'username_only' END AS match_type,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at,
        (SELECT COUNT(*)::integer FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions,
        (SELECT COUNT(*)::integer FROM auth_restore_tokens r WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.expires_at > now()) AS active_restore_tokens
      FROM users u
      WHERE lower(u.email) = lower($1)
        OR ($2 IS NOT NULL AND u.username_normalized = lower($2))
      ORDER BY CASE WHEN lower(u.email) = lower($1) THEN 0 ELSE 1 END
      LIMIT 1
    `, [ticket.email_snapshot, ticket.username_snapshot || null]);
    const account = accountResult.rows[0] || null;
    await insertAudit(client, { adminId, targetUserId: account?.id, ticketId, action: "account_lookup", metadata: { matched: Boolean(account) } });
    return { ticket, account: account ? mapRecoveryAccount(account) : null };
  });
}

export async function setRecoveryTemporaryPassword({ ticketId, adminId, targetUserId, password }) {
  return transaction(async (client) => {
    await assertRecoveryTarget(client, ticketId, targetUserId);
    const recent = await client.query(`SELECT COUNT(*)::integer AS count FROM admin_support_audit_log WHERE admin_user_id = $1 AND action = 'temporary_password_set' AND created_at >= now() - interval '1 hour'`, [adminId]);
    if (Number(recent.rows[0]?.count || 0) >= 10) throw rateLimitError("Temporary password action limit reached.");
    await client.query("UPDATE users SET password_salt = $2, password_hash = $3, updated_at = now() WHERE id = $1", [targetUserId, password.salt, password.hash]);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
    await client.query("UPDATE auth_restore_tokens SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [targetUserId]);
    await client.query(`UPDATE support_tickets SET status = 'waiting_for_user', admin_notes = concat_ws(E'\n', nullif(admin_notes, ''), $2), assigned_to = $3, updated_at = now() WHERE id = $1`, [ticketId, `Temporary password set by admin at ${new Date().toISOString()}. Sessions revoked.`, adminId]);
    await insertAudit(client, { adminId, targetUserId, ticketId, action: "temporary_password_set", metadata: { sessionsRevoked: true } });
    return true;
  });
}

export async function revokeRecoveryAccountSessions({ ticketId, adminId, targetUserId }) {
  return transaction(async (client) => {
    await assertRecoveryTarget(client, ticketId, targetUserId);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [targetUserId]);
    await client.query("UPDATE auth_restore_tokens SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [targetUserId]);
    await client.query(`UPDATE support_tickets SET admin_notes = concat_ws(E'\n', nullif(admin_notes, ''), $2), assigned_to = $3, updated_at = now() WHERE id = $1`, [ticketId, `User sessions revoked by admin at ${new Date().toISOString()}.`, adminId]);
    await insertAudit(client, { adminId, targetUserId, ticketId, action: "sessions_revoked" });
    return true;
  });
}

export async function getSupportTicketSummary() {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('open', 'in_review', 'waiting_for_user')) AS open_tickets,
      COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('resolved', 'closed')) AS urgent_tickets,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS new_today,
      MIN(created_at) FILTER (WHERE status IN ('open', 'in_review', 'waiting_for_user')) AS oldest_open_at
    FROM support_tickets
  `);
  const row = result.rows[0] || {};
  return {
    openTickets: Number(row.open_tickets || 0),
    urgentTickets: Number(row.urgent_tickets || 0),
    newToday: Number(row.new_today || 0),
    oldestOpenAt: row.oldest_open_at || null
  };
}

function mapTicket(row, { admin }) {
  const ticket = {
    id: row.id,
    topic: row.topic,
    issue: row.issue,
    subject: row.subject,
    message: row.message,
    status: row.status,
    priority: row.priority,
    relatedSignalId: row.related_signal_id || null,
    relatedSubscriptionId: row.related_subscription_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
    source: row.source || "authenticated_support",
    publicResponse: row.public_response || ""
  };
  if (!admin) return ticket;
  return {
    ...ticket,
    adminNotes: row.admin_notes || "",
    assignedTo: row.assigned_to || null,
    user: {
      id: row.user_id,
      username: row.current_username || row.username_snapshot || (row.user_id ? "No username" : "Logged-out user"),
      email: row.current_email || row.email_snapshot,
      subscriptionTier: row.current_plan || row.subscription_tier_snapshot || "free",
      creditBalance: Number(row.current_credit_balance ?? row.credit_balance_snapshot ?? 0)
    },
    context: {
      userAgent: row.user_agent || "",
      pageUrl: row.page_url || ""
    },
    accountMatchStatus: row.source === "public_account_recovery" ? Boolean(row.recovery_account_found) : null
  };
}

async function assertRecoveryTarget(client, ticketId, targetUserId) {
  const result = await client.query(`SELECT t.id FROM support_tickets t JOIN users u ON u.id = $2 WHERE t.id = $1 AND t.source = 'public_account_recovery' AND lower(u.email) = lower(t.email_snapshot)`, [ticketId, targetUserId]);
  if (!result.rows[0]) {
    const error = new Error("Account does not match this recovery request.");
    error.statusCode = 409;
    throw error;
  }
}

async function insertAudit(client, { adminId, targetUserId = null, ticketId, action, metadata = {} }) {
  await client.query(`INSERT INTO admin_support_audit_log (id, admin_user_id, target_user_id, ticket_id, action, metadata) VALUES ($1,$2,$3,$4,$5,$6)`, [createId("audit"), adminId, targetUserId, ticketId, action, JSON.stringify(metadata)]);
}

function mapRecoveryAccount(row) {
  return {
    id: row.id, username: row.username || "", email: row.email, plan: row.plan || "free",
    createdAt: row.created_at, lastLoginAt: row.last_login_at, matchType: row.match_type,
    activeSessions: Number(row.active_sessions || 0), activeRestoreTokens: Number(row.active_restore_tokens || 0)
  };
}

function rateLimitError(message) {
  const error = new Error(message);
  error.statusCode = 429;
  return error;
}

export function assertPublicRecoverySubmissionAllowed(hourly) {
  if (Number(hourly) >= 3) {
    const error = new Error("Account recovery request limit reached. Please wait before submitting another request.");
    error.statusCode = 429;
    error.code = "RECOVERY_RATE_LIMIT";
    throw error;
  }
  return true;
}

export function assertSupportSubmissionAllowed(hourly, daily) {
  if (Number(hourly) >= 5 || Number(daily) >= 20) {
    const error = new Error("Support request limit reached. Please wait before submitting another ticket.");
    error.statusCode = 429;
    error.code = "SUPPORT_RATE_LIMIT";
    throw error;
  }
  return true;
}
