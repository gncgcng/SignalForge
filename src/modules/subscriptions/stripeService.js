import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig, getStripeMode } from "../../config/appConfig.js";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  findUserById,
  findUserByStripeCustomer,
  getRetryableStripeWebhookEvent,
  claimTrialIdentities,
  isTrialIdentityClaimed,
  listStripeWebhookEvents,
  updateStripeCustomer,
  updateStripeSubscription
} from "../../db/repositories.js";
import {
  deactivateAffiliateReferral,
  reconcileAffiliateRefund,
  recordRecurringAffiliateCommission
} from "../affiliates/affiliateRepository.js";
import { trackProductEvent } from "../analytics/productAnalyticsService.js";
import { trialIdentities } from "../auth/trialIdentity.js";
import {
  sendAffiliateCommissionEmail,
  sendFailedPaymentEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionConfirmationEmail,
  sendTrialCardAlreadyUsedEmail,
  sendTrialEndingEmail,
  sendTrialStartedEmail
} from "../notifications/transactionalEmailService.js";
import {
  PAID_ACCESS_STATUSES,
  PLAN,
  amountCentsForInterval,
  hasPaidAccess,
  intervalForPrice,
  priceIdForInterval
} from "./subscriptionService.js";
import {
  claimTrialCard,
  hasPaidInvoice,
  listGoogleSubjects,
  recordBillingAnomaly,
  recordInvoiceRefund,
  recordPaidInvoice
} from "./billingRepository.js";

const stripeApiBase = "https://api.stripe.com/v1";

// ---- Checkout: one plan, monthly or annual, with a 7-day card-required trial ----

export async function createCheckout(user, { interval } = {}) {
  assertCheckoutEnabled();
  assertStripeCheckoutConfigured(user);
  assertStripeRedirectsConfigured(user);
  const billingInterval = interval === "year" || interval === "annual" ? "year" : interval === "month" || interval === "monthly" ? "month" : null;
  if (!billingInterval) {
    throw validationError("Choose monthly or annual billing.");
  }
  const priceId = priceIdForInterval(billingInterval);
  if (!priceId) {
    throw missingStripeConfiguration(appConfig.stripe.priceEnvironmentKeys[PLAN.intervals[billingInterval].priceKey], user);
  }
  // Already subscribed (trial, active or past due): manage it in the Customer Portal instead of a second checkout.
  if (hasPaidAccess(user) && user.subscription?.providerSubscriptionId && user.subscription?.stripeMode === getStripeMode()) {
    return { ...(await createCustomerPortal(user)), mode: "portal" };
  }

  const eligibility = await getTrialEligibility(user);
  const customerId = await ensureStripeCustomer(user);
  const session = await stripeRequest("/checkout/sessions", buildCheckoutSessionParams({
    user,
    customerId,
    priceId,
    interval: billingInterval,
    trial: eligibility.eligible
  }));
  await trackProductEvent({
    eventType: "checkout_started",
    userId: user.id,
    plan: PLAN.id,
    amountCents: amountCentsForInterval(billingInterval),
    metadata: { kind: "subscription", interval: billingInterval, trial: eligibility.eligible }
  });

  return { url: session.url, id: session.id, mode: "subscription", trial: eligibility.eligible };
}

// The Checkout Session payload. Promotion codes are never offered. The card is always collected, even for the
// trial, and the trial (7 days) is left out for an account that has already had one.
export function buildCheckoutSessionParams({ user, customerId, priceId, interval, trial }) {
  return {
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    payment_method_collection: "always",
    success_url: appConfig.stripe.successUrl,
    cancel_url: appConfig.stripe.cancelUrl,
    "metadata[user_id]": user.id,
    "metadata[kind]": "subscription",
    "metadata[plan]": PLAN.id,
    "metadata[interval]": interval,
    "subscription_data[metadata][user_id]": user.id,
    "subscription_data[metadata][plan]": PLAN.id,
    ...(trial ? {
      "subscription_data[trial_period_days]": String(PLAN.trialDays),
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel"
    } : {})
  };
}

// No trial for an account that has had any subscription before, or whose email / Google account already had a
// free trial (trial_identity_claims, kept after account deletion). The card rule is checked later, in the webhook,
// because the card isn't known until it is entered.
export async function getTrialEligibility(user) {
  if (user?.subscription?.firstSubscribedAt || user?.subscription?.providerSubscriptionId) {
    return { eligible: false, reason: "previous_subscription" };
  }
  const identities = trialIdentities({ email: user?.email, googleSubjects: await listGoogleSubjects(user.id) });
  if (await isTrialIdentityClaimed(identities)) {
    return { eligible: false, reason: "trial_used" };
  }
  return { eligible: true, reason: null };
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
      result = await processCheckoutCompleted(object, event.id);
    } else if (
      event.type === "invoice.payment_succeeded" ||
      event.type === "invoice.paid"
    ) {
      result = await processInvoicePaid(object, event.id);
    } else if (event.type === "invoice.payment_failed") {
      result = await processInvoicePaymentFailed(object, event.id);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      result = await processSubscriptionChanged(object, event.type, { eventId: event.id });
    } else if (event.type === "customer.subscription.trial_will_end") {
      result = await processTrialWillEnd(object, event.id);
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
    return { duplicate: false, ...(result || {}), action: result?.action || "ignored" };
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

async function processCheckoutCompleted(session, stripeEventId) {
  const customerId = stripeId(session.customer);
  const userId = session.client_reference_id || session.metadata?.user_id ||
    (await findUserByStripeCustomer(customerId, getStripeMode()))?.id;
  if (session.mode !== "subscription" && session.metadata?.kind !== "subscription") {
    // Old credit-pack sessions: credit packs are retired, nothing is granted.
    return { action: "checkout_ignored", userId: userId || null };
  }
  if (!userId) throw retryableWebhookError("Unable to resolve the checkout user.");
  if (isDeletedAccount(await findUserById(userId))) return deletedAccountResult();

  if (customerId) {
    await updateStripeCustomer(userId, customerId, getStripeMode());
  }
  await trackProductEvent({
    eventType: "checkout_completed",
    userId,
    plan: PLAN.id,
    amountCents: Number(session.amount_total || 0),
    metadata: { kind: "subscription" }
  });

  const subscriptionId = stripeId(session.subscription);
  if (!subscriptionId) throw retryableWebhookError("Checkout subscription is missing.");
  // Never assume "active": the subscription's own status (usually "trialing") is read from Stripe and stored.
  const subscription = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const synced = await processSubscriptionChanged(subscription, "checkout.session.completed", { userId, eventId: stripeEventId });
  return { ...synced, action: `checkout_${synced.action}` };
}

async function resolveSubscriptionUser(subscription, eventType, { userId = null } = {}) {
  const metadataUserId = userId || subscription.metadata?.user_id || null;
  const customerId = stripeId(subscription.customer);
  const user = metadataUserId
    ? await findUserById(metadataUserId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (user) return { user };
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
    return { result: { action: "subscription_deleted_unknown_customer", userId: null } };
  }
  throw retryableWebhookError("Unable to resolve the subscription user.");
}

// customer.subscription.created / updated / deleted, and the subscription read after checkout or an invoice.
// Stores Stripe's own status; paid access follows from it (hasPaidAccess). A price that isn't ours grants nothing.
async function processSubscriptionChanged(subscription, eventType, { userId = null, eventId = null } = {}) {
  const resolved = await resolveSubscriptionUser(subscription, eventType, { userId });
  if (resolved.result) return resolved.result;
  const { user } = resolved;
  if (isDeletedAccount(user)) return deletedAccountResult();

  const deleted = eventType === "customer.subscription.deleted";
  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const interval = intervalForPrice(priceId);
  if (!interval && !deleted) {
    await flagUnknownPrice(priceId, { eventId, eventType, userId: user.id, subscriptionId: subscription.id });
    return { action: "unknown_price_ignored", userId: user.id, priceId };
  }

  const status = deleted ? "canceled" : String(subscription.status || "incomplete");
  const paid = !deleted && PAID_ACCESS_STATUSES.includes(status);
  const period = getSubscriptionPeriod(subscription);
  const update = await updateStripeSubscription({
    userId: user.id,
    customerId: stripeId(subscription.customer),
    subscriptionId: deleted ? null : subscription.id,
    status,
    plan: paid ? PLAN.id : "free",
    priceId: deleted ? null : priceId,
    periodStart: fromUnix(period.start),
    periodEnd: fromUnix(period.end),
    stripeMode: getStripeMode(),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    trialEnd: fromUnix(subscription.trial_end),
    billingInterval: interval
  });
  if (!update) return deletedAccountResult();
  const previous = update.previous || {};
  const result = { action: deleted ? "subscription_ended" : "subscription_synced", userId: user.id, status };

  if (eventType === "customer.subscription.created" && status === "trialing") {
    result.trial = await startTrial(user, subscription, interval);
  }
  // Cancellation requested (in the Customer Portal): access continues to the period end.
  if (!deleted && subscription.cancel_at_period_end && !previous.cancelAtPeriodEnd) {
    sendSubscriptionCanceledEmail(user, { accessUntil: fromUnix(period.end) || fromUnix(subscription.trial_end) });
    result.cancellationEmail = true;
  }
  if (deleted) {
    await deactivateAffiliateReferral(user.id);
    // A trial that ended without ever being paid for counts as a cancelled trial.
    if (subscription.trial_end && !(await hasPaidInvoice(subscription.id))) {
      await trackProductEvent({ eventType: "trial_canceled", userId: user.id, plan: PLAN.id, metadata: { subscriptionId: subscription.id } });
      result.trialCanceled = true;
    }
  }
  return result;
}

// A new trial: one per card. The card's fingerprint is only known now, after checkout. If another account already
// used this card for a trial, the trial ends now (the first charge happens immediately) and the user is told why.
async function startTrial(user, subscription, interval) {
  const amountCents = amountCentsForInterval(interval);
  const fingerprint = await readSubscriptionCardFingerprint(subscription);
  if (!fingerprint) {
    await recordBillingAnomaly({
      kind: "trial_card_fingerprint_missing",
      reference: subscription.id,
      detail: { userId: user.id }
    });
  } else {
    const hash = cardFingerprintHash(fingerprint);
    if (hash) {
      const claim = await claimTrialCard(hash, user.id);
      if (!claim.claimed) {
        await stripeRequest(`/subscriptions/${encodeURIComponent(subscription.id)}`, { trial_end: "now" });
        sendTrialCardAlreadyUsedEmail(user, { amountCents, interval });
        await recordBillingAnomaly({
          kind: "trial_card_reused",
          reference: subscription.id,
          detail: { userId: user.id }
        });
        return { ended: true, reason: "card_already_used" };
      }
    }
  }
  await claimTrialIdentities(trialIdentities({ email: user.email, googleSubjects: await listGoogleSubjects(user.id) }));
  await trackProductEvent({ eventType: "trial_started", userId: user.id, plan: PLAN.id, metadata: { interval } });
  sendTrialStartedEmail(user, { firstChargeDate: fromUnix(subscription.trial_end), amountCents, interval });
  return { ended: false };
}

async function readSubscriptionCardFingerprint(subscription) {
  let paymentMethod = subscription.default_payment_method;
  if (!paymentMethod) {
    const customerId = stripeId(subscription.customer);
    if (customerId) {
      const customer = await stripeGet(`/customers/${encodeURIComponent(customerId)}`);
      paymentMethod = customer?.invoice_settings?.default_payment_method || null;
    }
  }
  if (!paymentMethod) return null;
  if (typeof paymentMethod === "string") {
    paymentMethod = await stripeGet(`/payment_methods/${encodeURIComponent(paymentMethod)}`);
  }
  return paymentMethod?.card?.fingerprint || null;
}

// Same secret and HMAC as trial_identity_claims; Stripe's fingerprint itself is never stored.
export function cardFingerprintHash(fingerprint) {
  const secret = appConfig.trialIdentitySecret;
  if (!secret) {
    console.error("[trial] TRIAL_IDENTITY_SECRET is not set; skipping the one-trial-per-card check.");
    return null;
  }
  if (!fingerprint) return null;
  return createHmac("sha256", secret).update(`card:${fingerprint}`).digest("hex");
}

// 3 days before the trial ends: when the first charge happens, how much, and how to cancel.
async function processTrialWillEnd(subscription, eventId) {
  const resolved = await resolveSubscriptionUser(subscription, "customer.subscription.trial_will_end");
  if (resolved.result) return resolved.result;
  const { user } = resolved;
  if (isDeletedAccount(user)) return deletedAccountResult();
  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const interval = intervalForPrice(priceId);
  if (!interval) {
    await flagUnknownPrice(priceId, { eventId, eventType: "customer.subscription.trial_will_end", userId: user.id });
    return { action: "unknown_price_ignored", userId: user.id, priceId };
  }
  if (subscription.cancel_at_period_end || subscription.status !== "trialing") {
    return { action: "trial_ending_not_charged", userId: user.id };
  }
  sendTrialEndingEmail(user, {
    firstChargeDate: fromUnix(subscription.trial_end),
    amountCents: amountCentsForInterval(interval),
    interval
  });
  return { action: "trial_ending_notified", userId: user.id };
}

// invoice.paid (and the older invoice.payment_succeeded for the same invoice). Only an invoice that charged money
// counts: the $0 trial invoice grants nothing, sends nothing and pays no commission.
async function processInvoicePaid(invoice, stripeEventId) {
  const amountPaid = Number(invoice.amount_paid || 0);
  if (amountPaid <= 0) {
    return { action: "zero_amount_invoice_ignored", userId: null };
  }
  const customerId = stripeId(invoice.customer);
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  const subscription = subscriptionId
    ? await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
    : null;
  const userId = subscription?.metadata?.user_id || invoice.metadata?.user_id;
  const user = userId
    ? await findUserById(userId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (!user) throw retryableWebhookError("Unable to resolve the invoice user.");
  if (isDeletedAccount(user)) return deletedAccountResult();

  const priceId = getInvoicePriceId(invoice) || subscription?.items?.data?.[0]?.price?.id || null;
  const interval = intervalForPrice(priceId);
  if (!interval) {
    await flagUnknownPrice(priceId, { eventId: stripeEventId, eventType: "invoice.paid", userId: user.id, invoiceId: invoice.id });
    return { action: "unknown_price_ignored", userId: user.id, priceId };
  }

  const recorded = await recordPaidInvoice({
    invoiceId: invoice.id,
    userId: user.id,
    subscriptionId,
    chargeId: stripeId(invoice.charge) || stripeId(invoice.payments?.data?.[0]?.payment?.charge),
    amountPaidCents: amountPaid,
    currency: invoice.currency,
    interval,
    livemode: invoice.livemode,
    paidAt: fromUnix(invoice.status_transitions?.paid_at)
  });
  if (!recorded.inserted) {
    return { action: "invoice_already_recorded", userId: user.id };
  }
  if (subscription) {
    await processSubscriptionChanged(subscription, "invoice.paid", { userId: user.id, eventId: stripeEventId });
  }
  if (recorded.firstPaidInvoice && subscription?.trial_end) {
    await trackProductEvent({ eventType: "trial_converted", userId: user.id, plan: PLAN.id, amountCents: amountPaid, metadata: { interval } });
  }
  const period = getInvoicePeriod(invoice, priceId);
  const commission = await recordRecurringAffiliateCommission({
    referredUserId: user.id,
    plan: PLAN.id,
    grossAmountCents: amountPaid,
    stripeInvoiceId: invoice.id,
    stripeEventId,
    periodStart: fromUnix(period.start)
  });
  await trackProductEvent({
    eventType: "subscription",
    userId: user.id,
    plan: PLAN.id,
    amountCents: amountPaid,
    metadata: { source: "invoice", interval }
  });
  // One confirmation per subscription, on its first real charge; Stripe's own receipts cover every charge.
  if (recorded.firstPaidInvoice) {
    sendSubscriptionConfirmationEmail(user, {
      amountCents: amountPaid,
      interval,
      nextChargeDate: fromUnix(period.end) || fromUnix(getSubscriptionPeriod(subscription).end)
    });
  }
  if (commission && recorded.firstPaidInvoice) {
    await trackProductEvent({ eventType: "affiliate_conversion", userId: user.id, plan: PLAN.id, metadata: { source: "first_paid_invoice" } });
  }
  if (commission?.affiliateUser?.email) {
    sendAffiliateCommissionEmail(commission.affiliateUser, {
      plan: PLAN.id,
      commissionCents: commission.commission_amount_cents
    });
  }
  return {
    action: "subscription_payment_recorded",
    userId: user.id,
    amountCents: amountPaid,
    affiliateCommissionCreated: Boolean(commission)
  };
}

async function processInvoicePaymentFailed(invoice, stripeEventId) {
  const customerId = stripeId(invoice.customer);
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  const subscription = subscriptionId
    ? await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
    : null;
  const userId = subscription?.metadata?.user_id || invoice.metadata?.user_id;
  const user = userId
    ? await findUserById(userId)
    : await findUserByStripeCustomer(customerId, getStripeMode());
  if (!user) throw retryableWebhookError("Unable to resolve the failed invoice user.");
  if (isDeletedAccount(user)) return deletedAccountResult();

  // Usually past_due now: access continues and the app shows "Payment failed — update your card".
  if (subscription) {
    await processSubscriptionChanged(subscription, "invoice.payment_failed", { userId: user.id, eventId: stripeEventId });
  }
  sendFailedPaymentEmail(user);
  return { action: "failed_payment_notified", userId: user.id, status: subscription?.status || null };
}

// A refund: record it against the invoice (revenue drops by the refunded amount) and reverse the affiliate
// commission in proportion.
async function processChargeRefunded(charge) {
  const invoiceId = stripeId(charge.invoice);
  const refundedCents = Number(charge.amount_refunded || 0);
  const invoice = await recordInvoiceRefund({ invoiceId, chargeId: charge.id || null, amountRefundedCents: refundedCents });
  const reversal = await reconcileAffiliateRefund(invoice?.stripe_invoice_id || invoiceId, refundedCents);
  if (invoice) {
    await trackProductEvent({
      eventType: "refund",
      userId: invoice.user_id || null,
      plan: PLAN.id,
      amountCents: refundedCents,
      metadata: { invoiceId: invoice.stripe_invoice_id }
    });
  }
  if (!invoice && !reversal) return { action: "refund_ignored", userId: null };
  return {
    action: "refund_recorded",
    userId: invoice?.user_id || null,
    refundedCents,
    affiliateCommissionReversed: Boolean(reversal)
  };
}

// Unknown price ids are logged once at warn level, grant nothing, and show on the admin billing-anomalies card.
// The webhook still answers 200 so Stripe doesn't retry forever.
async function flagUnknownPrice(priceId, detail = {}) {
  const { firstTime } = await recordBillingAnomaly({
    kind: "unknown_price",
    reference: priceId || "none",
    stripeEventId: detail.eventId || null,
    detail
  });
  if (firstTime) {
    console.warn(`[stripe] Unknown price ${safeLogValue(priceId)} on ${safeLogValue(detail.eventType)}; nothing granted.`);
  }
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

// Checked before anything touches Stripe, so a paused checkout makes no API call at all.
function assertCheckoutEnabled() {
  if (appConfig.stripe.checkoutEnabled) return;
  const error = new Error("New purchases are paused while a new plan is prepared. Everything in your account stays free until then.");
  error.statusCode = 403;
  error.code = "checkout_paused";
  throw error;
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
