// Transactional emails: every template renders html + text with no leftover placeholders, links
// are absolute https on APP_URL, user-supplied values are escaped, the real senders hand Resend
// both versions, and (DB-backed) the welcome email waits for verification on email signups.
// Resend and Google are stubbed at fetch; nothing leaves the machine.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const APP_URL = "https://staging.signalforge-app.com";
process.env.NODE_ENV = "development";
process.env.APP_URL = APP_URL;
process.env.EMAIL_FEATURES_ENABLED = "true";
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.TRIAL_IDENTITY_SECRET = "email-templates-test-secret";
process.env.GOOGLE_AUTH_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "email-test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "email-test-secret";
process.env.GOOGLE_REDIRECT_URI = `${APP_URL}/api/auth/google/callback`;

// Resend stub, installed before anything that might capture fetch.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  if (String(input) === "https://api.resend.com/emails") {
    sent.push(JSON.parse(init.body));
    return Response.json({ id: `email_${sent.length}` });
  }
  return realFetch(input, init);
};

const { appConfig } = await import("../src/config/appConfig.js");
const { EMAIL_LOGO_URL } = await import("../src/modules/notifications/emailTemplates.js");
const templates = await import("../src/modules/notifications/emailTemplates.js");
const senders = await import("../src/modules/notifications/transactionalEmailService.js");
const { sendVerificationEmail } = await import("../src/modules/auth/emailVerificationService.js");
const { emailSamples, TEMPLATE_NAMES } = await import("./test-support/email-samples.js");
const results = {};

// --- Rendering --------------------------------------------------------------------------------
const PLACEHOLDER = /\$\{|\{\{|\}\}|\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/;
const samples = emailSamples();
for (const template of TEMPLATE_NAMES) {
  assert.ok(samples.some((sample) => sample.template === template), `no sample renders ${template}`);
}
for (const { name, email } of samples) {
  assert.ok(email.subject?.trim(), `${name}: no subject`);
  assert.match(email.html, /^<!DOCTYPE html>/, `${name}: no html`);
  assert.ok(email.text?.trim().length > 80, `${name}: no text version`);
  for (const [part, value] of Object.entries({ subject: email.subject, html: email.html, text: email.text })) {
    assert.doesNotMatch(value, PLACEHOLDER, `${name}: unreplaced placeholder in ${part}`);
  }

  // Every link, in both versions, is absolute https on APP_URL; the only image is the hosted logo.
  const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
  assert.ok(hrefs.length >= 4, `${name}: expected a button and footer links`);
  for (const href of hrefs) assert.ok(href.startsWith(`${APP_URL}/`), `${name}: link ${href} is not on APP_URL`);
  const textUrls = email.text.match(/https?:\/\/\S+/g) || [];
  assert.ok(textUrls.length >= 4, `${name}: text version is missing links`);
  for (const url of textUrls) assert.ok(url.startsWith(`${APP_URL}/`), `${name}: text link ${url} is not on APP_URL`);
  const images = [...email.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(images, [EMAIL_LOGO_URL], `${name}: unexpected images`);
  assert.match(EMAIL_LOGO_URL, /^https:\/\/signalforge-app\.com\/.+\.png$/);
  assert.doesNotMatch(email.html, /data:image|<svg/i, `${name}: inline image`);

  // Layout pieces.
  assert.match(email.html, /display:none;[^"]*max-height:0[^"]*mso-hide:all/, `${name}: no hidden preheader`);
  assert.match(email.html, /width="600"/, `${name}: not a 600px table layout`);
  // Button: dark teal with bold white text, in both the Outlook (VML) and the regular version.
  assert.match(email.html, /<v:roundrect[^>]+fillcolor="#0e7490"/, `${name}: Outlook (VML) button isn't teal`);
  assert.match(email.html, /<center style="color:#ffffff;[^"]*font-weight:bold;/, `${name}: Outlook button text isn't bold white`);
  const button = email.html.match(/<a href="[^"]+" style="(display:inline-block;[^"]+)">/);
  assert.ok(button, `${name}: no button link`);
  assert.match(button[1], /background-color:#0e7490;/, `${name}: button background isn't teal`);
  assert.match(button[1], /(^|;)color:#ffffff;/, `${name}: button text isn't white`);
  assert.match(button[1], /font-weight:bold;/, `${name}: button text isn't bold`);
  assert.match(email.html, /Or paste this link:<br>/, `${name}: no paste-this-link fallback`);
  for (const footer of [
    "SignalForge · You&#039;re receiving this because you created an account at signalforge-app.com",
    `${APP_URL}/#support`, `${APP_URL}/?legal=terms`, `${APP_URL}/?legal=privacy`
  ]) assert.ok(email.html.includes(footer), `${name}: footer missing ${footer}`);
  assert.ok(email.text.includes("SignalForge · You're receiving this because you created an account at signalforge-app.com"));
}
results.everyTemplateHasHtmlTextAndNoPlaceholders = true;

// WCAG contrast of the button text on its background (light mode, as rendered): at least 4.5:1.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
const buttonContrast = contrast("#ffffff", "#0e7490");
assert.ok(buttonContrast >= 4.5, `button contrast ${buttonContrast.toFixed(2)}:1 is below 4.5:1`);
results.buttonTealWhiteContrast = Number(buttonContrast.toFixed(2));
results.allLinksAbsoluteHttpsOnAppUrl = true;

// Button URL is printed in full under the button.
const verify = templates.buildVerifyEmail({ verificationUrl: `${APP_URL}/?verify=abc123` });
assert.ok(verify.html.includes(`>${APP_URL}/?verify=abc123</a>`));
assert.ok(verify.text.includes(`Confirm email: ${APP_URL}/?verify=abc123`));
// A non-http(s) button link is refused rather than sent.
assert.throws(() => templates.buildPasswordResetEmail({ resetUrl: "javascript:alert(1)" }));

// User-provided values are escaped.
const hostile = emailSamples({
  username: "<script>alert('x')</script>",
  ticketSubject: "<img src=x onerror=alert(1)>\"quoted\""
});
for (const { name, email } of hostile) {
  assert.doesNotMatch(email.html, /<script|<img src=x|onerror=alert\(1\)>/i, `${name}: unescaped user value`);
}
const hostileWelcome = hostile.find((sample) => sample.name === "welcome").email;
assert.ok(hostileWelcome.html.includes("Hi &lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;,"));
const hostileSupport = hostile.find((sample) => sample.name === "support-confirmation").email;
assert.ok(hostileSupport.html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;quoted&quot;"));
results.userValuesEscaped = true;

// Footer address: absent unless EMAIL_FOOTER_ADDRESS is set, then in both versions (escaped).
assert.doesNotMatch(templates.buildFailedPaymentEmail().text, /Market Street/);
appConfig.email.footerAddress = "SignalForge, 1 Market Street <Suite 5>";
const withAddress = templates.buildFailedPaymentEmail();
appConfig.email.footerAddress = "";
assert.ok(withAddress.text.includes("SignalForge, 1 Market Street <Suite 5>"));
assert.ok(withAddress.html.includes("SignalForge, 1 Market Street &lt;Suite 5&gt;"));
results.footerAddressOnlyWhenSet = true;

// --- The real senders hand Resend both versions -----------------------------------------------
const user = { email: "sender-check@example.com", username: "sender_check" };
const ticket = { id: "sup_test", subject: "Help", topic: "Billing", priority: "urgent" };
sent.length = 0;
await sendVerificationEmail(user, "tok123");
await senders.sendWelcomeEmail(user, { trialGranted: true });
await senders.sendPasswordResetEmail(user, `${APP_URL}/?reset=tok`);
await senders.sendSubscriptionConfirmationEmail(user, "pro");
await senders.sendFailedPaymentEmail(user);
await senders.sendAffiliateCommissionEmail(user, { plan: "elite", commissionCents: 1980 });
await senders.sendSupportConfirmationEmail(user, ticket);
await senders.sendSupportAdminNotificationEmail("admin@example.com", ticket);
assert.equal(sent.length, 8);
for (const payload of sent) {
  assert.ok(payload.subject && payload.html?.startsWith("<!DOCTYPE html>") && payload.text?.length > 80, `incomplete payload: ${payload.subject}`);
}
assert.ok(sent.find((payload) => payload.subject.includes("Pro subscription")).text.includes("100 unlock credits"));
results.sendersSendHtmlAndText = true;

// --- Welcome timing (DB-backed) ---------------------------------------------------------------
const { getPool, query } = await import("../src/db/client.js");
const { registerOrLogin, verifyEmail } = await import("../src/modules/auth/authService.js");
const { trialIdentities } = await import("../src/modules/auth/trialIdentity.js");
const fixtures = await import("./account-deletion-fixtures.js");
const helpers = await import("./test-support/trial-signup-helpers.js");
const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const userIds = [];
const claimEmails = [];

const emailsTo = (address) => sent.filter((payload) => payload.to.includes(address));
const isWelcome = (payload) => payload.subject === "Welcome to SignalForge";
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
}
async function signUp(email) {
  claimEmails.push(email);
  const signup = await registerOrLogin({
    email,
    password: "email-test-password",
    deviceFingerprint: `email-test-device-${tag}-${userIds.length}`,
    legalConsentAccepted: true,
    ageConfirmed: true,
    intent: "signup"
  }, { headers: { "x-forwarded-for": `10.99.${userIds.length}.${randomBytes(1)[0]}` }, socket: {} });
  userIds.push(signup.user.id);
  return signup;
}
const tokenFrom = (payload) => new URL(payload.text.match(/https:\/\/\S+\?verify=\S+/)[0]).searchParams.get("verify");

try {
  // Email signup: only the verification email goes out.
  const email = `email-welcome-${tag}@example.com`;
  const signup = await signUp(email);
  await settle();
  assert.deepEqual(emailsTo(email).map((payload) => payload.subject), ["Confirm your SignalForge email"],
    "something other than the verification email was sent at signup");
  assert.match(emailsTo(email)[0].text, /activate your 3 free signal unlocks/);

  // The welcome is sent once the link is used, with copy for an account that has its unlocks.
  await verifyEmail(tokenFrom(emailsTo(email)[0]));
  await waitFor(() => emailsTo(email).some(isWelcome), "the welcome email");
  const welcome = emailsTo(email).find(isWelcome);
  assert.match(welcome.text, /you have 3 free signal unlocks/);
  assert.ok(welcome.text.includes(`Run your first scan: ${APP_URL}/#scanner`));
  // Reusing the link fails and sends nothing more.
  await assert.rejects(verifyEmail(tokenFrom(emailsTo(email)[0])));
  await settle();
  assert.equal(emailsTo(email).filter(isWelcome).length, 1);
  results.welcomeOnlyAfterVerification = true;

  // Same email after deletion: no trial left, and neither email promises one.
  await helpers.deleteUser(signup.user.id);
  const again = await signUp(email);
  const verifyAgain = emailsTo(email).filter((payload) => payload.subject === "Confirm your SignalForge email").at(-1);
  assert.doesNotMatch(verifyAgain.text, /free signal unlocks/);
  await verifyEmail(tokenFrom(verifyAgain));
  await waitFor(() => emailsTo(email).filter(isWelcome).length === 2, "the second welcome");
  const welcomeAgain = emailsTo(email).filter(isWelcome).at(-1);
  assert.match(welcomeAgain.text, /starts without free unlocks/);
  assert.doesNotMatch(welcomeAgain.text, /you have 3 free/);
  assert.ok(welcomeAgain.text.includes(`View plans: ${APP_URL}/#billing`));
  assert.ok(again.trialAlreadyUsed);
  results.copyMatchesTrialState = true;

  // Google signups are verified at signup, so they're welcomed right away.
  const googleEmail = `email-welcome-google-${tag}@example.com`;
  claimEmails.push(googleEmail);
  const google = await helpers.googleSignup({ sub: `g-email-${tag}`, email: googleEmail, deviceFingerprint: `email-test-google-${tag}` });
  userIds.push(google.userId);
  await waitFor(() => emailsTo(googleEmail).some(isWelcome), "the Google welcome");
  assert.equal(emailsTo(googleEmail).length, 1, "Google signup sent more than the welcome");
  results.googleWelcomedAtSignup = true;

  console.log(JSON.stringify({ emailTemplates: "ok", results }, null, 2));
} finally {
  helpers.restoreFetch();
  globalThis.fetch = realFetch;
  const hashes = claimEmails.flatMap((address) => trialIdentities({ email: address }).map((item) => item.hash))
    .concat(trialIdentities({ googleSubjects: [`g-email-${tag}`] }).map((item) => item.hash));
  await query(`DELETE FROM trial_identity_claims WHERE identity_hash = ANY($1)`, [hashes]);
  await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [[...userIds, ...helpers.createdUserIds]]);
  await fixtures.cleanupTestUsers([...new Set([...userIds, ...helpers.createdUserIds])]);
  await getPool().end();
}
