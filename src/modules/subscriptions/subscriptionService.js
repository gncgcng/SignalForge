import { appConfig } from "../../config/appConfig.js";
import { incrementTrialSignalsUsed } from "../../db/repositories.js";

export function ensureTrialSubscription(user) {
  user.subscription = user.subscription || {
    status: "trialing",
    provider: "stripe",
    providerCustomerId: null,
    currentPeriodEnd: null,
    createdAt: new Date().toISOString()
  };
}

export function getSubscriptionSummary(user) {
  ensureTrialSubscription(user);
  const isTester = user.role === "tester";
  const allowance = user.freeSignalAllowance ?? appConfig.freeSignalAllowance;
  const remaining = Math.max(0, allowance - user.trialSignalsUsed);

  return {
    plan: user.plan,
    role: user.role || "user",
    unlimitedSignals: isTester,
    status: user.subscription.status,
    trialSignalsUsed: user.trialSignalsUsed,
    trialSignalsRemaining: isTester ? null : remaining,
    freeSignalAllowance: allowance,
    paidCredits: user.paidCredits || 0,
    emailVerified: Boolean(user.emailVerifiedAt),
    trialUsed: Boolean(user.trialUsed),
    stripeReady: true,
    checkoutConfigured: Boolean(appConfig.stripe.publishableKey && appConfig.stripe.priceId)
  };
}

export function canGenerateSignal(user) {
  if (user.role === "tester") {
    return true;
  }

  if (user.plan !== "trial") {
    return true;
  }

  if (!user.emailVerifiedAt && (user.paidCredits || 0) <= 0) {
    return false;
  }

  return user.trialSignalsUsed < (user.freeSignalAllowance ?? appConfig.freeSignalAllowance) || (user.paidCredits || 0) > 0;
}

export async function recordSignalUsage(user) {
  if (user.role !== "tester" && user.plan === "trial") {
    await incrementTrialSignalsUsed(user.id);
    user.trialSignalsUsed += 1;
  }
}
