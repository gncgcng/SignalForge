import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { summarizeScanBatch } from "../src/modules/signals/signalService.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const signalServiceSource = await readFile(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");

const setupA = {
  id: "sig-trump",
  setupKey: "TRUMP-USD:1h:long:fixture",
  symbol: "TRUMP-USD",
  timeframe: "1h",
  direction: "long",
  setupType: "Momentum breakout",
  confidenceScore: 88,
  validUntil: "2026-08-06T18:00:00.000Z"
};
const setupB = {
  id: "sig-plume",
  setupKey: "PLUME-USD:15m:long:fixture",
  symbol: "PLUME-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Momentum breakout",
  confidenceScore: 92,
  validUntil: "2026-08-06T18:00:00.000Z"
};
const setups = [setupA, setupB];
const providerError = {
  symbol: "BROKEN-USD",
  timeframe: "15m",
  message: "Provider request failed"
};
const scanned = [
  { symbol: setupA.symbol, timeframe: setupA.timeframe, valid: true, resultType: "ready_signal" },
  { symbol: setupB.symbol, timeframe: setupB.timeframe, valid: true, resultType: "ready_signal" },
  ...Array.from({ length: 350 }, (_, index) => ({
    symbol: `NOSETUP-${index}`,
    timeframe: "15m",
    valid: false,
    resultType: "rejected"
  })),
  {
    symbol: providerError.symbol,
    timeframe: providerError.timeframe,
    valid: false,
    providerError: true,
    resultType: "rejected"
  }
];
const backendSummary = summarizeScanBatch(
  scanned,
  setups,
  [],
  { topReasons: [{ reason: "No qualified setup", count: 350 }], topCodes: [] },
  [],
  []
);

assert.equal(scanned.length, 353);
assert.equal(backendSummary.ready, 2);
assert.equal(backendSummary.providerErrors, 1);

const failedRun = await runFrontendScanAllHarness("failed");
const cancelledRun = await runFrontendScanAllHarness("cancelled", {
  terminalSetups: [setupA],
  terminalScannedMarkets: 217,
  providerErrors: []
});
const emptyFailedRun = await runFrontendScanAllHarness("failed", {
  terminalSetups: [],
  terminalScannedMarkets: 118,
  providerErrors: [],
  initialScanResults: [setupA]
});
const completedRun = await runFrontendScanAllHarness("completed");

const failedReadySnapshot = failedRun.renderCalls.find((call) =>
  call.responseStatus === "failed" && call.setups.length === 2
);
assert.ok(failedReadySnapshot, "The failed terminal API snapshot must still contain both accumulated ready setups.");
assert.equal(failedReadySnapshot.summary.ready, 2);
assert.equal(failedReadySnapshot.errors.length, 1);

const failedFinalRender = failedRun.renderCalls.at(-1);
assert.equal(failedFinalRender.responseStatus, "failed");
assert.equal(failedFinalRender.setups.length, 2);
assert.equal(failedFinalRender.summary.ready, 2);
assert.equal(failedFinalRender.errors.length, 1);
assert.equal(failedFinalRender.errors[0].symbol, providerError.symbol);
assert.equal(failedRun.state.scanResults.length, 2);
assert.deepEqual(failedRun.progressCalls.at(-1), {
  done: 353,
  total: 353,
  message: "Scan All failed. Late scan finalization failed 2 ready setups were retained."
});

const currentFailedUiSummary = {
  ready: failedFinalRender.setups.length,
  watching: failedFinalRender.summary.watching,
  avoid: failedFinalRender.summary.avoidTrade,
  rejected: failedFinalRender.summary.rejected,
  expired: failedFinalRender.summary.expired,
  skipped: failedFinalRender.summary.skipped,
  providerErrors: failedFinalRender.summary.providerErrors
};
assert.deepEqual(currentFailedUiSummary, {
  ready: 2,
  watching: 0,
  avoid: 0,
  rejected: backendSummary.rejected,
  expired: 0,
  skipped: 0,
  providerErrors: 1
});

assert.equal(cancelledRun.state.scanResults.length, 1);
assert.equal(cancelledRun.state.scanResults[0].symbol, setupA.symbol);
assert.deepEqual(cancelledRun.progressCalls.at(-1), {
  done: 217,
  total: 353,
  message: "Scan cancelled. Partial results are still shown below."
});
assert.match(cancelledRun.statusLine, /Scan cancelled/);

assert.equal(emptyFailedRun.state.scanResults.length, 0);
assert.equal(emptyFailedRun.renderCalls.at(-1).setups.length, 0);
assert.equal(emptyFailedRun.renderCalls.at(-1).errors.length, 0);
assert.equal(emptyFailedRun.renderCalls.at(-1).summary.providerErrors, 0);
assert.deepEqual(emptyFailedRun.progressCalls.at(-1), {
  done: 118,
  total: 353,
  message: "Scan All failed. Late scan finalization failed"
});
assert.match(emptyFailedRun.statusLine, /Scan All failed/);

assert.equal(completedRun.state.scanResults.length, 2);
assert.equal(completedRun.renderCalls.at(-1).setups.length, 2);
assert.deepEqual(completedRun.progressCalls.at(-1), {
  done: 353,
  total: 353,
  message: "Market scan complete · found 2 ready setups so far"
});

const scanClickSource = extractBetween(
  appSource,
  'scanAllButton.addEventListener("click", async () => {',
  'cancelScanButton?.addEventListener("click"'
);
const scanCardSource = extractNamedFunction(appSource, "renderScanCard");
const unlockClickSource = extractBetween(
  appSource,
  'signalsGrid.addEventListener("click", async (event) => {',
  'signalsGrid.addEventListener("input"'
);

assert.match(scanClickSource, /generateButton\.disabled = true/);
assert.match(scanClickSource, /snapshot\.jobId === state\.activeScanJob/);
assert.match(scanClickSource, /renderTerminalScanJobSnapshot/);
assert.doesNotMatch(scanClickSource, /renderScanResults\(\[\], \[\{ symbol: "Scan All"/);
assert.match(scanCardSource, /getSignalValidityState\(setup\)\.status === "expired" \? "disabled" : ""/);
assert.doesNotMatch(scanCardSource, /activeScanJob|scanInProgress/);
assert.doesNotMatch(unlockClickSource, /activeScanJob|scanInProgress/);
assert.equal(failedRun.generateDisabledDuringPolling, true);
assert.equal(failedRun.state.activeScanJob, null);

const unlockRender = renderActualScanCard(setupA, "active");
assert.match(unlockRender, /data-unlock-symbol="TRUMP-USD"/);
assert.doesNotMatch(unlockRender.match(/<button data-unlock-symbol[^>]+>/)?.[0] || "", /\sdisabled(?:\s|>)/);

assert.equal(emptyFailedRun.initialResultsClearedAtStart, true);
assert.equal(emptyFailedRun.renderCalls.some((call) => call.setups.some((setup) => setup.id === setupA.id)), false);

const failedJobCatch = extractBetween(
  signalServiceSource,
  "async function runScanAllJob",
  "async function getCachedScanAllResult"
);
const jobStatusSource = extractNamedFunction(signalServiceSource, "toScanAllJobStatus");
assert.match(failedJobCatch, /job\.status = job\.cancelRequested \? "cancelled" : "failed"/);
assert.doesNotMatch(failedJobCatch, /job\.result\s*=\s*(?:null|\{\}|undefined)/);
assert.match(jobStatusSource, /const result = job\.result \|\| \{\}/);
assert.match(jobStatusSource, /setups: result\.setups \|\| \[\]/);

const persistenceIndex = signalServiceSource.indexOf("await saveGeneratedSignal(signal, {");
const publicReturnIndex = signalServiceSource.indexOf("publicResult: {", persistenceIndex);
assert.ok(persistenceIndex >= 0 && publicReturnIndex > persistenceIndex);
assert.match(signalServiceSource, /if \(result\.valid\) \{\s*context\.setups\.push\(result\.setup\);\s*context\.fullSetups\.push\(detailed\.fullSetup\);/);

console.log(JSON.stringify({
  reproduced: true,
  backendTerminalSnapshot: {
    status: "failed",
    scannedMarkets: 353,
    ready: failedReadySnapshot.summary.ready,
    setups: failedReadySnapshot.setups.map((setup) => setup.symbol),
    providerErrors: failedReadySnapshot.errors.length
  },
  frontendAfterCatch: {
    progress: `${failedRun.progressCalls.at(-1).done}/${failedRun.progressCalls.at(-1).total}`,
    ready: currentFailedUiSummary.ready,
    setups: failedRun.state.scanResults.length,
    providerErrors: currentFailedUiSummary.providerErrors
  },
  cancelledRun: {
    progress: `${cancelledRun.progressCalls.at(-1).done}/${cancelledRun.progressCalls.at(-1).total}`,
    retainedSetups: cancelledRun.state.scanResults.map((setup) => setup.symbol)
  },
  emptyFailedRun: {
    progress: `${emptyFailedRun.progressCalls.at(-1).done}/${emptyFailedRun.progressCalls.at(-1).total}`,
    retainedSetups: emptyFailedRun.state.scanResults.length,
    providerErrors: emptyFailedRun.renderCalls.at(-1).summary.providerErrors
  },
  completedControlRun: {
    retainedSetups: completedRun.state.scanResults.map((setup) => setup.symbol),
    progress: "353/353"
  },
  unlockCharacterization: {
    globalUnlockCurrentDisabledDuringScan: failedRun.generateDisabledDuringPolling,
    cardUnlockDisabledByActiveScan: false,
    cardUnlockDisabledOnlyWhenExpired: true
  },
  rootCauseRepaired: "Terminal failed and cancelled snapshots retain their canonical setups, summaries, and backend progress while showing the job failure separately."
}, null, 2));

async function runFrontendScanAllHarness(terminalStatus, options = {}) {
  let clickHandler = null;
  let statusRequestCount = 0;
  let lastResponseStatus = null;
  let generateDisabledDuringPolling = false;
  const renderCalls = [];
  const progressCalls = [];
  const state = {
    scanResults: [...(options.initialScanResults || [])],
    activeScanJob: null,
    subscription: null
  };
  const markets = Array.from({ length: 353 }, (_, index) => ({
    symbol: `MARKET-${index}`,
    category: "Crypto"
  }));
  const statusLine = { textContent: "" };
  const terminalSetups = options.terminalSetups || setups;
  const terminalScannedMarkets = options.terminalScannedMarkets ?? 353;
  const currentProviderErrors = options.providerErrors || [providerError];
  const completedSnapshot = buildSnapshot(
    terminalStatus,
    terminalScannedMarkets,
    terminalSetups,
    currentProviderErrors
  );
  const runningSnapshot = buildSnapshot(
    "running",
    Math.min(200, terminalScannedMarkets),
    terminalSetups,
    currentProviderErrors
  );
  let initialResultsClearedAtStart = false;
  const context = {
    console,
    state,
    scannerMarketType: { value: "all" },
    scanAllButton: elementWithListener((callback) => { clickHandler = callback; }),
    generateButton: { disabled: false },
    cancelScanButton: controlElement(),
    scanProgress: controlElement(),
    scanSummaryPanel: controlElement(),
    signalsGrid: {
      get innerHTML() { return this.value || ""; },
      set innerHTML(value) {
        this.value = value;
        if (value === "" && state.scanResults.length === 0) initialResultsClearedAtStart = true;
      }
    },
    statusLine,
    getManualScanMarkets: () => markets,
    getFrontendSupportedScanTimeframes: () => ["15m"],
    summarizeFrontendScanUniverse: () => ({ total: 353, crypto: 353, commodities: 0 }),
    updateScanProgress: (done, total, message) => {
      progressCalls.push({ done, total, message });
      statusLine.textContent = message;
    },
    renderScanResults: (currentSetups, errors, diagnostics, summary, avoidTrades, marketBrief, scanUniverse, skippedMarkets, options) => {
      state.scanResults = currentSetups;
      renderCalls.push({
        responseStatus: lastResponseStatus,
        setups: currentSetups,
        errors,
        diagnostics,
        summary,
        avoidTrades,
        marketBrief,
        scanUniverse,
        skippedMarkets,
        options
      });
    },
    api: {
      request: async (path) => {
        if (path === "/api/signals/scan-all/start") {
          lastResponseStatus = "queued";
          return buildSnapshot("queued", 0, []);
        }
        statusRequestCount += 1;
        generateDisabledDuringPolling ||= context.generateButton.disabled === true;
        const response = statusRequestCount === 1 ? runningSnapshot : completedSnapshot;
        lastResponseStatus = response.status;
        return response;
      }
    },
    wait: async () => {},
    renderSubscription: () => {},
    loadAlerts: async () => {},
    loadCandidates: async () => {},
    markFirstScanCompleted: () => {}
  };
  vm.createContext(context);
  vm.runInContext([
    extractNamedFunction(appSource, "pollScanAllJob"),
    extractNamedFunction(appSource, "applyScanJobSnapshot"),
    extractNamedFunction(appSource, "renderTerminalScanJobSnapshot"),
    scanClickSourceForEvaluation(appSource)
  ].join("\n\n"), context);
  assert.equal(typeof clickHandler, "function");
  await clickHandler();
  return {
    state,
    renderCalls,
    progressCalls,
    generateDisabledDuringPolling,
    initialResultsClearedAtStart,
    statusLine: context.statusLine.textContent
  };
}

function buildSnapshot(status, scannedMarkets = 353, currentSetups = setups, providerErrors = [providerError]) {
  return {
    jobId: "scanjob-fixture",
    status,
    progress: {
      scannedMarkets,
      totalMarkets: 353,
      selectedMarkets: 353,
      currentMarket: status === "running" ? "MARKET-200" : null,
      currentTimeframe: status === "running" ? "15m" : null
    },
    setups: currentSetups,
    errors: providerErrors,
    candidates: [],
    avoidTrades: [],
    diagnostics: { topReasons: [], samples: [] },
    scanSummary: currentSetups.length === setups.length && providerErrors.length === 1
      ? backendSummary
      : {
          ready: currentSetups.length,
          watching: 0,
          avoidTrade: 0,
          rejected: Math.max(0, scannedMarkets - currentSetups.length - providerErrors.length),
          expired: 0,
          skipped: 0,
          providerErrors: providerErrors.length,
          noData: 0
        },
    scanUniverse: { selectedMarkets: 353, scannedMarkets, timeframes: 3 },
    skippedMarkets: [],
    marketBrief: null,
    subscription: null,
    error: status === "failed" ? "Late scan finalization failed" : null
  };
}

function renderActualScanCard(setup, validityStatus) {
  const context = {
    state: { expandedSignalKeys: new Set(), scannerMode: "beginner" },
    getSignalKey: (signal) => signal.setupKey,
    getDisplaySymbol: (symbol) => symbol,
    getMarketType: () => "Crypto",
    getProviderSymbolLabel: () => "Coinbase",
    renderSignalValidity: () => "",
    renderConfidenceHelp: () => "",
    renderLockedSignalQuality: () => "",
    renderModeDetails: () => "",
    escapeHtml: (value) => String(value),
    getSignalValidityState: () => ({ status: validityStatus })
  };
  vm.createContext(context);
  vm.runInContext(extractNamedFunction(appSource, "renderScanCard"), context);
  return context.renderScanCard(setup);
}

function elementWithListener(onListener) {
  return {
    disabled: false,
    addEventListener: (_event, callback) => onListener(callback)
  };
}

function controlElement() {
  return {
    disabled: false,
    classList: { add: () => {}, remove: () => {} },
    scrollIntoView: () => {}
  };
}

function scanClickSourceForEvaluation(source) {
  return extractBetween(
    source,
    'scanAllButton.addEventListener("click", async () => {',
    'cancelScanButton?.addEventListener("click"'
  ).trim();
}

function extractNamedFunction(source, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  const start = patterns.reduce((found, pattern) => found >= 0 ? found : source.indexOf(pattern), -1);
  assert.ok(start >= 0, `Could not find function ${name}.`);
  const brace = source.indexOf("{", start);
  const end = findMatchingBrace(source, brace);
  return source.slice(start, end + 1);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not extract source between ${startMarker} and ${endMarker}.`);
  return source.slice(start, end);
}

function findMatchingBrace(source, openingBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced function braces in production source.");
}
