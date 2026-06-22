import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig, getStripeMode } from "../../config/appConfig.js";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  findUserById,
  findUserByStripeCustomer,
  grantSubscriptionEntitlements,
  grantUnlockCredits,
  updateStripeCustomer,
  updateStripeSubscription
} from "../../db/repositories.js";
import {
  deactivateAffiliateReferral,
  reconcileAffiliateRefund,
  recordRecurringAffiliateCommission
} from "../affiliates/affiliateRepository.js";
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
  if (!await claimStripeWebhookEvent(event.id, event.type)) {
    return { duplicate: true };
  }

  try {
    const object = event.data?.object || {};
    if (event.type === "checkout.session.completed") {
      await processCheckoutCompleted(object);
    } else if (
      event.type === "invoice.payment_succeeded" ||
      event.type === "invoice.paid"
    ) {
      await processInvoicePaymentSucceeded(object, event.id);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await processSubscriptionChanged(object, event.type);
    } else if (event.type === "charge.refunded") {
      await processChargeRefunded(object);
    }

    await completeStripeWebhookEvent(event.id);
    return { duplicate: false };
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
  const userId = session.metadata?.user_id;
  if (!userId) return;

  if (session.customer) {
    await updateStripeCustomer(userId, stripeId(session.customer), getStripeMode());
  }
  if (session.metadata?.kind === "credit_pack") {
    const quantity = CREDIT_PACKS[session.metadata.pack]?.quantity || 0;
    if (quantity > 0) {
      await grantUnlockCredits(userId, quantity, `checkout:${session.id}`, "credit_pack");
    }
    return;
  }

  const subscriptionId = stripeId(session.subscription);
  if (session.metadata?.kind === "subscription" && subscriptionId) {
    const subscription = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    await processSubscriptionChanged(subscription, "customer.subscription.created");
  }
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
  if (!user) return;

  const priceId = getInvoicePriceId(invoice) ||
    subscription?.items?.data?.[0]?.price?.id;
  const planId = planFromPrice(priceId);
  const plan = BILLING_PLANS[planId];
  if (!plan || plan.monthlyUnlockGrant <= 0) return;

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
  await recordRecurringAffiliateCommission({
    referredUserId: user.id,
    plan: planId,
    grossAmountCents: Number(invoice.amount_paid || 0),
    stripeInvoiceId: invoice.id,
    stripeEventId,
    periodStart: fromUnix(periodStart)
  });
}

async function processSubscriptionChanged(subscription, eventType) {
  const user = subscription.metadata?.user_id
    ? await findUserById(subscription.metadata.user_id)
    : await findUserByStripeCustomer(subscription.customer, getStripeMode());
  if (!user) return;

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
}

async function processChargeRefunded(charge) {
  const invoiceId = stripeId(charge.invoice);
  if (!invoiceId) return;
  await reconcileAffiliateRefund(invoiceId, Number(charge.amount_refunded || 0));
}

function planFromPrice(priceId) {
  if (priceId === appConfig.stripe.prices.elite) return "elite";
  if (priceId === appConfig.stripe.prices.pro) return "pro";
  return "free";
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
