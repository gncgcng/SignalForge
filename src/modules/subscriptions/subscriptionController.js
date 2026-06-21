import { readBody, readJson, sendError, sendJson } from "../../shared/http.js";
import { getSubscriptionSummary } from "./subscriptionService.js";
import {
  createCheckout,
  createCustomerPortal,
  processStripeEvent,
  verifyStripeSignature
} from "./stripeService.js";

export async function handleSubscriptionRoutes(req, res, pathname) {
  if (pathname === "/api/subscriptions/webhook" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const event = verifyStripeSignature(rawBody, req.headers["stripe-signature"]);
      return sendJson(res, 200, {
        received: true,
        ...(await processStripeEvent(event))
      });
    } catch (error) {
      console.error(
        `[stripe] Webhook request failed status=${Number(error.statusCode || 400)}`
      );
      const statusCode = error.statusCode || 400;
      return sendError(
        res,
        statusCode,
        statusCode >= 500
          ? "Stripe webhook processing failed."
          : "Stripe webhook rejected."
      );
    }
  }

  if (!pathname.startsWith("/api/subscriptions")) {
    return false;
  }
  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (pathname === "/api/subscriptions/me" && req.method === "GET") {
      return sendJson(res, 200, { subscription: getSubscriptionSummary(req.user) });
    }
    if (pathname === "/api/subscriptions/checkout" && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, {
        checkout: await createCheckout(req.user, body)
      });
    }
    if (pathname === "/api/subscriptions/portal" && req.method === "POST") {
      return sendJson(res, 200, {
        portal: await createCustomerPortal(req.user)
      });
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}
