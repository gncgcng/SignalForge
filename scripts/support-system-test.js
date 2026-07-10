import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleSupportRoutes } from "../src/modules/support/supportController.js";
import { assertSupportSubmissionAllowed } from "../src/modules/support/supportRepository.js";
import {
  validateAdminTicketUpdate,
  validateSupportTicketInput
} from "../src/modules/support/supportService.js";

const migration = readFileSync("migrations/031_support_tickets.sql", "utf8");
const repository = readFileSync("src/modules/support/supportRepository.js", "utf8");
const service = readFileSync("src/modules/support/supportService.js", "utf8");
const controller = readFileSync("src/modules/support/supportController.js", "utf8");
const server = readFileSync("src/server.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const router = readFileSync("public/router.js", "utf8");

for (const column of [
  "user_id", "username_snapshot", "email_snapshot", "topic", "issue", "subject", "message",
  "status", "priority", "admin_notes", "assigned_to", "related_signal_id",
  "related_subscription_id", "user_agent", "page_url", "created_at", "updated_at", "resolved_at"
]) assert.match(migration, new RegExp(`\\b${column}\\b`));
assert.match(migration, /CHECK \(status IN \('open', 'in_review', 'waiting_for_user', 'resolved', 'closed'\)\)/);
assert.match(migration, /CHECK \(priority IN \('low', 'normal', 'high', 'urgent'\)\)/);

const valid = validateSupportTicketInput({
  topic: "Billing / Subscription",
  issue: "Payment failed",
  subject: "Checkout payment failed",
  message: "Stripe checkout completed but my subscription did not activate.",
  relatedSubscriptionId: "sub_123"
});
assert.equal(valid.priority, "high");
assert.equal(valid.relatedSubscriptionId, "sub_123");
assert.throws(() => validateSupportTicketInput({}), /valid support topic/);
assert.throws(() => validateSupportTicketInput({
  topic: "Billing / Subscription", issue: "Credits missing", subject: "Missing", message: "A sufficiently long message"
}), /valid issue/);
assert.throws(() => validateSupportTicketInput({
  topic: "Other", issue: "General question", subject: "", message: "A sufficiently long message"
}), /Subject/);
const sanitized = validateSupportTicketInput({
  topic: "Other",
  issue: "General question",
  subject: "Unsafe <script> title",
  message: "Please review <img src=x onerror=alert(1)> this support issue."
});
assert.doesNotMatch(sanitized.subject, /[<>]/);
assert.doesNotMatch(sanitized.message, /[<>]/);

assert.deepEqual(validateAdminTicketUpdate({ status: "resolved", priority: "urgent", adminNotes: "Investigated internally" }), {
  status: "resolved",
  priority: "urgent",
  adminNotes: "Investigated internally"
});
assert.throws(() => validateAdminTicketUpdate({ status: "deleted", priority: "normal" }), /valid ticket status/);
assert.equal(assertSupportSubmissionAllowed(4, 19), true);
for (const counts of [[5, 5], [1, 20]]) {
  assert.throws(() => assertSupportSubmissionAllowed(...counts), (error) => error.statusCode === 429 && error.code === "SUPPORT_RATE_LIMIT");
}

const anonymousResponse = mockResponse();
await handleSupportRoutes({ method: "GET", user: null, headers: {} }, anonymousResponse, "/api/support", new URL("http://localhost/api/support"));
assert.equal(anonymousResponse.statusCode, 401);

const nonAdminResponse = mockResponse();
await handleSupportRoutes({
  method: "GET",
  user: { id: "usr_normal", email: "normal@example.com" },
  headers: {}
}, nonAdminResponse, "/api/admin/support", new URL("http://localhost/api/admin/support"));
assert.equal(nonAdminResponse.statusCode, 403);

assert.match(repository, /WHERE user_id = \$1/);
assert.match(repository, /WHERE id = \$1 AND user_id = \$2/);
assert.match(repository, /SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
assert.match(repository, /Number\(hourly\) >= 5 \|\| Number\(daily\) >= 20/);
assert.match(repository, /if \(!admin\) return ticket/);
assert.match(repository, /updateSupportTicketRecord/);
assert.match(repository, /assigned_to = \$5/);
assert.match(service, /assertAdmin\(admin\)/);
assert.match(controller, /pathname === "\/api\/support" && req\.method === "POST"/);
assert.match(controller, /pathname === "\/api\/admin\/support"/);
assert.match(server, /handleSupportRoutes/);

assert.match(router, /support: "support"/);
assert.match(router, /"admin-support": "admin-support"/);
assert.match(html, /data-view-link="support"/);
assert.match(html, /id="support-form"/);
assert.match(html, /id="support-ticket-list"/);
assert.match(html, /id="admin-support-view"/);
assert.match(html, /id="admin-support-summary"/);
assert.match(app, /escapeHtml\(ticket\.message\)/);
assert.match(app, /adminSupportNavLink\.classList\.toggle\("hidden", !state\.user\.isAdmin\)/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.support-form-grid[\s\S]*grid-template-columns: 1fr/);
assert.match(css, /\.support-page,[\s\S]*overflow-x: hidden/);

console.log("Support system tests passed.");

function mockResponse() {
  return {
    statusCode: null,
    payload: null,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(payload) { this.payload = JSON.parse(payload); }
  };
}
