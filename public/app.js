const state = {
  user: null,
  subscription: null,
  marketCatalog: [],
  pairs: [],
  selectedPair: null,
  timeframe: "15m",
  marketData: null,
  marketStatus: {},
  scannerMode: getStoredScannerMode(),
  navSections: getStoredNavSections(),
  expandedSignalKeys: new Set(),
  lastScanSummary: null,
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
  scanResults: [],
  watchlist: [],
  alerts: [],
  unreadAlertCount: 0,
  notifications: {
    configured: false,
    connected: false,
    botUsername: "",
    settings: null
  },
  testerAccess: null,
  affiliate: null,
  affiliateAdmin: {
    affiliates: [],
    referrals: [],
    payouts: []
  },
  webhookEvents: [],
  referralCode: getStoredAffiliateCode(),
  adminRequests: [],
  abuseDashboard: {
    flaggedAccounts: [],
    accountsPerIp: [],
    repeatedDevices: [],
    disposableEmails: []
  },
  adminAnalytics: null,
  performance: null,
  paperPortfolio: {
    trades: [],
    stats: {
      totalPaperTrades: 0,
      winRate: 0,
      averageR: 0,
      bestMarket: null,
      bestTimeframe: null
    }
  },
  journal: {
    entries: [],
    stats: {
      averageTradeRating: 0,
      mostCommonEmotion: null,
      bestPerformingMarket: null,
      bestPerformingTimeframe: null
    }
  },
  backtesting: null
};

const RESTORE_TOKEN_KEY = "signalforge-restore-token";
const SCANNER_MODE_KEY = "signalforge-scanner-mode";
const NAV_SECTIONS_KEY = "signalforge-nav-sections";

const authScreen = document.querySelector("#auth-screen");
const landingPage = document.querySelector("#landing-page");
const dashboard = document.querySelector("#dashboard");
const appSplash = document.querySelector("#app-splash");
const appSplashStatus = document.querySelector("#app-splash-status");
const installAppButton = document.querySelector("#install-app-button");
const mobileMenuToggle = document.querySelector("#mobile-menu-toggle");
const sidebar = document.querySelector(".sidebar");
const authForm = document.querySelector("#auth-form");
const authNote = document.querySelector("#auth-note");
const legalConsent = document.querySelector("#legal-consent");
const legalModal = document.querySelector("#legal-modal");
const legalModalTitle = document.querySelector("#legal-modal-title");
const legalModalBody = document.querySelector("#legal-modal-body");
const googleAuthButton = document.querySelector("#google-auth-button");
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
const scanSummaryPanel = document.querySelector("#scan-summary-panel");
const viewOpportunitiesButton = document.querySelector("#view-opportunities-button");
const scannerModeToggle = document.querySelector("#scanner-mode-toggle");
const statusLine = document.querySelector("#status-line");
const signalsGrid = document.querySelector("#signals-grid");
const paperPortfolioGrid = document.querySelector("#paper-portfolio-grid");
const paperTradeCount = document.querySelector("#paper-trade-count");
const journalFilters = document.querySelector("#journal-filters");
const journalFrom = document.querySelector("#journal-from");
const journalTo = document.querySelector("#journal-to");
const journalMarket = document.querySelector("#journal-market");
const journalTimeframe = document.querySelector("#journal-timeframe");
const journalEmotion = document.querySelector("#journal-emotion");
const journalClear = document.querySelector("#journal-clear");
const journalList = document.querySelector("#journal-list");
const journalEntryCount = document.querySelector("#journal-entry-count");
const backtestingLabForm = document.querySelector("#backtesting-lab-form");
const labStatus = document.querySelector("#lab-status");
const labEvaluation = document.querySelector("#lab-evaluation");
const labEmptyState = document.querySelector("#lab-empty-state");
const labLoadingState = document.querySelector("#lab-loading-state");
const labResults = document.querySelector("#lab-results");
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
const testerAccountBadge = document.querySelector("#tester-account-badge");
const accountRoleLabel = document.querySelector("#account-role-label");
const testerRequestStatus = document.querySelector("#tester-request-status");
const requestTesterAccessButton = document.querySelector("#request-tester-access");
const testerAccessMessage = document.querySelector("#tester-access-message");
const adminNavLink = document.querySelector("#admin-nav-link");
const affiliateAdminNavLink = document.querySelector("#affiliate-admin-nav-link");
const webhookEventsNavLink = document.querySelector("#webhook-events-nav-link");
const adminRequestList = document.querySelector("#admin-request-list");
const adminRequestCount = document.querySelector("#admin-request-count");
const verificationNote = document.querySelector("#verification-note");
const resendVerificationButton = document.querySelector("#resend-verification");
const billingCurrentPlan = document.querySelector("#billing-current-plan");
const billingDiscoveryCredits = document.querySelector("#billing-discovery-credits");
const billingUnlockCredits = document.querySelector("#billing-unlock-credits");
const billingPlanGrid = document.querySelector("#billing-plan-grid");
const billingPackGrid = document.querySelector("#billing-pack-grid");
const billingStatus = document.querySelector("#billing-status");
const manageSubscriptionButton = document.querySelector("#manage-subscription-button");
const affiliateLink = document.querySelector("#affiliate-link");
const affiliateStatus = document.querySelector("#affiliate-status");
const affiliatePayoutForm = document.querySelector("#affiliate-payout-form");
const affiliatePayoutButton = document.querySelector("#affiliate-payout-button");
const affiliateReferrals = document.querySelector("#affiliate-referrals");
const affiliatePayouts = document.querySelector("#affiliate-payouts");
const affiliateAdminAccounts = document.querySelector("#affiliate-admin-accounts");
const affiliateAdminReferrals = document.querySelector("#affiliate-admin-referrals");
const affiliateAdminPayouts = document.querySelector("#affiliate-admin-payouts");
const webhookEventList = document.querySelector("#webhook-event-list");
const webhookEventSummary = document.querySelector("#webhook-event-summary");
const backtestForm = document.querySelector("#backtest-form");
const backtestSymbol = document.querySelector("#backtest-symbol");
const backtestTimeframe = document.querySelector("#backtest-timeframe");
const backtestStatus = document.querySelector("#backtest-status");
const backtestOutput = document.querySelector("#backtest-output");
const performanceFilters = document.querySelector("#performance-filters");
const performanceFrom = document.querySelector("#performance-from");
const performanceTo = document.querySelector("#performance-to");
const performanceMarket = document.querySelector("#performance-market");
const performanceTimeframe = document.querySelector("#performance-timeframe");
const performanceDirection = document.querySelector("#performance-direction");
const performanceClear = document.querySelector("#performance-clear");
let marketRequestId = 0;
let signalRefreshTimer = null;
let marketLoadTimer = null;
let telegramConnectionTimer = null;
let billingRefreshTimer = null;
let deferredInstallPrompt = null;

const legalDocuments = {
  terms: {
    title: "Terms",
    body: `
      <p>SignalForge provides market research tools, scanners, alerts, backtesting, paper trading, and educational analytics. You are responsible for how you use the information shown in the app.</p>
      <p>SignalForge does not place trades, connect to brokers, manage money, or provide personalized investment recommendations. You agree not to misuse the service, bypass usage limits, abuse trials, or rely on SignalForge as your sole basis for trading decisions.</p>
      <p>Subscriptions, unlock credits, affiliate links, and notifications are provided subject to availability and may change as the product evolves.</p>
    `
  },
  privacy: {
    title: "Privacy Policy",
    body: `
      <p>SignalForge stores account information needed to operate the service, including your email, authentication records, credit balances, saved signals, alerts, journal entries, affiliate attribution, and subscription status.</p>
      <p>Payment information is handled by Stripe. Telegram alerts require Telegram connection details. Google sign-in is validated on the backend before an account is created or linked.</p>
      <p>We use security and anti-abuse signals such as IP-derived hashes and device fingerprints to protect free trials and subscriptions. We do not sell personal trading history.</p>
    `
  },
  risk: {
    title: "Risk Disclaimer",
    body: `
      <p><strong>Educational tool only. Not financial advice.</strong></p>
      <p>Trading crypto, commodities, stocks, ETFs, or any other market involves substantial risk. You can lose money. SignalForge confidence scores and setup quality labels describe rule alignment, not a probability of profit.</p>
      <p>Backtests, paper trading, alerts, and historical outcomes may exclude fees, slippage, liquidity constraints, execution quality, and future market changes. Past or simulated performance does not guarantee future results.</p>
      <p>Affiliate disclosure: Affiliates may earn commissions from paid subscriptions.</p>
    `
  }
};

const api = {
  async request(path, options = {}) {
    const optionHeaders = options.headers || {};
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-device-fingerprint": getDeviceFingerprint(),
        ...optionHeaders
      }
    });
    const payload = await response.json();

    if (!response.ok) {
      const error = new Error(payload.error?.message || "Request failed.");
      error.statusCode = response.status;
      error.details = payload.error?.details;
      throw error;
    }

    return payload;
  }
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  console.info("[pwa] Install prompt is available.");
  updateInstallButtonVisibility();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  console.info("[pwa] App installation completed.");
  updateInstallButtonVisibility();
});

installAppButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installAppButton.disabled = true;
  try {
    await deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updateInstallButtonVisibility();
  } finally {
    installAppButton.disabled = false;
  }
});

window.matchMedia("(display-mode: standalone)")
  .addEventListener?.("change", updateInstallButtonVisibility);

function updateInstallButtonVisibility() {
  const alreadyInstalled = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  installAppButton.classList.toggle("hidden", alreadyInstalled || !deferredInstallPrompt);
}

function openLegalDocument(documentKey) {
  const legalDocument = legalDocuments[documentKey];
  if (!legalDocument) return;

  legalModalTitle.textContent = legalDocument.title;
  legalModalBody.innerHTML = legalDocument.body;
  legalModal.classList.remove("hidden");
}

function closeLegalDocument() {
  legalModal.classList.add("hidden");
}

document.querySelector("#start-free-button").addEventListener("click", () => {
  showAuth();
});

document.querySelector("#landing-login-button").addEventListener("click", () => {
  showAuth();
});

document.querySelectorAll(".launch-auth-button").forEach((button) => {
  button.addEventListener("click", () => {
    showAuth();
  });
});

document.querySelectorAll("[data-legal-doc]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    openLegalDocument(trigger.dataset.legalDoc);
  });
});

document.querySelectorAll("[data-legal-close]").forEach((trigger) => {
  trigger.addEventListener("click", closeLegalDocument);
});

scannerModeToggle.addEventListener("change", () => {
  state.scannerMode = scannerModeToggle.checked ? "advanced" : "basic";
  localStorage.setItem(SCANNER_MODE_KEY, state.scannerMode);
  renderSignals();
});

viewOpportunitiesButton.addEventListener("click", () => {
  scrollToSignalDesk();
});

viewDemoButton.addEventListener("click", async () => {
  try {
    const { user, restore } = await api.request("/api/auth/demo", { method: "POST" });
    saveRestoreToken(restore);
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
  const credentials = Object.fromEntries(form);
  credentials.affiliateCode = state.referralCode;
  credentials.legalConsentAccepted = legalConsent.checked;

  try {
    authNote.textContent = "Authenticating...";
    const result = await api.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials)
    });
    saveRestoreToken(result.restore);
    state.user = result.user;
    if (result.verificationRequired) {
      authNote.textContent = result.developmentVerificationUrl
        ? `Verify your email to activate free signals. Development link: ${result.developmentVerificationUrl}`
        : "Check your email to activate your free signals.";
    }
    await bootDashboard();
  } catch (error) {
    authNote.textContent = error.message;
  }
});

googleAuthButton.addEventListener("click", async () => {
  if (!legalConsent.checked) {
    authNote.textContent = "Agree to the Terms, Privacy Policy, and Risk Disclaimer before creating or connecting an account.";
    return;
  }

  try {
    googleAuthButton.disabled = true;
    authNote.textContent = "Opening Google sign-in...";
    const { authorizationUrl } = await api.request("/api/auth/google/start", {
      method: "POST",
      body: JSON.stringify({
        affiliateCode: state.referralCode,
        legalConsentAccepted: true
      })
    });
    location.assign(authorizationUrl);
  } catch (error) {
    authNote.textContent = error.message;
    googleAuthButton.disabled = false;
  }
});

resendVerificationButton.addEventListener("click", async () => {
  try {
    resendVerificationButton.disabled = true;
    const result = await api.request("/api/auth/resend-verification", { method: "POST" });
    verificationNote.textContent = result.developmentVerificationUrl
      ? `Development verification link: ${result.developmentVerificationUrl}`
      : "Verification email sent.";
  } catch (error) {
    verificationNote.textContent = error.message;
  } finally {
    resendVerificationButton.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await api.request("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({ restoreToken: getRestoreToken() })
    });
  } finally {
    clearClientAuthState();
  }
  landingPage.classList.remove("hidden");
  dashboard.classList.add("hidden");
  authScreen.classList.add("hidden");
});

document.querySelector("#upgrade-button").addEventListener("click", async () => {
  showView("billing");
});

billingPlanGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-billing-plan]");
  if (button) await startCheckout(button, { plan: button.dataset.billingPlan });
});

billingPackGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-billing-pack]");
  if (button) await startCheckout(button, { pack: button.dataset.billingPack });
});

manageSubscriptionButton.addEventListener("click", async () => {
  try {
    manageSubscriptionButton.disabled = true;
    billingStatus.textContent = "Opening Stripe billing portal...";
    const { portal } = await api.request("/api/subscriptions/portal", { method: "POST" });
    location.assign(portal.url);
  } catch (error) {
    billingStatus.textContent = error.message;
    manageSubscriptionButton.disabled = false;
  }
});

document.querySelector("#copy-affiliate-link").addEventListener("click", async () => {
  try {
    await copyText(state.affiliate?.affiliateLink || "");
    affiliateStatus.textContent = "Affiliate link copied.";
  } catch (error) {
    affiliateStatus.textContent = error.message;
  }
});

affiliatePayoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(affiliatePayoutForm);
  try {
    affiliatePayoutButton.disabled = true;
    affiliateStatus.textContent = "Submitting payout request...";
    const result = await api.request("/api/affiliates/payouts", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form))
    });
    state.affiliate = result.affiliate;
    affiliatePayoutForm.reset();
    renderAffiliate();
    affiliateStatus.textContent = "Payout request submitted for admin approval.";
  } catch (error) {
    affiliateStatus.textContent = error.message;
  } finally {
    affiliatePayoutButton.disabled = Boolean(state.affiliate?.disabled);
  }
});

document.querySelector("#affiliate-admin-view").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-affiliate-admin-action]");
  if (!button) return;

  try {
    button.disabled = true;
    const action = button.dataset.affiliateAdminAction;
    let path;
    let body;
    if (action === "approve-payout" || action === "reject-payout") {
      path = `/api/admin/affiliates/payouts/${button.dataset.payoutId}`;
      body = { decision: action === "approve-payout" ? "approved" : "rejected" };
    } else if (action === "flag-referral" || action === "clear-referral") {
      path = `/api/admin/affiliates/referrals/${button.dataset.referralId}`;
      body = {
        suspicious: action === "flag-referral",
        reason: action === "flag-referral" ? "Flagged for manual review by admin" : ""
      };
    } else {
      path = `/api/admin/affiliates/accounts/${button.dataset.affiliateUserId}`;
      body = { disabled: action === "disable-affiliate" };
    }
    const result = await api.request(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    state.affiliateAdmin = result.affiliateAdmin;
    renderAffiliateAdmin();
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

document.querySelector("#webhook-events-view").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-webhook-retry]");
  if (!button) return;

  try {
    button.disabled = true;
    button.textContent = "Retrying...";
    const result = await api.request(
      `/api/admin/stripe/webhooks/${encodeURIComponent(button.dataset.webhookRetry)}/retry`,
      { method: "POST", body: "{}" }
    );
    state.webhookEvents = result.events || [];
    renderWebhookEvents();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
});

mobileMenuToggle.addEventListener("click", () => {
  setMobileNavigationOpen(!dashboard.classList.contains("mobile-nav-open"));
});

dashboard.addEventListener("click", (event) => {
  const clickedBackdrop = dashboard.classList.contains("mobile-nav-open") &&
    window.matchMedia("(max-width: 767px)").matches &&
    !sidebar.contains(event.target) &&
    !mobileMenuToggle.contains(event.target);
  if (clickedBackdrop) setMobileNavigationOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMobileNavigationOpen(false);
  if (event.key === "Escape") closeLegalDocument();
});

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 767px)").matches) {
    setMobileNavigationOpen(false);
  }
});

document.querySelectorAll("[data-view-link]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showView(link.dataset.viewLink);
    setMobileNavigationOpen(false);
  });
});

document.querySelectorAll("[data-nav-section-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.dataset.navSectionToggle;
    state.navSections[section] = !state.navSections[section];
    localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify(state.navSections));
    renderNavSections();
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
  let progressTimer = null;
  let progressIndex = 0;

  scanAllButton.disabled = true;
  generateButton.disabled = true;
  scanProgress.classList.remove("hidden");
  scanSummaryPanel.classList.add("hidden");
  state.scanResults = [];
  signalsGrid.innerHTML = "";
  updateScanProgress(0, total, "Scanning all active crypto and commodity markets...");
  progressTimer = setInterval(() => {
    if (progressIndex >= total - 1) return;
    const symbol = symbols[Math.floor(progressIndex / frames.length)] || symbols[0] || "market";
    const timeframe = frames[progressIndex % frames.length] || "timeframe";
    progressIndex += 1;
    updateScanProgress(
      progressIndex,
      total,
      `Scanning ${symbol} ${timeframe} · found ${state.lastScanSummary?.opportunitiesFound || 0} opportunities so far`
    );
  }, 180);

  try {
    const result = await api.request("/api/signals/scan-all", { method: "POST" });
    state.subscription = result.subscription || state.subscription;
    renderSubscription();
    updateScanProgress(total, total, "Market scan complete");
    await loadAlerts();
    renderScanResults(result.setups, result.errors);
  } catch (error) {
    updateScanProgress(0, total, "Scan All failed");
    renderScanResults([], [{ symbol: "Scan All", timeframe: "", message: error.message }]);
  } finally {
    clearInterval(progressTimer);
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
    const { signal, subscription, analysis, alreadyUnlocked } = await api.request("/api/signals/generate", {
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
      statusLine.textContent = "No valid setup found. No unlock credit was used.";
      return;
    }

    state.scanResults = [];
    state.signals = [signal, ...state.signals];
    await loadSignals();
    renderSignals();
    renderSignalsHistory();
    statusLine.textContent = alreadyUnlocked
      ? "Already unlocked. No additional credit was used."
      : "Setup generated from live OHLCV data. Rule-based only; not financial advice.";
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

requestTesterAccessButton.addEventListener("click", async () => {
  try {
    requestTesterAccessButton.disabled = true;
    testerAccessMessage.textContent = "Submitting tester access request...";
    state.testerAccess = await api.request("/api/tester-access/request", { method: "POST" });
    renderTesterAccess();
    testerAccessMessage.textContent = "Tester access request submitted for review.";
  } catch (error) {
    testerAccessMessage.textContent = error.message;
  } finally {
    renderTesterAccess();
  }
});

adminRequestList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-tester-request-id]");

  if (!button) return;

  try {
    button.disabled = true;
    const result = await api.request(
      `/api/admin/tester-access/${button.dataset.testerRequestId}`,
      {
        method: "POST",
        body: JSON.stringify({ decision: button.dataset.decision })
      }
    );
    state.adminRequests = result.requests;
    renderAdminRequests();
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

backtestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = backtestForm.querySelector("button");

  try {
    submitButton.disabled = true;
    submitButton.textContent = "Running...";
    backtestStatus.textContent = "Loading live candles";
    const query = new URLSearchParams({
      symbol: backtestSymbol.value,
      timeframe: backtestTimeframe.value
    });
    const { backtest } = await api.request(`/api/backtesting?${query}`);
    renderBacktest(backtest);
  } catch (error) {
    backtestStatus.textContent = "Failed";
    backtestStatus.className = "status-pill status-hit-sl";
    backtestOutput.innerHTML = `
      <div class="empty-state">
        <strong>Backtest unavailable</strong>
        <p class="reasoning">${escapeHtml(error.message)}</p>
      </div>
    `;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Run Backtest";
  }
});

performanceFilters.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadPerformance();
});

performanceClear.addEventListener("click", async () => {
  performanceFrom.value = "";
  performanceTo.value = "";
  performanceMarket.value = "";
  performanceTimeframe.value = "";
  performanceDirection.value = "";
  await loadPerformance();
});

journalFilters.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadJournal();
});

journalClear.addEventListener("click", async () => {
  journalFrom.value = "";
  journalTo.value = "";
  journalMarket.value = "";
  journalTimeframe.value = "";
  journalEmotion.value = "";
  await loadJournal();
});

journalList.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-journal-paper-trade]");

  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');

  try {
    button.disabled = true;
    button.textContent = "Saving...";
    const emotionTags = [...form.querySelectorAll('[name="emotion"]:checked')]
      .map((input) => input.value);
    const ratingInput = form.querySelector('[name="rating"]:checked');
    await api.request(
      `/api/journal/${encodeURIComponent(form.dataset.journalPaperTrade)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          notesBeforeEntry: form.querySelector('[name="notesBeforeEntry"]').value,
          notesAfterExit: form.querySelector('[name="notesAfterExit"]').value,
          emotionTags,
          rating: ratingInput ? Number(ratingInput.value) : null,
          screenshotUrl: form.querySelector('[name="screenshotUrl"]').value
        })
      }
    );
    await loadJournal();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
});

backtestingLabForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = backtestingLabForm.querySelector('button[type="submit"]');
  const markets = [...document.querySelectorAll('input[name="lab-market"]:checked')]
    .map((input) => input.value);
  const timeframes = [...document.querySelectorAll('input[name="lab-timeframe"]:checked')]
    .map((input) => input.value);
  const enabledComponents = new Set(
    [...document.querySelectorAll('input[name="lab-component"]:checked')]
      .map((input) => input.value)
  );
  const componentNames = [
    "marketRegime", "multiTimeframe", "ema", "rsi", "adx", "atr", "supportResistance",
    "liquiditySweeps", "fairValueGaps", "orderBlocks", "structure",
    "vwap", "volumeProfile", "correlation"
  ];

  try {
    button.disabled = true;
    button.textContent = "Running...";
    labStatus.textContent = "Loading historical candles";
    labStatus.className = "status-pill status-active";
    labEmptyState.classList.add("hidden");
    labResults.classList.add("hidden");
    labLoadingState.classList.remove("hidden");
    const { backtest } = await api.request("/api/backtesting/run", {
      method: "POST",
      body: JSON.stringify({
        symbols: markets,
        timeframes,
        components: Object.fromEntries(
          componentNames.map((name) => [name, enabledComponents.has(name)])
        )
      })
    });
    state.backtesting = backtest;
    renderBacktestingLab();
  } catch (error) {
    labStatus.textContent = "Failed";
    labStatus.className = "status-pill status-hit-sl";
    labLoadingState.classList.add("hidden");
    labResults.classList.remove("hidden");
    labEvaluation.classList.remove("hidden");
    labEvaluation.innerHTML = `<strong>Backtest unavailable</strong><span>${escapeHtml(error.message)}</span>`;
  } finally {
    labLoadingState.classList.add("hidden");
    button.disabled = false;
    button.textContent = "Run Backtest";
  }
});

document.querySelectorAll('input[name="lab-preset"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      applyBacktestPreset(input.value);
    }
  });
});

paperPortfolioGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-journal]");

  if (!button) return;
  journalMarket.value = button.dataset.journalSymbol;
  journalTimeframe.value = button.dataset.journalTimeframe;
  showView("journal");
});

signalsGrid.addEventListener("click", async (event) => {
  const detailsButton = event.target.closest("[data-signal-details]");

  if (detailsButton) {
    const key = detailsButton.dataset.signalDetails;
    state.expandedSignalKeys = state.expandedSignalKeys.has(key) ? new Set() : new Set([key]);
    renderSignals();
    if (state.expandedSignalKeys.has(key)) {
      scrollToSignalKey(key);
    }
    return;
  }

  const paperButton = event.target.closest("[data-paper-signal-id]");

  if (paperButton) {
    await enterPaperTrade(paperButton);
    return;
  }

  const button = event.target.closest("[data-unlock-symbol]");

  if (!button) {
    return;
  }

  try {
    button.disabled = true;
    statusLine.textContent = `Unlocking ${button.dataset.unlockSymbol} ${button.dataset.unlockTimeframe}...`;
    const { signal, subscription, analysis, alreadyUnlocked } = await api.request("/api/signals/generate", {
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
      statusLine.textContent = "Setup no longer qualifies. No unlock credit was used.";
      return;
    }

    state.signals = [signal, ...state.signals];
    state.expandedSignalKeys = new Set([getSignalKey(signal)]);
    await loadSignals();
    renderSignals();
    renderSignalsHistory();
    statusLine.textContent = alreadyUnlocked
      ? "Already unlocked. No additional credit was used."
      : "Full signal unlocked and saved. Unlock credit deducted.";
    scrollToSignalKey(getSignalKey(signal));
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

signalsGrid.addEventListener("input", (event) => {
  const control = event.target.closest("[data-risk-account], [data-risk-percent]");
  if (control) updateRiskCard(control.closest(".risk-engine-card"));
});

signalsGrid.addEventListener("change", (event) => {
  const control = event.target.closest("[data-risk-account], [data-risk-percent]");
  if (control) updateRiskCard(control.closest(".risk-engine-card"));
});

signalsHistory.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-paper-signal-id]");

  if (button) {
    await enterPaperTrade(button);
  }
});

async function unlockSignal(button, symbol, timeframe) {
  try {
    button.disabled = true;
    statusLine.textContent = `Unlocking ${symbol} ${timeframe}...`;
    const { signal, subscription, analysis, alreadyUnlocked } = await api.request("/api/signals/generate", {
      method: "POST",
      body: JSON.stringify({ symbol, timeframe })
    });

    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "Setup no longer qualifies. No unlock credit was used.";
      return;
    }

    state.scanResults = [];
    state.expandedSignalKeys = new Set([getSignalKey(signal)]);
    await loadSignals();
    renderSignals();
    statusLine.textContent = alreadyUnlocked
      ? "Already unlocked. No additional credit was used."
      : "Full signal unlocked and saved. Unlock credit deducted.";
    scrollToSignalKey(getSignalKey(signal));
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function enterPaperTrade(button) {
  try {
    button.disabled = true;
    button.textContent = "Adding...";
    const riskCard = button.closest(".signal-card, tr")?.querySelector(".risk-engine-card");
    state.paperPortfolio = await api.request("/api/paper-trades", {
      method: "POST",
      body: JSON.stringify({
        signalId: button.dataset.paperSignalId,
        accountSize: Number(riskCard?.querySelector("[data-risk-account]")?.value || 10000),
        riskPercent: Number(riskCard?.querySelector("[data-risk-percent]")?.value || 1)
      })
    });
    renderPaperPortfolio();
    renderSignals();
    renderSignalsHistory();
    statusLine.textContent = "Signal added to Paper Portfolio. No real order was placed.";
  } catch (error) {
    statusLine.textContent = error.message;
    if (error.message.includes("already in your Paper Portfolio")) {
      await loadPaperPortfolio();
      return;
    }
    button.disabled = false;
    button.textContent = "Add to Paper Portfolio";
  }
}

async function init() {
  setSplashStatus("Restoring your session");
  await captureAffiliateReferral();
  const oauthError = new URLSearchParams(location.search).get("oauth_error");
  const oauthSuccess = new URLSearchParams(location.search).get("oauth") === "success";
  const verificationToken = new URLSearchParams(location.search).get("verify");
  let verificationMessage = "";
  if (verificationToken) {
    try {
      const result = await api.request("/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: verificationToken })
      });
      history.replaceState({}, "", `${location.pathname}${location.hash}`);
      verificationMessage = result.trialGranted
        ? "Email verified. Your free signals are active."
        : "Email verified. This device has already received a free trial.";
    } catch (error) {
      verificationMessage = error.message;
    }
    authNote.textContent = verificationMessage;
  }
  const [session, authConfig] = await Promise.all([
    loadStartupSession(),
    loadAuthConfig()
  ]);
  viewDemoButton.classList.toggle("hidden", !authConfig.demoEnabled);
  googleAuthButton.classList.toggle("hidden", !authConfig.googleEnabled);
  const user = session.user;

  state.user = user;

  if (user) {
    setSplashStatus("Opening your dashboard");
    if (oauthSuccess) {
      history.replaceState({}, "", `${location.pathname}${location.hash}`);
    }
    await bootDashboard();
  } else {
    setSplashStatus("Preparing your market desk");
    const showAuthCallback = Boolean(oauthError || verificationToken);
    landingPage.classList.toggle("hidden", showAuthCallback);
    authScreen.classList.toggle("hidden", !showAuthCallback);
    dashboard.classList.add("hidden");
    if (oauthError) {
      authNote.textContent = googleOAuthErrorMessage(oauthError);
      history.replaceState({}, "", `${location.pathname}${location.hash}`);
    }
  }
}

function setSplashStatus(message) {
  if (appSplashStatus) appSplashStatus.textContent = message;
}

async function loadStartupSession() {
  try {
    const session = await api.request("/api/auth/session");
    saveRestoreToken(session.restore);

    if (session.user) {
      console.info("[auth] Cookie session restored.");
      return session;
    }

    console.info("[auth] No cookie session found; checking persistent restore token.");
  } catch (error) {
    console.warn(`[auth] Cookie session check failed; trying persistent restore token. ${error.message}`);
  }

  const user = await restoreSavedSession();
  return { user };
}

async function loadAuthConfig() {
  try {
    return await api.request("/api/auth/config");
  } catch (error) {
    console.warn(`[auth] Auth config failed to load: ${error.message}`);
    return {
      demoEnabled: false,
      googleEnabled: false
    };
  }
}

async function restoreSavedSession() {
  const restoreToken = getRestoreToken();
  if (!restoreToken) {
    console.info("[auth] No persistent restore token found.");
    return null;
  }

  try {
    setSplashStatus("Reopening your saved session");
    const result = await api.request("/api/auth/restore", {
      method: "POST",
      body: JSON.stringify({ restoreToken })
    });
    saveRestoreToken(result.restore);
    console.info("[auth] Persistent restore token succeeded.");
    return result.user;
  } catch (error) {
    if (isPermanentRestoreFailure(error)) {
      clearRestoreToken();
    }
    console.warn(`[auth] Persistent restore token failed: ${error.message}`);
    return null;
  }
}

function isPermanentRestoreFailure(error) {
  return [400, 401, 403, 404, 410].includes(error.statusCode);
}

function saveRestoreToken(restore) {
  if (!restore?.token) return;
  try {
    localStorage.setItem(RESTORE_TOKEN_KEY, restore.token);
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage write failed: ${error.message}`);
  }
}

function getRestoreToken() {
  try {
    return localStorage.getItem(RESTORE_TOKEN_KEY) || "";
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage read failed: ${error.message}`);
    return "";
  }
}

function clearRestoreToken() {
  try {
    localStorage.removeItem(RESTORE_TOKEN_KEY);
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage clear failed: ${error.message}`);
  }
}

function clearClientAuthState() {
  setMobileNavigationOpen(false);
  const scannerMode = getStoredScannerMode();
  const navSections = getStoredNavSections();
  localStorage.clear();
  localStorage.setItem(SCANNER_MODE_KEY, scannerMode);
  localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify(navSections));
  sessionStorage.clear();

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();

    if (name) {
      document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
      document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; Secure`;
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
  state.affiliate = null;
  state.affiliateAdmin = { affiliates: [], referrals: [], payouts: [] };
  state.webhookEvents = [];
  state.testerAccess = null;
  state.adminRequests = [];
  state.abuseDashboard = {
    flaggedAccounts: [],
    accountsPerIp: [],
    repeatedDevices: [],
    disposableEmails: []
  };
  state.performance = null;
  state.paperPortfolio = {
    trades: [],
    stats: {
      totalPaperTrades: 0,
      winRate: 0,
      averageR: 0,
      bestMarket: null,
      bestTimeframe: null
    }
  };
  state.journal = {
    entries: [],
    stats: {
      averageTradeRating: 0,
      mostCommonEmotion: null,
      bestPerformingMarket: null,
      bestPerformingTimeframe: null
    }
  };
  state.backtesting = null;
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

  if (billingRefreshTimer) {
    clearTimeout(billingRefreshTimer);
    billingRefreshTimer = null;
  }
}

async function bootDashboard() {
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.querySelector("#user-name").textContent = state.user.name;
  adminNavLink.classList.toggle("hidden", !state.user.isAdmin);
  affiliateAdminNavLink.classList.toggle("hidden", !state.user.isAdmin);
  webhookEventsNavLink.classList.toggle("hidden", !state.user.isAdmin);
  testerAccountBadge.classList.toggle("hidden", state.user.role !== "tester");
  renderNavSections();
  scannerModeToggle.checked = state.scannerMode === "advanced";

  const dashboardLoads = await Promise.allSettled([
    loadPairs(),
    loadSubscription(),
    loadSignals(),
    loadWatchlist(),
    loadAlerts(),
    loadNotifications(),
    loadTesterAccess()
  ]);
  reportDashboardLoadFailures(dashboardLoads);

  if (state.user.isAdmin) {
    try {
      await loadAdminRequests();
    } catch (error) {
      reportDashboardLoadFailures([{ status: "rejected", reason: error }]);
    }
  }
  renderTimeframes();
  const requestedView = location.hash?.replace("#", "").split("?")[0];
  const allowedInitialViews = ["signals", "paper-portfolio", "journal", "backtesting", "performance", "watchlist", "alerts", "notifications", "affiliate", "settings", "billing"];
  if (state.user.isAdmin) {
    allowedInitialViews.push("admin", "affiliate-admin", "webhook-events");
  }
  showView(allowedInitialViews.includes(requestedView) ? requestedView : "scanner");
  renderCheckoutReturnStatus();
  startSignalHistoryRefresh();

  try {
    await loadMarketData();
  } catch (error) {
    reportDashboardLoadFailures([{ status: "rejected", reason: error }]);
  }
}

function reportDashboardLoadFailures(results) {
  const failures = results.filter((result) => result.status === "rejected");
  if (!failures.length) return;

  console.warn(
    `[auth] Dashboard restored, but ${failures.length} startup request(s) failed: ` +
    failures.map((failure) => failure.reason?.message || "Unknown error").join("; ")
  );
  if (statusLine) {
    statusLine.textContent = "Session restored. Some dashboard data could not load yet; refresh or retry in a moment.";
  }
}

function showAuth() {
  setMobileNavigationOpen(false);
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
  renderPerformanceMarketOptions();
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

function renderPerformanceMarketOptions() {
  const currentValue = performanceMarket.value;
  performanceMarket.innerHTML = `
    <option value="">All markets</option>
    ${state.marketCatalog
      .filter((pair) => pair.category === "Crypto" || pair.category === "Commodities")
      .map((pair) => `<option value="${pair.symbol}">${pair.symbol}</option>`)
      .join("")}
  `;
  performanceMarket.value = state.marketCatalog.some((pair) => pair.symbol === currentValue)
    ? currentValue
    : "";

  const journalValue = journalMarket.value;
  journalMarket.innerHTML = `
    <option value="">All markets</option>
    ${state.marketCatalog
      .filter((pair) => pair.category === "Crypto" || pair.category === "Commodities")
      .map((pair) => `<option value="${pair.symbol}">${pair.symbol}</option>`)
      .join("")}
  `;
  journalMarket.value = state.marketCatalog.some((pair) => pair.symbol === journalValue)
    ? journalValue
    : "";
}

async function loadMarketData() {
  if (!state.selectedPair || state.selectedPair.status !== "active") {
    renderChart([]);
    renderMarketRegime(null);
    renderMultiTimeframeConfluence(null);
    renderAdvancedMarketStructure(null, null);
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
    renderChart(marketData.candles, marketData.advancedStructure);
    document.querySelector("#provider-name").textContent = providerLabel;
    document.querySelector("#candle-count").textContent = `${marketData.candles.length}`;
    renderMarketRegime(marketData.regime);
    renderMultiTimeframeConfluence(marketData.confluence);
    renderAdvancedMarketStructure(marketData.advancedStructure, marketData.correlation);
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
    renderMarketRegime(null);
    renderMultiTimeframeConfluence(null);
    renderAdvancedMarketStructure(null, null);
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

async function loadPaperPortfolio() {
  state.paperPortfolio = await api.request("/api/paper-trades");
  renderPaperPortfolio();
  renderSignals();
  renderSignalsHistory();
}

async function loadJournal() {
  const params = new URLSearchParams();
  if (journalFrom.value) params.set("from", journalFrom.value);
  if (journalTo.value) params.set("to", journalTo.value);
  if (journalMarket.value) params.set("symbol", journalMarket.value);
  if (journalTimeframe.value) params.set("timeframe", journalTimeframe.value);
  if (journalEmotion.value) params.set("emotion", journalEmotion.value);
  const query = params.toString();
  state.journal = await api.request(`/api/journal${query ? `?${query}` : ""}`);
  renderJournal();
}

async function loadPerformance() {
  const params = new URLSearchParams();
  if (performanceFrom.value) params.set("from", performanceFrom.value);
  if (performanceTo.value) params.set("to", performanceTo.value);
  if (performanceMarket.value) params.set("symbol", performanceMarket.value);
  if (performanceTimeframe.value) params.set("timeframe", performanceTimeframe.value);
  if (performanceDirection.value) params.set("direction", performanceDirection.value);
  const query = params.toString();
  const { performance } = await api.request(`/api/performance${query ? `?${query}` : ""}`);
  state.performance = performance;
  renderPerformance();
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

async function loadTesterAccess() {
  state.testerAccess = await api.request("/api/tester-access");
  renderTesterAccess();
}

async function loadAffiliate() {
  const { affiliate } = await api.request("/api/affiliates/me");
  state.affiliate = affiliate;
  renderAffiliate();
}

async function loadAffiliateAdmin() {
  if (!state.user?.isAdmin) return;
  const { affiliateAdmin } = await api.request("/api/admin/affiliates");
  state.affiliateAdmin = affiliateAdmin;
  renderAffiliateAdmin();
}

async function loadWebhookEvents() {
  if (!state.user?.isAdmin) return;
  const { events } = await api.request("/api/admin/stripe/webhooks");
  state.webhookEvents = events || [];
  renderWebhookEvents();
}

async function loadAdminRequests() {
  if (!state.user.isAdmin) return;
  const [{ requests }, { abuse }, { affiliateAdmin }, { analytics }] = await Promise.all([
    api.request("/api/admin/tester-access"),
    api.request("/api/admin/abuse"),
    api.request("/api/admin/affiliates"),
    api.request("/api/admin/analytics")
  ]);
  state.adminRequests = requests;
  state.abuseDashboard = abuse;
  state.affiliateAdmin = affiliateAdmin;
  state.adminAnalytics = analytics;
  renderAdminAnalytics();
  renderAdminRequests();
  renderAbuseDashboard();
  renderAffiliateAdmin();
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
    if (!state.user || !["signals", "paper-portfolio"].includes(state.activeView)) {
      return;
    }

    try {
      if (state.activeView === "paper-portfolio") {
        await loadPaperPortfolio();
      } else {
        await loadSignals();
      }
    } catch {
      // Keep the current table visible if a demo refresh fails.
    }
  }, 30000);
}

function showView(view) {
  const allowedViews = ["scanner", "watchlist", "alerts", "notifications", "signals", "paper-portfolio", "journal", "backtesting", "performance", "affiliate", "settings", "billing"];
  if (state.user?.isAdmin) {
    allowedViews.push("admin", "affiliate-admin", "webhook-events");
  }
  const normalizedView = allowedViews.includes(view) ? view : "scanner";
  state.activeView = normalizedView;

  document.querySelectorAll("[data-view]").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.view !== normalizedView);
  });

  document.querySelectorAll("[data-view-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.viewLink === normalizedView);
  });
  const activeLink = document.querySelector(`[data-view-link="${normalizedView}"]`);
  const activeSection = activeLink?.closest("[data-nav-section]");
  if (activeSection) {
    state.navSections[activeSection.dataset.navSection] = true;
    localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify(state.navSections));
    renderNavSections();
  }

  const titles = {
    scanner: ["Market scanner", "High-probability setup lab"],
    watchlist: ["Favorite markets", "Watchlist & alert rules"],
    alerts: ["Detected setups", "In-app alerts"],
    notifications: ["Delivery channels", "Notifications"],
    signals: ["Signals history", "Saved signal desk"],
    "paper-portfolio": ["Simulated execution", "Paper Portfolio"],
    journal: ["Review and discipline", "Trade Journal"],
    backtesting: ["Historical strategy research", "Backtesting Lab"],
    performance: ["Outcome analytics", "Performance"],
    affiliate: ["Recurring commissions", "Affiliate Program"],
    settings: ["Account", "Settings"],
    admin: ["Administration", "Tester access requests"],
    "affiliate-admin": ["Administration", "Affiliate Program"],
    "webhook-events": ["Stripe operations", "Webhook Events"],
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

  if (normalizedView === "admin") {
    renderAdminRequests();
    renderAbuseDashboard();
  }

  if (normalizedView === "affiliate") {
    loadAffiliate().catch((error) => {
      affiliateStatus.textContent = error.message;
    });
  }

  if (normalizedView === "affiliate-admin") {
    loadAffiliateAdmin().catch((error) => {
      document.querySelector("#affiliate-admin-summary").textContent = error.message;
    });
  }

  if (normalizedView === "webhook-events") {
    loadWebhookEvents().catch((error) => {
      webhookEventSummary.textContent = error.message;
    });
  }

  if (normalizedView === "performance") {
    loadPerformance().catch((error) => {
      document.querySelector("#performance-filter-label").textContent = error.message;
    });
  }

  if (normalizedView === "paper-portfolio") {
    loadPaperPortfolio().catch((error) => {
      paperPortfolioGrid.innerHTML = `
        <div class="empty-state">
          <strong>Paper Portfolio unavailable</strong>
          <p class="reasoning">${escapeHtml(error.message)}</p>
        </div>
      `;
    });
  }

  if (normalizedView === "journal") {
    loadJournal().catch((error) => {
      journalList.innerHTML = `
        <div class="empty-state">
          <strong>Trade Journal unavailable</strong>
          <p class="reasoning">${escapeHtml(error.message)}</p>
        </div>
      `;
    });
  }
}

function setMobileNavigationOpen(open) {
  if (!dashboard || !mobileMenuToggle) return;
  dashboard.classList.toggle("mobile-nav-open", open);
  document.body.classList.toggle("mobile-nav-open", open);
  mobileMenuToggle.setAttribute("aria-expanded", String(open));
  mobileMenuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
}

function renderPairs() {
  const groups = [...new Set(state.pairs.map((pair) => pair.group || pair.category))];
  pairList.innerHTML = groups.map((group) => `
    <section class="market-category">
      <div class="market-category-title">
        <strong>${group}</strong>
        <span>${state.pairs.filter((pair) => (pair.group || pair.category) === group && pair.status === "active").length} live</span>
      </div>
      ${state.pairs.filter((pair) => (pair.group || pair.category) === group).map((pair) => pair.selectable ? `
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

function renderChart(candles, advancedStructure = null) {
  const svg = document.querySelector("#candle-chart");

  if (!candles.length) {
    svg.innerHTML = `<text x="340" y="145" fill="#8e9bb0" text-anchor="middle">Market data unavailable</text>`;
    return;
  }

  const width = 680;
  const height = 280;
  const padding = 18;
  const visible = candles.slice(-72);
  const zones = [
    ...(advancedStructure?.chartZones?.vwap || []),
    ...(advancedStructure?.chartZones?.profile || [])
  ].filter((zone) => Number.isFinite(Number(zone.price)));
  const min = Math.min(...visible.map((candle) => candle.low), ...zones.map((zone) => zone.price));
  const max = Math.max(...visible.map((candle) => candle.high), ...zones.map((zone) => zone.price));
  const range = Math.max(max - min, 1);
  const slot = (width - padding * 2) / visible.length;
  const bodyWidth = Math.max(3, slot * 0.58);
  const y = (price) => height - padding - ((price - min) / range) * (height - padding * 2);

  const candlesMarkup = visible.map((candle, index) => {
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
  const zonesMarkup = zones.map((zone) => {
    const zoneY = y(zone.price);
    const className = zone.label.includes("VWAP") ? "chart-vwap-zone" : "chart-profile-zone";
    return `
      <line class="${className}" x1="${padding}" x2="${width - padding}" y1="${zoneY}" y2="${zoneY}"></line>
      <text class="chart-zone-label" x="${width - padding - 4}" y="${zoneY - 4}" text-anchor="end">${escapeHtml(zone.label)}</text>
    `;
  }).join("");
  svg.innerHTML = `${candlesMarkup}${zonesMarkup}`;
}

function renderAdvancedMarketStructure(structure, correlation) {
  const vwapLabel = document.querySelector("#vwap-context-label");
  const vwapDetail = document.querySelector("#vwap-context-detail");
  const profileLabel = document.querySelector("#volume-profile-label");
  const profileDetail = document.querySelector("#volume-profile-detail");
  const correlationLabel = document.querySelector("#correlation-context-label");
  const correlationDetail = document.querySelector("#correlation-context-detail");
  const matrix = document.querySelector("#correlation-matrix");

  if (!structure?.available) {
    vwapLabel.textContent = "Unavailable";
    vwapDetail.textContent = structure?.reason || "Real volume data is unavailable.";
    profileLabel.textContent = "Unavailable";
    profileDetail.textContent = structure?.reason || "Real volume data is unavailable.";
  } else {
    vwapLabel.textContent = `${structure.vwap.event} · ${formatCurrency(structure.vwap.session.value)}`;
    vwapDetail.textContent = structure.vwap.explanation;
    profileLabel.textContent = `POC ${formatCurrency(structure.volumeProfile.poc)}`;
    profileDetail.textContent = structure.volumeProfile.explanation;
  }

  correlationLabel.textContent = correlation?.available
    ? `${correlation.peers.length} synchronized peers`
    : "Unavailable";
  correlationDetail.textContent = correlation?.explanation ||
    "Synchronized real-market returns are unavailable.";
  matrix.innerHTML = (correlation?.peers || []).slice(0, 6).map((peer) => `
    <span class="${Math.abs(peer.correlation) >= 0.75 ? "strong" : ""}">
      ${escapeHtml(peer.symbol)} ${Number(peer.correlation).toFixed(2)}
    </span>
  `).join("");
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

function renderMarketRegime(regime) {
  const label = regime?.label || "Unavailable";
  document.querySelector("#market-regime").textContent = label;
  document.querySelector("#regime-card-label").textContent = label;
  document.querySelector("#regime-volatility-level").textContent = regime?.volatilityLevel || "--";
  document.querySelector("#regime-explanation").textContent = regime?.explanation ||
    "Live regime analysis is unavailable for the selected market.";
}

function renderMultiTimeframeConfluence(confluence) {
  const display = confluence?.display;
  const available = (confluence?.higherTimeframes || []).filter((item) => item.available);
  const unavailable = (confluence?.higherTimeframes || []).filter((item) => !item.available);
  const trendLabels = available.map((item) => {
    return `${item.timeframe} ${item.regime?.label || "Unknown"}`;
  });

  document.querySelector("#htf-trend-label").textContent = trendLabels.length
    ? trendLabels.join(" · ")
    : "No higher timeframe";
  document.querySelector("#ltf-setup-label").textContent = confluence
    ? `${confluence.lowerTimeframe} · ${confluence.lowerTimeframeRegime?.label || "Unknown"}`
    : "Unavailable";
  document.querySelector("#ltf-setup-detail").textContent = confluence?.lowerTimeframeRegime?.explanation ||
    "Lower-timeframe structure is unavailable.";
  document.querySelector("#confluence-score").textContent = display ? `${display.score}/100` : "--";
  document.querySelector("#confluence-badge").textContent = display?.badge || "Partial Alignment";
  document.querySelector("#confluence-badge").className = `alignment-badge ${getAlignmentClass(display?.badge)}`;
  document.querySelector("#confluence-explanation").textContent = display?.explanation ||
    "Higher-timeframe analysis is unavailable.";
  document.querySelector("#htf-timeframe-badges").innerHTML = [
    ...available.map((item) => `
      <span class="timeframe-alignment">
        ${escapeHtml(item.timeframe)} · ${escapeHtml(item.regime?.label || "Unknown")}
      </span>
    `),
    ...unavailable.map((item) => `
      <span class="timeframe-alignment unavailable">${escapeHtml(item.timeframe)} unavailable</span>
    `)
  ].join("");
}

function renderSubscription() {
  if (!state.subscription) return;
  document.querySelector("#trial-count").textContent = state.subscription.unlimitedSignals
    ? "Unlimited access"
    : `${state.subscription.unlockCreditsRemaining} unlocks left`;
  verificationNote.classList.toggle("hidden", state.subscription.emailVerified);
  resendVerificationButton.classList.toggle("hidden", state.subscription.emailVerified);
  if (!state.subscription.emailVerified) {
    verificationNote.textContent = "Verify your email before using setup or unlock credits.";
  }
  renderBilling();
}

function renderBilling() {
  if (!state.subscription) return;
  const subscription = state.subscription;
  billingCurrentPlan.textContent = subscription.planName;
  billingDiscoveryCredits.textContent = subscription.unlimitedSignals
    ? "Unlimited"
    : `${subscription.setupDiscoveries.remaining} / ${subscription.setupDiscoveries.limit} ${subscription.setupDiscoveries.period}`;
  billingUnlockCredits.textContent = subscription.unlimitedSignals
    ? "Unlimited"
    : String(subscription.unlockCreditsRemaining);
  manageSubscriptionButton.classList.toggle("hidden", !subscription.customerPortalAvailable);
  if (subscription.stripeConfiguration) {
    const config = subscription.stripeConfiguration;
    const checkoutMissing = [
      ...(config.checkoutMissing || []),
      ...config.missing.filter((key) =>
        key !== "STRIPE_WEBHOOK_SECRET" &&
        key !== "STRIPE_SECRET_KEY"
      )
    ];
    billingStatus.textContent = config.customerModeWarning
      ? config.customerModeWarning
      : checkoutMissing.length
      ? `Missing Stripe configuration: ${checkoutMissing.join(", ")}`
      : config.webhookConfigured
        ? `Stripe ${config.mode} mode is configured.`
        : `Checkout is configured. Webhooks are missing STRIPE_WEBHOOK_SECRET.`;
  }

  billingPlanGrid.innerHTML = subscription.plans.map((plan) => {
    const current = subscription.plan === plan.id;
    return `
      <article class="panel billing-plan ${current ? "current" : ""}">
        <div><span class="eyebrow">${current ? "Current plan" : "Subscription"}</span><h3>${escapeHtml(plan.name)}</h3></div>
        <strong>${plan.discoveryLimit} setup discoveries / ${plan.discoveryPeriod}</strong>
        <span>${plan.id === "free" ? "3 lifetime unlocks" : `${plan.monthlyUnlockGrant} unlocks / month`}</span>
        <span>${plan.id === "free" ? "Lifetime unlock limit" : "Unused unlocks roll over"}</span>
        ${plan.id === "free"
          ? `<button class="secondary-action" type="button" disabled>${current ? "Current plan" : "Free"}</button>`
          : `<button data-billing-plan="${plan.id}" type="button" ${current ? "disabled" : ""}>${current ? "Current plan" : `Upgrade to ${plan.name}`}</button>`}
      </article>
    `;
  }).join("");

  billingPackGrid.innerHTML = subscription.creditPacks.map((pack) => `
    <article class="panel billing-pack">
      <span class="eyebrow">Credit pack</span>
      <h3>${escapeHtml(pack.name)}</h3>
      <span>One-time purchase</span>
      <button data-billing-pack="${pack.id}" type="button">Buy credits</button>
    </article>
  `).join("");
}

function renderCheckoutReturnStatus() {
  const hashQuery = location.hash.split("?")[1] || "";
  const checkoutStatus = new URLSearchParams(hashQuery).get("checkout");
  if (checkoutStatus === "success") {
    billingStatus.textContent = "Purchase completed. Billing updates may take a moment.";
    refreshBillingAfterCheckout();
  } else if (checkoutStatus === "cancelled") {
    billingStatus.textContent = "Checkout was cancelled. No charge was made.";
  }
}

async function refreshBillingAfterCheckout() {
  const baseline = billingSnapshot();

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await waitForBillingRefresh(2000);

    try {
      await loadSubscription();
      if (billingSnapshot() !== baseline) {
        billingStatus.textContent = "Purchase confirmed. Billing credits are updated.";
        history.replaceState({}, "", `${location.pathname}#billing`);
        return;
      }
      billingStatus.textContent = `Purchase received. Waiting for Stripe confirmation (${attempt}/20)...`;
    } catch {
      billingStatus.textContent = "Purchase received. Retrying billing refresh...";
    }
  }

  billingStatus.textContent = "Purchase received. Billing will update when Stripe confirms payment.";
  history.replaceState({}, "", `${location.pathname}#billing`);
}

function billingSnapshot() {
  return JSON.stringify({
    plan: state.subscription?.plan,
    status: state.subscription?.status,
    unlocks: state.subscription?.unlockCreditsRemaining,
    periodStart: state.subscription?.currentPeriodStart
  });
}

function waitForBillingRefresh(delayMs) {
  return new Promise((resolve) => {
    billingRefreshTimer = setTimeout(() => {
      billingRefreshTimer = null;
      resolve();
    }, delayMs);
  });
}

async function startCheckout(button, payload) {
  try {
    button.disabled = true;
    billingStatus.textContent = "Creating secure Stripe checkout...";
    const { checkout } = await api.request("/api/subscriptions/checkout", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    location.assign(checkout.url);
  } catch (error) {
    billingStatus.textContent = error.message;
    button.disabled = false;
  }
}

function renderSignals() {
  if (state.scanResults.length > 0) {
    document.querySelector("#signal-count").textContent = `${state.scanResults.length} scan results`;
    signalsGrid.innerHTML = state.scanResults.map((setup) => renderScanCard(setup)).join("");
    return;
  }

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
          <td colspan="10">
            ${renderSignalTransparency(signal)}
            ${renderPaperTradeAction(signal)}
          </td>
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

function renderPaperPortfolio() {
  const { trades, stats } = state.paperPortfolio;
  paperTradeCount.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;
  document.querySelector("#paper-stat-total").textContent = `${stats.totalPaperTrades || 0}`;
  document.querySelector("#paper-stat-win-rate").textContent = `${stats.winRate || 0}%`;
  document.querySelector("#paper-stat-average-r").textContent = `${formatR(stats.averageR || 0)}`;
  document.querySelector("#paper-stat-best-market").textContent = stats.bestMarket
    ? `${stats.bestMarket.label} · ${formatR(stats.bestMarket.netR)}`
    : "--";
  document.querySelector("#paper-stat-best-timeframe").textContent = stats.bestTimeframe
    ? `${stats.bestTimeframe.label} · ${formatR(stats.bestTimeframe.netR)}`
    : "--";
  renderAccountGrowthCurve(document.querySelector("#paper-growth-curve"), stats.accountGrowthCurve || []);

  if (!trades.length) {
    paperPortfolioGrid.innerHTML = `
      <div class="empty-state">
        <strong>No paper trades yet</strong>
        <p class="reasoning">Open an active unlocked signal from the Scanner or Signals page, then add it to your Paper Portfolio.</p>
      </div>
    `;
    return;
  }

  paperPortfolioGrid.innerHTML = trades.map((trade) => `
    <article class="paper-trade-card">
      <div class="paper-trade-header">
        <div>
          <strong>${escapeHtml(trade.symbol)} · ${escapeHtml(trade.timeframe)}</strong>
          <span>${escapeHtml(trade.setupType || "Qualified setup")}</span>
        </div>
        <span class="status-pill ${getPaperStatusClass(trade.status)}">${escapeHtml(trade.status)}</span>
      </div>
      <div class="signal-metrics">
        <div><span>Direction</span><strong class="direction ${trade.direction}">${trade.direction.toUpperCase()}</strong></div>
        <div><span>Entry</span><strong>${formatCurrency(trade.entryPrice)}</strong></div>
        <div><span>Stop</span><strong>${formatCurrency(trade.stopLoss)}</strong></div>
        <div><span>Target</span><strong>${formatCurrency(trade.takeProfit)}</strong></div>
        <div><span>Planned R/R</span><strong>${trade.riskRewardRatio}:1</strong></div>
        <div><span>Paper P/L</span><strong class="${trade.realizedR > 0 ? "positive" : trade.realizedR < 0 ? "negative" : ""}">${formatR(trade.realizedR)}</strong></div>
        <div><span>Position size</span><strong>${Number(trade.positionSize || 0).toFixed(4)}</strong></div>
        <div><span>Risk amount</span><strong>${formatCurrency(trade.riskAmount || 0)}</strong></div>
        <div><span>Effective risk</span><strong>${trade.effectiveRiskPercent || 0}%</strong></div>
        <div><span>Potential profit</span><strong>${formatCurrency(trade.potentialProfit || 0)}</strong></div>
        <div><span>Simulated P/L</span><strong class="${trade.realizedPnl > 0 ? "positive" : trade.realizedPnl < 0 ? "negative" : ""}">${formatCurrency(trade.realizedPnl || 0)}</strong></div>
      </div>
      <p class="reasoning">Entered ${formatDateTime(trade.enteredAt)}${trade.resolvedAt ? ` · Resolved ${formatDateTime(trade.resolvedAt)}` : ""}.</p>
      <button
        class="secondary-action"
        data-open-journal
        data-journal-symbol="${escapeHtml(trade.symbol)}"
        data-journal-timeframe="${escapeHtml(trade.timeframe)}"
        type="button"
      >Open Journal</button>
    </article>
  `).join("");
}

function renderJournal() {
  const { entries, stats } = state.journal;
  const emotions = ["Confident", "Fear", "FOMO", "Impatient", "Disciplined"];
  journalEntryCount.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
  document.querySelector("#journal-stat-rating").textContent = `${Number(stats.averageTradeRating || 0).toFixed(1)}/5`;
  document.querySelector("#journal-stat-emotion").textContent = stats.mostCommonEmotion
    ? `${stats.mostCommonEmotion.label} · ${stats.mostCommonEmotion.count}`
    : "--";
  document.querySelector("#journal-stat-market").textContent = stats.bestPerformingMarket
    ? `${stats.bestPerformingMarket.label} · ${formatR(stats.bestPerformingMarket.netR)}`
    : "--";
  document.querySelector("#journal-stat-timeframe").textContent = stats.bestPerformingTimeframe
    ? `${stats.bestPerformingTimeframe.label} · ${formatR(stats.bestPerformingTimeframe.netR)}`
    : "--";

  if (!entries.length) {
    journalList.innerHTML = `
      <div class="empty-state">
        <strong>No journal entries match these filters</strong>
        <p class="reasoning">Add an unlocked signal to your Paper Portfolio, then record the plan, emotions, and review here.</p>
      </div>
    `;
    return;
  }

  journalList.innerHTML = entries.map((entry) => {
    const journal = entry.journal || {};
    return `
      <form class="journal-entry" data-journal-paper-trade="${entry.id}">
        <div class="journal-entry-header">
          <div>
            <strong>${escapeHtml(entry.symbol)} · ${escapeHtml(entry.timeframe)}</strong>
            <span>${escapeHtml(entry.direction.toUpperCase())} · Entered ${formatDateTime(entry.enteredAt)}</span>
          </div>
          <div class="journal-outcome">
            <strong class="${entry.realizedR > 0 ? "positive" : entry.realizedR < 0 ? "negative" : ""}">${formatR(entry.realizedR)}</strong>
            <span class="status-pill ${getPaperStatusClass(entry.status)}">${escapeHtml(entry.status)}</span>
          </div>
        </div>
        <div class="journal-notes-grid">
          <label>
            Notes before entry
            <textarea name="notesBeforeEntry" maxlength="4000" placeholder="Plan, invalidation, and what must remain true...">${escapeHtml(journal.notesBeforeEntry || "")}</textarea>
          </label>
          <label>
            Notes after exit
            <textarea name="notesAfterExit" maxlength="4000" placeholder="Execution review, lessons, and what to repeat...">${escapeHtml(journal.notesAfterExit || "")}</textarea>
          </label>
        </div>
        <fieldset class="emotion-options">
          <legend>Emotion tags</legend>
          ${emotions.map((emotion) => `
            <label>
              <input name="emotion" type="checkbox" value="${emotion}" ${(journal.emotionTags || []).includes(emotion) ? "checked" : ""} />
              ${emotion}
            </label>
          `).join("")}
        </fieldset>
        <div class="journal-review-row">
          <fieldset class="star-rating">
            <legend>Trade rating</legend>
            ${[1, 2, 3, 4, 5].map((rating) => `
              <label title="${rating} star${rating === 1 ? "" : "s"}">
                <input name="rating" type="radio" value="${rating}" ${journal.rating === rating ? "checked" : ""} />
                <span>★</span>
              </label>
            `).join("")}
          </fieldset>
          <label class="screenshot-field">
            Screenshot URL
            <input name="screenshotUrl" type="url" value="${escapeHtml(journal.screenshotUrl || "")}" placeholder="https://..." />
          </label>
          ${journal.screenshotUrl ? `<a class="journal-screenshot-link" href="${escapeHtml(journal.screenshotUrl)}" target="_blank" rel="noopener">View screenshot</a>` : ""}
          <button type="submit">Save Journal</button>
        </div>
      </form>
    `;
  }).join("");
}

function renderPerformance() {
  if (!state.performance) return;
  const { summary, signalsByMarket, signalsByTimeframe, monthlyPerformance, charts } = state.performance;
  document.querySelector("#performance-total").textContent = `${summary.totalSignals}`;
  document.querySelector("#performance-win-rate").textContent = `${summary.winRate}%`;
  document.querySelector("#performance-hit-tp").textContent = `${summary.hitTpCount}`;
  document.querySelector("#performance-hit-sl").textContent = `${summary.hitSlCount}`;
  document.querySelector("#performance-expired").textContent = `${summary.expiredCount}`;
  document.querySelector("#performance-average-rr").textContent = `${summary.averageRiskReward}:1`;
  document.querySelector("#performance-best-market").textContent = summary.bestMarket
    ? `${summary.bestMarket.label} · ${summary.bestMarket.winRate}%`
    : "--";
  document.querySelector("#performance-best-timeframe").textContent = summary.bestTimeframe
    ? `${summary.bestTimeframe.label} · ${summary.bestTimeframe.winRate}%`
    : "--";
  document.querySelector("#performance-best-regime").textContent = summary.bestRegime
    ? `${summary.bestRegime.label} · ${summary.bestRegime.winRate}%`
    : "--";
  document.querySelector("#performance-best-confluence").textContent = summary.bestConfluenceRange
    ? `${summary.bestConfluenceRange.label} · ${summary.bestConfluenceRange.winRate}%`
    : "--";
  document.querySelector("#performance-filter-label").textContent = getPerformanceFilterLabel();
  renderWinRateChart(charts.winRateOverTime);
  renderAnalyticsBars(document.querySelector("#tp-sl-chart"), charts.outcomes, true);
  renderAnalyticsBars(document.querySelector("#market-distribution-chart"), charts.marketDistribution);
  renderAnalyticsBars(document.querySelector("#signals-by-market"), signalsByMarket);
  renderAnalyticsBars(document.querySelector("#signals-by-timeframe"), signalsByTimeframe);
  renderRegimePerformance(state.performance.regimePerformance || []);
  renderConfluencePerformance(state.performance.confluencePerformance || []);
  renderSmcPerformance(
    document.querySelector("#signals-by-smc"),
    state.performance.smcPerformance || [],
    "signals"
  );
  renderRiskPerformance(
    document.querySelector("#signals-by-risk-level"),
    state.performance.expectancyByRiskLevel || []
  );
  renderRiskPerformance(
    document.querySelector("#signals-by-stop-style"),
    state.performance.stopStylePerformance || []
  );
  renderRiskPerformance(
    document.querySelector("#signals-by-target-style"),
    state.performance.targetStylePerformance || []
  );
  renderEvidencePerformance(
    document.querySelector("#signals-by-vwap"),
    state.performance.vwapPerformance || []
  );
  renderEvidencePerformance(
    document.querySelector("#signals-by-volume-profile"),
    state.performance.volumeProfilePerformance || []
  );
  renderEvidencePerformance(
    document.querySelector("#signals-by-correlation"),
    state.performance.correlationPerformance || []
  );
  renderMonthlyPerformance(monthlyPerformance);
}

function renderEvidencePerformance(container, items) {
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = `<div class="empty-state"><span>No tracked outcomes yet.</span></div>`;
    return;
  }
  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => `
    <div class="distribution-row">
      <div><span>${escapeHtml(item.label)}</span><strong>${item.winRate}% · ${formatR(item.netR)}</strong></div>
      <div class="distribution-track"><span style="width: ${Math.max(2, item.winRate)}%"></span></div>
      <small>${item.totalSignals} signals</small>
    </div>
  `).join("");
}

function renderSmcPerformance(container, items, unit = "trades") {
  if (!container) return;
  if (!items?.length || items.every((item) => (item.totalSignals || item.totalTrades || 0) === 0)) {
    container.innerHTML = `<div class="empty-state"><span>No tracked SMC outcomes yet.</span></div>`;
    return;
  }

  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => {
    const total = item.totalSignals ?? item.totalTrades ?? 0;
    return `
      <div class="distribution-row">
        <div><span>${escapeHtml(item.label)}</span><strong>${item.winRate}% · ${formatR(item.netR)}</strong></div>
        <div class="distribution-track"><span style="width: ${Math.max(2, item.winRate)}%"></span></div>
        <small>${total} ${unit}</small>
      </div>
    `;
  }).join("");
}

function renderRiskPerformance(container, items) {
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = `<div class="empty-state"><span>No tracked risk-engine outcomes yet.</span></div>`;
    return;
  }
  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => `
    <div class="distribution-row">
      <div><span>${escapeHtml(item.label)}</span><strong>${formatR(item.expectancy)} expectancy</strong></div>
      <div class="distribution-track"><span style="width: ${Math.max(2, item.winRate)}%"></span></div>
      <small>${item.winRate}% win rate · ${item.totalSignals} signals</small>
    </div>
  `).join("");
}

function renderConfluencePerformance(items) {
  const container = document.querySelector("#signals-by-confluence");

  if (!items.length) {
    container.innerHTML = `<div class="empty-state"><span>No tracked confluence outcomes yet.</span></div>`;
    return;
  }

  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => `
    <div class="distribution-row">
      <div>
        <span>${escapeHtml(item.label)} confluence</span>
        <strong>${item.winRate}% · ${item.netR}R</strong>
      </div>
      <div class="distribution-track">
        <span style="width: ${Math.max(2, Math.min(100, item.winRate))}%"></span>
      </div>
      <small>${item.hitTpCount} TP · ${item.hitSlCount} SL · ${item.expiredCount} expired</small>
    </div>
  `).join("");
}

function renderRegimePerformance(items) {
  const container = document.querySelector("#signals-by-regime");

  if (!items.length) {
    container.innerHTML = `<div class="empty-state"><span>No tracked regime outcomes yet.</span></div>`;
    return;
  }

  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => `
    <div class="distribution-row">
      <div>
        <span>${escapeHtml(item.label)}</span>
        <strong>${item.winRate}% · ${item.netR}R</strong>
      </div>
      <div class="distribution-track">
        <span style="width: ${Math.max(2, Math.min(100, item.winRate))}%"></span>
      </div>
      <small>${item.hitTpCount} TP · ${item.hitSlCount} SL · ${item.expiredCount} expired</small>
    </div>
  `).join("");
}

function renderWinRateChart(points) {
  const container = document.querySelector("#win-rate-chart");

  if (!points.length) {
    container.innerHTML = `<div class="empty-state"><span>No resolved outcomes in this range.</span></div>`;
    return;
  }

  const width = 620;
  const height = 220;
  const padding = 28;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const x = (index) => padding + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value) => height - padding - (value / 100) * innerHeight;
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point.winRate)}`).join(" ");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Win rate over time">
      <line class="chart-axis" x1="${padding}" y1="${y(100)}" x2="${padding}" y2="${y(0)}"></line>
      <line class="chart-axis" x1="${padding}" y1="${y(0)}" x2="${width - padding}" y2="${y(0)}"></line>
      <text class="chart-label" x="2" y="${y(100) + 4}">100%</text>
      <text class="chart-label" x="10" y="${y(0) + 4}">0%</text>
      <path class="chart-line" d="${path}"></path>
      ${points.map((point, index) => `
        <circle class="chart-dot" cx="${x(index)}" cy="${y(point.winRate)}" r="4"></circle>
        <text class="chart-label" x="${x(index)}" y="${height - 6}" text-anchor="middle">${point.label}</text>
      `).join("")}
    </svg>
  `;
}

function renderAnalyticsBars(container, items, outcomeColors = false) {
  if (!items.length || items.every((item) => item.value === 0)) {
    container.innerHTML = `<div class="empty-state"><span>No signal data in this range.</span></div>`;
    return;
  }

  const max = Math.max(...items.map((item) => item.value), 1);
  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => {
    const colorClass = outcomeColors
      ? item.label === "Hit TP" ? "positive" : "negative"
      : "";
    return `
      <div class="analytics-bar">
        <span>${item.label}</span>
        <div class="analytics-bar-track">
          <span class="analytics-bar-fill ${colorClass}" style="width:${(item.value / max) * 100}%"></span>
        </div>
        <strong>${item.value}</strong>
      </div>
    `;
  }).join("");
}

function renderMonthlyPerformance(months) {
  const container = document.querySelector("#monthly-performance");

  if (!months.length) {
    container.innerHTML = `<div class="empty-state"><span>No monthly performance data in this range.</span></div>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>Month</th><th>Signals</th><th>Win rate</th><th>TP</th><th>SL</th><th>Expired</th><th>Net R</th></tr></thead>
      <tbody>${months.map((month) => `
        <tr>
          <td><strong>${month.label}</strong></td>
          <td>${month.totalSignals}</td>
          <td>${month.winRate}%</td>
          <td>${month.hitTpCount}</td>
          <td>${month.hitSlCount}</td>
          <td>${month.expiredCount}</td>
          <td class="${month.netR >= 0 ? "net-r-positive" : "net-r-negative"}">${month.netR >= 0 ? "+" : ""}${month.netR}R</td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function getPerformanceFilterLabel() {
  const parts = [];
  if (performanceFrom.value || performanceTo.value) {
    parts.push(`${performanceFrom.value || "Start"} to ${performanceTo.value || "Today"}`);
  }
  if (performanceMarket.value) parts.push(performanceMarket.value);
  if (performanceTimeframe.value) parts.push(performanceTimeframe.value);
  return parts.length ? parts.join(" · ") : "All history";
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

function renderScanSummary(opportunitiesFound, marketsScanned, timeframesScanned, errors = []) {
  scanSummaryPanel.classList.remove("hidden");
  document.querySelector("#scan-summary-title").textContent = opportunitiesFound > 0
    ? "Scan Summary"
    : "No high-quality setups right now.";
  document.querySelector("#scan-summary-opportunities").textContent = `${opportunitiesFound} opportunity${opportunitiesFound === 1 ? "" : "ies"} found`;
  document.querySelector("#scan-summary-markets").textContent = `${marketsScanned} market${marketsScanned === 1 ? "" : "s"} scanned`;
  document.querySelector("#scan-summary-timeframes").textContent = `${timeframesScanned} timeframes scanned`;
  document.querySelector("#scan-summary-credits").textContent = opportunitiesFound > 0
    ? "No unlock credits used yet"
    : "No credits used";
  document.querySelector("#scan-summary-next").textContent = `Suggested next scan: ${formatSuggestedScanTime()}`;
  document.querySelector("#scan-summary-reason").textContent = opportunitiesFound > 0
    ? "Open Signal Desk to unlock or inspect compact opportunities."
    : `No setup met the confidence and risk filters.${errors.length ? ` ${errors.length} provider warning${errors.length === 1 ? "" : "s"} logged.` : ""}`;
}

function renderScanResults(setups, errors) {
  state.scanResults = setups;
  document.querySelector("#signal-count").textContent = `${setups.length} scan results`;
  const activePairs = state.pairs
    .concat(state.marketCatalog)
    .filter((pair, index, pairs) => pairs.findIndex((item) => item.symbol === pair.symbol) === index)
    .filter((pair) => pair.status === "active");
  const frames = ["1h", "4h", "15m", "5m"];
  const scannedMarkets = activePairs.map((pair) => pair.symbol);
  state.lastScanSummary = {
    marketsScanned: scannedMarkets.length,
    timeframesScanned: frames.length,
    opportunitiesFound: setups.length,
    errors: errors.length
  };
  renderScanSummary(setups.length, scannedMarkets.length, frames.length, errors);

  if (setups.length === 0) {
    signalsGrid.innerHTML = `
      <article class="signal-card compact-signal-card expanded">
        <div class="signal-top">
          <div>
            <strong>No high-quality setups right now.</strong>
            <span>${scannedMarkets.slice(0, 12).join(" · ")}${scannedMarkets.length > 12 ? " · ..." : ""}</span>
          </div>
        </div>
        <p class="reasoning">No setup met the confidence and risk filters. No credits used.</p>
        <div class="signal-metrics">
          <div><span>Markets scanned</span><strong>${scannedMarkets.length}</strong></div>
          <div><span>Timeframes</span><strong>${frames.join(", ")}</strong></div>
          <div><span>Provider errors</span><strong>${errors.length}</strong></div>
          <div><span>Suggested next scan</span><strong>${formatSuggestedScanTime()}</strong></div>
        </div>
      </article>
    `;
    statusLine.textContent = "No high-probability setups right now. Trial credits were not used.";
    scanSummaryPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  signalsGrid.innerHTML = setups.map((setup) => renderScanCard(setup)).join("");
  statusLine.textContent = `Found ${setups.length} high-probability setup${setups.length === 1 ? "" : "s"}. Unlocking one will use a trial credit.`;
  scanSummaryPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderScanCard(setup) {
  const key = getSignalKey(setup);
  const expanded = state.expandedSignalKeys.has(key);
  const passed = (setup.confirmations || []).filter((item) => item.passed).map((item) => item.name).join(", ");

  return `
    <article class="signal-card compact-signal-card ${expanded ? "expanded" : ""}" data-signal-key="${key}">
      <div class="signal-top">
        <div>
          <strong>${setup.symbol}</strong>
          <span>${setup.timeframe} · ${setup.marketType || getMarketType(setup.symbol)}</span>
        </div>
        <strong class="direction ${setup.direction}">${setup.direction}</strong>
      </div>
      <div class="signal-metrics">
        <div><span>Setup type</span><strong>${setup.setupType || "Qualified setup"}</strong></div>
        <div><span>Confidence</span><strong>${setup.confidenceScore}%</strong></div>
        <div><span>Risk/reward</span><strong>${setup.riskRewardRatio}:1</strong></div>
      </div>
      <div class="compact-actions">
        <button data-unlock-symbol="${setup.symbol}" data-unlock-timeframe="${setup.timeframe}" type="button">Unlock Signal</button>
        <button class="secondary-action" data-signal-details="${key}" type="button">${expanded ? "Hide Details" : "View Details"}</button>
      </div>
      <div class="signal-details ${expanded ? "" : "hidden"}">
        <p class="reasoning">Passed confirmations: ${passed || "No confirmation detail available."}. Unlock the full signal to save entry, stop loss, and take profit.</p>
        ${renderModeDetails(setup, true)}
      </div>
    </article>
  `;
}

function renderSignalCard(signal) {
  const key = getSignalKey(signal);
  const expanded = state.expandedSignalKeys.has(key);
  return `
    <article class="signal-card compact-signal-card ${expanded ? "expanded" : ""}" data-signal-key="${key}">
      <div class="signal-top">
        <div>
          <strong>${signal.symbol}</strong>
          <span>${signal.timeframe} · ${getMarketType(signal.symbol)}</span>
        </div>
        <strong class="direction ${signal.direction}">${signal.direction}</strong>
      </div>
      <div class="signal-metrics">
        <div><span>Setup type</span><strong>${signal.setupType || "Qualified setup"}</strong></div>
        <div><span>Entry</span><strong>${formatCurrency(signal.entryPrice)}</strong></div>
        <div><span>Stop loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div>
        <div><span>Take profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div>
        <div><span>Risk/reward</span><strong>${signal.riskRewardRatio}:1</strong></div>
        <div><span>Confidence</span><strong>${signal.confidenceScore}%</strong></div>
      </div>
      <div class="compact-actions">
        <button class="secondary-action" data-signal-details="${key}" type="button">${expanded ? "Hide Details" : "View Details"}</button>
        ${renderPaperTradeAction(signal)}
      </div>
      <div class="signal-details ${expanded ? "" : "hidden"}">
        ${renderModeDetails(signal)}
      </div>
    </article>
  `;
}

function renderModeDetails(signal, locked = false) {
  if (state.scannerMode === "basic") {
    return `
      <section class="basic-signal-details">
        <div class="signal-metrics">
          <div><span>Direction</span><strong class="direction ${signal.direction}">${String(signal.direction || "").toUpperCase()}</strong></div>
          <div><span>Entry</span><strong>${locked ? "Unlock required" : formatCurrency(signal.entryPrice)}</strong></div>
          <div><span>Stop loss</span><strong>${locked ? "Unlock required" : formatCurrency(signal.stopLoss)}</strong></div>
          <div><span>Take profit</span><strong>${locked ? "Unlock required" : formatCurrency(signal.takeProfit)}</strong></div>
          <div><span>Risk/reward</span><strong>${signal.riskRewardRatio}:1</strong></div>
          <div><span>Confidence</span><strong>${signal.confidenceScore}%</strong></div>
        </div>
        <section class="signal-transparency">
          <h4>Why this signal?</h4>
          <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
          <div class="signal-disclaimer">
            <strong>Educational tool only. Not financial advice.</strong>
            <span>Review risk and market context before making any decision.</span>
          </div>
        </section>
        ${locked ? "" : renderRiskEngineCard(signal)}
      </section>
    `;
  }

  return `
    <section class="advanced-signal-details">
      <p class="reasoning">${escapeHtml(signal.reasoning || "Advanced signal context is based on rule alignment.")}</p>
      ${renderSignalTransparency(signal)}
      ${renderSignalConfluence(signal)}
      ${renderRiskEngineCard(signal, locked)}
    </section>
  `;
}

function renderRiskEngineCard(signal, locked = false) {
  const plan = signal.riskPlan || {
    stopStyle: signal.indicators?.stopStyle || "ATR regime",
    stopMultiplier: signal.indicators?.stopMultiplier,
    targetStyle: signal.indicators?.targetStyle || "Regime dynamic",
    targetMultiple: signal.indicators?.targetMultiple || signal.riskRewardRatio,
    riskTier: signal.indicators?.riskTier || "Unknown",
    recommendedRiskPercent: signal.indicators?.recommendedRiskPercent || 0,
    explanation: signal.indicators?.riskExplanation || ""
  };

  if (locked || !Number.isFinite(Number(signal.entryPrice))) {
    return `
      <section class="risk-engine-card">
        <div class="risk-engine-heading"><span>Dynamic Risk Engine</span><strong>${escapeHtml(plan.riskTier)}</strong></div>
        <div class="risk-engine-policy">
          <span>${escapeHtml(plan.stopStyle)} · ${Number(plan.stopMultiplier || 0).toFixed(2)}x ATR</span>
          <span>${escapeHtml(plan.targetStyle)} · ${Number(plan.targetMultiple || signal.riskRewardRatio || 0).toFixed(2)}R</span>
        </div>
        <p class="reasoning">${escapeHtml(plan.explanation || "Unlock the signal to calculate position size.")}</p>
      </section>
    `;
  }
  const initialEffectiveRisk = Number(signal.qualityScore) >= 86 ? 1 : 0.5;
  const initialRiskAmount = 10000 * initialEffectiveRisk / 100;
  const initialUnitRisk = Math.abs(Number(signal.entryPrice) - Number(signal.stopLoss));
  const initialPositionSize = initialUnitRisk ? initialRiskAmount / initialUnitRisk : 0;
  const initialPotentialProfit = initialPositionSize *
    Math.abs(Number(signal.takeProfit) - Number(signal.entryPrice));

  return `
    <section
      class="risk-engine-card"
      data-entry="${signal.entryPrice}"
      data-stop="${signal.stopLoss}"
      data-target="${signal.takeProfit}"
      data-quality="${signal.qualityScore}"
    >
      <div class="risk-engine-heading"><span>Dynamic Risk Engine</span><strong>${escapeHtml(plan.riskTier)}</strong></div>
      <p class="reasoning">${escapeHtml(plan.explanation)}</p>
      <div class="risk-inputs">
        <label>Account size (USD)<input data-risk-account type="number" min="1" step="100" value="10000" /></label>
        <label>Risk %<select data-risk-percent><option>0.25</option><option>0.5</option><option selected>1</option><option>2</option></select></label>
      </div>
      <div class="risk-results">
        <div><span>Position size</span><strong data-risk-position>${initialPositionSize.toFixed(4)}</strong></div>
        <div><span>Risk amount</span><strong data-risk-amount>${formatCurrency(initialRiskAmount)}</strong></div>
        <div><span>Potential profit</span><strong data-risk-profit>${formatCurrency(initialPotentialProfit)}</strong></div>
        <div><span>R multiple</span><strong>${Number(signal.riskRewardRatio).toFixed(2)}R</strong></div>
      </div>
      <p class="risk-scaling-note" data-risk-note>${Number(signal.qualityScore) >= 86 ? "Normal risk applies, capped at 2%." : "Medium quality reduces requested risk by half."}</p>
    </section>
  `;
}

function updateRiskCard(card) {
  if (!card?.dataset.entry) return;
  const accountSize = Number(card.querySelector("[data-risk-account]").value);
  const requestedRisk = Number(card.querySelector("[data-risk-percent]").value);
  const quality = Number(card.dataset.quality);
  const effectiveRisk = quality >= 86 ? requestedRisk : quality >= 78 ? requestedRisk * 0.5 : 0;
  const riskAmount = accountSize * Math.min(2, effectiveRisk) / 100;
  const unitRisk = Math.abs(Number(card.dataset.entry) - Number(card.dataset.stop));
  const reward = Math.abs(Number(card.dataset.target) - Number(card.dataset.entry));
  const positionSize = unitRisk ? riskAmount / unitRisk : 0;

  card.querySelector("[data-risk-position]").textContent = positionSize.toFixed(4);
  card.querySelector("[data-risk-amount]").textContent = formatCurrency(riskAmount);
  card.querySelector("[data-risk-profit]").textContent = formatCurrency(positionSize * reward);
  card.querySelector("[data-risk-note]").textContent = quality >= 86
    ? `Normal risk applies, capped at 2%. Effective risk: ${Math.min(2, effectiveRisk)}%.`
    : quality >= 78
      ? `Medium quality reduces requested risk by half. Effective risk: ${effectiveRisk}%.`
      : "Low quality: no trade suggested.";
}

function renderSignalConfluence(signal) {
  const score = signal.confluenceScore || signal.indicators?.confluenceScore;
  const badge = signal.alignmentBadge || signal.indicators?.alignmentBadge;
  const explanation = signal.indicators?.confluenceExplanation;

  if (!Number.isFinite(Number(score))) return "";

  return `
    <section class="signal-confluence">
      <div>
        <span>Multi-timeframe confluence</span>
        <strong>${score}/100</strong>
        <span class="alignment-badge ${getAlignmentClass(badge)}">${escapeHtml(badge || "Partial Alignment")}</span>
      </div>
      <p class="reasoning">${escapeHtml(explanation || "Higher-timeframe evidence was included in confidence and quality scoring.")}</p>
    </section>
  `;
}

function getAlignmentClass(badge) {
  if (badge === "Full Alignment") return "full";
  if (badge === "Countertrend") return "countertrend";
  return "partial";
}

function renderPaperTradeAction(signal) {
  const existingTrade = state.paperPortfolio.trades.find((trade) => trade.signalId === signal.id);

  if (existingTrade) {
    return `<button class="secondary-action paper-trade-action" type="button" disabled>In Paper Portfolio · ${existingTrade.status}</button>`;
  }

  if (signal.status !== "Active") {
    return `<button class="secondary-action paper-trade-action" type="button" disabled>Signal ${signal.status}</button>`;
  }

  return `<button class="secondary-action paper-trade-action" data-paper-signal-id="${signal.id}" type="button">Add to Paper Portfolio</button>`;
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
      ${renderAiAnalyst(signal)}
      <div class="confirmation-list">
        ${confirmations.map((item) => `
          <div class="confirmation-item ${item.passed ? "passed" : "failed"}">
            <strong>${item.passed ? "Passed" : "Failed"} · ${item.name}</strong>
            <span>${item.detail}</span>
          </div>
        `).join("")}
      </div>
      ${renderSmcExplanation(signal)}
      ${renderAdvancedStructureExplanation(signal)}
      <p class="risk-guidance"><strong>Risk per trade:</strong> Define a consistent maximum loss before entering, size the position from the stop distance, and avoid risking capital you cannot afford to lose.</p>
      <div class="signal-disclaimer">
        <strong>Educational tool only. Not financial advice.</strong>
        <span>Review the market and your own risk limits before making any decision.</span>
      </div>
    </section>
  `;
}

function renderAiAnalyst(signal) {
  const analyst = signal.analyst || {
    strategyVersion: signal.indicators?.strategyVersion || "legacy",
    overallQuality: signal.indicators?.analystOverallQuality || (
      Number(signal.qualityScore) >= 90 ? "Excellent" :
        Number(signal.qualityScore) >= 84 ? "Good" :
          Number(signal.qualityScore) >= 78 ? "Average" : "Avoid"
    ),
    strengths: signal.indicators?.analystStrengths || [],
    weaknesses: signal.indicators?.analystWeaknesses || [],
    sections: signal.indicators?.analystSections || {},
    adaptive: {
      adjustment: Number(signal.indicators?.analystAdaptiveAdjustment || 0),
      factors: signal.indicators?.analystAdaptiveFactors || []
    }
  };
  const strengths = analyst.strengths || [];
  const weaknesses = analyst.weaknesses || [];

  return `
    <section class="ai-analyst-card">
      <div class="ai-analyst-heading">
        <div><span class="eyebrow">AI Signal Analyst</span><strong>Overall setup quality: ${escapeHtml(analyst.overallQuality || "Average")}</strong></div>
        <span>${escapeHtml(analyst.strategyVersion || "current")}</span>
      </div>
      <div class="analyst-columns">
        <div>
          <strong>Strengths</strong>
          ${strengths.length
            ? strengths.map((item) => `<span class="analyst-factor strength">✓ ${escapeHtml(item)}</span>`).join("")
            : `<span class="analyst-factor">No strong factor recorded.</span>`}
        </div>
        <div>
          <strong>Weaknesses</strong>
          ${weaknesses.length
            ? weaknesses.map((item) => `<span class="analyst-factor weakness">✗ ${escapeHtml(item)}</span>`).join("")
            : `<span class="analyst-factor">No material weakness recorded.</span>`}
        </div>
      </div>
      <details class="analyst-details">
        <summary>Full analyst context</summary>
        ${Object.entries(analyst.sections || {}).map(([key, value]) => `
          <div><strong>${escapeHtml(formatAnalystSection(key))}</strong><span>${escapeHtml(value || "Unavailable")}</span></div>
        `).join("")}
      </details>
      <p class="reasoning">Historical adaptation: ${analyst.adaptive?.adjustment > 0 ? "+" : ""}${analyst.adaptive?.adjustment || 0} quality points. The analyst cannot create or override a trade.</p>
    </section>
  `;
}

function formatAnalystSection(key) {
  const labels = {
    marketRegime: "Market regime",
    multiTimeframe: "Multi-timeframe confluence",
    session: "Session context",
    newsRisk: "News risk",
    smartMoneyConcepts: "Smart Money Concepts",
    vwap: "VWAP",
    volumeProfile: "Volume Profile",
    riskEngine: "Risk Engine"
  };
  return labels[key] || key;
}

function renderAdvancedStructureExplanation(signal) {
  const structure = signal.marketStructure || {
    available: Boolean(signal.indicators?.vwapAvailable),
    factors: signal.indicators?.marketStructureFactors || [],
    explanation: signal.indicators?.marketStructureExplanation || "",
    vwap: {
      session: { value: signal.indicators?.sessionVwap },
      anchored: { value: signal.indicators?.anchoredVwap },
      event: signal.indicators?.vwapEvent || "None"
    },
    volumeProfile: signal.indicators?.volumeProfile || null
  };
  const correlation = signal.correlation || {
    available: Boolean(signal.indicators?.correlationAvailable),
    conflict: Boolean(signal.indicators?.correlationConflict),
    breakdown: Boolean(signal.indicators?.correlationBreakdown),
    explanation: signal.indicators?.correlationExplanation || "",
    peers: signal.indicators?.correlationPeers || []
  };

  return `
    <section class="advanced-explanation">
      <div class="smc-heading"><span>Advanced Market Structure</span><strong>${structure.available ? "Live volume context" : "Unavailable"}</strong></div>
      <div class="advanced-factor-grid">
        <div>
          <strong>VWAP context</strong>
          <span>${escapeHtml(structure.factors?.find((factor) => factor.name === "VWAP")?.detail || structure.explanation || "VWAP unavailable.")}</span>
        </div>
        <div>
          <strong>Volume profile context</strong>
          <span>${escapeHtml(structure.factors?.find((factor) => factor.name === "Volume Profile")?.detail || "Volume profile unavailable.")}</span>
        </div>
        <div class="${correlation.conflict ? "conflict" : ""}">
          <strong>Correlation context</strong>
          <span>${escapeHtml(correlation.explanation || "Correlation context unavailable.")}</span>
        </div>
      </div>
    </section>
  `;
}

function renderSmcExplanation(signal) {
  const smc = signal.smc || {
    score: Number(signal.indicators?.smcScore || 0),
    conflict: Boolean(signal.indicators?.smcConflict),
    explanation: signal.indicators?.smcExplanation,
    factors: signal.indicators?.smcFactors || []
  };
  const factors = smc.factors || [];

  return `
    <section class="smc-explanation ${smc.conflict ? "conflict" : ""}">
      <div class="smc-heading">
        <span>Smart Money Concepts</span>
        <strong>${smc.conflict ? "Conflict" : smc.score ? `${smc.score} confluence points` : "Neutral"}</strong>
      </div>
      <p class="reasoning">${escapeHtml(smc.explanation || "No objective Smart Money Concepts confirmation was recorded.")}</p>
      <div class="smc-factor-grid">
        ${factors.map((factor) => `
          <div class="${factor.passed ? "passed" : "failed"}">
            <strong>${factor.passed ? "Contributed" : "Not active"} · ${escapeHtml(factor.name)}</strong>
            <span>${escapeHtml(factor.detail)}</span>
          </div>
        `).join("") || `<span class="reasoning">No SMC factors contributed to this setup.</span>`}
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

function renderTesterAccess() {
  const role = state.testerAccess?.role || state.user?.role || "user";
  const request = state.testerAccess?.request;
  const isTester = role === "tester";
  const status = isTester ? "approved" : request?.status || "not-requested";
  const labels = {
    "not-requested": "Not requested",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected"
  };

  testerAccountBadge.classList.toggle("hidden", !isTester);
  accountRoleLabel.textContent = isTester ? "Tester account" : "Standard account";
  testerRequestStatus.textContent = labels[status] || status;
  testerRequestStatus.className = `status-pill ${
    status === "approved"
      ? "status-hit-tp"
      : status === "rejected"
        ? "status-hit-sl"
        : status === "pending"
          ? "status-active"
          : ""
  }`.trim();
  requestTesterAccessButton.disabled = isTester || status === "pending";
  requestTesterAccessButton.textContent = isTester
    ? "Tester access active"
    : status === "pending"
      ? "Request pending"
      : status === "rejected"
        ? "Request tester access again"
      : "Request tester access";
}

function renderAffiliate() {
  if (!state.affiliate) return;
  const affiliate = state.affiliate;
  affiliateLink.textContent = affiliate.affiliateLink;
  document.querySelector("#affiliate-active-subscribers").textContent =
    affiliate.activeSubscribers;
  document.querySelector("#affiliate-monthly-commission").textContent =
    formatCents(affiliate.monthlyCommissionCents);
  document.querySelector("#affiliate-lifetime-earnings").textContent =
    formatCents(affiliate.lifetimeEarningsCents);
  document.querySelector("#affiliate-pending-payout").textContent =
    formatCents(affiliate.pendingPayoutCents);
  document.querySelector("#affiliate-conversion-rate").textContent =
    `${Number(affiliate.conversionRate || 0).toFixed(1)}%`;

  const payoutAllowed = affiliate.eligible !== false &&
    !affiliate.disabled &&
    affiliate.pendingPayoutCents >= affiliate.minimumPayoutCents;
  affiliatePayoutButton.disabled = !payoutAllowed;
  affiliateStatus.textContent = affiliate.eligible === false
    ? "Tester accounts are not eligible for affiliate commissions."
    : affiliate.disabled
      ? "This affiliate account is disabled."
      : payoutAllowed
        ? "Your available balance meets the $25 payout minimum."
        : `Earn ${formatCents(Math.max(0, affiliate.minimumPayoutCents - affiliate.pendingPayoutCents))} more to request a payout.`;

  affiliateReferrals.innerHTML = affiliate.referrals.length
    ? `
      <table>
        <thead><tr><th>Account</th><th>Plan</th><th>Monthly</th><th>Lifetime</th><th>Status</th></tr></thead>
        <tbody>${affiliate.referrals.map((referral) => `
          <tr>
            <td>${escapeHtml(maskEmail(referral.email))}</td>
            <td>${escapeHtml(String(referral.subscription_plan).toUpperCase())}</td>
            <td>${formatCents(referral.monthly_commission_cents)}</td>
            <td>${formatCents(referral.lifetime_commission_cents)}</td>
            <td><span class="status-pill ${referral.active ? "status-hit-tp" : "status-expired"}">${referral.active ? "Active" : "Inactive"}</span></td>
          </tr>
        `).join("")}</tbody>
      </table>
    `
    : `<div class="empty-state"><strong>No referrals yet</strong><p class="reasoning">Share your affiliate link to begin tracking conversions.</p></div>`;

  affiliatePayouts.innerHTML = affiliate.payouts.length
    ? `
      <table>
        <thead><tr><th>Amount</th><th>Method</th><th>Status</th><th>Requested</th></tr></thead>
        <tbody>${affiliate.payouts.map((payout) => `
          <tr>
            <td>${formatCents(payout.amount_cents)}</td>
            <td>${escapeHtml(String(payout.payout_method).toUpperCase())}</td>
            <td><span class="status-pill ${payout.status === "approved" ? "status-hit-tp" : payout.status === "rejected" ? "status-hit-sl" : "status-active"}">${escapeHtml(payout.status)}</span></td>
            <td>${formatDateTime(payout.created_at)}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    `
    : `<div class="empty-state"><span>No payout requests yet.</span></div>`;
}

function renderAffiliateAdmin() {
  if (!state.user?.isAdmin) {
    affiliateAdminNavLink.classList.add("hidden");
    return;
  }
  const admin = state.affiliateAdmin;
  const activeCount = admin.referrals.filter((referral) => referral.active).length;
  document.querySelector("#affiliate-admin-summary").textContent =
    `${activeCount} active referrals`;

  affiliateAdminAccounts.innerHTML = admin.affiliates.length
    ? admin.affiliates.map((affiliate) => `
      <article class="affiliate-admin-row">
        <div>
          <strong>${escapeHtml(affiliate.email)}</strong>
          <span>${affiliate.active_referrals} active · ${formatCents(affiliate.lifetime_earnings_cents)} lifetime</span>
        </div>
        <button class="${affiliate.affiliate_disabled ? "" : "reject-action"}"
          data-affiliate-admin-action="${affiliate.affiliate_disabled ? "enable-affiliate" : "disable-affiliate"}"
          data-affiliate-user-id="${affiliate.id}" type="button">
          ${affiliate.affiliate_disabled ? "Enable" : "Disable"}
        </button>
      </article>
    `).join("")
    : `<div class="empty-state"><span>No affiliate accounts yet.</span></div>`;

  affiliateAdminReferrals.innerHTML = admin.referrals.length
    ? admin.referrals.map((referral) => `
      <article class="affiliate-admin-row">
        <div>
          <strong>${escapeHtml(referral.affiliate_email)} to ${escapeHtml(referral.referred_email)}</strong>
          <span>${escapeHtml(String(referral.subscription_plan).toUpperCase())} · ${formatCents(referral.monthly_commission_cents)} monthly · ${referral.active ? "Active" : "Inactive"}</span>
        </div>
        <button class="${referral.suspicious ? "" : "reject-action"}"
          data-affiliate-admin-action="${referral.suspicious ? "clear-referral" : "flag-referral"}"
          data-referral-id="${referral.id}" type="button">
          ${referral.suspicious ? "Clear flag" : "Flag"}
        </button>
      </article>
    `).join("")
    : `<div class="empty-state"><span>No attributed referrals yet.</span></div>`;

  affiliateAdminPayouts.innerHTML = admin.payouts.length
    ? admin.payouts.map((payout) => `
      <article class="affiliate-admin-row">
        <div>
          <strong>${escapeHtml(payout.email)} · ${formatCents(payout.amount_cents)}</strong>
          <span>${escapeHtml(String(payout.payout_method).toUpperCase())} · ${escapeHtml(payout.payout_destination)} · ${escapeHtml(payout.status)}</span>
        </div>
        ${payout.status === "pending" ? `
          <div class="admin-request-actions">
            <button data-affiliate-admin-action="approve-payout" data-payout-id="${payout.id}" type="button">Approve</button>
            <button class="reject-action" data-affiliate-admin-action="reject-payout" data-payout-id="${payout.id}" type="button">Reject</button>
          </div>
        ` : `<span class="status-pill ${payout.status === "approved" ? "status-hit-tp" : "status-hit-sl"}">${escapeHtml(payout.status)}</span>`}
      </article>
    `).join("")
    : `<div class="empty-state"><span>No payout requests yet.</span></div>`;
}

function renderWebhookEvents() {
  if (!state.user?.isAdmin) {
    webhookEventsNavLink.classList.add("hidden");
    return;
  }

  const events = state.webhookEvents || [];
  const failedCount = events.filter((event) => event.status === "failed").length;
  webhookEventSummary.textContent = `${events.length} events · ${failedCount} failed`;
  webhookEventList.innerHTML = events.length
    ? events.map((event) => {
      const result = event.result_json || {};
      const statusClass = event.status === "processed"
        ? "status-hit-tp"
        : event.status === "failed"
          ? "status-hit-sl"
          : "status-expired";
      return `
        <article class="webhook-event-row">
          <div class="webhook-event-main">
            <div>
              <strong>${escapeHtml(event.event_type)}</strong>
              <span>${escapeHtml(event.event_id)} · ${formatDateTime(event.received_at)}</span>
            </div>
            <span class="status-pill ${statusClass}">${escapeHtml(event.status)}</span>
          </div>
          <div class="webhook-event-meta">
            <span>Object ${escapeHtml(event.stripe_object_id || "unknown")}</span>
            <span>Attempts ${Number(event.attempts || 0)}</span>
            <span>${escapeHtml(result.action || "No result recorded")}</span>
          </div>
          ${event.last_error ? `<p class="webhook-event-error">${escapeHtml(event.last_error)}</p>` : ""}
          ${event.status === "failed"
            ? `<button class="secondary-action" data-webhook-retry="${escapeHtml(event.event_id)}" type="button">Retry event</button>`
            : ""}
        </article>
      `;
    }).join("")
    : `<div class="empty-state"><strong>No Stripe webhook events yet</strong><p class="reasoning">Verified Stripe deliveries will appear here.</p></div>`;
}

function renderAdminAnalytics() {
  if (!state.user?.isAdmin || !state.adminAnalytics) return;
  const analytics = state.adminAnalytics;
  document.querySelector("#admin-analytics-summary").textContent =
    `${analytics.signups || 0} signups · ${analytics.scans || 0} scans · ${analytics.unlocks || 0} unlocks`;
  document.querySelector("#analytics-total-users").textContent = formatInteger(analytics.totalUsers);
  document.querySelector("#analytics-paid-users").textContent = formatInteger(analytics.paidUsers);
  document.querySelector("#analytics-conversion-rate").textContent = `${analytics.conversionRate || 0}%`;
  document.querySelector("#analytics-mrr").textContent = formatCents(analytics.monthlyRecurringRevenueCents);
  document.querySelector("#analytics-affiliate-owed").textContent = formatCents(analytics.affiliateRevenueOwedCents);
  document.querySelector("#analytics-checkout-funnel").textContent =
    `${formatInteger(analytics.checkoutCompleted)} / ${formatInteger(analytics.checkoutStarted)}`;
  renderMetricRows("#analytics-signups", [
    ["Total signups", analytics.signups],
    ["Email signups", analytics.emailSignups],
    ["Google signups", analytics.googleSignups]
  ]);
  renderMetricRows("#analytics-usage", [
    ["Scans", analytics.scans],
    ["Unlocks", analytics.unlocks],
    ["Subscriptions", analytics.subscriptions],
    ["Affiliate conversions", analytics.affiliateConversions]
  ]);
  renderMarketMetricRows("#analytics-most-scanned", analytics.mostScannedMarkets);
  renderMarketMetricRows("#analytics-most-unlocked", analytics.mostUnlockedMarkets);
}

function renderMetricRows(selector, rows) {
  document.querySelector(selector).innerHTML = rows.map(([label, value]) => `
    <div class="metric-row"><span>${escapeHtml(label)}</span><strong>${formatInteger(value)}</strong></div>
  `).join("");
}

function renderMarketMetricRows(selector, rows = []) {
  document.querySelector(selector).innerHTML = rows.length
    ? rows.map((row) => `
      <div class="metric-row"><span>${escapeHtml(row.symbol)}</span><strong>${formatInteger(row.count)}</strong></div>
    `).join("")
    : `<div class="empty-state"><span>No events yet.</span></div>`;
}

function renderAdminRequests() {
  if (!state.user?.isAdmin) {
    adminNavLink.classList.add("hidden");
    return;
  }

  adminRequestCount.textContent = `${state.adminRequests.length} pending`;

  if (!state.adminRequests.length) {
    adminRequestList.innerHTML = `
      <div class="empty-state">
        <strong>No pending tester requests</strong>
        <p class="reasoning">New requests will appear here for manual review.</p>
      </div>
    `;
    return;
  }

  adminRequestList.innerHTML = state.adminRequests.map((request) => `
    <article class="admin-request-item">
      <div>
        <strong>${escapeHtml(request.user.name)}</strong>
        <p class="reasoning">${escapeHtml(request.user.email)} · Requested ${formatDateTime(request.requestedAt)}</p>
      </div>
      <div class="admin-request-actions">
        <button data-tester-request-id="${request.id}" data-decision="approved" type="button">Approve</button>
        <button class="reject-action" data-tester-request-id="${request.id}" data-decision="rejected" type="button">Reject</button>
      </div>
    </article>
  `).join("");
}

function renderAbuseDashboard() {
  if (!state.user?.isAdmin) return;
  const abuse = state.abuseDashboard;
  document.querySelector("#flagged-account-count").textContent =
    `${abuse.flaggedAccounts.length} flagged`;
  renderAdminRows("#flagged-accounts", abuse.flaggedAccounts, (item) => `
    <div><strong>${escapeHtml(item.email)}</strong><span>Score ${item.abuseScore} · ${(item.abuseFlags || []).join(", ") || "review"}</span></div>
  `);
  renderAdminRows("#accounts-per-ip", abuse.accountsPerIp, (item) => `
    <div><strong>${escapeHtml(item.ipHash)}</strong><span>${item.accounts} accounts · ${item.attempts} attempts</span></div>
  `);
  renderAdminRows("#repeated-devices", abuse.repeatedDevices, (item) => `
    <div><strong>${escapeHtml(item.deviceHash)}</strong><span>${item.accounts} accounts · Trial used ${item.trialUsed ? "yes" : "no"}</span></div>
  `);
  renderAdminRows("#disposable-emails", abuse.disposableEmails, (item) => `
    <div><strong>${escapeHtml(item.domain)}</strong><span>${item.attempts} blocked attempts</span></div>
  `);
}

function renderAdminRows(selector, items, rowRenderer) {
  const container = document.querySelector(selector);
  container.classList.add("admin-abuse-list");
  container.innerHTML = items.length
    ? items.map(rowRenderer).join("")
    : `<div class="empty-state"><span>No matching records.</span></div>`;
}

function renderBacktest(backtest) {
  const { metrics, ruleSetEvaluation } = backtest;
  const statusLabels = {
    passed: "Historical checks passed",
    failed: "Historical checks failed",
    "insufficient-sample": "Insufficient sample"
  };
  const statusClass = ruleSetEvaluation.status === "passed"
    ? "status-hit-tp"
    : ruleSetEvaluation.status === "failed"
      ? "status-hit-sl"
      : "status-expired";

  backtestStatus.textContent = statusLabels[ruleSetEvaluation.status] || "Review required";
  backtestStatus.className = `status-pill ${statusClass}`;
  backtestOutput.innerHTML = `
    <div class="backtest-summary-grid">
      <div><span>Total trades</span><strong>${metrics.totalTrades}</strong></div>
      <div><span>Win rate</span><strong>${metrics.winRate}%</strong></div>
      <div><span>Average R</span><strong>${metrics.averageR}R</strong></div>
      <div><span>Net R</span><strong>${metrics.netR}R</strong></div>
      <div><span>Max drawdown</span><strong>${metrics.maxDrawdownR}R</strong></div>
      <div><span>Average quality</span><strong>${metrics.averageQualityScore}/100</strong></div>
    </div>
    <div class="backtest-review">
      <strong>${escapeHtml(backtest.symbol)} · ${escapeHtml(backtest.timeframe)} · ${escapeHtml(backtest.provider)}</strong>
      <p class="reasoning">${escapeHtml(ruleSetEvaluation.message)}</p>
      <span>${backtest.candleCount} real candles · ${metrics.wins} TP · ${metrics.losses} SL · ${metrics.expired} expired</span>
    </div>
    ${backtest.trades.length ? `
      <div class="backtest-trades">
        ${backtest.trades.slice(0, 12).map((trade) => `
          <div>
            <span>${escapeHtml(trade.setupType)} · ${escapeHtml(trade.direction.toUpperCase())}</span>
            <strong class="${trade.outcome === "Hit TP" ? "positive" : trade.outcome === "Hit SL" ? "negative" : ""}">${escapeHtml(trade.outcome)} · ${trade.realizedR}R</strong>
          </div>
        `).join("")}
      </div>
    ` : `
      <div class="empty-state">
        <strong>No qualifying historical trades</strong>
        <p class="reasoning">The stricter rules correctly returned no trade for this candle sample.</p>
      </div>
    `}
  `;
}

function renderBacktestingLab() {
  const report = state.backtesting;
  if (!report) {
    labEmptyState.classList.remove("hidden");
    labLoadingState.classList.add("hidden");
    labResults.classList.add("hidden");
    return;
  }
  const { metrics, evaluation, curves, breakdowns, trades, errors } = report;
  const edgeFound = evaluation.status === "edge-detected";

  labEmptyState.classList.add("hidden");
  labLoadingState.classList.add("hidden");
  labResults.classList.remove("hidden");
  labStatus.textContent = edgeFound ? "Edge detected" : "No edge found";
  labStatus.className = `status-pill ${edgeFound ? "status-hit-tp" : "status-expired"}`;
  labEvaluation.classList.remove("hidden");
  labEvaluation.className = `lab-evaluation ${edgeFound ? "edge" : "no-edge"}`;
  labEvaluation.innerHTML = `
    <strong>${escapeHtml(evaluation.message)}</strong>
    <span>${errors.length ? `${errors.length} market/timeframe combinations were unavailable.` : "All selected combinations completed."}</span>
  `;
  document.querySelector("#lab-total-trades").textContent = `${metrics.totalTrades}`;
  document.querySelector("#lab-win-rate").textContent = `${metrics.winRate}%`;
  document.querySelector("#lab-profit-factor").textContent = metrics.profitFactor === null ? "∞" : `${metrics.profitFactor}`;
  document.querySelector("#lab-average-r").textContent = formatR(metrics.averageR);
  document.querySelector("#lab-max-drawdown").textContent = formatR(metrics.maxDrawdownR);
  document.querySelector("#lab-win-streak").textContent = `${metrics.consecutiveWins}`;
  document.querySelector("#lab-loss-streak").textContent = `${metrics.consecutiveLosses}`;
  document.querySelector("#lab-expectancy").textContent = formatR(metrics.expectancy);
  renderLabCurve(document.querySelector("#lab-equity-curve"), curves.equity, "Equity curve");
  renderLabCurve(document.querySelector("#lab-drawdown-curve"), curves.drawdown, "Drawdown curve");
  renderLabBreakdown(document.querySelector("#lab-by-market"), breakdowns.markets);
  renderLabBreakdown(document.querySelector("#lab-by-timeframe"), breakdowns.timeframes);
  renderLabBreakdown(document.querySelector("#lab-by-regime"), breakdowns.regimes);
  renderLabBreakdown(document.querySelector("#lab-by-confluence"), breakdowns.confluence);
  renderSmcPerformance(document.querySelector("#lab-by-smc"), breakdowns.smc || [], "trades");
  renderSmcComparison(document.querySelector("#lab-smc-comparison"), report.smcComparison);
  renderRiskComparison(document.querySelector("#lab-stop-comparison"), report.riskComparison?.stops);
  renderRiskComparison(document.querySelector("#lab-target-comparison"), report.riskComparison?.targets);
  renderComponentComparison(
    document.querySelector("#lab-vwap-comparison"),
    report.advancedStructureComparison?.vwap
  );
  renderComponentComparison(
    document.querySelector("#lab-profile-comparison"),
    report.advancedStructureComparison?.volumeProfile
  );
  renderComponentComparison(
    document.querySelector("#lab-correlation-comparison"),
    report.advancedStructureComparison?.correlation
  );
  renderLabTrades(trades);
}

function applyBacktestPreset(preset) {
  const componentInputs = [...document.querySelectorAll('input[name="lab-component"]')];
  const timeframeInputs = [...document.querySelectorAll('input[name="lab-timeframe"]')];
  const conservativeComponents = new Set([
    "marketRegime",
    "multiTimeframe",
    "ema",
    "rsi",
    "adx",
    "atr",
    "supportResistance"
  ]);
  const balancedComponents = new Set([
    ...conservativeComponents,
    "liquiditySweeps",
    "fairValueGaps",
    "structure",
    "vwap",
    "volumeProfile",
    "correlation"
  ]);

  componentInputs.forEach((input) => {
    input.checked = preset === "aggressive"
      ? true
      : preset === "conservative"
        ? conservativeComponents.has(input.value)
        : balancedComponents.has(input.value);
  });

  timeframeInputs.forEach((input) => {
    input.checked = preset === "conservative"
      ? ["1h", "4h"].includes(input.value)
      : preset === "aggressive"
        ? true
        : input.value === "1h";
  });
}

function renderComponentComparison(container, comparison) {
  if (!container) return;
  if (!comparison) {
    container.innerHTML = `<div class="empty-state"><span>Component disabled for this run.</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="smc-comparison-grid">
      <div><span>${escapeHtml(comparison.primary.label)}</span><strong>${formatR(comparison.primary.metrics.expectancy)} expectancy</strong></div>
      <div><span>${escapeHtml(comparison.variant.label)}</span><strong>${formatR(comparison.variant.metrics.expectancy)} expectancy</strong></div>
      <div><span>Improvement</span><strong>${formatR(comparison.expectancyDelta)} expectancy · ${comparison.winRateDelta >= 0 ? "+" : ""}${comparison.winRateDelta}% win rate</strong></div>
    </div>
  `;
}

function renderRiskComparison(container, comparison) {
  if (!container || !comparison) return;
  container.innerHTML = `
    <div class="smc-comparison-grid">
      <div><span>${escapeHtml(comparison.primary.label)}</span><strong>${formatR(comparison.primary.metrics.expectancy)} expectancy · ${formatR(comparison.primary.metrics.maxDrawdownR)} drawdown</strong></div>
      <div><span>${escapeHtml(comparison.variant.label)}</span><strong>${formatR(comparison.variant.metrics.expectancy)} expectancy · ${formatR(comparison.variant.metrics.maxDrawdownR)} drawdown</strong></div>
      <div><span>Dynamic advantage</span><strong>${formatR(comparison.expectancyDelta)} expectancy · ${formatR(comparison.drawdownDelta)} drawdown delta</strong></div>
    </div>
  `;
}

function renderAccountGrowthCurve(container, points) {
  if (!container) return;
  if (!points?.length || points.length === 1) {
    container.innerHTML = `<div class="empty-state"><span>Close a paper trade to build the growth curve.</span></div>`;
    return;
  }
  const width = 620;
  const height = 220;
  const padding = 30;
  const values = points.map((point) => Number(point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const x = (index) => padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
  const y = (value) => height - padding - ((value - min) / range) * (height - padding * 2);
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point.value)}`).join(" ");
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Paper account growth curve">
      <path class="chart-line" d="${path}"></path>
      <text class="chart-label" x="4" y="${y(max) + 4}">${formatCurrency(max)}</text>
      <text class="chart-label" x="4" y="${y(min) + 4}">${formatCurrency(min)}</text>
    </svg>
  `;
}

function renderSmcComparison(container, comparison) {
  if (!container) return;
  if (!comparison) {
    container.innerHTML = `<div class="empty-state"><span>Enable an SMC component to compare results.</span></div>`;
    return;
  }

  container.innerHTML = `
    <div class="smc-comparison-grid">
      <div><span>With SMC</span><strong>${comparison.withSmc.winRate}% · ${formatR(comparison.withSmc.expectancy)} expectancy</strong></div>
      <div><span>Without SMC</span><strong>${comparison.withoutSmc.winRate}% · ${formatR(comparison.withoutSmc.expectancy)} expectancy</strong></div>
      <div><span>Difference</span><strong>${comparison.delta.winRate >= 0 ? "+" : ""}${comparison.delta.winRate}% win rate · ${formatR(comparison.delta.expectancy)}</strong></div>
    </div>
  `;
}

function renderLabCurve(container, points, label) {
  if (!points?.length || points.length === 1) {
    container.innerHTML = `<div class="empty-state"><span>No completed trades to chart.</span></div>`;
    return;
  }
  const width = 620;
  const height = 220;
  const padding = 28;
  const values = points.map((point) => Number(point.value));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = Math.max(max - min, 1);
  const x = (index) => padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
  const y = (value) => height - padding - ((value - min) / range) * (height - padding * 2);
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point.value)}`).join(" ");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
      <line class="chart-axis" x1="${padding}" y1="${y(0)}" x2="${width - padding}" y2="${y(0)}"></line>
      <path class="chart-line" d="${path}"></path>
      <text class="chart-label" x="4" y="${y(max) + 4}">${max.toFixed(1)}R</text>
      <text class="chart-label" x="4" y="${y(min) + 4}">${min.toFixed(1)}R</text>
    </svg>
  `;
}

function renderLabBreakdown(container, items) {
  if (!items?.length) {
    container.innerHTML = `<div class="empty-state"><span>No completed trades.</span></div>`;
    return;
  }
  container.classList.add("distribution-list");
  container.innerHTML = items.map((item) => `
    <div class="distribution-row">
      <div><span>${escapeHtml(item.label)}</span><strong>${item.winRate}% · ${formatR(item.netR)}</strong></div>
      <div class="distribution-track"><span style="width: ${Math.max(2, item.winRate)}%"></span></div>
      <small>${item.totalTrades} trades</small>
    </div>
  `).join("");
}

function renderLabTrades(trades) {
  const container = document.querySelector("#lab-trades");
  if (!trades?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>No historical trades qualified</strong>
        <p class="reasoning">The selected components produced no valid setups without using future candles.</p>
      </div>
    `;
    return;
  }
  container.innerHTML = `
    <table class="signals-table">
      <thead><tr><th>Market</th><th>TF</th><th>Direction</th><th>Setup</th><th>Regime</th><th>Confluence</th><th>Outcome</th><th>R</th><th>Opened</th></tr></thead>
      <tbody>${trades.map((trade) => `
        <tr>
          <td>${escapeHtml(trade.symbol)}</td>
          <td>${escapeHtml(trade.timeframe)}</td>
          <td><strong class="direction ${trade.direction}">${trade.direction.toUpperCase()}</strong></td>
          <td>${escapeHtml(trade.setupType)}</td>
          <td>${escapeHtml(trade.regime)}</td>
          <td>${trade.confluenceScore}</td>
          <td><span class="status-pill ${getPaperStatusClass(trade.outcome)}">${escapeHtml(trade.outcome)}</span></td>
          <td>${formatR(trade.realizedR)}</td>
          <td>${formatDateTime(trade.openedAt)}</td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getDeviceFingerprint() {
  return [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}`,
    `${screen.colorDepth}`
  ].join("|").slice(0, 200);
}

function getStoredAffiliateCode() {
  return sanitizeAffiliateCode(sessionStorage.getItem("signalforge-affiliate-code"));
}

function getStoredScannerMode() {
  return localStorage.getItem("signalforge-scanner-mode") === "advanced" ? "advanced" : "basic";
}

function getStoredNavSections() {
  const defaults = {
    trading: true,
    alerts: true,
    research: true,
    portfolio: true,
    growth: true,
    account: true
  };

  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("signalforge-nav-sections") || "{}")
    };
  } catch {
    return defaults;
  }
}

function renderNavSections() {
  document.querySelectorAll("[data-nav-section]").forEach((section) => {
    const name = section.dataset.navSection;
    const expanded = state.navSections[name] !== false;
    section.classList.toggle("collapsed", !expanded);
    section.querySelector("[data-nav-section-toggle]")?.setAttribute("aria-expanded", String(expanded));
  });
}

function getSignalKey(signal) {
  if (signal?.id) return `signal:${signal.id}`;
  return `${signal?.symbol || "market"}:${signal?.timeframe || "timeframe"}`;
}

function getMarketType(symbol) {
  const market = state.marketCatalog.find((item) => item.symbol === symbol) ||
    state.pairs.find((item) => item.symbol === symbol);
  return market?.assetClass || market?.category || "Crypto";
}

function getShortSignalReason(signal) {
  if (signal?.summary) return signal.summary;
  if (signal?.reasoning) return String(signal.reasoning).split(".").slice(0, 2).join(". ").trim();

  const confirmations = signal?.confirmations || [];
  const passed = confirmations.filter((item) => item.passed).map((item) => item.name);
  if (passed.length) {
    return `Qualified because ${passed.slice(0, 4).join(", ")} aligned with the rule set.`;
  }

  return "This setup is shown only when the rule-based scanner finds enough trend, risk, and structure alignment.";
}

function formatSuggestedScanTime() {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(Date.now() + 15 * 60 * 1000));
}

function scrollToSignalDesk() {
  document.querySelector(".signals-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToSignalKey(key) {
  const cards = [...document.querySelectorAll("[data-signal-key]")];
  const card = cards.find((item) => item.dataset.signalKey === key);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function captureAffiliateReferral() {
  const code = sanitizeAffiliateCode(new URLSearchParams(location.search).get("ref"));
  if (!code) return;
  state.referralCode = code;
  sessionStorage.setItem("signalforge-affiliate-code", code);

  try {
    await api.request("/api/affiliates/click", {
      method: "POST",
      body: JSON.stringify({
        affiliateCode: code,
        visitorId: getAffiliateVisitorId()
      })
    });
  } catch {
    // Attribution remains available for signup even if click analytics are unavailable.
  }
}

function sanitizeAffiliateCode(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function getAffiliateVisitorId() {
  const source = getDeviceFingerprint();
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `visitor-${(hash >>> 0).toString(16)}`;
}

function maskEmail(value) {
  const [name, domain] = String(value || "").split("@");
  if (!domain) return "Referred account";
  return `${name.slice(0, 2)}***@${domain}`;
}

function googleOAuthErrorMessage(code) {
  const messages = {
    google_denied: "Google sign-in was cancelled.",
    invalid_state: "Google sign-in expired. Please try again.",
    invalid_callback: "Google returned an incomplete sign-in response.",
    token_exchange_failed: "Google sign-in could not be verified.",
    invalid_token: "Google identity verification failed.",
    expired_token: "Google sign-in expired. Please try again.",
    unverified_email: "Your Google account email must be verified.",
    disposable_email: "Temporary or disposable email addresses are not supported.",
    account_blocked: "Google sign-in is unavailable for this account.",
    not_configured: "Google sign-in is not configured."
  };
  return messages[code] || "Google sign-in failed. Please try again.";
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

function formatCents(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0) / 100);
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatR(value) {
  const numeric = Number(value || 0);
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(2)}R`;
}

function getPaperStatusClass(status) {
  if (status === "Hit TP") return "status-hit-tp";
  if (status === "Hit SL") return "status-hit-sl";
  if (status === "Expired") return "status-expired";
  return "status-active";
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

registerPwa();
init()
  .catch((error) => {
    console.warn(`[auth] Startup session restore failed before login state was confirmed: ${error.message}`);
    if (state.user) {
      landingPage.classList.add("hidden");
      authScreen.classList.add("hidden");
      dashboard.classList.remove("hidden");
      if (statusLine) {
        statusLine.textContent = "Session restored. Some dashboard data could not load yet.";
      }
      return;
    }

    landingPage.classList.add("hidden");
    authScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
    authNote.textContent = "We could not confirm your session. Check your connection and refresh before signing in again.";
  })
  .finally(hideSplash);

async function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/"
    });
    window.signalForgePushRegistration = registration;
  } catch (error) {
    console.warn(`[pwa] Service worker registration failed: ${error.message}`);
  }
}

function hideSplash() {
  requestAnimationFrame(() => {
    appSplash.classList.add("hidden");
    setTimeout(() => appSplash.remove(), 220);
  });
}
