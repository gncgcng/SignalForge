process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgres://user:password@postgres.railway.internal:5432/railway";
process.env.APP_URL = "https://signalforge-app.xyz";

const { appConfig } = await import("../src/config/appConfig.js");
const { attachAuth } = await import("../src/middleware/authMiddleware.js");
const { isDemoOrTesterIdentity } = await import("../src/modules/auth/authPolicy.js");
const { buildClearCookies, buildSessionCookie } = await import("../src/modules/auth/authController.js");
const { createDemoSession } = await import("../src/modules/auth/authService.js");
const { listSignalsByUser } = await import("../src/db/repositories.js");
const { getSubscriptionSummary } = await import("../src/modules/subscriptions/subscriptionService.js");

const freshRequest = { headers: {} };
await attachAuth(freshRequest);

let demoRejected = false;

try {
  await createDemoSession();
} catch (error) {
  demoRejected = error.message === "Demo access is disabled.";
}

const sessionCookie = buildSessionCookie("sess_user_a");
const clearCookies = buildClearCookies();
let capturedSql = "";
let capturedParams = [];

await listSignalsByUser("usr_a", async (sql, params) => {
  capturedSql = sql;
  capturedParams = params;
  return { rows: [] };
});

const userA = getSubscriptionSummary({
  id: "usr_a",
  plan: "trial",
  trialSignalsUsed: 1,
  freeSignalAllowance: 3,
  paidCredits: 0,
  subscription: { status: "trialing" }
});
const userB = getSubscriptionSummary({
  id: "usr_b",
  plan: "trial",
  trialSignalsUsed: 0,
  freeSignalAllowance: 3,
  paidCredits: 0,
  subscription: { status: "trialing" }
});

const result = {
  production: appConfig.isProduction,
  demoEnabled: appConfig.demoEnabled,
  demoRejected,
  demoIdentityBlocked: isDemoOrTesterIdentity("demo@signalforge.app"),
  testerIdentityBlocked: isDemoOrTesterIdentity("tester@signalforge.app"),
  freshRequestLoggedOut: freshRequest.user === null,
  secureDomainCookie: sessionCookie.startsWith("__Secure-signalforge_session=") &&
    sessionCookie.includes("HttpOnly") &&
    sessionCookie.includes("Secure") &&
    sessionCookie.includes("Path=/") &&
    sessionCookie.includes("Domain=signalforge-app.xyz") &&
    !sessionCookie.includes("Domain=localhost"),
  clearsCurrentCookie: clearCookies.some((cookie) => cookie.startsWith("__Secure-signalforge_session=")),
  clearsLegacyCookie: clearCookies.some((cookie) => cookie.startsWith("__Host-signalforge_session=")) &&
    clearCookies.some((cookie) => cookie.startsWith("signalforge_session=")),
  queryScopedToUser: capturedSql.includes("WHERE s.user_id = $1") &&
    capturedParams.length === 1 &&
    capturedParams[0] === "usr_a",
  separateCredits: userA.trialSignalsRemaining === 2 && userB.trialSignalsRemaining === 3
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true && value !== false) ||
  !result.production ||
  result.demoEnabled ||
  !result.demoRejected ||
  !result.demoIdentityBlocked ||
  !result.testerIdentityBlocked ||
  !result.freshRequestLoggedOut ||
  !result.secureDomainCookie ||
  !result.clearsCurrentCookie ||
  !result.clearsLegacyCookie ||
  !result.queryScopedToUser ||
  !result.separateCredits
) {
  process.exitCode = 1;
}
