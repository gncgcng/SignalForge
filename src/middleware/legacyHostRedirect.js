// Single source of truth for the domain move from signalforge-app.xyz to signalforge-app.com.
export const CANONICAL_HOST = "signalforge-app.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
export const LEGACY_HOSTS = Object.freeze(["signalforge-app.xyz", "www.signalforge-app.xyz"]);
export const WWW_ALIAS_HOST = `www.${CANONICAL_HOST}`;
// Every host that redirects to CANONICAL_ORIGIN. The canonical host itself is never listed.
export const REDIRECT_SOURCE_HOSTS = Object.freeze([...LEGACY_HOSTS, WWW_ALIAS_HOST]);

// Temporary (302) while the move is new, so a mistake isn't cached by browsers and crawlers.
// Flip to 301 after a week of clean operation.
export const HOST_REDIRECT_STATUS = 302;

// Machine-to-machine callers that are registered against the old host and must keep working
// there until their dashboards are updated: Stripe webhooks, the Google OAuth callback
// (state cookie is host-scoped), and the health checks Railway probes.
export const REDIRECT_EXEMPT_PATHS = Object.freeze([
  "/api/stripe/webhook",
  "/api/subscriptions/webhook",
  "/api/auth/google/callback",
  "/api/auth/health",
  "/api/debug/ping"
]);

export function normalizeHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return "";
  // Strip an optional port and a trailing FQDN dot; IPv6 literals never match a source host.
  return hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function isLegacyHostRedirectEnabled() {
  // Off unless explicitly opted in; read per request so the flag can flip without code changes.
  // One flag controls every host redirect (legacy .xyz hosts and the www alias).
  return process.env.LEGACY_HOST_REDIRECT === "true";
}

// Returns the absolute redirect target, or null when the request must be served normally.
// Only an exact match on a known source host redirects; the target origin is always the
// hard-coded canonical one, never anything derived from the request.
export function resolveLegacyHostRedirect(hostHeader, requestTarget) {
  if (!isLegacyHostRedirectEnabled()) return null;
  if (!REDIRECT_SOURCE_HOSTS.includes(normalizeHostHeader(hostHeader))) return null;

  const target = typeof requestTarget === "string" && requestTarget.startsWith("/") ? requestTarget : "/";
  let parsed;
  try {
    parsed = new URL(target, CANONICAL_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== CANONICAL_ORIGIN) return null;
  if (REDIRECT_EXEMPT_PATHS.includes(parsed.pathname)) return null;

  return `${CANONICAL_ORIGIN}${parsed.pathname}${parsed.search}`;
}

export function redirectLegacyHost(req, res) {
  const location = resolveLegacyHostRedirect(req.headers.host, req.url);
  if (!location) return false;
  res.writeHead(HOST_REDIRECT_STATUS, { location });
  res.end();
  return true;
}
