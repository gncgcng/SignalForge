export const ROUTE_TO_VIEW = Object.freeze({
  scanner: "scanner",
  signals: "signals",
  "paper-trading": "paper-portfolio",
  backtesting: "backtesting",
  performance: "performance",
  "how-it-works": "how-it-works",
  watchlist: "watchlist",
  alerts: "alerts",
  notifications: "notifications",
  journal: "journal",
  affiliate: "affiliate",
  leaderboard: "leaderboard",
  profile: "profile",
  settings: "settings",
  support: "support",
  billing: "billing",
  admin: "admin",
  "admin-support": "admin-support",
  "affiliate-admin": "affiliate-admin",
  "webhook-events": "webhook-events"
});

export const PUBLIC_ROUTES = new Set([
  "#landing",
  "#signin",
  "#signup",
  "#reset-password",
  "#account-recovery-support",
  "#clear-session",
  "#debug-build",
  "#how-it-works",
  "#pricing"
]);

export function getHashRoute(hash = globalThis.location?.hash || "") {
  const rawHash = String(hash || "").trim();
  const cleanHash = rawHash.split("?")[0].toLowerCase();
  return cleanHash || "#landing";
}

export function isPublicRoute(route = getHashRoute()) {
  return PUBLIC_ROUTES.has(route) || /^#u\/[a-z0-9_]{3,20}$/.test(route);
}

const VIEW_TO_ROUTE = Object.freeze(Object.fromEntries(
  Object.entries(ROUTE_TO_VIEW).map(([route, view]) => [view, route])
));

export function normalizeAppRoute(routeOrView) {
  const value = String(routeOrView || "").replace(/^#/, "").split("?")[0].trim().toLowerCase();
  if (value === "paper-portfolio") return "paper-trading";
  if (Object.hasOwn(ROUTE_TO_VIEW, value)) return value;
  return VIEW_TO_ROUTE[value] || value;
}

export function parseAppHash(hash = "") {
  const raw = String(hash || "").replace(/^#/, "");
  const separator = raw.indexOf("?");
  const routePart = separator >= 0 ? raw.slice(0, separator) : raw;
  const queryPart = separator >= 0 ? raw.slice(separator + 1) : "";
  let decodedRoute = "";
  try {
    decodedRoute = decodeURIComponent(routePart).trim().toLowerCase();
  } catch {
    decodedRoute = "";
  }
  const route = normalizeAppRoute(decodedRoute);
  return {
    route,
    params: new URLSearchParams(queryPart),
    valid: Boolean(decodedRoute && Object.hasOwn(ROUTE_TO_VIEW, route)),
    canonical: decodedRoute === route
  };
}

export function buildRouteHash(routeOrView, params = {}) {
  const route = normalizeAppRoute(routeOrView) || "scanner";
  const searchParams = params instanceof URLSearchParams
    ? new URLSearchParams(params)
    : new URLSearchParams(params || {});
  const query = searchParams.toString();
  return `#${route}${query ? `?${query}` : ""}`;
}
