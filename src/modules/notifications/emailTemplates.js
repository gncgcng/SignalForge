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

export function buildVerifyEmail({ verificationUrl, expiresInHours = 24 }) {
  return renderEmail({
    subject: "Confirm your SignalForge email",
    preheader: "One click to start scanning.",
    heading: "Confirm your email",
    paragraphs: [
      "Thanks for creating a SignalForge account.",
      "Confirm this is your email address to start scanning markets."
    ],
    button: { label: "Confirm email", url: verificationUrl },
    note: `This link expires in ${hoursLabel(expiresInHours)}. If you didn't create a SignalForge account, you can ignore this email.`
  });
}

// Sent once the email is verified (email signups) or at signup (Google, already verified).
export function buildWelcomeEmail({ username = "" }) {
  return renderEmail({
    subject: "Welcome to SignalForge",
    preheader: "Your account is ready. Run your first scan.",
    heading: "Welcome to SignalForge",
    greeting: username,
    paragraphs: [
      "Your account is ready. Free accounts see setups with their levels (entry, stop and target) on BTC-USD and ETH-USD, each with its track record, plus the fee calculator and paper trading.",
      "Every other market, Telegram alerts, the trade checker and My trades are part of the SignalForge plan: $9.99 a month or $89.99 a year, with a 7-day free trial. You can start it from Billing whenever you like."
    ],
    button: { label: "Run your first scan", url: appLink("/#scanner") }
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

// --- Billing (one plan, 7-day trial with card) ----------------------------------------------------

const BILLING_LINK = () => appLink("/#billing");
const CANCEL_LINE = "You can cancel any time in Settings → Billing. Cancelling keeps your access until the end of the period you've paid for.";

// amountCents + interval ("month" | "year") -> "$9.99 a month"
export function formatPlanCharge(amountCents, interval) {
  return `${formatCents(amountCents)} ${interval === "year" ? "a year" : "a month"}`;
}

// "21 Oct 2026", in UTC so the date matches Stripe's.
export function formatBillingDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function buildTrialStartedEmail({ firstChargeDate, amountCents, interval }) {
  const date = formatBillingDate(firstChargeDate);
  return renderEmail({
    subject: "Your SignalForge free trial has started",
    preheader: `Nothing is charged until ${date}.`,
    heading: "Your 7-day free trial has started",
    paragraphs: [
      "You now have the full SignalForge plan: setups and levels on every market, Telegram alerts, the trade checker and My trades.",
      `Your card will be charged ${formatCents(amountCents)} on ${date}, and then ${formatPlanCharge(amountCents, interval)} until you cancel.`,
      `To avoid being charged, cancel before ${date}. ${CANCEL_LINE}`
    ],
    button: { label: "Manage billing", url: BILLING_LINK() }
  });
}

export function buildTrialEndingEmail({ firstChargeDate, amountCents, interval }) {
  const date = formatBillingDate(firstChargeDate);
  return renderEmail({
    subject: `Your SignalForge trial ends on ${date}`,
    preheader: `Your card will be charged ${formatCents(amountCents)} on ${date} unless you cancel.`,
    heading: "Your free trial ends soon",
    paragraphs: [
      `Your SignalForge free trial ends on ${date}. On that day your card will be charged ${formatCents(amountCents)}, and then ${formatPlanCharge(amountCents, interval)} until you cancel.`,
      `If you don't want to continue, cancel before ${date} and you won't be charged. ${CANCEL_LINE}`
    ],
    button: { label: "Open Settings → Billing", url: BILLING_LINK() }
  });
}

export function buildTrialCardAlreadyUsedEmail({ amountCents, interval }) {
  return renderEmail({
    subject: "Your SignalForge subscription started today",
    preheader: "This card was already used for a free trial.",
    heading: "Your subscription started today",
    paragraphs: [
      "This card was already used for a free trial, so your subscription started today.",
      `Your card is charged ${formatPlanCharge(amountCents, interval)} from today until you cancel. ${CANCEL_LINE}`,
      "One free trial per person and per card. If you think this is a mistake, contact Support and we'll look at it."
    ],
    button: { label: "Manage billing", url: BILLING_LINK() }
  });
}

export function buildSubscriptionConfirmationEmail({ amountCents, interval, nextChargeDate }) {
  const next = formatBillingDate(nextChargeDate);
  return renderEmail({
    subject: "Your SignalForge subscription is active",
    preheader: `Thanks for subscribing to SignalForge.`,
    heading: "Subscription confirmed",
    paragraphs: [
      `We charged ${formatCents(amountCents)} for SignalForge. Your plan renews at ${formatPlanCharge(amountCents, interval)}${next ? `; the next charge is on ${next}` : ""}.`,
      CANCEL_LINE
    ],
    button: { label: "View billing", url: BILLING_LINK() }
  });
}

export function buildFailedPaymentEmail() {
  return renderEmail({
    subject: "Action needed: your SignalForge payment didn't go through",
    preheader: "Update your card to keep your plan.",
    heading: "Your payment didn't go through",
    paragraphs: [
      "We couldn't collect the latest payment for your SignalForge subscription. Stripe will try the card again over the next few days, and your access stays on while it does.",
      "To update your card: open Settings → Billing, choose Update card, and enter the new card. The next retry uses it automatically."
    ],
    button: { label: "Update card", url: BILLING_LINK() }
  });
}

export function buildSubscriptionCanceledEmail({ accessUntil }) {
  const date = formatBillingDate(accessUntil);
  return renderEmail({
    subject: "Your SignalForge subscription is cancelled",
    preheader: date ? `You keep access until ${date}.` : "Your subscription is cancelled.",
    heading: "Subscription cancelled",
    paragraphs: [
      date
        ? `Your SignalForge subscription is cancelled and won't renew. You keep full access until ${date}, and you won't be charged again.`
        : "Your SignalForge subscription is cancelled and won't renew. You won't be charged again.",
      "Your My trades history stays in your account afterwards, readable and exportable. You can subscribe again from Billing at any time."
    ],
    button: { label: "View billing", url: BILLING_LINK() }
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
