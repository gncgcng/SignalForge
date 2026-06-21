import { createHmac, timingSafeEqual } from "node:crypto";
import { appConfig, getStripeMode } from "../../config/appConfig.js";
import {
  findUserById,
  findUserByStripeCustomer,
  grantUnlockCredits,
  hasStripeWebhookEvent,
  recordStripeWebhookEvent,
  updateStripeCustomer,
  updateStripeSubscription
} from "../../db/repositories.js";
import { BILLING_PLANS, CREDIT_PACKS, normalizePlan } from "./subscriptionService.js";

const stripeApiBase = "https://api.stripe.com/v1";

export async function createCheckout(user, { plan, pack }) {
  assertStripeCheckoutConfigured(user);
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
  if (await hasStripeWebhookEvent(event.id)) {
    return { duplicate: true };
  }

  const object = event.data?.object || {};
  if (event.type === "checkout.session.completed") {
    await processCheckoutCompleted(object);
  } else if (event.type === "invoice.paid") {
    await processInvoicePaid(object);
  } else if (event.type.startsWith("customer.subscription.")) {
    await processSubscriptionChanged(object, event.type);
  }

  await recordStripeWebhookEvent(event.id, event.type);
  return { duplicate: false };
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
    await updateStripeCustomer(userId, session.customer, getStripeMode());
  }
  if (session.metadata?.kind === "credit_pack") {
    const quantity = CREDIT_PACKS[session.metadata.pack]?.quantity || 0;
    if (quantity > 0) {
      await grantUnlockCredits(userId, quantity, `checkout:${session.id}`, "credit_pack");
    }
  }
}

async function processInvoicePaid(invoice) {
  const user = await findUserByStripeCustomer(invoice.customer, getStripeMode());
  if (!user) return;
  const priceId = invoice.lines?.data?.[0]?.price?.id;
  const planId = planFromPrice(priceId);
  const plan = BILLING_PLANS[planId];
  if (!plan || plan.monthlyUnlockGrant <= 0) return;

  const periodStart = invoice.lines?.data?.find((line) => line.price?.id === priceId)
    ?.period?.start;
  const grantReference = invoice.subscription && periodStart
    ? `subscription:${invoice.subscription}:${planId}:${periodStart}`
    : `invoice:${invoice.id}`;
  await grantUnlockCredits(
    user.id,
    plan.monthlyUnlockGrant,
    grantReference,
    "subscription_renewal"
  );
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

  await updateStripeSubscription({
    userId: user.id,
    customerId: subscription.customer,
    subscriptionId: eventType.endsWith(".deleted") ? null : subscription.id,
    status: eventType.endsWith(".deleted") ? "canceled" : subscription.status,
    plan: normalizePlan(plan),
    priceId: active ? priceId : null,
    periodStart: fromUnix(subscription.current_period_start),
    periodEnd: fromUnix(subscription.current_period_end),
    stripeMode: getStripeMode(),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
  });
}

function planFromPrice(priceId) {
  if (priceId === appConfig.stripe.prices.elite) return "elite";
  if (priceId === appConfig.stripe.prices.pro) return "pro";
  return "free";
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

function assertStripeCheckoutConfigured(user) {
  if (!appConfig.stripe.secretKey) {
    throw missingStripeConfiguration("STRIPE_SECRET_KEY", user);
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
