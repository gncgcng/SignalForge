// Pivot phase 3, test 9 (copy half): the pricing card, the Billing status lines, the emails, the Telegram alert and
// the legal pages say what the brief requires. Pure: reads files and calls pure helpers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.STRIPE_PRICE_MONTHLY = "price_copy_monthly";
const view = await import("../public/billingView.js");
const emails = await import("../src/modules/notifications/emailTemplates.js");
const { formatTelegramSignalMessage, formatTelegramSignalReplyMarkup } = await import("../src/modules/notifications/notificationService.js");
const { CURRENT_LEGAL_CONSENT_VERSION } = await import("../src/modules/auth/authPolicy.js");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const results = {};
const check = (name, fn) => { fn(); results[name] = true; };

check("pricing card: one plan, monthly/annual toggle, the trial sentence", () => {
  const now = new Date("2026-10-14T09:00:00Z");
  // The app shows dates in the viewer's time zone; tests pin UTC.
  assert.equal(view.pricingNote({ now, timeZone: "UTC" }),
    "7-day free trial. Card required. You won't be charged until 21 Oct 2026. Cancel any time in Settings. One free trial per person and per card.");
  assert.match(view.pricingNote({ now, trialEligible: false }), /already had its free trial, so a subscription starts today/);
  assert.equal(view.checkoutButtonLabel({ trialEligible: true }), "Start 7-day free trial");
  assert.equal(view.checkoutButtonLabel({ trialEligible: false }), "Subscribe");
  assert.equal(view.PLAN_PRICES.month.label, "$9.99");
  assert.equal(view.PLAN_PRICES.year.label, "$89.99");
  assert.ok(1 - 8999 / (999 * 12) > 0.245, "annual saves 25% (rounded)");
  assert.match(html, /data-plan-interval-choice="month"[^>]*>Monthly</);
  assert.match(html, /data-plan-interval-choice="year"[^>]*>Annual · save 25%</);
  assert.match(html, /7-day free trial\. Card required\. You won't be charged until <span data-trial-charge-date>/);
  assert.match(html, /One free trial per person and per card\./);
  assert.doesNotMatch(html, /3 free unlocks|3 Free Setup Unlocks|Unlock credit packs|Redeem a code/);
});

check("billing status in plain words", () => {
  const base = { hasPaidAccess: true, billingInterval: "month", customerPortalAvailable: true };
  assert.equal(view.describeBillingStatus({ ...base, status: "trialing", nextChargeAt: "2026-10-21T10:00:00Z", trialEnd: "2026-10-21T10:00:00Z" }, { timeZone: "UTC" }).headline,
    "Free trial — first charge $9.99 on 21 Oct 2026");
  assert.equal(view.describeBillingStatus({ ...base, status: "trialing", cancelAtPeriodEnd: true, trialEnd: "2026-10-21T10:00:00Z" }, { timeZone: "UTC" }).headline,
    "Free trial — cancelled. Access until 21 Oct 2026");
  assert.equal(view.describeBillingStatus({ ...base, status: "active", billingInterval: "year", nextChargeAt: "2027-10-21T10:00:00Z" }, { timeZone: "UTC" }).headline, "Active — $89.99/year");
  // In a US time zone, a trial ending at 04:22 UTC on the 21st is shown as the 20th, as Stripe shows it.
  assert.equal(view.describeBillingStatus({ ...base, status: "trialing", nextChargeAt: "2026-10-21T04:22:00Z", trialEnd: "2026-10-21T04:22:00Z" }, { timeZone: "America/Los_Angeles" }).headline,
    "Free trial — first charge $9.99 on 20 Oct 2026");
  const pastDue = view.describeBillingStatus({ ...base, status: "past_due" });
  assert.equal(pastDue.headline, "Payment failed — update your card");
  assert.equal(pastDue.banner, "Payment failed — update your card");
  assert.equal(view.describeBillingStatus({ status: "canceled" }).headline, "Cancelled — your subscription has ended");
  assert.equal(view.describeBillingStatus({ status: "none" }).headline, "Free plan");
  assert.match(html, /<button class="secondary-action" id="billing-cancel-button" type="button" data-billing-portal>Cancel subscription<\/button>/);
  assert.match(html, /id="billing-update-card-button" type="button" data-billing-portal>Update card<\/button>/);
  assert.match(html, /id="billing-past-due-banner"[\s\S]{0,120}Payment failed — update your card/);
});

check("levels copy: the trial line replaces the unlock line; Telegram drops it", () => {
  assert.equal(view.LEVELS_TRIAL_MESSAGE, "Start your 7-day free trial to see levels on every market.");
  assert.doesNotMatch(app, /Unlock to view the setup levels/);
  assert.doesNotMatch(app, /One unlock credit deducted|Unlocking one uses an unlock credit|Code redeemed/);
  const message = formatTelegramSignalMessage({
    symbol: "BTC-USD", timeframe: "1h", direction: "long", setupType: "Momentum breakout", confidenceScore: 80, confirmations: []
  });
  assert.doesNotMatch(message, /unlock/i, "no unlock line in Telegram alerts");
  const markup = formatTelegramSignalReplyMarkup({ setupKey: "k", symbol: "BTC-USD", timeframe: "1h" });
  if (markup.reply_markup) assert.equal(markup.reply_markup.inline_keyboard[0][0].text, "View levels");
});

check("billing emails", () => {
  const charge = "2026-10-21T10:00:00Z";
  const started = emails.buildTrialStartedEmail({ firstChargeDate: charge, amountCents: 999, interval: "month" }).text;
  // Emails give the exact UTC moment, since they can't know the reader's time zone.
  assert.match(started, /Your card will be charged \$9\.99 on 21 Oct 2026, 10:00 UTC, and then \$9\.99 a month until you cancel\./);
  assert.match(started, /cancel any time in Settings → Billing/i);
  const ending = emails.buildTrialEndingEmail({ firstChargeDate: charge, amountCents: 8999, interval: "year" });
  assert.equal(ending.subject, "Your SignalForge trial ends on 21 Oct 2026, 10:00 UTC");
  assert.match(ending.text, /charged \$89\.99/);
  assert.match(ending.text, /Open Settings → Billing: https?:\/\/[^\s]+\/#billing/);
  assert.match(emails.buildFailedPaymentEmail().text, /open Settings → Billing, choose Update card/);
  assert.match(emails.buildSubscriptionCanceledEmail({ accessUntil: charge }).text, /You keep full access until 21 Oct 2026, 10:00 UTC/);
  assert.match(emails.buildTrialCardAlreadyUsedEmail({ amountCents: 999, interval: "month" }).text,
    /This card was already used for a free trial, so your subscription started today\./);
  assert.doesNotMatch(emails.buildWelcomeEmail({ username: "x" }).text, /unlock/i);
  assert.doesNotMatch(emails.buildVerifyEmail({ verificationUrl: "https://signalforge-app.com/v" }).text, /unlock/i);
});

check("legal: subscription terms, refund policy, privacy; consent version bumped", () => {
  const terms = app.slice(app.indexOf("  terms: {"), app.indexOf("  privacy: {"));
  const privacy = app.slice(app.indexOf("  privacy: {"), app.indexOf("  risk: {"));
  const refund = app.slice(app.indexOf("  refund: {"), app.indexOf("const defaultSupportIssues"));
  assert.match(terms, /It renews automatically at the end of each billing period until you cancel\./);
  assert.match(terms, /your card is charged automatically at the end of the trial/);
  assert.match(terms, /One free trial per person and per card/);
  assert.match(terms, /you keep access until the end of the period you've paid for/);
  assert.match(refund, /<strong>Monthly plans\.<\/strong> No partial refunds\./);
  assert.match(refund, /<strong>Annual plans\.<\/strong> If you ask within 14 days of an annual charge, we refund that charge in full\./);
  assert.match(refund, /If the law where you live gives you more rights, those apply\./);
  assert.match(privacy, /Stripe gives us a fingerprint of your card[\s\S]*We store only a keyed hash of it, use it only to enforce one free trial per card/);
  assert.match(privacy, /Trades you log in My trades are stored only to show your own statistics\./, "phase 2c line kept");
  assert.notEqual(CURRENT_LEGAL_CONSENT_VERSION, "2026-10-12", "the consent version changes with the legal text");
});

console.log(JSON.stringify(results, null, 2));
