import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig, getStripeMode } from "../../config/appConfig.js";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  findUserById,
  findUserByStripeCustomer,
  getRetryableStripeWebhookEvent,
  grantSubscriptionEntitlements,
  grantUnlockCredits,
  listStripeWebhookEvents,
  updateStripeCustomer,
  updateStripeSubscription
} from "../../db/repositories.js";
import {
  activateAffiliateReferral,
  deactivateAffiliateReferral,
  reconcileAffiliateRefund,
  recordRecurringAffiliateCommission
} from "../affiliates/affiliateRepository.js";
import { trackProductEvent } from "../analytics/productAnalyticsService.js";
import {
  sendAffiliateCommissionEmail,
  sendFailedPaymentEmail,
  sendSubscriptionConfirmationEmail
} from "../notifications/transactionalEmailService.js";
import { BILLING_PLANS, CREDIT_PACKS, normalizePlan } from "./subscriptionService.js";
import { recordStripeDiscountRedemption } from "../promo-codes/promoCodeRepository.js";

const stripeApiBase = "https://api.stripe.com/v1";

export async function createCheckout(user, { plan, pack }) {
  assertStripeCheckoutConfigured(user);
  assertStripeRedirectsConfigured(user);
  const planConfig = plan ? BILLING_PLANS[plan] : null;
  const packConfig = pack ? CREDIT_PACKS[pack] : null;

  if ((!planConfig || plan === "free") && !packConfig) {
    throw validationError("Choose a valid subscription plan or credit pack.");
  }
  const customerId = await ensureStripeCustomer(user);
  if (
    planConfig &&
    user.subscription?.providerSubscriptionId &&
    user.subscription?.stripeMode === getStripeMode()
  ) {
    return {
      ...(await createCustomerPortal(user)),
      mode: "portal"
    };
  }

  const priceId = planConfig
    ? appConfig.stripe.prices[plan]
    : appConfig.stripe.prices[pack];

  if (!priceId) {
    throw missingStripeConfiguration(
      appConfig.stripe.priceEnvironmentKeys[plan || pack],
      user
    );
  }

  const kind = planConfig ? "subscription" : "credit_pack";
  const session = await stripeRequest("/checkout/sessions", {
    mode: planConfig ? "subscription" : "payment",
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: appConfig.stripe.successUrl,
    cancel_url: appConfig.stripe.cancelUrl,
    allow_promotion_codes: appConfig.stripe.promotionCodesEnabled ? "true" : undefined,
    "metadata[user_id]": user.id,
    "metadata[kind]": kind,
    "metadata[plan]": planConfig?.id || "",
    "metadata[pack]": packConfig?.id || "",
    "metadata[unlock_quantity]": String(packConfig?.quantity || 0),
    ...(planConfig ? {
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][plan]": planConfig.id
    } : {})
  });
  await trackProductEvent({
    eventType: "checkout_started",
    userId: user.id,
    plan: planConfig?.id || null,
    amountCents: planMonthlyAmountCents(planConfig?.id),
    metadata: {
      kind,
      pack: packConfig?.id || null
    }
  });

  return { url: session.url, id: session.id, mode: kind };
}

export async function createCustomerPortal(user) {
  assertStripeCheckoutConfigured(user);
  assertStripeRedirectsConfigured(user);
  const customerId = await ensureStripeCustomer(user);
  const session = await stripeRequest("/billing_portal/sessions", {
    customer: customerId,
    return_url: appConfig.stripe.portalReturnUrl
  });
  return { url: session.url };
}

// Pinned so the promo calls don't depend on the account's default API version
// (promotion codes take promotion[coupon] rather than a top-level coupon here).
// Only these promo calls send it; every other Stripe call uses the account default.
const PROMO_STRIPE_API_VERSION = "2025-09-30.clover";
const promoStripeOptions = { headers: { "stripe-version": PROMO_STRIPE_API_VERSION } };

export async function createPromoCoupon({ percentOff, amountOffCents, maxRedemptions, expiresAt }) {
  return stripeRequest("/coupons", {
    percent_off: percentOff || undefined,
    amount_off: amountOffCents || undefined,
    currency: amountOffCents ? "usd" : undefined,
    duration: "once",
    max_redemptions: maxRedemptions,
    redeem_by: expiresAt ? String(Math.floor(expiresAt.getTime() / 1000)) : undefined
  }, promoStripeOptions);
}

export async function deletePromoCoupon(couponId) {
  return stripeRequest(`/coupons/${encodeURIComponent(couponId)}`, {}, { ...promoStripeOptions, method: "DELETE" });
}

export async function createPromoPromotionCode({ couponId, code, maxRedemptions, expiresAt }) {
  return stripeRequest("/promotion_codes", {
    "promotion[type]": "coupon",
    "promotion[coupon]": couponId,
    code,
    max_redemptions: maxRedemptions,
    expires_at: expiresAt ? String(Math.floor(expiresAt.getTime() / 1000)) : undefined
  }, promoStripeOptions);
}

export async function updatePromoPromotionCodeActive(promotionCodeId, active) {
  return stripeRequest(`/promotion_codes/${encodeURIComponent(promotionCodeId)}`, {
    active: active ? "true" : "false"
  }, promoStripeOptions);
}

export function verifyStripeSignature(rawBody, signatureHeader) {
  if (!appConfig.stripe.webhookSecret) {
    throw missingStripeConfiguration("STRIPE_WEBHOOK_SECRET");
  }

  const parts = String(signatureHeader || "").split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) {
    throw validationError("Invalid Stripe signature.");
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw validationError("Expired Stripe signature.");
  }

  const expected = createHmac("sha256", appConfig.stripe.webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const valid = signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });

  if (!valid) throw validationError("Invalid Stripe signature.");
  return JSON.parse(rawBody);
}

export async function processStripeEvent(event) {
  const object = event.data?.object || {};
  console.log(
    `[stripe] Webhook received event=${safeLogValue(event.id)} ` +
    `type=${safeLogValue(event.type)} object=${safeLogValue(object.id)}`
  );
  if (!await claimStripeWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    stripeObjectId: object.id,
    payload: event
  })) {
    console.log(
      `[stripe] Webhook duplicate event=${safeLogValue(event.id)} ` +
      `type=${safeLogValue(event.type)}`
    );
    return { duplicate: true };
  }

  try {
    let result = { action: "ignored", userId: null };
    if (event.type === "checkout.session.completed") {
      result = await processCheckoutCompleted(object);
    } else if (
      event.type === "invoice.payment_succeeded" ||
      event.type === "invoice.paid"
    ) {
      result = await processInvoicePaymentSucceeded(object, event.id);
    } else if (event.type === "invoice.payment_failed") {
      result = await processInvoicePaymentFailed(object);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      result = await processSubscriptionChanged(object, event.type);
    } else if (event.type === "charge.refunded") {
      result = await processChargeRefunded(object);
    }

    await completeStripeWebhookEvent(event.id, {
      userId: result?.userId || null,
      result
    });
    console.log(
      `[stripe] Webhook processed event=${safeLogValue(event.id)} ` +
      `type=${safeLogValue(event.type)} action=${safeLogValue(result?.action)}`
    );
    return { duplicate: false, action: result?.action || "ignored" };
  } catch (error) {
    const safeError = sanitizeStripeError(error);
    await failStripeWebhookEvent(event.id, safeError);
    console.error(
      `[stripe] Webhook processing failed event=${safeLogValue(event.id)} ` +
      `type=${safeLogValue(event.type)} error=${safeError}`
    );
    throw error;
  }
}

export async function getStripeWebhookHistory({ status, limit } = {}) {
  const allowedStatus = ["processing", "processed", "failed"].includes(status)
    ? status
    : null;
  return listStripeWebhookEvents({ status: allowedStatus, limit });
}

export async function retryStripeWebhookEvent(eventId) {
  const stored = await getRetryableStripeWebhookEvent(eventId);
  if (!stored?.payload_json) {
    throw validationError("Failed Stripe webhook event not found or has no retry payload.");
  }
  return processStripeEvent(stored.payload_json);
}

async function ensureStripeCustomer(user) {
  const currentMode = getStripeMode();
  const storedMode = user.subscription?.stripeMode || null;
  const storedCustomerId = user.subscription?.providerCustomerId || null;

  if (shouldReuseStripeCustomer(storedCustomerId, storedMode, currentMode)) {
    return user.subscription.providerCustomerId;
  }
  const modeMismatch = Boolean(storedCustomerId && storedMode !== currentMode);
  if (modeMismatch) {
    console.warn(
      `[stripe] Customer mode mismatch for user ${user.id}: ` +
      `stored=${storedMode || "unknown"} current=${currentMode}; creating a new customer.`
    );
  }

  const customer = await stripeRequest("/customers", {
    email: user.email,
    name: user.name,
    "metadata[user_id]": user.id,
    "metadata[stripe_mode]": currentMode
  });
  await updateStripeCustomer(user.id, customer.id, currentMode, modeMismatch);
  user.subscription.providerCustomerId = customer.id;
  user.subscription.stripeMode = currentMode;
  if (modeMismatch) {
    user.subscription.providerSubscriptionId = null;
    user.subscription.priceId = null;
    user.subscription.currentPeriodStart = null;
    user.subscription.currentPeriodEnd = null;
    user.subscription.cancelAtPeriodEnd = false;
  }
  return customer.id;
}

export function shouldReuseStripeCustomer(customerId, storedMode, currentMode) {
  return Boolean(
    customerId &&
    (currentMode === "test" || currentMode === "live") &&
    storedMode === currentMode
  );
}

async function processCheckoutCompleted(session) {
  const customerId = stripeId(session.customer);
  const userId = session.metadata?.user_id ||
    (await findUserByStripeCustomer(customerId, getStripeMode()))?.id;
  const kind = session.metadata?.kind;
  if (!userId && ["subscription", "credit_pack"].includes(kind)) {
    throw retryableWebhookError("Unable to resolve the checkout user.");
  }
  if (!userId) return { action: "checkout_ignored", userId: null };
  if (isDeletedAccount(await findUserById(userId))) return deletedAccountResult();

  if (customerId) {
    await updateStripeCustomer(userId, customerId, getStripeMode());
  }
  await recordPromoRedemptionFromCheckout(session, userId);
  if (session.metadata?.kind === "credit_pack") {
    const quantity = CREDIT_PACKS[session.metadata.pack]?.quantity || 0;
    if (quantity <= 0) throw retryableWebhookError("Unknown Stripe credit pack.");
    await grantUnlockCredits(userId, quantity, `checkout:${session.id}`, "credit_pack");
    await trackProductEvent({
      eventType: "checkout_completed",
      userId,
      amountCents: Number(session.amount_total || 0),
      metadata: { kind: "credit_pack", pack: session.metadata.pack || null }
    });
    return { action: "credit_pack_granted", userId };
  }

  const subscriptionId = stripeId(session.subscription);
  if (kind === "subscription") {
    const planId = normalizePlan(session.metadata?.plan);
    if (planId === "free" || !subscriptionId) {
      throw retryableWebhookError("Checkout subscription metadata is incomplete.");
    }

    await updateStripeSubscription({
      userId,
      customerId,
      subscriptionId,
      status: "active",
      plan: planId,
      priceId: appConfig.stripe.prices[planId],
      periodStart: null,
      periodEnd: null,
      stripeMode: getStripeMode(),
      cancelAtPeriodEnd: false
    });
    const referral = await activateAffiliateReferral(userId, planId);
    await trackProductEvent({
      eventType: "checkout_completed",
      userId,
      plan: planId,
      amountCents: Number(session.amount_total || 0),
      metadata: { kind: "subscription" }
    });
    await trackProductEvent({
      eventType: "subscription",
      userId,
      plan: planId,
      amountCents: Number(session.amount_total || 0),
      metadata: { source: "checkout" }
    });
    if (referral) {
      await trackProductEvent({
        eventType: "affiliate_conversion",
        userId,
        plan: planId,
        metadata: { source: "checkout" }
      });
    }

    try {
      const subscription = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
      await processSubscriptionChanged(subscription, "customer.subscription.created");
    } catch (error) {
      console.warn(
        `[stripe] Checkout upgraded user=${safeLogValue(userId)} plan=${safeLogValue(planId)} ` +
        `but subscription enrichment will retry: ${sanitizeStripeError(error)}`
      );
      throw error;
    }
    return { action: "subscription_activated", userId, plan: planId };
  }
  return { action: "checkout_ignored", userId };
}

async function processInvoicePaymentSucceeded(invoice, stripeEventId) {
  const customerId = stripeId(invoice.customer);
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  let subscription = null;

  if (subscriptionId) {
    subscription = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  const userId = subscription?.metadata?.user_id || invoice.metadata?.user_id;
  const user = userId
    ? await findUserById(userId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (!user) throw retryableWebhookError("Unable to resolve the invoice user.");
  if (isDeletedAccount(user)) return deletedAccountResult();

  const priceId = getInvoicePriceId(invoice) ||
    subscription?.items?.data?.[0]?.price?.id;
  const planId = planFromPrice(priceId);
  const plan = BILLING_PLANS[planId];
  if (!plan || plan.monthlyUnlockGrant <= 0) {
    if (isCreditPackPrice(priceId)) {
      return { action: "credit_pack_invoice_ignored", userId: user.id };
    }
    throw retryableWebhookError(`Unknown subscription price ${safeLogValue(priceId)}.`);
  }

  const period = getInvoicePeriod(invoice, priceId);
  const subscriptionPeriod = getSubscriptionPeriod(subscription);
  const applied = await updateStripeSubscription({
    userId: user.id,
    customerId,
    subscriptionId,
    status: subscription?.status || "active",
    plan: planId,
    priceId,
    periodStart: fromUnix(period.start || subscriptionPeriod.start),
    periodEnd: fromUnix(period.end || subscriptionPeriod.end),
    stripeMode: getStripeMode(),
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end)
  });
  if (!applied) return deletedAccountResult();

  const periodStart = period.start || subscriptionPeriod.start;
  const grantReference = subscriptionId && periodStart
    ? `subscription:${subscriptionId}:${planId}:${periodStart}`
    : `invoice:${invoice.id}`;
  await grantSubscriptionEntitlements({
    userId: user.id,
    plan: planId,
    scanCredits: plan.discoveryLimit,
    unlockCredits: plan.monthlyUnlockGrant,
    externalReference: grantReference
  });
  const commission = await recordRecurringAffiliateCommission({
    referredUserId: user.id,
    plan: planId,
    grossAmountCents: Number(invoice.amount_paid || 0),
    stripeInvoiceId: invoice.id,
    stripeEventId,
    periodStart: fromUnix(periodStart)
  });
  await trackProductEvent({
    eventType: "subscription",
    userId: user.id,
    plan: planId,
    amountCents: Number(invoice.amount_paid || 0),
    metadata: { source: "invoice" }
  });
  sendSubscriptionConfirmationEmail(user, planId);
  if (commission?.affiliateUser?.email) {
    sendAffiliateCommissionEmail(commission.affiliateUser, {
      plan: planId,
      commissionCents: commission.commission_amount_cents
    });
  }
  return {
    action: "subscription_payment_applied",
    userId: user.id,
    plan: planId,
    affiliateCommissionCreated: Boolean(commission)
  };
}

async function processInvoicePaymentFailed(invoice) {
  const customerId = stripeId(invoice.customer);
  const userId = invoice.metadata?.user_id;
  const user = userId
    ? await findUserById(userId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (!user) throw retryableWebhookError("Unable to resolve the failed invoice user.");
  if (isDeletedAccount(user)) return deletedAccountResult();

  sendFailedPaymentEmail(user);
  return { action: "failed_payment_notified", userId: user.id };
}

async function processSubscriptionChanged(subscription, eventType) {
  const metadataUserId = subscription.metadata?.user_id || null;
  const customerId = stripeId(subscription.customer);
  const user = metadataUserId
    ? await findUserById(metadataUserId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (!user) {
    // Account deletion clears the local customer id and deletes the Stripe customer, so a
    // later subscription.deleted for it resolves to nobody. Acknowledge only that exact case:
    // a deleted event, no user_id metadata, and a customer Stripe confirms is deleted. A
    // customer that exists but isn't linked yet (subscription events can arrive before
    // checkout.session.completed links it) still throws, so Stripe retries until it's linked.
    if (
      eventType === "customer.subscription.deleted" &&
      !metadataUserId &&
      customerId &&
      await isStripeCustomerDeleted(customerId)
    ) {
      return { action: "subscription_deleted_unknown_customer", userId: null };
    }
    throw retryableWebhookError("Unable to resolve the subscription user.");
  }
  if (isDeletedAccount(user)) return deletedAccountResult();

  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const active = !eventType.endsWith(".deleted") &&
    ["active", "trialing", "past_due"].includes(subscription.status);
  const plan = active ? planFromPrice(priceId) : "free";
  const period = getSubscriptionPeriod(subscription);

  const applied = await updateStripeSubscription({
    userId: user.id,
    customerId: stripeId(subscription.customer),
    subscriptionId: eventType.endsWith(".deleted") ? null : subscription.id,
    status: eventType.endsWith(".deleted") ? "canceled" : subscription.status,
    plan: normalizePlan(plan),
    priceId: active ? priceId : null,
    periodStart: fromUnix(period.start),
    periodEnd: fromUnix(period.end),
    stripeMode: getStripeMode(),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
  });
  if (!applied) return deletedAccountResult();
  if (!active) {
    await deactivateAffiliateReferral(user.id);
  }
  return {
    action: active ? "subscription_synced" : "subscription_cancelled",
    userId: user.id,
    plan: normalizePlan(plan)
  };
}

// Events for an anonymized account are acknowledged (so Stripe stops retrying) but never
// applied, and are stored without a user link.
function isDeletedAccount(user) {
  return user?.accountStatus === "deleted";
}

function deletedAccountResult() {
  return { action: "ignored_deleted_account", userId: null };
}

// Stripe answers a retrieve of a deleted customer with a { deleted: true } stub. Any lookup
// error propagates, so the webhook fails and Stripe retries rather than guessing.
async function isStripeCustomerDeleted(customerId) {
  const customer = await stripeGet(`/customers/${encodeURIComponent(customerId)}`);
  return customer?.deleted === true;
}

async function processChargeRefunded(charge) {
  const invoiceId = stripeId(charge.invoice);
  if (!invoiceId) return { action: "refund_ignored", userId: null };
  const refund = await reconcileAffiliateRefund(invoiceId, Number(charge.amount_refunded || 0));
  return { action: refund ? "affiliate_refund_reconciled" : "refund_ignored", userId: null };
}

function planFromPrice(priceId) {
  if (priceId === appConfig.stripe.prices.elite) return "elite";
  if (priceId === appConfig.stripe.prices.pro) return "pro";
  return "free";
}

function planMonthlyAmountCents(planId) {
  if (planId === "pro") return 2900;
  if (planId === "elite") return 9900;
  return 0;
}

function isCreditPackPrice(priceId) {
  return ["pack10", "pack50", "pack100"]
    .some((pack) => appConfig.stripe.prices[pack] === priceId);
}

export function getPlanEntitlementsForPrice(priceId) {
  const planId = planFromPrice(priceId);
  const plan = BILLING_PLANS[planId];
  if (!plan || planId === "free") return null;
  return {
    plan: planId,
    scanCredits: plan.discoveryLimit,
    unlockCredits: plan.monthlyUnlockGrant
  };
}

// Best-effort, informational only: Stripe already enforces the redemption cap for
// stripe_discount codes, this just mirrors the result into our own table for admin
// reporting. Any failure here must never break checkout processing.
async function recordPromoRedemptionFromCheckout(session, userId) {
  try {
    const promotionCodeId = stripeId(session.discounts?.[0]?.promotion_code) ||
      await resolveSessionPromotionCodeId(session.id);
    if (!promotionCodeId) return;
    await recordStripeDiscountRedemption({ stripePromotionCodeId: promotionCodeId, userId });
  } catch (error) {
    console.warn(`[stripe] promo_redemption_record_failed session=${safeLogValue(session.id)} reason=${sanitizeStripeError(error)}`);
  }
}

async function resolveSessionPromotionCodeId(sessionId) {
  const detailed = await stripeGet(
    `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=total_details.breakdown`
  );
  // discount.promotion_code exists before and after 2025-09-30.clover (clover only replaced
  // discount.coupon with discount.source.coupon), so this works on any account/webhook version.
  return stripeId(detailed.total_details?.breakdown?.discounts?.[0]?.discount?.promotion_code) || null;
}

const STRIPE_TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
const LOCAL_BILLABLE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

// Cancels every non-terminal Stripe subscription on the user's customer immediately
// (not at period end: the account is about to stop existing). Stripe is treated as the
// source of truth so a missed webhook can't leave a billable subscription behind.
// Does not touch our database; callers record the resulting local state.
export async function cancelSubscription(user) {
  const subscription = user?.subscription || {};
  const customerId = subscription.providerCustomerId || null;
  const localSubscriptionId = subscription.providerSubscriptionId || null;
  const locallyBillable = Boolean(localSubscriptionId) &&
    LOCAL_BILLABLE_SUBSCRIPTION_STATUSES.has(subscription.status);

  if (!customerId && !localSubscriptionId) {
    return { canceledSubscriptionIds: [], checkedStripe: false };
  }

  const stripeReachable = Boolean(appConfig.stripe.secretKey) &&
    shouldReuseStripeCustomer(customerId, subscription.stripeMode, getStripeMode());
  if (!stripeReachable) {
    if (locallyBillable) {
      const error = new Error("Unable to confirm your subscription is cancelled. Please contact support to delete your account.");
      error.statusCode = 409;
      error.code = "subscription_unverifiable";
      throw error;
    }
    return { canceledSubscriptionIds: [], checkedStripe: false };
  }

  // The full list is fetched before anything is cancelled: any page failing aborts with nothing touched.
  let listed;
  try {
    listed = await listCustomerSubscriptions(customerId);
  } catch (cause) {
    // A retry after a partial deletion: the customer is already gone from Stripe, which
    // cancelled all its subscriptions when it was deleted. Confirmed with a retrieve (a deleted
    // customer returns a `deleted: true` stub), so a customer that never existed, e.g. under
    // a different Stripe account's key, still fails as permanent.
    if (cause.stripeCode === "resource_missing") {
      let customer;
      try {
        customer = await stripeGet(`/customers/${encodeURIComponent(customerId)}`);
      } catch (lookupError) {
        throw stripeVerificationError(isTransientStripeError(lookupError) ? lookupError : cause, customerId, "subscription list");
      }
      if (customer?.deleted === true) {
        return { canceledSubscriptionIds: [], checkedStripe: true, customerAlreadyDeleted: true };
      }
    }
    throw stripeVerificationError(cause, customerId, "subscription list");
  }
  // Stripe's default listing already excludes canceled subscriptions; filter anyway as a safety net.
  const open = listed.filter((item) => !STRIPE_TERMINAL_SUBSCRIPTION_STATUSES.has(item.status));
  const canceledSubscriptionIds = [];
  for (const item of open) {
    let canceled;
    try {
      canceled = await stripeRequest(
        `/subscriptions/${encodeURIComponent(item.id)}`,
        {},
        { method: "DELETE" }
      );
    } catch (cause) {
      // Includes a subscription that became canceled after it was listed; a retry re-lists and skips it.
      throw subscriptionCancelFailedError(cause);
    }
    if (canceled.status !== "canceled") {
      throw subscriptionCancelFailedError();
    }
    canceledSubscriptionIds.push(item.id);
  }
  return { canceledSubscriptionIds, checkedStripe: true };
}

const STRIPE_SUBSCRIPTION_PAGE_SIZE = 100;
const STRIPE_SUBSCRIPTION_MAX_PAGES = 20;

export async function listCustomerSubscriptions(customerId) {
  const subscriptions = [];
  let startingAfter = null;
  for (let page = 0; page < STRIPE_SUBSCRIPTION_MAX_PAGES; page += 1) {
    const cursor = startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : "";
    const listed = await stripeGet(
      `/subscriptions?customer=${encodeURIComponent(customerId)}&limit=${STRIPE_SUBSCRIPTION_PAGE_SIZE}${cursor}`
    );
    const data = Array.isArray(listed.data) ? listed.data : [];
    subscriptions.push(...data);
    if (!listed.has_more) return subscriptions;
    startingAfter = data.at(-1)?.id;
    if (!startingAfter) {
      // has_more with an empty page: treated as a transient Stripe fault (no stripeStatus set).
      throw new Error("Stripe reported more subscriptions but returned an empty page.");
    }
  }
  const error = new Error("Too many subscriptions to cancel automatically. Please contact support.");
  error.statusCode = 409;
  error.code = "too_many_subscriptions";
  throw error;
}

// Network failures, 429 and 5xx may succeed on retry. A missing customer or a rejected
// key (401/403) won't, nor will any other 4xx, so those send the user to support instead.
function isTransientStripeError(error) {
  const status = error.stripeStatus;
  if (!status) return true;
  if (error.stripeCode === "resource_missing") return false;
  return status === 429 || status >= 500;
}

// Deletes the Stripe customer during account deletion (only; no other flow deletes customers).
// Already deleted (resource_missing) counts as success so a retry after a failed DB step works.
// Anything else fails closed with the same transient/permanent classes as the subscription list.
export async function deleteStripeCustomer(customerId) {
  let deleted;
  try {
    deleted = await stripeRequest(`/customers/${encodeURIComponent(customerId)}`, {}, { method: "DELETE" });
  } catch (cause) {
    if (cause.stripeCode === "resource_missing") return { deleted: true, alreadyDeleted: true };
    throw stripeVerificationError(cause, customerId, "customer delete");
  }
  if (deleted?.deleted !== true) {
    throw stripeVerificationError(new Error("Stripe did not confirm the customer deletion."), customerId, "customer delete");
  }
  return { deleted: true, alreadyDeleted: false };
}

function stripeVerificationError(cause, customerId, step) {
  if (cause.code === "too_many_subscriptions") return cause;
  const transient = isTransientStripeError(cause);
  console.error(
    `[stripe] ${step} failed customer=${customerId} class=${transient ? "transient" : "permanent"} ` +
    `http=${cause.stripeStatus ?? "none"} code=${cause.stripeCode ?? "none"} type=${cause.stripeType ?? "none"} ` +
    `request_id=${cause.stripeRequestId ?? "none"} message=${cause.message}`
  );
  const error = new Error(transient
    ? "We couldn't verify your subscription, so your account was not deleted. Please try again."
    : "We couldn't verify your subscription, so your account was not deleted. Please contact support to delete your account.");
  error.statusCode = transient ? 503 : 502;
  error.code = transient ? "subscription_check_unavailable" : "subscription_check_failed";
  error.cause = cause;
  return error;
}

function subscriptionCancelFailedError(cause) {
  const error = new Error(
    "We couldn't confirm your subscription was cancelled, so your account was not deleted. " +
    "Please try again, and contact support if this keeps happening."
  );
  error.statusCode = 502;
  error.code = "subscription_cancel_failed";
  if (cause) error.cause = cause;
  return error;
}

async function stripeRequest(path, params, { method = "POST", headers = {} } = {}) {
  const response = await fetch(`${stripeApiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${appConfig.stripe.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined)
    )
  });
  return readStripeResponse(response);
}

// Errors carry Stripe's HTTP status, error code/type and request id so callers can classify them.
async function readStripeResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (parseError) {
    if (response.ok) throw parseError;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Stripe request failed with HTTP ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : 400;
    error.stripeStatus = response.status;
    error.stripeCode = payload?.error?.code;
    error.stripeType = payload?.error?.type;
    error.stripeRequestId = response.headers?.get?.("request-id") || undefined;
    throw error;
  }
  return payload;
}

async function stripeGet(path) {
  const response = await fetch(`${stripeApiBase}${path}`, {
    headers: {
      authorization: `Bearer ${appConfig.stripe.secretKey}`
    }
  });
  return readStripeResponse(response);
}

function assertStripeCheckoutConfigured(user) {
  if (!appConfig.stripe.secretKey) {
    throw missingStripeConfiguration("STRIPE_SECRET_KEY", user);
  }
}

function assertStripeRedirectsConfigured(user) {
  if (!appConfig.stripe.appUrl) {
    throw missingStripeConfiguration("APP_URL", user);
  }
}

function missingStripeConfiguration(key, user = null) {
  console.warn(`[stripe] Missing configuration key: ${key}`);
  const canSeeKey = !appConfig.isProduction ||
    appConfig.adminEmails.has(String(user?.email || "").toLowerCase());
  const error = new Error(canSeeKey
    ? `Stripe billing is not configured: missing ${key}.`
    : "Stripe billing is not configured.");
  error.statusCode = 503;
  error.missingConfigurationKey = key;
  return error;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function retryableWebhookError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  return error;
}

function fromUnix(value) {
  return value ? new Date(Number(value) * 1000) : null;
}

function getInvoiceSubscriptionId(invoice) {
  return stripeId(
    invoice.subscription ||
    invoice.parent?.subscription_details?.subscription
  );
}

function getInvoicePriceId(invoice) {
  const line = invoice.lines?.data?.find((item) =>
    item.price?.id || item.pricing?.price_details?.price
  );
  return stripeId(line?.price) || stripeId(line?.pricing?.price_details?.price);
}

function getInvoicePeriod(invoice, priceId) {
  const line = invoice.lines?.data?.find((item) => {
    const itemPrice = stripeId(item.price) || stripeId(item.pricing?.price_details?.price);
    return !priceId || itemPrice === priceId;
  });
  return line?.period || {};
}

function getSubscriptionPeriod(subscription) {
  const item = subscription?.items?.data?.[0];
  return {
    start: subscription?.current_period_start || item?.current_period_start,
    end: subscription?.current_period_end || item?.current_period_end
  };
}

function stripeId(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

function sanitizeStripeError(error) {
  return String(error?.message || "Stripe webhook processing failed.")
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b/g, "[redacted-key]")
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, "[redacted-webhook-secret]")
    .slice(0, 500);
}

function safeLogValue(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
}
