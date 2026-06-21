import {
  appConfig,
  getStripeConfigurationStatus,
  getStripeMode
} from "../../config/appConfig.js";
import { consumeDiscoveryCredits } from "../../db/repositories.js";

export const BILLING_PLANS = {
  free: {
    id: "free",
    name: "Free",
    discoveryLimit: 10,
    discoveryPeriod: "day",
    monthlyUnlockGrant: 0,
    lifetimeUnlockGrant: 3
  },
  pro: {
    id: "pro",
    name: "Pro",
    discoveryLimit: 300,
    discoveryPeriod: "month",
    monthlyUnlockGrant: 100,
    lifetimeUnlockGrant: 0
  },
  elite: {
    id: "elite",
    name: "Elite",
    discoveryLimit: 1000,
    discoveryPeriod: "month",
    monthlyUnlockGrant: 500,
    lifetimeUnlockGrant: 0
  }
};

export const CREDIT_PACKS = {
  pack10: { id: "pack10", name: "10 unlocks", quantity: 10 },
  pack50: { id: "pack50", name: "50 unlocks", quantity: 50 },
  pack100: { id: "pack100", name: "100 unlocks", quantity: 100 },
};

export function ensureTrialSubscription(user) {
  user.subscription = user.subscription || {
    status: "trialing",
    provider: "stripe",
    providerCustomerId: null,
    stripeMode: null,
    providerSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: new Date().toISOString()
  };
}

export function normalizePlan(plan) {
  if (plan === "trial") return "free";
  return BILLING_PLANS[plan] ? plan : "free";
}

export function getSubscriptionSummary(user) {
  ensureTrialSubscription(user);
  const isTester = user.role === "tester";
  const planId = isTester ? "tester" : normalizePlan(user.plan);
  const plan = BILLING_PLANS[planId] || null;
  const discoveriesUsed = plan?.discoveryPeriod === "day"
    ? Number(user.discoveriesToday || 0)
    : Number(user.discoveriesPeriod || 0);
  const unlockBalance = getUnlockBalance(user);
  const showStripeDiagnostics = !appConfig.isProduction ||
    appConfig.adminEmails.has(String(user.email || "").toLowerCase());
  const currentStripeMode = getStripeMode();
  const customerModeMismatch = Boolean(
    user.subscription.providerCustomerId &&
    user.subscription.stripeMode !== currentStripeMode
  );
  const stripeConfiguration = showStripeDiagnostics
    ? {
      ...getStripeConfigurationStatus(),
      customerModeWarning: customerModeMismatch
        ? `Stored Stripe customer mode is ${user.subscription.stripeMode || "unknown"}; ` +
          `current key mode is ${currentStripeMode}. A new customer will be created automatically.`
        : null
    }
    : null;

  return {
    plan: planId,
    planName: isTester ? "Tester" : plan.name,
    role: user.role || "user",
    unlimitedSignals: isTester,
    status: user.subscription.status,
    setupDiscoveries: {
      limit: isTester ? null : plan.discoveryLimit,
      used: isTester ? 0 : discoveriesUsed,
      remaining: isTester ? null : Math.max(0, plan.discoveryLimit - discoveriesUsed),
      period: isTester ? "unlimited" : plan.discoveryPeriod
    },
    unlockCreditsRemaining: isTester ? null : unlockBalance,
    unlockCreditsRollover: !isTester && planId !== "free",
    monthlyUnlockGrant: isTester ? null : plan.monthlyUnlockGrant,
    lifetimeUnlocksUsed: Number(user.lifetimeUnlocksUsed || user.trialSignalsUsed || 0),
    trialSignalsUsed: Number(user.trialSignalsUsed || 0),
    trialSignalsRemaining: isTester ? null : unlockBalance,
    freeSignalAllowance: appConfig.freeSignalAllowance,
    paidCredits: Number(user.paidCredits || 0),
    emailVerified: Boolean(user.emailVerifiedAt),
    trialUsed: Boolean(user.trialUsed),
    currentPeriodStart: user.subscription.currentPeriodStart,
    currentPeriodEnd: user.subscription.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(user.subscription.cancelAtPeriodEnd),
    stripeReady: true,
    checkoutConfigured: Boolean(appConfig.stripe.secretKey),
    customerPortalAvailable: Boolean(
      appConfig.stripe.secretKey &&
      user.subscription.providerCustomerId &&
      !customerModeMismatch
    ),
    stripeConfiguration,
    plans: Object.values(BILLING_PLANS),
    creditPacks: Object.values(CREDIT_PACKS)
  };
}

export function canGenerateSignal(user) {
  if (user.role === "tester") return true;
  if (!user.emailVerifiedAt && Number(user.paidCredits || 0) <= 0) return false;
  return getUnlockBalance(user) > 0;
}

export function canDiscoverSetups(user) {
  if (user.role === "tester") return true;
  if (
    normalizePlan(user.plan) === "free" &&
    !user.emailVerifiedAt &&
    Number(user.paidCredits || 0) <= 0
  ) {
    return false;
  }
  const summary = getSubscriptionSummary(user);
  return summary.setupDiscoveries.remaining > 0;
}

export async function recordDiscoveryUsage(user, quantity, scanKey) {
  if (user.role === "tester" || quantity <= 0) {
    return getSubscriptionSummary(user);
  }

  const plan = BILLING_PLANS[normalizePlan(user.plan)];
  const periodStart = plan.discoveryPeriod === "day"
    ? startOfUtcDay()
    : user.subscription?.currentPeriodStart || startOfUtcMonth();

  await consumeDiscoveryCredits(user.id, {
    quantity,
    limit: plan.discoveryLimit,
    periodStart,
    scanKey
  });

  if (plan.discoveryPeriod === "day") {
    user.discoveriesToday = Number(user.discoveriesToday || 0) + quantity;
  } else {
    user.discoveriesPeriod = Number(user.discoveriesPeriod || 0) + quantity;
  }
  return getSubscriptionSummary(user);
}

// Kept for older callers and tester regression coverage. Unlock debit is now atomic
// with saving the signal in the repository.
export async function recordSignalUsage() {
  return undefined;
}

function startOfUtcDay() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function startOfUtcMonth() {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function getUnlockBalance(user) {
  if (user.unlockCreditsBalance !== undefined && user.unlockCreditsBalance !== null) {
    return Number(user.unlockCreditsBalance);
  }
  return Math.max(
    0,
    Number(user.freeSignalAllowance ?? appConfig.freeSignalAllowance) -
      Number(user.trialSignalsUsed || 0)
  ) + Number(user.paidCredits || 0);
}
