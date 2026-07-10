import { appConfig } from "../../config/appConfig.js";
import { isAdminUser } from "../auth/authService.js";
import {
  sendSupportAdminNotificationEmail,
  sendSupportConfirmationEmail
} from "../notifications/transactionalEmailService.js";
import {
  createSupportTicketRecord,
  findSupportTicketByUser,
  findSupportTicketForAdmin,
  getSupportTicketSummary,
  listAllSupportTickets,
  listSupportTicketsByUser,
  updateSupportTicketRecord
} from "./supportRepository.js";

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

  void sendSupportConfirmationEmail(user, ticket).catch((error) => {
    console.warn(`[support] confirmation email failed ticket=${ticket.id} error=${safeError(error)}`);
  });
  if (["high", "urgent"].includes(ticket.priority)) {
    void Promise.all([...appConfig.adminEmails].map((email) =>
      sendSupportAdminNotificationEmail(email, ticket)
    )).catch((error) => {
      console.warn(`[support] admin email failed ticket=${ticket.id} error=${safeError(error)}`);
    });
  }

  return {
    message: "Support request submitted. We’ll review it as soon as possible.",
    ticket,
    tickets: await listSupportTicketsByUser(user.id)
  };
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
    adminNotes: cleanText(input.adminNotes, 10000, { multiline: true })
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
