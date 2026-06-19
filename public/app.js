const state = {
  user: null,
  subscription: null,
  marketCatalog: [],
  pairs: [],
  selectedPair: null,
  timeframe: "15m",
  marketData: null,
  marketStatus: {},
  activeView: "scanner",
  historyFilters: {
    pair: "all",
    timeframe: "all",
    direction: "all"
  },
  signalStats: {
    totalSignals: 0,
    winRate: 0,
    hitTpCount: 0,
    hitSlCount: 0,
    expiredCount: 0
  },
  signals: [],
  watchlist: [],
  alerts: [],
  unreadAlertCount: 0,
  notifications: {
    configured: false,
    connected: false,
    botUsername: "",
    settings: null
  }
};

const authScreen = document.querySelector("#auth-screen");
const landingPage = document.querySelector("#landing-page");
const dashboard = document.querySelector("#dashboard");
const authForm = document.querySelector("#auth-form");
const authNote = document.querySelector("#auth-note");
const viewDemoButton = document.querySelector("#view-demo-button");
const pairSearch = document.querySelector("#pair-search");
const pairList = document.querySelector("#pair-list");
const timeframes = document.querySelector("#timeframes");
const generateButton = document.querySelector("#generate-button");
const scanAllButton = document.querySelector("#scan-all-button");
const scanProgress = document.querySelector("#scan-progress");
const scanProgressText = document.querySelector("#scan-progress-text");
const scanProgressCount = document.querySelector("#scan-progress-count");
const scanProgressBar = document.querySelector("#scan-progress-bar");
const statusLine = document.querySelector("#status-line");
const signalsGrid = document.querySelector("#signals-grid");
const historyCount = document.querySelector("#history-count");
const signalsHistory = document.querySelector("#signals-history");
const historyPairFilter = document.querySelector("#history-pair-filter");
const historyTimeframeFilter = document.querySelector("#history-timeframe-filter");
const historyDirectionFilter = document.querySelector("#history-direction-filter");
const statTotal = document.querySelector("#stat-total");
const statWinRate = document.querySelector("#stat-win-rate");
const statHitTp = document.querySelector("#stat-hit-tp");
const statHitSl = document.querySelector("#stat-hit-sl");
const statExpired = document.querySelector("#stat-expired");
const favoriteMarketButton = document.querySelector("#favorite-market-button");
const watchlistGrid = document.querySelector("#watchlist-grid");
const watchlistCount = document.querySelector("#watchlist-count");
const alertsGrid = document.querySelector("#alerts-grid");
const alertsCount = document.querySelector("#alerts-count");
const unreadAlertCount = document.querySelector("#unread-alert-count");
const telegramConnectForm = document.querySelector("#telegram-connect-form");
const telegramConnectButton = document.querySelector("#telegram-connect-button");
const telegramConnectionPanel = document.querySelector("#telegram-connection-panel");
const telegramConnectionCode = document.querySelector("#telegram-connection-code");
const telegramStartCommand = document.querySelector("#telegram-start-command");
const telegramOpenBotLink = document.querySelector("#telegram-open-bot-link");
const telegramCopyCommand = document.querySelector("#telegram-copy-command");
const telegramConnectionMessage = document.querySelector("#telegram-connection-message");
const telegramTestButton = document.querySelector("#telegram-test-button");
const telegramPreferencesForm = document.querySelector("#telegram-preferences-form");
const telegramChatId = document.querySelector("#telegram-chat-id");
const telegramEnabled = document.querySelector("#telegram-enabled");
const telegramDirection = document.querySelector("#telegram-direction");
const telegramMinimumConfidence = document.querySelector("#telegram-minimum-confidence");
const telegramStatusLine = document.querySelector("#telegram-status-line");
let marketRequestId = 0;
let signalRefreshTimer = null;
let marketLoadTimer = null;
let telegramConnectionTimer = null;

const api = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...options
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error?.message || "Request failed.");
    }

    return payload;
  }
};

document.querySelector("#start-free-button").addEventListener("click", () => {
  showAuth();
});

document.querySelector("#landing-login-button").addEventListener("click", () => {
  showAuth();
});

viewDemoButton.addEventListener("click", async () => {
  try {
    const { user } = await api.request("/api/auth/demo", { method: "POST" });
    state.user = user;
    await bootDashboard();
  } catch (error) {
    showAuth();
    authNote.textContent = error.message;
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(authForm);

  try {
    authNote.textContent = "Authenticating...";
    const { user } = await api.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form))
    });
    state.user = user;
    await bootDashboard();
  } catch (error) {
    authNote.textContent = error.message;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await api.request("/api/auth/logout", { method: "POST" });
  } finally {
    clearClientAuthState();
  }
  landingPage.classList.remove("hidden");
  dashboard.classList.add("hidden");
  authScreen.classList.add("hidden");
});

document.querySelector("#upgrade-button").addEventListener("click", async () => {
  const { checkout } = await api.request("/api/subscriptions/checkout", { method: "POST" });
  statusLine.textContent = checkout.message;
});

document.querySelectorAll("[data-view-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.viewLink);
  });
});

[historyPairFilter, historyTimeframeFilter, historyDirectionFilter].forEach((filter) => {
  filter.addEventListener("change", () => {
    state.historyFilters = {
      pair: historyPairFilter.value,
      timeframe: historyTimeframeFilter.value,
      direction: historyDirectionFilter.value
    };
    renderSignalsHistory();
  });
});

pairSearch.addEventListener("input", async () => {
  await loadPairs(pairSearch.value);
});

scanAllButton.addEventListener("click", async () => {
  const symbols = state.marketCatalog.filter((pair) => pair.status === "active").map((pair) => pair.symbol);
  const frames = ["1h", "4h", "15m", "5m"];
  const total = symbols.length * frames.length;

  scanAllButton.disabled = true;
  generateButton.disabled = true;
  scanProgress.classList.remove("hidden");
  signalsGrid.innerHTML = "";
  updateScanProgress(0, total, "Scanning all active crypto and commodity markets...");

  try {
    const result = await api.request("/api/signals/scan-all", { method: "POST" });
    updateScanProgress(total, total, "Market scan complete");
    await loadAlerts();
    renderScanResults(result.setups, result.errors);
  } catch (error) {
    updateScanProgress(0, total, "Scan All failed");
    renderScanResults([], [{ symbol: "Scan All", timeframe: "", message: error.message }]);
  } finally {
    scanAllButton.disabled = false;
    generateButton.disabled = false;
  }
});

generateButton.addEventListener("click", async () => {
  if (!state.selectedPair) {
    statusLine.textContent = "Choose a market first.";
    return;
  }

  try {
    generateButton.disabled = true;
    statusLine.textContent = "Generating setup from live OHLCV candles...";
    const { signal, subscription, analysis } = await api.request("/api/signals/generate", {
      method: "POST",
      body: JSON.stringify({
        symbol: state.selectedPair.symbol,
        timeframe: state.timeframe
      })
    });
    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "No valid setup found. Trial credit was not used.";
      return;
    }

    state.signals = [signal, ...state.signals];
    await loadSignals();
    renderSignals();
    renderSignalsHistory();
    statusLine.textContent = "Setup generated from live OHLCV data. Rule-based only; not financial advice.";
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    generateButton.disabled = false;
  }
});

favoriteMarketButton.addEventListener("click", async () => {
  if (!state.selectedPair?.selectable) return;

  const favorite = state.watchlist.some((item) => item.symbol === state.selectedPair.symbol);
  const path = favorite
    ? `/api/watchlist?symbol=${encodeURIComponent(state.selectedPair.symbol)}`
    : "/api/watchlist";
  const options = favorite
    ? { method: "DELETE" }
    : { method: "POST", body: JSON.stringify({ symbol: state.selectedPair.symbol }) };
  const { watchlist } = await api.request(path, options);
  state.watchlist = watchlist;
  renderFavoriteButton();
  renderWatchlist();
});

watchlistGrid.addEventListener("click", async (event) => {
  const removeButton = event.target.closest("[data-watchlist-remove]");
  const saveButton = event.target.closest("[data-alert-save]");

  if (removeButton) {
    const { watchlist } = await api.request(
      `/api/watchlist?symbol=${encodeURIComponent(removeButton.dataset.watchlistRemove)}`,
      { method: "DELETE" }
    );
    state.watchlist = watchlist;
    renderWatchlist();
    renderFavoriteButton();
    return;
  }

  if (saveButton) {
    const item = saveButton.closest("[data-watchlist-symbol]");
    const { watchlist } = await api.request("/api/alerts/preferences", {
      method: "PUT",
      body: JSON.stringify({
        symbol: item.dataset.watchlistSymbol,
        timeframe: item.querySelector("[data-alert-timeframe]").value,
        direction: item.querySelector("[data-alert-direction]").value,
        minimumConfidence: Number(item.querySelector("[data-alert-confidence]").value)
      })
    });
    state.watchlist = watchlist;
    renderWatchlist();
  }
});

alertsGrid.addEventListener("click", async (event) => {
  const readButton = event.target.closest("[data-alert-read]");
  const unlockButton = event.target.closest("[data-alert-unlock]");

  if (readButton) {
    applyAlerts(await api.request(`/api/alerts/${readButton.dataset.alertRead}/read`, { method: "POST" }));
    return;
  }

  if (unlockButton) {
    await unlockSignal(unlockButton, unlockButton.dataset.alertUnlock, unlockButton.dataset.alertTimeframe);
  }
});

telegramConnectForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    telegramStatusLine.textContent = "Connecting Telegram...";
    state.notifications = await api.request("/api/notifications/telegram/connect", {
      method: "POST",
      body: JSON.stringify({
        chatId: telegramChatId.value,
        enabled: false,
        timeframes: getSelectedTelegramTimeframes(),
        direction: telegramDirection.value,
        minimumConfidence: Number(telegramMinimumConfidence.value)
      })
    });
    renderNotifications();
    setTelegramConnectionFeedback("Connected successfully", "success");
    telegramStatusLine.textContent = "Connected successfully. Enable alerts when your preferences are ready.";
  } catch (error) {
    setTelegramConnectionFeedback("Connection failed", "error");
    telegramStatusLine.textContent = error.message;
  }
});

telegramConnectButton.addEventListener("click", async () => {
  try {
    telegramConnectButton.disabled = true;
    telegramConnectButton.textContent = "Generating code...";
    setTelegramConnectionFeedback("Waiting for Telegram confirmation", "waiting");
    const connection = await api.request("/api/notifications/telegram/connect/start", {
      method: "POST"
    });

    telegramConnectionCode.textContent = connection.code;
    telegramStartCommand.textContent = `/start ${connection.code}`;
    telegramOpenBotLink.href = connection.botUrl;
    telegramConnectionPanel.classList.remove("hidden");
    telegramOpenBotLink.focus();
    startTelegramConnectionStatusPolling();
  } catch (error) {
    const message = error.message.includes("not configured")
      ? "Telegram bot not configured"
      : "Connection failed";
    setTelegramConnectionFeedback(message, "error");
    telegramStatusLine.textContent = error.message;
    telegramConnectButton.disabled = false;
    telegramConnectButton.textContent = "Connect Telegram";
  }
});

telegramCopyCommand.addEventListener("click", async () => {
  const command = telegramStartCommand.textContent;

  try {
    await copyText(command);
    telegramCopyCommand.textContent = "Copied";
    telegramStatusLine.textContent = `${command} copied. Paste it into the SignalForge Telegram bot.`;
  } catch {
    telegramCopyCommand.textContent = "Copy failed";
    telegramStatusLine.textContent = "Copy failed. Select the command above and copy it manually.";
  } finally {
    setTimeout(() => {
      telegramCopyCommand.textContent = "Copy /start CODE";
    }, 1800);
  }
});

telegramTestButton.addEventListener("click", async () => {
  try {
    telegramTestButton.disabled = true;
    telegramTestButton.textContent = "Sending...";
    const result = await api.request("/api/notifications/telegram/test", { method: "POST" });
    telegramStatusLine.textContent = result.message;
  } catch (error) {
    telegramStatusLine.textContent = `Connection failed: ${error.message}`;
  } finally {
    telegramTestButton.disabled = false;
    telegramTestButton.textContent = "Send Test Alert";
  }
});

telegramPreferencesForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    state.notifications = await api.request("/api/notifications/telegram/preferences", {
      method: "PUT",
      body: JSON.stringify({
        enabled: telegramEnabled.checked,
        timeframes: getSelectedTelegramTimeframes(),
        direction: telegramDirection.value,
        minimumConfidence: Number(telegramMinimumConfidence.value)
      })
    });
    renderNotifications();
    telegramStatusLine.textContent = "Telegram preferences saved.";
  } catch (error) {
    telegramStatusLine.textContent = error.message;
  }
});

telegramEnabled.addEventListener("change", async () => {
  if (!state.notifications.connected) return;

  try {
    state.notifications = await api.request("/api/notifications/telegram/enabled", {
      method: "PUT",
      body: JSON.stringify({ enabled: telegramEnabled.checked })
    });
    renderNotifications();
    telegramStatusLine.textContent = telegramEnabled.checked
      ? "Telegram notifications enabled."
      : "Telegram notifications disabled.";
  } catch (error) {
    telegramEnabled.checked = !telegramEnabled.checked;
    telegramStatusLine.textContent = error.message;
  }
});

signalsGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-unlock-symbol]");

  if (!button) {
    return;
  }

  try {
    button.disabled = true;
    statusLine.textContent = `Unlocking ${button.dataset.unlockSymbol} ${button.dataset.unlockTimeframe}...`;
    const { signal, subscription, analysis } = await api.request("/api/signals/generate", {
      method: "POST",
      body: JSON.stringify({
        symbol: button.dataset.unlockSymbol,
        timeframe: button.dataset.unlockTimeframe
      })
    });

    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "Setup no longer qualifies. Trial credit was not used.";
      return;
    }

    state.signals = [signal, ...state.signals];
    await loadSignals();
    renderSignals();
    renderSignalsHistory();
    statusLine.textContent = "Full signal unlocked and saved.";
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function unlockSignal(button, symbol, timeframe) {
  try {
    button.disabled = true;
    statusLine.textContent = `Unlocking ${symbol} ${timeframe}...`;
    const { signal, subscription, analysis } = await api.request("/api/signals/generate", {
      method: "POST",
      body: JSON.stringify({ symbol, timeframe })
    });

    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "Setup no longer qualifies. Trial credit was not used.";
      return;
    }

    await loadSignals();
    statusLine.textContent = "Full signal unlocked and saved.";
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function init() {
  const [{ user }, authConfig] = await Promise.all([
    api.request("/api/auth/session"),
    api.request("/api/auth/config")
  ]);
  viewDemoButton.classList.toggle("hidden", !authConfig.demoEnabled);
  state.user = user;

  if (user) {
    await bootDashboard();
  } else {
    landingPage.classList.remove("hidden");
    authScreen.classList.add("hidden");
    dashboard.classList.add("hidden");
  }
}

function clearClientAuthState() {
  localStorage.clear();
  sessionStorage.clear();

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();

    if (name) {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
    }
  }

  state.user = null;
  state.subscription = null;
  state.marketCatalog = [];
  state.pairs = [];
  state.selectedPair = null;
  state.marketData = null;
  state.marketStatus = {};
  state.signals = [];
  state.watchlist = [];
  state.alerts = [];
  state.unreadAlertCount = 0;
  state.notifications = {
    configured: false,
    connected: false,
    botUsername: "",
    settings: null
  };
  state.signalStats = {
    totalSignals: 0,
    winRate: 0,
    hitTpCount: 0,
    hitSlCount: 0,
    expiredCount: 0
  };

  if (signalRefreshTimer) {
    clearInterval(signalRefreshTimer);
    signalRefreshTimer = null;
  }

  if (marketLoadTimer) {
    clearTimeout(marketLoadTimer);
    marketLoadTimer = null;
  }

  if (telegramConnectionTimer) {
    clearInterval(telegramConnectionTimer);
    telegramConnectionTimer = null;
  }
}

async function bootDashboard() {
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.querySelector("#user-name").textContent = state.user.name;
  await Promise.all([
    loadPairs(),
    loadSubscription(),
    loadSignals(),
    loadWatchlist(),
    loadAlerts(),
    loadNotifications()
  ]);
  renderTimeframes();
  const requestedView = location.hash?.replace("#", "");
  showView(["signals", "watchlist", "alerts", "notifications"].includes(requestedView) ? requestedView : "scanner");
  startSignalHistoryRefresh();
  await loadMarketData();
}

function showAuth() {
  landingPage.classList.add("hidden");
  dashboard.classList.add("hidden");
  authScreen.classList.remove("hidden");
}

async function loadPairs(query = "") {
  const { pairs } = await api.request(`/api/market-data/pairs?q=${encodeURIComponent(query)}`);
  state.pairs = pairs;

  if (!query) {
    state.marketCatalog = pairs;
  }

  state.selectedPair = state.selectedPair ||
    pairs.find((pair) => pair.symbol === "BTC-USD" && pair.status === "active") ||
    pairs.find((pair) => pair.status === "active") ||
    pairs[0];
  renderHistoryPairOptions();
  renderPairs();
  renderSelectedMarket();
}

function renderHistoryPairOptions() {
  const currentValue = historyPairFilter.value || "all";
  historyPairFilter.innerHTML = `
    <option value="all">All pairs</option>
    ${state.marketCatalog.map((pair) => `<option value="${pair.symbol}">${pair.symbol}</option>`).join("")}
  `;
  historyPairFilter.value = state.marketCatalog.some((pair) => pair.symbol === currentValue) ? currentValue : "all";
}

async function loadMarketData() {
  if (!state.selectedPair || state.selectedPair.status !== "active") {
    renderChart([]);
    setMarketStatus(
      state.selectedPair?.category === "Commodities"
        ? `${state.selectedPair.symbol}: ${state.selectedPair.availabilityMessage || "Data provider not configured"}.`
        : "Stocks and ETFs are Coming Soon.",
      "idle"
    );
    return;
  }

  const requestId = marketRequestId += 1;
  const statusKey = getMarketStatusKey();
  const providerLabel = getProviderLabel(state.selectedPair);

  try {
    document.querySelector("#provider-name").textContent = providerLabel;
    setMarketStatus(`Loading ${state.selectedPair.symbol} ${state.timeframe} candles...`, "loading");
    const { marketData } = await api.request(`/api/market-data/candles?symbol=${encodeURIComponent(state.selectedPair.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`);

    if (requestId !== marketRequestId) {
      return;
    }

    state.marketData = marketData;
    state.selectedPair = marketData.pair;
    state.pairs = state.pairs.map((pair) => pair.symbol === marketData.pair.symbol ? marketData.pair : pair);
    renderPairs();
    renderSelectedMarket();
    renderChart(marketData.candles);
    document.querySelector("#provider-name").textContent = providerLabel;
    document.querySelector("#candle-count").textContent = `${marketData.candles.length}`;
    document.querySelector("#market-regime").textContent = inferRegime(marketData.candles);
    document.querySelector("#provider-status").textContent = marketData.cache === "hit" ? "Cached live" : "Live candles";
    state.marketStatus[statusKey] = {
      type: "loaded",
      message: `Loaded ${marketData.candles.length} live ${state.selectedPair.symbol} ${state.timeframe} candles from ${providerLabel}.`
    };
    renderMarketStatus();
  } catch (error) {
    if (requestId !== marketRequestId) {
      return;
    }

    state.marketData = null;
    renderChart([]);
    document.querySelector("#provider-name").textContent = providerLabel;
    document.querySelector("#provider-status").textContent = "Provider issue";
    document.querySelector("#candle-count").textContent = "--";
    document.querySelector("#market-regime").textContent = "Unavailable";
    state.marketStatus[statusKey] = {
      type: "error",
      message: `${state.selectedPair.symbol} ${state.timeframe}: ${error.message}`
    };
    renderMarketStatus();
  }
}

async function loadSubscription() {
  const { subscription } = await api.request("/api/subscriptions/me");
  state.subscription = subscription;
  renderSubscription();
}

async function loadSignals() {
  const { signals, stats } = await api.request("/api/signals");
  state.signals = signals;
  state.signalStats = stats || state.signalStats;
  renderSignals();
  renderSignalsHistory();
  renderPerformanceStats();
}

async function loadWatchlist() {
  const { watchlist } = await api.request("/api/watchlist");
  state.watchlist = watchlist;
  renderWatchlist();
  renderFavoriteButton();
}

async function loadAlerts() {
  applyAlerts(await api.request("/api/alerts"));
}

async function loadNotifications() {
  state.notifications = await api.request("/api/notifications/telegram");
  renderNotifications();

  if (!state.notifications.connected && state.notifications.configured) {
    try {
      const connection = await api.request("/api/notifications/telegram/connect/status");

      if (connection.status === "waiting") {
        telegramConnectionCode.textContent = connection.code;
        telegramStartCommand.textContent = `/start ${connection.code}`;
        if (connection.botUrl) {
          telegramOpenBotLink.href = connection.botUrl;
        }
        telegramConnectionPanel.classList.remove("hidden");
        setTelegramConnectionFeedback("Waiting for Telegram confirmation", "waiting");
        startTelegramConnectionStatusPolling();
      }
    } catch {
      // The main Notifications panel still shows provider configuration state.
    }
  }
}

function applyAlerts({ alerts, unreadCount }) {
  state.alerts = alerts;
  state.unreadAlertCount = unreadCount;
  renderAlerts();
  renderUnreadAlertCount();
}

function startSignalHistoryRefresh() {
  if (signalRefreshTimer) {
    return;
  }

  signalRefreshTimer = setInterval(async () => {
    if (!state.user || state.activeView !== "signals") {
      return;
    }

    try {
      await loadSignals();
    } catch {
      // Keep the current table visible if a demo refresh fails.
    }
  }, 30000);
}

function showView(view) {
  const normalizedView = ["scanner", "watchlist", "alerts", "notifications", "signals", "billing"].includes(view) ? view : "scanner";
  state.activeView = normalizedView;

  document.querySelectorAll("[data-view]").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.view !== normalizedView);
  });

  document.querySelectorAll("[data-view-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.viewLink === normalizedView);
  });

  const titles = {
    scanner: ["Market scanner", "High-probability setup lab"],
    watchlist: ["Favorite markets", "Watchlist & alert rules"],
    alerts: ["Detected setups", "In-app alerts"],
    notifications: ["Delivery channels", "Notifications"],
    signals: ["Signals history", "Saved signal desk"],
    billing: ["Subscription", "Billing"]
  };
  const [eyebrow, title] = titles[normalizedView];
  document.querySelector(".topbar .eyebrow").textContent = eyebrow;
  document.querySelector(".topbar h2").textContent = title;

  if (normalizedView === "signals") {
    renderSignalsHistory();
  }

  if (normalizedView === "alerts") {
    renderAlerts();
  }
}

function renderPairs() {
  const categories = [...new Set(state.pairs.map((pair) => pair.category))];
  pairList.innerHTML = categories.map((category) => `
    <section class="market-category">
      <div class="market-category-title">
        <strong>${category}</strong>
        <span>${state.pairs.filter((pair) => pair.category === category && pair.status === "active").length} live</span>
      </div>
      ${state.pairs.filter((pair) => pair.category === category).map((pair) => pair.selectable ? `
        <button class="pair-button ${state.selectedPair?.symbol === pair.symbol ? "active" : ""}" data-symbol="${pair.symbol}" data-status="${pair.status}" ${pair.status !== "active" ? "disabled" : ""} aria-busy="${getPairIsLoading(pair)}">
          <span>
            <strong>${pair.symbol}</strong><br />
            <small>${pair.name} · ${pair.assetClass} · ${pair.venue}</small>
          </span>
          <strong>${getPairBadge(pair)}</strong>
        </button>
      ` : `
        <div class="pair-button unavailable" data-symbol="${pair.symbol}" data-status="${pair.status}" aria-disabled="true">
          <span>
            <strong>${pair.symbol}</strong><br />
            <small>${pair.name} · ${pair.availabilityMessage}</small>
          </span>
          <strong>${getPairBadge(pair)}</strong>
        </div>
      `).join("")}
    </section>
  `).join("");

  pairList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPair = state.pairs.find((pair) => pair.symbol === button.dataset.symbol);
      renderPairs();
      renderSelectedMarket();
      queueMarketDataLoad();
    });
  });
}

function getPairBadge(pair) {
  if (pair.status !== "active") {
    return pair.category === "Commodities" &&
      pair.availabilityCode === "PROVIDER_NOT_CONFIGURED"
      ? "Not configured"
      : "Coming Soon";
  }

  return Number.isFinite(pair.change24h) ? formatPercent(pair.change24h) : "Live";
}

function getMarketStatusKey(pair = state.selectedPair, timeframe = state.timeframe) {
  return `${pair?.symbol || "none"}:${timeframe}`;
}

function getPairIsLoading(pair) {
  return state.marketStatus[getMarketStatusKey(pair)]?.type === "loading";
}

function setMarketStatus(message, type) {
  state.marketStatus[getMarketStatusKey()] = { message, type };
  renderMarketStatus();
}

function renderMarketStatus() {
  const current = state.marketStatus[getMarketStatusKey()];
  statusLine.textContent = current?.message || "Select a market and timeframe to generate a setup.";
  generateButton.disabled = current?.type === "loading" || state.selectedPair?.status !== "active";
  scanAllButton.disabled = current?.type === "loading";
  document.querySelector("#provider-status").textContent = current?.type === "loading" ? "Loading" : document.querySelector("#provider-status").textContent;
  renderPairs();
}

function renderSelectedMarket() {
  if (!state.selectedPair) return;
  document.querySelector("#provider-name").textContent = getProviderLabel(state.selectedPair);
  document.querySelector("#selected-symbol").textContent = state.selectedPair.symbol;
  document.querySelector("#selected-price").textContent = Number.isFinite(state.selectedPair.lastPrice)
    ? formatCurrency(state.selectedPair.lastPrice)
    : state.selectedPair.availabilityMessage || "Coming Soon";
  document.querySelector("#selected-change").textContent = Number.isFinite(state.selectedPair.change24h) ? formatPercent(state.selectedPair.change24h) : "--";
  renderFavoriteButton();
}

function renderFavoriteButton() {
  const favorite = state.watchlist.some((item) => item.symbol === state.selectedPair?.symbol);
  favoriteMarketButton.textContent = favorite ? "★" : "☆";
  favoriteMarketButton.classList.toggle("active", favorite);
  favoriteMarketButton.title = favorite ? "Remove from watchlist" : "Add to watchlist";
  favoriteMarketButton.setAttribute(
    "aria-label",
    favorite ? "Remove selected market from watchlist" : "Add selected market to watchlist"
  );
  favoriteMarketButton.disabled = !state.selectedPair?.selectable;
}

function getProviderLabel(pair) {
  if (pair?.provider === "twelve-data") return "Twelve Data";
  if (pair?.provider === "coinbase-exchange") return "Coinbase";
  return "Not configured";
}

function renderTimeframes() {
  timeframes.innerHTML = ["5m", "15m", "1h", "4h"].map((frame) => `
    <button class="${state.timeframe === frame ? "active" : ""}" data-frame="${frame}">${frame}</button>
  `).join("");

  timeframes.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.timeframe = button.dataset.frame;
      renderTimeframes();
      queueMarketDataLoad();
    });
  });
}

function queueMarketDataLoad() {
  clearTimeout(marketLoadTimer);
  marketLoadTimer = setTimeout(() => {
    marketLoadTimer = null;
    loadMarketData();
  }, 250);
}

function renderChart(candles) {
  const svg = document.querySelector("#candle-chart");

  if (!candles.length) {
    svg.innerHTML = `<text x="340" y="145" fill="#8e9bb0" text-anchor="middle">Market data unavailable</text>`;
    return;
  }

  const width = 680;
  const height = 280;
  const padding = 18;
  const visible = candles.slice(-72);
  const min = Math.min(...visible.map((candle) => candle.low));
  const max = Math.max(...visible.map((candle) => candle.high));
  const range = Math.max(max - min, 1);
  const slot = (width - padding * 2) / visible.length;
  const bodyWidth = Math.max(3, slot * 0.58);
  const y = (price) => height - padding - ((price - min) / range) * (height - padding * 2);

  svg.innerHTML = visible.map((candle, index) => {
    const x = padding + index * slot + slot / 2;
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const highY = y(candle.high);
    const lowY = y(candle.low);
    const bodyY = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(openY - closeY));
    const directionClass = candle.close >= candle.open ? "candle-up" : "candle-down";

    return `
      <line class="candle-wick ${directionClass}" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${highY.toFixed(2)}" y2="${lowY.toFixed(2)}"></line>
      <rect class="candle-body ${directionClass}" x="${(x - bodyWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}"></rect>
    `;
  }).join("");
}

function inferRegime(candles) {
  if (candles.length < 12) return "Building";
  const recent = candles.slice(-12);
  const first = recent[0].open;
  const last = recent[recent.length - 1].close;
  const move = ((last - first) / first) * 100;

  if (move > 1.2) return "Trend up";
  if (move < -1.2) return "Trend down";
  return "Range";
}

function renderSubscription() {
  if (!state.subscription) return;
  document.querySelector("#trial-count").textContent = `${state.subscription.trialSignalsRemaining} signals left`;
}

function renderSignals() {
  document.querySelector("#signal-count").textContent = `${state.signals.length} setups`;

  if (state.signals.length === 0) {
    signalsGrid.innerHTML = `<article class="signal-card"><p class="reasoning">Generated setups will appear here with entry, stop, target, confidence, and concise reasoning.</p></article>`;
    return;
  }

  signalsGrid.innerHTML = state.signals.map((signal) => renderSignalCard(signal)).join("");
}

function renderSignalsHistory() {
  const filtered = state.signals.filter((signal) => {
    return (state.historyFilters.pair === "all" || signal.symbol === state.historyFilters.pair) &&
      (state.historyFilters.timeframe === "all" || signal.timeframe === state.historyFilters.timeframe) &&
      (state.historyFilters.direction === "all" || signal.direction === state.historyFilters.direction);
  });

  historyCount.textContent = `${filtered.length} saved`;

  if (state.signals.length === 0) {
    signalsHistory.innerHTML = `
      <div class="empty-state">
        <strong>No saved signals yet</strong>
        <p class="reasoning">Unlock a setup from Scan All or Unlock Current to save it in your Signals history.</p>
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    signalsHistory.innerHTML = `
      <div class="empty-state">
        <strong>No signals match these filters</strong>
        <p class="reasoning">Adjust pair, timeframe, or direction to see saved signals.</p>
      </div>
    `;
    return;
  }

  signalsHistory.innerHTML = `
    <table class="signals-table">
      <thead>
        <tr>
          <th>Pair</th>
          <th>TF</th>
          <th>Direction</th>
          <th>Entry</th>
          <th>Stop</th>
          <th>Take profit</th>
          <th>R/R</th>
          <th>Confidence</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${filtered.map((signal) => `
        ${renderSignalHistoryRow(signal)}
        <tr class="history-transparency">
          <td colspan="10">${renderSignalTransparency(signal)}</td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function renderPerformanceStats() {
  statTotal.textContent = `${state.signalStats.totalSignals || 0}`;
  statWinRate.textContent = `${state.signalStats.winRate || 0}%`;
  statHitTp.textContent = `${state.signalStats.hitTpCount || 0}`;
  statHitSl.textContent = `${state.signalStats.hitSlCount || 0}`;
  statExpired.textContent = `${state.signalStats.expiredCount || 0}`;
}

function renderSignalHistoryRow(signal) {
  const status = getDemoSignalStatus(signal);

  return `
    <tr>
      <td><strong>${signal.symbol}</strong></td>
      <td>${signal.timeframe}</td>
      <td><strong class="direction ${signal.direction}">${signal.direction}</strong></td>
      <td>${formatCurrency(signal.entryPrice)}</td>
      <td>${formatCurrency(signal.stopLoss)}</td>
      <td>${formatCurrency(signal.takeProfit)}</td>
      <td>${signal.riskRewardRatio}:1</td>
      <td>${signal.confidenceScore}%</td>
      <td><span class="status-pill ${status.className}">${status.label}</span></td>
      <td>${formatDateTime(signal.generatedAt)}</td>
    </tr>
  `;
}

function getDemoSignalStatus(signal) {
  if (signal.status) {
    const normalized = signal.status.toLowerCase().replaceAll(" ", "-");
    const labels = {
      active: "Active",
      "hit-tp": "Hit TP",
      "hit-sl": "Hit SL",
      expired: "Expired"
    };

    return {
      label: labels[normalized] || "Active",
      className: `status-${normalized}`
    };
  }

  const ageMinutes = (Date.now() - new Date(signal.generatedAt).getTime()) / 60000;

  if (ageMinutes > 240) {
    return { label: "Expired", className: "status-expired" };
  }

  return { label: "Active", className: "status-active" };
}

function renderNoSetup(analysis) {
  const rows = (analysis?.candidates || []).flatMap((candidate) => {
    return candidate.confirmations.map((item) => `
      <div>
        <span>${candidate.direction.toUpperCase()} · ${item.name}</span>
        <strong>${item.passed ? "Passed" : "Failed"}</strong>
      </div>
    `);
  }).join("");

  signalsGrid.innerHTML = `
    <article class="signal-card">
      <div class="signal-top">
        <div>
          <strong>No valid setup found</strong>
          <span>${state.selectedPair?.symbol || ""} ${state.timeframe}</span>
        </div>
      </div>
      <p class="reasoning">${analysis?.message || "Conditions are too weak for a rule-based setup."}</p>
      <div class="signal-metrics">${rows}</div>
      <div class="signal-disclaimer">
        <strong>Educational tool only. Not financial advice.</strong>
        <span>No trial credit was used for this analysis.</span>
      </div>
    </article>
    ${state.signals.map((signal) => renderSignalCard(signal)).join("")}
  `;
}

function updateScanProgress(done, total, message) {
  scanProgressText.textContent = message;
  scanProgressCount.textContent = `${done}/${total}`;
  scanProgressBar.max = total;
  scanProgressBar.value = done;
  statusLine.textContent = message;
}

function renderScanResults(setups, errors) {
  document.querySelector("#signal-count").textContent = `${setups.length} scan results`;
  const scannedMarkets = state.pairs
    .concat(state.marketCatalog)
    .filter((pair, index, pairs) => pairs.findIndex((item) => item.symbol === pair.symbol) === index)
    .filter((pair) => pair.status === "active")
    .map((pair) => pair.symbol)
    .join(" · ");

  if (setups.length === 0) {
    signalsGrid.innerHTML = `
      <article class="signal-card">
        <div class="signal-top">
          <div>
            <strong>No high-probability setups right now</strong>
            <span>${scannedMarkets}</span>
          </div>
        </div>
        <p class="reasoning">${errors.length ? `${errors.length} market checks had provider errors; successful checks found no valid setups.` : "All active markets and timeframes were scanned without using trial credits."}</p>
      </article>
    `;
    statusLine.textContent = "No high-probability setups right now. Trial credits were not used.";
    return;
  }

  signalsGrid.innerHTML = setups.map((setup) => renderScanCard(setup)).join("");
  statusLine.textContent = `Found ${setups.length} high-probability setup${setups.length === 1 ? "" : "s"}. Unlocking one will use a trial credit.`;
}

function renderScanCard(setup) {
  const passed = setup.confirmations.filter((item) => item.passed).map((item) => item.name).join(", ");

  return `
    <article class="signal-card">
      <div class="signal-top">
        <div>
          <strong>${setup.symbol}</strong>
          <span>${setup.timeframe}</span>
        </div>
        <strong class="direction ${setup.direction}">${setup.direction}</strong>
      </div>
      <div class="signal-metrics">
        <div><span>Confidence</span><strong>${setup.confidenceScore}%</strong></div>
        <div><span>Risk/reward</span><strong>${setup.riskRewardRatio}:1</strong></div>
        <div><span>Passed</span><strong>${setup.confirmations.filter((item) => item.passed).length}/${setup.confirmations.length}</strong></div>
        <div><span>Status</span><strong>Locked</strong></div>
      </div>
      <p class="reasoning">Passed confirmations: ${passed}. Unlock the full signal to save entry, stop loss, and take profit.</p>
      ${renderSignalTransparency(setup)}
      <button class="secondary-action" data-unlock-symbol="${setup.symbol}" data-unlock-timeframe="${setup.timeframe}" type="button">Unlock Signal</button>
    </article>
  `;
}

function renderSignalCard(signal) {
  return `
    <article class="signal-card">
      <div class="signal-top">
        <div>
          <strong>${signal.symbol}</strong>
          <span>${signal.timeframe}</span>
        </div>
        <strong class="direction ${signal.direction}">${signal.direction}</strong>
      </div>
      <div class="signal-metrics">
        <div><span>Entry</span><strong>${formatCurrency(signal.entryPrice)}</strong></div>
        <div><span>Stop loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div>
        <div><span>Take profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div>
        <div><span>Risk/reward</span><strong>${signal.riskRewardRatio}:1</strong></div>
        <div><span>Confidence</span><strong>${signal.confidenceScore}%</strong></div>
        <div><span>Generated</span><strong>${formatTime(signal.generatedAt)}</strong></div>
      </div>
      <p class="reasoning">${signal.reasoning}</p>
      ${renderSignalTransparency(signal)}
    </article>
  `;
}

function renderSignalTransparency(signal) {
  const confirmations = normalizeConfirmations(signal.confirmations || [], signal.indicators || {});
  const passedCount = confirmations.filter((item) => item.passed).length;
  const totalCount = confirmations.length;
  const alignment = totalCount ? Math.round((passedCount / totalCount) * 100) : 0;
  const confidence = Number(signal.confidenceScore || 0);

  return `
    <section class="signal-transparency">
      <h4>Why this signal?</h4>
      <div class="confidence-breakdown">
        <span>Confidence ${confidence}%</span>
        <div class="confidence-track" aria-label="${confidence}% confidence">
          <span style="width: ${Math.min(100, Math.max(0, confidence))}%"></span>
        </div>
        <strong>${passedCount}/${totalCount} checks · ${alignment}% aligned</strong>
      </div>
      <p class="reasoning">Confidence summarizes rule alignment and setup quality. It is not a forecast or probability of profit.</p>
      <div class="confirmation-list">
        ${confirmations.map((item) => `
          <div class="confirmation-item ${item.passed ? "passed" : "failed"}">
            <strong>${item.passed ? "Passed" : "Failed"} · ${item.name}</strong>
            <span>${item.detail}</span>
          </div>
        `).join("")}
      </div>
      <p class="risk-guidance"><strong>Risk per trade:</strong> Define a consistent maximum loss before entering, size the position from the stop distance, and avoid risking capital you cannot afford to lose.</p>
      <div class="signal-disclaimer">
        <strong>Educational tool only. Not financial advice.</strong>
        <span>Review the market and your own risk limits before making any decision.</span>
      </div>
    </section>
  `;
}

function normalizeConfirmations(confirmations, indicators) {
  const grouped = new Map();

  for (const item of confirmations) {
    const name = getConfirmationGroup(item.name);
    const existing = grouped.get(name);

    if (!existing) {
      grouped.set(name, {
        name,
        passed: Boolean(item.passed),
        detail: item.detail || "No additional detail available."
      });
      continue;
    }

    existing.passed = existing.passed && Boolean(item.passed);
    existing.detail = `${existing.detail} ${item.detail || ""}`.trim();
  }

  const required = ["Trend", "RSI", "ATR", "Support/resistance"];

  for (const name of required) {
    if (grouped.has(name)) {
      continue;
    }

    if (name === "ATR" && Number.isFinite(Number(indicators.atr14))) {
      grouped.set(name, {
        name,
        passed: Number(indicators.atr14) > 0,
        detail: `ATR14 was ${indicators.atr14}; this value was used to frame stop and target distances.`
      });
      continue;
    }

    grouped.set(name, {
      name,
      passed: false,
      detail: "This confirmation was not recorded for this earlier signal."
    });
  }

  const displayOrder = ["Trend", "RSI", "ATR", "Support/resistance", "Volume"];
  return [...grouped.values()].sort((a, b) => {
    const aIndex = displayOrder.indexOf(a.name);
    const bIndex = displayOrder.indexOf(b.name);
    return (aIndex === -1 ? displayOrder.length : aIndex) -
      (bIndex === -1 ? displayOrder.length : bIndex);
  });
}

function getConfirmationGroup(name = "") {
  const normalized = name.toLowerCase();

  if (normalized.includes("support") || normalized.includes("resistance")) {
    return "Support/resistance";
  }

  if (normalized.includes("ema")) return "Trend";
  if (normalized.includes("trend")) return "Trend";
  if (normalized.includes("rsi")) return "RSI";
  if (normalized.includes("atr")) return "ATR";
  if (normalized.includes("volume")) return "Volume";
  return name;
}

function renderWatchlist() {
  watchlistCount.textContent = `${state.watchlist.length} market${state.watchlist.length === 1 ? "" : "s"}`;

  if (!state.watchlist.length) {
    watchlistGrid.innerHTML = `
      <div class="empty-state">
        <strong>Your watchlist is empty</strong>
        <p class="reasoning">Select an active crypto or commodity market in the scanner, then use the star button.</p>
      </div>
    `;
    return;
  }

  watchlistGrid.innerHTML = state.watchlist.map((item) => {
    const preference = item.preference || {
      timeframe: "1h",
      direction: "both",
      minimumConfidence: 75
    };

    return `
      <article class="watchlist-item" data-watchlist-symbol="${item.symbol}">
        <div class="watchlist-item-header">
          <div>
            <strong>${item.symbol}</strong>
            <p class="reasoning">${item.preference ? "Alert active" : "Favorite market"}</p>
          </div>
          <button class="icon-action active" data-watchlist-remove="${item.symbol}" type="button" title="Remove from watchlist" aria-label="Remove ${item.symbol} from watchlist">★</button>
        </div>
        <div class="alert-preferences">
          <label>
            Timeframe
            <select data-alert-timeframe>
              ${["5m", "15m", "1h", "4h"].map((frame) => `<option value="${frame}" ${preference.timeframe === frame ? "selected" : ""}>${frame}</option>`).join("")}
            </select>
          </label>
          <label>
            Direction
            <select data-alert-direction>
              ${["long", "short", "both"].map((direction) => `<option value="${direction}" ${preference.direction === direction ? "selected" : ""}>${direction[0].toUpperCase()}${direction.slice(1)}</option>`).join("")}
            </select>
          </label>
          <label>
            Minimum confidence
            <input data-alert-confidence type="number" min="0" max="100" step="1" value="${preference.minimumConfidence}" />
          </label>
        </div>
        <button class="secondary-action" data-alert-save="${item.symbol}" type="button">Save Alert Preference</button>
      </article>
    `;
  }).join("");
}

function renderAlerts() {
  alertsCount.textContent = `${state.alerts.length} alert${state.alerts.length === 1 ? "" : "s"}`;

  if (!state.alerts.length) {
    alertsGrid.innerHTML = `
      <div class="empty-state">
        <strong>No alerts detected yet</strong>
        <p class="reasoning">Save alert preferences in your Watchlist, then run Scan All to detect matching setups.</p>
      </div>
    `;
    return;
  }

  alertsGrid.innerHTML = state.alerts.map((alert) => `
    <article class="alert-item ${alert.readAt ? "" : "unread"}">
      <div class="alert-item-header">
        <div>
          <strong>${alert.symbol} · ${alert.timeframe}</strong>
          <p class="reasoning">${formatDateTime(alert.detectedAt)}</p>
        </div>
        <div>
          ${alert.readAt ? "" : `<span class="unread-label">New</span>`}
          <strong class="direction ${alert.direction}">${alert.direction}</strong>
        </div>
      </div>
      <div class="signal-metrics">
        <div><span>Confidence</span><strong>${alert.confidenceScore}%</strong></div>
        <div><span>Risk/reward</span><strong>${alert.riskRewardRatio}:1</strong></div>
      </div>
      <p class="reasoning">${alert.reasoning}</p>
      ${renderSignalTransparency(alert)}
      <div class="alert-actions">
        ${alert.readAt ? "" : `<button class="secondary-action" data-alert-read="${alert.id}" type="button">Mark Read</button>`}
        <button data-alert-unlock="${alert.symbol}" data-alert-timeframe="${alert.timeframe}" type="button">Unlock Full Signal</button>
      </div>
    </article>
  `).join("");
}

function renderUnreadAlertCount() {
  unreadAlertCount.textContent = `${state.unreadAlertCount}`;
  unreadAlertCount.classList.toggle("hidden", state.unreadAlertCount === 0);
}

function renderNotifications() {
  const { configured, connected, botUsername, settings } = state.notifications;
  const providerStatus = document.querySelector("#telegram-provider-status");
  const connectionStatus = document.querySelector("#telegram-connection-status");
  const connectHelp = document.querySelector("#telegram-connect-help");

  providerStatus.textContent = configured ? "Bot ready" : "Not configured";
  providerStatus.className = `status-pill ${configured ? "status-hit-tp" : "status-expired"}`;
  connectionStatus.textContent = connected
    ? settings.enabled ? "Connected · Enabled" : "Connected · Disabled"
    : "Not connected";
  connectHelp.textContent = botUsername
    ? `Start @${botUsername}, obtain your numeric chat ID, then connect it here.`
    : "Start the configured SignalForge bot, obtain your numeric chat ID, then connect it here.";

  telegramConnectButton.disabled = !configured || connected;
  telegramConnectButton.textContent = connected ? "Telegram Connected" : "Connect Telegram";
  telegramConnectForm.querySelector("button").disabled = !configured;
  telegramPreferencesForm.querySelector("button").disabled = !connected;
  telegramEnabled.disabled = !connected;
  telegramTestButton.classList.toggle("hidden", !connected);

  if (!settings) {
    telegramEnabled.checked = false;
    if (!configured) {
      setTelegramConnectionFeedback("Telegram bot not configured", "error");
    }
    return;
  }

  telegramChatId.value = settings.chatId;
  telegramEnabled.checked = settings.enabled;
  telegramDirection.value = settings.direction;
  telegramMinimumConfidence.value = settings.minimumConfidence;

  document.querySelectorAll('input[name="telegram-timeframe"]').forEach((input) => {
    input.checked = settings.timeframes.includes(input.value);
  });

  setTelegramConnectionFeedback("Connected successfully", "success");
}

function getSelectedTelegramTimeframes() {
  return [...document.querySelectorAll('input[name="telegram-timeframe"]:checked')]
    .map((input) => input.value);
}

function startTelegramConnectionStatusPolling() {
  if (telegramConnectionTimer) {
    clearInterval(telegramConnectionTimer);
  }

  const checkStatus = async () => {
    try {
      const connection = await api.request("/api/notifications/telegram/connect/status");

      if (connection.status === "waiting") {
        setTelegramConnectionFeedback("Waiting for Telegram confirmation", "waiting");
        telegramConnectionCode.textContent = connection.code;
        telegramStartCommand.textContent = `/start ${connection.code}`;
        if (connection.botUrl) {
          telegramOpenBotLink.href = connection.botUrl;
        }
        telegramConnectionPanel.classList.remove("hidden");
        return;
      }

      if (connection.status === "connected") {
        clearInterval(telegramConnectionTimer);
        telegramConnectionTimer = null;
        setTelegramConnectionFeedback("Connected successfully", "success");
        await loadNotifications();
        telegramStatusLine.textContent = "Connected successfully. Alerts remain disabled until you enable them.";
        return;
      }

      if (["invalid", "expired", "failed"].includes(connection.status)) {
        clearInterval(telegramConnectionTimer);
        telegramConnectionTimer = null;
        setTelegramConnectionFeedback(
          connection.status === "invalid" ? "Invalid code" : "Connection failed",
          "error"
        );
        telegramStatusLine.textContent = connection.message;
        telegramConnectButton.disabled = false;
        telegramConnectButton.textContent = "Connect Telegram";
      }
    } catch (error) {
      clearInterval(telegramConnectionTimer);
      telegramConnectionTimer = null;
      setTelegramConnectionFeedback("Connection failed", "error");
      telegramStatusLine.textContent = error.message;
      telegramConnectButton.disabled = false;
      telegramConnectButton.textContent = "Connect Telegram";
    }
  };

  checkStatus();
  telegramConnectionTimer = setInterval(checkStatus, 2000);
}

function setTelegramConnectionFeedback(message, type = "") {
  telegramConnectionMessage.textContent = message;
  telegramConnectionMessage.className = `connection-status ${type}`.trim();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard unavailable.");
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 1000 ? 2 : 4
  }).format(value);
}

function formatPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

init().catch(() => {
  landingPage.classList.remove("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
});
