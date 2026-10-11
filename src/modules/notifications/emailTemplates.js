import { appConfig } from "../../config/appConfig.js";

// Transactional email templates. Each build*Email() returns { subject, html, text } and does no
// I/O, so the senders, `npm run email:preview` and the tests all render the same thing.
//
// Layout rules (Gmail light/dark, Apple Mail, Outlook desktop):
// - 600px, table-based, inline styles; <style> only adds dark-mode and narrow-screen overrides
//   for clients that honour it, and nothing depends on it.
// - Logo is a hosted PNG on the dark header band, so it reads the same in light and dark mode.
// - Button is "bulletproof": a VML roundrect for Outlook, a padded <a> everywhere else, followed
//   by the full URL as text.
// - Everything that isn't ours (usernames, ticket subjects, topics) is HTML-escaped.

export const EMAIL_LOGO_URL = "https://signalforge-app.com/icons/android-chrome-192x192.png";
export const EMAIL_SITE_HOST = "signalforge-app.com";

const COLORS = {
  page: "#f1f4f8",
  header: "#0b1220",
  card: "#ffffff",
  text: "#111827",
  muted: "#5b6676",
  link: "#0e7490",
  // Dark teal with white text (≈5.4:1). A bright cyan button with dark text came out as light
  // text on bright cyan after Gmail's dark-mode inversion; this pair stays readable either way.
  button: "#0e7490",
  buttonText: "#ffffff",
  rule: "#e3e8ef"
};
const FONT = "Arial, Helvetica, sans-serif";

export function emailBaseUrl() {
  return String(appConfig.appUrl || appConfig.abuseProtection.publicAppUrl || `https://${EMAIL_SITE_HOST}`)
    .replace(/\/+$/, "");
}

export function appLink(path = "/") {
  return `${emailBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

// --- Templates --------------------------------------------------------------------------------

export function buildVerifyEmail({ verificationUrl, trialAvailable = true, expiresInHours = 24 }) {
  const unlocks = appConfig.freeSignalAllowance;
  return renderEmail({
    subject: "Confirm your SignalForge email",
    preheader: trialAvailable
      ? `One click to start scanning and activate your ${unlocks} free unlocks.`
      : "One click to start scanning and unlocking signals.",
    heading: "Confirm your email",
    paragraphs: [
      "Thanks for creating a SignalForge account.",
      trialAvailable
        ? `Confirm this is your email address to start scanning markets and to activate your ${unlocks} free signal unlocks.`
        : "Confirm this is your email address to start scanning markets and unlocking signals."
    ],
    button: { label: "Confirm email", url: verificationUrl },
    note: `This link expires in ${hoursLabel(expiresInHours)}. If you didn't create a SignalForge account, you can ignore this email.`
  });
}

// Sent once the email is verified (email signups) or at signup (Google, already verified), so
// the account can scan and, with unlocks, unlock signals right now.
export function buildWelcomeEmail({ username = "", trialGranted = true }) {
  const unlocks = appConfig.freeSignalAllowance;
  return renderEmail({
    subject: "Welcome to SignalForge",
    preheader: trialGranted
      ? `Your account is ready and your ${unlocks} free signal unlocks are waiting.`
      : "Your account is ready. Run your first scan.",
    heading: "Welcome to SignalForge",
    greeting: username,
    paragraphs: trialGranted
      ? [
          `Your account is ready, and you have ${unlocks} free signal unlocks.`,
          "Run a scan to see current setups, then unlock the ones you want to follow. Each unlocked signal shows its entry, stop and target, and is tracked to its outcome."
        ]
      : [
          "Your account is ready. You can run scans and review setups now.",
          "This email or device has already used SignalForge's free trial, so this account starts without free unlocks. To unlock a signal, choose a plan or a credit pack in Billing."
        ],
    button: trialGranted
      ? { label: "Run your first scan", url: appLink("/#scanner") }
      : { label: "View plans", url: appLink("/#billing") }
  });
}

export function buildPasswordResetEmail({ resetUrl, expiresInMinutes = 60 }) {
  return renderEmail({
    subject: "Reset your SignalForge password",
    preheader: "Use this link to choose a new password.",
    heading: "Reset your password",
    paragraphs: [
      "We received a request to reset the password for your SignalForge account.",
      `This link expires in ${minutesLabel(expiresInMinutes)} and can be used once.`
    ],
    button: { label: "Reset password", url: resetUrl },
    note: "If you didn't ask for this, you can ignore this email. Your password won't change."
  });
}

export function buildSubscriptionConfirmationEmail({ planName, monthlyUnlockGrant = 0 }) {
  const name = planName || "paid";
  return renderEmail({
    subject: `Your SignalForge ${name} subscription is active`,
    preheader: `Thanks for subscribing to SignalForge ${name}.`,
    heading: "Subscription confirmed",
    paragraphs: [
      `Your SignalForge ${name} subscription is active.`,
      monthlyUnlockGrant > 0
        ? `Your plan adds ${formatNumber(monthlyUnlockGrant)} unlock credits each billing period, and unused credits carry over. Your balance and invoices are in Billing.`
        : "Your balance and invoices are in Billing."
    ],
    button: { label: "View billing", url: appLink("/#billing") }
  });
}

export function buildFailedPaymentEmail() {
  return renderEmail({
    subject: "Action needed: your SignalForge payment didn't go through",
    preheader: "Update your payment method to keep your plan active.",
    heading: "Your payment didn't go through",
    paragraphs: [
      "We couldn't collect the latest payment for your SignalForge subscription.",
      "Update your payment method in Billing to keep your plan and its monthly unlock credits active."
    ],
    button: { label: "Update payment method", url: appLink("/#billing") }
  });
}

export function buildAffiliateCommissionEmail({ planName, commissionCents }) {
  const amount = formatCents(commissionCents);
  return renderEmail({
    subject: `You earned a ${amount} SignalForge affiliate commission`,
    preheader: `A subscription you referred earned you ${amount}.`,
    heading: "Affiliate commission earned",
    paragraphs: [
      `A ${planName || "paid"} subscription you referred earned you a ${amount} commission.`,
      "It's in your affiliate dashboard, where you can track referrals and request a payout."
    ],
    button: { label: "View affiliate dashboard", url: appLink("/#affiliate") }
  });
}

export function buildSupportConfirmationEmail({ username = "", ticketId, ticketSubject }) {
  return renderEmail({
    subject: `We received your SignalForge support request (${ticketId})`,
    preheader: "Your request is open. We'll reply in SignalForge.",
    heading: "Support request received",
    greeting: username,
    paragraphs: [
      `We received your request “${ticketSubject}”. It's open, and the SignalForge team will review it as soon as possible.`,
      "Replies appear under Support in your account."
    ],
    button: { label: "View your requests", url: appLink("/#support") },
    note: `Reference: ${ticketId}`
  });
}

export function buildAdminSupportNoticeEmail({ ticketId, ticketSubject, topic, priority }) {
  const level = String(priority || "high").toUpperCase();
  return renderEmail({
    subject: `[SignalForge] ${level} support request ${ticketId}`,
    preheader: `${topic}: ${ticketSubject}`,
    heading: `${level} support request`,
    paragraphs: [
      `Topic: ${topic}`,
      `Subject: ${ticketSubject}`
    ],
    button: { label: "Open support queue", url: appLink("/#admin-support") },
    note: `Reference: ${ticketId}`
  });
}

// --- Layout -----------------------------------------------------------------------------------

export function renderEmail({ subject, preheader, heading, greeting = "", paragraphs = [], button, note = "" }) {
  const buttonUrl = button ? assertAbsoluteUrl(button.url) : "";
  const footer = footerContent();
  return {
    subject,
    html: renderHtml({ subject, preheader, heading, greeting, paragraphs, button, buttonUrl, note, footer }),
    text: renderText({ heading, greeting, paragraphs, button, buttonUrl, note, footer })
  };
}

function footerContent() {
  return {
    disclaimer: "Educational tool only. Not financial advice.",
    reason: `SignalForge · You're receiving this because you created an account at ${EMAIL_SITE_HOST}`,
    links: [
      { label: "Support", url: appLink("/#support") },
      { label: "Terms", url: appLink("/?legal=terms") },
      { label: "Privacy", url: appLink("/?legal=privacy") }
    ],
    address: String(appConfig.email.footerAddress || "").trim()
  };
}

function renderHtml({ subject, preheader, heading, greeting, paragraphs, button, buttonUrl, note, footer }) {
  const text = `font-family:${FONT};color:${COLORS.text};`;
  const body = [
    `<h1 class="sf-text" style="margin:0 0 16px;${text}font-size:24px;line-height:32px;font-weight:bold;">${escapeHtml(heading)}</h1>`,
    greeting
      ? `<p class="sf-text" style="margin:0 0 16px;${text}font-size:16px;line-height:24px;">Hi ${escapeHtml(greeting)},</p>`
      : "",
    ...paragraphs.map((paragraph) =>
      `<p class="sf-text" style="margin:0 0 16px;${text}font-size:16px;line-height:24px;">${escapeHtml(paragraph)}</p>`),
    button ? renderButton(button.label, buttonUrl) : "",
    button
      ? `<p class="sf-muted" style="margin:16px 0 0;font-family:${FONT};color:${COLORS.muted};font-size:13px;line-height:20px;">Or paste this link:<br>` +
        `<a class="sf-link" href="${escapeAttribute(buttonUrl)}" style="color:${COLORS.link};text-decoration:underline;word-break:break-all;">${escapeHtml(buttonUrl)}</a></p>`
      : "",
    note
      ? `<p class="sf-muted" style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${COLORS.rule};font-family:${FONT};color:${COLORS.muted};font-size:13px;line-height:20px;">${escapeHtml(note)}</p>`
      : ""
  ].filter(Boolean).join("\n");

  const footerLinks = footer.links
    .map((link) => `<a class="sf-link" href="${escapeAttribute(assertAbsoluteUrl(link.url))}" style="color:${COLORS.link};text-decoration:underline;">${escapeHtml(link.label)}</a>`)
    .join(" &nbsp;·&nbsp; ");
  const footerLine = (content) =>
    `<p class="sf-muted" style="margin:0 0 6px;font-family:${FONT};color:${COLORS.muted};font-size:12px;line-height:18px;">${content}</p>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
  @media (prefers-color-scheme: dark) {
    .sf-page { background-color: #0b1220 !important; }
    .sf-card { background-color: #111a2b !important; }
    .sf-text { color: #e5edf5 !important; }
    .sf-muted { color: #a3b0c2 !important; }
    .sf-link { color: #67e8f9 !important; }
  }
  @media screen and (max-width: 620px) {
    .sf-container { width: 100% !important; }
    .sf-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body class="sf-page" style="margin:0;padding:0;background-color:${COLORS.page};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" class="sf-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background-color:${COLORS.page};">
<tr><td align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="sf-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td class="sf-pad" bgcolor="${COLORS.header}" style="background-color:${COLORS.header};padding:20px 32px;border-radius:12px 12px 0 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${EMAIL_LOGO_URL}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border:0;outline:none;text-decoration:none;border-radius:8px;"></td>
<td style="vertical-align:middle;padding-left:12px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:bold;color:#ffffff;">SignalForge</td>
</tr></table>
</td></tr>
<tr><td class="sf-card sf-pad" bgcolor="${COLORS.card}" style="background-color:${COLORS.card};padding:32px;border-radius:0 0 12px 12px;">
${body}
</td></tr>
<tr><td class="sf-pad" style="padding:20px 32px 8px;">
${footerLine(escapeHtml(footer.disclaimer))}
${footerLine(escapeHtml(footer.reason))}
${footerLine(footerLinks)}
${footer.address ? footerLine(escapeHtml(footer.address)) : ""}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}

function renderButton(label, url) {
  const href = escapeAttribute(url);
  const text = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;"><tr><td align="left">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="17%" stroke="f" fillcolor="${COLORS.button}">
<w:anchorlock/>
<center style="color:${COLORS.buttonText};font-family:${FONT};font-size:16px;font-weight:bold;">${text}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${href}" style="display:inline-block;background-color:${COLORS.button};color:${COLORS.buttonText};font-family:${FONT};font-size:16px;font-weight:bold;line-height:48px;text-align:center;text-decoration:none;width:260px;border-radius:8px;-webkit-text-size-adjust:none;mso-hide:all;">${text}</a>
<!--<![endif]-->
</td></tr></table>`;
}

function renderText({ heading, greeting, paragraphs, button, buttonUrl, note, footer }) {
  return [
    heading,
    "",
    ...(greeting ? [`Hi ${greeting},`, ""] : []),
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...(button ? [`${button.label}: ${buttonUrl}`, ""] : []),
    ...(note ? [note, ""] : []),
    "--",
    footer.disclaimer,
    footer.reason,
    ...footer.links.map((link) => `${link.label}: ${link.url}`),
    ...(footer.address ? [footer.address] : [])
  ].join("\n");
}

// --- Helpers ----------------------------------------------------------------------------------

function assertAbsoluteUrl(url) {
  const parsed = new URL(String(url));
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`Email links must be absolute http(s) URLs, got ${parsed.protocol}`);
  }
  return parsed.href;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function formatCents(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0) / 100);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function hoursLabel(hours) {
  return Number(hours) === 1 ? "1 hour" : `${hours} hours`;
}

function minutesLabel(minutes) {
  return Number(minutes) % 60 === 0 ? hoursLabel(Number(minutes) / 60) : `${minutes} minutes`;
}
