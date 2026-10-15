// The first-touch source the browser recorded (public/attribution.js), re-cleaned here
// because it comes from the client. Stored in the signup event's metadata; only short
// slugs and a host are kept, never a full URL.
function clean(value, max = 64) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, max);
}

export function normalizeSignupAttribution(raw) {
  if (!raw || typeof raw !== "object") return {};
  const source = clean(raw.source);
  if (!source) return {};
  const landingPath = String(raw.landingPath || "").split(/[?#]/)[0];
  return {
    source,
    medium: clean(raw.medium),
    campaign: clean(raw.campaign),
    referrerHost: clean(raw.referrerHost, 120),
    landingPath: /^\/[A-Za-z0-9/_.-]{0,119}$/.test(landingPath) ? landingPath : ""
  };
}
