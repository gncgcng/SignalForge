import {
  ROUTE_TO_VIEW,
  buildRouteHash,
  getHashRoute,
  isPublicRoute,
  normalizeAppRoute,
  parseAppHash
} from "./router.js";
import {
  SIGNAL_STATUS_FILTERS,
  createSignalFilters,
  filterAndSortSignals,
  filtersFromSignalParams,
  getSignalSummary,
  getSignalStatusCounts,
  getSignalStatusKey,
  normalizeSignal,
  signalFiltersToParams
} from "./signalFilters.js";
import { calculateRiskPosition } from "./riskCalculator.js";
import { formatSignalCountdown, getSignalValidityState } from "./signalValidity.js";

const RESTORE_TOKEN_KEY = "signalforge-restore-token";
const AUTH_RESTORE_TIMEOUT_MS = 8000;
const LEGACY_AUTH_STORAGE_KEYS = new Set([
  "signalforge-auth-token",
  "signalforge-session",
  "signalforge-session-token",
  "signalforge-refresh-token",
  "signalforge-user",
  "signalforge-cached-user",
  "auth-token",
  "refresh-token",
  "access-token",
  "authtoken",
  "accesstoken",
  "restoretoken",
  "refreshtoken",
  "signalforge_auth",
  "signalforge_session",
  "signalforge_restore",
  "signalforge_user",
  "signalforge_cached_user",
  "token",
  "user"
]);
const SIGNAL_VIEW_MODE_KEY = "signalforge-signal-view-mode";
const LEGACY_SCANNER_MODE_KEY = "signalforge-scanner-mode";
const NAV_SECTIONS_KEY = "signalforge-nav-sections";
const TELEGRAM_UNLOCK_KEY = "signalforge-telegram-unlock";
const UNLOCK_REVEAL_KEY = "signalforge-unlock-reveal";
const ONBOARDING_SKIP_KEY = "signalforge-onboarding-skipped";
const FIRST_SCAN_KEY = "signalforge-first-scan-complete";
const PAPER_INDICATORS_KEY = "signalforge-paper-indicators";
const RISK_ACCOUNT_SIZE_KEY = "signalforge-risk-account-size";
const RISK_PERCENT_KEY = "signalforge-risk-percent";
const authStorage = window.SignalForgeAuthStorage;

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
  onboardingSkipped: getStoredOnboardingSkipped(),
  firstScanCompleted: getStoredFirstScanCompleted(),
  expandedSignalKeys: new Set(),
  unlockedRevealSignalId: null,
  telegramExpiredNotice: null,
  riskCalculations: new Map(),
  lastScanSummary: null,
  activeView: "scanner",
  activeRoute: "scanner",
  lastAppliedRouteHash: "",
  historyFilters: {
    status: "all",
    pair: "all",
    timeframe: "all",
    direction: "all",
    strategy: "all",
    dateRange: "all",
    sort: "newest",
    search: ""
  },
  historyFiltersInitialized: false,
  signalStats: {
    totalSignals: 0,
    winRate: 0,
    hitTpCount: 0,
    hitSlCount: 0,
    expiredCount: 0
  },
  signals: [],
  candidates: [],
  marketBrief: null,
  avoidTrades: [],
  showAllAvoidTrades: false,
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
  adminDashboard: null,
  learningDashboard: null,
  adminUserSearchResults: [],
  validationDashboard: null,
  candidateQuality: null,
  adminSignals: { signals: [], stats: {}, page: 1, totalPages: 1, total: 0, filters: {} },
  adminCryptoMarkets: { markets: [], summary: {}, filters: {} },
  profile: null,
  publicProfile: null,
  leaderboards: null,
  leaderboardTab: "topRMultiple",
  support: { tickets: [], topics: {} },
  adminSupport: { tickets: [], summary: {}, topics: {}, selectedTicketId: null },
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
  paperTrading: {
    selectedSymbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    activeTab: "positions",
    indicators: getStoredPaperIndicators(),
    markets: [],
    orders: [],
    account: null,
    marketData: null,
    marketError: null,
    draftSignalId: null
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

const authScreen = document.querySelector("#auth-screen");
const debugBuildPage = document.querySelector("#debug-build-page");
const clearSessionPage = document.querySelector("#clear-session-page");
const candidateGrid = document.querySelector("#candidate-grid");
const candidateCount = document.querySelector("#candidate-count");
const dailyMarketBrief = document.querySelector("#daily-market-brief");
const dailyBriefContent = document.querySelector("#daily-brief-content");
const dailyBriefUpdated = document.querySelector("#daily-brief-updated");
const avoidTradeSection = document.querySelector("#avoid-trade-section");
const avoidTradeGrid = document.querySelector("#avoid-trade-grid");
const avoidTradeCount = document.querySelector("#avoid-trade-count");
const avoidTradeMore = document.querySelector("#avoid-trade-more");
const landingPage = document.querySelector("#landing-page");
const publicHowItWorksPage = document.querySelector("#public-how-it-works-page");
const publicProfilePage = document.querySelector("#public-profile-page");
const accountRecoverySupportPage = document.querySelector("#account-recovery-support-page");
const accountRecoverySupportForm = document.querySelector("#account-recovery-support-form");
const accountRecoveryStatus = document.querySelector("#account-recovery-status");
const dashboard = document.querySelector("#dashboard");
const appSplash = document.querySelector("#app-splash");
const appSplashStatus = document.querySelector("#app-splash-status");
const appSplashLoading = document.querySelector("#app-splash-loading");
const authRestoreFailure = document.querySelector("#auth-restore-failure");
const authRestoreFailureMessage = document.querySelector("#auth-restore-failure-message");
const authRestoreRetry = document.querySelector("#auth-restore-retry");
const authRestoreSignIn = document.querySelector("#auth-restore-sign-in");
const authRestoreClear = document.querySelector("#auth-restore-clear");
const installAppButton = document.querySelector("#install-app-button");
const mobileMenuToggle = document.querySelector("#mobile-menu-toggle");
const sidebar = document.querySelector(".sidebar");
const authForm = document.querySelector("#auth-form");
const authNote = document.querySelector("#auth-note");
const forgotPasswordButton = document.querySelector("#forgot-password-button");
const passwordResetRequestForm = document.querySelector("#password-reset-request-form");
const passwordResetConfirmForm = document.querySelector("#password-reset-confirm-form");
const passwordResetRequestNote = document.querySelector("#password-reset-request-note");
const passwordResetConfirmNote = document.querySelector("#password-reset-confirm-note");
const passwordResetUnavailable = document.querySelector("#password-reset-unavailable");
const passwordResetEmailField = document.querySelector("#password-reset-email-field");
const passwordResetSubmit = document.querySelector("#password-reset-submit");
const adminEmailWarning = document.querySelector("#admin-email-warning");
const passwordResetContactSupport = document.querySelector("#password-reset-contact-support");
let emailFeaturesEnabled = false;
const backToLoginButton = document.querySelector("#back-to-login-button");
const legalConsent = document.querySelector("#legal-consent");
const legalModal = document.querySelector("#legal-modal");
const legalModalTitle = document.querySelector("#legal-modal-title");
const legalModalBody = document.querySelector("#legal-modal-body");
const unlockReveal = document.querySelector("#unlock-reveal");
const unlockRevealCard = document.querySelector("#unlock-reveal-card");
const googleAuthButton = document.querySelector("#google-auth-button");
const viewDemoButton = document.querySelector("#view-demo-button");
const livePreviewSection = document.querySelector("#live-preview");
const landingRunScan = document.querySelector("#landing-run-scan");
const landingDemoShell = document.querySelector(".landing-demo-shell");
const landingDemoResult = document.querySelector("#landing-demo-result");
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
const onboardingPanel = document.querySelector("#onboarding-panel");
const onboardingChecklist = document.querySelector("#onboarding-checklist");
const onboardingProgressText = document.querySelector("#onboarding-progress-text");
const onboardingProgressBar = document.querySelector("#onboarding-progress-bar");
const onboardingProgressNote = document.querySelector("#onboarding-progress-note");
const onboardingSkipButton = document.querySelector("#onboarding-skip-button");
const onboardingShowButton = document.querySelector("#onboarding-show-button");
const statusLine = document.querySelector("#status-line");
const signalsGrid = document.querySelector("#signals-grid");
const paperPortfolioGrid = document.querySelector("#paper-portfolio-grid");
const paperTradeCount = document.querySelector("#paper-trade-count");
const paperMarketSearch = document.querySelector("#paper-market-search");
const paperMarketList = document.querySelector("#paper-market-list");
const paperTimeframes = document.querySelector("#paper-timeframes");
const paperIndicatorControls = document.querySelector("#paper-indicator-controls");
const paperChart = document.querySelector("#paper-candle-chart");
const paperChartLoading = document.querySelector("#paper-chart-loading");
const paperChartTooltip = document.querySelector("#paper-chart-tooltip");
const paperOrderForm = document.querySelector("#paper-order-form");
const paperOrderMarket = document.querySelector("#paper-order-market");
const paperOrderType = document.querySelector("#paper-order-type");
const paperLimitField = document.querySelector("#paper-limit-field");
const paperLimitPrice = document.querySelector("#paper-limit-price");
const paperOrderQuantity = document.querySelector("#paper-order-quantity");
const paperOrderSize = document.querySelector("#paper-order-size");
const paperOrderStop = document.querySelector("#paper-order-stop");
const paperOrderTarget = document.querySelector("#paper-order-target");
const paperOrderNotes = document.querySelector("#paper-order-notes");
const paperOrderSignalId = document.querySelector("#paper-order-signal-id");
const paperOrderWarning = document.querySelector("#paper-order-warning");
const paperTerminalTabs = document.querySelector("#paper-terminal-tabs");
const paperHistoryFilters = document.querySelector("#paper-history-filters");
const paperResetAccount = document.querySelector("#paper-reset-account");
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
const historyStrategyFilter = document.querySelector("#history-strategy-filter");
const historyDateFilter = document.querySelector("#history-date-filter");
const historySortFilter = document.querySelector("#history-sort-filter");
const historySearchFilter = document.querySelector("#history-search-filter");
const historyStatusFilters = document.querySelector("#history-status-filters");
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
const telegramScope = document.querySelector("#telegram-scope");
const telegramDirection = document.querySelector("#telegram-direction");
const telegramMinimumConfidence = document.querySelector("#telegram-minimum-confidence");
const telegramStatusLine = document.querySelector("#telegram-status-line");
const testerAccountBadge = document.querySelector("#tester-account-badge");
const accountRoleLabel = document.querySelector("#account-role-label");
const testerRequestStatus = document.querySelector("#tester-request-status");
const requestTesterAccessButton = document.querySelector("#request-tester-access");
const testerAccessMessage = document.querySelector("#tester-access-message");
const profileSettingsForm = document.querySelector("#profile-settings-form");
const settingsUsername = document.querySelector("#settings-username");
const settingsPublicProfile = document.querySelector("#settings-public-profile");
const settingsPublicLeaderboard = document.querySelector("#settings-public-leaderboard");
const settingsProfilePreview = document.querySelector("#settings-profile-preview");
const settingsViewLeaderboard = document.querySelector("#settings-view-leaderboard");
const profileSettingsMessage = document.querySelector("#profile-settings-message");
const usernameRequiredPanel = document.querySelector("#username-required-panel");
const usernameOnboardingForm = document.querySelector("#username-onboarding-form");
const onboardingUsername = document.querySelector("#onboarding-username");
const onboardingPublicProfile = document.querySelector("#onboarding-public-profile");
const usernameOnboardingMessage = document.querySelector("#username-onboarding-message");
const adminNavLink = document.querySelector("#admin-nav-link");
const adminSignalsNavLink = document.querySelector("#admin-signals-nav-link");
const adminCryptoMarketsNavLink = document.querySelector("#admin-crypto-markets-nav-link");
const affiliateAdminNavLink = document.querySelector("#affiliate-admin-nav-link");
const webhookEventsNavLink = document.querySelector("#webhook-events-nav-link");
const adminSupportNavLink = document.querySelector("#admin-support-nav-link");
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
const adminSignalFilters = document.querySelector("#admin-signal-filters");
const adminSignalsTable = document.querySelector("#admin-signals-table");
const adminSignalModal = document.querySelector("#admin-signal-modal");
const adminSignalDetail = document.querySelector("#admin-signal-detail");
const adminCryptoFilters = document.querySelector("#admin-crypto-filters");
const adminCryptoMarketList = document.querySelector("#admin-crypto-market-list");
const adminCryptoRebuildActive = document.querySelector("#admin-crypto-rebuild-active");
const adminCryptoSync = document.querySelector("#admin-crypto-sync");
const adminCryptoVerifyPending = document.querySelector("#admin-crypto-verify-pending");
const adminCryptoDiagnostics = document.querySelector("#admin-crypto-diagnostics");
const adminCryptoOperationStatus = document.querySelector("#admin-crypto-operation-status");
const adminCryptoProgress = document.querySelector("#admin-crypto-progress");
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
const performanceOutcome = document.querySelector("#performance-outcome");
const performanceClear = document.querySelector("#performance-clear");
const leaderboardTabs = document.querySelector("#leaderboard-tabs");
const leaderboardTable = document.querySelector("#leaderboard-table");
const leaderboardTitle = document.querySelector("#leaderboard-title");
const leaderboardEyebrow = document.querySelector("#leaderboard-eyebrow");
const leaderboardUpdated = document.querySelector("#leaderboard-updated");
const supportForm = document.querySelector("#support-form");
const supportTopic = document.querySelector("#support-topic");
const supportIssue = document.querySelector("#support-issue");
const supportFormStatus = document.querySelector("#support-form-status");
const supportTicketList = document.querySelector("#support-ticket-list");
const supportTicketCount = document.querySelector("#support-ticket-count");
const adminSupportFilters = document.querySelector("#admin-support-filters");
const adminSupportTicketList = document.querySelector("#admin-support-ticket-list");
const adminSupportDetail = document.querySelector("#admin-support-detail");
let marketRequestId = 0;
let signalRefreshTimer = null;
let marketLoadTimer = null;
let telegramConnectionTimer = null;
let billingRefreshTimer = null;
let deferredInstallPrompt = null;
let loginInProgress = false;
let authOperationVersion = 0;

const legalDocuments = {
  terms: {
    title: "Terms",
    body: `
      <p>SignalForge provides market research tools, scanners, alerts, backtesting, paper trading, and educational analytics. You are responsible for how you use the information shown in the app.</p>
      <p>SignalForge does not place trades, connect to external trading accounts, manage money, or provide personalized investment recommendations. You agree not to misuse the service, bypass usage limits, abuse trials, or rely on SignalForge as your sole basis for trading decisions.</p>
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

const defaultSupportIssues = {
  "Account / Login": ["Cannot sign in", "Google login issue", "Password reset issue", "Session keeps expiring", "Account settings issue"],
  "Billing / Subscription": ["Payment failed", "Subscription not active", "Cancel subscription", "Refund question", "Invoice question"],
  "Credits / Unlocks": ["Credits missing", "Signal charged twice", "Signal did not unlock", "Wrong credit balance"],
  "Telegram Alerts": ["Not receiving alerts", "Telegram not connecting", "Unlock link not opening app", "Duplicate alerts"],
  "Signals / Scanner": ["Signal looks wrong", "TP/SL issue", "Confidence issue", "Scanner not finding setups"],
  "Paper Trading": ["Order did not open", "TP/SL tracking issue", "Balance or P/L issue", "Chart or market data issue"],
  "Affiliate Program": ["Referral not tracked", "Commission missing", "Payout question", "Affiliate link issue"],
  "Bug Report": ["Page error", "Mobile layout issue", "Data not loading", "Unexpected behavior"],
  "Feature Request": ["Scanner improvement", "Alert improvement", "Paper trading improvement", "Other feature request"],
  Other: ["General question", "Other issue"]
};

const api = {
  async request(path, options = {}) {
    const { timeoutMs = 0, signal: externalSignal, onResponse, onPayload, ...fetchOptions } = options;
    const optionHeaders = fetchOptions.headers || {};
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId = null;
    const abortFromExternalSignal = () => controller.abort();

    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });

    if (timeoutMs > 0) {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      const response = await fetch(path, {
        ...fetchOptions,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-device-fingerprint": getDeviceFingerprint(),
          ...optionHeaders
        }
      });
      onResponse?.({ status: response.status, ok: response.ok });
      if (path === "/api/auth/session" || path === "/api/auth/restore") {
        updateAuthDebug({ endpoint: path, statusCode: response.status, restoreHttpStatus: response.status });
      }
      const responseText = await response.text();
      let payload = {};
      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          const error = new Error("The server returned an unexpected response.");
          error.statusCode = response.status;
          error.code = "invalid_json";
          throw error;
        }
      }
      onPayload?.({ payload, status: response.status, ok: response.ok });

      if (!response.ok) {
        const message = payload.message || (typeof payload.error === "string"
          ? payload.error
          : payload.error?.message);
        const error = new Error(message || "Request failed.");
        error.statusCode = response.status;
        error.code = payload.code ||
          (typeof payload.error === "string" ? payload.error : payload.error?.code) ||
          "request_failed";
        error.details = payload.error?.details;
        error.responseSummary = summarizeAuthResponse(payload);
        throw error;
      }

      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        const abortError = new Error(timedOut ? "The request timed out." : "The request was cancelled.");
        abortError.code = timedOut ? "request_timeout" : "request_aborted";
        throw abortError;
      }
      throw error;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
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

authRestoreRetry?.addEventListener("click", () => {
  setAuthRestoreRecoveryBusy(true, "Trying again...");
  location.reload();
});

authRestoreSignIn?.addEventListener("click", () => {
  openSignInAfterRestoreFailure("Session restore failed. Please sign in again.");
});

authRestoreClear?.addEventListener("click", () => {
  clearSavedAuthStorage("user_requested");
  openSignInAfterRestoreFailure("Saved session cleared. Please sign in again.");
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

landingRunScan?.addEventListener("click", () => {
  landingRunScan.disabled = true;
  landingRunScan.textContent = "Scanning...";
  landingDemoShell?.classList.add("scanning");
  landingDemoResult?.classList.add("hidden");

  window.setTimeout(() => {
    landingDemoShell?.classList.remove("scanning");
    landingDemoResult?.classList.remove("hidden");
    landingRunScan.disabled = false;
    landingRunScan.textContent = "Run Scan";
  }, 900);
});

document.querySelectorAll("[data-legal-doc]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    openLegalDocument(trigger.dataset.legalDoc);
  });
});

document.querySelectorAll("[data-legal-close]").forEach((trigger) => {
  trigger.addEventListener("click", closeLegalDocument);
});

document.addEventListener("click", (event) => {
  const trustLink = event.target.closest("[data-how-it-works-link], [data-public-how-it-works]");
  if (trustLink) {
    event.preventDefault();
    if (state.user) {
      if (state.unlockedRevealSignalId) {
        unlockReveal.classList.add("hidden");
        document.body.classList.remove("unlock-reveal-open");
        sessionStorage.removeItem(UNLOCK_REVEAL_KEY);
        state.unlockedRevealSignalId = null;
      }
      navigateTo("how-it-works");
    }
    else showPublicHowItWorks({ updateHistory: true });
    return;
  }

  if (event.target.closest("[data-how-it-works-home]")) {
    showLandingFromTrustPage();
    return;
  }

  if (event.target.closest("[data-how-it-works-start]")) {
    if (state.user) navigateTo("scanner");
    else {
      history.replaceState({}, "", `${location.pathname}${location.search}#scanner`);
      showAuth();
    }
    return;
  }

  if (event.target.closest("[data-how-risk-disclaimer]")) {
    openLegalDocument("risk");
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-signal-view-mode]");
  if (!button) return;
  setSignalViewMode(button.dataset.signalViewMode);
});

viewOpportunitiesButton.addEventListener("click", () => {
  scrollToSignalDesk();
});

viewDemoButton.addEventListener("click", () => {
  livePreviewSection?.scrollIntoView({ behavior: "smooth", block: "start" });
  landingRunScan?.focus({ preventScroll: true });
});

onboardingSkipButton?.addEventListener("click", () => {
  state.onboardingSkipped = true;
  localStorage.setItem(ONBOARDING_SKIP_KEY, "1");
  renderOnboarding();
  showToast("Checklist skipped. It stays available on the dashboard.");
});

onboardingShowButton?.addEventListener("click", () => {
  state.onboardingSkipped = false;
  localStorage.removeItem(ONBOARDING_SKIP_KEY);
  renderOnboarding();
  onboardingPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
});

onboardingPanel?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-onboarding-action]");
  if (!button) return;

  handleOnboardingAction(button.dataset.onboardingAction);
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  console.info("[auth-ui] login:submit");
  if (loginInProgress) {
    authNote.textContent = "Sign in is already in progress.";
    return;
  }
  if (!authForm.reportValidity()) {
    authNote.textContent = "Enter a valid email and password.";
    updateAuthDebug({ lastAuthAction: "login", lastAuthStatus: "validation_failed", lastErrorMessage: authNote.textContent });
    return;
  }
  const form = new FormData(authForm);
  const credentials = Object.fromEntries(form);
  credentials.affiliateCode = state.referralCode;
  credentials.legalConsentAccepted = legalConsent.checked;
  credentials.publicProfileEnabled = Boolean(credentials.publicProfileEnabled);
  const submitButton = authForm.querySelector("button[type='submit']");
  const loginOperationId = ++authOperationVersion;
  loginInProgress = true;
  window.__signalForgeLoginInProgress = true;

  try {
    submitButton.disabled = true;
    submitButton.textContent = "Signing in...";
    authNote.textContent = "Signing in...";
    console.info("[auth-ui] login:request:start");
    console.info("[auth-ui] login:endpoint=/api/auth/login");
    updateAuthDebug({
      authLoading: false,
      signingIn: true,
      endpoint: "/api/auth/login",
      lastAuthAction: "login",
      lastAuthStatus: "loading",
      lastLoginStage: "request_start",
      lastHttpStatus: null,
      lastErrorMessage: ""
    });
    console.info("[auth-ui] login:request_sent");
    const result = await api.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
      timeoutMs: 8000,
      onResponse: ({ status }) => {
        console.info(`[auth-ui] login:response_status=${status}`);
        updateAuthDebug({ lastLoginStage: "response_received", lastHttpStatus: status });
      },
      onPayload: ({ payload }) => {
        const summary = summarizeAuthResponse(payload);
        console.info(`[auth-ui] login:response_json_ok=${Boolean(payload && typeof payload === "object")}`);
        updateAuthDebug({ lastResponseSummary: summary });
      }
    });
    if (result.ok !== true || !result.user || typeof result.user !== "object") {
      const error = new Error("Sign in failed. Please try again.");
      error.code = "unexpected_login_response";
      throw error;
    }
    console.info("[auth-ui] login:save_session:start");
    saveAuthSession(result);
    console.info("[auth-ui] login:save_session:done");
    console.info("[auth-ui] login:success");
    updateAuthDebug({
      signingIn: false,
      lastAuthAction: "login",
      lastAuthStatus: "success",
      lastLoginStage: "session_saved",
      lastResponseSummary: summarizeAuthResponse(result),
      lastErrorMessage: ""
    });
    if (result.verificationRequired) {
      authNote.textContent = result.verificationUnavailable
        ? "Email verification is temporarily unavailable. Your account is saved; contact support for account help."
        : result.developmentVerificationUrl
        ? `Verify your email to activate free signals. Development link: ${result.developmentVerificationUrl}`
        : "Check your email to activate your free signals.";
    }
    history.replaceState({}, "", `${location.pathname}${location.search}#scanner`);
    console.info("[auth-ui] login:navigate:dashboard");
    bootDashboard().catch((error) => {
      console.warn(`[auth-ui] dashboard:hydrate:failed reason=${safeAuthFailureReason(error)}`);
      if (statusLine) statusLine.textContent = "Signed in. Some dashboard data could not load yet; refresh or retry in a moment.";
    });
  } catch (error) {
    const message = getLoginErrorMessage(error);
    if (error.code === "request_timeout") console.warn("[auth-ui] login:timeout");
    console.warn(`[auth-ui] login:failed reason=${safeAuthFailureReason(error)}`);
    console.warn("[auth-ui] login:request:error");
    authNote.textContent = message;
    updateAuthDebug({
      signingIn: false,
      lastAuthAction: "login",
      lastAuthStatus: error.code === "request_timeout" ? "timeout" : "failed",
      lastLoginStage: error.code === "request_timeout" ? "request_timeout" : "request_failed",
      lastHttpStatus: error.statusCode || null,
      lastResponseSummary: error.responseSummary || "response_unavailable",
      lastErrorMessage: message
    });
  } finally {
    if (loginOperationId === authOperationVersion) loginInProgress = false;
    window.__signalForgeLoginInProgress = loginInProgress;
    submitButton.disabled = false;
    submitButton.textContent = "Enter Dashboard";
    console.info("[auth-ui] login:finally");
    updateAuthDebug({ signingIn: loginInProgress });
  }
});

forgotPasswordButton?.addEventListener("click", () => {
  location.hash = "#reset-password";
});

document.querySelector("#auth-api-test")?.addEventListener("click", async () => {
  const button = document.querySelector("#auth-api-test");
  try {
    button.disabled = true;
    button.textContent = "Testing auth API...";
    updateAuthDebug({ endpoint: "/api/auth/health", lastLoginStage: "auth_api_test_start", lastErrorMessage: "" });
    const result = await api.request("/api/auth/health", {
      timeoutMs: 5000,
      onResponse: ({ status }) => updateAuthDebug({ lastHttpStatus: status })
    });
    updateAuthDebug({ lastLoginStage: "auth_api_test_success", lastResponseSummary: `ok=${result?.ok === true}` });
    button.textContent = "Auth API reachable";
  } catch (error) {
    updateAuthDebug({
      lastLoginStage: "auth_api_test_failed",
      lastHttpStatus: error.statusCode || null,
      lastErrorMessage: error.message
    });
    button.textContent = "Auth API test failed";
  } finally {
    button.disabled = false;
  }
});

passwordResetContactSupport?.addEventListener("click", (event) => {
  event.preventDefault();
  history.pushState({}, "", "#account-recovery-support");
  showAccountRecoverySupport();
});

document.querySelector("#recovery-back-to-sign-in")?.addEventListener("click", (event) => {
  event.preventDefault();
  history.pushState({}, "", `${location.pathname}${location.search}#signin`);
  showAuth();
});

accountRecoverySupportForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!accountRecoverySupportForm.reportValidity()) return;
  const button = document.querySelector("#account-recovery-submit");
  try {
    button.disabled = true;
    button.textContent = "Submitting...";
    accountRecoveryStatus.textContent = "Saving your account recovery request...";
    const result = await api.request("/api/support/account-recovery", {
      method: "POST",
      body: JSON.stringify({
        ...Object.fromEntries(new FormData(accountRecoverySupportForm)),
        pageUrl: location.href
      })
    });
    accountRecoverySupportForm.reset();
    accountRecoveryStatus.textContent = `Recovery request submitted for admin review. ${result.detail}`;
  } catch (error) {
    accountRecoveryStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Submit recovery request";
  }
});

backToLoginButton?.addEventListener("click", () => {
  history.pushState({}, "", `${location.pathname}${location.search}#signin`);
  showAuthForm();
});

passwordResetRequestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!emailFeaturesEnabled) {
    passwordResetRequestNote.textContent = "Password reset by email is not available yet. Please contact support if you need help accessing your account.";
    return;
  }
  const submitButton = passwordResetRequestForm.querySelector("button[type='submit']");
  const form = new FormData(passwordResetRequestForm);

  try {
    submitButton.disabled = true;
    passwordResetRequestNote.textContent = "Sending reset link...";
    const result = await api.request("/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email") })
    });
    passwordResetRequestNote.textContent = result.developmentResetUrl
      ? `${result.message} Development link: ${result.developmentResetUrl}`
      : result.message;
  } catch (error) {
    passwordResetRequestNote.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

passwordResetConfirmForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const resetToken = getPasswordResetToken();
  const submitButton = passwordResetConfirmForm.querySelector("button[type='submit']");
  const form = new FormData(passwordResetConfirmForm);

  if (!resetToken) {
    passwordResetConfirmNote.textContent = "Reset link is missing. Request a new password reset email.";
    return;
  }

  try {
    submitButton.disabled = true;
    passwordResetConfirmNote.textContent = "Updating password...";
    await api.request("/api/auth/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({
        token: resetToken,
        password: form.get("password")
      })
    });
    clearPasswordResetParam();
    passwordResetConfirmForm.reset();
    showAuthForm();
    authNote.textContent = "Password updated. Sign in with your new password.";
  } catch (error) {
    passwordResetConfirmNote.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

googleAuthButton.addEventListener("click", async () => {
  if (loginInProgress) {
    authNote.textContent = "Finish the current sign-in attempt before using Google.";
    return;
  }
  if (googleAuthButton.dataset.enabled !== "true") {
    authNote.textContent = "Google sign-in is temporarily unavailable.";
    return;
  }
  if (!legalConsent.checked) {
    authNote.textContent = "Agree to the Terms, Privacy Policy, and Risk Disclaimer before creating or connecting an account.";
    return;
  }

  try {
    googleAuthButton.disabled = true;
    authNote.textContent = "Opening Google sign-in...";
    console.info("[auth-ui] google:request:start");
    updateAuthDebug({ lastAuthAction: "google_login", lastAuthStatus: "loading", lastErrorMessage: "" });
    const { authorizationUrl } = await api.request("/api/auth/google/start", {
      method: "POST",
      body: JSON.stringify({
        affiliateCode: state.referralCode,
        legalConsentAccepted: true
      }),
      timeoutMs: 8000,
      onResponse: ({ status }) => {
        console.info(`[auth-ui] google:request:response status=${status}`);
        updateAuthDebug({ lastHttpStatus: status, lastLoginStage: "google_response" });
      }
    });
    if (!authorizationUrl || !/^https:\/\//.test(authorizationUrl)) {
      const error = new Error("Google sign-in returned an unexpected response.");
      error.code = "unexpected_google_response";
      throw error;
    }
    location.assign(authorizationUrl);
  } catch (error) {
    const message = ["request_timeout", "request_aborted"].includes(error.code) || error.statusCode >= 500
      ? "Could not open Google sign-in right now. Please try again."
      : "Google sign-in failed. Please try again.";
    console.warn(`[auth-ui] google:failed reason=${safeAuthFailureReason(error)}`);
    authNote.textContent = message;
    updateAuthDebug({ lastAuthAction: "google_login", lastAuthStatus: "failed", lastErrorMessage: message });
  } finally {
    googleAuthButton.disabled = googleAuthButton.dataset.enabled !== "true";
    console.info("[auth-ui] google:finally");
  }
});

window.__signalForgeMainAuthReady = true;

resendVerificationButton.addEventListener("click", async () => {
  try {
    resendVerificationButton.disabled = true;
    const result = await api.request("/api/auth/resend-verification", { method: "POST" });
    verificationNote.textContent = result.verificationUnavailable
      ? "Email verification is temporarily unavailable. Contact support for account help."
      : result.developmentVerificationUrl
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
      body: JSON.stringify({ restoreToken: getAuthSession().restoreToken })
    });
  } finally {
    clearAuthSession("logout");
    clearClientAuthState();
  }
  landingPage.classList.remove("hidden");
  dashboard.classList.add("hidden");
  authScreen.classList.add("hidden");
});

profileSettingsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveProfileSettings({
    username: settingsUsername.value,
    publicProfileEnabled: settingsPublicProfile.checked,
    publicLeaderboardEnabled: settingsPublicLeaderboard.checked,
    messageElement: profileSettingsMessage
  });
});

settingsViewLeaderboard?.addEventListener("click", () => navigateTo("leaderboard"));
document.querySelector("#settings-open-support")?.addEventListener("click", () => navigateTo("support"));
document.querySelector("#admin-open-support")?.addEventListener("click", () => navigateTo("admin-support"));

supportTopic?.addEventListener("change", renderSupportIssueOptions);

supportForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#support-submit");
  if (!supportForm.reportValidity()) return;
  try {
    button.disabled = true;
    button.textContent = "Submitting...";
    supportFormStatus.textContent = "Submitting your support request...";
    const form = new FormData(supportForm);
    const result = await api.request("/api/support", {
      method: "POST",
      body: JSON.stringify({
        ...Object.fromEntries(form),
        pageUrl: location.href
      })
    });
    state.support.tickets = result.tickets || [];
    supportForm.reset();
    renderSupportTopicOptions();
    renderSupportTickets();
    supportFormStatus.textContent = result.message || "Support request submitted. You can check the status here inside SignalForge.";
    showToast("Support request submitted");
  } catch (error) {
    supportFormStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Submit support request";
  }
});

adminSupportFilters?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadAdminSupport();
});

adminSupportTicketList?.addEventListener("click", (event) => {
  const ticketId = event.target.closest("[data-admin-support-ticket]")?.dataset.adminSupportTicket;
  if (!ticketId) return;
  state.adminSupport.selectedTicketId = ticketId;
  renderAdminSupportTickets();
  renderAdminSupportDetail();
});

adminSupportDetail?.addEventListener("submit", async (event) => {
  const temporaryPasswordForm = event.target.closest("[data-recovery-temp-password]");
  if (temporaryPasswordForm) {
    event.preventDefault();
    if (!confirm("Set this temporary password and revoke all existing sessions for the matched user?")) return;
    const button = temporaryPasswordForm.querySelector('button[type="submit"]');
    try {
      button.disabled = true;
      const payload = Object.fromEntries(new FormData(temporaryPasswordForm));
      await api.request(`/api/admin/support/${encodeURIComponent(temporaryPasswordForm.dataset.recoveryTempPassword)}/account-recovery/temporary-password`, { method: "POST", body: JSON.stringify(payload) });
      temporaryPasswordForm.reset();
      await loadAdminSupport();
      await lookupRecoveryAccount(temporaryPasswordForm.dataset.recoveryTempPassword);
      showToast("Temporary password set; sessions revoked");
    } catch (error) {
      temporaryPasswordForm.querySelector("[data-recovery-tool-status]").textContent = error.message;
    } finally {
      button.disabled = false;
    }
    return;
  }
  const form = event.target.closest("[data-admin-support-update]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  try {
    button.disabled = true;
    button.textContent = "Saving...";
    const payload = Object.fromEntries(new FormData(form));
    const result = await api.request(`/api/admin/support/${encodeURIComponent(form.dataset.adminSupportUpdate)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    state.adminSupport.selectedTicketId = result.ticket.id;
    await loadAdminSupport();
    showToast("Support request updated");
  } catch (error) {
    const status = form.querySelector("[data-admin-support-status]");
    if (status) status.textContent = error.message;
    button.disabled = false;
    button.textContent = "Save changes";
  }
});

adminSupportDetail?.addEventListener("click", async (event) => {
  const lookupButton = event.target.closest("[data-recovery-account-lookup]");
  if (lookupButton) {
    await lookupRecoveryAccount(lookupButton.dataset.recoveryAccountLookup);
    return;
  }
  const generateButton = event.target.closest("[data-generate-temp-password]");
  if (generateButton) {
    const input = adminSupportDetail.querySelector('input[name="temporaryPassword"]');
    if (input) input.value = generateTemporaryPassword();
    return;
  }
  const revokeButton = event.target.closest("[data-recovery-revoke-sessions]");
  if (!revokeButton || !confirm("Revoke all active sessions and restore tokens for this matched account?")) return;
  try {
    revokeButton.disabled = true;
    await api.request(`/api/admin/support/${encodeURIComponent(revokeButton.dataset.ticketId)}/account-recovery/revoke-sessions`, {
      method: "POST",
      body: JSON.stringify({ targetUserId: revokeButton.dataset.recoveryRevokeSessions })
    });
    await loadAdminSupport();
    await lookupRecoveryAccount(revokeButton.dataset.ticketId);
    showToast("User sessions revoked");
  } catch (error) {
    showToast(error.message);
  } finally {
    revokeButton.disabled = false;
  }
});

usernameOnboardingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveProfileSettings({
    username: onboardingUsername.value,
    publicProfileEnabled: onboardingPublicProfile.checked,
    messageElement: usernameOnboardingMessage
  });
});

document.querySelector("#upgrade-button").addEventListener("click", async () => {
  navigateTo("billing");
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
    navigateTo(link.dataset.viewLink);
  });
});

window.addEventListener("hashchange", handleBrowserRouteChange);
window.addEventListener("popstate", handleBrowserRouteChange);

document.querySelectorAll("[data-nav-section-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.dataset.navSectionToggle;
    state.navSections[section] = !state.navSections[section];
    localStorage.setItem(NAV_SECTIONS_KEY, JSON.stringify(state.navSections));
    renderNavSections();
  });
});

[historyPairFilter, historyTimeframeFilter, historyDirectionFilter, historyStrategyFilter, historyDateFilter, historySortFilter].forEach((filter) => {
  filter.addEventListener("change", () => {
    state.historyFilters = createSignalFilters({
      ...state.historyFilters,
      pair: historyPairFilter.value,
      timeframe: historyTimeframeFilter.value,
      direction: historyDirectionFilter.value,
      strategy: historyStrategyFilter.value,
      dateRange: historyDateFilter.value,
      sort: historySortFilter.value
    });
    updateSignalFilterUrl();
  });
});

historyStatusFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-status]");
  if (!button) return;
  state.historyFilters = createSignalFilters({ ...state.historyFilters, status: button.dataset.historyStatus });
  updateSignalFilterUrl();
});

historySearchFilter?.addEventListener("input", () => {
  state.historyFilters = createSignalFilters({ ...state.historyFilters, search: historySearchFilter.value });
  updateSignalFilterUrl({ replace: true });
});

signalsHistory?.addEventListener("click", (event) => {
  const detailButton = event.target.closest("[data-history-details]");
  if (detailButton) {
    const key = detailButton.dataset.historyDetails;
    if (state.expandedSignalKeys.has(key)) state.expandedSignalKeys.delete(key);
    else state.expandedSignalKeys.add(key);
    renderSignalsHistory();
    if (state.expandedSignalKeys.has(key)) scrollToSignalKey(key);
    return;
  }
  const destination = event.target.closest("[data-signal-empty-action]")?.dataset.signalEmptyAction;
  if (destination) navigateTo(destination);
});

pairSearch.addEventListener("input", async () => {
  await loadPairs(pairSearch.value);
});

scanAllButton.addEventListener("click", async () => {
  const frames = ["1h", "4h", "15m", "5m"];
  const markets = state.marketCatalog.filter((pair) => pair.category === "Crypto" ? pair.effectiveScannerEnabled : pair.status === "active");
  const scanTasks = markets.flatMap((pair) => frames
    .filter((timeframe) => pair.category !== "Crypto" || pair.supportedTimeframes.includes(timeframe))
    .map((timeframe) => ({ symbol: pair.symbol, timeframe })));
  const total = scanTasks.length;
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
    const symbol = scanTasks[progressIndex]?.symbol || scanTasks[0]?.symbol || "market";
    const timeframe = scanTasks[progressIndex]?.timeframe || "timeframe";
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
    await loadCandidates();
    markFirstScanCompleted();
    renderScanResults(result.setups, result.errors, result.diagnostics, result.scanSummary, result.avoidTrades, result.marketBrief);
  } catch (error) {
    updateScanProgress(0, total, "Scan All failed");
    renderScanResults([], [{ symbol: "Scan All", timeframe: "", message: error.message }], null, null, []);
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
        timeframe: state.timeframe,
        setupKey: state.scanResults.find((setup) => setup.symbol === state.selectedPair.symbol && setup.timeframe === state.timeframe)?.setupKey
      })
    });
    state.subscription = subscription;
    renderSubscription();
    await Promise.all([loadCandidates(), loadMarketBrief()]);

    if (!signal) {
      markFirstScanCompleted();
      renderNoSetup(analysis);
      statusLine.textContent = "No valid setup found. No unlock credit was used.";
      return;
    }

    state.scanResults = [];
    state.signals = [signal, ...state.signals];
    markFirstScanCompleted();
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
        scope: telegramScope.value,
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

avoidTradeMore?.addEventListener("click", () => {
  state.showAllAvoidTrades = !state.showAllAvoidTrades;
  renderAvoidTrades();
});

dailyMarketBrief?.addEventListener("click", (event) => {
  if (!event.target.closest("#daily-brief-refresh")) return;
  scanAllButton?.click();
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

document.querySelector("#admin-signal-search")?.addEventListener("input", () => {
  renderAdminSignalMonitor();
});

adminSignalFilters?.addEventListener("submit", (event) => {
  event.preventDefault();
  state.adminSignals.page = 1;
  state.adminSignals.filters = Object.fromEntries(new FormData(adminSignalFilters).entries());
  loadAdminSignals();
});
document.querySelector("#admin-signal-filters-clear")?.addEventListener("click", () => {
  adminSignalFilters.reset(); state.adminSignals.page = 1; state.adminSignals.filters = {}; loadAdminSignals();
});
document.querySelector("#admin-signals-prev")?.addEventListener("click", () => { if (state.adminSignals.page > 1) { state.adminSignals.page -= 1; loadAdminSignals(); } });
document.querySelector("#admin-signals-next")?.addEventListener("click", () => { if (state.adminSignals.page < state.adminSignals.totalPages) { state.adminSignals.page += 1; loadAdminSignals(); } });
adminSignalsTable?.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-admin-signal-copy]");
  if (copy) { await navigator.clipboard.writeText(copy.dataset.adminSignalCopy); showToast("Signal ID copied"); return; }
  const button = event.target.closest("[data-admin-signal-view]");
  if (!button) return;
  try { const { signal } = await api.request(`/api/admin/signals/${encodeURIComponent(button.dataset.adminSignalView)}`); renderAdminSignalDetail(signal); adminSignalModal.classList.remove("hidden"); document.body.classList.add("modal-open"); } catch (error) { showToast(error.message); }
});
adminSignalModal?.addEventListener("click", (event) => { if (event.target.closest("[data-admin-signal-close]")) closeAdminSignalModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !adminSignalModal?.classList.contains("hidden")) closeAdminSignalModal(); });
adminCryptoFilters?.addEventListener("submit", (event) => {
  event.preventDefault();
  state.adminCryptoMarkets.filters = Object.fromEntries(new FormData(adminCryptoFilters).entries());
  loadAdminCryptoMarkets();
});
document.querySelector("#admin-crypto-filter-clear")?.addEventListener("click", () => {
  adminCryptoFilters.reset(); state.adminCryptoMarkets.filters = {}; loadAdminCryptoMarkets();
});
adminCryptoRebuildActive?.addEventListener("click", async () => {
  adminCryptoRebuildActive.disabled = true;
  adminCryptoOperationStatus.textContent = "Rebuilding active Coinbase markets...";
  try {
    const result = await api.request("/api/admin/crypto-markets/rebuild-active", { method: "POST" });
    const rebuild = result.rebuild || {};
    adminCryptoOperationStatus.textContent = `Rebuild complete: Active ${rebuild.active || 0}, Unavailable ${rebuild.unavailable || 0}, Provider error ${rebuild.providerError || 0}, Legacy ${rebuild.legacy || 0}, Disabled preserved ${rebuild.disabledPreserved || 0}.`;
    showToast("Active Coinbase markets rebuilt");
    await loadAdminCryptoMarkets();
    await loadPairs();
  } catch (error) {
    adminCryptoOperationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    adminCryptoRebuildActive.disabled = false;
  }
});
adminCryptoSync?.addEventListener("click", async () => {
  adminCryptoSync.disabled = true;
  adminCryptoOperationStatus.textContent = "Syncing Coinbase USD markets...";
  try {
    const result = await api.request("/api/admin/crypto-markets/sync", { method: "POST" });
    const sync = result.sync || {};
    adminCryptoOperationStatus.textContent = `Coinbase sync complete: products found ${sync.productsFound || 0}, USD crypto pairs ${sync.usdCryptoPairsImported || sync.discovered || 0}, new ${sync.new || sync.imported || 0}, updated ${sync.updated || 0}, missing/legacy ${sync.missingLegacy || 0}.`;
    showToast("Coinbase markets synced");
    await loadAdminCryptoMarkets();
    await loadPairs();
  } catch (error) {
    adminCryptoOperationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    adminCryptoSync.disabled = false;
  }
});
adminCryptoDiagnostics?.addEventListener("click", async () => {
  adminCryptoDiagnostics.disabled = true;
  adminCryptoOperationStatus.textContent = "Testing Coinbase provider sample symbols...";
  try {
    const result = await api.request("/api/admin/crypto-markets/diagnostics", { method: "POST" });
    const rows = result.diagnostics?.results || [];
    adminCryptoOperationStatus.innerHTML = `Coinbase diagnostic complete: ${rows.map((row) =>
      `${escapeHtml(row.symbol)}=${escapeHtml(titleCase(row.finalStatus))}`
    ).join(" · ")}`;
    showToast("Coinbase diagnostics complete");
  } catch (error) {
    adminCryptoOperationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    adminCryptoDiagnostics.disabled = false;
  }
});
adminCryptoVerifyPending?.addEventListener("click", async () => {
  adminCryptoVerifyPending.disabled = true;
  adminCryptoOperationStatus.textContent = "Checking unresolved markets...";
  try {
    const result = await api.request("/api/admin/crypto-markets/verify-pending", { method: "POST" });
    adminCryptoOperationStatus.textContent = `Verification complete: Active ${result.ready || result.active || 0}, Unavailable ${result.unavailable || 0}, Provider error ${result.providerError || 0}, Legacy ${result.legacy || 0}, Unresolved ${result.stillPending || 0}.`;
    await loadAdminCryptoMarkets();
    await loadPairs();
    showToast("Market verification complete");
  } catch (error) {
    adminCryptoOperationStatus.textContent = error.message;
    showToast(error.message);
  } finally {
    adminCryptoVerifyPending.disabled = false;
  }
});
adminCryptoMarketList?.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-crypto-setting]");
  if (!input) return;
  input.disabled = true;
  try {
    await api.request(`/api/admin/crypto-markets/${encodeURIComponent(input.dataset.symbol)}`, {
      method: "PATCH", body: JSON.stringify({ [input.dataset.cryptoSetting]: input.checked })
    });
    showToast("Crypto market setting updated");
  } catch (error) {
    input.checked = !input.checked;
    showToast(error.message);
  } finally {
    await loadAdminCryptoMarkets();
  }
});
adminCryptoMarketList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-crypto-verify]");
  const replaceButton = event.target.closest("[data-crypto-replace]");
  if (replaceButton) {
    const suggested = replaceButton.dataset.replacement || "";
    const replacementSymbol = window.prompt("Replacement Coinbase symbol", suggested);
    if (!replacementSymbol) return;
    try {
      await api.request(`/api/admin/crypto-markets/${encodeURIComponent(replaceButton.dataset.cryptoReplace)}/replace`, {
        method: "POST", body: JSON.stringify({ replacementSymbol })
      });
      showToast("Legacy replacement saved");
      await loadAdminCryptoMarkets();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (!button) return;
  button.disabled = true; button.textContent = "Checking...";
  try {
    const result = await api.request(`/api/admin/crypto-markets/${encodeURIComponent(button.dataset.cryptoVerify)}/verify`, { method: "POST" });
    const market = result.verification?.market || {};
    const label = market.statusLabel || titleCase(market.marketStatus || "unavailable");
    showToast(result.verification.available ? `Verified: ${label}` : `${label}: ${market.lastError || "Verification completed"}`);
  } catch (error) { showToast(error.message); }
  await loadAdminCryptoMarkets();
});

document.querySelector("#admin-error-filter")?.addEventListener("change", () => {
  renderAdminErrorLogs();
});

document.querySelector("#admin-user-search-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#admin-user-search-input");
  const output = document.querySelector("#admin-user-search-results");
  const query = input?.value?.trim() || "";
  if (!query || query.length < 2) {
    output.innerHTML = `<div class="empty-state"><span>Enter at least 2 characters.</span></div>`;
    return;
  }

  try {
    output.innerHTML = `<div class="empty-state"><span>Searching users...</span></div>`;
    const result = await api.request(`/api/admin/users/search?q=${encodeURIComponent(query)}`);
    state.adminUserSearchResults = result.users || [];
    renderAdminUserSearchResults();
  } catch (error) {
    output.innerHTML = `<div class="empty-state"><span>${escapeHtml(error.message)}</span></div>`;
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

document.querySelector("#performance-view")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-performance-open-signals]");
  if (button) navigateTo("signals");
});

document.querySelectorAll("[data-performance-range]").forEach((button) => {
  button.addEventListener("click", async () => {
    const range = button.dataset.performanceRange;
    document.querySelectorAll("[data-performance-range]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    if (range === "all") {
      performanceFrom.value = "";
      performanceTo.value = "";
    } else {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - Number(range));
      performanceFrom.value = toDateInputValue(start);
      performanceTo.value = toDateInputValue(end);
    }

    await loadPerformance();
  });
});

performanceClear.addEventListener("click", async () => {
  performanceFrom.value = "";
  performanceTo.value = "";
  performanceMarket.value = "";
  performanceTimeframe.value = "";
  performanceDirection.value = "";
  performanceOutcome.value = "";
  document.querySelectorAll("[data-performance-range]").forEach((item) => {
    item.classList.toggle("active", item.dataset.performanceRange === "all");
  });
  await loadPerformance();
});

leaderboardTabs?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-leaderboard-tab]");
  if (!button) return;
  state.leaderboardTab = button.dataset.leaderboardTab;
  renderLeaderboards();
});

leaderboardTable?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-leaderboard-action]")?.dataset.leaderboardAction;
  if (!action) return;
  navigateTo(action);
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

paperPortfolioGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-open-journal]");
  if (button) {
    journalMarket.value = button.dataset.journalSymbol;
    journalTimeframe.value = button.dataset.journalTimeframe;
    navigateTo("journal");
    return;
  }
  const closeButton = event.target.closest("[data-paper-close-order]");
  if (closeButton) await performPaperOrderAction(closeButton, "close");
  const cancelButton = event.target.closest("[data-paper-cancel-order]");
  if (cancelButton) await performPaperOrderAction(cancelButton, "cancel");
});

paperMarketSearch.addEventListener("input", () => renderPaperMarketList());
paperTimeframes.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-paper-timeframe]");
  if (!button) return;
  state.paperTrading.timeframe = button.dataset.paperTimeframe;
  await loadPaperTradingTerminal();
});
paperIndicatorControls.addEventListener("change", () => {
  state.paperTrading.indicators = new Set(
    [...paperIndicatorControls.querySelectorAll("input:checked")].map((input) => input.value)
  );
  localStorage.setItem(PAPER_INDICATORS_KEY, JSON.stringify([...state.paperTrading.indicators]));
  renderPaperTradingChart();
});
paperOrderMarket.addEventListener("change", async () => {
  state.paperTrading.selectedSymbol = paperOrderMarket.value;
  await loadPaperTradingTerminal();
});
document.querySelector("#paper-direction-control").addEventListener("click", (event) => {
  const button = event.target.closest("[data-paper-direction]");
  if (!button) return;
  state.paperTrading.direction = button.dataset.paperDirection;
  renderPaperOrderTicket();
});
paperOrderType.addEventListener("change", renderPaperOrderTicket);
[paperLimitPrice, paperOrderQuantity, paperOrderSize, paperOrderStop, paperOrderTarget]
  .forEach((input) => input.addEventListener("input", renderPaperOrderCalculations));
paperOrderForm.addEventListener("submit", placePaperTradingOrder);
paperTerminalTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-paper-tab]");
  if (!button) return;
  state.paperTrading.activeTab = button.dataset.paperTab;
  renderPaperOrders();
});
paperHistoryFilters.addEventListener("input", renderPaperOrders);
paperHistoryFilters.addEventListener("change", renderPaperOrders);
paperResetAccount.addEventListener("click", resetPaperTrading);

signalsGrid.addEventListener("click", async (event) => {
  if (event.target.closest("[data-scan-again]")) {
    scanAllButton.click();
    return;
  }
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
        timeframe: button.dataset.unlockTimeframe,
        setupKey: button.dataset.unlockSetupKey
      })
    });

    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "Setup no longer qualifies. No unlock credit was used.";
      return;
    }

    await completeSignalUnlock({ signal, subscription, alreadyUnlocked, source: "scanner" });
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

document.addEventListener("input", (event) => {
  const control = event.target.closest("[data-calculator-account], [data-calculator-percent], [data-calculator-custom]");
  if (!control) return;
  const calculator = control.closest("[data-risk-calculator]");
  updateRiskCalculator(calculator, { persist: !control.matches("[data-calculator-custom]") });
});

document.addEventListener("click", (event) => {
  const quickRisk = event.target.closest("[data-risk-quick]");
  if (quickRisk) {
    const calculator = quickRisk.closest("[data-risk-calculator]");
    const percentInput = calculator?.querySelector("[data-calculator-percent]");
    const customInput = calculator?.querySelector("[data-calculator-custom]");
    if (!calculator || !percentInput || !customInput) return;
    percentInput.value = quickRisk.dataset.riskQuick;
    customInput.value = "";
    updateRiskCalculator(calculator, { persist: true });
    return;
  }

  const customRisk = event.target.closest("[data-risk-custom-focus]");
  if (customRisk) {
    customRisk.closest("[data-risk-calculator]")?.querySelector("[data-calculator-custom]")?.focus();
  }
});

signalsHistory.addEventListener("click", async (event) => {
  const historicalButton = event.target.closest("[data-expired-history]");
  if (historicalButton) {
    signalsHistory.querySelector("[data-expired-history-details]")?.classList.toggle("hidden");
    return;
  }
  const button = event.target.closest("[data-paper-signal-id]");

  if (button) {
    await enterPaperTrade(button);
  }
});

unlockReveal.addEventListener("click", async (event) => {
  if (event.target.closest("[data-unlock-reveal-close]")) {
    closeUnlockReveal();
    return;
  }

  const paperButton = event.target.closest("[data-paper-signal-id]");
  if (paperButton) {
    await enterPaperTrade(paperButton);
    renderUnlockReveal();
    return;
  }

  if (event.target.closest("[data-unlock-view-analysis]")) {
    closeUnlockReveal();
    return;
  }

  if (event.target.closest("[data-copy-signal-levels]")) {
    await copyUnlockedSignalLevels();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !unlockReveal.classList.contains("hidden")) {
    closeUnlockReveal();
  }
});

async function unlockSignal(button, symbol, timeframe) {
  try {
    button.disabled = true;
    statusLine.textContent = `Unlocking ${symbol} ${timeframe}...`;
    const { signal, subscription, analysis, alreadyUnlocked } = await api.request("/api/signals/generate", {
      method: "POST",
      body: JSON.stringify({ symbol, timeframe, setupKey: button.dataset.unlockSetupKey })
    });

    state.subscription = subscription;
    renderSubscription();

    if (!signal) {
      renderNoSetup(analysis);
      statusLine.textContent = "Setup no longer qualifies. No unlock credit was used.";
      return;
    }

    await completeSignalUnlock({ signal, subscription, alreadyUnlocked, source: "scanner" });
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function enterPaperTrade(button) {
  const signal = state.signals.find((item) => item.id === button.dataset.paperSignalId);
  if (!signal) {
    statusLine.textContent = "Unlocked signal not found.";
    return;
  }
  const validity = getSignalValidityState(signal);
  if (validity.status === "expired") {
    statusLine.textContent = "This signal is expired. You can view it for learning, but it should not be treated as a current setup.";
    showToast("Expired signals cannot be opened as fresh paper trades");
    return;
  }
  if (validity.status === "expiring-soon") {
    showToast("This signal is close to expiring. Price conditions may have changed.");
  }
  state.paperTrading.draftSignalId = signal.id;
  state.paperTrading.selectedSymbol = signal.symbol;
  state.paperTrading.timeframe = signal.timeframe;
  state.paperTrading.direction = signal.direction;
  unlockReveal.classList.add("hidden");
  document.body.classList.remove("unlock-reveal-open");
  state.unlockedRevealSignalId = null;
  sessionStorage.removeItem(UNLOCK_REVEAL_KEY);
  navigateTo("paper-trading", { pair: getDisplaySymbol(signal.symbol) }, { skipPaperLoad: true });
  await loadPaperTradingTerminal();
  prefillPaperOrderFromSignal(signal);
  showToast("Paper order ticket pre-filled");
}

async function init() {
  const restoreOperationId = ++authOperationVersion;
  console.info(`[app] build_version=${window.__SIGNALFORGE_BUILD_VERSION__ || "development"}`);
  console.info("[auth] restore:start");
  updateAuthDebug({
    started: true,
    restoreStarted: true,
    status: "restore_started",
    restoreStatus: "started",
    authLoading: true,
    signingIn: false,
    endpoint: "/api/auth/session",
    lastLoginStage: "session_restore"
  });
  setSplashStatus("Restoring your session");
  renderHowItWorksPages();
  if (window.__signalForgeHardClearInProgress) return;
  if (isDebugBuildRoute()) {
    showDebugBuildPage();
    return;
  }
  if (isClearSessionRoute()) {
    await emergencyClearSession();
    return;
  }
  if (isAccountRecoveryRoute()) {
    setSplashStatus("Opening account recovery support");
    showAccountRecoverySupport();
    return;
  }
  if (isPasswordResetRequestRoute()) {
    const authConfig = await loadAuthConfig();
    applyAuthConfig(authConfig);
    updateAuthDebug({ authLoading: false, status: "public_auth_route", endpoint: "not_called" });
    showPasswordResetRequest();
    hideSplash();
    return;
  }
  if (isPublicProfileRoute()) {
    setSplashStatus("Loading public profile");
    await loadPublicProfileRoute();
    return;
  }
  await captureAffiliateReferral();
  const oauthError = new URLSearchParams(location.search).get("oauth_error");
  const oauthSuccess = new URLSearchParams(location.search).get("oauth") === "success";
  const verificationToken = new URLSearchParams(location.search).get("verify");
  const passwordResetToken = getPasswordResetToken();
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
  applyAuthConfig({ googleEnabled: false, emailFeaturesEnabled: false });
  loadAuthConfig()
    .then(applyAuthConfig)
    .catch((error) => console.warn(`[auth] Auth config refresh failed: ${error.message}`));
  const restoreController = new AbortController();
  const restoreTimeout = window.setTimeout(() => restoreController.abort(), AUTH_RESTORE_TIMEOUT_MS);
  let session;
  try {
    session = await loadStartupSession({ signal: restoreController.signal, operationId: restoreOperationId });
  } catch (error) {
    if (!isAuthOperationCurrent(restoreOperationId)) {
      console.info("[auth] restore:stale_result_ignored");
      return;
    }
    if (restoreController.signal.aborted) {
      console.warn("[auth] restore:timeout");
      updateAuthDebug({ status: "restore_timeout", timeout: true, failureReason: "timeout" });
      const timeoutError = new Error("Session restore timed out.");
      timeoutError.code = "restore_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(restoreTimeout);
  }
  if (!isAuthOperationCurrent(restoreOperationId) || loginInProgress) {
    console.info("[auth] restore:stale_result_ignored");
    return;
  }
  updateAuthDebug({ authLoading: false });
  const user = session.user;

  state.user = user;

  if (passwordResetToken) {
    setSplashStatus("Opening password reset");
    publicProfilePage?.classList.add("hidden");
    landingPage.classList.add("hidden");
    dashboard.classList.add("hidden");
    authScreen.classList.remove("hidden");
    showPasswordResetConfirm();
    return;
  }

  if (user) {
    setSplashStatus("Opening your dashboard");
    if (isPublicAuthRoute()) {
      history.replaceState({}, "", `${location.pathname}${location.search}#scanner`);
    }
    if (oauthSuccess) {
      history.replaceState({}, "", `${location.pathname}${location.hash}`);
    }
    await bootDashboard();
  } else if (isHowItWorksRoute()) {
    setSplashStatus("Opening SignalForge guide");
    showPublicHowItWorks();
  } else if (isPasswordResetRequestRoute()) {
    setSplashStatus("Opening account recovery");
    showPasswordResetRequest();
  } else if (isPublicAuthRoute()) {
    setSplashStatus("Opening sign in");
    showAuth();
    authNote.textContent = "Please sign in to continue.";
  } else {
    setSplashStatus("Preparing your market desk");
    const showAuthCallback = Boolean(
      oauthError ||
      verificationToken ||
      getPendingTelegramUnlockKey() ||
      isPublicAuthRoute() ||
      isProtectedAppRoute()
    );
    if (showAuthCallback) {
      showAuth();
    } else {
      publicProfilePage?.classList.add("hidden");
      authScreen.classList.add("hidden");
      dashboard.classList.add("hidden");
      landingPage.classList.remove("hidden");
    }
    if (getPendingTelegramUnlockKey()) {
      authNote.textContent = "Sign in to unlock this Telegram signal preview.";
    }
    if (oauthError) {
      authNote.textContent = googleOAuthErrorMessage(oauthError);
      history.replaceState({}, "", `${location.pathname}${location.hash}`);
    } else if (isProtectedAppRoute() || isPublicAuthRoute()) {
      authNote.textContent = "Please sign in to continue.";
    }
  }
}

function setSplashStatus(message) {
  if (appSplashStatus) appSplashStatus.textContent = message;
}

async function loadStartupSession({ signal, operationId } = {}) {
  let cookieFailure = null;
  try {
    const session = await api.request("/api/auth/session", { signal });
    if (!isValidSessionPayload(session)) {
      console.warn("[auth] restore:failed reason=unexpected_session_response");
      const error = new Error("The session endpoint returned an unexpected response.");
      error.code = "unexpected_session_response";
      throw error;
    }
    if (isAuthOperationCurrent(operationId)) saveAuthSession(session);

    if (session.user) {
      console.info(`[auth] restore:success user_id=${safeAuthLogId(session.user.id)}`);
      updateAuthDebug({
        status: "restore_success",
        restoreStatus: "success",
        currentUserLoaded: true,
        routeAfterRestore: getHashRoute(),
        userId: safeAuthLogId(session.user.id)
      });
      console.info("[auth] Cookie session restored.");
      return session;
    }

    console.info("[auth] No cookie session found; checking persistent restore token.");
  } catch (error) {
    if (signal?.aborted || error.code === "request_aborted") throw error;
    cookieFailure = error;
    console.warn(`[auth] Cookie session check failed; trying persistent restore token. ${error.message}`);
  }

  const user = await restoreSavedSession({ signal, cookieFailure, operationId });
  return { user };
}

async function loadAuthConfig({ signal } = {}) {
  try {
    return await api.request("/api/auth/config", { signal });
  } catch (error) {
    if (signal?.aborted || error.code === "request_aborted") throw error;
    console.warn(`[auth] Auth config failed to load: ${error.message}`);
    return {
      demoEnabled: false,
      googleEnabled: false,
      emailFeaturesEnabled: false
    };
  }
}

function applyAuthConfig(authConfig = {}) {
  emailFeaturesEnabled = Boolean(authConfig.emailFeaturesEnabled);
  passwordResetUnavailable?.classList.toggle("hidden", emailFeaturesEnabled);
  passwordResetEmailField?.classList.toggle("hidden", !emailFeaturesEnabled);
  passwordResetSubmit?.classList.toggle("hidden", !emailFeaturesEnabled);
  adminEmailWarning?.classList.toggle("hidden", emailFeaturesEnabled);
  viewDemoButton.classList.remove("hidden");
  googleAuthButton.classList.remove("hidden");
  googleAuthButton.dataset.enabled = String(Boolean(authConfig.googleEnabled));
  googleAuthButton.disabled = !authConfig.googleEnabled;
  googleAuthButton.textContent = authConfig.googleEnabled
    ? "Continue with Google"
    : "Google sign-in temporarily unavailable";
  googleAuthButton.setAttribute("aria-disabled", String(!authConfig.googleEnabled));
}

async function restoreSavedSession({ signal, cookieFailure = null, operationId } = {}) {
  if (!isAuthOperationCurrent(operationId)) return null;
  const restoreToken = getAuthSession().restoreToken;
  if (!restoreToken) {
    console.info("[auth] No persistent restore token found.");
    if (cookieFailure && !isMissingSessionFailure(cookieFailure)) throw cookieFailure;
    if (cookieFailure && isAuthOperationCurrent(operationId)) clearSavedAuthStorage("invalid_cookie_session");
    return null;
  }

  try {
    setSplashStatus("Reopening your saved session");
    const result = await api.request("/api/auth/restore", {
      method: "POST",
      body: JSON.stringify({ restoreToken }),
      signal
    });
    if (!isValidRestoredSessionPayload(result)) {
      console.warn("[auth] restore:failed reason=unexpected_restore_response");
      const error = new Error("The restore endpoint returned an unexpected response.");
      error.code = "unexpected_restore_response";
      throw error;
    }
    if (!isAuthOperationCurrent(operationId)) return null;
    saveAuthSession(result);
    console.info(`[auth] restore:success user_id=${safeAuthLogId(result.user.id)}`);
    updateAuthDebug({
      status: "restore_success",
      restoreStatus: "success",
      currentUserLoaded: true,
      routeAfterRestore: getHashRoute()
    });
    console.info("[auth] Persistent restore token succeeded.");
    return result.user;
  } catch (error) {
    if (signal?.aborted || error.code === "request_aborted") throw error;
    if (isPermanentRestoreFailure(error)) {
      if (isAuthOperationCurrent(operationId)) clearSavedAuthStorage("invalid_or_expired_restore_token");
      console.warn(`[auth] restore:failed reason=${safeAuthFailureReason(error)}`);
      return null;
    }
    console.warn(`[auth] Persistent restore token failed: ${error.message}`);
    throw error;
  }
}

function isPermanentRestoreFailure(error) {
  return [400, 401, 403, 404, 410].includes(error.statusCode);
}

function isMissingSessionFailure(error) {
  return [401, 403].includes(error?.statusCode);
}

function isValidSessionPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    Object.prototype.hasOwnProperty.call(payload, "user") &&
    (payload.user === null || typeof payload.user === "object")
  );
}

function isValidRestoredSessionPayload(payload) {
  return Boolean(payload && typeof payload === "object" && payload.user && typeof payload.user === "object");
}

function safeAuthLogId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
}

function safeAuthFailureReason(error) {
  return String(error?.code || error?.statusCode || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function isAuthOperationCurrent(operationId) {
  return operationId === undefined || operationId === authOperationVersion;
}

function getLoginErrorMessage(error) {
  if (error?.code === "request_timeout") {
    return "Sign in timed out. Please try again.";
  }
  if ([401, 403].includes(error?.statusCode) || error?.code === "invalid_credentials") {
    return "Invalid email or password.";
  }
  if (error?.statusCode === 404) {
    return "Sign in is currently unavailable.";
  }
  if (error?.code === "invalid_json") {
    return "Sign in failed. Server returned an invalid response.";
  }
  if (error?.code === "request_aborted" || error?.statusCode >= 500) {
    return "Could not sign in right now. Please try again.";
  }
  if (error?.code === "unexpected_login_response" || error?.code === "invalid_json") {
    return "Sign in failed. Please try again.";
  }
  return error?.message || "Sign in failed. Please try again.";
}

function saveAuthSession(session = {}) {
  if (session.user && typeof session.user === "object") state.user = session.user;
  const saved = authStorage?.saveAuthSession
    ? authStorage.saveAuthSession(session)
    : saveRestoreToken(session.restore || ((session.restoreToken || session.token) ? {
      token: session.restoreToken || session.token,
      expiresAt: session.expiresAt || session.restoreTokenExpiresAt
    } : null));
  updateAuthDebug({
    hasStoredToken: Boolean(getAuthSession().restoreToken),
    hasStoredUser: false,
    currentUserLoaded: Boolean(state.user)
  });
  return saved;
}

function getAuthSession() {
  const stored = authStorage?.getAuthSession?.() || {};
  return {
    user: state.user,
    token: stored.token || stored.restoreToken || getRestoreToken(),
    restoreToken: stored.restoreToken || stored.token || getRestoreToken(),
    expiresAt: stored.expiresAt || ""
  };
}

function saveRestoreToken(restore) {
  if (!restore?.token) return;
  if (authStorage?.saveAuthSession) {
    authStorage.saveAuthSession({ restore });
    return;
  }
  try {
    localStorage.setItem(RESTORE_TOKEN_KEY, restore.token);
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage write failed: ${error.message}`);
  }
}

function getRestoreToken() {
  if (authStorage?.getAuthSession) return authStorage.getAuthSession().restoreToken || "";
  try {
    return localStorage.getItem(RESTORE_TOKEN_KEY) || "";
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage read failed: ${error.message}`);
    return "";
  }
}

function clearRestoreToken() {
  authStorage?.clearAuthSession?.();
  try {
    localStorage.removeItem(RESTORE_TOKEN_KEY);
  } catch (error) {
    console.warn(`[auth] Persistent restore localStorage clear failed: ${error.message}`);
  }
}

function clearSavedAuthStorage(reason = "restore_failed") {
  authStorage?.clearAuthSession?.();
  const shouldRemove = (key) => {
    const normalized = String(key || "").toLowerCase();
    return normalized === RESTORE_TOKEN_KEY ||
      LEGACY_AUTH_STORAGE_KEYS.has(normalized) ||
      (/^signalforge[-_:]/.test(normalized) && /(auth|session|token|restore|user)/.test(normalized));
  };

  for (const storage of [localStorage, sessionStorage]) {
    try {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);
      keys.filter(shouldRemove).forEach((key) => storage.removeItem(key));
    } catch (error) {
      console.warn(`[auth] Saved session storage cleanup failed: ${error.message}`);
    }
  }

  for (const name of ["signalforge_session", "__Secure-signalforge_session", "__Host-signalforge_session"]) {
    document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
    document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; Secure`;
  }

  console.info(`[auth] local_session:cleared reason=${safeAuthFailureReason({ code: reason })}`);
  updateAuthDebug({ status: "local_session_cleared", failureReason: reason });
}

function clearAuthSession(reason = "user_requested") {
  clearSavedAuthStorage(reason);
  state.user = null;
}

async function emergencyClearSession() {
  const restoreToken = getAuthSession().restoreToken;
  api.request("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({ restoreToken }),
    timeoutMs: 2000
  }).catch(() => {});
  clearAuthSession("emergency_route");
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  const cleanup = [];
  if ("caches" in window) {
    cleanup.push(
      caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("signalforge-")).map((key) => caches.delete(key))
      ))
    );
  }
  if ("serviceWorker" in navigator) {
    cleanup.push(
      navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(
        registrations.map((registration) => registration.unregister())
      ))
    );
  }
  await Promise.allSettled(cleanup);
  history.replaceState({}, "", `${location.pathname}${location.search}#signin`);
  showAuth();
  authNote.textContent = "Saved session cleared. Please sign in again.";
  authRestoreFailure?.classList.add("hidden");
  hideSplash();
}

function updateAuthDebug(update = {}) {
  const debug = window.__signalForgeAuthDebug || {
    buildVersion: window.__SIGNALFORGE_BUILD_VERSION__ || "development"
  };
  Object.assign(debug, update);
  const storedSession = getAuthSession();
  debug.hasStoredToken = Boolean(storedSession.restoreToken);
  debug.hasStoredUser = false;
  debug.hasRestoreToken = Boolean(storedSession.restoreToken);
  debug.currentUserLoaded = Boolean(state.user);
  window.__signalForgeAuthDebug = debug;
  const hashParams = new URLSearchParams(String(location.hash || "").split("?")[1] || "");
  if (new URLSearchParams(location.search).get("debugAuth") !== "1" && hashParams.get("debugAuth") !== "1") return;
  const panel = document.querySelector("#auth-debug-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.textContent = [
    `Build: ${debug.buildVersion || "development"}`,
    `Route: ${getHashRoute()}`,
    `Auth loading: ${Boolean(debug.authLoading)}`,
    `Signing in: ${Boolean(debug.signingIn)}`,
    `Stored token: ${debug.hasStoredToken}`,
    `Stored user: ${debug.hasStoredUser}`,
    `Restore started: ${Boolean(debug.started)}`,
    `Restore status: ${debug.restoreStatus || debug.status || "idle"}`,
    `Restore HTTP status: ${debug.restoreHttpStatus ?? debug.statusCode ?? "none"}`,
    `Current user loaded: ${debug.currentUserLoaded}`,
    `Route after restore: ${debug.routeAfterRestore || "none"}`,
    `Last stage: ${debug.lastLoginStage || debug.status || "idle"}`,
    `HTTP status: ${debug.lastHttpStatus ?? debug.statusCode ?? "none"}`,
    `Endpoint: ${debug.endpoint || "none"}`,
    `Response: ${debug.lastResponseSummary || "none"}`,
    `Local token: ${hasLegacyLocalAuthToken()}`,
    `Restore token: ${debug.hasRestoreToken}`,
    `Last error: ${debug.lastErrorMessage || debug.failureReason || "none"}`
  ].join(" | ");
}

function hasLegacyLocalAuthToken() {
  try {
    return ["signalforge-auth-token", "auth-token", "access-token", "token"]
      .some((key) => Boolean(localStorage.getItem(key)));
  } catch {
    return false;
  }
}

function summarizeAuthResponse(payload) {
  if (!payload || typeof payload !== "object") return "invalid_or_empty";
  const errorCode = typeof payload.error === "string"
    ? payload.error
    : payload.error?.code || (payload.ok === false ? "request_failed" : "none");
  return [
    `ok=${payload.ok === true}`,
    `user=${Boolean(payload.user && typeof payload.user === "object")}`,
    `token=${Boolean(payload.token)}`,
    `restoreToken=${Boolean(payload.restoreToken || payload.restore?.token)}`,
    `error=${String(errorCode).replace(/[^a-z0-9_-]/gi, "_").slice(0, 48)}`
  ].join(" ");
}

function clearClientAuthState() {
  setMobileNavigationOpen(false);
  const scannerMode = getStoredScannerMode();
  const navSections = getStoredNavSections();
  localStorage.clear();
  localStorage.setItem(SIGNAL_VIEW_MODE_KEY, scannerMode);
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
  state.onboardingSkipped = false;
  state.firstScanCompleted = false;
  state.signals = [];
  state.candidates = [];
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
  state.adminAnalytics = null;
  state.adminDashboard = null;
  state.adminUserSearchResults = [];
  state.validationDashboard = null;
  state.abuseDashboard = {
    flaggedAccounts: [],
    accountsPerIp: [],
    repeatedDevices: [],
    disposableEmails: []
  };
  state.profile = null;
  state.publicProfile = null;
  state.performance = null;
  state.leaderboards = null;
  state.leaderboardTab = "topRMultiple";
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
  publicProfilePage?.classList.add("hidden");
  publicHowItWorksPage?.classList.add("hidden");
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.querySelector("#user-name").textContent = getUserDisplayName();
  adminNavLink.classList.toggle("hidden", !state.user.isAdmin);
  adminSignalsNavLink.classList.toggle("hidden", !state.user.isAdmin);
  adminCryptoMarketsNavLink.classList.toggle("hidden", !state.user.isAdmin);
  adminSupportNavLink.classList.toggle("hidden", !state.user.isAdmin);
  affiliateAdminNavLink.classList.toggle("hidden", !state.user.isAdmin);
  webhookEventsNavLink.classList.toggle("hidden", !state.user.isAdmin);
  testerAccountBadge.classList.toggle("hidden", state.user.role !== "tester");
  renderNavSections();
  syncSignalViewToggles();

  const dashboardLoads = await Promise.allSettled([
    loadPairs(),
    loadSubscription(),
    loadSignals(),
    loadCandidates(),
    loadMarketBrief(),
    loadWatchlist(),
    loadAlerts(),
    loadNotifications(),
    loadTesterAccess(),
    loadProfile()
  ]);
  reportDashboardLoadFailures(dashboardLoads);

  if (state.user.isAdmin) {
    try {
      await Promise.all([loadAdminRequests(), loadCandidateQuality()]);
    } catch (error) {
      reportDashboardLoadFailures([{ status: "rejected", reason: error }]);
    }
  }
  renderTimeframes();
  syncRouteFromLocation({ force: true, replaceInvalid: true });
  renderOnboarding();
  renderCheckoutReturnStatus();
  startSignalHistoryRefresh();

  try {
    await loadMarketData();
  } catch (error) {
    reportDashboardLoadFailures([{ status: "rejected", reason: error }]);
  }

  await processPendingTelegramUnlock();
  await restoreUnlockReveal();
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

function getPendingTelegramUnlockKey() {
  const hashParams = parseAppHash(location.hash).params;
  const fromUrl = new URLSearchParams(location.search).get("telegramUnlock") ||
    hashParams.get("unlock") ||
    hashParams.get("telegramUnlock") ||
    "";
  if (fromUrl) {
    sessionStorage.setItem(TELEGRAM_UNLOCK_KEY, fromUrl);
    return fromUrl;
  }

  return sessionStorage.getItem(TELEGRAM_UNLOCK_KEY) || "";
}

async function processPendingTelegramUnlock() {
  const setupKey = getPendingTelegramUnlockKey();
  if (!setupKey) return;

  try {
    statusLine.textContent = "Unlocking Telegram signal preview...";
    const { signal, subscription, alreadyUnlocked, expired, message, historicalAnalysis } = await api.request("/api/signals/telegram-unlock", {
      method: "POST",
      body: JSON.stringify({ setupKey })
    });

    state.subscription = subscription;
    renderSubscription();

    if (expired) {
      state.telegramExpiredNotice = { message, signal: historicalAnalysis };
      removeTelegramUnlockParam();
      navigateTo("signals", {}, { replace: true });
      renderSignalsHistory();
      statusLine.textContent = message;
      return;
    }

    if (!signal) {
      statusLine.textContent = "Telegram signal preview could not be unlocked.";
      return;
    }

    removeTelegramUnlockParam();
    await completeSignalUnlock({ signal, subscription, alreadyUnlocked, source: "telegram" });
  } catch (error) {
    statusLine.textContent = error.message;
    navigateTo("signals", {}, { replace: true });
  }
}

function removeTelegramUnlockParam() {
  const url = new URL(location.href);
  url.searchParams.delete("telegramUnlock");
  const parsed = parseAppHash(url.hash);
  parsed.params.delete("unlock");
  parsed.params.delete("telegramUnlock");
  url.hash = buildRouteHash(parsed.valid ? parsed.route : "signals", parsed.params);
  sessionStorage.removeItem(TELEGRAM_UNLOCK_KEY);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  state.lastAppliedRouteHash = url.hash;
}

function showAuth() {
  setMobileNavigationOpen(false);
  debugBuildPage?.classList.add("hidden");
  clearSessionPage?.classList.add("hidden");
  publicProfilePage?.classList.add("hidden");
  publicHowItWorksPage?.classList.add("hidden");
  landingPage.classList.add("hidden");
  dashboard.classList.add("hidden");
  authScreen.classList.remove("hidden");
  authRestoreFailure?.classList.add("hidden");
  showAuthForm();
  document.querySelector("#auth-api-test")?.classList.toggle("hidden", !isAuthDebugEnabled());
}

function isAuthDebugEnabled() {
  const hashParams = new URLSearchParams(String(location.hash || "").split("?")[1] || "");
  return new URLSearchParams(location.search).get("debugAuth") === "1" || hashParams.get("debugAuth") === "1";
}

function isPasswordResetRequestRoute() {
  return ["#forgot-password", "#reset-password"].includes(getHashRoute()) && !getPasswordResetToken();
}

function showAuthForm() {
  accountRecoverySupportPage?.classList.add("hidden");
  authForm?.classList.remove("hidden");
  passwordResetRequestForm?.classList.add("hidden");
  passwordResetConfirmForm?.classList.add("hidden");
  const signupMode = getHashRoute() === "#signup";
  for (const fieldName of ["name", "username", "publicProfileEnabled"]) {
    const input = authForm?.elements?.namedItem(fieldName);
    const label = input?.closest("label");
    label?.classList.toggle("hidden", !signupMode);
    if (input) input.disabled = !signupMode;
  }
  const heading = authForm?.querySelector("h2");
  const submit = authForm?.querySelector('button[type="submit"]');
  if (heading) heading.textContent = signupMode ? "Create your account" : "Sign in";
  if (submit && !loginInProgress) submit.textContent = signupMode ? "Create account" : "Sign in";
  if (authNote && !loginInProgress) {
    authNote.textContent = signupMode
      ? "Create your account to start with 3 signal unlocks."
      : "Sign in to continue to your SignalForge dashboard.";
  }
}

function showPasswordResetRequest() {
  showAuth();
  authForm?.classList.add("hidden");
  passwordResetRequestForm?.classList.remove("hidden");
  passwordResetConfirmForm?.classList.add("hidden");
  passwordResetRequestNote.textContent = emailFeaturesEnabled
    ? "Password recovery availability is checked securely."
    : "Email password reset is not available yet. Submit an account recovery request.";
}

function isAccountRecoveryRoute() {
  return getHashRoute() === "#account-recovery-support";
}

function isClearSessionRoute() {
  return getHashRoute() === "#clear-session";
}

function isDebugBuildRoute() {
  return getHashRoute() === "#debug-build";
}

async function showDebugBuildPage() {
  publicProfilePage?.classList.add("hidden");
  publicHowItWorksPage?.classList.add("hidden");
  accountRecoverySupportPage?.classList.add("hidden");
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
  clearSessionPage?.classList.add("hidden");
  debugBuildPage?.classList.remove("hidden");
  document.querySelector("#debug-build-route").textContent = location.hash || "none";
  document.querySelector("#debug-build-local-auth").textContent = hasStoredAuthKeys(localStorage) ? "Yes" : "No";
  document.querySelector("#debug-build-session-auth").textContent = hasStoredAuthKeys(sessionStorage) ? "Yes" : "No";
  const workerStatus = document.querySelector("#debug-build-service-worker");
  try {
    const registrations = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    workerStatus.textContent = registrations.length ? "Yes" : "No";
  } catch {
    workerStatus.textContent = "Unavailable";
  }
  hideSplash();
}

function hasStoredAuthKeys(storage) {
  try {
    return Array.from({ length: storage.length }, (_, index) => String(storage.key(index) || "").toLowerCase())
      .some((key) => key === "token" || key === "user" ||
        /(signalforge.*(auth|session|token|restore|user))/.test(key));
  } catch {
    return false;
  }
}

function isPublicAuthRoute() {
  return ["#signin", "#signup", "#forgot-password", "#reset-password"].includes(getHashRoute());
}

function showAccountRecoverySupport() {
  publicProfilePage?.classList.add("hidden");
  publicHowItWorksPage?.classList.add("hidden");
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
  accountRecoverySupportPage?.classList.remove("hidden");
}

function isHowItWorksRoute() {
  return parseAppHash(location.hash).route === "how-it-works";
}

function isProtectedAppRoute() {
  const parsed = parseAppHash(location.hash);
  return parsed.valid && parsed.route !== "how-it-works";
}

function isPublicStartupRoute() {
  const hashRoute = getHashRoute();
  return isPublicRoute(hashRoute) || [
    "#top",
    "#quick-start",
    "#why-signalforge",
    "#features",
    "#live-preview",
    "#markets-covered",
    "#affiliate-program",
    "#faq",
    "#forgot-password",
  ].includes(hashRoute) || isPublicProfileRoute();
}

function showPublicHowItWorks({ updateHistory = false } = {}) {
  renderHowItWorksPages();
  if (updateHistory && location.hash !== "#how-it-works") {
    history.pushState({}, "", `${location.pathname}${location.search}#how-it-works`);
  }
  publicProfilePage?.classList.add("hidden");
  accountRecoverySupportPage?.classList.add("hidden");
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
  publicHowItWorksPage?.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showLandingFromTrustPage() {
  history.pushState({}, "", `${location.pathname}${location.search}#top`);
  publicHowItWorksPage?.classList.add("hidden");
  publicProfilePage?.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
  landingPage.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHowItWorksPages() {
  const markup = renderHowItWorksContent();
  document.querySelectorAll("[data-how-it-works-content]").forEach((container) => {
    container.innerHTML = markup;
  });
}

function renderHowItWorksContent() {
  return `
    <div class="trust-page">
      <section class="trust-hero">
        <span class="eyebrow">Transparent market analysis</span>
        <h1>How SignalForge Works</h1>
        <p>SignalForge scans crypto markets for structured trading setups using rule-based analysis, risk/reward checks, and market condition filters.</p>
        <div class="trust-actions">
          <button type="button" data-how-it-works-start>Start scanning</button>
          <button class="secondary-action" type="button" data-how-risk-disclaimer>View risk disclaimer</button>
        </div>
      </section>

      <div class="trust-card-grid trust-card-grid-primary">
        ${renderTrustCard("What it does", "A structured workflow from scan to review.", [
          "Scans supported crypto markets across available timeframes.",
          "Checks trend, momentum, volume, structure, volatility, and risk/reward.",
          "Watches developing setups before promoting them.",
          "Alerts users when a validated setup becomes ready.",
          "Lets users unlock full details, paper trade, and review outcomes."
        ], "does")}
        ${renderTrustCard("What it does not do", "Clear limits matter.", [
          "Does not guarantee profit or provide financial advice.",
          "Does not place real trades or connect to brokers.",
          "Does not know the future or predict every market move.",
          "Does not force every scanned market into a signal."
        ], "does-not")}
      </div>

      <section class="trust-confidence-card">
        <div>
          <span class="eyebrow">Confidence explained</span>
          <h2>Rule alignment, not win probability.</h2>
          <p>Confidence reflects how well a setup matches SignalForge's rules. It is not a probability of profit.</p>
        </div>
        <div class="trust-confidence-examples">
          <article><strong>Higher confidence</strong><span>More required rules aligned and fewer material risk factors were found.</span></article>
          <article><strong>Lower confidence</strong><span>Fewer confirmations aligned, or the setup carried more unresolved risk.</span></article>
        </div>
      </section>

      <div class="trust-card-grid">
        ${renderTrustCard("Watching setups", "Possible ideas that are not ready yet.", [
          "Waiting for volume confirmation.",
          "Price is too far from the intended entry.",
          "Risk/reward is not strong enough.",
          "Candle confirmation is missing or trend context conflicts."
        ], "watching")}
        ${renderTrustCard("Avoid trade zones", "Sometimes the best result is no trade.", [
          "The market is choppy or trend direction is unclear.",
          "Volume or risk/reward is weak.",
          "Price is overextended or too close to opposing structure."
        ], "avoid")}
        ${renderTrustCard("Unlocks and credits", "Pay only for eligible full signal details.", [
          "Previews appear before unlock; Entry, Stop Loss, and Take Profit remain protected.",
          "A credit is used only when an eligible signal is unlocked.",
          "Expired signals do not charge as fresh unlocks.",
          "Watching setups and Avoid Trade cards are free to view."
        ], "credits")}
        ${renderTrustCard("Paper trading", "Simulated practice, never a real order.", [
          "Uses no real money and does not connect to a broker.",
          "Helps users test signals and practice risk management.",
          "Simulated results may differ from real execution."
        ], "paper")}
        ${renderTrustCard("Risk management", "Every signal can lose.", [
          "Stop loss and position sizing remain important.",
          "Users choose their own risk and remain responsible for decisions.",
          "The position-size calculator is an estimate, not a recommendation.",
          "High risk per trade can cause substantial losses."
        ], "risk")}
        ${renderTrustCard("Learning engine", "Outcome review improves context, not certainty.", [
          "Reviews TP, SL, expired, rejected, and watched setups.",
          "Uses post-mortem tags to improve scoring over time.",
          "Learning never overrides validation rules.",
          "Adjustments require enough real sample data to become meaningful."
        ], "learning")}
      </div>

      <section class="trust-final-disclaimer">
        <span class="eyebrow">Final disclaimer</span>
        <h2>Educational analysis with visible limits.</h2>
        <p>SignalForge is an educational market analysis tool. It is not financial advice, investment advice, or a guarantee of results. Trading involves risk, including possible loss of capital.</p>
      </section>
    </div>`;
}

function renderTrustCard(title, subtitle, items, type) {
  return `
    <article class="trust-card trust-card-${type}">
      <span class="trust-card-label">${escapeHtml(title)}</span>
      <h2>${escapeHtml(subtitle)}</h2>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </article>`;
}

function showPasswordResetConfirm() {
  showAuth();
  authForm?.classList.add("hidden");
  passwordResetRequestForm?.classList.add("hidden");
  passwordResetConfirmForm?.classList.remove("hidden");
  passwordResetConfirmNote.textContent = "Enter a new password to complete your reset.";
}

function getPasswordResetToken() {
  return new URLSearchParams(location.search).get("reset") || "";
}

function clearPasswordResetParam() {
  const url = new URL(location.href);
  url.searchParams.delete("reset");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function loadPairs(query = "") {
  const { pairs } = await api.request(`/api/market-data/pairs?q=${encodeURIComponent(query)}`);
  state.pairs = pairs;

  if (!query) {
    state.marketCatalog = pairs;
    renderBacktestMarketOptions();
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

function renderBacktestMarketOptions() {
  if (!backtestSymbol) return;
  const current = backtestSymbol.value;
  const markets = state.marketCatalog.filter((pair) =>
    pair.category === "Crypto" && pair.selectable && pair.providerStatus === "available"
  );
  backtestSymbol.innerHTML = markets.map((pair) => `<option value="${escapeHtml(pair.symbol)}">${escapeHtml(pair.displaySymbol)} · ${escapeHtml(pair.name)}</option>`).join("");
  backtestSymbol.value = markets.some((pair) => pair.symbol === current) ? current : markets[0]?.symbol || "BTC-USD";
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
    state.selectedPair = {
      ...marketData.pair,
      marketStatus: marketData.marketStatus,
      lastCandleAt: marketData.lastCandleAt
    };
    state.pairs = state.pairs.map((pair) => pair.symbol === marketData.pair.symbol ? state.selectedPair : pair);
    renderPairs();
    renderSelectedMarket();
    renderChart(marketData.candles, marketData.advancedStructure);
    document.querySelector("#provider-name").textContent = providerLabel;
    document.querySelector("#candle-count").textContent = `${marketData.candles.length} · Last ${formatDateTime(marketData.lastCandleAt)}`;
    renderMarketRegime(marketData.regime);
    renderMultiTimeframeConfluence(marketData.confluence);
    renderAdvancedMarketStructure(marketData.advancedStructure, marketData.correlation);
    document.querySelector("#provider-status").textContent = marketData.marketStatus?.label || (marketData.cache === "hit" ? "Cached live" : "Live candles");
    state.marketStatus[statusKey] = {
      type: "loaded",
      message: `${marketData.marketStatus?.label || "Loaded"} ${state.selectedPair.symbol} ${state.timeframe}: ${marketData.candles.length} candles from ${providerLabel}. Last candle ${formatDateTime(marketData.lastCandleAt)}.`
    };
    renderMarketStatus();
  } catch (error) {
    if (requestId !== marketRequestId) {
      return;
    }

    state.marketData = null;
    state.selectedPair = {
      ...state.selectedPair,
      marketStatus: {
        code: "PROVIDER_ISSUE",
        label: "Provider issue",
        detail: error.message,
        lastCandleAt: null
      }
    };
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
    renderSelectedMarket();
    renderMarketStatus();
  }
}

async function loadSubscription() {
  const { subscription } = await api.request("/api/subscriptions/me");
  state.subscription = subscription;
  renderSubscription();
}

async function loadSignals() {
  const { signals } = await api.request("/api/signals");
  state.signals = (signals || []).map(normalizeSignal);
  state.signalStats = getSignalSummary(state.signals);
  logSignalHistoryDiagnostics("loaded");
  renderSignals();
  renderSignalsHistory();
  renderPerformanceStats();
  renderOnboarding();
}

async function loadCandidates() {
  const { candidates } = await api.request("/api/signals/candidates");
  state.candidates = candidates || [];
  renderCandidates();
}

async function loadMarketBrief() {
  const { marketBrief } = await api.request("/api/signals/market-brief");
  state.marketBrief = marketBrief || null;
  renderMarketBrief();
}

async function loadCandidateQuality() {
  if (!state.user?.isAdmin) return;
  const { quality, marketBrief } = await api.request("/api/signals/candidates/quality");
  state.candidateQuality = quality;
  setText("#candidate-quality-created", quality.candidatesCreatedToday || 0);
  setText("#candidate-quality-watching", quality.candidatesWatching || 0);
  setText("#candidate-quality-promoted", quality.candidatesPromoted || 0);
  setText("#candidate-quality-rejected", Number(quality.candidatesRejected || 0) + Number(quality.candidatesExpired || 0));
  setText("#candidate-quality-rate", `${quality.promotionRate || 0}%`);
  setText("#candidate-quality-unfilled", quality.pendingOrdersExpiredUnfilled || 0);
  setText("#candidate-quality-avoid", quality.avoidTradesToday || 0);
  setText("#candidate-quality-avoid-promoted", quality.avoidTradesLaterPromoted || 0);
  setText("#candidate-quality-avoid-failed", quality.avoidTradesWouldHaveFailed || 0);
  document.querySelector("#candidate-quality-reasons").innerHTML = renderCandidateMetricRows(
    quality.topRejectionReasons || [], "reason", "count"
  );
  document.querySelector("#candidate-quality-entry").innerHTML = renderCandidateMetricRows(
    quality.entryQualityDistribution || [], "quality", "count"
  );
  document.querySelector("#candidate-quality-avoid-reasons").innerHTML = renderCandidateMetricRows(
    quality.topAvoidReasons || [], "reason", "count"
  );
  document.querySelector("#candidate-quality-avoid-markets").innerHTML = renderCandidateMetricRows(
    quality.mostAvoidedMarkets || [], "market", "count"
  );
  document.querySelector("#candidate-quality-avoid-timeframes").innerHTML = renderCandidateMetricRows(
    quality.mostAvoidedTimeframes || [], "timeframe", "count"
  );
  document.querySelector("#candidate-quality-patterns").innerHTML = renderPatternDiagnosticRows(
    quality.recentPatternObservations || []
  );
  renderAdminMarketBrief(marketBrief);
}

async function loadAdminSignals() {
  if (!state.user?.isAdmin) throw new Error("Admin access required.");
  const params = new URLSearchParams({ page: String(state.adminSignals.page || 1), limit: "25" });
  for (const [key, value] of Object.entries(state.adminSignals.filters || {})) {
    if (String(value || "").trim()) params.set(key, String(value).trim());
  }
  adminSignalsTable.innerHTML = `<div class="empty-state"><strong>Loading generated signals...</strong></div>`;
  const result = await api.request(`/api/admin/signals?${params}`);
  state.adminSignals = { ...state.adminSignals, ...result, signals: result.signals || [], stats: result.stats || {} };
  renderAdminSignals();
}

async function loadAdminCryptoMarkets() {
  if (!state.user?.isAdmin) throw new Error("Admin access required.");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.adminCryptoMarkets.filters || {})) {
    if (String(value || "").trim() && value !== "all") params.set(key, String(value).trim());
  }
  adminCryptoMarketList.innerHTML = `<div class="empty-state"><strong>Loading crypto markets...</strong></div>`;
  const result = await api.request(`/api/admin/crypto-markets?${params}`);
  state.adminCryptoMarkets = { ...state.adminCryptoMarkets, markets: result.markets || [], summary: result.summary || {}, displayed: result.displayed || 0, verificationJob: result.verificationJob || null };
  renderAdminCryptoMarkets();
  if (result.verificationJob?.running) renderCryptoVerificationProgress(result.verificationJob);
}

function renderAdminCryptoMarkets() {
  const { markets, summary } = state.adminCryptoMarkets;
  document.querySelector("#admin-crypto-market-count").textContent = `${Number(summary.active || 0)} active markets · ${Number(summary.totalDiscovered || 0)} discovered`;
  document.querySelector("#admin-crypto-summary").innerHTML = [
    ["Active", summary.active], ["Unavailable", summary.unavailable], ["Provider errors", summary.providerError],
    ["Legacy / migrated", summary.legacy], ["Disabled by admin", summary.disabled],
    ["Total discovered", summary.totalDiscovered], ["Scanner enabled", summary.scannerEnabled],
    ["Paper trading", summary.paperTradingEnabled]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${Number(value || 0)}</strong></article>`).join("");
  adminCryptoMarketList.innerHTML = markets.length ? markets.map(renderAdminCryptoMarket).join("") : `<div class="empty-state"><strong>No crypto markets match these filters.</strong></div>`;
}

function renderAdminCryptoMarket(market) {
  const canonicalStatus = market.status || (market.marketStatus === "active" ? "active" : market.marketStatus) || "unavailable";
  const status = market.statusLabel || titleCase(canonicalStatus);
  const available = canonicalStatus === "active";
  const providerClass = available ? "available" : "unavailable";
  const timeframes = market.supportedTimeframes?.length ? market.supportedTimeframes.join(", ") : "None verified";
  const details = market.verificationDetails || {};
  return `<article class="admin-crypto-market-card">
    <header><div><strong>${escapeHtml(market.displaySymbol)}</strong><span>${escapeHtml(market.name)} &middot; Coinbase &middot; ${escapeHtml(market.providerSymbol)}</span></div><em class="crypto-provider-state ${providerClass}">${escapeHtml(status)}</em></header>
    <div class="admin-crypto-market-meta"><span>Status<strong>${escapeHtml(status)}</strong></span><span>Verification<strong>${escapeHtml(titleCase(market.verificationStatus || "failed"))}</strong></span><span>Timeframes<strong>${escapeHtml(timeframes)}</strong></span><span>Last verified<strong>${market.lastVerifiedAt ? formatDateTime(market.lastVerifiedAt) : "Never"}</strong></span><span>Last candle<strong>${market.lastSuccessfulCandleAt ? formatDateTime(market.lastSuccessfulCandleAt) : "Never"}</strong></span></div>
    <details class="admin-crypto-verification-details" ${canonicalStatus !== "active" ? "open" : ""}>
      <summary>Verification details</summary>
      <div class="admin-crypto-detail-grid">
        <span>Provider symbol<strong>${escapeHtml(details.providerSymbol || market.providerSymbol)}</strong></span>
        <span>Product exists<strong>${formatMaybe(details.productExists)}</strong></span>
        <span>Trading enabled<strong>${formatMaybe(details.productTradingEnabled)}</strong></span>
        <span>Latest candle<strong>${details.latestCandleTime ? formatDateTime(details.latestCandleTime) : market.lastSuccessfulCandleAt ? formatDateTime(market.lastSuccessfulCandleAt) : "Never"}</strong></span>
        <span>Last verified<strong>${details.lastVerifiedAt ? formatDateTime(details.lastVerifiedAt) : market.lastVerifiedAt ? formatDateTime(market.lastVerifiedAt) : "Never"}</strong></span>
        <span>Last attempt<strong>${details.lastVerificationAttempt ? formatDateTime(details.lastVerificationAttempt) : market.lastCheckedAt ? formatDateTime(market.lastCheckedAt) : "Never"}</strong></span>
        <span>Next retry<strong>${details.nextRetryTime ? formatDateTime(details.nextRetryTime) : market.cooldownUntil ? formatDateTime(market.cooldownUntil) : "Now"}</strong></span>
        <span>Final status<strong>${escapeHtml(status)}</strong></span>
      </div>
      <div class="admin-crypto-candle-checks">
        ${["5m", "15m", "1h", "4h"].map((timeframe) => renderCryptoCandleCheck(timeframe, details.candleChecks?.[timeframe], market)).join("")}
      </div>
      <p class="admin-crypto-error">${escapeHtml(details.lastError || market.lastError || "No verification error recorded.")}</p>
    </details>
    ${market.lastError ? `<p class="admin-crypto-error">${escapeHtml(market.lastError)}</p>` : ""}
    <div class="admin-crypto-toggles">
      ${cryptoSettingToggle(market, "enabled", market.enabled ? "Market enabled" : "Disabled by admin")}
      ${cryptoSettingToggle(market, "scannerEnabled", "Scanner", !available)}
      ${cryptoSettingToggle(market, "paperTradingEnabled", "Paper trading", !available)}
      ${cryptoSettingToggle(market, "watchlistEnabled", "Watchlist", !available)}
      <button class="secondary-action" data-crypto-verify="${escapeHtml(market.symbol)}" type="button">Verify now</button>
      <button class="secondary-action" data-crypto-replace="${escapeHtml(market.symbol)}" data-replacement="${escapeHtml(market.replacementSymbol || "")}" type="button">Replace symbol</button>
    </div>
  </article>`;
}

function renderCryptoCandleCheck(timeframe, check = {}, market = {}) {
  const inferredPass = market.supportedTimeframes?.includes(timeframe);
  const pass = check.pass ?? inferredPass;
  const message = pass
    ? `Pass${check.candles ? ` · ${check.candles} candles` : ""}${check.latestCandleAt ? ` · ${formatDateTime(check.latestCandleAt)}` : ""}`
    : check.error || (market.unsupportedTimeframes?.includes(timeframe) ? "Failed" : "Not checked");
  return `<span class="crypto-candle-check ${pass ? "pass" : "fail"}">${escapeHtml(timeframe)}<strong>${escapeHtml(message)}</strong></span>`;
}

function formatMaybe(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

async function pollCryptoVerificationJob() {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await api.request("/api/admin/crypto-markets/verification-job");
    renderCryptoVerificationProgress(result.verificationJob);
    if (!result.verificationJob?.running) {
      adminCryptoVerifyPending.disabled = false;
      await loadAdminCryptoMarkets();
      await loadPairs();
      showToast("Market verification complete");
      break;
    }
  }
}

function renderCryptoVerificationProgress(job = {}) {
  const total = Number(job.total || 0);
  const completed = Number(job.completed || 0);
  adminCryptoProgress.classList.toggle("hidden", !job.running && !job.finishedAt);
  document.querySelector("#admin-crypto-progress-label").textContent = job.running
    ? `Verifying ${completed + 1 > total ? total : completed + 1} / ${total}${job.currentSymbol ? ` · ${job.currentSymbol}` : ""}...`
    : `Verification complete: Active ${job.active || 0}, Unavailable ${job.unavailable || 0}, Provider error ${job.providerError || 0}, Legacy ${job.legacy || 0}, Unresolved ${job.stillPending || 0}.`;
  document.querySelector("#admin-crypto-progress-count").textContent = `${completed} / ${total}`;
  const progress = document.querySelector("#admin-crypto-progress-bar");
  progress.max = Math.max(1, total); progress.value = completed;
  adminCryptoOperationStatus.textContent = job.running
    ? `Verification progress: ${completed}/${total}${job.lastResult?.symbol ? ` · last ${job.lastResult.symbol}: ${titleCase(job.lastResult.status)}` : ""}`
    : `Verification complete: Active ${job.active || 0}, Unavailable ${job.unavailable || 0}, Provider error ${job.providerError || 0}, Unresolved ${job.stillPending || 0}.`;
}

function cryptoSettingToggle(market, key, label, disabled = false) {
  return `<label class="admin-crypto-toggle"><input type="checkbox" data-crypto-setting="${key}" data-symbol="${escapeHtml(market.symbol)}" ${market[key] ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${label}</span></label>`;
}

function renderAdminSignals() {
  const data = state.adminSignals;
  const stats = data.stats || {};
  document.querySelector("#admin-signals-total-label").textContent = `${formatInteger(data.total || 0)} records`;
  document.querySelector("#admin-signal-stats").innerHTML = [
    ["Total generated", stats.total], ["Active", stats.active], ["Expiring soon", stats.expiringSoon],
    ["Hit TP", stats.hitTp], ["Hit SL", stats.hitSl], ["Expired", stats.expired],
    ["Win rate", `${Number(stats.winRate || 0).toFixed(1)}%`], ["Average R/R", `${Number(stats.averageRiskReward || 0).toFixed(2)}R`],
    ["Average confidence", `${Number(stats.averageConfidence || 0).toFixed(1)}%`], ["Today", stats.today], ["This week", stats.week]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value ?? 0}</strong></article>`).join("");
  adminSignalsTable.innerHTML = data.signals.length ? `
    <div class="admin-generated-table">
      <div class="admin-generated-row admin-generated-head"><span>Pair</span><span>Setup</span><span>Levels</span><span>Scores</span><span>Status</span><span>Source / created</span><span>Actions</span></div>
      ${data.signals.map(renderAdminSignalRow).join("")}
    </div>` : `<div class="empty-state"><strong>No generated signals match these filters.</strong><p class="reasoning">Clear filters or wait for the scanner to promote a validated setup.</p></div>`;
  document.querySelector("#admin-signals-page-label").textContent = `Page ${data.page || 1} of ${data.totalPages || 1}`;
  document.querySelector("#admin-signals-prev").disabled = Number(data.page || 1) <= 1;
  document.querySelector("#admin-signals-next").disabled = Number(data.page || 1) >= Number(data.totalPages || 1);
}

function renderAdminSignalRow(signal) {
  const effectiveStatus = signal.expiringSoon && signal.status === "Active" ? "Expiring Soon" : signal.status;
  return `<article class="admin-generated-row">
    <span data-label="Pair"><strong>${escapeHtml(signal.displayPair || signal.pair)}</strong><small>${escapeHtml(signal.provider)} &middot; ${escapeHtml(signal.pair)}</small></span>
    <span data-label="Setup"><strong class="direction ${escapeHtml(signal.direction)}">${escapeHtml(String(signal.direction).toUpperCase())} &middot; ${escapeHtml(signal.timeframe)}</strong><small>${escapeHtml(signal.strategy)}${signal.pattern ? ` &middot; ${escapeHtml(titleCase(signal.pattern))}` : ""}</small></span>
    <span data-label="Levels"><small>Entry ${formatCurrency(signal.entry)}</small><small>SL ${formatCurrency(signal.stopLoss)} &middot; TP ${formatCurrency(signal.takeProfit)}</small><strong>${Number(signal.riskReward).toFixed(2)}R</strong></span>
    <span data-label="Scores"><small>Confidence ${Number(signal.confidence).toFixed(0)}%</small><small>Quality ${Number(signal.setupQualityScore).toFixed(0)} &middot; Readiness ${Number(signal.entryReadinessScore).toFixed(0)}</small></span>
    <span data-label="Status"><em class="status-pill ${adminSignalStatusClass(effectiveStatus)}">${escapeHtml(effectiveStatus)}</em><small>${escapeHtml(signal.resultReason || "Tracking")}</small></span>
    <span data-label="Source"><strong>${escapeHtml(titleCase(signal.source))}</strong><small>${formatDateTime(signal.createdAt)}</small><small>Valid until ${formatDateTime(signal.validUntil)}</small></span>
    <span data-label="Actions" class="admin-signal-row-actions"><button data-admin-signal-view="${escapeHtml(signal.id)}" type="button">View details</button><button class="secondary-action" data-admin-signal-copy="${escapeHtml(signal.signalId)}" type="button">Copy ID</button>${signal.promotedFromCandidateId ? `<button class="secondary-action" data-admin-signal-view="${escapeHtml(signal.id)}" type="button">Candidate source</button>` : ""}${signal.status !== "Active" ? `<button class="secondary-action" data-admin-signal-view="${escapeHtml(signal.id)}" type="button">Post-mortem</button>` : ""}</span>
  </article>`;
}

function renderAdminSignalDetail(signal) {
  const quality = signal.qualityBreakdown?.categories || {};
  const analysis = signal.fullAnalysis || {};
  const pattern = signal.patternContext || {};
  const candidate = signal.candidateOrigin;
  document.querySelector("#admin-signal-modal-title").textContent = `${signal.displayPair} / ${signal.timeframe} / ${String(signal.direction).toUpperCase()}`;
  adminSignalDetail.innerHTML = `
    <section class="admin-detail-levels"><div><span>Entry</span><strong>${formatCurrency(signal.entry)}</strong></div><div><span>Stop loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div><div><span>Take profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div><div><span>Risk/reward</span><strong>${Number(signal.riskReward).toFixed(2)}R</strong></div></section>
    <section class="admin-detail-meta"><span class="status-pill ${adminSignalStatusClass(signal.status)}">${escapeHtml(signal.status)}</span><span>${escapeHtml(signal.strategy)}</span><span>${Number(signal.confidence).toFixed(0)}% confidence</span><span>${Number(signal.setupQualityScore).toFixed(0)} quality</span><span>${Number(signal.entryReadinessScore).toFixed(0)} readiness</span></section>
    ${renderAdminDetailSection("Signal quality breakdown", Object.values(quality).map((item) => `${item.label}: ${titleCase(item.status)} - ${item.reason}`))}
    ${renderAdminDetailSection("Why it was generated", [analysis.reasoning, ...(analysis.confirmations || []).map((item) => `${item.passed ? "Passed" : "Failed"}: ${item.name} - ${item.detail}`), ...(signal.warningReasons || []).map((item) => `Warning: ${typeof item === "string" ? item : item.reason}`)])}
    ${signal.pattern ? renderAdminDetailSection("Pattern context", [`${pattern.label || titleCase(signal.pattern)} - ${titleCase(pattern.bias)} ${pattern.category || "pattern"}`, `Pattern confidence: ${Math.round(Number(pattern.confidence || 0) * 100)}%`, ...(pattern.reasons || []), ...(pattern.warnings || []).map((item) => `Warning: ${item}`)]) : ""}
    ${renderAdminDetailSection("Outcome and post-mortem", [`Status: ${signal.status}`, signal.resultReason, signal.maxFavorableExcursion == null ? null : `Maximum favorable excursion: ${signal.maxFavorableExcursion}R`, signal.maxAdverseExcursion == null ? null : `Maximum adverse excursion: ${signal.maxAdverseExcursion}R`, ...(signal.postMortemTags || []).map((tag) => `Post-mortem: ${tag}`)])}
    ${candidate ? renderAdminDetailSection("Candidate origin", [`Original status: ${candidate.status}`, `Setup quality at detection: ${candidate.setupQualityScore}`, `Entry readiness at detection: ${candidate.entryReadinessScore}`, ...(candidate.missingConfirmations || []).map((item) => `Missing before promotion: ${item}`), `Watched from ${formatDateTime(candidate.firstDetectedAt)} to ${formatDateTime(candidate.lastCheckedAt)}`]) : ""}
    <section class="admin-detail-footer"><span>Signal ID ${escapeHtml(signal.signalId)}</span><span>Sources ${escapeHtml((signal.sourceHistory || [signal.source]).join(", "))}</span><span>Created ${formatDateTime(signal.createdAt)}</span></section>`;
}

function renderAdminDetailSection(title, rows) {
  const visible = (rows || []).filter(Boolean);
  if (!visible.length) return "";
  return `<section class="admin-detail-section"><h4>${escapeHtml(title)}</h4><ul>${visible.map((row) => `<li>${escapeHtml(String(row))}</li>`).join("")}</ul></section>`;
}

function closeAdminSignalModal() { adminSignalModal?.classList.add("hidden"); document.body.classList.remove("modal-open"); }
function adminSignalStatusClass(status) { const value = String(status || "").toLowerCase(); if (value.includes("tp")) return "status-hit-tp"; if (value.includes("sl")) return "status-hit-sl"; if (value.includes("expir")) return "status-expired"; return "status-active"; }

function renderCandidateMetricRows(items, labelKey, valueKey) {
  if (!items.length) return `<p class="reasoning">No candidate data yet.</p>`;
  return items.map((item) => `<div class="analytics-list-row"><span>${escapeHtml(titleCase(item[labelKey]))}</span><strong>${Number(item[valueKey] || 0)}</strong></div>`).join("");
}

function renderPatternDiagnosticRows(items) {
  if (!items.length) return `<p class="reasoning">No resolved shadow pattern observations yet.</p>`;
  return items.map((item) => `<div class="analytics-list-row pattern-diagnostic-row"><span><strong>${escapeHtml(titleCase(item.pattern))}</strong><small>${escapeHtml(item.reason)}</small></span><strong>${Math.round(Number(item.confidence || 0) * 100)}% Â· ${escapeHtml(titleCase(item.finalStatus))}</strong></div>`).join("");
}

function renderCandidates() {
  if (!candidateGrid || !candidateCount) return;
  const active = state.candidates.filter((candidate) => ["watching", "almost_ready", "ready"].includes(candidate.status));
  candidateCount.textContent = `${active.length} watching`;
  if (!active.length) {
    candidateGrid.innerHTML = `<div class="empty-state"><strong>No setups being watched</strong><p class="reasoning">The crypto watcher will add promising setups as they develop.</p></div>`;
    return;
  }
  candidateGrid.innerHTML = active.map((candidate) => {
    const label = titleCase(candidate.status);
    const reasons = candidate.reasonsForWatching?.length
      ? candidate.reasonsForWatching
      : ["Entry timing is still being evaluated."];
    const missing = candidate.missingConfirmations || [];
    const nextConditions = candidate.nextConditions?.length
      ? candidate.nextConditions
      : ["Waiting for the remaining rule confirmations to align."];
    const advanced = state.scannerMode === "advanced";
    return `<article class="candidate-card ${escapeHtml(candidate.status)}">
      <header><div><strong>${escapeHtml(getDisplaySymbol(candidate.symbol))}</strong><span>${escapeHtml(candidate.timeframe)} · ${escapeHtml(String(candidate.direction || "").toUpperCase())} · ${escapeHtml(candidate.setupType)}</span></div><span class="status-pill">${escapeHtml(label)}</span></header>
      ${advanced ? `<div class="candidate-scores"><span>Setup quality<strong>${Number(candidate.setupQualityScore ?? candidate.candidateScore)}%</strong></span><span>Entry readiness<strong>${Number(candidate.entryReadinessScore ?? candidate.readinessScore)}%</strong></span></div>
      <div class="candidate-quality-summary">
        <span class="quality-chip ${qualityStatusFromScore(candidate.setupQualityScore ?? candidate.candidateScore)}">Setup ${qualityLabel(qualityStatusFromScore(candidate.setupQualityScore ?? candidate.candidateScore))}</span>
        <span class="quality-chip ${qualityStatusFromScore(candidate.entryReadinessScore ?? candidate.readinessScore)}">Entry ${qualityLabel(qualityStatusFromScore(candidate.entryReadinessScore ?? candidate.readinessScore))}</span>
      </div>` : ""}
      ${candidate.patternContext ? `<div class="pattern-context-inline"><span>Pattern</span><strong>${escapeHtml(candidate.patternContext.label)}</strong><small>${escapeHtml(titleCase(candidate.patternContext.bias))} ${escapeHtml(candidate.patternContext.category)}</small></div>` : ""}
      <p class="candidate-primary-reason"><strong>Why not a signal yet:</strong> ${escapeHtml(reasons[0])}</p>
      <p class="candidate-next-condition"><strong>Next:</strong> ${escapeHtml(nextConditions[0])}</p>
      <small>Last checked ${escapeHtml(formatDateTime(candidate.lastCheckedAt || candidate.firstDetectedAt))}</small>
      ${advanced ? `<details><summary>View technical explanation</summary>
        <div class="candidate-explanation">
          <section><strong>Why not a signal?</strong><ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
          <section><strong>Missing confirmations</strong>${missing.length ? `<ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>No named confirmation is missing; entry timing is still being monitored.</p>`}</section>
          <section><strong>Next condition needed</strong><ul>${nextConditions.map((condition) => `<li>${escapeHtml(condition)}</li>`).join("")}</ul></section>
          <section><strong>Technical status</strong><p>Entry quality: ${escapeHtml(titleCase(candidate.entryQuality))}. Monitoring expires ${escapeHtml(formatDateTime(candidate.expiresAt))}.</p></section>
          ${renderPatternContext(candidate.patternContext, { diagnostic: true })}
        </div>
      </details>` : ""}
    </article>`;
  }).join("");
}

function renderAvoidTrades() {
  if (!avoidTradeSection || !avoidTradeGrid || !avoidTradeCount || !avoidTradeMore) return;
  const avoidTrades = state.avoidTrades || [];
  avoidTradeSection.classList.toggle("hidden", avoidTrades.length === 0);
  avoidTradeCount.textContent = `${avoidTrades.length} avoid zone${avoidTrades.length === 1 ? "" : "s"}`;
  if (!avoidTrades.length) {
    avoidTradeGrid.innerHTML = "";
    avoidTradeMore.classList.add("hidden");
    return;
  }

  const visible = state.showAllAvoidTrades ? avoidTrades : avoidTrades.slice(0, 3);
  const advanced = state.scannerMode === "advanced";
  avoidTradeGrid.innerHTML = visible.map((item) => `
    <article class="avoid-trade-card" data-result-type="avoid_trade">
      <header>
        <div><strong>${escapeHtml(getDisplaySymbol(item.symbol))}</strong><span>${escapeHtml(item.timeframe)} · No Trade</span></div>
        <span class="avoid-trade-badge">Avoid Trade</span>
      </header>
      <p class="avoid-trade-primary"><strong>Reason:</strong> ${escapeHtml(item.reason)}</p>
      ${advanced ? `<div class="avoid-trade-columns">
        <section><strong>Avoid because</strong><ul>${(item.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
        <section><strong>What would improve it</strong><ul>${(item.improvements || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
      </div>` : ""}
      <footer><span>${escapeHtml(item.marketCondition || "Confirmations not aligned")}</span><span>No credits used</span></footer>
    </article>
  `).join("");
  avoidTradeMore.classList.toggle("hidden", avoidTrades.length <= 3);
  avoidTradeMore.textContent = state.showAllAvoidTrades ? "Show top 3" : `View ${avoidTrades.length - 3} more`;
}

function renderMarketBrief() {
  if (!dailyBriefContent || !dailyBriefUpdated) return;
  const brief = state.marketBrief;
  if (!brief?.available) {
    dailyBriefUpdated.textContent = "Waiting for scanner data";
    dailyBriefContent.innerHTML = `
      <div class="daily-brief-empty">
        <strong>Market brief unavailable right now.</strong>
        <p>SignalForge needs fresh market data to generate a brief.</p>
        <button class="secondary-action" id="daily-brief-refresh" type="button">Scan again</button>
      </div>`;
    return;
  }

  dailyBriefUpdated.textContent = `Last updated ${formatBriefAge(brief.generatedAt)}`;
  const noSignal = Number(brief.readySignalCount || 0) === 0;
  const mainReasons = brief.mainReasons?.length
    ? brief.mainReasons
    : ["No single reason dominates the current scanner results."];
  const advanced = state.scannerMode === "advanced";
  dailyBriefContent.innerHTML = `
    <div class="daily-brief-overview">
      <div class="daily-brief-condition"><span>Market condition</span><strong>${escapeHtml(brief.marketCondition)}</strong></div>
      ${advanced ? `<div class="daily-brief-chips">
        <span><strong>${Number(brief.readySignalCount || 0)}</strong> ready</span>
        <span><strong>${Number(brief.watchingCount || 0)}</strong> watching</span>
        <span><strong>${Number(brief.avoidCount || 0)}</strong> avoid</span>
        <span><strong>${Number(brief.pairsScanned || 0)}</strong> pairs</span>
      </div>` : ""}
    </div>
    <div class="daily-brief-columns">
      ${renderBriefPairList("Stronger pairs", brief.strongestPairs, "No directional strength stands out yet.")}
      ${renderBriefPairList("Weak or choppy", brief.weakestPairs, "No weak pair context is available yet.")}
      <section><strong>${noSignal ? "No clean signal yet because" : "What to watch next"}</strong><ul>${mainReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
    </div>
    ${advanced && brief.watchingBreakdown?.length ? `<div class="daily-brief-watching"><strong>Watching:</strong> ${brief.watchingBreakdown.map((item) => `${Number(item.count)} ${escapeHtml(item.setupType)}`).join(" · ")}</div>` : ""}
    ${advanced ? `<details class="daily-brief-pairs"><summary>View scanner and timeframe detail</summary><div>${(brief.pairSummaries || []).map((item) => `<article><strong>${escapeHtml(item.displaySymbol || getDisplaySymbol(item.symbol))}</strong><span>${escapeHtml(item.timeframe)} · ${escapeHtml(item.summary)}</span></article>`).join("")}</div></details>` : ""}
  `;
}

function renderBriefPairList(title, pairs = [], emptyCopy) {
  return `<section><strong>${escapeHtml(title)}</strong>${pairs.length
    ? `<ul>${pairs.map((item) => `<li><b>${escapeHtml(item.displaySymbol || getDisplaySymbol(item.symbol))}</b> ${escapeHtml(item.summary)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(emptyCopy)}</p>`}</section>`;
}

function renderAdminMarketBrief(brief) {
  const container = document.querySelector("#admin-market-brief");
  const updated = document.querySelector("#admin-market-brief-updated");
  if (!container || !updated) return;
  if (!brief?.available) {
    updated.textContent = "Unavailable";
    container.innerHTML = `<p class="reasoning">No market brief has been generated yet.</p>`;
    return;
  }
  updated.textContent = formatDateTime(brief.generatedAt);
  container.innerHTML = `
    <div class="admin-market-brief-grid">
      <div><span>Condition</span><strong>${escapeHtml(brief.marketCondition)}</strong></div>
      <div><span>Pairs scanned</span><strong>${Number(brief.pairsScanned || 0)}</strong></div>
      <div><span>Snapshot</span><strong>${escapeHtml(brief.scannerSnapshotId || "--")}</strong></div>
      <div><span>Ready / Watching / Avoid</span><strong>${Number(brief.readySignalCount || 0)} / ${Number(brief.watchingCount || 0)} / ${Number(brief.avoidCount || 0)}</strong></div>
    </div>
    ${renderRejectionReasons(brief.mainReasons || [])}`;
}

function formatBriefAge(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return formatDateTime(value);
}

async function loadPaperPortfolio() {
  state.paperPortfolio = await api.request("/api/paper-trades");
  renderPaperPortfolio();
  renderSignals();
  renderSignalsHistory();
}

async function loadPaperTradingTerminal() {
  paperChartLoading.classList.remove("hidden");
  const params = new URLSearchParams({
    symbol: state.paperTrading.selectedSymbol,
    timeframe: state.paperTrading.timeframe
  });
  const terminal = await api.request(`/api/paper-trades/terminal?${params}`);
  state.paperTrading = {
    ...state.paperTrading,
    ...terminal,
    markets: terminal.markets || [],
    orders: terminal.orders || [],
    account: terminal.account,
    marketData: terminal.marketData,
    marketError: terminal.marketError
  };
  paperChartLoading.classList.add("hidden");
  renderPaperTradingTerminal();
  renderSignals();
  renderSignalsHistory();
  const route = parseAppHash(location.hash);
  if (route.route === "paper-trading" && route.params.has("pair")) {
    removeHashParams(["pair"]);
  }
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
  if (performanceOutcome.value) params.set("status", performanceOutcome.value);
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
  renderOnboarding();

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

async function loadProfile() {
  const result = await api.request("/api/profile/me");
  const profile = normalizeProfile(result.profile, state.user);
  state.profile = profile;
  state.scannerMode = profile.signalViewMode;
  persistSignalViewMode(profile.signalViewMode);
  state.user = {
    ...state.user,
    username: profile?.username || "",
    usernameRequired: Boolean(profile?.usernameRequired),
    publicProfileEnabled: Boolean(profile?.publicProfileEnabled),
    publicLeaderboardEnabled: Boolean(profile?.publicLeaderboardEnabled),
    usernameUpdatedAt: profile?.private?.usernameUpdatedAt || state.user?.usernameUpdatedAt || null,
    profile
  };
  document.querySelector("#user-name").textContent = getUserDisplayName();
  renderSignalViewSurfaces();
  renderProfile();
  renderOnboarding();
  return profile;
}

async function saveProfileSettings({
  username,
  publicProfileEnabled,
  publicLeaderboardEnabled,
  messageElement,
  signalViewMode
}) {
  try {
    if (messageElement) messageElement.textContent = "Saving profile...";
    const result = await api.request("/api/profile/me", {
      method: "PUT",
      body: JSON.stringify({
        ...(String(username || "").trim() ? { username: String(username).trim() } : {}),
        publicProfileEnabled,
        publicLeaderboardEnabled,
        ...(signalViewMode ? { signalViewMode } : {})
      })
    });
    const profile = normalizeProfile(result.profile, state.user);
    state.profile = profile;
    state.scannerMode = profile.signalViewMode;
    persistSignalViewMode(profile.signalViewMode);
    state.user = {
      ...state.user,
      username: profile?.username || "",
      usernameRequired: Boolean(profile?.usernameRequired),
      publicProfileEnabled: Boolean(profile?.publicProfileEnabled),
      publicLeaderboardEnabled: Boolean(profile?.publicLeaderboardEnabled),
      usernameUpdatedAt: profile?.private?.usernameUpdatedAt || state.user?.usernameUpdatedAt || null,
      profile
    };
    document.querySelector("#user-name").textContent = getUserDisplayName();
    renderSignalViewSurfaces();
    renderProfile();
    renderOnboarding();
    if (messageElement) messageElement.textContent = "Profile updated.";
    showToast("Profile updated");
  } catch (error) {
    if (messageElement) messageElement.textContent = error.message;
  }
}

async function loadLeaderboards() {
  const { leaderboards } = await api.request("/api/leaderboards");
  state.leaderboards = leaderboards;
  renderLeaderboards();
}

async function loadSupport() {
  const result = await api.request("/api/support");
  state.support = {
    topics: result.topics || defaultSupportIssues,
    tickets: result.tickets || []
  };
  renderSupportTopicOptions();
  renderSupportTickets();
}

async function loadAdminSupport() {
  if (!state.user?.isAdmin) return;
  const params = new URLSearchParams();
  const mappings = [
    ["status", "#admin-support-status"],
    ["topic", "#admin-support-topic"],
    ["priority", "#admin-support-priority"],
    ["source", "#admin-support-source"],
    ["from", "#admin-support-from"],
    ["to", "#admin-support-to"],
    ["search", "#admin-support-search"]
  ];
  for (const [key, selector] of mappings) {
    const value = document.querySelector(selector)?.value?.trim();
    if (value) params.set(key, value);
  }
  const result = await api.request(`/api/admin/support${params.size ? `?${params}` : ""}`);
  state.adminSupport = {
    ...state.adminSupport,
    tickets: result.tickets || [],
    summary: result.summary || {},
    topics: result.topics || defaultSupportIssues
  };
  renderAdminSupportFilters();
  renderAdminSupportSummary();
  renderAdminSupportTickets();
  renderAdminSupportDetail();
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
  const [{ requests }, { abuse }, { affiliateAdmin }, { analytics, validation, learning, dashboard }, support] = await Promise.all([
    api.request("/api/admin/tester-access"),
    api.request("/api/admin/abuse"),
    api.request("/api/admin/affiliates"),
    api.request("/api/admin/analytics"),
    api.request("/api/admin/support")
  ]);
  state.adminRequests = requests;
  state.abuseDashboard = abuse;
  state.affiliateAdmin = affiliateAdmin;
  state.adminAnalytics = analytics;
  state.adminDashboard = dashboard;
  state.learningDashboard = learning;
  state.validationDashboard = validation;
  state.adminSupport = {
    ...state.adminSupport,
    tickets: support.tickets || [],
    summary: support.summary || {},
    topics: support.topics || defaultSupportIssues
  };
  renderAdminAnalytics();
  renderAdminRequests();
  renderAbuseDashboard();
  renderAffiliateAdmin();
  renderAdminSupportFilters();
  renderAdminSupportSummary();
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
    refreshSignalValidityTimers();
    if (!state.user || !["signals", "paper-portfolio"].includes(state.activeView)) {
      return;
    }

    try {
      if (state.activeView === "paper-portfolio") {
        await loadPaperTradingTerminal();
      } else {
        await loadSignals();
      }
    } catch {
      // Keep the current table visible if a demo refresh fails.
    }
  }, 30000);
}

function refreshSignalValidityTimers() {
  document.querySelectorAll("[data-signal-validity]").forEach((element) => {
    const signal = {
      validUntil: element.dataset.validUntil,
      generatedAt: element.dataset.generatedAt,
      validityDurationMs: Number(element.dataset.validityDurationMs || 0),
      status: element.dataset.signalStatus
    };
    const validity = getSignalValidityState(signal);
    const status = getDemoSignalStatus(signal);
    const badge = element.querySelector("[data-validity-badge]");
    const countdown = element.querySelector("[data-validity-countdown]");
    if (badge) {
      badge.className = `status-pill ${status.className}`;
      badge.textContent = status.label;
    }
    if (countdown) {
      countdown.textContent = ["active", "expiring-soon"].includes(validity.status)
        ? `Expires in: ${formatSignalCountdown(signal)}`
        : status.label;
    }
    if (validity.status === "expired") {
      element.closest("[data-signal-key]")?.querySelectorAll("[data-unlock-symbol], [data-paper-signal-id]")
        .forEach((button) => {
          button.disabled = true;
          button.textContent = button.matches("[data-paper-signal-id]") ? "Expired · Historical only" : "Expired";
        });
    }
  });
}

function navigateTo(routeOrView, params = {}, options = {}) {
  const route = normalizeAppRoute(routeOrView);
  const allowedRoute = isRouteAllowed(route) ? route : "scanner";
  const hash = buildRouteHash(allowedRoute, params);
  const destination = `${location.pathname}${location.search}${hash}`;

  if (location.hash !== hash) {
    history[options.replace ? "replaceState" : "pushState"]({}, "", destination);
  }
  syncRouteFromLocation({ force: true, viewOptions: options });
  setMobileNavigationOpen(false);
}

function syncRouteFromLocation({ force = false, replaceInvalid = false, viewOptions = {} } = {}) {
  if (!state.user || dashboard.classList.contains("hidden")) return;
  const parsed = parseAppHash(location.hash);
  let route = parsed.route;
  let params = parsed.params;

  if (!parsed.valid || !isRouteAllowed(route)) {
    route = "scanner";
    params = new URLSearchParams();
    if (replaceInvalid || location.hash) {
      history.replaceState({}, "", `${location.pathname}${location.search}#scanner`);
    }
  } else if (!parsed.canonical) {
    const canonicalHash = buildRouteHash(route, params);
    history.replaceState({}, "", `${location.pathname}${location.search}${canonicalHash}`);
  }

  const currentHash = buildRouteHash(route, params);
  if (!force && state.lastAppliedRouteHash === currentHash) return;
  state.lastAppliedRouteHash = currentHash;
  state.activeRoute = route;

  if (route === "paper-trading" && params.get("pair")) {
    const symbol = resolvePaperTradingRouteSymbol(params.get("pair"));
    if (symbol) state.paperTrading.selectedSymbol = symbol;
  }

  applyViewState(ROUTE_TO_VIEW[route], viewOptions);
  if (route === "signals") consumeSignalRouteParams(params);
}

function handleBrowserRouteChange() {
  if (isClearSessionRoute()) {
    emergencyClearSession();
    return;
  }
  if (isDebugBuildRoute()) {
    showDebugBuildPage();
    return;
  }
  if (isAccountRecoveryRoute()) {
    showAccountRecoverySupport();
    return;
  }
  if (isHowItWorksRoute() && !state.user) {
    showPublicHowItWorks();
    return;
  }
  if (isPublicAuthRoute() && !state.user) {
    if (isPasswordResetRequestRoute()) showPasswordResetRequest();
    else showAuth();
    updateAuthDebug({ status: "public_auth_route", authLoading: false });
    return;
  }
  if (!state.user && publicHowItWorksPage && !publicHowItWorksPage.classList.contains("hidden")) {
    publicHowItWorksPage.classList.add("hidden");
    landingPage.classList.remove("hidden");
    authScreen.classList.add("hidden");
    dashboard.classList.add("hidden");
    return;
  }
  syncRouteFromLocation({ replaceInvalid: true });
}

function isRouteAllowed(route) {
  if (!Object.hasOwn(ROUTE_TO_VIEW, route)) return false;
  return !["admin", "admin-signals", "admin-crypto-markets", "admin-support", "affiliate-admin", "webhook-events"].includes(route) || Boolean(state.user?.isAdmin);
}

function resolvePaperTradingRouteSymbol(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const markets = [...state.paperTrading.markets, ...state.marketCatalog, ...state.pairs];
  return markets.find((market) => {
    return [market.symbol, market.displaySymbol, market.name]
      .filter(Boolean)
      .some((candidate) => String(candidate).toUpperCase().replace(/[^A-Z0-9]/g, "") === normalized);
  })?.symbol || null;
}

function consumeSignalRouteParams(params) {
  applySignalFiltersFromRoute(params);
  const signalId = params.get("signalId");
  if (!signalId) return;
  const signal = state.signals.find((item) => item.id === signalId);
  if (!signal) return;
  if (!filterAndSortSignals([signal], state.historyFilters, state.marketCatalog).length) {
    state.historyFilters = createSignalFilters({ status: "all" });
  }
  const key = getSignalKey(signal);
  state.expandedSignalKeys = new Set([key]);
  renderSignalsHistory();
  highlightSignalKey(key);
  removeHashParams(["signalId"]);
}

function applySignalFiltersFromRoute(params) {
  const filters = filtersFromSignalParams(params, state.signals);
  if (filters.pair !== "all") {
    const normalized = filters.pair.toUpperCase().replace(/[^A-Z0-9]/g, "");
    filters.pair = [...state.marketCatalog, ...state.signals]
      .find((item) => String(item.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === normalized)
      ?.symbol || "all";
  }
  state.historyFilters = filters;
  state.historyFiltersInitialized = true;
  renderSignalsHistory();
}

function updateSignalFilterUrl({ replace = false } = {}) {
  const current = parseAppHash(location.hash);
  const params = signalFiltersToParams(state.historyFilters, current.route === "signals" ? current.params : undefined);
  navigateTo("signals", params, { replace });
}

function removeHashParams(names) {
  const parsed = parseAppHash(location.hash);
  for (const name of names) parsed.params.delete(name);
  const hash = buildRouteHash(parsed.route, parsed.params);
  history.replaceState({}, "", `${location.pathname}${location.search}${hash}`);
  state.lastAppliedRouteHash = hash;
}

function applyViewState(view, options = {}) {
  const allowedViews = ["scanner", "watchlist", "alerts", "notifications", "signals", "paper-portfolio", "journal", "backtesting", "performance", "how-it-works", "affiliate", "leaderboard", "profile", "settings", "support", "billing"];
  if (state.user?.isAdmin) {
    allowedViews.push("admin", "admin-signals", "admin-crypto-markets", "admin-support", "affiliate-admin", "webhook-events");
  }
  const normalizedView = allowedViews.includes(view) ? view : "scanner";
  if (normalizedView !== "admin-signals") closeAdminSignalModal();
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
    "paper-portfolio": ["Free simulated execution", "Paper Trading"],
    journal: ["Review and discipline", "Trade Journal"],
    backtesting: ["Historical strategy research", "Backtesting Lab"],
    performance: ["Outcome analytics", "Performance"],
    "how-it-works": ["Product guide", "How SignalForge Works"],
    affiliate: ["Recurring commissions", "Affiliate Program"],
    leaderboard: ["Community rankings", "Leaderboard"],
    profile: ["Public identity", "Profile"],
    settings: ["Account", "Settings"],
    support: ["Account support", "Support"],
    admin: ["Administration", "Tester access requests"],
    "admin-signals": ["ADMIN SIGNALS", "All generated signals"],
    "admin-crypto-markets": ["ADMIN", "Crypto Markets"],
    "admin-support": ["Administration", "Support Tickets"],
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

  if (normalizedView === "admin-signals") {
    loadAdminSignals().catch((error) => {
      adminSignalsTable.innerHTML = `<div class="empty-state"><strong>Generated signals unavailable</strong><p class="reasoning">${escapeHtml(error.message)}</p></div>`;
    });
  }

  if (normalizedView === "admin-crypto-markets") {
    loadAdminCryptoMarkets().catch((error) => {
      adminCryptoMarketList.innerHTML = `<div class="empty-state"><strong>Crypto market settings unavailable</strong><p class="reasoning">${escapeHtml(error.message)}</p></div>`;
    });
  }

  if (normalizedView === "affiliate") {
    loadAffiliate().catch((error) => {
      affiliateStatus.textContent = error.message;
    });
  }

  if (normalizedView === "profile") {
    loadProfile().catch((error) => {
      usernameOnboardingMessage.textContent = error.message;
    });
  }

  if (normalizedView === "leaderboard") {
    loadLeaderboards().catch((error) => {
      leaderboardTable.innerHTML = `
        <div class="empty-state">
          <strong>Leaderboard unavailable</strong>
          <p class="reasoning">${escapeHtml(error.message)}</p>
        </div>
      `;
    });
  }

  if (normalizedView === "affiliate-admin") {
    loadAffiliateAdmin().catch((error) => {
      document.querySelector("#affiliate-admin-summary").textContent = error.message;
    });
  }

  if (normalizedView === "support") {
    renderSupportTopicOptions();
    loadSupport().catch((error) => {
      supportFormStatus.textContent = error.message;
    });
  }

  if (normalizedView === "admin-support") {
    loadAdminSupport().catch((error) => {
      adminSupportTicketList.innerHTML = `<div class="empty-state"><strong>Support queue unavailable</strong><p class="reasoning">${escapeHtml(error.message)}</p></div>`;
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

  if (normalizedView === "paper-portfolio" && !options.skipPaperLoad) {
    loadPaperTradingTerminal().catch((error) => {
      paperPortfolioGrid.innerHTML = `
        <div class="empty-state">
          <strong>Paper Trading unavailable</strong>
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
        <span>${state.pairs.filter((pair) => (pair.group || pair.category) === group && pair.status === "active").length} active</span>
      </div>
      ${state.pairs.filter((pair) => (pair.group || pair.category) === group).map((pair) => pair.selectable ? `
        <button class="pair-button ${state.selectedPair?.symbol === pair.symbol ? "active" : ""}" data-symbol="${pair.symbol}" data-status="${pair.status}" ${pair.status !== "active" ? "disabled" : ""} aria-busy="${getPairIsLoading(pair)}">
          <span>
            <strong>${getDisplaySymbol(pair)}</strong><br />
            <small>${pair.name} · ${getProviderSymbolLabel(pair)}</small>
          </span>
          <strong>${getPairBadge(pair)}</strong>
        </button>
      ` : `
        <div class="pair-button unavailable" data-symbol="${pair.symbol}" data-status="${pair.status}" aria-disabled="true">
          <span>
            <strong>${getDisplaySymbol(pair)}</strong><br />
            <small>${getProviderSymbolLabel(pair)} · ${pair.availabilityMessage}</small>
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
    if (pair.category === "Crypto") {
      return pair.statusLabel || (pair.status === "disabled" ? "Disabled by admin" : "Unavailable");
    }
    return pair.category === "Commodities" &&
      pair.availabilityCode === "PROVIDER_NOT_CONFIGURED"
      ? "Not configured"
      : "Coming Soon";
  }

  return pair.marketStatus?.label || (Number.isFinite(pair.change24h) ? formatPercent(pair.change24h) : "Ready");
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
  document.querySelector("#provider-name").textContent = getProviderSymbolLabel(state.selectedPair);
  document.querySelector("#selected-symbol").textContent = getDisplaySymbol(state.selectedPair);
  document.querySelector("#selected-price").textContent = Number.isFinite(state.selectedPair.lastPrice)
    ? formatCurrency(state.selectedPair.lastPrice)
    : state.selectedPair.availabilityMessage || "Coming Soon";
  document.querySelector("#selected-change").textContent = Number.isFinite(state.selectedPair.change24h) ? formatPercent(state.selectedPair.change24h) : "--";
  document.querySelector("#provider-status").textContent = state.selectedPair.marketStatus?.label ||
    (state.selectedPair.category === "Crypto" && state.selectedPair.providerStatus === "unchecked"
      ? "Pending verification"
      : state.selectedPair.status === "active" ? "Ready" : state.selectedPair.availabilityMessage || "Coming Soon");
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

function getDisplaySymbol(pairOrSymbol) {
  const pair = typeof pairOrSymbol === "string"
    ? state.marketCatalog.find((item) => item.symbol === pairOrSymbol) ||
      state.pairs.find((item) => item.symbol === pairOrSymbol)
    : pairOrSymbol;

  if (!pair) return String(pairOrSymbol || "");
  return pair.displaySymbol || (pair.category === "Crypto" ? pair.symbol.replace("-", "") : pair.symbol);
}

function getProviderSymbolLabel(pairOrSymbol) {
  const pair = typeof pairOrSymbol === "string"
    ? state.marketCatalog.find((item) => item.symbol === pairOrSymbol) ||
      state.pairs.find((item) => item.symbol === pairOrSymbol)
    : pairOrSymbol;

  if (!pair) return "";
  return `${getProviderLabel(pair)} · ${pair.symbol}`;
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
        removeHashParams(["checkout"]);
        return;
      }
      billingStatus.textContent = `Purchase received. Waiting for Stripe confirmation (${attempt}/20)...`;
    } catch {
      billingStatus.textContent = "Purchase received. Retrying billing refresh...";
    }
  }

  billingStatus.textContent = "Purchase received. Billing will update when Stripe confirms payment.";
  removeHashParams(["checkout"]);
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
  if (!state.historyFiltersInitialized) {
    state.historyFilters = filtersFromSignalParams(new URLSearchParams(), state.signals);
    state.historyFiltersInitialized = true;
  }
  const counts = getSignalStatusCounts(state.signals);
  const filtered = filterAndSortSignals(state.signals, state.historyFilters, state.marketCatalog);

  renderSignalFilterControls(counts);

  historyCount.textContent = `${counts.all} saved`;
  logSignalHistoryDiagnostics("filter", filtered.length);

  if (state.signals.length === 0) {
    signalsHistory.innerHTML = `
      ${renderTelegramExpiredNotice()}
      <div class="empty-state">
        <strong>No saved signals yet</strong>
        <p class="reasoning">Unlock a setup from Scan All or Unlock Current to save it in your Signals history.</p>
        ${renderSignalEmptyActions()}
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    const empty = getSignalFilterEmptyState(state.historyFilters.status);
    signalsHistory.innerHTML = `
      ${renderTelegramExpiredNotice()}
      <div class="empty-state">
        <strong>${escapeHtml(empty.title)}</strong>
        <p class="reasoning">${escapeHtml(empty.body)}</p>
        ${renderSignalEmptyActions()}
      </div>
    `;
    return;
  }

  signalsHistory.innerHTML = `
    ${renderTelegramExpiredNotice()}
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
          <th>Confidence ${renderConfidenceHelp()}</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${filtered.map((signal) => `
        ${renderSignalHistoryRow(signal)}
        ${state.expandedSignalKeys.has(getSignalKey(signal)) ? `<tr class="history-transparency">
          <td colspan="10">
            ${renderUnlockedSignalDetails(signal)}
          </td>
        </tr>` : ""}
      `).join("")}</tbody>
    </table>
    <div class="mobile-signals-list">
      ${filtered.map((signal) => renderMobileSignalHistoryCard(signal)).join("")}
    </div>
  `;
}

function renderTelegramExpiredNotice() {
  const notice = state.telegramExpiredNotice;
  if (!notice) return "";
  const signal = notice.signal || {};
  return `
    <section class="expired-signal-notice" role="status">
      <div>
        <span class="status-pill status-expired">Expired</span>
        <strong>${escapeHtml(notice.message || "This signal has expired and is no longer valid as a fresh setup.")}</strong>
        <p>It was not unlocked and no credit was charged.</p>
      </div>
      <button class="secondary-action" type="button" data-expired-history>View historical analysis</button>
      <div class="expired-history-details hidden" data-expired-history-details>
        <span>${escapeHtml(getDisplaySymbol(signal.symbol || "Signal"))} · ${escapeHtml(signal.timeframe || "")}</span>
        <strong>${escapeHtml(signal.setupType || "Historical setup")}</strong>
        <p>${escapeHtml(signal.reasoning || "This setup is retained for learning context only. Entry levels are not available without a valid unlock.")}</p>
      </div>
    </section>
  `;
}

function logSignalHistoryDiagnostics(event, rendered = null) {
  if (!isDevelopmentRuntime()) return;
  const counts = getSignalStatusCounts(state.signals);
  if (event === "loaded") {
    console.debug(
      `[signals] loaded total=${counts.all} active=${counts.active} tp=${counts["hit-tp"]} ` +
      `sl=${counts["hit-sl"]} expired=${counts.expired} closed=${counts.closed} selected=${state.historyFilters.status}`
    );
    return;
  }
  console.debug(`[signals] filter selected=${state.historyFilters.status} rendered=${rendered ?? 0}`);
}

function isDevelopmentRuntime() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function renderSignalFilterControls(counts) {
  historyStatusFilters.innerHTML = SIGNAL_STATUS_FILTERS.map(([value, label]) => `
    <button
      class="${state.historyFilters.status === value ? "active" : ""}"
      type="button"
      role="tab"
      aria-selected="${state.historyFilters.status === value}"
      data-history-status="${value}"
    >
      <span>${label}</span><strong>${counts[value] || 0}</strong>
    </button>
  `).join("");

  const pairValues = [...new Set([...state.marketCatalog, ...state.signals].map((item) => item.symbol).filter(Boolean))]
    .sort((a, b) => getDisplaySymbol(a).localeCompare(getDisplaySymbol(b)));
  historyPairFilter.innerHTML = `<option value="all">All pairs</option>${pairValues.map((symbol) => `
    <option value="${escapeHtml(symbol)}">${escapeHtml(getDisplaySymbol(symbol))} · ${escapeHtml(symbol)}</option>
  `).join("")}`;
  historyPairFilter.value = pairValues.includes(state.historyFilters.pair) ? state.historyFilters.pair : "all";

  const strategies = [...new Set([
    ...state.signals.map((signal) => signal.setupType).filter(Boolean),
    ...(state.historyFilters.strategy !== "all" ? [state.historyFilters.strategy] : [])
  ])]
    .sort((a, b) => a.localeCompare(b));
  historyStrategyFilter.innerHTML = `<option value="all">All strategies</option>${strategies.map((strategy) => `
    <option value="${escapeHtml(strategy)}">${escapeHtml(strategy)}</option>
  `).join("")}`;
  historyStrategyFilter.value = strategies.includes(state.historyFilters.strategy) ? state.historyFilters.strategy : "all";
  historyTimeframeFilter.value = state.historyFilters.timeframe;
  historyDirectionFilter.value = state.historyFilters.direction;
  historyDateFilter.value = state.historyFilters.dateRange;
  historySortFilter.value = state.historyFilters.sort;
  if (historySearchFilter.value !== state.historyFilters.search) historySearchFilter.value = state.historyFilters.search;
}

function getSignalFilterEmptyState(status) {
  const messages = {
    active: ["No active signals right now.", "Run the scanner or wait for Telegram alerts to find new setups."],
    "hit-tp": ["No take-profit signals yet.", "Closed winning signals will appear here."],
    "hit-sl": ["No stop-loss signals yet.", "Signals that hit stop loss will appear here."],
    expired: ["No expired signals yet.", "Signals that time out will appear here."],
    closed: ["No closed signals yet.", "Completed, expired, and manually closed signals will appear here."],
    all: ["No signals match these filters.", "Adjust the market, timeframe, direction, strategy, date, or search filters."]
  };
  const [title, body] = messages[status] || messages.all;
  return { title, body };
}

function renderSignalEmptyActions() {
  return `
    <div class="signal-empty-actions">
      <button type="button" data-signal-empty-action="scanner">Go to Scanner</button>
      <button class="secondary-button" type="button" data-signal-empty-action="paper-trading">Open Paper Trading</button>
    </div>
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
  if (state.paperTrading.account) renderPaperTradingTerminal();
}

function renderPaperTradingTerminal() {
  renderPaperMarketList();
  renderPaperTerminalHeader();
  renderPaperOrderTicket();
  renderPaperAccount();
  renderPaperTradingChart();
  renderPaperOrders();
}

function renderPaperMarketList() {
  const query = String(paperMarketSearch.value || "").toLowerCase().replaceAll("-", "");
  const markets = state.paperTrading.markets.filter((market) => {
    const haystack = `${market.displaySymbol} ${market.symbol} ${market.name} ${market.providerLabel}`.toLowerCase().replaceAll("-", "");
    return !query || haystack.includes(query);
  });
  paperMarketList.innerHTML = markets.map((market) => `
    <button class="paper-market-row ${market.symbol === state.paperTrading.selectedSymbol ? "active" : ""}" type="button" data-paper-market="${escapeHtml(market.symbol)}">
      <span><strong>${escapeHtml(market.displaySymbol)}</strong><small>${escapeHtml(getProviderSymbolLabel(market))}</small></span>
      <span class="paper-market-state">${market.symbol === state.paperTrading.selectedSymbol && state.paperTrading.marketData ? escapeHtml(state.paperTrading.marketData.marketStatus?.label || "Ready") : "Ready"}</span>
    </button>
  `).join("") || `<div class="empty-state"><span>No matching markets.</span></div>`;
  paperMarketList.querySelectorAll("[data-paper-market]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.paperTrading.selectedSymbol = button.dataset.paperMarket;
      await loadPaperTradingTerminal();
    });
  });
  const options = state.paperTrading.markets.map((market) => `<option value="${escapeHtml(market.symbol)}">${escapeHtml(market.displaySymbol)} · ${escapeHtml(market.name)}</option>`).join("");
  paperOrderMarket.innerHTML = options;
  paperOrderMarket.value = state.paperTrading.selectedSymbol;
  document.querySelector("#paper-filter-market").innerHTML = `<option value="">All markets</option>${options}`;
}

function renderPaperTerminalHeader() {
  const data = state.paperTrading.marketData;
  const pair = data?.pair || state.paperTrading.markets.find((item) => item.symbol === state.paperTrading.selectedSymbol);
  const change = Number(pair?.change24h);
  setText("#paper-top-market", getDisplaySymbol(pair || state.paperTrading.selectedSymbol));
  setText("#paper-top-price", Number.isFinite(Number(pair?.lastPrice)) ? formatCurrency(Number(pair.lastPrice)) : "--");
  setText("#paper-top-change", Number.isFinite(change) ? formatPercent(change) : "--");
  setText("#paper-top-timeframe", state.paperTrading.timeframe);
  setText("#paper-top-provider", getProviderLabel(pair));
  setText("#paper-top-status", data?.marketStatus?.label || (state.paperTrading.marketError ? "Provider unavailable" : "Loading"));
  document.querySelectorAll("[data-paper-timeframe]").forEach((button) => button.classList.toggle("active", button.dataset.paperTimeframe === state.paperTrading.timeframe));
  paperIndicatorControls.querySelectorAll("input").forEach((input) => {
    input.checked = state.paperTrading.indicators.has(input.value);
  });
}

function renderPaperOrderTicket() {
  const marketPrice = Number(state.paperTrading.marketData?.pair?.lastPrice || state.paperTrading.marketData?.candles?.at(-1)?.close || 0);
  document.querySelectorAll("[data-paper-direction]").forEach((button) => button.classList.toggle("active", button.dataset.paperDirection === state.paperTrading.direction));
  paperLimitField.classList.toggle("hidden", paperOrderType.value !== "limit");
  if (paperOrderType.value === "limit" && !Number(paperLimitPrice.value) && marketPrice) paperLimitPrice.value = marketPrice;
  document.querySelector("#paper-place-order").textContent = paperOrderType.value === "watch"
    ? "Watch setup"
    : `Place Paper ${state.paperTrading.direction === "long" ? "Long" : "Short"}`;
  renderPaperOrderCalculations();
  renderSignalEntryDistanceWarning();
}

function renderSignalEntryDistanceWarning() {
  if (!paperOrderSignalId.value) return;
  const currentPrice = Number(state.paperTrading.marketData?.pair?.lastPrice || state.paperTrading.marketData?.candles?.at(-1)?.close || 0);
  const signalEntry = Number(paperLimitPrice.value);
  const atr = calculateAtr(state.paperTrading.marketData?.candles || [], 14);
  if (!(currentPrice > 0 && signalEntry > 0 && atr > 0)) return;
  const closeToEntry = Math.abs(currentPrice - signalEntry) <= atr * 0.25;
  if (paperOrderType.value === "watch") {
    paperOrderWarning.textContent = "This entry is away from current price and may remain pending. Watch only creates no paper order.";
  } else if (paperOrderType.value === "limit" && !closeToEntry) {
    paperOrderWarning.textContent = "This entry is away from current price and may remain pending until price reaches it.";
  } else if (paperOrderType.value === "market" && !closeToEntry) {
    paperOrderWarning.textContent = "Simulated market entry uses the current price, which is away from the signal entry.";
  }
}

function prefillPaperOrderFromSignal(signal) {
  paperOrderSignalId.value = signal.id;
  paperOrderMarket.value = signal.symbol;
  const currentPrice = Number(state.paperTrading.marketData?.pair?.lastPrice || state.paperTrading.marketData?.candles?.at(-1)?.close || 0);
  const atr = calculateAtr(state.paperTrading.marketData?.candles || [], 14);
  const closeToEntry = atr > 0 && Math.abs(currentPrice - Number(signal.entryPrice)) <= atr * 0.25;
  paperOrderType.value = closeToEntry ? "market" : "watch";
  paperLimitPrice.value = signal.entryPrice;
  paperOrderStop.value = signal.stopLoss;
  paperOrderTarget.value = signal.takeProfit;
  const sizing = getSignalRiskCalculation(signal);
  if (sizing.valid) {
    paperOrderQuantity.value = formatCalculatorNumber(sizing.quantity, 8);
    paperOrderSize.value = formatCalculatorNumber(sizing.positionSize, 2);
  }
  paperOrderNotes.value = `${signal.setupType || "SignalForge setup"} · unlocked signal`;
  state.paperTrading.direction = signal.direction;
  renderPaperOrderTicket();
  paperOrderWarning.textContent = closeToEntry
    ? "Current price is close to the signal entry zone. Simulated entry now is selected."
    : "Signal entry is away from current price. Watch only is selected; choose Limit if you want an order that may remain pending.";
  if (sizing.valid) {
    paperOrderWarning.textContent += ` Estimated risk: ${formatCurrency(sizing.riskAmount)} (${formatCalculatorNumber(sizing.riskPercent, 2)}%).`;
  }
  paperOrderForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPaperOrderCalculations() {
  const latest = Number(state.paperTrading.marketData?.pair?.lastPrice || 0);
  const entry = paperOrderType.value === "limit" ? Number(paperLimitPrice.value) : latest;
  const stop = Number(paperOrderStop.value);
  const target = Number(paperOrderTarget.value);
  const requestedQuantity = Number(paperOrderQuantity.value);
  const size = Number(paperOrderSize.value);
  const quantity = requestedQuantity > 0 ? requestedQuantity : entry > 0 ? size / entry : 0;
  const effectiveSize = requestedQuantity > 0 ? quantity * entry : size;
  const risk = Math.abs(entry - stop) * quantity;
  const reward = Math.abs(target - entry) * quantity;
  const rr = risk > 0 ? reward / risk : 0;
  const riskPercent = effectiveSize > 0 ? (risk / effectiveSize) * 100 : 0;
  const rewardPercent = effectiveSize > 0 ? (reward / effectiveSize) * 100 : 0;
  document.querySelector("#paper-order-calculations").innerHTML = `
    <div><span>Estimated entry</span><strong>${entry > 0 ? formatCurrency(entry) : "--"}</strong></div><div><span>Risk</span><strong>${risk > 0 ? `${formatCurrency(risk)} · ${riskPercent.toFixed(2)}%` : "--"}</strong></div>
    <div><span>Potential loss</span><strong class="negative">${risk > 0 ? formatCurrency(-risk) : "--"}</strong></div><div><span>Potential profit</span><strong class="positive">${reward > 0 ? `${formatCurrency(reward)} · ${rewardPercent.toFixed(2)}%` : "--"}</strong></div><div><span>Reward / Risk</span><strong>${rr > 0 ? `${rr.toFixed(2)}R` : "--"}</strong></div>
  `;
  paperOrderWarning.textContent = rr > 0 && rr < 1.5 ? "Warning: reward/risk is below 1.5R." : "";
}

function renderPaperAccount() {
  const account = state.paperTrading.account || {};
  setText("#paper-account-balance", formatCurrency(account.balance || 10000));
  setText("#paper-account-equity", formatCurrency(account.equity || account.balance || 10000));
  setText("#paper-account-realized", formatCurrency(account.realizedPnl || 0));
  setText("#paper-account-unrealized", formatCurrency(account.unrealizedPnl || 0));
  setText("#paper-account-open", account.openPositions || 0);
  setText("#paper-account-win-rate", `${account.winRate || 0}%`);
  setText("#paper-account-net-r", formatR(account.netR || 0));
  setText("#paper-account-average-r", formatR(account.averageR || 0));
  paperTradeCount.textContent = `${account.openPositions || 0} open position${account.openPositions === 1 ? "" : "s"}`;
}

function renderPaperTradingChart() {
  const data = state.paperTrading.marketData;
  const candles = data?.candles || [];
  if (!candles.length) {
    paperChart.innerHTML = `<text x="460" y="235" fill="#8e9bb0" text-anchor="middle">${escapeHtml(state.paperTrading.marketError || "Not enough candles")}</text>`;
    setText("#paper-chart-status", state.paperTrading.marketError || "Market data unavailable.");
    return;
  }
  const visible = candles.slice(-120);
  const width = 920;
  const height = 480;
  const left = 14;
  const right = 76;
  const top = 18;
  const volumeHeight = state.paperTrading.indicators.has("volume") ? 72 : 0;
  const bottom = 28 + volumeHeight;
  const orders = state.paperTrading.orders.filter((order) => order.symbol === state.paperTrading.selectedSymbol);
  const levelPrices = orders.flatMap((order) => [order.entryPrice, order.limitPrice, order.stopLoss, order.takeProfit]).filter(Number.isFinite);
  const min = Math.min(...visible.map((candle) => Number(candle.low)), ...levelPrices);
  const max = Math.max(...visible.map((candle) => Number(candle.high)), ...levelPrices);
  const range = Math.max(max - min, max * 0.002, 0.000001);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const slot = plotWidth / visible.length;
  const y = (price) => top + ((max - Number(price)) / range) * plotHeight;
  const x = (index) => left + index * slot + slot / 2;
  const grid = Array.from({ length: 6 }, (_, index) => {
    const price = max - (range * index / 5);
    const gridY = y(price);
    return `<line class="paper-chart-grid" x1="${left}" x2="${width - right}" y1="${gridY}" y2="${gridY}"></line><text class="paper-price-label" x="${width - right + 8}" y="${gridY + 4}">${escapeHtml(formatCompactPrice(price))}</text>`;
  }).join("");
  const candleMarkup = visible.map((candle, index) => {
    const candleX = x(index);
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const up = Number(candle.close) >= Number(candle.open);
    return `<g class="paper-candle" data-paper-candle-index="${index}"><line class="candle-wick ${up ? "candle-up" : "candle-down"}" x1="${candleX}" x2="${candleX}" y1="${y(candle.high)}" y2="${y(candle.low)}"></line><rect class="candle-body ${up ? "candle-up" : "candle-down"}" x="${candleX - Math.max(1.5, slot * 0.28)}" y="${Math.min(openY, closeY)}" width="${Math.max(3, slot * 0.56)}" height="${Math.max(2, Math.abs(openY - closeY))}"></rect></g>`;
  }).join("");
  const overlays = renderPaperChartOverlays(visible, x, y);
  const volume = state.paperTrading.indicators.has("volume") ? renderPaperVolume(visible, x, slot, height - 22, volumeHeight - 8) : "";
  const tradeLines = orders.filter((order) => ["Open", "Pending"].includes(order.status)).map((order) => {
    const entry = order.entryPrice || order.limitPrice;
    return renderPaperPriceLine(y(entry), "entry", `ENTRY ${formatCompactPrice(entry)}`) +
      renderPaperPriceLine(y(order.stopLoss), "stop", `SL ${formatCompactPrice(order.stopLoss)}`) +
      renderPaperPriceLine(y(order.takeProfit), "target", `TP ${formatCompactPrice(order.takeProfit)}`);
  }).join("");
  const markers = orders.filter((order) => order.closedAt && order.exitPrice).slice(0, 20).map((order) => {
    const markerX = width - right - 12;
    const markerY = y(order.exitPrice);
    return `<circle class="paper-trade-marker ${order.outcome === "Hit TP" ? "win" : "loss"}" cx="${markerX}" cy="${markerY}" r="5"></circle>`;
  }).join("");
  const positionMarkers = orders.filter((order) => order.status === "Open" && order.entryPrice).map((order) => `<circle class="paper-position-marker ${order.direction}" cx="${width - right - 18}" cy="${y(order.entryPrice)}" r="5"></circle>`).join("");
  const timeAxis = Array.from({ length: 6 }, (_, tick) => {
    const index = Math.min(visible.length - 1, Math.floor((visible.length - 1) * tick / 5));
    return `<text class="paper-time-label" x="${x(index)}" y="${height - 7}" text-anchor="middle">${escapeHtml(formatTime(Number(visible[index].time) * 1000))}</text>`;
  }).join("");
  const latest = Number(visible.at(-1).close);
  paperChart.innerHTML = `${grid}${volume}${candleMarkup}${overlays}${tradeLines}${renderPaperPriceLine(y(latest), "current", `NOW ${formatCompactPrice(latest)}`)}${markers}${positionMarkers}${timeAxis}<line id="paper-crosshair-x" class="paper-crosshair hidden" x1="0" x2="0" y1="${top}" y2="${height - bottom}"></line><line id="paper-crosshair-y" class="paper-crosshair hidden" x1="${left}" x2="${width - right}" y1="0" y2="0"></line>`;
  bindPaperChartCrosshair(visible, { left, right, top, bottom, width, height, min, max, x, y });
  renderPaperIndicatorReadout(visible);
  setText("#paper-chart-status", `${candles.length} live candles · Last ${formatDateTime(data.lastCandleAt)} · ${data.marketStatus?.label || "Ready"}`);
}

function renderPaperChartOverlays(candles, x, y) {
  const enabled = state.paperTrading.indicators;
  const lines = [];
  if (enabled.has("ema20")) lines.push(renderIndicatorPath(calculateEmaSeries(candles, 20), x, y, "ema20"));
  if (enabled.has("ema50")) lines.push(renderIndicatorPath(calculateEmaSeries(candles, 50), x, y, "ema50"));
  if (enabled.has("ema200")) lines.push(renderIndicatorPath(calculateEmaSeries(candles, 200), x, y, "ema200"));
  if (enabled.has("vwap")) lines.push(renderIndicatorPath(calculateVwapSeries(candles), x, y, "vwap"));
  if (enabled.has("bollinger")) {
    const bands = calculateBollingerSeries(candles, 20);
    lines.push(renderIndicatorPath(bands.upper, x, y, "bollinger"), renderIndicatorPath(bands.lower, x, y, "bollinger"));
  }
  return lines.join("");
}

function renderIndicatorPath(values, x, y, className) {
  const points = values.map((value, index) => Number.isFinite(value) ? `${x(index).toFixed(2)},${y(value).toFixed(2)}` : null).filter(Boolean);
  return points.length > 1 ? `<polyline class="paper-indicator-line ${className}" points="${points.join(" ")}"></polyline>` : "";
}

function renderPaperVolume(candles, x, slot, baseline, availableHeight) {
  const maxVolume = Math.max(...candles.map((candle) => Number(candle.volume || 0)), 1);
  return candles.map((candle, index) => {
    const barHeight = (Number(candle.volume || 0) / maxVolume) * availableHeight;
    const up = Number(candle.close) >= Number(candle.open);
    return `<rect class="paper-volume ${up ? "up" : "down"}" x="${x(index) - Math.max(1, slot * 0.3)}" y="${baseline - barHeight}" width="${Math.max(2, slot * 0.6)}" height="${barHeight}"></rect>`;
  }).join("");
}

function renderPaperPriceLine(lineY, type, label) {
  if (!Number.isFinite(lineY)) return "";
  return `<line class="paper-trade-line ${type}" x1="14" x2="844" y1="${lineY}" y2="${lineY}"></line><text class="paper-trade-label ${type}" x="838" y="${lineY - 4}" text-anchor="end">${escapeHtml(label)}</text>`;
}

function bindPaperChartCrosshair(candles, dimensions) {
  paperChart.onpointermove = (event) => {
    const rect = paperChart.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * dimensions.width;
    const svgY = ((event.clientY - rect.top) / rect.height) * dimensions.height;
    const plotWidth = dimensions.width - dimensions.left - dimensions.right;
    const index = Math.max(0, Math.min(candles.length - 1, Math.floor(((svgX - dimensions.left) / plotWidth) * candles.length)));
    const candle = candles[index];
    const crossX = paperChart.querySelector("#paper-crosshair-x");
    const crossY = paperChart.querySelector("#paper-crosshair-y");
    crossX.classList.remove("hidden"); crossY.classList.remove("hidden");
    crossX.setAttribute("x1", dimensions.x(index)); crossX.setAttribute("x2", dimensions.x(index));
    crossY.setAttribute("y1", svgY); crossY.setAttribute("y2", svgY);
    paperChartTooltip.classList.remove("hidden");
    paperChartTooltip.style.left = `${Math.min(rect.width - 190, Math.max(8, event.clientX - rect.left + 12))}px`;
    paperChartTooltip.style.top = `${Math.max(8, event.clientY - rect.top - 68)}px`;
    paperChartTooltip.textContent = `${formatDateTime(Number(candle.time) * 1000)} · O ${formatCompactPrice(candle.open)} H ${formatCompactPrice(candle.high)} L ${formatCompactPrice(candle.low)} C ${formatCompactPrice(candle.close)}`;
  };
  paperChart.onpointerleave = () => {
    paperChart.querySelectorAll(".paper-crosshair").forEach((line) => line.classList.add("hidden"));
    paperChartTooltip.classList.add("hidden");
  };
}

function renderPaperIndicatorReadout(candles) {
  const enabled = state.paperTrading.indicators;
  const values = [];
  if (enabled.has("rsi")) values.push(["RSI 14", calculateRsi(candles, 14)]);
  if (enabled.has("atr")) values.push(["ATR 14", calculateAtr(candles, 14)]);
  if (enabled.has("macd")) values.push(["MACD", calculateMacd(candles)]);
  document.querySelector("#paper-indicator-readout").innerHTML = values.map(([label, value]) => `<span><strong>${label}</strong> ${Number(value || 0).toFixed(2)}</span>`).join("");
}

function renderPaperOrders() {
  const tab = state.paperTrading.activeTab;
  paperTerminalTabs.querySelectorAll("[data-paper-tab]").forEach((button) => button.classList.toggle("active", button.dataset.paperTab === tab));
  paperHistoryFilters.classList.toggle("hidden", tab !== "history");
  let orders = state.paperTrading.orders.filter((order) => tab === "positions" ? order.status === "Open" : tab === "pending" ? order.status === "Pending" : ["Hit TP", "Hit SL", "Expired", "Expired unfilled", "Closed", "Cancelled"].includes(order.status));
  if (tab === "history") orders = filterPaperHistory(orders);
  if (!orders.length) {
    const messages = { positions: "No open paper positions.", pending: "No pending limit orders.", history: "No completed paper trades yet." };
    paperPortfolioGrid.innerHTML = `<div class="empty-state"><strong>${messages[tab]}</strong><p class="reasoning">Select a market and place a simulated trade to begin.</p></div>`;
    return;
  }
  const columns = tab === "pending"
    ? ["Market", "Side", "Limit", "Size", "Stop", "Target", "Created", "Action"]
    : tab === "history"
      ? ["Market", "Side", "Entry", "Exit", "Result", "P/L", "R", "Closed", "Notes"]
      : ["Market", "Side", "Entry", "Current", "Stop", "Target", "Size", "P/L", "R", "Opened", "Action"];
  paperPortfolioGrid.innerHTML = `<table><thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead><tbody>${orders.map((order) => renderPaperOrderRow(order, tab)).join("")}</tbody></table>`;
}

function renderPaperOrderRow(order, tab) {
  const market = escapeHtml(getDisplaySymbol(order.symbol));
  const side = `<strong class="direction ${order.direction}">${escapeHtml(order.direction.toUpperCase())}</strong>`;
  if (tab === "pending") return `<tr><td data-label="Market">${market}</td><td data-label="Side">${side}</td><td data-label="Limit">${formatCurrency(order.limitPrice)}</td><td data-label="Size">${formatCurrency(order.positionSizeUsd)}</td><td data-label="Stop">${formatCurrency(order.stopLoss)}</td><td data-label="Target">${formatCurrency(order.takeProfit)}</td><td data-label="Created">${formatDateTime(order.createdAt)}</td><td data-label="Action"><button class="secondary-action" type="button" data-paper-cancel-order="${order.id}">Cancel</button></td></tr>`;
  if (tab === "history") return `<tr><td data-label="Market">${market}</td><td data-label="Side">${side}</td><td data-label="Entry">${formatCurrency(order.entryPrice || order.limitPrice)}</td><td data-label="Exit">${order.exitPrice ? formatCurrency(order.exitPrice) : "--"}</td><td data-label="Result"><span class="status-pill ${getPaperStatusClass(order.status)}">${escapeHtml(order.status)}</span></td><td data-label="P/L" class="${order.realizedPnl >= 0 ? "positive" : "negative"}">${formatCurrency(order.realizedPnl)}</td><td data-label="R">${formatR(order.rMultiple)}</td><td data-label="Closed">${order.closedAt ? formatDateTime(order.closedAt) : "--"}</td><td data-label="Notes">${escapeHtml(order.notes || "--")}</td></tr>`;
  return `<tr><td data-label="Market">${market}</td><td data-label="Side">${side}</td><td data-label="Entry">${formatCurrency(order.entryPrice)}</td><td data-label="Current">${formatCurrency(order.currentPrice)}</td><td data-label="Stop">${formatCurrency(order.stopLoss)}</td><td data-label="Target">${formatCurrency(order.takeProfit)}</td><td data-label="Size">${formatCurrency(order.positionSizeUsd)}</td><td data-label="P/L" class="${order.unrealizedPnl >= 0 ? "positive" : "negative"}">${formatCurrency(order.unrealizedPnl)}</td><td data-label="R">${formatR(order.unrealizedR)}</td><td data-label="Opened">${formatDateTime(order.openedAt)}</td><td data-label="Action"><button class="secondary-action" type="button" data-paper-close-order="${order.id}">Close</button></td></tr>`;
}

function filterPaperHistory(orders) {
  const market = document.querySelector("#paper-filter-market").value;
  const direction = document.querySelector("#paper-filter-direction").value;
  const outcome = document.querySelector("#paper-filter-outcome").value;
  const from = document.querySelector("#paper-filter-from").value;
  const to = document.querySelector("#paper-filter-to").value;
  return orders.filter((order) => (!market || order.symbol === market) && (!direction || order.direction === direction) && (!outcome || order.status === outcome) && (!from || new Date(order.closedAt) >= new Date(from)) && (!to || new Date(order.closedAt) < new Date(`${to}T23:59:59`)));
}

async function placePaperTradingOrder(event) {
  event.preventDefault();
  const button = document.querySelector("#paper-place-order");
  if (paperOrderType.value === "watch") {
    state.paperTrading.draftSignalId = paperOrderSignalId.value || null;
    showToast("Watch only selected. No paper order was placed.");
    paperOrderWarning.textContent = "Watching only. The setup remains in Signals; no position or pending order was created.";
    return;
  }
  try {
    button.disabled = true;
    button.textContent = "Placing simulated order...";
    const payload = {
      savedSignalId: paperOrderSignalId.value || null,
      symbol: paperOrderMarket.value,
      timeframe: state.paperTrading.timeframe,
      direction: state.paperTrading.direction,
      orderType: paperOrderType.value,
      limitPrice: Number(paperLimitPrice.value),
      quantity: Number(paperOrderQuantity.value),
      positionSizeUsd: Number(paperOrderSize.value),
      stopLoss: Number(paperOrderStop.value),
      takeProfit: Number(paperOrderTarget.value),
      notes: paperOrderNotes.value
    };
    const terminal = await api.request("/api/paper-trades/orders", { method: "POST", body: JSON.stringify(payload) });
    Object.assign(state.paperTrading, terminal);
    state.paperTrading.draftSignalId = null;
    paperOrderSignalId.value = "";
    renderPaperTradingTerminal();
    showToast(payload.orderType === "market" ? "Paper position opened" : "Paper limit order placed");
  } catch (error) {
    paperOrderWarning.textContent = error.message;
  } finally {
    button.disabled = false;
    renderPaperOrderTicket();
  }
}

async function performPaperOrderAction(button, action) {
  try {
    button.disabled = true;
    const orderId = action === "close" ? button.dataset.paperCloseOrder : button.dataset.paperCancelOrder;
    const terminal = await api.request(`/api/paper-trades/orders/${encodeURIComponent(orderId)}/${action}`, { method: "POST", body: "{}" });
    Object.assign(state.paperTrading, terminal);
    renderPaperTradingTerminal();
    showToast(action === "close" ? "Paper position closed" : "Pending order cancelled");
  } catch (error) {
    paperOrderWarning.textContent = error.message;
    button.disabled = false;
  }
}

async function resetPaperTrading() {
  if (!window.confirm("Reset the paper account to $10,000 and archive all open positions and history?")) return;
  try {
    const terminal = await api.request("/api/paper-trades/reset", { method: "POST", body: JSON.stringify({ confirmation: "RESET" }) });
    Object.assign(state.paperTrading, terminal);
    renderPaperTradingTerminal();
    showToast("Paper account reset");
  } catch (error) {
    paperOrderWarning.textContent = error.message;
  }
}

function calculateEmaSeries(candles, period) {
  const multiplier = 2 / (period + 1);
  let current = Number(candles[0]?.close || 0);
  return candles.map((candle) => current = Number(candle.close) * multiplier + current * (1 - multiplier));
}

function calculateVwapSeries(candles) {
  let volume = 0; let priceVolume = 0;
  return candles.map((candle) => {
    const candleVolume = Number(candle.volume || 0);
    volume += candleVolume;
    priceVolume += ((Number(candle.high) + Number(candle.low) + Number(candle.close)) / 3) * candleVolume;
    return volume ? priceVolume / volume : Number(candle.close);
  });
}

function calculateBollingerSeries(candles, period) {
  const upper = []; const lower = [];
  candles.forEach((candle, index) => {
    const values = candles.slice(Math.max(0, index - period + 1), index + 1).map((item) => Number(item.close));
    if (values.length < period) { upper.push(NaN); lower.push(NaN); return; }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    upper.push(mean + deviation * 2); lower.push(mean - deviation * 2);
  });
  return { upper, lower };
}

function calculateRsi(candles, period) {
  const changes = candles.slice(-(period + 1)).map((item, index, array) => index ? Number(item.close) - Number(array[index - 1].close) : 0).slice(1);
  if (changes.length < period) return 0;
  const gains = changes.reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  const losses = changes.reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  return losses ? 100 - (100 / (1 + gains / losses)) : 100;
}

function calculateAtr(candles, period) {
  const recent = candles.slice(-(period + 1));
  if (recent.length <= period) return 0;
  return recent.slice(1).reduce((sum, candle, index) => sum + Math.max(Number(candle.high) - Number(candle.low), Math.abs(Number(candle.high) - Number(recent[index].close)), Math.abs(Number(candle.low) - Number(recent[index].close))), 0) / period;
}

function calculateMacd(candles) {
  const fast = calculateEmaSeries(candles, 12).at(-1) || 0;
  const slow = calculateEmaSeries(candles, 26).at(-1) || 0;
  return fast - slow;
}

function formatCompactPrice(value) {
  const numeric = Number(value || 0);
  return numeric >= 1000 ? numeric.toFixed(2) : numeric >= 1 ? numeric.toFixed(4) : numeric.toPrecision(5);
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
        <p class="reasoning">Add an unlocked signal to Paper Trading, then record the plan, emotions, and review here.</p>
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
  const {
    summary,
    signalsByMarket,
    signalsByTimeframe,
    monthlyPerformance,
    charts,
    regimePerformance = [],
    smcPerformance = [],
    confluencePerformance = [],
    sessionPerformance = []
  } = state.performance;
  const netR = calculateNetRFromPerformance(state.performance);
  const closedCount = Number(summary.hitTpCount || 0) + Number(summary.hitSlCount || 0) + Number(summary.expiredCount || 0);
  const hasClosedSignals = closedCount > 0;

  document.querySelector("#performance-empty-state")?.classList.toggle("hidden", hasClosedSignals);
  document.querySelector("#performance-total").textContent = `${summary.totalSignals}`;
  document.querySelector("#performance-win-rate").textContent = `${summary.winRate}%`;
  document.querySelector("#performance-net-r").textContent = formatR(netR);
  document.querySelector("#performance-net-r").className = netR >= 0 ? "positive" : "negative";
  document.querySelector("#performance-average-r").textContent = formatR(closedCount ? netR / closedCount : 0);
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
  document.querySelector("#performance-overview-note").classList.toggle("hidden", hasClosedSignals && monthlyPerformance.length > 1);
  renderEquityCurve(monthlyPerformance);
  renderWinRateChart(charts.winRateOverTime);
  renderAnalyticsBars(document.querySelector("#tp-sl-chart"), charts.outcomes, true);
  renderAnalyticsBars(document.querySelector("#market-distribution-chart"), charts.marketDistribution);
  renderMarketPerformanceTable(document.querySelector("#signals-by-market"), buildMarketPerformanceRows(state.performance));
  renderFactorTable(document.querySelector("#signals-by-timeframe"), buildTimeframePerformanceRows(state.performance));
  renderFactorTable(document.querySelector("#signals-by-regime"), regimePerformance);
  renderFactorTable(document.querySelector("#signals-by-smc"), smcPerformance);
  renderFactorTable(document.querySelector("#signals-by-confluence"), confluencePerformance);
  renderFactorTable(document.querySelector("#signals-by-session"), sessionPerformance);
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
  renderRecentClosedSignals();
}

function calculateNetRFromPerformance(performance) {
  if (performance?.monthlyPerformance?.length) {
    return performance.monthlyPerformance.reduce((sum, month) => sum + Number(month.netR || 0), 0);
  }
  const summary = performance?.summary || {};
  return Number(summary.hitTpCount || 0) * Number(summary.averageRiskReward || 0) -
    Number(summary.hitSlCount || 0);
}

function buildMarketPerformanceRows(performance) {
  if (performance.marketPerformance?.length) return performance.marketPerformance;
  return (performance.signalsByMarket || []).map((item) => ({
    label: item.label,
    totalSignals: item.value,
    winRate: 0,
    netR: 0,
    bestTimeframe: null
  }));
}

function buildTimeframePerformanceRows(performance) {
  if (performance.timeframePerformance?.length) return performance.timeframePerformance;
  return (performance.signalsByTimeframe || []).map((item) => ({
    label: item.label,
    totalSignals: item.value,
    winRate: 0,
    netR: 0
  }));
}

function renderMarketPerformanceTable(container, rows) {
  if (!container) return;
  if (!rows?.length) {
    container.innerHTML = renderPerformanceEmpty("No market performance yet.");
    return;
  }

  container.innerHTML = `
    <table class="performance-data-table">
      <thead><tr><th>Market</th><th>Signals</th><th>Win rate</th><th>Net R</th><th>Average R</th><th>Best timeframe</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td><strong>${escapeHtml(row.label)}</strong></td>
          <td>${row.totalSignals ?? row.value ?? 0}</td>
          <td>${row.winRate || 0}%</td>
          <td class="${Number(row.netR || 0) >= 0 ? "positive" : "negative"}">${formatR(row.netR || 0)}</td>
          <td>${formatR(getAverageR(row))}</td>
          <td>${row.bestTimeframe ? `${escapeHtml(row.bestTimeframe.label)} · ${row.bestTimeframe.winRate}%` : "--"}</td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function renderFactorTable(container, rows) {
  if (!container) return;
  const activeRows = (rows || []).filter((row) => Number(row.totalSignals || row.value || 0) > 0);
  if (!activeRows.length) {
    container.innerHTML = renderPerformanceEmpty("No tracked outcomes yet.");
    return;
  }

  container.innerHTML = `
    <table class="performance-data-table compact">
      <thead><tr><th>Factor</th><th>Signals</th><th>Win rate</th><th>Net R</th><th>Average R</th></tr></thead>
      <tbody>${activeRows.map((row) => `
        <tr>
          <td><strong>${escapeHtml(row.label)}</strong></td>
          <td>${row.totalSignals ?? row.value ?? 0}</td>
          <td>${row.winRate || 0}%</td>
          <td class="${Number(row.netR || 0) >= 0 ? "positive" : "negative"}">${formatR(row.netR || 0)}</td>
          <td>${formatR(getAverageR(row))}</td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function getAverageR(row) {
  const total = Number(row.totalSignals ?? row.value ?? 0);
  return total ? Number(row.netR || 0) / total : 0;
}

function renderPerformanceEmpty(message) {
  return `<div class="empty-state"><span>${escapeHtml(message)}</span></div>`;
}

function renderRecentClosedSignals() {
  const container = document.querySelector("#recent-closed-signals");
  if (!container) return;
  const signals = state.performance?.recentClosedSignals || [];
  if (!signals.length) {
    container.innerHTML = renderPerformanceEmpty("No completed signals yet.");
    return;
  }

  container.innerHTML = `
    <table class="performance-data-table">
      <thead><tr><th>Market</th><th>Timeframe</th><th>Direction</th><th>Outcome</th><th>R result</th><th>Closed</th><th></th></tr></thead>
      <tbody>${signals.map((signal) => `
        <tr>
          <td><strong>${escapeHtml(signal.symbol)}</strong></td>
          <td>${escapeHtml(signal.timeframe)}</td>
          <td><strong class="direction ${signal.direction}">${escapeHtml(signal.direction).toUpperCase()}</strong></td>
          <td><span class="status-pill ${getPaperStatusClass(signal.status)}">${escapeHtml(signal.status)}</span></td>
          <td class="${Number(signal.resultR || 0) >= 0 ? "positive" : "negative"}">${formatR(signal.resultR || 0)}</td>
          <td>${formatDateTime(signal.closedAt)}</td>
          <td><button class="secondary-action" type="button" data-performance-open-signals>View signal</button></td>
        </tr>
      `).join("")}</tbody>
    </table>
  `;
}

function renderEquityCurve(months) {
  const points = [];
  let cumulative = 0;
  for (const month of months || []) {
    cumulative += Number(month.netR || 0);
    points.push({ label: month.label, value: cumulative });
  }
  renderRLineChart(document.querySelector("#equity-curve-chart"), points, "Cumulative R over time");
}

function renderRLineChart(container, points, label) {
  if (!container) return;
  if (!points?.length || points.length === 1) {
    container.innerHTML = `<div class="empty-state"><span>Not enough closed signals yet. Keep tracking outcomes to build performance history.</span></div>`;
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
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">
      <line class="chart-axis" x1="${padding}" y1="${y(0)}" x2="${width - padding}" y2="${y(0)}"></line>
      <path class="chart-line" d="${path}"></path>
      <text class="chart-label" x="4" y="${y(max) + 4}">${formatR(max)}</text>
      <text class="chart-label" x="4" y="${y(min) + 4}">${formatR(min)}</text>
    </svg>
  `;
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
  if (performanceDirection.value) parts.push(performanceDirection.value.toUpperCase());
  if (performanceOutcome.value) parts.push(performanceOutcome.value);
  return parts.length ? parts.join(" · ") : "All history";
}

function renderSignalHistoryRow(signal) {
  const status = getDemoSignalStatus(signal);
  const key = getSignalKey(signal);

  return `
    <tr data-signal-key="${key}">
      <td>
        <strong>${escapeHtml(getDisplaySymbol(signal.symbol))}</strong>
        <small class="history-provider-label">${escapeHtml(getProviderSymbolLabel(signal.symbol))}</small>
        <button class="history-details-button" type="button" data-history-details="${key}">
          ${state.expandedSignalKeys.has(key) ? "Hide details" : "View details"}
        </button>
      </td>
      <td>${signal.timeframe}</td>
      <td><strong class="direction ${signal.direction}">${signal.direction}</strong></td>
      <td>${formatCurrency(signal.entryPrice)}</td>
      <td>${formatCurrency(signal.stopLoss)}</td>
      <td>${formatCurrency(signal.takeProfit)}</td>
      <td>${signal.riskRewardRatio}:1</td>
      <td>${signal.confidenceScore}%</td>
      <td>${renderSignalValidity(signal, { compact: true })}</td>
      <td>${formatDateTime(signal.generatedAt)}</td>
    </tr>
  `;
}

function renderMobileSignalHistoryCard(signal) {
  const status = getDemoSignalStatus(signal);
  const key = getSignalKey(signal);

  return `
    <article class="mobile-signal-card" data-signal-key="${key}">
      <div class="mobile-signal-card-header">
        <div>
          <strong>${escapeHtml(getDisplaySymbol(signal.symbol))}</strong>
          <span>${escapeHtml(getProviderSymbolLabel(signal.symbol))}</span>
        </div>
        <span class="status-pill ${status.className}">${status.label}</span>
      </div>
      <div class="mobile-signal-meta">
        <span>${escapeHtml(signal.timeframe)}</span>
        <strong class="direction ${signal.direction}">${escapeHtml(signal.direction || "")}</strong>
        <span>${formatDateTime(signal.generatedAt)}</span>
      </div>
      ${renderSignalValidity(signal)}
      <div class="mobile-signal-values">
        ${renderMobileSignalValue("Entry", formatCurrency(signal.entryPrice))}
        ${renderMobileSignalValue("Stop", formatCurrency(signal.stopLoss))}
        ${renderMobileSignalValue("Take profit", formatCurrency(signal.takeProfit))}
        ${renderMobileSignalValue("R/R", `${signal.riskRewardRatio}:1`)}
        ${renderMobileSignalConfidence(signal.confidenceScore)}
      </div>
      ${renderRiskCalculator(signal)}
      ${renderPaperTradeAction(signal)}
      ${renderConfidenceSummary(signal)}
      ${state.scannerMode === "advanced" ? renderSignalQuality(signal, { compact: true }) : ""}
      ${renderMobileSignalAccordion(signal)}
    </article>
  `;
}

function renderMobileSignalValue(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderMobileSignalConfidence(confidenceScore) {
  return `
    <div>
      <span>Confidence ${renderConfidenceHelp()}</span>
      <strong>${Number(confidenceScore || 0)}%</strong>
    </div>
  `;
}

function renderMobileSignalAccordion(signal) {
  const confirmations = normalizeConfirmations(signal.confirmations || [], signal.indicators || {});
  const passed = confirmations.filter((item) => item.passed).map((item) => item.name);

  if (state.scannerMode === "beginner") {
    return `
      <div class="mobile-signal-accordion beginner">
        <details>
          <summary>Why this setup?</summary>
          <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
        </details>
        <button class="secondary-action view-advanced-details" type="button" data-signal-view-mode="advanced">View advanced details</button>
        <p class="mobile-signal-disclaimer">Educational analysis only. Not financial advice.</p>
      </div>`;
  }

  return `
    <div class="mobile-signal-accordion">
      <details>
        <summary>Overview</summary>
        <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
      </details>
      <details>
        <summary>Why this signal?</summary>
        <div class="confirmation-list mobile-confirmations">
          ${confirmations.map((item) => `
            <div class="confirmation-item ${item.passed ? "passed" : "failed"}">
              <strong>${item.passed ? "Passed" : "Failed"} · ${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.detail)}</span>
            </div>
          `).join("") || `<p class="reasoning">Confirmed by ${escapeHtml(passed.join(", ") || "rule-based confluence")}.</p>`}
        </div>
      </details>
      <details>
        <summary>Risk levels</summary>
        <div class="mobile-signal-values compact">
          ${renderMobileSignalValue("Entry", formatCurrency(signal.entryPrice))}
          ${renderMobileSignalValue("Stop loss", formatCurrency(signal.stopLoss))}
          ${renderMobileSignalValue("Take profit", formatCurrency(signal.takeProfit))}
          ${renderMobileSignalValue("Reward/risk", `${signal.riskRewardRatio}:1`)}
        </div>
        ${renderRiskEngineCard(signal)}
      </details>
      <details>
        <summary>AI analyst explanation</summary>
        ${renderAiAnalyst(signal)}
      </details>
      <details>
        <summary>Full analysis context</summary>
        <p class="reasoning long-analysis">${escapeHtml(signal.reasoning || "Advanced signal context is based on rule alignment.")}</p>
        ${renderSignalConfluence(signal)}
        ${renderSmcExplanation(signal)}
        ${renderAdvancedStructureExplanation(signal)}
        ${renderRiskEngineCard(signal)}
      </details>
      <details>
        <summary>Checklist and validation</summary>
        ${renderSignalValidation(signal)}
        <div class="confirmation-list mobile-confirmations">
          ${confirmations.map((item) => `
            <div class="confirmation-item ${item.passed ? "passed" : "failed"}">
              <strong>${item.passed ? "Passed" : "Failed"} · ${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.detail)}</span>
            </div>
          `).join("")}
        </div>
      </details>
      <details>
        <summary>Historical learning insight</summary>
        ${renderLearningInsight(signal)}
      </details>
      ${renderCandidateHistory(signal)}
    </div>
  `;
}

function getDemoSignalStatus(signal) {
  const key = getSignalValidityState(signal).status;
  const labels = {
    active: "Active",
    "expiring-soon": "Expiring Soon",
    "hit-tp": "Hit TP",
    "hit-sl": "Hit SL",
    expired: "Expired",
    closed: "Closed",
    "manually-closed": "Closed"
  };
  return { label: labels[key] || "Active", className: `status-${key}`, key };
}

function renderSignalValidity(signal, { compact = false } = {}) {
  const status = getDemoSignalStatus(signal);
  const validity = getSignalValidityState(signal);
  const active = ["active", "expiring-soon"].includes(validity.status);
  const timer = active ? `Expires in: ${formatSignalCountdown(signal)}` : status.label;
  return `
    <section class="signal-validity ${compact ? "compact" : ""}" data-signal-validity data-valid-until="${escapeHtml(signal.validUntil || "")}" data-generated-at="${escapeHtml(signal.generatedAt || signal.createdAt || "")}" data-validity-duration-ms="${Number(signal.validityDurationMs || 0)}" data-signal-status="${escapeHtml(signal.status || "Active")}">
      <div>
        <span class="status-pill ${status.className}" data-validity-badge>${status.label}</span>
        <strong data-validity-countdown>${escapeHtml(timer)}</strong>
      </div>
      ${compact ? "" : `<small>Signal validity means the setup conditions were current when generated. Market conditions can change quickly.</small>`}
    </section>
  `;
}

function renderNoSetup(analysis) {
  state.avoidTrades = analysis?.avoidTrade ? [analysis.avoidTrade] : [];
  state.showAllAvoidTrades = false;
  renderAvoidTrades();
  const rejectionSummary = analysis?.rejectionSummary ||
    (analysis?.rejectionReasons?.length
      ? `No setup found because: ${analysis.rejectionReasons.slice(0, 3).join(", ")}.`
      : "");
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
      <p class="reasoning">${rejectionSummary || analysis?.message || "Conditions are too weak for a rule-based setup."}</p>
      ${renderRejectionReasons(analysis?.rejectionReasons)}
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

function renderScanSummary(opportunitiesFound, marketsScanned, timeframesScanned, errors = [], diagnostics = null, summary = null) {
  const counts = summary || { ready: opportunitiesFound, watching: 0, avoidTrade: 0, rejected: 0, expired: 0 };
  scanSummaryPanel.classList.remove("hidden");
  document.querySelector("#scan-summary-title").textContent = opportunitiesFound > 0
    ? "Scan complete"
    : counts.watching > 0 ? "No ready signals yet" : "No clean setups right now.";
  document.querySelector("#scan-summary-opportunities").textContent = `${counts.ready} ready · ${counts.watching} watching · ${counts.avoidTrade || 0} avoid`;
  document.querySelector("#scan-summary-markets").textContent = `${marketsScanned} market${marketsScanned === 1 ? "" : "s"} scanned`;
  document.querySelector("#scan-summary-timeframes").textContent = `${timeframesScanned} timeframes scanned`;
  document.querySelector("#scan-summary-ready").textContent = counts.ready;
  document.querySelector("#scan-summary-watching").textContent = counts.watching;
  document.querySelector("#scan-summary-avoid").textContent = counts.avoidTrade || 0;
  document.querySelector("#scan-summary-rejected").textContent = counts.rejected;
  document.querySelector("#scan-summary-expired").textContent = counts.expired;
  document.querySelector("#scan-summary-credits").textContent = opportunitiesFound > 0
    ? "No unlock credits used yet"
    : "No credits used";
  document.querySelector("#scan-summary-next").textContent = `Suggested next scan: ${formatSuggestedScanTime()}`;
  document.querySelector("#scan-summary-reason").textContent = opportunitiesFound > 0
    ? `Ready signals appear below. ${counts.watching ? `${counts.watching} additional setup${counts.watching === 1 ? " is" : "s are"} still being monitored.` : "No additional setups are being watched."}`
    : counts.watching > 0
      ? "Probable setups were found, but confirmation or entry readiness is still incomplete. No credits used."
      : "SignalForge scanned the market but did not find enough confirmation for a valid setup. No credits used.";
  document.querySelector("#scan-summary-diagnostics-content").innerHTML = `
    <p><strong>Most common avoid reason:</strong> ${escapeHtml(summary?.topAvoidReason || summary?.topRejectionReason || diagnostics?.topReasons?.[0]?.reason || "Strategy not matched")}</p>
    ${renderRejectionReasons((diagnostics?.topReasons || []).map((item) => `${item.reason} (${item.count})`))}
    ${renderDiagnosticSamples(diagnostics?.samples)}
    ${errors.length ? `<p>${errors.length} provider warning${errors.length === 1 ? "" : "s"} occurred during this scan.</p>` : ""}
  `;
}

function renderScanResults(setups, errors, diagnostics = null, scanSummary = null, avoidTrades = [], marketBrief = null) {
  state.scanResults = setups;
  if (marketBrief) state.marketBrief = marketBrief;
  renderMarketBrief();
  state.avoidTrades = avoidTrades || [];
  state.showAllAvoidTrades = false;
  renderAvoidTrades();
  document.querySelector("#signal-count").textContent = `${setups.length} scan results`;
  const activePairs = state.pairs
    .concat(state.marketCatalog)
    .filter((pair, index, pairs) => pairs.findIndex((item) => item.symbol === pair.symbol) === index)
    .filter((pair) => pair.category === "Crypto" ? pair.effectiveScannerEnabled : pair.status === "active");
  const frames = ["1h", "4h", "15m", "5m"];
  const scannedMarkets = activePairs.map((pair) => pair.symbol);
  state.lastScanSummary = {
    marketsScanned: scannedMarkets.length,
    timeframesScanned: frames.length,
    opportunitiesFound: setups.length,
    watchingSetups: scanSummary?.watching || 0,
    avoidTradeZones: scanSummary?.avoidTrade || 0,
    rejectedSetups: scanSummary?.rejected || 0,
    expiredSetups: scanSummary?.expired || 0,
    errors: errors.length
  };
  renderScanSummary(setups.length, scannedMarkets.length, frames.length, errors, diagnostics, scanSummary);

  if (setups.length === 0) {
    signalsGrid.innerHTML = `
      <article class="signal-card compact-signal-card expanded">
        <div class="signal-top">
          <div>
            <strong>No clean setups right now.</strong>
            <span>${scannedMarkets.slice(0, 12).join(" · ")}${scannedMarkets.length > 12 ? " · ..." : ""}</span>
          </div>
        </div>
        <p class="reasoning">SignalForge scanned the market but did not find enough confirmation for a valid setup. No credits used.</p>
        ${renderRejectionReasons((diagnostics?.topReasons || []).map((item) => `${item.reason} (${item.count})`))}
        <details class="scan-diagnostics"><summary>View scan diagnostics</summary>${renderDiagnosticSamples(diagnostics?.samples)}</details>
        <div class="signal-metrics">
          <div><span>Markets scanned</span><strong>${scannedMarkets.length}</strong></div>
          <div><span>Timeframes</span><strong>${frames.join(", ")}</strong></div>
          <div><span>Provider errors</span><strong>${errors.length}</strong></div>
          <div><span>Suggested next scan</span><strong>${formatSuggestedScanTime()}</strong></div>
        </div>
        <div class="compact-actions"><button type="button" data-scan-again>Scan again</button></div>
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

function renderRejectionReasons(reasons = []) {
  const uniqueReasons = [...new Set((reasons || []).filter(Boolean))].slice(0, 6);
  if (!uniqueReasons.length) return "";

  return `
    <div class="diagnostic-reasons">
      ${uniqueReasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
    </div>
  `;
}

function renderDiagnosticSamples(samples = []) {
  if (!samples?.length) return "";

  return `
    <div class="diagnostic-samples">
      ${samples.slice(0, 4).map((sample) => `
        <div>
          <strong>${escapeHtml(getDisplaySymbol(sample.symbol))} ${escapeHtml(sample.timeframe)}</strong>
          <span>${escapeHtml(sample.message)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderScanCard(setup) {
  const key = getSignalKey(setup);
  const expanded = state.expandedSignalKeys.has(key);
  const passed = (setup.confirmations || []).filter((item) => item.passed).map((item) => item.name).join(", ");

  return `
    <article class="signal-card compact-signal-card ${expanded ? "expanded" : ""}" data-signal-key="${key}">
      <div class="signal-top">
        <div>
          <strong>${getDisplaySymbol(setup.symbol)}</strong>
          <span>${setup.timeframe} · ${setup.marketType || getMarketType(setup.symbol)} · ${getProviderSymbolLabel(setup.symbol)}</span>
        </div>
        <strong class="direction ${setup.direction}">${setup.direction}</strong>
      </div>
      ${renderSignalValidity(setup)}
      <div class="signal-metrics">
        <div><span>Setup type</span><strong>${setup.setupType || "Qualified setup"}</strong></div>
        <div><span>Confidence ${renderConfidenceHelp()}</span><strong>${setup.confidenceScore}%</strong></div>
        <div><span>Risk/reward</span><strong>${setup.riskRewardRatio}:1</strong></div>
        ${state.scannerMode === "advanced" ? `
          <div><span>Validation</span><strong>${setup.validationPassed === false ? "Rejected" : "Passed"}</strong></div>
          <div><span>Validation score</span><strong>${Number(setup.validationScore || 100)}/100</strong></div>
        ` : ""}
      </div>
      ${renderLockedSignalQuality(setup)}
      <div class="compact-actions">
        <button data-unlock-symbol="${setup.symbol}" data-unlock-timeframe="${setup.timeframe}" data-unlock-setup-key="${escapeHtml(setup.setupKey || "")}" type="button" ${getSignalValidityState(setup).status === "expired" ? "disabled" : ""}>${getSignalValidityState(setup).status === "expired" ? "Expired" : "Unlock Signal"}</button>
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
          <strong>${getDisplaySymbol(signal.symbol)}</strong>
          <span>${signal.timeframe} · ${getMarketType(signal.symbol)} · ${getProviderSymbolLabel(signal.symbol)}</span>
        </div>
        <strong class="direction ${signal.direction}">${signal.direction}</strong>
      </div>
      ${renderSignalValidity(signal)}
      <div class="signal-metrics">
        <div><span>Setup type</span><strong>${signal.setupType || "Qualified setup"}</strong></div>
        <div><span>Entry</span><strong>${formatCurrency(signal.entryPrice)}</strong></div>
        <div><span>Stop loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div>
        <div><span>Take profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div>
        <div><span>Risk/reward</span><strong>${signal.riskRewardRatio}:1</strong></div>
        <div><span>Confidence ${renderConfidenceHelp()}</span><strong>${signal.confidenceScore}%</strong></div>
        ${state.scannerMode === "advanced" ? `
          <div><span>Validation</span><strong>${signal.validationPassed === false ? "Rejected" : "Passed"}</strong></div>
          <div><span>Validation score</span><strong>${Number(signal.validationScore || 100)}/100</strong></div>
        ` : ""}
      </div>
      ${renderRiskCalculator(signal)}
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
  if (state.scannerMode === "beginner") {
    return `
      <section class="basic-signal-details">
        ${locked ? "" : `<div class="signal-metrics">
          <div><span>Direction</span><strong class="direction ${signal.direction}">${String(signal.direction || "").toUpperCase()}</strong></div>
          <div><span>Entry</span><strong>${formatCurrency(signal.entryPrice)}</strong></div>
          <div><span>Stop loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div>
          <div><span>Take profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div>
          <div><span>Risk/reward</span><strong>${signal.riskRewardRatio}:1</strong></div>
          <div><span>Confidence ${renderConfidenceHelp()}</span><strong>${signal.confidenceScore}%</strong></div>
        </div>`}
        <section class="signal-transparency">
          <h4>${locked ? "Why this setup?" : "Why this setup?"}</h4>
          <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
          <div class="signal-disclaimer">
            <strong>Educational tool only. Not financial advice.</strong>
            <span>Confidence reflects rule alignment and setup quality. It is not a guarantee.</span>
          </div>
        </section>
        ${locked ? "" : renderRiskEngineCard(signal)}
      </section>
    `;
  }

  if (locked) {
    return `
      <section class="advanced-signal-details locked-advanced-preview">
        <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
        ${renderLockedSignalQuality(signal)}
        ${renderAdvancedPreviewChecks(signal)}
        <p class="locked-preview-note">Entry, stop loss, take profit, and full analysis remain hidden until unlock.</p>
      </section>
    `;
  }

  return `
    <section class="advanced-signal-details">
      <p class="reasoning">${escapeHtml(signal.reasoning || "Advanced signal context is based on rule alignment.")}</p>
      ${renderSignalTransparency(signal)}
      ${renderSignalQuality(signal)}
      ${renderPatternContext(signal.patternContext || signal.indicators?.patternContext)}
      ${renderSignalValidation(signal)}
      ${renderSignalConfluence(signal)}
      ${renderRiskEngineCard(signal)}
      ${renderCandidateHistory(signal)}
    </section>
  `;
}

function renderAdvancedPreviewChecks(signal) {
  const confirmations = normalizeConfirmations(signal.confirmations || [], signal.indicators || {});
  const passed = confirmations.filter((item) => item.passed).map((item) => item.name).slice(0, 5);
  return `<div class="advanced-preview-checks"><strong>Preview context</strong><span>${escapeHtml(passed.join(" · ") || "Validated rule alignment")}</span></div>`;
}

function renderCandidateHistory(signal) {
  const history = signal.candidateHistory || signal.indicators?.candidateHistory || [];
  const setupScore = signal.setupQualityScore ?? signal.indicators?.setupQualityScore;
  const readinessScore = signal.entryReadinessScore ?? signal.indicators?.entryReadinessScore;
  if (!history.length && setupScore == null && readinessScore == null) return "";
  return `
    <details class="unlocked-analysis-section">
      <summary>Candidate and watch history</summary>
      <div class="candidate-history-summary">
        ${setupScore == null ? "" : `<div><span>Setup quality</span><strong>${Number(setupScore)}%</strong></div>`}
        ${readinessScore == null ? "" : `<div><span>Entry readiness</span><strong>${Number(readinessScore)}%</strong></div>`}
      </div>
      ${history.length ? `<ol>${history.slice(0, 8).map((item) => `<li>${escapeHtml(item.message || item.status || item)}</li>`).join("")}</ol>` : `<p class="reasoning">This signal was promoted after its setup and entry checks became ready.</p>`}
    </details>`;
}

function renderSignalValidation(signal) {
  const rejected = signal.rejectedReasons || signal.indicators?.validationRejectedReasons || [];
  return `
    <section class="signal-validation-card">
      <div>
        <span>Validation ${signal.validationPassed === false ? "Rejected" : "Passed"}</span>
        <strong>${Number(signal.validationScore || signal.indicators?.validationScore || 100)}/100</strong>
      </div>
      ${rejected.length ? `
        <div class="diagnostic-reasons">
          ${rejected.map((item) => `<span>${escapeHtml(item.stage || "validation")}: ${escapeHtml(item.reason || item)}</span>`).join("")}
        </div>
      ` : `<p class="reasoning">Final validation passed before publication, unlock, history, and performance tracking.</p>`}
    </section>
  `;
}

function getRiskCalculatorDefaults() {
  const readPositive = (key, fallback) => {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    accountSize: readPositive(RISK_ACCOUNT_SIZE_KEY, 10000),
    riskPercent: readPositive(RISK_PERCENT_KEY, 1)
  };
}

function saveRiskCalculatorDefaults(accountSize, riskPercent) {
  try {
    if (Number.isFinite(accountSize) && accountSize > 0) {
      localStorage.setItem(RISK_ACCOUNT_SIZE_KEY, String(accountSize));
    }
    if (Number.isFinite(riskPercent) && riskPercent > 0) {
      localStorage.setItem(RISK_PERCENT_KEY, String(riskPercent));
    }
  } catch (error) {
    console.warn(`[risk-calculator] Could not save preferences: ${error.message}`);
  }
}

function formatCalculatorNumber(value, maximumFractionDigits = 4) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    useGrouping: false
  }).format(Number(value || 0));
}

function calculateSignalRisk(signal, values = {}) {
  const defaults = getRiskCalculatorDefaults();
  return calculateRiskPosition({
    direction: signal.direction,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    accountSize: values.accountSize ?? defaults.accountSize,
    riskPercent: values.riskPercent ?? defaults.riskPercent,
    customRiskAmount: values.customRiskAmount ?? ""
  });
}

function renderRiskCalculator(signal, { compact = false } = {}) {
  const defaults = getRiskCalculatorDefaults();
  const calculation = calculateSignalRisk(signal, defaults);
  const signalId = escapeHtml(String(signal.id || getSignalKey(signal)));
  const invalid = !calculation.valid;

  return `
    <section
      class="signal-risk-calculator ${compact ? "compact" : ""}"
      data-risk-calculator
      data-signal-id="${signalId}"
      data-direction="${escapeHtml(String(signal.direction || ""))}"
      data-entry="${Number(signal.entryPrice)}"
      data-stop="${Number(signal.stopLoss)}"
      data-target="${Number(signal.takeProfit)}"
    >
      <div class="risk-calculator-heading">
        <div><span class="eyebrow">Position sizing</span><h4>Risk Calculator</h4></div>
        <span>Estimate only</span>
      </div>
      <div class="risk-calculator-inputs">
        <label>Account size
          <span class="currency-input"><span>$</span><input class="sf-input" data-calculator-account type="number" min="0.01" step="any" inputmode="decimal" value="${defaults.accountSize}" /></span>
        </label>
        <label>Risk per trade %
          <input class="sf-input" data-calculator-percent type="number" min="0.01" step="0.1" inputmode="decimal" value="${defaults.riskPercent}" />
        </label>
        <label>Custom risk amount <small>Optional</small>
          <span class="currency-input"><span>$</span><input class="sf-input" data-calculator-custom type="number" min="0.01" step="any" inputmode="decimal" placeholder="Use percentage" /></span>
        </label>
      </div>
      <div class="risk-quick-buttons" aria-label="Quick risk percentages">
        ${[0.5, 1, 2].map((percent) => `<button type="button" data-risk-quick="${percent}">${percent}%</button>`).join("")}
        <button type="button" data-risk-custom-focus>Custom</button>
      </div>
      <p class="risk-calculator-warning ${defaults.riskPercent > 3 ? "" : "hidden"}" data-calculator-warning>High risk per trade. Many traders risk 1–2% or less per setup.</p>
      <p class="risk-calculator-error ${invalid ? "" : "hidden"}" data-calculator-error>${escapeHtml(invalid ? `Risk calculator unavailable because signal levels are invalid. ${calculation.reason || ""}` : "")}</p>
      <div class="risk-calculator-results ${invalid ? "hidden" : ""}" data-calculator-results>
        <div><span>Risk amount</span><strong data-calculator-risk>${invalid ? "--" : formatCurrency(calculation.riskAmount)}</strong></div>
        <div><span>Estimated position size</span><strong data-calculator-size>${invalid ? "--" : formatCurrency(calculation.positionSize)}</strong></div>
        <div><span>Quantity</span><strong data-calculator-quantity>${invalid ? "--" : formatCalculatorNumber(calculation.quantity, 8)}</strong></div>
        <div><span>Potential loss</span><strong class="negative" data-calculator-loss>${invalid ? "--" : formatCurrency(calculation.potentialLoss)}</strong></div>
        <div><span>Potential profit</span><strong class="positive" data-calculator-profit>${invalid ? "--" : formatCurrency(calculation.potentialProfit)}</strong></div>
        <div><span>Risk / reward</span><strong data-calculator-rr>${invalid ? "--" : `${calculation.riskReward.toFixed(2)}R`}</strong></div>
        <div><span>Distance to stop</span><strong data-calculator-stop-distance>${invalid ? "--" : `${formatCurrency(calculation.stopDistance)} · ${calculation.stopDistancePercent.toFixed(2)}%`}</strong></div>
        <div><span>Distance to target</span><strong data-calculator-target-distance>${invalid ? "--" : `${formatCurrency(calculation.targetDistance)} · ${calculation.targetDistancePercent.toFixed(2)}%`}</strong></div>
      </div>
      <p class="risk-calculator-note">Position sizing is a risk management estimate. SignalForge is an educational tool and does not provide financial advice.</p>
    </section>
  `;
}

function updateRiskCalculator(calculator, { persist = false } = {}) {
  if (!calculator) return;
  const accountSize = Number(calculator.querySelector("[data-calculator-account]")?.value);
  const riskPercent = Number(calculator.querySelector("[data-calculator-percent]")?.value);
  const customRiskAmount = calculator.querySelector("[data-calculator-custom]")?.value ?? "";
  const calculation = calculateRiskPosition({
    direction: calculator.dataset.direction,
    entryPrice: calculator.dataset.entry,
    stopLoss: calculator.dataset.stop,
    takeProfit: calculator.dataset.target,
    accountSize,
    riskPercent,
    customRiskAmount
  });
  if (persist) saveRiskCalculatorDefaults(accountSize, riskPercent);

  const error = calculator.querySelector("[data-calculator-error]");
  const results = calculator.querySelector("[data-calculator-results]");
  const warning = calculator.querySelector("[data-calculator-warning]");
  warning?.classList.toggle("hidden", !(calculation.valid && calculation.riskPercent > 3));
  error?.classList.toggle("hidden", calculation.valid);
  results?.classList.toggle("hidden", !calculation.valid);
  if (!calculation.valid) {
    if (error) error.textContent = `Risk calculator unavailable. ${calculation.reason || "Check the entered values."}`;
    state.riskCalculations.delete(calculator.dataset.signalId);
    return;
  }

  state.riskCalculations.set(calculator.dataset.signalId, calculation);
  const set = (selector, value) => {
    const node = calculator.querySelector(selector);
    if (node) node.textContent = value;
  };
  set("[data-calculator-risk]", formatCurrency(calculation.riskAmount));
  set("[data-calculator-size]", formatCurrency(calculation.positionSize));
  set("[data-calculator-quantity]", formatCalculatorNumber(calculation.quantity, 8));
  set("[data-calculator-loss]", formatCurrency(calculation.potentialLoss));
  set("[data-calculator-profit]", formatCurrency(calculation.potentialProfit));
  set("[data-calculator-rr]", `${calculation.riskReward.toFixed(2)}R`);
  set("[data-calculator-stop-distance]", `${formatCurrency(calculation.stopDistance)} · ${calculation.stopDistancePercent.toFixed(2)}%`);
  set("[data-calculator-target-distance]", `${formatCurrency(calculation.targetDistance)} · ${calculation.targetDistancePercent.toFixed(2)}%`);
}

function getSignalRiskCalculation(signal) {
  return state.riskCalculations.get(String(signal.id || getSignalKey(signal))) || calculateSignalRisk(signal);
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
    : quality >= 70
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

function renderPaperTradeAction(signal, primary = false) {
  const existingTrade = state.paperTrading.orders.find((order) => order.savedSignalId === signal.id) ||
    state.paperPortfolio.trades.find((trade) => trade.signalId === signal.id);
  const className = primary ? "paper-trade-action primary-paper-action" : "secondary-action paper-trade-action";

  if (existingTrade) {
    return `<button class="${className}" type="button" disabled>Already added to Paper Trading</button>`;
  }

  const validity = getSignalValidityState(signal);
  if (validity.status === "expired") {
    return `
      <div class="expired-paper-action">
        <button class="${className}" type="button" disabled>Expired · Historical only</button>
        <small>This signal is expired. You can view it for learning, but it should not be treated as a current setup.</small>
      </div>
    `;
  }

  if (signal.status !== "Active") {
    return `<button class="${className}" type="button" disabled>Signal ${signal.status}</button>`;
  }

  return `
    ${validity.status === "expiring-soon" ? `<p class="signal-expiry-warning">This signal is close to expiring. Price conditions may have changed.</p>` : ""}
    <button class="${className}" data-paper-signal-id="${signal.id}" type="button">Add to Paper Trading</button>
  `;
}

function renderConfidenceSummary(signal) {
  const confirmations = normalizeConfirmations(signal.confirmations || [], signal.indicators || {});
  const passed = confirmations.filter((item) => item.passed).length;
  return `
    <section class="unlocked-confidence-summary">
      <span>Confidence summary ${renderConfidenceHelp()}</span>
      <strong>${getConfidenceBand(signal.confidenceScore)} · ${Number(signal.confidenceScore || 0)}%</strong>
      <small>${passed}/${confirmations.length} confirmations passed. Confidence measures rule alignment, not probability of profit.</small>
    </section>
  `;
}

function renderConfidenceHelp() {
  return `
    <span class="confidence-help" tabindex="0" aria-label="About SignalForge confidence">
      <span aria-hidden="true">i</span>
      <span class="confidence-tooltip" role="tooltip">
        Confidence reflects rule alignment and setup quality. It is not a win probability.
        <button type="button" data-how-it-works-link>Learn more</button>
      </span>
    </span>`;
}

function renderLockedSignalQuality(signal) {
  const quality = signal.signalQuality || {};
  const overall = normalizeQualityStatus(quality.overall || qualityStatusFromScore(signal.qualityScore));
  return `
    <section class="signal-quality-summary" data-locked-quality-summary>
      <div><span>Signal quality</span><strong class="quality-chip ${overall}">${qualityLabel(overall)}</strong></div>
      <p>${escapeHtml(quality.mainReason || "Core confirmations and risk rules passed validation.")}</p>
    </section>
  `;
}

function renderSignalQuality(signal, { compact = false } = {}) {
  const quality = getSignalQualityData(signal);
  const categories = Object.values(quality.categories || {});
  const content = `
    <div class="signal-quality-heading">
      <div><span class="eyebrow">Rule transparency</span><h4>Signal Quality</h4></div>
      <span class="quality-chip ${normalizeQualityStatus(quality.overall)}">${qualityLabel(quality.overall)}</span>
    </div>
    <p class="confidence-explanation">${escapeHtml(quality.confidenceExplanation)}</p>
    <div class="signal-quality-rows">
      ${categories.map((item) => `
        <div class="signal-quality-row">
          <div><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.reason || "Not enough data")}</p></div>
          <span class="quality-chip ${normalizeQualityStatus(item.status)}">${qualityLabel(item.status)}</span>
        </div>
      `).join("")}
    </div>
    <div class="signal-quality-explanation">
      <section><strong>Why confidence is high</strong>${renderQualityReasonList(quality.strengths, "No strong category explanation is available yet.")}</section>
      <section><strong>Risk factors</strong>${renderQualityReasonList(quality.risks, "No material weak category was recorded.")}</section>
    </div>
  `;
  return compact
    ? `<details class="signal-quality-card compact"><summary>Signal Quality · ${qualityLabel(quality.overall)}</summary>${content}</details>`
    : `<section class="signal-quality-card">${content}</section>`;
}

function renderQualityReasonList(items = [], emptyText) {
  return items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(emptyText)}</p>`;
}

function getSignalQualityData(signal) {
  const stored = signal.signalQuality || signal.indicators?.signalQuality;
  if (stored?.categories) return stored;
  const definitions = [
    ["trendAlignment", "Trend alignment", ["trend", "ema structure"]],
    ["momentum", "Momentum", ["rsi", "momentum"]],
    ["volumeConfirmation", "Volume confirmation", ["volume"]],
    ["entryTiming", "Entry timing", []],
    ["riskReward", "Risk/reward", []],
    ["marketStructure", "Market structure", ["structure"]],
    ["patternContext", "Pattern context", []],
    ["supportResistance", "Support/resistance context", ["support", "resistance"]],
    ["volatilityAtr", "Volatility / ATR", ["atr", "volatility"]],
    ["higherTimeframe", "Higher timeframe alignment", []],
    ["learningHistory", "Learning history", []]
  ];
  const confirmations = signal.confirmations || [];
  const categories = Object.fromEntries(definitions.map(([key, label, names]) => {
    const confirmation = confirmations.find((item) => names.some((name) => String(item.name || "").toLowerCase().includes(name)));
    let category = confirmation
      ? { status: confirmation.passed ? "good" : "failed", reason: confirmation.detail || (confirmation.passed ? `${label} passed.` : `${label} failed.`) }
      : { status: "missing", reason: "Not enough data" };
    if (key === "entryTiming" && signal.indicators?.entryQuality) {
      const entry = String(signal.indicators.entryQuality).toLowerCase();
      category = { status: entry === "excellent" ? "strong" : normalizeQualityStatus(entry), reason: `Entry timing was classified as ${entry}.` };
    }
    if (key === "riskReward" && Number.isFinite(Number(signal.riskRewardRatio))) {
      const rr = Number(signal.riskRewardRatio);
      category = { status: rr >= 2.5 ? "strong" : rr >= 2 ? "good" : rr >= 1.5 ? "fair" : "failed", reason: `${rr.toFixed(2)}R was evaluated against the minimum risk/reward rule.` };
    }
    if (key === "higherTimeframe" && Number(signal.confluenceScore || signal.indicators?.confluenceScore)) {
      category = { status: qualityStatusFromScore(signal.confluenceScore || signal.indicators.confluenceScore), reason: signal.alignmentBadge === "Full Alignment" ? "Higher timeframes are aligned." : "Higher timeframe alignment is partial." };
    }
    if (key === "learningHistory") {
      const samples = Number(signal.learningInsight?.sampleSize || signal.indicators?.learningSampleSize || 0);
      category = samples ? { status: samples >= 20 ? "good" : "fair", reason: `${samples} comparable closed signals informed calibration.` } : { status: "limited", reason: "Not enough closed signals yet for strong learning confidence." };
    }
    if (key === "patternContext") {
      const pattern = signal.patternContext || signal.indicators?.patternContext;
      category = pattern?.pattern
        ? { status: normalizeQualityStatus(pattern.strength), reason: `${pattern.label} provides ${pattern.bias} context in shadow mode; it did not create the signal.` }
        : { status: "missing", reason: "No named chart pattern was detected. Other validated setup logic may still apply." };
    }
    return [key, { key, label, ...category }];
  }));
  const list = Object.values(categories);
  return {
    overall: qualityStatusFromScore(signal.qualityScore || signal.confidenceScore),
    categories,
    strengths: list.filter((item) => ["strong", "good"].includes(item.status)).map((item) => item.reason).slice(0, 4),
    risks: list.filter((item) => ["fair", "weak", "missing", "failed", "limited"].includes(item.status)).map((item) => item.reason).slice(0, 4),
    confidenceExplanation: "Confidence reflects rule alignment and setup quality. It is not a guarantee or probability of profit."
  };
}

function renderPatternContext(pattern, { diagnostic = false } = {}) {
  if (!pattern?.pattern) return "";
  const reasons = Array.isArray(pattern.reasons) ? pattern.reasons : [];
  const warnings = Array.isArray(pattern.warnings) ? pattern.warnings : [];
  return `<section class="pattern-context-card">
    <div class="pattern-context-heading"><div><span class="eyebrow">Pattern context</span><strong>${escapeHtml(pattern.label)}</strong></div><span class="quality-chip ${normalizeQualityStatus(pattern.strength)}">${escapeHtml(titleCase(pattern.strength))}</span></div>
    <p>${escapeHtml(titleCase(pattern.bias))} ${escapeHtml(pattern.category)} context detected. Confirmation still comes from trend, volume, entry readiness, risk/reward, and final validation.</p>
    ${diagnostic && reasons.length ? `<ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
    ${diagnostic && warnings.length ? `<div class="pattern-warning"><strong>Still needed</strong><span>${escapeHtml(warnings.join(" "))}</span></div>` : ""}
    <small>Pattern recognition supports setup analysis, but it does not guarantee direction or outcome.</small>
  </section>`;
}

function qualityStatusFromScore(value) {
  const score = Number(value || 0);
  if (score >= 88) return "strong";
  if (score >= 75) return "good";
  if (score >= 60) return "fair";
  if (score > 0) return "weak";
  return "missing";
}

function normalizeQualityStatus(value) {
  const status = String(value || "missing").toLowerCase();
  return ["strong", "good", "fair", "weak", "missing", "failed", "limited"].includes(status) ? status : "missing";
}

function qualityLabel(value) {
  const status = normalizeQualityStatus(value);
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderUnlockedSignalDetails(signal) {
  const confirmations = normalizeConfirmations(signal.confirmations || [], signal.indicators || {});
  if (state.scannerMode === "beginner") {
    return `
      <div class="unlocked-signal-details beginner">
        ${renderRiskCalculator(signal)}
        ${renderPaperTradeAction(signal)}
        ${renderConfidenceSummary(signal)}
        <section class="unlocked-analysis-section">
          <h4>Why this setup?</h4>
          <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
        </section>
        <button class="secondary-action view-advanced-details" type="button" data-signal-view-mode="advanced">View advanced details</button>
        <div class="signal-disclaimer">
          <strong>Educational analysis only. Not financial advice.</strong>
          <span>Confidence reflects rule alignment and setup quality. It is not a guarantee. <button class="inline-trust-link" type="button" data-how-it-works-link>Learn how signals work</button></span>
        </div>
      </div>`;
  }
  return `
    <div class="unlocked-signal-details">
      ${renderRiskCalculator(signal)}
      ${renderPaperTradeAction(signal)}
      ${renderConfidenceSummary(signal)}
      ${renderSignalQuality(signal)}
      <section class="unlocked-analysis-section">
        <h4>Why this signal?</h4>
        <p class="reasoning">${escapeHtml(getShortSignalReason(signal))}</p>
      </section>
      <details class="unlocked-analysis-section">
        <summary>AI analyst explanation</summary>
        ${renderAiAnalyst(signal)}
      </details>
      <details class="unlocked-analysis-section">
        <summary>Full analysis context</summary>
        <p class="reasoning long-analysis">${escapeHtml(signal.reasoning || "Advanced signal context is based on rule alignment.")}</p>
        ${renderSignalConfluence(signal)}
        ${renderSmcExplanation(signal)}
        ${renderAdvancedStructureExplanation(signal)}
        ${renderRiskEngineCard(signal)}
      </details>
      <details class="unlocked-analysis-section">
        <summary>Checklist and validation details</summary>
        ${renderSignalValidation(signal)}
        <div class="confirmation-list">
          ${confirmations.map((item) => `
            <div class="confirmation-item ${item.passed ? "passed" : "failed"}">
              <strong>${item.passed ? "Passed" : "Failed"} · ${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.detail)}</span>
            </div>
          `).join("")}
        </div>
      </details>
      <details class="unlocked-analysis-section">
        <summary>Historical learning insight</summary>
        ${renderLearningInsight(signal)}
      </details>
      ${renderCandidateHistory(signal)}
      <div class="signal-disclaimer">
        <strong>Educational tool only. Not financial advice.</strong>
        <span>Review the market and your own risk limits before making any decision. <button class="inline-trust-link" type="button" data-how-it-works-link>Learn how signals work</button></span>
      </div>
    </div>
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
      ${renderLearningInsight(signal)}
      <p class="risk-guidance"><strong>Risk per trade:</strong> Define a consistent maximum loss before entering, size the position from the stop distance, and avoid risking capital you cannot afford to lose.</p>
      <div class="signal-disclaimer">
        <strong>Educational tool only. Not financial advice.</strong>
        <span>Review the market and your own risk limits before making any decision.</span>
      </div>
    </section>
  `;
}

function renderLearningInsight(signal) {
  const insight = signal.learningInsight || {
    mode: signal.indicators?.learningMode || "neutral",
    message: signal.indicators?.learningInsight ||
      "This market/timeframe has limited completed-signal history, so learning adjustment is neutral.",
    adjustment: Number(signal.indicators?.learningAdjustment || 0),
    sampleSize: Number(signal.indicators?.learningSampleSize || 0)
  };

  return `
    <section class="advanced-explanation learning-insight ${escapeHtml(insight.mode || "neutral")}">
      <div class="smc-heading">
        <span>Historical learning insight</span>
        <strong>${Number(insight.adjustment || 0) > 0 ? "+" : ""}${Number(insight.adjustment || 0)} confidence</strong>
      </div>
      <p class="reasoning">${escapeHtml(insight.message)}</p>
      <span class="muted">${formatInteger(insight.sampleSize || 0)} similar completed signal${Number(insight.sampleSize || 0) === 1 ? "" : "s"} considered. Educational context only.</span>
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
        <div><span>Confidence ${renderConfidenceHelp()}</span><strong>${alert.confidenceScore}%</strong></div>
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
  telegramScope.disabled = !connected;
  telegramTestButton.classList.toggle("hidden", !connected);

  if (!settings) {
    telegramEnabled.checked = false;
    if (!configured) {
      setTelegramConnectionFeedback("Telegram bot not configured", "error");
    }
    renderOnboarding();
    return;
  }

  telegramChatId.value = settings.chatId;
  telegramEnabled.checked = settings.enabled;
  telegramScope.value = settings.favoriteMarketsOnly ? "watchlist" : "all_crypto";
  telegramDirection.value = settings.direction;
  telegramMinimumConfidence.value = settings.minimumConfidence;

  document.querySelectorAll('input[name="telegram-timeframe"]').forEach((input) => {
    input.checked = settings.timeframes.includes(input.value);
  });

  setTelegramConnectionFeedback("Connected successfully", "success");
  renderOnboarding();
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
    `${formatInteger(analytics.totalUsers)} users · ${formatCents(analytics.monthlyRecurringRevenueCents)} MRR · ${formatInteger(analytics.unlocks)} unlocks`;
  renderMetricRows("#analytics-signups", [
    ["Total signups", analytics.signups],
    ["Email signups", analytics.emailSignups],
    ["Google signups", analytics.googleSignups],
    ["Checkout completed", analytics.checkoutCompleted]
  ]);
  renderMetricRows("#analytics-usage", [
    ["Scans", analytics.scans],
    ["Unlocks", analytics.unlocks],
    ["Subscriptions", analytics.subscriptions],
    ["Affiliate conversions", analytics.affiliateConversions]
  ]);
  renderMarketMetricRows("#analytics-most-scanned", analytics.mostScannedMarkets);
  renderMarketMetricRows("#analytics-most-unlocked", analytics.mostUnlockedMarkets);
  renderAdminOperationsDashboard();
  renderValidationDashboard();
}

function renderAdminOperationsDashboard() {
  const dashboard = state.adminDashboard || {};
  const overview = dashboard.overview || {};
  renderAdminHealth(dashboard.health || []);
  renderMetricRows("#admin-overview-users", [
    ["Total users", overview.users?.totalUsers],
    ["Active today", overview.users?.activeToday],
    ["Active this week", overview.users?.activeThisWeek],
    ["New users today", overview.users?.newUsersToday],
    ["New Pro", overview.users?.newPro],
    ["New Elite", overview.users?.newElite]
  ]);
  renderMetricRows("#admin-overview-revenue", [
    ["Monthly recurring revenue", formatCents(overview.revenue?.monthlyRecurringRevenueCents)],
    ["Revenue today", formatCents(overview.revenue?.revenueTodayCents)],
    ["Revenue this month", formatCents(overview.revenue?.revenueThisMonthCents)],
    ["Failed payments", overview.revenue?.failedPayments],
    ["Renewals today", overview.revenue?.renewalsToday]
  ], { rawValues: true });
  renderMetricRows("#admin-overview-signals", [
    ["Generated today", overview.signals?.generatedToday],
    ["Validated today", overview.signals?.validatedToday],
    ["Rejected today", overview.signals?.rejectedToday],
    ["Telegram alerts sent", overview.signals?.telegramAlertsSentToday],
    ["Unlocks today", overview.signals?.unlocksToday],
    ["Average confidence", `${Number(overview.signals?.averageConfidence || 0).toFixed(1)}%`],
    ["Average R:R", `${Number(overview.signals?.averageRiskReward || 0).toFixed(2)}R`]
  ], { rawValues: true });
  renderMetricRows("#admin-overview-system", [
    ["Server uptime", formatDuration(overview.system?.serverUptimeSeconds)],
    ["Database status", titleCase(overview.system?.databaseStatus || "unknown")],
    ["Coinbase status", titleCase(overview.system?.coinbaseStatus || "unknown")],
    ["Commodity provider", titleCase(overview.system?.commodityProviderStatus || "unknown")],
    ["Telegram bot", titleCase(overview.system?.telegramBotStatus || "unknown")],
    ["Stripe", titleCase(overview.system?.stripeStatus || "unknown")]
  ], { rawValues: true });

  renderAdminSignalMonitor();
  renderAdminRejectionAnalytics();
  renderAdminStrategyAnalytics();
  renderAdminMarketAnalytics();
  renderAdminTelegram();
  renderAdminAffiliates();
  renderAdminStripe();
  renderAdminErrorLogs();
  renderAdminUserSearchResults();
  renderLearningDashboard();
}

function renderAdminHealth(health = []) {
  const container = document.querySelector("#admin-health-grid");
  if (!container) return;
  container.innerHTML = health.length
    ? health.map((item) => `
      <article class="admin-health-card ${item.status === "green" ? "healthy" : "unhealthy"}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${item.status === "green" ? "Green" : "Red"}</strong>
        <small>${escapeHtml(item.detail || "")}</small>
      </article>
    `).join("")
    : `<div class="empty-state"><span>No health data yet.</span></div>`;
}

function renderAdminSignalMonitor() {
  const container = document.querySelector("#admin-signal-monitor");
  if (!container) return;
  const query = (document.querySelector("#admin-signal-search")?.value || "").trim().toLowerCase();
  const rows = (state.adminDashboard?.signalMonitor || []).filter((signal) => {
    if (!query) return true;
    return [
      signal.market,
      signal.timeframe,
      signal.direction,
      signal.strategy,
      signal.status,
      signal.rejectedReason
    ].join(" ").toLowerCase().includes(query);
  });

  container.innerHTML = rows.length
    ? `
      <div class="admin-table">
        <div class="admin-table-row admin-table-head">
          <span>Market</span><span>Strategy</span><span>Confidence</span><span>RR</span><span>Validation</span><span>Status</span><span>Reason</span>
        </div>
        ${rows.map((signal) => `
          <div class="admin-table-row">
            <span><strong>${escapeHtml(signal.market || "--")}</strong><small>${escapeHtml(signal.timeframe || "--")} · ${escapeHtml(signal.direction || "--")}</small></span>
            <span>${escapeHtml(signal.strategy || "Unknown")}</span>
            <span>${Number(signal.confidence || 0).toFixed(0)}%</span>
            <span>${Number(signal.riskReward || 0).toFixed(2)}R</span>
            <span>${Number(signal.validationScore || 0).toFixed(0)}</span>
            <span><em class="status-pill ${signal.validationPassed ? "status-hit-tp" : "status-hit-sl"}">${escapeHtml(signal.status || "Unknown")}</em></span>
            <span>${escapeHtml(signal.rejectedReason || "None")}${renderAdminSignalQualityDebug(signal.signalQualityDebug)}</span>
          </div>
        `).join("")}
      </div>
    `
    : `<div class="empty-state"><span>No signal monitor rows match.</span></div>`;
}

function renderAdminRejectionAnalytics() {
  const rows = state.adminDashboard?.rejectionAnalytics || [];
  renderAdminBarList("#admin-rejection-pie", rows, (item) => item.reason, (item) => item.count);
}

function renderAdminSignalQualityDebug(debug) {
  if (!debug?.categories?.length) return "";
  return `
    <details class="admin-signal-quality-debug">
      <summary>Raw quality scores</summary>
      <div>
        ${debug.categories.map((item) => `
          <p><strong>${escapeHtml(item.label)}</strong><span>${item.score === null ? "n/a" : Number(item.score)} · ${escapeHtml(item.status)} · ${item.confidenceImpact === null ? "impact n/a" : `${Number(item.confidenceImpact) >= 0 ? "+" : ""}${Number(item.confidenceImpact)} confidence`}</span><small>${escapeHtml(item.ruleSource || "unknown rule")} · ${escapeHtml(item.reason || "No reason recorded")}</small></p>
        `).join("")}
        ${debug.penaltiesApplied?.length ? `<p><strong>Penalties</strong><small>${debug.penaltiesApplied.map((item) => `${escapeHtml(item.category)} ${Number(item.points)}: ${escapeHtml(item.reason)}`).join(" · ")}</small></p>` : ""}
        ${debug.confidenceCapsApplied?.length ? `<p><strong>Confidence caps</strong><small>${debug.confidenceCapsApplied.map((item) => `${Number(item.cap)}: ${escapeHtml(item.reason)}`).join(" · ")}</small></p>` : ""}
      </div>
    </details>
  `;
}

function renderAdminStrategyAnalytics() {
  const rows = state.adminDashboard?.strategyAnalytics || [];
  renderAdminCompactTable("#admin-strategy-analytics", ["Strategy", "Generated", "Passed", "Rejected", "Conf", "RR", "Win"], rows, (item) => [
    item.strategy,
    formatInteger(item.generated),
    formatInteger(item.passed),
    formatInteger(item.rejected),
    `${Number(item.averageConfidence || 0).toFixed(1)}%`,
    `${Number(item.averageRiskReward || 0).toFixed(2)}R`,
    `${Number(item.winRate || 0).toFixed(1)}%`
  ]);
}

function renderAdminMarketAnalytics() {
  const rows = state.adminDashboard?.marketAnalytics || [];
  renderAdminCompactTable("#admin-market-analytics", ["Market", "Signals", "Win", "RR", "Conf"], rows, (item) => [
    item.market,
    formatInteger(item.signals),
    `${Number(item.winRate || 0).toFixed(1)}%`,
    `${Number(item.averageRiskReward || 0).toFixed(2)}R`,
    `${Number(item.averageConfidence || 0).toFixed(1)}%`
  ]);
}

function renderAdminTelegram() {
  const telegram = state.adminDashboard?.telegram || {};
  renderMetricRows("#admin-telegram-metrics", [
    ["Messages sent", telegram.messagesSent],
    ["Failed sends", telegram.failedSends],
    ["Pending queue", telegram.pendingQueue],
    ["Avg delivery", `${Number(telegram.averageDeliverySeconds || 0).toFixed(1)}s`],
    ["Retry count", telegram.retryCount]
  ], { rawValues: true });
  renderAdminRows("#admin-telegram-failures", telegram.latestFailures || [], (item) => `
    <div><strong>${escapeHtml(item.setupKey || item.id)}</strong><span>${escapeHtml(item.error || "No error")} · attempts ${formatInteger(item.attempts)}</span></div>
  `);
}

function renderAdminAffiliates() {
  const affiliates = state.adminDashboard?.affiliates || {};
  renderMetricRows("#admin-affiliate-metrics", [
    ["Active referrals", affiliates.activeReferrals],
    ["Monthly commissions", formatCents(affiliates.monthlyCommissionsCents)],
    ["Pending payouts", formatCents(affiliates.pendingPayoutsCents)],
    ["Paid payouts", formatCents(affiliates.paidPayoutsCents)],
    ["Conversion rate", `${Number(affiliates.conversionRate || 0).toFixed(1)}%`]
  ], { rawValues: true });
  renderAdminRows("#admin-top-affiliates", affiliates.topAffiliates || [], (item) => `
    <div><strong>${escapeHtml(item.username || item.email || item.userId)}</strong><span>${formatInteger(item.activeReferrals)} active · ${formatCents(item.lifetimeEarningsCents)} lifetime</span></div>
  `);
}

function renderAdminStripe() {
  const stripe = state.adminDashboard?.stripe || {};
  renderMetricRows("#admin-stripe-metrics", [
    ["Latest subscriptions", stripe.activeSubscriptions],
    ["Renewals", stripe.renewals],
    ["Failed renewals", stripe.failedRenewals],
    ["Refunds", stripe.refunds],
    ["Webhook failures", stripe.webhookFailures]
  ]);
  renderAdminRows("#admin-stripe-latest", stripe.latestSubscriptions || [], (item) => `
    <div><strong>${escapeHtml(item.username || item.email || item.userId)}</strong><span>${escapeHtml(String(item.plan || "free").toUpperCase())} · ${escapeHtml(item.status || "unknown")} · ${formatDateTime(item.updatedAt)}</span></div>
  `);
}

function renderAdminErrorLogs() {
  const container = document.querySelector("#admin-error-logs");
  if (!container) return;
  const filter = document.querySelector("#admin-error-filter")?.value || "all";
  const rows = (state.adminDashboard?.errorLogs || []).filter((item) => filter === "all" || item.area === filter);
  renderAdminRows("#admin-error-logs", rows, (item) => `
    <div><strong>${escapeHtml(item.area)} · ${escapeHtml(item.id || "event")}</strong><span>${escapeHtml(item.message || "No message")} · ${formatDateTime(item.createdAt)}</span></div>
  `);
}

function renderAdminUserSearchResults() {
  const container = document.querySelector("#admin-user-search-results");
  if (!container) return;
  const rows = state.adminUserSearchResults || [];
  container.innerHTML = rows.length
    ? rows.map((user) => `
      <article class="admin-user-result">
        <div>
          <strong>${escapeHtml(user.username || user.name || user.id)}</strong>
          <span>${escapeHtml(user.email)} · ${escapeHtml(user.id)}</span>
        </div>
        <div class="admin-user-result-grid">
          <span>Plan <strong>${escapeHtml(String(user.plan || "free").toUpperCase())}</strong></span>
          <span>Subscription <strong>${escapeHtml(user.subscription?.status || "none")}</strong></span>
          <span>Unlock credits <strong>${formatInteger(user.credits?.unlockCreditsBalance)}</strong></span>
          <span>Signals <strong>${formatInteger(user.signals?.unlocked)}</strong></span>
          <span>Affiliate <strong>${formatInteger(user.affiliate?.activeReferrals)} active</strong></span>
          <span>Telegram <strong>${user.telegram?.connected ? "Connected" : "Not connected"}</strong></span>
          <span>Profile <strong>${user.profile?.publicProfileEnabled ? "Public" : "Private"}</strong></span>
          <span>Abuse score <strong>${formatInteger(user.profile?.abuseScore)}</strong></span>
        </div>
      </article>
    `).join("")
    : `<div class="empty-state"><span>Search by username, email, or user ID.</span></div>`;
}

function renderAdminBarList(selector, rows = [], labelGetter, valueGetter) {
  const container = document.querySelector(selector);
  if (!container) return;
  const max = Math.max(...rows.map((item) => Number(valueGetter(item) || 0)), 1);
  container.innerHTML = rows.length
    ? rows.map((item) => {
      const value = Number(valueGetter(item) || 0);
      return `
        <div class="admin-bar-row">
          <div><span>${escapeHtml(labelGetter(item))}</span><strong>${formatInteger(value)}</strong></div>
          <span class="admin-bar-track"><i style="width:${Math.max(5, (value / max) * 100)}%"></i></span>
        </div>
      `;
    }).join("")
    : `<div class="empty-state"><span>No rejection data yet.</span></div>`;
}

function renderAdminCompactTable(selector, columns, rows = [], rowFormatter) {
  const container = document.querySelector(selector);
  if (!container) return;
  container.innerHTML = rows.length
    ? `
      <div class="admin-compact-table">
        <div class="admin-compact-row admin-table-head">${columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}</div>
        ${rows.map((row) => `<div class="admin-compact-row">${rowFormatter(row).map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>`).join("")}
      </div>
    `
    : `<div class="empty-state"><span>No analytics yet.</span></div>`;
}

function renderValidationDashboard() {
  const validation = state.validationDashboard || {};
  setText("#validation-pass-rate", `${Number(validation.validationPassRate || 0).toFixed(1)}% pass rate`);
  setText("#validation-generated", formatInteger(validation.signalsGenerated));
  setText("#validation-rejected", formatInteger(validation.signalsRejected));
  setText("#validation-average-confidence", `${Number(validation.averageConfidence || 0).toFixed(1)}%`);
  setText("#validation-average-rr", `${Number(validation.averageRiskReward || 0).toFixed(2)}R`);
  renderValidationRows("#validation-top-reasons", validation.topRejectionReasons, (item) => [
    `${item.stage || "validation"} · ${item.reason || "Unknown reason"}`,
    item.count
  ]);
  renderValidationRows("#validation-top-strategies", validation.strategiesPassingMost, (item) => [
    item.strategy || "Unknown strategy",
    item.count
  ]);
  renderValidationRows("#validation-top-markets", validation.marketsPassingMost, (item) => [
    item.symbol || "Unknown market",
    item.count
  ]);
}

function renderLearningDashboard() {
  const learning = state.learningDashboard || {};
  renderAdminCompactTable("#learning-best-strategies", ["Strategy", "Market", "TF", "Samples", "Win", "Avg R"], learning.bestStrategies || [], (item) => [
    item.strategy,
    item.market,
    item.timeframe,
    formatInteger(item.sampleSize),
    `${Number(item.winRate || 0).toFixed(1)}%`,
    `${Number(item.avgR || 0).toFixed(2)}R`
  ]);
  renderAdminCompactTable("#learning-worst-strategies", ["Strategy", "Market", "TF", "Samples", "Win", "Avg R"], learning.worstStrategies || [], (item) => [
    item.strategy,
    item.market,
    item.timeframe,
    formatInteger(item.sampleSize),
    `${Number(item.winRate || 0).toFixed(1)}%`,
    `${Number(item.avgR || 0).toFixed(2)}R`
  ]);
  renderAdminCompactTable("#learning-confidence-bands", ["Band", "Samples", "Win", "Avg R"], learning.confidenceBandPerformance || [], (item) => [
    item.band,
    formatInteger(item.sampleSize),
    `${Number(item.winRate || 0).toFixed(1)}%`,
    `${Number(item.avgR || 0).toFixed(2)}R`
  ]);
  renderAdminCompactTable("#learning-adjustments", ["Factor", "Value", "Samples", "Adj"], learning.learningAdjustments || [], (item) => [
    item.factorName,
    item.factorValue,
    formatInteger(item.sampleSize),
    `${Number(item.confidenceAdjustment || 0) > 0 ? "+" : ""}${Number(item.confidenceAdjustment || 0)}`
  ]);
  renderValidationRows("#learning-sl-reasons", learning.mostCommonSlReasons || [], (item) => [
    titleCase(item.reason || "unknown"),
    item.count
  ]);
  renderValidationRows("#learning-expired-reasons", learning.mostCommonExpiredReasons || [], (item) => [
    titleCase(item.reason || "unknown"),
    item.count
  ]);
  renderValidationRows("#learning-outcomes", learning.signalsByOutcome || [], (item) => [
    `${item.outcome || "Unknown"} · ${Number(item.avgR || 0).toFixed(2)}R`,
    item.count
  ]);
}

function renderValidationRows(selector, rows = [], rowFormatter) {
  const normalized = Array.isArray(rows) ? rows : [];
  document.querySelector(selector).innerHTML = normalized.length
    ? normalized.map((row) => {
      const [label, count] = rowFormatter(row);
      return `<div class="metric-row"><span>${escapeHtml(label)}</span><strong>${formatInteger(count)}</strong></div>`;
    }).join("")
    : `<div class="empty-state"><span>No validation data yet.</span></div>`;
}

function renderMetricRows(selector, rows, options = {}) {
  document.querySelector(selector).innerHTML = rows.map(([label, value]) => `
    <div class="metric-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(options.rawValues ? value : formatInteger(value))}</strong></div>
  `).join("");
}

function renderMarketMetricRows(selector, rows = []) {
  document.querySelector(selector).innerHTML = rows.length
    ? rows.map((row) => `
      <div class="metric-row"><span>${escapeHtml(row.symbol)}</span><strong>${formatInteger(row.count)}</strong></div>
    `).join("")
    : `<div class="empty-state"><span>No events yet.</span></div>`;
}

function renderSupportTopicOptions() {
  if (!supportTopic) return;
  const topics = state.support.topics && Object.keys(state.support.topics).length
    ? state.support.topics
    : defaultSupportIssues;
  const current = supportTopic.value;
  supportTopic.innerHTML = Object.keys(topics).map((topic) =>
    `<option value="${escapeHtml(topic)}">${escapeHtml(topic)}</option>`
  ).join("");
  supportTopic.value = topics[current] ? current : Object.keys(topics)[0] || "";
  renderSupportIssueOptions();
}

function renderSupportIssueOptions() {
  if (!supportIssue) return;
  const topics = state.support.topics && Object.keys(state.support.topics).length
    ? state.support.topics
    : defaultSupportIssues;
  const issues = topics[supportTopic.value] || [];
  const current = supportIssue.value;
  supportIssue.innerHTML = issues.map((issue) =>
    `<option value="${escapeHtml(issue)}">${escapeHtml(issue)}</option>`
  ).join("");
  supportIssue.value = issues.includes(current) ? current : issues[0] || "";
}

function renderSupportTickets() {
  if (!supportTicketList) return;
  const tickets = state.support.tickets || [];
  supportTicketCount.textContent = `${tickets.length} request${tickets.length === 1 ? "" : "s"}`;
  supportTicketList.innerHTML = tickets.length ? tickets.map((ticket) => `
    <details class="support-ticket-card">
      <summary>
        <div>
          <strong>${escapeHtml(ticket.subject)}</strong>
          <span>${escapeHtml(ticket.topic)} · ${formatDateTime(ticket.createdAt)}</span>
        </div>
        <span class="status-pill ${getSupportStatusClass(ticket.status)}">${escapeHtml(formatSupportLabel(ticket.status))}</span>
      </summary>
      <div class="support-ticket-body">
        <div class="support-ticket-meta">
          <span>Issue<strong>${escapeHtml(ticket.issue)}</strong></span>
          <span>Priority<strong>${escapeHtml(formatSupportLabel(ticket.priority))}</strong></span>
          <span>Updated<strong>${formatDateTime(ticket.updatedAt)}</strong></span>
          <span>Reference<strong>${escapeHtml(ticket.id)}</strong></span>
        </div>
        <div class="support-message-block"><span>Original message</span><p>${escapeHtml(ticket.message)}</p></div>
        ${ticket.publicResponse ? `<div class="support-message-block"><span>Support response</span><p>${escapeHtml(ticket.publicResponse)}</p></div>` : ""}
        ${ticket.relatedSignalId ? `<p class="support-reference">Signal: ${escapeHtml(ticket.relatedSignalId)}</p>` : ""}
      </div>
    </details>
  `).join("") : `
    <div class="empty-state support-empty-state">
      <strong>No support requests yet</strong>
      <p class="reasoning">Submitted requests and their current status will appear here.</p>
    </div>
  `;
}

function renderAdminSupportFilters() {
  const select = document.querySelector("#admin-support-topic");
  if (!select) return;
  const current = select.value;
  const topics = Object.keys(state.adminSupport.topics || defaultSupportIssues);
  select.innerHTML = `<option value="">All topics</option>${topics.map((topic) => `<option value="${escapeHtml(topic)}">${escapeHtml(topic)}</option>`).join("")}`;
  select.value = topics.includes(current) ? current : "";
}

function renderAdminSupportSummary() {
  if (!state.user?.isAdmin) return;
  const summary = state.adminSupport.summary || {};
  const markup = `
    <div><span>Open tickets</span><strong>${formatInteger(summary.openTickets)}</strong></div>
    <div><span>Urgent tickets</span><strong class="${Number(summary.urgentTickets) ? "negative" : ""}">${formatInteger(summary.urgentTickets)}</strong></div>
    <div><span>New today</span><strong>${formatInteger(summary.newToday)}</strong></div>
    <div><span>Oldest open</span><strong>${summary.oldestOpenAt ? formatDateTime(summary.oldestOpenAt) : "None"}</strong></div>
  `;
  const dashboardSummary = document.querySelector("#admin-support-summary");
  const pageSummary = document.querySelector("#admin-support-stats");
  if (dashboardSummary) dashboardSummary.innerHTML = markup;
  if (pageSummary) pageSummary.innerHTML = markup;
}

function renderAdminSupportTickets() {
  if (!adminSupportTicketList) return;
  const tickets = state.adminSupport.tickets || [];
  document.querySelector("#admin-support-count").textContent = `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;
  adminSupportTicketList.innerHTML = tickets.length ? tickets.map((ticket) => `
    <button class="admin-support-ticket ${state.adminSupport.selectedTicketId === ticket.id ? "active" : ""}" type="button" data-admin-support-ticket="${escapeHtml(ticket.id)}">
      <div class="admin-support-ticket-top">
        <span class="status-pill ${getSupportStatusClass(ticket.status)}">${escapeHtml(formatSupportLabel(ticket.status))}</span>
        <span class="support-priority priority-${escapeHtml(ticket.priority)}">${escapeHtml(formatSupportLabel(ticket.priority))}</span>
      </div>
      <span class="support-source-badge">${ticket.source === "public_account_recovery" ? "Account recovery" : "In-app support"}</span>
      ${ticket.source === "public_account_recovery" ? `<span class="support-source-badge">${ticket.accountMatchStatus ? "Matched account found" : "No matched account"}</span>` : ""}
      <strong>${escapeHtml(ticket.subject)}</strong>
      <span>${escapeHtml(ticket.topic)} · ${escapeHtml(ticket.issue)}</span>
      <small>${escapeHtml(ticket.user?.username || "No username")} · ${escapeHtml(ticket.user?.subscriptionTier || "free")} · ${formatDateTime(ticket.createdAt)}</small>
    </button>
  `).join("") : `<div class="empty-state"><strong>No matching support requests</strong><p class="reasoning">Adjust the queue filters to see other tickets.</p></div>`;
}

function renderAdminSupportDetail() {
  if (!adminSupportDetail) return;
  const ticket = state.adminSupport.tickets.find((item) => item.id === state.adminSupport.selectedTicketId);
  if (!ticket) {
    adminSupportDetail.innerHTML = `<div class="empty-state"><strong>Select a support request</strong><p class="reasoning">Open a ticket to review its message, account context, and internal notes.</p></div>`;
    return;
  }
  adminSupportDetail.innerHTML = `
    <div class="admin-support-detail-header">
      <div><span class="eyebrow">${escapeHtml(ticket.topic)}</span><h3>${escapeHtml(ticket.subject)}</h3></div>
      <span class="status-pill ${getSupportStatusClass(ticket.status)}">${escapeHtml(formatSupportLabel(ticket.status))}</span>
    </div>
    <div class="admin-support-context-grid">
      <div><span>User</span><strong>${escapeHtml(ticket.user?.username || "No username")}</strong><small>${escapeHtml(ticket.user?.email || "")}</small></div>
      <div><span>Plan</span><strong>${escapeHtml(String(ticket.user?.subscriptionTier || "free").toUpperCase())}</strong><small>${formatInteger(ticket.user?.creditBalance)} unlock credits</small></div>
      <div><span>Issue</span><strong>${escapeHtml(ticket.issue)}</strong><small>${escapeHtml(formatSupportLabel(ticket.priority))} priority</small></div>
      <div><span>Created</span><strong>${formatDateTime(ticket.createdAt)}</strong><small>Updated ${formatDateTime(ticket.updatedAt)}</small></div>
    </div>
    <div class="support-message-block"><span>Full message</span><p>${escapeHtml(ticket.message)}</p></div>
    <div class="admin-support-references">
      <p><strong>Ticket:</strong> ${escapeHtml(ticket.id)}</p>
      <p><strong>Source:</strong> ${escapeHtml(ticket.source === "public_account_recovery" ? "Account recovery" : "Authenticated support")}</p>
      <p><strong>User ID:</strong> ${escapeHtml(ticket.user?.id || "Unavailable")}</p>
      <p><strong>Signal:</strong> ${escapeHtml(ticket.relatedSignalId || "Not supplied")}</p>
      <p><strong>Subscription/payment:</strong> ${escapeHtml(ticket.relatedSubscriptionId || "Not supplied")}</p>
      <p><strong>Page:</strong> ${escapeHtml(ticket.context?.pageUrl || "Not supplied")}</p>
      <p><strong>User agent:</strong> ${escapeHtml(ticket.context?.userAgent || "Not supplied")}</p>
    </div>
    ${ticket.source === "public_account_recovery" ? renderAccountRecoveryTools(ticket) : ""}
    <form class="admin-support-update-form" data-admin-support-update="${escapeHtml(ticket.id)}">
      <div class="support-form-grid">
        <label>Status<select name="status">${renderSupportSelectOptions(["open", "in_review", "waiting_for_user", "resolved", "closed"], ticket.status)}</select></label>
        <label>Priority<select name="priority">${renderSupportSelectOptions(["low", "normal", "high", "urgent"], ticket.priority)}</select></label>
      </div>
      <label>Public response<textarea name="publicResponse" rows="4" maxlength="5000" placeholder="Visible to the user in My support requests. No email is sent.">${escapeHtml(ticket.publicResponse || "")}</textarea></label>
      <label>Internal admin notes<textarea name="adminNotes" rows="6" maxlength="10000" placeholder="Private notes. These are never shown to the user.">${escapeHtml(ticket.adminNotes || "")}</textarea></label>
      <button type="submit">Save changes</button>
      <p class="status-line" data-admin-support-status></p>
    </form>
  `;
}

function renderAccountRecoveryTools(ticket) {
  const account = ticket.recoveryAccount;
  return `<section class="account-recovery-tools">
    <header><div><span class="eyebrow">Admin only</span><h3>Account Recovery Tools</h3></div><button class="secondary-action" type="button" data-recovery-account-lookup="${escapeHtml(ticket.id)}">${account === undefined ? "Look up account" : "Refresh lookup"}</button></header>
    ${account === undefined ? `<p class="reasoning">Search securely using the submitted email and username.</p>` : account === null ? `<div class="empty-state"><strong>No matching account found</strong><p class="reasoning">The submitted details did not match an account. This result is admin-only.</p></div>` : `
      <div class="recovery-account-grid">
        <div><span>User ID</span><strong>${escapeHtml(account.id)}</strong></div><div><span>Username</span><strong>${escapeHtml(account.username || "None")}</strong></div>
        <div><span>Email</span><strong>${escapeHtml(account.email)}</strong></div><div><span>Plan</span><strong>${escapeHtml(String(account.plan).toUpperCase())}</strong></div>
        <div><span>Created</span><strong>${formatDateTime(account.createdAt)}</strong></div><div><span>Last login</span><strong>${account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "Unavailable"}</strong></div>
        <div><span>Active sessions</span><strong>${formatInteger(account.activeSessions)}</strong></div><div><span>Restore tokens</span><strong>${formatInteger(account.activeRestoreTokens)}</strong></div>
      </div>
      ${account.matchType !== "email" ? `<p class="recovery-tool-warning">Username-only match. Credential actions are disabled until the submitted email matches the account.</p>` : `<form class="recovery-temp-form" data-recovery-temp-password="${escapeHtml(ticket.id)}">
        <input type="hidden" name="targetUserId" value="${escapeHtml(account.id)}" />
        <label>Temporary password<input name="temporaryPassword" type="text" minlength="12" maxlength="128" autocomplete="off" required /></label>
        <div class="recovery-tool-actions"><button class="secondary-action" type="button" data-generate-temp-password>Generate password</button><button type="submit">Set temporary password</button><button class="secondary-action" type="button" data-ticket-id="${escapeHtml(ticket.id)}" data-recovery-revoke-sessions="${escapeHtml(account.id)}">Revoke user sessions</button></div>
        <p class="recovery-tool-warning">Only share this temporary password through a trusted private channel. Ask the user to change it after login. It is never stored or shown again.</p>
        <p class="status-line" data-recovery-tool-status></p>
      </form>`}`}
  </section>`;
}

async function lookupRecoveryAccount(ticketId) {
  const ticket = state.adminSupport.tickets.find((item) => item.id === ticketId);
  if (!ticket) return;
  try {
    const result = await api.request(`/api/admin/support/${encodeURIComponent(ticketId)}/account-recovery/lookup`);
    ticket.recoveryAccount = result.account || null;
  } catch (error) {
    showToast(error.message);
  }
  renderAdminSupportDetail();
}

function generateTemporaryPassword() {
  const bytes = new Uint32Array(3);
  crypto.getRandomValues(bytes);
  return `SF-${bytes[0].toString(36)}-${bytes[1].toString(36)}-${bytes[2].toString(36)}aA1`;
}

function renderSupportSelectOptions(values, selected) {
  return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(formatSupportLabel(value))}</option>`).join("");
}

function getSupportStatusClass(status) {
  if (status === "resolved") return "status-hit-tp";
  if (status === "closed") return "status-closed";
  if (status === "waiting_for_user") return "status-expired";
  if (status === "in_review") return "status-review";
  return "status-active";
}

function formatSupportLabel(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function renderLeaderboards() {
  if (!leaderboardTable) return;
  const metadata = {
    topRMultiple: ["Top R-Multiple", "Ranked by net R"],
    bestWinRate: ["Best Win Rate", "Minimum 3 closed outcomes"],
    mostActive: ["Most Active", "Ranked by tracked signals"],
    longestWinStreak: ["Longest Win Streak", "Consecutive TP hits"],
    monthlyChampions: ["Monthly Champions", "Current calendar month"]
  };
  const tab = state.leaderboardTab || "topRMultiple";
  const rows = state.leaderboards?.tabs?.[tab] || [];
  const [title, eyebrow] = metadata[tab] || metadata.topRMultiple;

  leaderboardTitle.textContent = title;
  leaderboardEyebrow.textContent = eyebrow;
  leaderboardUpdated.textContent = state.leaderboards?.generatedAt
    ? `Updated ${formatDateTime(state.leaderboards.generatedAt)}`
    : "Live rankings";
  leaderboardTabs?.querySelectorAll("[data-leaderboard-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leaderboardTab === tab);
  });

  if (!rows.length) {
    const eligibility = state.leaderboards?.viewerEligibility || {};
    const hasAnyRankedUsers = Object.values(state.leaderboards?.tabs || {})
      .some((tabRows) => Array.isArray(tabRows) && tabRows.length);
    const tabMessage = hasAnyRankedUsers
      ? getLeaderboardTabEmptyMessage(tab)
      : "To appear here, enable your public profile, turn on leaderboard visibility, and complete at least one tracked signal or linked paper trade.";
    leaderboardTable.innerHTML = `
      <div class="empty-state leaderboard-empty-state">
        <strong>${hasAnyRankedUsers ? "No qualifying traders for this ranking yet." : "No ranked traders yet."}</strong>
        <p class="reasoning">${escapeHtml(tabMessage)}</p>
        ${state.user ? `
          <div class="leaderboard-checklist" aria-label="Your leaderboard eligibility">
            ${renderEligibilityCheck("Public profile enabled", eligibility.publicProfileEnabled)}
            ${renderEligibilityCheck("Leaderboard enabled", eligibility.leaderboardEnabled)}
            ${renderEligibilityCheck(
              "Completed tracked signal or linked paper trade",
              Number(eligibility.completedTrackedSignals || 0) > 0 || Number(eligibility.linkedPaperTrades || 0) > 0
            )}
          </div>
        ` : ""}
        <div class="empty-state-actions">
          <button type="button" data-leaderboard-action="settings">Open Profile Settings</button>
          <button class="secondary-button" type="button" data-leaderboard-action="signals">Go to Signals</button>
          <button class="secondary-button" type="button" data-leaderboard-action="paper-trading">Open Paper Trading</button>
        </div>
      </div>
    `;
    return;
  }

  leaderboardTable.innerHTML = `
    <table class="leaderboard-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Trader</th>
          <th>Net R</th>
          <th>Win rate</th>
          <th>Closed</th>
          <th>Best market</th>
          <th>Best timeframe</th>
          <th>Current streak</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td data-label="Rank"><strong>#${row.rank}</strong></td>
            <td data-label="Trader">
              ${row.profileUrl ? `<a class="leaderboard-user" href="${escapeHtml(row.profileUrl)}">` : `<span class="leaderboard-user">`}
                <span class="leaderboard-avatar">${escapeHtml(row.avatarInitial || "S")}</span>
                <span>
                  <strong>${escapeHtml(row.username)}</strong>
                  <small>${escapeHtml(formatPlanBadge(row.plan))}</small>
                </span>
              ${row.profileUrl ? `</a>` : `</span>`}
            </td>
            <td data-label="Net R"><strong class="${Number(row.netR) >= 0 ? "positive" : "negative"}">${formatR(row.netR)}</strong></td>
            <td data-label="Win rate">${Number(row.winRate || 0).toFixed(1)}%</td>
            <td data-label="Closed">${formatInteger(row.closedSignals)}</td>
            <td data-label="Best market">${escapeHtml(row.bestMarket?.label || "--")}</td>
            <td data-label="Best timeframe">${escapeHtml(row.bestTimeframe?.label || "--")}</td>
            <td data-label="Current streak">${escapeHtml(row.currentStreak || "No closed trades")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function getLeaderboardTabEmptyMessage(tab) {
  const messages = {
    bestWinRate: "No trader has the minimum 3 completed outcomes required for this ranking yet.",
    longestWinStreak: "No qualifying TP win streak has been recorded yet.",
    monthlyChampions: "No completed tracked outcomes have been recorded this calendar month.",
    mostActive: "No completed tracked outcomes are available for the activity ranking yet.",
    topRMultiple: "No completed tracked outcomes are available for the R-multiple ranking yet."
  };
  return messages[tab] || messages.topRMultiple;
}

function renderEligibilityCheck(label, passed) {
  return `<span class="${passed ? "passed" : "missing"}">${passed ? "✓" : "✕"} ${escapeHtml(label)}</span>`;
}

function formatPlanBadge(plan) {
  const value = String(plan || "free").toLowerCase();
  if (value === "elite") return "Elite";
  if (value === "pro") return "Pro";
  return "Free";
}

function renderProfile() {
  const profile = normalizeProfile(state.profile, state.user);
  state.profile = profile;
  const stats = profile?.stats || {};
  const username = profile?.username || "";
  const displayName = username || "Create a username";

  setText("#profile-avatar", profile?.avatarInitial || "SF");
  setText("#profile-username", displayName);
  setText("#profile-joined", `Joined ${formatProfileDate(profile?.joinedAt)}`);
  setText("#profile-plan-badge", profile?.plan || "Free");
  setText("#profile-signals-unlocked", formatInteger(stats.signalsUnlocked));
  setText("#profile-closed-signals", formatInteger(stats.closedSignals));
  setText("#profile-win-rate", `${Number(stats.winRate || 0).toFixed(1)}%`);
  setText("#profile-net-r", formatR(stats.netR));
  setText("#profile-average-r", formatR(stats.averageR));
  setText("#profile-favorite-market", stats.favoriteMarket || "--");
  setText("#profile-best-timeframe", stats.bestTimeframe || "--");
  setText("#profile-current-streak", `${stats.currentStreak || 0}`);
  setText("#profile-best-streak", `${stats.bestStreak || 0}`);

  if (settingsUsername) settingsUsername.value = username;
  if (settingsPublicProfile) settingsPublicProfile.checked = Boolean(profile?.publicProfileEnabled);
  if (settingsPublicLeaderboard) {
    settingsPublicLeaderboard.checked = Boolean(profile?.publicLeaderboardEnabled);
    settingsPublicLeaderboard.disabled = false;
  }
  setText("#signal-view-mode-status", `${profile.signalViewMode === "advanced" ? "Advanced" : "Beginner"} view is saved to your account.`);
  syncSignalViewToggles();
  const eligibility = profile?.private?.leaderboardEligibility || {};
  setText("#eligibility-public-profile", profile?.publicProfileEnabled ? "On" : "Off");
  setText("#eligibility-leaderboard", profile?.publicLeaderboardEnabled ? "On" : "Off");
  setText("#eligibility-tracked-signals", formatInteger(eligibility.completedTrackedSignals));
  setText("#eligibility-paper-trades", formatInteger(eligibility.linkedPaperTrades));
  setText("#eligibility-status", eligibility.eligible ? "Eligible" : "Not eligible yet");
  document.querySelector("#leaderboard-eligibility")?.classList.toggle("eligible", Boolean(eligibility.eligible));
  if (onboardingUsername && !onboardingUsername.value) onboardingUsername.value = username;
  if (onboardingPublicProfile) onboardingPublicProfile.checked = Boolean(profile?.publicProfileEnabled);
  if (settingsProfilePreview) {
    settingsProfilePreview.href = profile?.publicProfileUrl || "#";
    settingsProfilePreview.textContent = username ? `View /u/${username}` : "Create a username first";
    settingsProfilePreview.classList.toggle("disabled-link", !username || !profile?.publicProfileEnabled);
  }
  usernameRequiredPanel?.classList.toggle("hidden", !profile?.usernameRequired);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function normalizeProfile(profile, user = state.user) {
  const source = profile || user?.profile || {};
  const username = source?.username || user?.username || "";
  return {
    username,
    usernameRequired: source?.usernameRequired ?? !username,
    avatarInitial: source?.avatarInitial || (username || user?.name || "S").slice(0, 1).toUpperCase(),
    joinedAt: source?.joinedAt || user?.createdAt || null,
    publicProfileEnabled: Boolean(source?.publicProfileEnabled ?? user?.publicProfileEnabled),
    publicLeaderboardEnabled: Boolean(source?.publicLeaderboardEnabled ?? user?.publicLeaderboardEnabled),
    signalViewMode: source?.signalViewMode === "advanced" || user?.signalViewMode === "advanced"
      ? "advanced"
      : "beginner",
    publicProfileUrl: source?.publicProfileUrl || (username ? `/u/${username}` : null),
    plan: source?.plan || user?.plan || "free",
    stats: {
      signalsUnlocked: Number(source?.stats?.signalsUnlocked || 0),
      closedSignals: Number(source?.stats?.closedSignals || 0),
      winRate: Number(source?.stats?.winRate || 0),
      netR: Number(source?.stats?.netR || 0),
      averageR: Number(source?.stats?.averageR || 0),
      favoriteMarket: source?.stats?.favoriteMarket || null,
      bestTimeframe: source?.stats?.bestTimeframe || null,
      currentStreak: source?.stats?.currentStreak || "No closed trades",
      bestStreak: source?.stats?.bestStreak || "No wins yet"
    },
    private: {
      usernameUpdatedAt: source?.private?.usernameUpdatedAt || user?.usernameUpdatedAt || null,
      canChangeUsernameAt: source?.private?.canChangeUsernameAt || null,
      leaderboardEligibility: {
        publicProfileEnabled: Boolean(source?.private?.leaderboardEligibility?.publicProfileEnabled ?? source?.publicProfileEnabled),
        leaderboardEnabled: Boolean(source?.private?.leaderboardEligibility?.leaderboardEnabled ?? source?.publicLeaderboardEnabled),
        completedTrackedSignals: Number(source?.private?.leaderboardEligibility?.completedTrackedSignals || 0),
        linkedPaperTrades: Number(source?.private?.leaderboardEligibility?.linkedPaperTrades || 0),
        eligible: Boolean(source?.private?.leaderboardEligibility?.eligible)
      }
    }
  };
}

function getUserDisplayName() {
  return state.user?.profile?.username || state.user?.username || state.user?.name || "Trader";
}

function isPublicProfileRoute() {
  return location.pathname.startsWith("/u/") && location.pathname.length > 3;
}

async function loadPublicProfileRoute() {
  const username = decodeURIComponent(location.pathname.replace(/^\/u\//, "").split("/")[0] || "");
  landingPage.classList.add("hidden");
  authScreen.classList.add("hidden");
  dashboard.classList.add("hidden");
  publicHowItWorksPage?.classList.add("hidden");
  publicProfilePage?.classList.remove("hidden");

  try {
    const { profile } = await api.request(`/api/profiles/${encodeURIComponent(username)}`);
    state.publicProfile = profile;
    renderPublicProfile(profile);
  } catch (error) {
    renderPublicProfileError(error.message);
  }
}

function renderPublicProfile(profile) {
  const stats = profile.stats || {};
  document.title = `${profile.username} | SignalForge Profile`;
  document.querySelector("#public-profile-shell").innerHTML = `
    <a class="brand-mark public-profile-brand" href="/" aria-label="SignalForge home">
      <img src="/icons/android-chrome-192x192.png" alt="" />
      <span>SignalForge</span>
    </a>
    <article class="panel profile-hero-card public">
      <div class="profile-avatar">${escapeHtml(profile.avatarInitial || "SF")}</div>
      <div>
        <p class="eyebrow">Public trader profile</p>
        <h1>@${escapeHtml(profile.username)}</h1>
        <p class="muted">Joined ${formatProfileDate(profile.joinedAt)} · ${escapeHtml(profile.plan || "Free")} plan</p>
      </div>
    </article>
    <section class="profile-stat-grid">
      ${renderProfileStat("Signals unlocked", formatInteger(stats.signalsUnlocked))}
      ${renderProfileStat("Closed signals", formatInteger(stats.closedSignals))}
      ${renderProfileStat("Win rate", `${Number(stats.winRate || 0).toFixed(1)}%`)}
      ${renderProfileStat("Net R", formatR(stats.netR))}
      ${renderProfileStat("Average R", formatR(stats.averageR))}
      ${renderProfileStat("Favorite market", stats.favoriteMarket || "--")}
      ${renderProfileStat("Best timeframe", stats.bestTimeframe || "--")}
      ${renderProfileStat("Current streak", stats.currentStreak || 0)}
      ${renderProfileStat("Best streak", stats.bestStreak || 0)}
    </section>
    <p class="risk-disclaimer">Educational tool only. Not financial advice.</p>
  `;
}

function renderPublicProfileError(message) {
  document.querySelector("#public-profile-shell").innerHTML = `
    <a class="brand-mark public-profile-brand" href="/" aria-label="SignalForge home">
      <img src="/icons/android-chrome-192x192.png" alt="" />
      <span>SignalForge</span>
    </a>
    <article class="panel profile-hero-card public">
      <div class="profile-avatar">SF</div>
      <div>
        <p class="eyebrow">Public profile</p>
        <h1>Profile unavailable</h1>
        <p class="muted">${escapeHtml(message)}</p>
      </div>
    </article>
  `;
}

function renderProfileStat(label, value) {
  return `
    <article class="profile-stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function formatProfileDate(value) {
  if (!value) return "recently";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
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
  const stored = localStorage.getItem(SIGNAL_VIEW_MODE_KEY) || localStorage.getItem(LEGACY_SCANNER_MODE_KEY);
  return stored === "advanced" ? "advanced" : "beginner";
}

function persistSignalViewMode(mode) {
  const normalized = mode === "advanced" ? "advanced" : "beginner";
  localStorage.setItem(SIGNAL_VIEW_MODE_KEY, normalized);
  localStorage.removeItem(LEGACY_SCANNER_MODE_KEY);
}

function syncSignalViewToggles() {
  document.querySelectorAll("[data-signal-view-mode]").forEach((button) => {
    const active = button.dataset.signalViewMode === state.scannerMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderSignalViewSurfaces() {
  syncSignalViewToggles();
  renderSignals();
  renderSignalsHistory();
  renderCandidates();
  renderAvoidTrades();
  renderMarketBrief();
  if (state.unlockedRevealSignalId) renderUnlockReveal();
}

async function setSignalViewMode(mode) {
  const nextMode = mode === "advanced" ? "advanced" : "beginner";
  if (state.scannerMode === nextMode) return;
  const previousMode = state.scannerMode;
  state.scannerMode = nextMode;
  persistSignalViewMode(nextMode);
  renderSignalViewSurfaces();

  if (!state.user) return;
  const status = document.querySelector("#signal-view-mode-status");
  if (status) status.textContent = "Saving view preference...";
  try {
    const result = await api.request("/api/profile/me", {
      method: "PUT",
      body: JSON.stringify({ signalViewMode: nextMode })
    });
    state.profile = normalizeProfile(result.profile, state.user);
    state.user = { ...state.user, signalViewMode: nextMode, profile: state.profile };
    if (status) status.textContent = `${nextMode === "advanced" ? "Advanced" : "Beginner"} view is saved to your account.`;
  } catch (error) {
    state.scannerMode = previousMode;
    persistSignalViewMode(previousMode);
    renderSignalViewSurfaces();
    if (status) status.textContent = `Could not save view preference: ${error.message}`;
    showToast("Could not save signal view mode");
  }
}

function getStoredPaperIndicators() {
  try {
    const stored = JSON.parse(localStorage.getItem("signalforge-paper-indicators") || "[]");
    return new Set(Array.isArray(stored) && stored.length ? stored : ["ema20", "ema50", "volume"]);
  } catch {
    return new Set(["ema20", "ema50", "volume"]);
  }
}

function getStoredNavSections() {
  const defaults = {
    trading: true,
    alerts: true,
    research: true,
    portfolio: true,
    growth: true,
    community: true,
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

function getStoredOnboardingSkipped() {
  return localStorage.getItem("signalforge-onboarding-skipped") === "1";
}

function getStoredFirstScanCompleted() {
  return localStorage.getItem("signalforge-first-scan-complete") === "1";
}

function renderNavSections() {
  document.querySelectorAll("[data-nav-section]").forEach((section) => {
    const name = section.dataset.navSection;
    const expanded = state.navSections[name] !== false;
    section.classList.toggle("collapsed", !expanded);
    section.querySelector("[data-nav-section-toggle]")?.setAttribute("aria-expanded", String(expanded));
  });
}

function getOnboardingSteps() {
  const profile = normalizeProfile(state.profile, state.user);
  const telegramSettings = state.notifications?.settings;
  const telegramPreferencesChosen = Boolean(
    state.notifications?.connected &&
    telegramSettings &&
    Array.isArray(telegramSettings.timeframes) &&
    telegramSettings.timeframes.length &&
    telegramSettings.direction &&
    Number.isFinite(Number(telegramSettings.minimumConfidence))
  );
  const unlockedCount = Number(state.signalStats?.totalSignals || 0) || state.signals?.length || 0;

  return [
    {
      id: "username",
      title: "Create username",
      description: "Reserve a public identity for profiles, rankings, and community features.",
      done: Boolean(profile?.username),
      action: "profile",
      cta: profile?.username ? "View profile" : "Create username"
    },
    {
      id: "telegram",
      title: "Connect Telegram",
      description: "Link your Telegram account so SignalForge can deliver setup previews.",
      done: Boolean(state.notifications?.connected),
      action: "telegram",
      cta: state.notifications?.connected ? "Telegram settings" : "Connect Telegram"
    },
    {
      id: "alerts",
      title: "Choose alert preferences",
      description: "Set timeframes, direction, alert scope, and minimum confidence.",
      done: telegramPreferencesChosen,
      action: "preferences",
      cta: telegramPreferencesChosen ? "Review alerts" : "Choose preferences"
    },
    {
      id: "scan",
      title: "Run first scan",
      description: "Scan supported markets and see why setups passed or failed.",
      done: Boolean(state.firstScanCompleted || state.lastScanSummary),
      action: "scan",
      cta: "Run scan"
    },
    {
      id: "unlock",
      title: "Unlock first signal",
      description: "Save a full signal to history with entry, stop, target, and outcome tracking.",
      done: unlockedCount > 0,
      action: "unlock",
      cta: unlockedCount > 0 ? "View signals" : "Unlock signal"
    }
  ];
}

function renderOnboarding() {
  if (!onboardingPanel || !onboardingChecklist) return;

  const steps = getOnboardingSteps();
  const completed = steps.filter((step) => step.done).length;
  const total = steps.length;
  const allComplete = completed === total;
  const shouldShowPanel = !allComplete && !state.onboardingSkipped;

  onboardingPanel.classList.toggle("hidden", !shouldShowPanel);
  onboardingShowButton?.classList.toggle("hidden", shouldShowPanel || allComplete);
  onboardingProgressText.textContent = `${completed}/${total} complete`;
  onboardingProgressBar.max = total;
  onboardingProgressBar.value = completed;
  onboardingProgressNote.textContent = allComplete
    ? "Your core SignalForge setup is complete."
    : `${total - completed} step${total - completed === 1 ? "" : "s"} left. You can skip and return anytime from the dashboard.`;

  const firstIncompleteId = steps.find((step) => !step.done)?.id;
  onboardingChecklist.innerHTML = steps.map((step, index) => `
    <article class="onboarding-step ${step.done ? "complete" : ""} ${step.id === firstIncompleteId ? "current" : ""}">
      <span class="onboarding-step-icon">${step.done ? "✓" : index + 1}</span>
      <div>
        <strong>${escapeHtml(step.title)}</strong>
        <p>${escapeHtml(step.description)}</p>
      </div>
      <button class="${step.done ? "secondary-action" : ""}" data-onboarding-action="${step.action}" type="button">
        ${escapeHtml(step.cta)}
      </button>
    </article>
  `).join("");
}

function handleOnboardingAction(action) {
  if (action === "profile") {
    navigateTo("profile");
    usernameRequiredPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
    onboardingUsername?.focus({ preventScroll: true });
    return;
  }

  if (action === "telegram" || action === "preferences") {
    navigateTo("notifications");
    if (action === "preferences") {
      telegramPreferencesForm?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      telegramConnectButton?.focus({ preventScroll: true });
    }
    return;
  }

  if (action === "scan") {
    navigateTo("scanner");
    scanAllButton?.scrollIntoView({ behavior: "smooth", block: "center" });
    scanAllButton?.focus({ preventScroll: true });
    return;
  }

  if (action === "unlock") {
    if (state.scanResults?.length) {
      navigateTo("scanner");
      scrollToSignalDesk();
      return;
    }

    navigateTo(state.signals?.length ? "signals" : "scanner");
    if (!state.signals?.length) {
      scrollToSignalDesk();
    }
  }
}

function markFirstScanCompleted() {
  state.firstScanCompleted = true;
  localStorage.setItem(FIRST_SCAN_KEY, "1");
  renderOnboarding();
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

async function completeSignalUnlock({ signal, subscription, alreadyUnlocked, source }) {
  state.subscription = subscription || state.subscription;
  renderSubscription();
  state.scanResults = [];
  await Promise.all([loadSignals(), loadPaperPortfolio()]);

  const unlockedSignal = state.signals.find((item) => item.id === signal.id) ||
    state.signals.find((item) => item.setupKey && item.setupKey === signal.setupKey) ||
    signal;
  const unlockedKey = getSignalKey(unlockedSignal);
  state.expandedSignalKeys = new Set([unlockedKey]);
  state.unlockedRevealSignalId = unlockedSignal.id;
  sessionStorage.setItem(UNLOCK_REVEAL_KEY, unlockedSignal.id);

  navigateTo("signals", {}, { replace: source === "telegram" });
  renderSignals();
  renderSignalsHistory();
  renderUnlockReveal();

  const sourceLabel = source === "telegram" ? " from Telegram" : "";
  statusLine.textContent = alreadyUnlocked
    ? "Already unlocked. No additional credit was used."
    : `Signal unlocked${sourceLabel}. One unlock credit deducted.`;
  showToast(alreadyUnlocked ? "Already unlocked" : "Signal unlocked");
}

async function restoreUnlockReveal() {
  const signalId = sessionStorage.getItem(UNLOCK_REVEAL_KEY);
  if (!signalId) return;
  const signal = state.signals.find((item) => item.id === signalId);
  if (!signal) {
    sessionStorage.removeItem(UNLOCK_REVEAL_KEY);
    return;
  }
  await loadPaperPortfolio();
  state.unlockedRevealSignalId = signal.id;
  navigateTo("signals", {}, { replace: true });
  renderUnlockReveal();
}

function renderUnlockReveal() {
  const signal = state.signals.find((item) => item.id === state.unlockedRevealSignalId);
  if (!signal) {
    unlockReveal.classList.add("hidden");
    document.body.classList.remove("unlock-reveal-open");
    return;
  }

  const confidenceBand = signal.confidenceBand || getConfidenceBand(signal.confidenceScore);
  unlockRevealCard.innerHTML = `
    <button class="unlock-reveal-close" type="button" aria-label="Close unlocked signal" data-unlock-reveal-close>×</button>
    <header class="unlock-reveal-header">
      <span class="unlock-reveal-kicker">Signal Unlocked</span>
      <div class="signal-view-toggle compact" data-signal-view-toggle role="group" aria-label="Signal view mode">
        <span>View:</span>
        <button type="button" data-signal-view-mode="beginner">Beginner</button>
        <button type="button" data-signal-view-mode="advanced">Advanced</button>
      </div>
      <div class="unlock-reveal-identity">
        <div>
          <h2 id="unlock-reveal-title">${escapeHtml(getDisplaySymbol(signal.symbol))}</h2>
          <span>${escapeHtml(getProviderSymbolLabel(signal.symbol))}</span>
        </div>
        <strong class="direction ${signal.direction}">${escapeHtml(String(signal.direction || "").toUpperCase())}</strong>
      </div>
      <div class="unlock-reveal-tags">
        <span>${escapeHtml(signal.timeframe)}</span>
        <span>${escapeHtml(confidenceBand)} · ${Number(signal.confidenceScore || 0)}%</span>
        <span>${escapeHtml(signal.setupType || "Qualified setup")}</span>
      </div>
      ${renderSignalValidity(signal, { compact: true })}
    </header>
    <section class="unlock-critical-levels" aria-label="Critical trade levels">
      <div class="entry"><span>Entry</span><strong>${formatCurrency(signal.entryPrice)}</strong></div>
      <div class="stop"><span>Stop Loss</span><strong>${formatCurrency(signal.stopLoss)}</strong></div>
      <div class="target"><span>Take Profit</span><strong>${formatCurrency(signal.takeProfit)}</strong></div>
      <div class="reward"><span>Risk / Reward</span><strong>${Number(signal.riskRewardRatio || 0).toFixed(2)}R</strong></div>
    </section>
    ${renderUnlockSignalModeContent(signal)}
    <div class="unlock-reveal-primary">${renderPaperTradeAction(signal, true)}</div>
    <div class="unlock-reveal-actions">
      <button class="secondary-action" type="button" data-unlock-view-analysis>View full analysis</button>
      <button class="secondary-action" type="button" data-copy-signal-levels>Copy levels</button>
      <button class="text-action" type="button" data-unlock-reveal-close>Close</button>
    </div>
    <p class="unlock-reveal-disclaimer">Educational tool only. Not financial advice.</p>
    <p class="unlock-trust-link">New to SignalForge? <button type="button" data-how-it-works-link>Learn how signals work.</button></p>
  `;
  unlockReveal.classList.remove("hidden");
  document.body.classList.add("unlock-reveal-open");
  requestAnimationFrame(() => unlockRevealCard.focus?.());
  syncSignalViewToggles();
}

function renderUnlockSignalModeContent(signal) {
  if (state.scannerMode === "beginner") {
    return `
      <section class="unlock-simple-reason">
        <span class="eyebrow">Why this setup?</span>
        <p>${escapeHtml(getShortSignalReason(signal))}</p>
      </section>
      ${renderRiskCalculator(signal, { compact: true })}`;
  }

  return `
    ${renderSignalQuality(signal, { compact: true })}
    ${renderRiskCalculator(signal, { compact: true })}
    <details class="unlock-advanced-details">
      <summary>Technical signal details</summary>
      ${renderSignalValidation(signal)}
      ${renderSignalConfluence(signal)}
      ${renderCandidateHistory(signal)}
    </details>`;
}

function closeUnlockReveal() {
  const signal = state.signals.find((item) => item.id === state.unlockedRevealSignalId);
  const key = signal ? getSignalKey(signal) : null;
  unlockReveal.classList.add("hidden");
  document.body.classList.remove("unlock-reveal-open");
  sessionStorage.removeItem(UNLOCK_REVEAL_KEY);
  state.unlockedRevealSignalId = null;
  if (key) highlightSignalKey(key);
}

async function copyUnlockedSignalLevels() {
  const signal = state.signals.find((item) => item.id === state.unlockedRevealSignalId);
  if (!signal) return;
  const text = [
    `${getDisplaySymbol(signal.symbol)} ${String(signal.direction || "").toUpperCase()} ${signal.timeframe}`,
    `Entry: ${formatCurrency(signal.entryPrice)}`,
    `Stop Loss: ${formatCurrency(signal.stopLoss)}`,
    `Take Profit: ${formatCurrency(signal.takeProfit)}`,
    `Risk/Reward: ${Number(signal.riskRewardRatio || 0).toFixed(2)}R`,
    "Educational tool only. Not financial advice."
  ].join("\n");

  try {
    await navigator.clipboard.writeText(text);
    showToast("Signal levels copied");
  } catch {
    showToast("Copy unavailable. Select the levels manually.");
  }
}

function getConfidenceBand(confidence) {
  const value = Number(confidence || 0);
  if (value >= 95) return "Elite";
  if (value >= 90) return "Excellent";
  if (value >= 80) return "Strong";
  return "Good";
}

function scrollToSignalKey(key) {
  const cards = [...document.querySelectorAll("[data-signal-key]")];
  const matches = cards.filter((item) => item.dataset.signalKey === key);
  const card = matches.find((item) => item.offsetParent !== null) || matches[0];
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function highlightSignalKey(key) {
  requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll("[data-signal-key]")];
    const matches = cards.filter((item) => item.dataset.signalKey === key);
    const card = matches.find((item) => item.offsetParent !== null) || matches[0];
    if (!card) return;
    card.classList.add("signal-highlight");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => card.classList.remove("signal-highlight"), 3200);
  });
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "app-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 220);
  }, 2600);
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

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getPaperStatusClass(status) {
  if (status === "Hit TP") return "status-hit-tp";
  if (status === "Hit SL") return "status-hit-sl";
  if (["Expired", "Expired unfilled"].includes(status)) return "status-expired";
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

function toDateInputValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

registerPwa();
init()
  .then(hideSplash)
  .catch(handleStartupFailure);

function handleStartupFailure(error) {
  const reason = error?.code === "restore_timeout" ? "timeout" : safeAuthFailureReason(error);
  console.warn(`[auth] restore:failed reason=${reason}`);
  console.warn(`[auth] Startup session restore failed before login state was confirmed: ${error.message}`);
  if (state.user) {
    landingPage.classList.add("hidden");
    authScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    if (statusLine) statusLine.textContent = "Session restored. Some dashboard data could not load yet.";
    hideSplash();
    return;
  }

  if (isPublicStartupRoute()) {
    if (isAccountRecoveryRoute()) showAccountRecoverySupport();
    else if (isHowItWorksRoute()) showPublicHowItWorks();
    else if (isDebugBuildRoute()) showDebugBuildPage();
    else if (isPasswordResetRequestRoute()) showPasswordResetRequest();
    else if (isPublicAuthRoute()) showAuth();
    else {
      publicHowItWorksPage?.classList.add("hidden");
      authScreen.classList.add("hidden");
      dashboard.classList.add("hidden");
      landingPage.classList.remove("hidden");
    }
    hideSplash();
    return;
  }

  showAuthRestoreFailure(error);
}

function showAuthRestoreFailure(error) {
  showAuth();
  authForm?.classList.add("hidden");
  authRestoreFailure?.classList.remove("hidden");
  authRestoreFailureMessage.textContent = error?.code === "restore_timeout"
    ? "Session restore took too long. Please try again or sign in."
    : "Please sign in again.";
  updateAuthDebug({
    status: "restore_failed",
    failureReason: safeAuthFailureReason(error),
    timeout: error?.code === "restore_timeout"
  });
  setAuthRestoreRecoveryBusy(false);
  hideSplash();
}

function setAuthRestoreRecoveryBusy(busy, message = "") {
  for (const button of [authRestoreRetry, authRestoreSignIn, authRestoreClear]) {
    if (button) button.disabled = busy;
  }
  if (busy && message) authRestoreFailureMessage.textContent = message;
}

function openSignInAfterRestoreFailure(message) {
  authRestoreFailure?.classList.add("hidden");
  showAuth();
  authNote.textContent = message;
  hideSplash();
}

async function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("signalforge-")).map((key) => caches.delete(key)));
    }
    const workerStatus = document.querySelector("#debug-build-service-worker");
    if (workerStatus) workerStatus.textContent = "No";
    console.info("[pwa] Service worker registration temporarily disabled for auth stability.");
  } catch (error) {
    console.warn(`[pwa] Service worker cleanup failed: ${error.message}`);
  }
}

function hideSplash() {
  if (window.__signalForgeBootFailsafe) {
    window.clearTimeout(window.__signalForgeBootFailsafe);
    window.__signalForgeBootFailsafe = null;
  }
  requestAnimationFrame(() => {
    appSplash?.classList.add("hidden");
    setTimeout(() => appSplash?.remove(), 220);
  });
}
