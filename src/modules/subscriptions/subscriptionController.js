import { sendError, sendJson } from "../../shared/http.js";
import { getSubscriptionSummary } from "./subscriptionService.js";

export async function handleSubscriptionRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/subscriptions")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/subscriptions/me" && req.method === "GET") {
    return sendJson(res, 200, { subscription: getSubscriptionSummary(req.user) });
  }

  if (pathname === "/api/subscriptions/checkout" && req.method === "POST") {
    return sendJson(res, 200, {
      checkout: {
        mode: "subscription",
        status: "placeholder",
        message: "Stripe checkout endpoint is ready for integration."
      }
    });
  }

  return false;
}
