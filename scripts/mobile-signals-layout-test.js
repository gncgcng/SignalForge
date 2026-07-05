import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = {
  mobileCardsRendered:
    app.includes("renderMobileSignalHistoryCard(signal)") &&
    app.includes('class="mobile-signals-list"') &&
    app.includes('class="mobile-signal-card"') &&
    app.includes("renderMobileSignalAccordion(signal)"),
  desktopTablePreserved:
    app.includes('<table class="signals-table">') &&
    css.includes(".signals-table {\n  width: 100%;\n  min-width: 980px;") &&
    css.includes(".mobile-signals-list {\n  display: none;"),
  mobileTableDisabled:
    css.includes("@media (max-width: 767px)") &&
    css.includes(".signals-table {\n    display: none;") &&
    css.includes(".mobile-signals-list {\n    display: grid;") &&
    css.includes(".signals-table-wrap {\n    overflow: visible;"),
  stackedRows:
    app.includes('Entry", formatCurrency(signal.entryPrice)') &&
    app.includes('Stop", formatCurrency(signal.stopLoss)') &&
    app.includes('Take profit", formatCurrency(signal.takeProfit)') &&
    app.includes('R/R", `${signal.riskRewardRatio}:1`') &&
    css.includes(".mobile-signal-values"),
  accordionSections:
    app.includes("<summary>Overview</summary>") &&
    app.includes("<summary>Why this signal?</summary>") &&
    app.includes("<summary>Risk levels</summary>") &&
    app.includes("<summary>Advanced analysis</summary>") &&
    css.includes(".mobile-signal-accordion details"),
  longAnalysisSafe:
    app.includes('class="reasoning long-analysis"') &&
    css.includes("overflow-wrap: anywhere;") &&
    css.includes("white-space: normal;"),
  telegramDeepLinkAnchors:
    app.includes('data-signal-key="${key}"') &&
    app.includes("processPendingTelegramUnlock") &&
    app.includes("highlightSignalKey(unlockedKey)") &&
    app.includes("getPendingTelegramUnlockKey()") &&
    app.includes("Sign in to unlock this Telegram signal preview."),
  mobileHeaderPolish:
    css.includes("overflow-x: hidden;") &&
    css.includes(".topbar .eyebrow") &&
    css.includes(".topbar h2") &&
    css.includes("font-size: 1rem;"),
  filtersStack:
    html.includes('class="history-filters"') &&
    css.includes(".history-filters {\n    grid-template-columns: 1fr;"),
  disclaimerFits:
    css.includes(".signal-disclaimer {\n    align-items: flex-start;") &&
    css.includes("width: 100%;")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Mobile Signals layout check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
