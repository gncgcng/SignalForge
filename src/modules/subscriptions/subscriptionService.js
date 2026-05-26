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
  const allowance = user.freeSignalAllowance || appConfig.freeSignalAllowance;
  const remaining = Math.max(0, allowance - user.trialSignalsUsed);

  return {
    plan: user.plan,
    status: user.subscription.status,
    trialSignalsUsed: user.trialSignalsUsed,
    trialSignalsRemaining: remaining,
    freeSignalAllowance: allowance,
    paidCredits: user.paidCredits || 0,
    stripeReady: true,
    checkoutConfigured: Boolean(appConfig.stripe.publishableKey && appConfig.stripe.priceId)
  };
}

export function canGenerateSignal(user) {
  if (user.plan !== "trial") {
    return true;
  }

  return user.trialSignalsUsed < (user.freeSignalAllowance || appConfig.freeSignalAllowance) || (user.paidCredits || 0) > 0;
}

export async function recordSignalUsage(user) {
  if (user.plan === "trial") {
    await incrementTrialSignalsUsed(user.id);
    user.trialSignalsUsed += 1;
  }
}
