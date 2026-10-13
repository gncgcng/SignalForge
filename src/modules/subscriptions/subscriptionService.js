import {
  appConfig,
  getStripeConfigurationStatus,
  getStripeMode
} from "../../config/appConfig.js";
import { consumeDiscoveryCredits } from "../../db/repositories.js";

// One plan: $9.99 a month or $89.99 a year, with a 7-day free trial (card required).
export const PLAN = Object.freeze({
  id: "signalforge",
  name: "SignalForge",
  trialDays: 7,
  intervals: Object.freeze({
    month: Object.freeze({ priceKey: "monthly", amountCents: 999, label: "$9.99/month" }),
    year: Object.freeze({ priceKey: "annual", amountCents: 8999, label: "$89.99/year" })
  })
});

// Free accounts see setups with levels on these markets; every other market needs the plan.
export const FREE_LEVEL_MARKETS = Object.freeze(["BTC-USD", "ETH-USD"]);
// Free accounts can run this many setup discoveries a day. Paid access isn't metered.
export const FREE_DISCOVERY_LIMIT = 10;

// Stripe's own subscription statuses that keep paid access. past_due keeps access while Stripe retries the card;
// the app shows "Payment failed — update your card".
export const PAID_ACCESS_STATUSES = Object.freeze(["trialing", "active", "past_due"]);

export const LEVELS_TRIAL_MESSAGE = "Start your 7-day free trial to see levels on every market.";
export const PAID_FEATURE_MESSAGE = "This is part of the SignalForge plan. Start your 7-day free trial to use it.";

// The one function that decides paid access, on the server. Testers and admins always have it.
export function hasPaidAccess(user) {
  if (!user) return false;
  if (user.role === "tester") return true;
  if (user.email && appConfig.adminEmails.has(String(user.email).toLowerCase())) return true;
  const subscription = user.subscription || {};
  if (!PAID_ACCESS_STATUSES.includes(subscription.status)) return false;
  if (!subscription.providerSubscriptionId) return false;
  // A subscription from the other Stripe mode (e.g. old test-mode subscriptions under a live key) never pays here.
  const currentMode = getStripeMode();
  const knownModes = ["test", "live"];
  if (knownModes.includes(currentMode) && knownModes.includes(subscription.stripeMode) && subscription.stripeMode !== currentMode) {
    return false;
  }
  return true;
}

export function isPastDue(user) {
  return hasPaidAccess(user) && user.subscription?.status === "past_due";
}

export function canViewLevels(user, symbol) {
  return hasPaidAccess(user) || FREE_LEVEL_MARKETS.includes(String(symbol || "").toUpperCase());
}

export function paidAccessError(message = PAID_FEATURE_MESSAGE) {
  const error = new Error(message);
  error.statusCode = 402;
  error.code = "PAID_ACCESS_REQUIRED";
  return error;
}

export function assertPaidAccess(user, message) {
  if (!hasPaidAccess(user)) throw paidAccessError(message);
}

export function assertCanViewLevels(user, symbol) {
  if (!canViewLevels(user, symbol)) throw paidAccessError(LEVELS_TRIAL_MESSAGE);
}

export function intervalForPrice(priceId) {
  if (!priceId) return null;
  if (priceId === appConfig.stripe.prices.monthly) return "month";
  if (priceId === appConfig.stripe.prices.annual) return "year";
  return null;
}

export function priceIdForInterval(interval) {
  const key = PLAN.intervals[interval]?.priceKey;
  return key ? appConfig.stripe.prices[key] || "" : "";
}

export function amountCentsForInterval(interval) {
  return PLAN.intervals[interval]?.amountCents ?? null;
}

// Legacy rows (old default 'trialing' with no Stripe subscription) read as 'none'.
export function subscriptionStatus(user) {
  const subscription = user?.subscription || {};
  if (!subscription.status) return "none";
  if (!subscription.providerSubscriptionId && ["trialing", "active"].includes(subscription.status)) return "none";
  return subscription.status;
}

export function ensureSubscriptionShape(user) {
  user.subscription = user.subscription || {
    status: "none",
    provider: "stripe",
    providerCustomerId: null,
    stripeMode: null,
    providerSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
    firstSubscribedAt: null,
    billingInterval: null,
    createdAt: new Date().toISOString()
  };
}

// Kept for older callers; the subscription row now defaults to 'none'.
export const ensureTrialSubscription = ensureSubscriptionShape;

export function normalizePlan(plan) {
  return plan === PLAN.id ? PLAN.id : "free";
}

// What the Billing page and the client need. Trial eligibility needs the database, so the controller adds it.
export function getSubscriptionSummary(user, { trialEligible = null } = {}) {
  ensureSubscriptionShape(user);
  const isTester = user.role === "tester";
  const paid = hasPaidAccess(user);
  const status = subscriptionStatus(user);
  const discoveriesUsed = Number(user.discoveriesToday || 0);
  const showStripeDiagnostics = !appConfig.isProduction ||
    appConfig.adminEmails.has(String(user.email || "").toLowerCase());
  const currentStripeMode = getStripeMode();
  const customerModeMismatch = Boolean(
    user.subscription.providerCustomerId &&
    user.subscription.stripeMode !== currentStripeMode
  );
  const interval = user.subscription.billingInterval || intervalForPrice(user.subscription.priceId) || null;
  const nextChargeAt = status === "trialing"
    ? user.subscription.trialEnd || user.subscription.currentPeriodEnd
    : user.subscription.currentPeriodEnd;
  const stripeConfiguration = showStripeDiagnostics
    ? {
      ...getStripeConfigurationStatus(),
      customerModeWarning: customerModeMismatch
        ? `Stored Stripe customer mode is ${user.subscription.stripeMode || "unknown"}; ` +
          `current key mode is ${currentStripeMode}. A new customer will be created automatically.`
        : null
    }
    : null;
  const unlimited = isTester || paid;

  return {
    plan: isTester ? "tester" : (paid ? PLAN.id : "free"),
    planName: isTester ? "Tester" : (paid ? PLAN.name : "Free"),
    role: user.role || "user",
    hasPaidAccess: paid,
    pastDue: paid && status === "past_due",
    status,
    billingInterval: interval,
    nextChargeAt: paid && !user.subscription.cancelAtPeriodEnd ? nextChargeAt || null : null,
    nextChargeCents: paid && !user.subscription.cancelAtPeriodEnd && interval ? amountCentsForInterval(interval) : null,
    trialEnd: user.subscription.trialEnd || null,
    currentPeriodStart: user.subscription.currentPeriodStart,
    currentPeriodEnd: user.subscription.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(user.subscription.cancelAtPeriodEnd),
    // Only /api/subscriptions/me checks the identity claims (it needs the database). Everywhere else an account that
    // has subscribed before is still known to have no trial; otherwise it's unknown (null).
    trialEligible: trialEligible ?? (user.subscription.firstSubscribedAt || user.subscription.providerSubscriptionId ? false : null),
    freeLevelMarkets: FREE_LEVEL_MARKETS,
    setupDiscoveries: {
      limit: unlimited ? null : FREE_DISCOVERY_LIMIT,
      used: unlimited ? 0 : discoveriesUsed,
      remaining: unlimited ? null : Math.max(0, FREE_DISCOVERY_LIMIT - discoveriesUsed),
      period: unlimited ? "unlimited" : "day"
    },
    unlimitedSignals: isTester,
    emailVerified: Boolean(user.emailVerifiedAt),
    stripeReady: true,
    checkoutConfigured: Boolean(appConfig.stripe.secretKey),
    checkoutEnabled: Boolean(appConfig.stripe.checkoutEnabled),
    customerPortalAvailable: Boolean(
      appConfig.stripe.secretKey &&
      user.subscription.providerCustomerId &&
      !customerModeMismatch
    ),
    stripeConfiguration,
    pricing: {
      trialDays: PLAN.trialDays,
      monthly: { interval: "month", amountCents: PLAN.intervals.month.amountCents, label: PLAN.intervals.month.label },
      annual: { interval: "year", amountCents: PLAN.intervals.year.amountCents, label: PLAN.intervals.year.label }
    }
  };
}

export function canDiscoverSetups(user) {
  if (user.role === "tester" || hasPaidAccess(user)) return true;
  if (!user.emailVerifiedAt) return false;
  return getSubscriptionSummary(user).setupDiscoveries.remaining > 0;
}

export async function recordDiscoveryUsage(user, quantity, scanKey) {
  if (user.role === "tester" || hasPaidAccess(user) || quantity <= 0) {
    return getSubscriptionSummary(user);
  }

  await consumeDiscoveryCredits(user.id, {
    quantity,
    limit: FREE_DISCOVERY_LIMIT,
    periodStart: startOfUtcDay(),
    scanKey
  });
  user.discoveriesToday = Number(user.discoveriesToday || 0) + quantity;
  return getSubscriptionSummary(user);
}

// Kept for older callers. Viewing levels no longer uses credits.
export async function recordSignalUsage() {
  return undefined;
}

function startOfUtcDay() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
