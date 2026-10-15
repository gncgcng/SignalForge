// First-touch acquisition source. The first page a visitor lands on (the app or /research)
// records where they came from: utm_source when the link carries one, otherwise the
// referring site's host, otherwise "direct". Later visits never overwrite it, and it is
// sent once with signup. Only a host is kept from the referrer, never its path or query.
export const FIRST_TOUCH_KEY = "signalforge-first-touch";

// Hosts a visitor passes through mid-flow (sign-in, checkout); never an acquisition source.
const IGNORED_REFERRER_HOSTS = ["accounts.google.com", "checkout.stripe.com", "billing.stripe.com"];

function clean(value, max = 64) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, max);
}

export function deriveFirstTouch({ search = "", referrer = "", currentHost = "", pathname = "/" } = {}) {
  const params = new URLSearchParams(search);
  let referrerHost = "";
  try {
    referrerHost = referrer ? new URL(referrer).hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch {
    referrerHost = "";
  }
  const ownHost = String(currentHost || "").toLowerCase().replace(/^www\./, "");
  if (referrerHost === ownHost || IGNORED_REFERRER_HOSTS.includes(referrerHost)) referrerHost = "";

  const utmSource = clean(params.get("utm_source"));
  return {
    source: utmSource || clean(referrerHost) || "direct",
    medium: clean(params.get("utm_medium")) || (utmSource ? "" : referrerHost ? "referral" : "none"),
    campaign: clean(params.get("utm_campaign")),
    referrerHost: clean(referrerHost, 120),
    landingPath: String(pathname || "/").slice(0, 120)
  };
}

export function captureFirstTouch(win = globalThis.window) {
  try {
    if (!win?.localStorage || win.localStorage.getItem(FIRST_TOUCH_KEY)) return;
    const touch = deriveFirstTouch({
      search: win.location.search,
      referrer: win.document?.referrer,
      currentHost: win.location.hostname,
      pathname: win.location.pathname
    });
    win.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify({ ...touch, capturedAt: new Date().toISOString() }));
  } catch {
    // Storage blocked (private mode): signup is simply recorded without a source.
  }
}

export function getFirstTouch(win = globalThis.window) {
  try {
    const stored = JSON.parse(win?.localStorage?.getItem(FIRST_TOUCH_KEY) || "null");
    return stored && typeof stored === "object" ? stored : null;
  } catch {
    return null;
  }
}
