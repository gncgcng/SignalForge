import { getEconomicCalendarContext } from "./economicCalendarService.js";
import { getTradingSession } from "./sessionIntelligenceService.js";

export async function getMarketIntelligence(at = new Date()) {
  const session = getTradingSession(at);

  try {
    const calendar = await getEconomicCalendarContext(at);
    return { session, calendar };
  } catch (error) {
    return {
      session,
      calendar: {
        configured: true,
        provider: "Trading Economics",
        error: error.message,
        upcomingEvents: [],
        newsRisk: {
          level: "Unknown",
          badge: "Calendar Unavailable",
          blockSignal: false,
          confidenceAdjustment: 0,
          explanation: error.message,
          event: null
        }
      }
    };
  }
}
