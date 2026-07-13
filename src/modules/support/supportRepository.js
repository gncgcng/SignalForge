import { query, transaction } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

const ticketSelect = `
  SELECT
    t.*,
    COALESCE(u.username, t.username_snapshot) AS current_username,
    COALESCE(u.email, t.email_snapshot) AS current_email,
    COALESCE(u.plan, t.subscription_tier_snapshot) AS current_plan,
    COALESCE(c.unlock_credits_balance, t.credit_balance_snapshot) AS current_credit_balance
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
  const result = await query(`
    UPDATE support_tickets
    SET status = $2,
      priority = $3,
      admin_notes = $4,
      assigned_to = $5,
      resolved_at = CASE
        WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now())
        ELSE NULL
      END,
      updated_at = now()
    WHERE id = $1
    RETURNING id
  `, [ticketId, update.status, update.priority, update.adminNotes, adminId]);
  return result.rows[0] ? findSupportTicketForAdmin(ticketId) : null;
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
    source: row.source || "authenticated_support"
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
    }
  };
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
