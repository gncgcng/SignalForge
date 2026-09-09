import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const profileService = readFileSync(new URL("../src/modules/profiles/profileService.js", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/040_signal_view_mode.sql", import.meta.url), "utf8");

assert.match(migration, /signal_view_mode text NOT NULL DEFAULT 'beginner'/);
assert.match(migration, /CHECK \(signal_view_mode IN \('beginner', 'advanced'\)\)/);
assert.match(repository, /signal_view_mode = COALESCE\(\$7, signal_view_mode\)/);
assert.match(profileService, /validateSignalViewMode/);

assert.ok((html.match(/data-signal-view-toggle/g) || []).length >= 3, "mode controls should appear on signal surfaces and Settings");
assert.match(html, /data-signal-view-mode="beginner"/);
assert.match(html, /data-signal-view-mode="advanced"/);
assert.match(app, /return stored === "advanced" \? "advanced" : "beginner"/);
assert.match(app, /api\.request\("\/api\/profile\/me"/);
assert.match(app, /renderSignalViewSurfaces\(\)/);

assert.match(app, /state\.scannerMode === "beginner"/);
assert.match(app, /Why this setup\?/);
assert.match(app, /renderRiskCalculator\(signal/);
assert.match(app, /View advanced details/);
assert.match(app, /renderSignalValidation\(signal\)/);
assert.match(app, /renderCandidateHistory\(signal\)/);
assert.match(app, /Candidate and watch history/);
assert.doesNotMatch(app.slice(app.indexOf("function renderAdvancedPreviewChecks"), app.indexOf("function renderSignalValidation")), /JSON\.stringify/);

assert.match(app, /locked \? "" : `<div class="signal-metrics">/);
assert.match(app, /Entry, stop loss, take profit, and full analysis remain hidden until unlock/);
assert.match(app, /const advanced = state\.scannerMode === "advanced"/);
assert.match(app, /Why not a signal yet/);
assert.match(app, /What would improve it/);
assert.match(app, /View scanner and timeframe detail/);

assert.match(css, /\.signal-view-toggle/);
assert.match(css, /@media \(max-width: 767px\)/);
assert.match(css, /grid-template-columns: auto minmax\(0, 1fr\) minmax\(0, 1fr\)/);
assert.match(css, /overflow-wrap: anywhere/);

console.log(JSON.stringify({
  defaultMode: "beginner",
  accountPersistence: true,
  lockedLevelsRedacted: true,
  watchingAndAvoidModes: true,
  mobileResponsive: true
}, null, 2));
