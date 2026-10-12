import {
  ALL_SETUPS_KEY,
  formatCount,
  formatPercent,
  formatR,
  renderTrackRecordMethodologyHtml,
  renderTrackRecordTableHtml,
  sortTrackRecords
} from "../../../public/trackRecords.js";
import { figureValue } from "./researchSummary.js";

// Public, server-rendered /research page: real HTML for search engines and link previews, no sign-in.
// Intraday figures come from the track-records file; research figures from data/research/summary.v1.json.
export const RESEARCH_URL = "https://signalforge-app.com/research";
export const RESEARCH_TITLE = "We tested our own trading signals. They lost money. | SignalForge";
export const RESEARCH_DESCRIPTION = "Before looking at any results we wrote down what would count as working, then tested thousands of past setups. Our intraday setups, a daily trend system and a BTC/ETH in-or-out rule all failed. Here is the full record, plus a free fee-cost calculator.";
const SOCIAL_IMAGE = "https://signalforge-app.com/icons/android-chrome-512x512.png";
const MIN_TABLE_CASES = 30;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const monthYear = (isoDate) => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`));
const yearOf = (isoDate) => String(isoDate).slice(0, 4);
const countWords = ["None", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const asWord = (count) => countWords[count] ?? formatCount(count);
const listCount = (list) => String(list).split(",").map((item) => item.trim()).filter(Boolean).length;
const roundTripPercent = (fraction) => `${(fraction * 100).toFixed(2)}%`;

// Every number on the page, with where it comes from. Exported so tests can check the rendered text against it.
export function researchFigures(trackRecords, summary) {
  const all = trackRecords?.available ? trackRecords.records.find((record) => record.key === ALL_SETUPS_KEY) : null;
  if (!all) throw new Error("Track records are not available; /research cannot render without them.");
  const dailyHoldoutAvgR = figureValue(summary, "dailyTrendHoldoutAvgR");
  return {
    intraday: {
      cases: all.n,
      expired: all.expired,
      pairs: trackRecords.pairs.length,
      from: trackRecords.period.from,
      to: trackRecords.period.to,
      winRate: all.winRate,
      breakEvenWinRate: all.breakEvenWinRate,
      avgR: all.avgR,
      retailAvgR: all.retailAvgR,
      headlineRoundTrip: trackRecords.fees.headlineRoundTrip,
      retailRoundTrip: trackRecords.fees.retailRoundTrip,
      cellsTested: figureValue(summary, "intradayCellsTested"),
      edgeCells: figureValue(summary, "intradayEdgeCells")
    },
    dailyTrend: {
      variants: figureValue(summary, "dailyTrendVariants"),
      devFrom: figureValue(summary, "dailyTrendDevFrom"),
      devTo: figureValue(summary, "dailyTrendDevTo"),
      passed: figureValue(summary, "dailyTrendPassedDev"),
      holdoutFrom: figureValue(summary, "dailyTrendHoldoutFrom"),
      holdoutTo: figureValue(summary, "dailyTrendHoldoutTo"),
      holdoutAvgR: dailyHoldoutAvgR
    },
    inOut: {
      rules: listCount(figureValue(summary, "inOutRules")),
      coins: listCount(figureValue(summary, "inOutCoins")),
      requiredCutPercent: 100 - figureValue(summary, "inOutMaxDrawdownShareOfHold"),
      passed: figureValue(summary, "inOutPassedDev"),
      deepestFallMin: figureValue(summary, "inOutDeepestFallMin"),
      deepestFallMax: figureValue(summary, "inOutDeepestFallMax"),
      holdoutFrom: figureValue(summary, "inOutHoldoutFrom"),
      holdoutTo: figureValue(summary, "inOutHoldoutTo")
    }
  };
}

export function renderResearchPage({ trackRecords, summary }) {
  const figures = researchFigures(trackRecords, summary);
  const { intraday, dailyTrend, inOut } = figures;
  const lossPer100 = Math.round(Math.abs(intraday.avgR) * 100);
  const rows = sortTrackRecords(trackRecords.records.filter((record) => record.key === ALL_SETUPS_KEY || record.n >= MIN_TABLE_CASES), "n", "desc");
  const intradayVerdict = intraday.edgeCells === 0
    ? `none of the ${formatCount(intraday.cellsTested)} strategy, direction and timeframe combinations we could judge passed`
    : `${formatCount(intraday.edgeCells)} of the ${formatCount(intraday.cellsTested)} strategy, direction and timeframe combinations we could judge passed`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#061B22" />
    <title>${escapeHtml(RESEARCH_TITLE)}</title>
    <meta name="description" content="${escapeHtml(RESEARCH_DESCRIPTION)}" />
    <link rel="canonical" href="${RESEARCH_URL}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${RESEARCH_URL}" />
    <meta property="og:site_name" content="SignalForge" />
    <meta property="og:title" content="We tested our own trading signals. They lost money." />
    <meta property="og:description" content="${escapeHtml(RESEARCH_DESCRIPTION)}" />
    <meta property="og:image" content="${SOCIAL_IMAGE}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="We tested our own trading signals. They lost money." />
    <meta name="twitter:description" content="${escapeHtml(RESEARCH_DESCRIPTION)}" />
    <meta name="twitter:image" content="${SOCIAL_IMAGE}" />
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="research-body">
    <main class="app-shell">
      <div class="landing-page premium-landing research-page">
        <header class="landing-nav premium-nav">
          <a class="logo-row" href="/" aria-label="SignalForge home">
            <img class="brand-logo small" src="/icons/android-chrome-192x192.png" alt="" />
            <strong>SignalForge</strong>
          </a>
          <nav class="research-nav-links" aria-label="Research sections">
            <a href="#tests">The tests</a>
            <a href="#fee-calculator">Fee calculator</a>
            <a href="#records">Track records</a>
            <a class="research-nav-cta" href="/">Open SignalForge</a>
          </nav>
        </header>

        <section class="landing-band research-hero">
          <span class="eyebrow">Research</span>
          <h1>We tested our own trading signals. They lost money.</h1>
          <p>Most signal services show you their wins. We wanted to know the real answer, so before looking at any results we wrote down the rules for what would count as "working", then tested on thousands of past setups.</p>
        </section>

        <section class="landing-band research-tests" id="tests">
          <article class="research-test">
            <span class="eyebrow">Test 1</span>
            <h2>Our intraday setups</h2>
            <p>Across ${formatCount(intraday.cases)} past long setups that reached their target or their stop, on ${formatCount(intraday.pairs)} liquid crypto pairs (${escapeHtml(monthYear(intraday.from))} – ${escapeHtml(monthYear(intraday.to))}), the setups won ${escapeHtml(formatPercent(intraday.winRate))} of the time but needed ${escapeHtml(formatPercent(intraday.breakEvenWinRate))} to break even. Average result: ${escapeHtml(formatR(intraday.avgR))} per trade after low fees (${escapeHtml(roundTripPercent(intraday.headlineRoundTrip))} round trip), and ${escapeHtml(formatR(intraday.retailAvgR))} at typical retail fees (${escapeHtml(roundTripPercent(intraday.retailRoundTrip))} round trip). In the original test, run before we looked at the most recent months, ${escapeHtml(intradayVerdict)}.</p>
          </article>
          <article class="research-test">
            <span class="eyebrow">Test 2</span>
            <h2>Daily trend-following</h2>
            <p>${formatCount(dailyTrend.variants)} versions tested on ${escapeHtml(yearOf(dailyTrend.devFrom))}–${escapeHtml(yearOf(dailyTrend.devTo))}. ${escapeHtml(asWord(dailyTrend.passed))} passed, then failed on ${escapeHtml(yearOf(dailyTrend.holdoutFrom))}–${escapeHtml(yearOf(dailyTrend.holdoutTo))} data it had never seen (${escapeHtml(formatR(dailyTrend.holdoutAvgR, 3))} per trade after fees).</p>
          </article>
          <article class="research-test">
            <span class="eyebrow">Test 3</span>
            <h2>"Hold BTC/ETH in uptrends, cash otherwise"</h2>
            <p>${formatCount(inOut.rules)} rules × ${formatCount(inOut.coins)} coins. None cut the worst crash by the ${formatCount(inOut.requiredCutPercent)}% we required: the deepest falls were ${escapeHtml(String(inOut.deepestFallMin))}–${escapeHtml(String(inOut.deepestFallMax))}%. They did better in ${escapeHtml(yearOf(inOut.holdoutFrom))}–${escapeHtml(yearOf(inOut.holdoutTo))}, but a rule that only works in the period you happen to like isn't a rule.</p>
          </article>
        </section>

        <section class="landing-band research-explainer">
          <h2>What "R" means</h2>
          <p>R is the amount you risk on a trade: the distance from your entry to your stop. ${escapeHtml(formatR(intraday.avgR))} means that for every $100 risked per trade, you lost about $${lossPer100} on average.</p>
          <h2>The lesson that surprised us most: fees</h2>
          <p>Short-term setups use tight stops. When your stop is 0.7% away and a round trip costs ${escapeHtml(roundTripPercent(intraday.retailRoundTrip))} in fees, fees alone cost you more than your whole risk. Try the calculator below with your own numbers.</p>
        </section>

        <section class="landing-band research-calculator" id="fee-calculator" aria-labelledby="fee-calculator-title">
          <span class="eyebrow">Free tool</span>
          <h2 id="fee-calculator-title">What do fees cost you per trade?</h2>
          <p>For a long trade. Everything runs in your browser; nothing is sent anywhere.</p>
          <form class="fee-calculator" id="fee-calculator-form" novalidate>
            <label>Entry price<input id="fc-entry" name="entry" type="number" inputmode="decimal" min="0" step="any" value="100" /></label>
            <label>Stop price<input id="fc-stop" name="stop" type="number" inputmode="decimal" min="0" step="any" value="99.3" /></label>
            <label>Fee per side, %<input id="fc-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="0.60" /></label>
            <div class="fee-presets" role="group" aria-label="Fee presets">
              <span>Presets:</span>
              <button type="button" data-fee-preset="0.10">0.10%</button>
              <button type="button" data-fee-preset="0.25">0.25%</button>
              <button type="button" data-fee-preset="0.60">0.60% (Coinbase retail taker)</button>
            </div>
            <label>Slippage per side, %<input id="fc-slippage" name="slippage" type="number" inputmode="decimal" min="0" step="0.01" value="0.05" /></label>
            <label>Target, R<input id="fc-target" name="target" type="number" inputmode="decimal" min="0" step="0.1" value="2" /></label>
          </form>
          <div class="fee-results" id="fee-calculator-results" aria-live="polite">
            <noscript><p>The calculator needs JavaScript. The formula: cost in R = (2 × (fee + slippage per side)) ÷ stop distance, both in %.</p></noscript>
          </div>
        </section>

        <section class="landing-band research-why">
          <h2>Why we publish this</h2>
          <p>SignalForge now shows the real track record next to every setup, including the bad ones. We'd rather you trade less than trade blind.</p>
        </section>

        <section class="landing-band research-records" id="records">
          <span class="eyebrow">Every record</span>
          <h2>Track records by setup</h2>
          <p>"All setups" plus every setup with at least ${MIN_TABLE_CASES} past cases. Same columns and labels as in the app.</p>
          <div class="track-records-table-wrap">
            ${renderTrackRecordTableHtml(rows, trackRecords, { escapeHtml })}
          </div>
        </section>

        <section class="landing-band research-method" id="how-we-measure">
          <h2>How we measure this</h2>
          <div class="track-records-method">
            ${renderTrackRecordMethodologyHtml(trackRecords, { escapeHtml, tableLinkHtml: `<a href="#records">See the records</a>` })}
          </div>
        </section>

        <section class="disclaimer-band">
          <div>
            <span class="eyebrow">Risk disclosure</span>
            <strong>Past results do not guarantee future results.</strong>
          </div>
          <p>SignalForge provides information and tools, not financial advice.</p>
        </section>

        <footer class="landing-footer">
          <a class="logo-row" href="/" aria-label="SignalForge home">
            <img class="brand-logo small" src="/icons/android-chrome-192x192.png" alt="" />
            <strong>SignalForge</strong>
          </a>
          <div class="footer-links">
            <a href="/">Home</a>
            <a href="/research">Research</a>
            <a href="/?legal=terms">Terms</a>
            <a href="/?legal=privacy">Privacy Policy</a>
            <a href="/?legal=risk">Risk Disclaimer</a>
          </div>
        </footer>
      </div>
    </main>
    <script type="module" src="/research.js"></script>
  </body>
</html>
`;
}
