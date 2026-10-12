import { computeFeeCost, formatPercentValue } from "./feeCost.js";

// Wires the /research fee-cost calculator. Client-side only: nothing is sent anywhere.
const form = document.querySelector("#fee-calculator-form");
const results = document.querySelector("#fee-calculator-results");

function value(id) {
  return document.querySelector(id)?.value ?? "";
}

function escapeText(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span.innerHTML;
}

function render() {
  const result = computeFeeCost({
    entry: value("#fc-entry"),
    stop: value("#fc-stop"),
    feePerSidePct: value("#fc-fee"),
    slippagePerSidePct: value("#fc-slippage"),
    targetR: value("#fc-target")
  });
  if (!result.ok) {
    results.innerHTML = `<p class="fee-error" role="alert">${escapeText(result.message)}</p>`;
    return;
  }
  results.innerHTML = `
    <dl class="fee-outputs">
      <div><dt>Stop distance</dt><dd data-fee-output="stopDistance">${result.stopDistancePct.toFixed(2)}%</dd></div>
      <div><dt>Round-trip cost</dt><dd data-fee-output="roundTrip">${result.roundTripPct.toFixed(2)}%</dd></div>
      <div><dt>Cost in R</dt><dd data-fee-output="costR">${result.costR.toFixed(2)}R</dd></div>
      <div><dt>Break-even win rate</dt><dd data-fee-output="breakEven">${escapeText(formatPercentValue(result.breakEvenWithCosts))}</dd></div>
    </dl>
    <p class="fee-sentence" data-fee-output="sentence">${escapeText(result.sentence)}</p>`;
}

if (form && results) {
  form.addEventListener("input", render);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-fee-preset]");
    if (!preset) return;
    document.querySelector("#fc-fee").value = preset.dataset.feePreset;
    render();
  });
  render();
}
