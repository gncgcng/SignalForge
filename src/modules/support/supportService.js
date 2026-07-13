import { createHmac } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { getSignupContext } from "../auth/abuseProtectionService.js";
import { hashPassword, isAdminUser } from "../auth/authService.js";
import {
  sendSupportAdminNotificationEmail,
  sendSupportConfirmationEmail
} from "../notifications/transactionalEmailService.js";
import {
  createSupportTicketRecord,
  createPublicRecoveryTicketRecord,
  findSupportTicketByUser,
  findSupportTicketForAdmin,
  getSupportTicketSummary,
  lookupRecoveryAccount,
  listAllSupportTickets,
  listSupportTicketsByUser,
  revokeRecoveryAccountSessions,
  setRecoveryTemporaryPassword,
  updateSupportTicketRecord
} from "./supportRepository.js";

const recoveryIssues = new Set(["Can’t sign in", "Forgot password", "Email reset unavailable", "Account locked", "Other"]);

export const supportIssues = Object.freeze({
  "Account / Login": ["Cannot sign in", "Google login issue", "Password reset issue", "Session keeps expiring", "Account settings issue"],
  "Billing / Subscription": ["Payment failed", "Subscription not active", "Cancel subscription", "Refund question", "Invoice question"],
  "Credits / Unlocks": ["Credits missing", "Signal charged twice", "Signal did not unlock", "Wrong credit balance"],
  "Telegram Alerts": ["Not receiving alerts", "Telegram not connecting", "Unlock link not opening app", "Duplicate alerts"],
  "Signals / Scanner": ["Signal looks wrong", "TP/SL issue", "Confidence issue", "Scanner not finding setups"],
  "Paper Trading": ["Order did not open", "TP/SL tracking issue", "Balance or P/L issue", "Chart or market data issue"],
  "Affiliate Program": ["Referral not tracked", "Commission missing", "Payout question", "Affiliate link issue"],
  "Bug Report": ["Page error", "Mobile layout issue", "Data not loading", "Unexpected behavior"],
  "Feature Request": ["Scanner improvement", "Alert improvement", "Paper trading improvement", "Other feature request"],
  Other: ["General question", "Other issue"]
});

const statuses = new Set(["open", "in_review", "waiting_for_user", "resolved", "closed"]);
const priorities = new Set(["low", "normal", "high", "urgent"]);

export async function getMySupportTickets(user) {
  return {
    topics: supportIssues,
    tickets: await listSupportTicketsByUser(user.id)
  };
}

export async function getMySupportTicket(user, ticketId) {
  const ticket = await findSupportTicketByUser(user.id, cleanId(ticketId));
  if (!ticket) throw httpError(404, "Support request not found.");
  return { ticket };
}

export async function submitSupportTicket(user, input, context = {}) {
  const ticketInput = validateSupportTicketInput(input);
  const ticket = await createSupportTicketRecord(user, ticketInput, {
    userAgent: cleanText(context.userAgent, 500),
    pageUrl: validatePageUrl(input.pageUrl)
  });

  if (appConfig.email.featuresEnabled) {
    void sendSupportConfirmationEmail(user, ticket).catch((error) => {
      console.warn(`[support] confirmation email failed ticket=${ticket.id} error=${safeError(error)}`);
    });
  }
  if (appConfig.email.featuresEnabled && ["high", "urgent"].includes(ticket.priority)) {
    void Promise.all([...appConfig.adminEmails].map((email) =>
      sendSupportAdminNotificationEmail(email, ticket)
    )).catch((error) => {
      console.warn(`[support] admin email failed ticket=${ticket.id} error=${safeError(error)}`);
    });
  }

  return {
    message: "Support request submitted. You can check the status here inside SignalForge.",
    ticket,
    tickets: await listSupportTicketsByUser(user.id)
  };
}

export async function submitPublicRecoveryTicket(input, req, context = {}) {
  const ticketInput = validatePublicRecoveryInput(input);
  const ipHash = getSignupContext(req, "").ipHash;
  const userAgent = cleanText(context.userAgent, 500);
  const requesterFingerprintHash = createHmac("sha256", appConfig.abuseProtection.hashSecret)
    .update(`account-recovery:${ipHash}:${userAgent}`)
    .digest("hex");
  await createPublicRecoveryTicketRecord(ticketInput, {
    requesterFingerprintHash,
    userAgent,
    pageUrl: validatePageUrl(input.pageUrl)
  });
  return {
    ok: true,
    message: "Request submitted for review.",
    detail: "Your request has been saved for admin review. Check back later or contact us through any official SignalForge support channel when available."
  };
}

export function validatePublicRecoveryInput(input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  const username = cleanText(input.username, 20);
  const issueType = cleanText(input.issueType || "Other", 80);
  const subject = cleanText(input.subject, 160);
  const message = cleanText(input.message, 5000, { multiline: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError(400, "Enter a valid email address.");
  if (username && !/^[A-Za-z0-9_]{3,20}$/.test(username)) throw httpError(400, "Username must use 3-20 letters, numbers, or underscores.");
  if (!recoveryIssues.has(issueType)) throw httpError(400, "Choose a valid account recovery issue.");
  if (subject.length < 4) throw httpError(400, "Subject must be at least 4 characters.");
  if (message.length < 10) throw httpError(400, "Message must be at least 10 characters.");
  return { email, username: username || null, issueType, subject, message: `[${issueType}] ${message}` };
}

export async function getAdminSupportTickets(admin, input = {}) {
  assertAdmin(admin);
  const filters = validateAdminFilters(input);
  const [tickets, summary] = await Promise.all([
    listAllSupportTickets(filters),
    getSupportTicketSummary()
  ]);
  return { tickets, summary, topics: supportIssues, filters };
}

export async function getAdminSupportTicket(admin, ticketId) {
  assertAdmin(admin);
  const ticket = await findSupportTicketForAdmin(cleanId(ticketId));
  if (!ticket) throw httpError(404, "Support request not found.");
  return { ticket };
}

export async function updateAdminSupportTicket(admin, ticketId, input) {
  assertAdmin(admin);
  const update = validateAdminTicketUpdate(input);
  const ticket = await updateSupportTicketRecord(cleanId(ticketId), admin.id, update);
  if (!ticket) throw httpError(404, "Support request not found.");
  return { ticket, message: "Support request updated." };
}

export async function getRecoveryAccountMatch(admin, ticketId) {
  assertAdmin(admin);
  const result = await lookupRecoveryAccount(cleanId(ticketId), admin.id);
  if (!result) throw httpError(404, "Support request not found.");
  return { account: result.account };
}

export async function setAdminTemporaryPassword(admin, ticketId, input = {}) {
  assertAdmin(admin);
  const password = String(input.temporaryPassword || "");
  const targetUserId = cleanId(input.targetUserId);
  if (password.length < 12 || password.length > 128) throw httpError(400, "Temporary password must be 12-128 characters.");
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) throw httpError(400, "Temporary password must include uppercase, lowercase, and a number.");
  await setRecoveryTemporaryPassword({ ticketId: cleanId(ticketId), adminId: admin.id, targetUserId, password: hashPassword(password) });
  return { ok: true, message: "Temporary password set. Existing sessions and restore tokens were revoked." };
}

export async function revokeAdminRecoverySessions(admin, ticketId, input = {}) {
  assertAdmin(admin);
  await revokeRecoveryAccountSessions({ ticketId: cleanId(ticketId), adminId: admin.id, targetUserId: cleanId(input.targetUserId) });
  return { ok: true, message: "User sessions and restore tokens revoked." };
}

export function validateSupportTicketInput(input = {}) {
  const topic = cleanText(input.topic, 80);
  const issue = cleanText(input.issue, 120);
  const subject = cleanText(input.subject, 160);
  const message = cleanText(input.message, 5000, { multiline: true });
  if (!supportIssues[topic]) throw httpError(400, "Choose a valid support topic.");
  if (!supportIssues[topic].includes(issue)) throw httpError(400, "Choose a valid issue for the selected topic.");
  if (subject.length < 4) throw httpError(400, "Subject must be at least 4 characters.");
  if (message.length < 10) throw httpError(400, "Message must be at least 10 characters.");
  return {
    topic,
    issue,
    subject,
    message,
    priority: inferPriority(topic, issue),
    relatedSignalId: optionalId(input.relatedSignalId),
    relatedSubscriptionId: optionalId(input.relatedSubscriptionId)
  };
}

export function validateAdminTicketUpdate(input = {}) {
  const status = String(input.status || "").trim();
  const priority = String(input.priority || "").trim();
  if (!statuses.has(status)) throw httpError(400, "Choose a valid ticket status.");
  if (!priorities.has(priority)) throw httpError(400, "Choose a valid ticket priority.");
  return {
    status,
    priority,
    adminNotes: cleanText(input.adminNotes, 10000, { multiline: true }),
    publicResponse: cleanText(input.publicResponse, 5000, { multiline: true })
  };
}

function validateAdminFilters(input) {
  const filters = {};
  if (input.status) {
    if (!statuses.has(input.status)) throw httpError(400, "Invalid support status filter.");
    filters.status = input.status;
  }
  if (input.topic) {
    if (!supportIssues[input.topic]) throw httpError(400, "Invalid support topic filter.");
    filters.topic = input.topic;
  }
  if (input.priority) {
    if (!priorities.has(input.priority)) throw httpError(400, "Invalid support priority filter.");
    filters.priority = input.priority;
  }
  if (input.source) {
    if (!["public_account_recovery", "authenticated_support"].includes(input.source)) throw httpError(400, "Invalid support source filter.");
    filters.source = input.source;
  }
  if (input.search) filters.search = cleanText(input.search, 120);
  if (input.from) filters.from = parseDate(input.from, false);
  if (input.to) filters.to = parseDate(input.to, true);
  filters.limit = Math.min(250, Math.max(1, Number(input.limit || 100)));
  return filters;
}

function inferPriority(topic, issue) {
  if (["Payment failed", "Subscription not active", "Signal charged twice", "Cannot sign in"].includes(issue)) return "high";
  if (topic === "Feature Request") return "low";
  return "normal";
}

function cleanText(value, maxLength, { multiline = false } = {}) {
  const pattern = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return String(value || "")
    .replace(pattern, multiline ? "" : " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

function optionalId(value) {
  const cleaned = cleanText(value, 200);
  if (!cleaned) return null;
  if (!/^[A-Za-z0-9_:.\/-]+$/.test(cleaned)) throw httpError(400, "Related reference contains unsupported characters.");
  return cleaned;
}

function cleanId(value) {
  const id = optionalId(value);
  if (!id) throw httpError(400, "Support request ID is required.");
  return id;
}

function validatePageUrl(value) {
  const cleaned = cleanText(value, 1000);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function parseDate(value, includeNextDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError(400, "Invalid support date filter.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw httpError(400, "Invalid support date filter.");
  if (includeNextDay) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function assertAdmin(user) {
  if (!isAdminUser(user)) throw httpError(403, "Admin access required.");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeError(error) {
  return String(error?.message || "unknown").replace(/[\r\n]/g, " ").slice(0, 160);
}
