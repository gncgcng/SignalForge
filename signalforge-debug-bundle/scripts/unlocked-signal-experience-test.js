import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const paperMigration = readFileSync(new URL("../migrations/009_paper_trades.sql", import.meta.url), "utf8");

const revealFunction = app.slice(
  app.indexOf("function renderUnlockReveal()"),
  app.indexOf("function closeUnlockReveal()")
);
const unlockedDetails = app.slice(
  app.indexOf("function renderUnlockedSignalDetails(signal)"),
  app.indexOf("function renderSignalTransparency(signal)")
);

const checks = {
  unlockShowsModal:
    html.includes('id="unlock-reveal"') &&
    html.includes('id="unlock-reveal-card"') &&
    app.includes("completeSignalUnlock({ signal, subscription, alreadyUnlocked") &&
    app.includes('navigateTo("signals"') &&
    app.includes("renderUnlockReveal();"),
  levelsBeforeAnalysis:
    revealFunction.indexOf("Entry") < revealFunction.indexOf("View full analysis") &&
    unlockedDetails.indexOf("renderPaperTradeAction(signal)") < unlockedDetails.indexOf("renderAiAnalyst(signal)") &&
    unlockedDetails.indexOf("renderAiAnalyst(signal)") < unlockedDetails.indexOf("Full analysis context") &&
    unlockedDetails.indexOf("Full analysis context") < unlockedDetails.indexOf("Checklist and validation details") &&
    unlockedDetails.indexOf("Checklist and validation details") < unlockedDetails.indexOf("Historical learning insight"),
  paperPortfolioAction:
    revealFunction.includes("renderPaperTradeAction(signal, true)") &&
    app.includes("Already added to Paper Trading") &&
    app.includes("prefillPaperOrderFromSignal(signal)") &&
    app.includes('navigateTo("paper-trading"') &&
    app.includes("skipPaperLoad: true"),
  duplicatePaperBlocked:
    paperMigration.includes("UNIQUE (user_id, saved_signal_id)") &&
    repositories.includes("ON CONFLICT (user_id, saved_signal_id) DO NOTHING"),
  duplicateUnlockProtected:
    repositories.includes("pg_advisory_xact_lock") &&
    repositories.includes("mapped.alreadyUnlocked = true") &&
    repositories.indexOf("if (existing.rows[0])") < repositories.indexOf("unlock_credits_balance = unlock_credits_balance - 1"),
  telegramExactSignal:
    app.includes('source: "telegram"') &&
    app.includes("state.unlockedRevealSignalId = unlockedSignal.id") &&
    app.includes("highlightSignalKey(key)") &&
    app.includes("sessionStorage.setItem(UNLOCK_REVEAL_KEY, unlockedSignal.id)"),
  mobileNoOverflow:
    css.includes("width: min(680px, 100%);") &&
    css.includes("grid-template-columns: repeat(2, minmax(0, 1fr));") &&
    css.includes("max-width: 100%;") &&
    css.includes("max-height: calc(100dvh - 20px);"),
  analysisCollapsedByDefault:
    app.includes("<details class=\"unlocked-analysis-section\">") &&
    app.includes("<summary>Full analysis context</summary>")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Unlocked signal experience check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
