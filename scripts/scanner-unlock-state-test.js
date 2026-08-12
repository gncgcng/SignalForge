import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const currentSetups = [
  buildSetup("RSCUSD", "rsc-ready", "long"),
  buildSetup("READY-B", "ready-b", "short"),
  buildSetup("READY-C", "ready-c", "long"),
  buildSetup("READY-D", "ready-d", "short")
];

const firstUnlock = await runSuccessfulUnlock(0);
const middleUnlock = await runSuccessfulUnlock(2);
const nullUnlock = await runFailedUnlock();
const rejectedUnlock = await runFailedUnlock(new Error("Unlock request rejected"));
const telegramUnlock = await runSuccessfulUnlock(1, "telegram");
const renderScanCardSource = extractNamedFunction(appSource, "renderScanCard");

assertPreservedScanner(firstUnlock, 0);
assertPreservedScanner(middleUnlock, 2);
assert.equal(firstUnlock.afterClose.length, 4);
assert.deepEqual(firstUnlock.navigation, []);
assert.deepEqual(middleUnlock.navigation, []);
assert.equal(firstUnlock.historySignalsLoaded, 5);
assert.equal(firstUnlock.historicalCardsInDesk, 0);
assertFailedUnlockPreserved(nullUnlock);
assertFailedUnlockPreserved(rejectedUnlock);
assert.equal(nullUnlock.renderNoSetupCalls, 0);
assert.equal(rejectedUnlock.status, "Unlock request rejected");
assert.deepEqual(telegramUnlock.navigation, ["signals"]);
assert.match(renderScanCardSource, /if \(setup\.scanDeskUnlocked\) return renderSignalCard\(setup\)/);

console.log(JSON.stringify({
  firstCard: summarize(firstUnlock, 0),
  middleCard: summarize(middleUnlock, 2),
  nullSignalFailure: summarizeFailure(nullUnlock),
  rejectedRequest: summarizeFailure(rejectedUnlock),
  telegramOriginNavigation: telegramUnlock.navigation
}, null, 2));

async function runSuccessfulUnlock(index, source = "scanner") {
  const unlocked = {
    ...currentSetups[index],
    id: `saved-${currentSetups[index].setupKey}`,
    entryPrice: 100 + index,
    stopLoss: 98 + index,
    takeProfit: 105 + index,
    riskRewardRatio: 2.5,
    status: "Active"
  };
  const harness = createHarness({ historySignal: unlocked });
  const completion = harness.context.completeSignalUnlock({
    signal: unlocked,
    subscription: { unlockCredits: 4 },
    alreadyUnlocked: false,
    source
  });

  await harness.historyRequested;
  const duringHistoryLoad = snapshot(harness);
  harness.resolveHistory({
    signals: [
      unlocked,
      ...Array.from({ length: 4 }, (_, historyIndex) => buildHistoricalSignal(historyIndex))
    ]
  });
  await completion;
  const afterHistoryLoad = snapshot(harness);
  harness.context.closeUnlockReveal();

  return {
    duringHistoryLoad,
    afterHistoryLoad,
    afterClose: harness.state.scanResults.map((item) => ({ ...item })),
    navigation: [...harness.navigation],
    historySignalsLoaded: harness.state.signals.length,
    historicalCardsInDesk: countMatches(harness.signalsGrid.innerHTML, "data-history-card"),
    route: harness.route.current
  };
}

async function runFailedUnlock(unlockError = null) {
  const harness = createHarness({
    unlockResponse: { signal: null, analysis: { message: "No longer valid" } },
    unlockError
  });
  await harness.clickUnlock(0);
  return {
    scanResults: harness.state.scanResults.map((item) => ({ ...item })),
    renderNoSetupCalls: harness.renderNoSetupCalls.count,
    currentCardsInDesk: countCurrentCards(harness.signalsGrid.innerHTML),
    navigation: [...harness.navigation],
    route: harness.route.current,
    status: harness.context.statusLine.textContent
  };
}

function createHarness({ historySignal = null, unlockResponse = null, unlockError = null } = {}) {
  let clickHandler;
  let resolveHistory;
  let historyStarted;
  const historyRequested = new Promise((resolve) => { historyStarted = resolve; });
  const historyResponse = new Promise((resolve) => { resolveHistory = resolve; });
  const navigation = [];
  const route = { current: "scanner" };
  const renderNoSetupCalls = { count: 0 };
  const state = {
    scanResults: currentSetups.map((item) => ({ ...item })),
    signals: [],
    signalStats: null,
    subscription: null,
    expandedSignalKeys: new Set(),
    unlockedRevealSignalId: null
  };
  const signalsGrid = {
    innerHTML: "",
    addEventListener(event, callback) {
      if (event === "click") clickHandler = callback;
    }
  };
  const session = new Map();
  const context = {
    console,
    state,
    signalsGrid,
    statusLine: { textContent: "" },
    document: {
      body: { classList: classListHarness() },
      querySelector: (selector) => selector === "#signal-count" ? { textContent: "" } : null
    },
    api: {
      async request(path) {
        if (path === "/api/signals/generate") {
          if (unlockError) throw unlockError;
          return unlockResponse || {
            signal: historySignal,
            subscription: { unlockCredits: 4 },
            analysis: null,
            alreadyUnlocked: false
          };
        }
        if (path === "/api/signals") {
          historyStarted();
          return historyResponse;
        }
        throw new Error(`Unexpected API request: ${path}`);
      }
    },
    normalizeSignal: (signal) => ({ ...signal }),
    getSignalSummary: () => ({}),
    logSignalHistoryDiagnostics: () => {},
    renderSignalsHistory: () => {},
    renderPerformanceStats: () => {},
    renderOnboarding: () => {},
    renderSubscription: () => {},
    loadPaperPortfolio: async () => {},
    getSignalKey: (signal) => signal.setupKey || signal.id,
    sessionStorage: {
      setItem: (key, value) => session.set(key, value),
      getItem: (key) => session.get(key),
      removeItem: (key) => session.delete(key)
    },
    UNLOCK_REVEAL_KEY: "signalforge_unlock_reveal",
    navigateTo(destination) {
      navigation.push(destination);
      route.current = destination;
    },
    renderUnlockReveal: () => {},
    showToast: () => {},
    renderNoSetup() {
      renderNoSetupCalls.count += 1;
      signalsGrid.innerHTML = '<article data-no-setup="true"></article>';
    },
    unlockReveal: { classList: classListHarness() },
    highlightSignalKey: () => {},
    enterPaperTrade: async () => {},
    scrollToSignalKey: () => {},
    scanAllButton: { click: () => {} },
    getDisplaySymbol: (symbol) => symbol,
    getMarketType: () => "Crypto",
    getProviderSymbolLabel: (symbol) => symbol,
    renderSignalValidity: () => "",
    renderConfidenceHelp: () => "",
    renderLockedSignalQuality: () => "",
    getSignalValidityState: () => ({ status: "active" }),
    escapeHtml: (value) => String(value),
    renderModeDetails: () => "",
    renderSignalCard: (signal) => String(signal.id).startsWith("history-")
      ? `<article data-history-card="${signal.id}"></article>`
      : `<article data-unlocked-card="${signal.setupKey}" data-entry="${signal.entryPrice}" data-stop="${signal.stopLoss}" data-target="${signal.takeProfit}"></article>`
  };
  vm.createContext(context);
  vm.runInContext([
    extractNamedFunction(appSource, "loadSignals"),
    extractNamedFunction(appSource, "renderSignals"),
    extractNamedFunction(appSource, "renderScanCard"),
    extractNamedFunction(appSource, "mergeUnlockedSignalIntoScanResults"),
    extractBetween(appSource, "async function completeSignalUnlock", "function mergeUnlockedSignalIntoScanResults"),
    extractNamedFunction(appSource, "closeUnlockReveal"),
    extractBetween(
      appSource,
      'signalsGrid.addEventListener("click", async (event) => {',
      'signalsGrid.addEventListener("input"'
    )
  ].join("\n\n"), context);
  context.renderSignals();

  return {
    context,
    state,
    signalsGrid,
    navigation,
    route,
    renderNoSetupCalls,
    historyRequested,
    resolveHistory,
    async clickUnlock(index) {
      assert.equal(typeof clickHandler, "function");
      const setup = currentSetups[index];
      const button = {
        disabled: false,
        dataset: {
          unlockSymbol: setup.symbol,
          unlockTimeframe: setup.timeframe,
          unlockSetupKey: setup.setupKey
        }
      };
      await clickHandler({
        target: {
          closest: (selector) => selector === "[data-unlock-symbol]" ? button : null
        }
      });
    }
  };
}

function assertPreservedScanner(result, unlockedIndex) {
  for (const stage of [result.duringHistoryLoad, result.afterHistoryLoad]) {
    assert.equal(stage.scanResults.length, 4);
    assert.deepEqual(stage.scanResults.map((item) => item.setupKey), currentSetups.map((item) => item.setupKey));
    assert.equal(stage.scanResults[unlockedIndex].scanDeskUnlocked, true);
    assert.equal(stage.scanResults[unlockedIndex].entryPrice, 100 + unlockedIndex);
    assert.equal(stage.scanResults[unlockedIndex].stopLoss, 98 + unlockedIndex);
    assert.equal(stage.scanResults[unlockedIndex].takeProfit, 105 + unlockedIndex);
    assert.equal(stage.scanResults.filter((item) => item.scanDeskUnlocked).length, 1);
    assert.equal(stage.currentCardsInDesk, 4);
    assert.equal(stage.historicalCardsInDesk, 0);
    assert.match(stage.html, new RegExp(`data-entry="${100 + unlockedIndex}"`));
    assert.match(stage.html, new RegExp(`data-stop="${98 + unlockedIndex}"`));
    assert.match(stage.html, new RegExp(`data-target="${105 + unlockedIndex}"`));
  }
  assert.equal(result.route, "scanner");
}

function assertFailedUnlockPreserved(result) {
  assert.equal(result.scanResults.length, 4);
  assert.deepEqual(result.scanResults, currentSetups);
  assert.equal(result.currentCardsInDesk, 4);
  assert.deepEqual(result.navigation, []);
  assert.equal(result.route, "scanner");
}

function snapshot(harness) {
  return {
    scanResults: harness.state.scanResults.map((item) => ({ ...item })),
    currentCardsInDesk: countCurrentCards(harness.signalsGrid.innerHTML),
    historicalCardsInDesk: countMatches(harness.signalsGrid.innerHTML, "data-history-card"),
    html: harness.signalsGrid.innerHTML
  };
}

function countCurrentCards(html) {
  return countMatches(html, "data-signal-key") + countMatches(html, "data-unlocked-card");
}

function summarize(result, index) {
  return {
    retainedCards: result.afterHistoryLoad.scanResults.length,
    setupKey: result.afterHistoryLoad.scanResults[index].setupKey,
    unlockedInPlace: result.afterHistoryLoad.scanResults[index].scanDeskUnlocked,
    entry: result.afterHistoryLoad.scanResults[index].entryPrice,
    stopLoss: result.afterHistoryLoad.scanResults[index].stopLoss,
    takeProfit: result.afterHistoryLoad.scanResults[index].takeProfit,
    route: result.route,
    historicalCardsInDesk: result.historicalCardsInDesk
  };
}

function summarizeFailure(result) {
  return { retainedCards: result.scanResults.length, route: result.route, status: result.status };
}

function buildSetup(symbol, setupKey, direction) {
  return {
    id: `scan-${setupKey}`,
    setupKey,
    symbol,
    timeframe: "15m",
    direction,
    confidenceScore: 92,
    resultType: "ready_signal",
    validUntil: "2026-08-12T00:00:00.000Z"
  };
}

function buildHistoricalSignal(index) {
  return { id: `history-${index}`, setupKey: `history-key-${index}`, status: "Hit SL" };
}

function countMatches(value, token) {
  return String(value).split(token).length - 1;
}

function classListHarness() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    contains: (item) => values.has(item)
  };
}

function extractNamedFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.reduce((found, marker) => found >= 0 ? found : source.indexOf(marker), -1);
  assert.ok(start >= 0, `Could not find function ${name}.`);
  const openingBrace = source.indexOf("{", start);
  const end = findMatchingBrace(source, openingBrace);
  return source.slice(start, end + 1);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not extract ${startMarker}.`);
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
  throw new Error("Unbalanced production function source.");
}
