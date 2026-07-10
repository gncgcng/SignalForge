import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ROUTE_TO_VIEW,
  buildRouteHash,
  normalizeAppRoute,
  parseAppHash
} from "../public/router.js";

assert.equal(parseAppHash("#signals").route, "signals");
assert.equal(parseAppHash("#backtesting").route, "backtesting");
assert.equal(parseAppHash("#paper-portfolio").route, "paper-trading");
assert.equal(parseAppHash("#paper-portfolio").canonical, false);
assert.equal(parseAppHash("#not-a-route").valid, false);
assert.equal(parseAppHash("").valid, false);
assert.equal(parseAppHash("#signals?signalId=abc123").params.get("signalId"), "abc123");
assert.equal(parseAppHash("#signals?unlock=setup-1").params.get("unlock"), "setup-1");
assert.equal(parseAppHash("#paper-trading?pair=BTCUSD").params.get("pair"), "BTCUSD");
assert.equal(buildRouteHash("paper-portfolio"), "#paper-trading");
assert.equal(buildRouteHash("signals", { signalId: "abc123" }), "#signals?signalId=abc123");
assert.equal(normalizeAppRoute("paper-portfolio"), "paper-trading");
assert.equal(ROUTE_TO_VIEW["paper-trading"], "paper-portfolio");

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

const checks = {
  centralizedNavigation:
    app.includes("function navigateTo(routeOrView, params = {}, options = {})") &&
    app.includes("navigateTo(link.dataset.viewLink);") &&
    !app.includes("function showView(") &&
    !app.includes("showView("),
  hashUpdatesWithoutReload:
    app.includes('history[options.replace ? "replaceState" : "pushState"]') &&
    !app.includes("location.reload("),
  initialDeepLink:
    app.includes("syncRouteFromLocation({ force: true, replaceInvalid: true })") &&
    app.includes('history.replaceState({}, "", `${location.pathname}${location.search}#scanner`)'),
  browserHistory:
    app.includes('window.addEventListener("hashchange", handleBrowserRouteChange)') &&
    app.includes('window.addEventListener("popstate", handleBrowserRouteChange)'),
  activeStateFromRoute:
    app.includes("state.activeRoute = route") &&
    app.includes("applyViewState(ROUTE_TO_VIEW[route], viewOptions)") &&
    app.includes('link.classList.toggle("active", link.dataset.viewLink === normalizedView)'),
  deepLinksPreserved:
    app.includes('params.get("signalId")') &&
    app.includes('hashParams.get("unlock")') &&
    app.includes('params.get("pair")') &&
    app.includes("removeHashParams([\"signalId\"])") &&
    app.includes("removeHashParams([\"pair\"])") &&
    app.includes('parsed.params.delete("unlock")'),
  paperRouteCanonical:
    html.includes('href="#paper-trading" data-view-link="paper-portfolio"') &&
    app.includes('navigateTo("paper-trading"'),
  sidebarRoutesComplete: [
    "scanner", "signals", "paper-trading", "backtesting", "performance",
    "watchlist", "alerts", "notifications", "journal", "affiliate",
    "billing", "settings", "profile"
  ].every((route) => html.includes(`href="#${route}"`)),
  pwaCachesRouter: serviceWorker.includes('"/router.js"')
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Client routing check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
