import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

function includes(source, text, label = text) {
  assert.ok(source.includes(text), `Expected ${label}`);
}

includes(html, 'id="onboarding-panel"', "onboarding panel markup");
includes(html, 'id="onboarding-checklist"', "checklist container");
includes(html, 'id="onboarding-progress-bar"', "progress bar");
includes(html, 'id="onboarding-skip-button"', "skip button");
includes(html, 'id="onboarding-show-button"', "dashboard reopen button");
includes(app, "ONBOARDING_SKIP_KEY", "onboarding skip storage key");
includes(app, "FIRST_SCAN_KEY", "first scan storage key");
includes(app, "function getOnboardingSteps()", "onboarding step state builder");
includes(app, "function renderOnboarding()", "onboarding renderer");
includes(app, "function handleOnboardingAction(action)", "onboarding action router");
includes(app, "function markFirstScanCompleted()", "first scan completion helper");
includes(app, "Create username", "username checklist copy");
includes(app, "Connect Telegram", "telegram checklist copy");
includes(app, "Choose alert preferences", "alert preferences checklist copy");
includes(app, "Run first scan", "first scan checklist copy");
includes(app, "Unlock first signal", "unlock checklist copy");
includes(app, "data-onboarding-action", "onboarding action buttons");
includes(app, 'navigateTo("notifications")', "notifications onboarding routing");
includes(app, 'navigateTo("profile")', "profile onboarding routing");
includes(app, "markFirstScanCompleted();", "scan completion call sites");

assert.ok(
  !/usernameRequired[\s\S]{0,120}\?\s*"profile"/.test(app),
  "Missing username should not force Profile view on dashboard startup."
);

includes(css, ".onboarding-panel", "onboarding panel styles");
includes(css, ".onboarding-checklist", "onboarding checklist styles");
includes(css, ".onboarding-step", "onboarding step card styles");
includes(css, "@media (max-width: 767px)", "mobile dashboard breakpoint");
assert.ok(
  /@media \(max-width: 767px\)[\s\S]*\.onboarding-step[\s\S]*grid-template-columns: auto 1fr/.test(css),
  "Expected mobile onboarding card stacking rules."
);

console.log("Onboarding flow checks passed.");
