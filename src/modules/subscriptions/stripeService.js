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
import { BILLING_PLANS, CREDIT_PACKS, normalizePlan } from "./subscriptionService.js";

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

  if (customerId) {
    await updateStripeCustomer(userId, customerId, getStripeMode());
  }
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
  await updateStripeSubscription({
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
  return {
    action: "subscription_payment_applied",
    userId: user.id,
    plan: planId,
    affiliateCommissionCreated: Boolean(commission)
  };
}

async function processSubscriptionChanged(subscription, eventType) {
  const user = subscription.metadata?.user_id
    ? await findUserById(subscription.metadata.user_id)
    : await findUserByStripeCustomer(stripeId(subscription.customer), getStripeMode());
  if (!user) throw retryableWebhookError("Unable to resolve the subscription user.");

  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const active = !eventType.endsWith(".deleted") &&
    ["active", "trialing", "past_due"].includes(subscription.status);
  const plan = active ? planFromPrice(priceId) : "free";
  const period = getSubscriptionPeriod(subscription);

  await updateStripeSubscription({
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
  if (!active) {
    await deactivateAffiliateReferral(user.id);
  }
  return {
    action: active ? "subscription_synced" : "subscription_cancelled",
    userId: user.id,
    plan: normalizePlan(plan)
  };
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

async function stripeRequest(path, params) {
  const response = await fetch(`${stripeApiBase}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${appConfig.stripe.secretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined)
    )
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Stripe request failed.");
    error.statusCode = response.status >= 500 ? 502 : 400;
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
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Stripe request failed.");
    error.statusCode = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return payload;
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
