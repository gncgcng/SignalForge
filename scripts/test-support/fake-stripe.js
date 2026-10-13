// An in-memory stand-in for the Stripe API (and Resend's email endpoint) for billing tests. It replaces
// globalThis.fetch, records every call, and serves subscriptions, customers and payment methods from maps the test
// fills in. Nothing leaves the machine.
export function installFakeStripe() {
  const state = {
    calls: [],
    emails: [],
    subscriptions: new Map(),
    customers: new Map(),
    paymentMethods: new Map(),
    nextId: 1
  };
  const realFetch = globalThis.fetch;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    if (url.hostname === "api.resend.com") {
      const body = JSON.parse(init.body || "{}");
      state.emails.push({ to: body.to?.[0], subject: body.subject, text: body.text });
      return json(200, { id: `email_${state.nextId++}` });
    }
    if (url.hostname !== "api.stripe.com") throw new Error(`fake-stripe: unexpected fetch ${url.href}`);
    const params = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    const path = url.pathname.replace(/^\/v1/, "");
    state.calls.push({ method, path, params, query: Object.fromEntries(url.searchParams) });

    if (method === "POST" && path === "/customers") {
      const id = `cus_fake_${state.nextId++}`;
      state.customers.set(id, { id, invoice_settings: { default_payment_method: null } });
      return json(200, { id });
    }
    if (method === "POST" && path === "/checkout/sessions") {
      const id = `cs_fake_${state.nextId++}`;
      return json(200, { id, url: `https://checkout.stripe.test/${id}` });
    }
    if (method === "POST" && path === "/billing_portal/sessions") {
      return json(200, { id: `bps_${state.nextId++}`, url: "https://billing.stripe.test/portal" });
    }
    let match = path.match(/^\/subscriptions\/([^/]+)$/);
    if (match && method === "GET") {
      const subscription = state.subscriptions.get(match[1]);
      return subscription ? json(200, subscription) : json(404, { error: { code: "resource_missing", message: "No such subscription" } });
    }
    if (match && method === "POST") {
      const subscription = state.subscriptions.get(match[1]);
      if (!subscription) return json(404, { error: { code: "resource_missing", message: "No such subscription" } });
      if (params.trial_end === "now") {
        subscription.status = "active";
        subscription.trial_end = Math.floor(Date.now() / 1000);
      }
      return json(200, subscription);
    }
    match = path.match(/^\/customers\/([^/]+)$/);
    if (match && method === "GET") {
      return json(200, state.customers.get(match[1]) || { id: match[1], invoice_settings: { default_payment_method: null } });
    }
    match = path.match(/^\/payment_methods\/([^/]+)$/);
    if (match && method === "GET") {
      const paymentMethod = state.paymentMethods.get(match[1]);
      return paymentMethod ? json(200, paymentMethod) : json(404, { error: { code: "resource_missing", message: "No such payment method" } });
    }
    return json(400, { error: { message: `fake-stripe: unhandled ${method} ${path}` } });
  };

  return {
    state,
    restore() { globalThis.fetch = realFetch; },
    callsTo(method, pathPattern) {
      return state.calls.filter((call) => call.method === method && (pathPattern instanceof RegExp ? pathPattern.test(call.path) : call.path === pathPattern));
    },
    addCard(paymentMethodId, fingerprint) {
      state.paymentMethods.set(paymentMethodId, { id: paymentMethodId, type: "card", card: { brand: "visa", last4: "4242", fingerprint } });
    },
    // A subscription as Stripe would return it (2024-09 API shape: period on the subscription and on the item).
    addSubscription({ id, customer, userId, priceId, status = "trialing", trialDays = 7, paymentMethod = null, cancelAtPeriodEnd = false }) {
      const now = Math.floor(Date.now() / 1000);
      const trialEnd = status === "trialing" ? now + trialDays * 86400 : null;
      const periodEnd = trialEnd || now + 30 * 86400;
      const subscription = {
        id,
        object: "subscription",
        customer,
        status,
        cancel_at_period_end: cancelAtPeriodEnd,
        trial_end: trialEnd,
        current_period_start: now,
        current_period_end: periodEnd,
        default_payment_method: paymentMethod,
        metadata: { user_id: userId, plan: "signalforge" },
        items: { data: [{ price: { id: priceId }, current_period_start: now, current_period_end: periodEnd }] }
      };
      state.subscriptions.set(id, subscription);
      return subscription;
    }
  };
}

// Lets fire-and-forget email sends finish before a test looks at state.emails.
export async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
