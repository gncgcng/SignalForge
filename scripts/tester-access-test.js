process.env.ADMIN_EMAILS = "admin@signalforge.app,ops@example.com";

import { readFileSync } from "node:fs";

const { isAdminUser, toPublicUser } = await import("../src/modules/auth/authService.js");
const { getPendingTesterRequests } = await import("../src/modules/tester-access/testerAccessService.js");
const {
  canGenerateSignal,
  getSubscriptionSummary,
  recordSignalUsage
} = await import("../src/modules/subscriptions/subscriptionService.js");

const migration = readFileSync(
  new URL("../migrations/007_tester_access_requests.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const controller = readFileSync(
  new URL("../src/modules/tester-access/testerAccessController.js", import.meta.url),
  "utf8"
);
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const config = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");

const admin = {
  id: "usr_admin",
  name: "Admin",
  email: "ADMIN@signalforge.app",
  role: "user",
  plan: "trial",
  trialSignalsUsed: 0,
  freeSignalAllowance: 3
};
const normal = {
  id: "usr_normal",
  name: "Normal",
  email: "user@example.com",
  role: "user",
  plan: "trial",
  trialSignalsUsed: 3,
  freeSignalAllowance: 3,
  paidCredits: 0
};
const tester = {
  ...normal,
  id: "usr_tester",
  role: "tester",
  plan: "tester"
};

let nonAdminRejected = false;

try {
  await getPendingTesterRequests(normal);
} catch (error) {
  nonAdminRejected = error.statusCode === 403;
}

await recordSignalUsage(tester);
const publicAdmin = toPublicUser(admin);
const testerSummary = getSubscriptionSummary(tester);

const result = {
  roleMigrationSafe: migration.includes("ADD COLUMN IF NOT EXISTS role") &&
    migration.includes("CREATE TABLE IF NOT EXISTS tester_access_requests") &&
    !migration.includes("DELETE FROM users"),
  pendingRequestUnique: migration.includes("WHERE status = 'pending'"),
  adminEmailsParsedServerSide: config.includes("process.env.ADMIN_EMAILS") &&
    config.includes("new Set"),
  adminListNotExposed: !JSON.stringify(publicAdmin).includes("ops@example.com") &&
    publicAdmin.isAdmin === true,
  nonAdminRejectedServerSide: nonAdminRejected,
  adminRecognizedCaseInsensitively: isAdminUser(admin),
  approvalSetsRoleAndCredits: repositories.includes("SET role = 'tester', plan = 'tester'") &&
    repositories.includes("appConfig.testerCreditAllowance"),
  rejectionDoesNotUpgrade: repositories.indexOf("if (decision === \"approved\")") <
    repositories.indexOf("SET role = 'tester'"),
  testerUnlimited: canGenerateSignal(tester) &&
    testerSummary.unlimitedSignals === true &&
    testerSummary.trialSignalsRemaining === null,
  testerUsageNotDeducted: tester.trialSignalsUsed === 3,
  adminRoutesProtected: controller.includes("getPendingTesterRequests(req.user)") &&
    controller.includes("decideTesterRequest(req.user"),
  adminHiddenByDefault: html.includes('class="hidden" href="#admin"') &&
    html.includes('id="admin-nav-link"'),
  frontendUsesServerAdminFlag: app.includes("state.user.isAdmin") &&
    !app.includes("ADMIN_EMAILS"),
  testerBadgePresent: html.includes("Tester account") &&
    app.includes("testerAccountBadge")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
