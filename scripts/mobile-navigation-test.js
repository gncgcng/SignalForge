import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  hamburgerPresent:
    html.includes('id="mobile-menu-toggle"') &&
    html.includes('aria-controls="mobile-navigation"') &&
    html.includes('aria-expanded="false"') &&
    html.includes(">☰</button>"),
  drawerIsMobileOnly:
    css.includes("@media (max-width: 767px)") &&
    css.includes(".mobile-menu-toggle {\n  display: none;") &&
    css.includes(".dashboard {\n    display: block;") &&
    css.includes("transform: translateX(-105%)") &&
    css.includes(".dashboard.mobile-nav-open .sidebar") &&
    css.includes("transform: translateX(0)"),
  desktopSidebarPreserved:
    css.includes("grid-template-columns: 260px 1fr") &&
    !css.includes("@media (max-width: 980px) {\n  .auth-screen,\n  .dashboard,"),
  menuDoesNotPushContent:
    css.includes("position: fixed") &&
    css.includes("z-index: 60") &&
    css.includes("body.mobile-nav-open") &&
    css.includes("overflow: hidden"),
  mobileTopbarCompact:
    css.includes(".topbar {\n    position: sticky;") &&
    css.includes("flex: 0 0 44px") &&
    css.includes(".user-chip #user-name") &&
    css.includes("display: none"),
  menuClosesOnSelection:
    app.includes("mobileMenuToggle.addEventListener") &&
    app.includes("setMobileNavigationOpen(!dashboard.classList.contains(\"mobile-nav-open\"))") &&
    app.includes("navigateTo(link.dataset.viewLink);") &&
    app.includes("setMobileNavigationOpen(false);"),
  menuClosesOnBackdropAndEscape:
    app.includes("dashboard.addEventListener(\"click\"") &&
    app.includes("!sidebar.contains(event.target)") &&
    app.includes("event.key === \"Escape\"") &&
    app.includes("window.addEventListener(\"resize\""),
  accessibilityStateUpdates:
    app.includes("mobileMenuToggle.setAttribute(\"aria-expanded\", String(open))") &&
    app.includes("mobileMenuToggle.setAttribute(\"aria-label\", open ? \"Close navigation\" : \"Open navigation\")"),
  pwaCacheBumped: css.includes("mobile-nav-open") &&
    /signalforge-static-v\d+/.test(
      readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8")
    )
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Mobile navigation check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
