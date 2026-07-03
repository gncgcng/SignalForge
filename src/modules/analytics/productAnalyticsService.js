import { recordProductAnalyticsEvent } from "../../db/repositories.js";

export async function trackProductEvent(event) {
  try {
    await recordProductAnalyticsEvent(event);
  } catch (error) {
    console.warn(
      `[analytics] Event write failed type=${safeValue(event?.eventType)} ` +
      `reason=${safeValue(error.message)}`
    );
  }
}

function safeValue(value) {
  return String(value || "unknown").replace(/[^a-z0-9_ .:-]/gi, "").slice(0, 120);
}
