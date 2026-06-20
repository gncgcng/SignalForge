export const tradingSessions = ["Asia", "London", "New York", "London/New York Overlap", "Low Liquidity"];

export function getTradingSession(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const hour = date.getUTCHours();
  let name = "Low Liquidity";
  let liquidity = "Low";
  let confidenceAdjustment = -6;

  if (hour >= 13 && hour < 16) {
    name = "London/New York Overlap";
    liquidity = "Highest";
    confidenceAdjustment = 5;
  } else if (hour >= 7 && hour < 16) {
    name = "London";
    liquidity = "High";
    confidenceAdjustment = 3;
  } else if (hour >= 13 && hour < 22) {
    name = "New York";
    liquidity = "High";
    confidenceAdjustment = 3;
  } else if (hour >= 0 && hour < 8) {
    name = "Asia";
    liquidity = "Moderate";
    confidenceAdjustment = 1;
  }

  return {
    name,
    liquidity,
    confidenceAdjustment,
    utcHour: hour,
    explanation: `${name} session at ${String(hour).padStart(2, "0")}:00 UTC with ${liquidity.toLowerCase()} expected liquidity. Confidence ${confidenceAdjustment >= 0 ? "increases" : "decreases"} by ${Math.abs(confidenceAdjustment)} points.`
  };
}
