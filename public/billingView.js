// Billing and pricing copy for the one plan ($9.99 a month or $89.99 a year, 7-day free trial, card required).
// Pure, so tests and the claims lint can check every sentence; app.js renders it on the landing pricing card,
// the Billing page and the past-due banner.

export const PLAN_PRICES = Object.freeze({
  month: Object.freeze({ amountCents: 999, label: "$9.99", per: "month", short: "$9.99/month" }),
  year: Object.freeze({ amountCents: 8999, label: "$89.99", per: "year", short: "$89.99/year" })
});
export const TRIAL_DAYS = 7;
// 12 × $9.99 = $119.88; $89.99 is 24.9% less.
export const ANNUAL_SAVING_LABEL = "save 25%";
export const PAST_DUE_BANNER = "Payment failed — update your card";
export const LEVELS_TRIAL_MESSAGE = "Start your 7-day free trial to see levels on every market.";
export const ONE_TRIAL_RULE = "One free trial per person and per card.";

export const FREE_FEATURES = Object.freeze([
  "The research page, the fee calculator and the track-records table",
  "Setups with levels on BTC-USD and ETH-USD, with their track records",
  "Paper trading"
]);
export const PAID_FEATURES = Object.freeze([
  "Setups and levels on every market and timeframe",
  "Telegram alerts",
  "The trade checker and My trades",
  "Backtesting and the performance pages"
]);

// "21 Oct 2026", in the viewer's own time zone, so it matches the date Stripe shows them (a trial ending at 04:22 UTC
// on the 21st ends on the evening of the 20th in the Americas). Tests pass timeZone: "UTC".
export function formatBillingDate(value, { timeZone } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", ...(timeZone ? { timeZone } : {}) }).format(date);
}

export function formatAmount(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100);
}

export function trialChargeDate(now = new Date(), days = TRIAL_DAYS) {
  return new Date(new Date(now).getTime() + days * 86400000);
}

export function priceLine(interval) {
  const price = PLAN_PRICES[interval] || PLAN_PRICES.month;
  return `${price.label} a ${price.per}`;
}

// The sentence under the pricing card. Without a trial (the account already had one) it says so before the click.
export function pricingNote({ now = new Date(), trialEligible = true, timeZone } = {}) {
  if (trialEligible === false) {
    return `This account has already had its free trial, so a subscription starts today and is charged at checkout. Cancel any time in Settings. ${ONE_TRIAL_RULE}`;
  }
  return `7-day free trial. Card required. You won't be charged until ${formatBillingDate(trialChargeDate(now), { timeZone })}. Cancel any time in Settings. ${ONE_TRIAL_RULE}`;
}

export function checkoutButtonLabel({ trialEligible = true } = {}) {
  return trialEligible === false ? "Subscribe" : "Start 7-day free trial";
}

// The Billing page's status, in plain words. resume: a cancellation is scheduled for the period end, so the primary
// button is "Resume subscription" (the Customer Portal) instead of "Update card".
export function describeBillingStatus(summary = {}, { timeZone } = {}) {
  const status = summary.status || "none";
  const interval = summary.billingInterval === "year" ? "year" : "month";
  const price = PLAN_PRICES[interval];
  const nextCharge = formatBillingDate(summary.nextChargeAt, { timeZone });
  const periodEnd = formatBillingDate(summary.trialEnd && status === "trialing" ? summary.trialEnd : summary.currentPeriodEnd, { timeZone });
  if (summary.plan === "tester") {
    return { tone: "neutral", headline: "Tester — full access", detail: "Tester accounts have every paid feature.", banner: null, manage: false, resume: false };
  }
  if (status === "trialing") {
    if (summary.cancelAtPeriodEnd) {
      return {
        tone: "neutral",
        headline: `Free trial — cancelled. Full access until ${periodEnd}, then your account moves to the free plan. You won't be charged.`,
        detail: "",
        banner: null,
        manage: true,
        resume: true
      };
    }
    return {
      tone: "good",
      headline: `Free trial — first charge ${price.label} on ${nextCharge || periodEnd}`,
      detail: `Then ${priceLine(interval)} until you cancel. Cancel before ${nextCharge || periodEnd} and you won't be charged.`,
      banner: null,
      manage: true,
      resume: false
    };
  }
  if (status === "active") {
    if (summary.cancelAtPeriodEnd) {
      return {
        tone: "neutral",
        headline: `Subscription cancelled. Full access until ${periodEnd}, then your account moves to the free plan.`,
        detail: "",
        banner: null,
        manage: true,
        resume: true
      };
    }
    return { tone: "good", headline: `Active — ${price.short}`, detail: nextCharge ? `Next charge ${price.label} on ${nextCharge}.` : "", banner: null, manage: true, resume: false };
  }
  if (status === "past_due") {
    return {
      tone: "warning",
      headline: PAST_DUE_BANNER,
      detail: "Your access continues while Stripe retries the card. Update your card to keep your plan.",
      banner: PAST_DUE_BANNER,
      manage: true,
      resume: false
    };
  }
  if (status === "canceled") {
    return { tone: "neutral", headline: "Cancelled — your subscription has ended", detail: "Your My trades history stays readable and exportable. You can subscribe again at any time.", banner: null, manage: false, resume: false };
  }
  if (["unpaid", "incomplete", "incomplete_expired", "paused"].includes(status)) {
    return { tone: "warning", headline: "Not active — the last payment didn't go through", detail: "Update your card or subscribe again to get the plan back.", banner: null, manage: true, resume: false };
  }
  return { tone: "neutral", headline: "Free plan", detail: FREE_FEATURES.join(" · "), banner: null, manage: false, resume: false };
}

export function renderFeatureListHtml(features, escapeHtml) {
  return `<ul>${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>`;
}
