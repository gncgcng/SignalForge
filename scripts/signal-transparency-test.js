import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const generator = readFileSync(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");

const result = {
  disclaimerVisibleInSignalDesk: html.includes("Educational tool only. Not financial advice."),
  signalCardsUseTransparency: app.includes("renderSignalTransparency(setup)") &&
    app.includes("renderSignalTransparency(signal)"),
  historyUsesTransparency: app.includes("history-transparency"),
  whyThisSignalPresent: app.includes("Why this signal?"),
  confidenceBreakdownPresent: app.includes("Confidence summarizes rule alignment"),
  riskGuidanceIsGeneral: app.includes("Define a consistent maximum loss") &&
    !app.includes("You should risk"),
  requiredConfirmationGroups: ["Trend", "RSI", "ATR", "Support/resistance"]
    .every((name) => app.includes(`\"${name}\"`)),
  volumeConditional: app.includes("\"Volume\"") &&
    app.includes("confirmations || []"),
  cryptoAtrConfirmationAdded: generator.includes("atrConfirmation(atr, entry)"),
  professionalStylesPresent: css.includes(".signal-transparency") &&
    css.includes(".confidence-breakdown") &&
    css.includes(".confirmation-list")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
