import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const envPath = join(rootDir, ".env");

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);

    if (!match) {
      throw new Error(`Invalid .env assignment: ${trimmed}`);
    }

    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`Multiline .env values are not supported: ${key}`);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const appUrl = resolveAppUrl(
  process.env.APP_URL,
  process.env.NODE_ENV || "development",
  Number(process.env.PORT || 4173)
);
const sessionCookieDomain = resolveCookieDomain(appUrl, process.env.NODE_ENV || "development");

export const stripeEnvironmentKeys = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_ELITE_PRICE_ID",
  "STRIPE_CREDITS_10_PRICE_ID",
  "STRIPE_CREDITS_50_PRICE_ID",
  "STRIPE_CREDITS_100_PRICE_ID"
];

export const appConfig = {
  appName: "SignalForge",
  debugBuildMarker: "AUTH-DEBUG-001",
  buildTimestamp: process.env.SIGNALFORGE_BUILD_TIMESTAMP || new Date().toISOString(),
  buildVersion: process.env.SIGNALFORGE_BUILD_VERSION ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ||
    "2026.07.13-auth-diagnostics.1",
  appUrl,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT || 4173),
  sessionCookieDomain,
  sessionCookieName: process.env.NODE_ENV === "production" && sessionCookieDomain
    ? "__Secure-signalforge_session"
    : process.env.NODE_ENV === "production" ? "__Host-signalforge_session" : "signalforge_session",
  legacySessionCookieName: "signalforge_session",
  legacySessionCookieNames: ["__Host-signalforge_session", "signalforge_session"],
  sessionMaxAgeSeconds: resolveSessionMaxAgeSeconds(process.env.SESSION_MAX_AGE_DAYS),
  restoreTokenMaxAgeSeconds: resolveSessionMaxAgeSeconds(process.env.RESTORE_TOKEN_MAX_AGE_DAYS),
  demoEnabled: process.env.NODE_ENV !== "production" && process.env.ENABLE_DEMO !== "false",
  freeSignalAllowance: 3,
  adminEmails,
  testerCreditAllowance: 1000000,
  email: {
    featuresEnabled: process.env.EMAIL_FEATURES_ENABLED === "true"
  },
  affiliate: {
    commissionRate: 0.2,
    minimumPayoutCents: 2500,
    publicAppUrl: appUrl || "https://signalforge-app.xyz"
  },
  googleOAuth: {
    enabled: process.env.GOOGLE_AUTH_ENABLED !== "false",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI || (
      process.env.NODE_ENV === "production"
        ? "https://signalforge-app.xyz/api/auth/google/callback"
        : `http://localhost:${Number(process.env.PORT || 4173)}/api/auth/google/callback`
    ),
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs"
  },
  abuseProtection: {
    hashSecret: process.env.ABUSE_HASH_SECRET || process.env.DATABASE_URL || "signalforge-local",
    signupAttemptsPerHour: Number(process.env.SIGNUP_ATTEMPTS_PER_HOUR || 10),
    accountsPerDay: Number(process.env.ACCOUNTS_PER_IP_PER_DAY || 3),
    accountsPerWeek: Number(process.env.ACCOUNTS_PER_IP_PER_WEEK || 5),
    verificationTokenHours: Number(process.env.EMAIL_VERIFICATION_TOKEN_HOURS || 24),
    verificationResendSeconds: Number(process.env.EMAIL_VERIFICATION_RESEND_SECONDS || 60),
    publicAppUrl: appUrl || process.env.PUBLIC_APP_URL ||
      `http://localhost:${Number(process.env.PORT || 4173)}`,
    resendApiKey: process.env.RESEND_API_KEY || "",
    emailFrom: process.env.EMAIL_FROM || "SignalForge <onboarding@resend.dev>",
    disposableEmailDomains: new Set(
      (process.env.DISPOSABLE_EMAIL_DOMAINS || "")
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)
    )
  },
  supportedTimeframes: ["5m", "15m", "1h", "4h"],
  marketData: {
    provider: "coinbase-exchange",
    baseUrl: process.env.MARKET_DATA_BASE_URL || "https://api.exchange.coinbase.com",
    candleLimit: 120,
    requestTimeoutMs: 8000,
    cacheTtlMs: 20000
  },
  cryptoMarkets: {
    syncEnabled: process.env.COINBASE_MARKET_SYNC_ENABLED === "true",
    syncIntervalMs: Math.max(3600000, Number(process.env.COINBASE_MARKET_SYNC_INTERVAL_MS || 86400000)),
    verificationEnabled: process.env.MARKET_VERIFICATION_ENABLED === "true",
    verificationIntervalMs: Math.max(60000, Number(process.env.MARKET_VERIFICATION_INTERVAL_MS || 300000)),
    verificationConcurrency: Math.max(1, Number(process.env.MARKET_VERIFICATION_CONCURRENCY || 1)),
    verificationDelayMs: Math.max(0, Number(process.env.MARKET_VERIFICATION_DELAY_MS || 750)),
    verificationTimeoutMs: Math.max(1000, Number(process.env.MARKET_VERIFICATION_TIMEOUT_MS || 10000)),
    verificationRetries: Math.max(0, Number(process.env.MARKET_VERIFICATION_RETRIES || 2)),
    maxActiveScannerPairs: Math.max(1, Number(process.env.CRYPTO_MAX_ACTIVE_SCANNER_PAIRS || 25)),
    maxConcurrentRequests: Math.min(5, Math.max(1, Number(process.env.CRYPTO_MAX_CONCURRENT_REQUESTS || 4))),
    maxCandlesPerRequest: Math.min(300, Math.max(60, Number(process.env.CRYPTO_MAX_CANDLES_PER_REQUEST || 120))),
    unavailableCooldownMs: Math.max(300000, Number(process.env.CRYPTO_UNAVAILABLE_COOLDOWN_MS || 21600000)),
    verificationPairsPerCycle: Math.min(20, Math.max(1, Number(process.env.CRYPTO_VERIFY_PAIRS_PER_CYCLE || 12)))
  },
  twelveData: {
    baseUrl: process.env.TWELVEDATA_API_BASE_URL || "https://api.twelvedata.com",
    apiKey: process.env.TWELVEDATA_API_KEY || "",
    cacheTtlMs: Number(process.env.TWELVEDATA_CACHE_TTL_MS || 300000)
  },
  manualScan: {
    maxMarkets: Math.max(200, Number(process.env.MANUAL_SCAN_MAX_MARKETS || 200)),
    concurrency: Math.max(1, Number(process.env.MANUAL_SCAN_CONCURRENCY || 2)),
    providerDelayMs: Math.max(0, Number(process.env.MANUAL_SCAN_PROVIDER_DELAY_MS || 750)),
    twelveDataEnabled: process.env.TWELVEDATA_MANUAL_SCAN_ENABLED !== "false"
  },
  economicCalendar: {
    baseUrl: process.env.TRADING_ECONOMICS_API_BASE_URL || "https://api.tradingeconomics.com",
    apiKey: process.env.TRADING_ECONOMICS_API_KEY || "",
    cacheTtlMs: Number(process.env.ECONOMIC_CALENDAR_CACHE_TTL_MS || 900000)
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    botUsername: process.env.TELEGRAM_BOT_USERNAME || "",
    queueIntervalMs: Number(process.env.TELEGRAM_QUEUE_INTERVAL_MS || 2000),
    maxAttempts: Number(process.env.TELEGRAM_MAX_ATTEMPTS || 3),
    connectionCodeTtlMinutes: Number(process.env.TELEGRAM_CONNECTION_CODE_TTL_MINUTES || 10),
    updatePollIntervalMs: Number(process.env.TELEGRAM_UPDATE_POLL_INTERVAL_MS || 3000)
  },
  signalTracking: {
    enabled: true,
    intervalMs: Number(process.env.SIGNAL_TRACKING_INTERVAL_MS || 60000)
  },
  autoScan: {
    enabled: process.env.CRYPTO_WATCHER_ENABLED !== "false" && process.env.AUTO_SCAN_ENABLED !== "false",
    cryptoWatcherEnabled: process.env.CRYPTO_WATCHER_ENABLED !== "false",
    cryptoOnly: process.env.AUTO_SCAN_CRYPTO_ONLY !== "false",
    intervalMs: Number(process.env.AUTO_SCAN_INTERVAL_MS || 300000),
    duplicateCooldownMs: Number(process.env.AUTO_SCAN_DUPLICATE_COOLDOWN_MS || process.env.AUTO_SCAN_INTERVAL_MS || 900000)
  },
  candidates: {
    candidateThreshold: Number(process.env.CANDIDATE_SCORE_THRESHOLD || 65),
    readyQualityThreshold: Number(process.env.CANDIDATE_READY_QUALITY_THRESHOLD || 75),
    readyThreshold: Number(process.env.CANDIDATE_READY_THRESHOLD || 80),
    marketsPerCycle: Number(process.env.CANDIDATE_SCAN_MARKETS_PER_CYCLE || 4)
  },
  stripe: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    appUrl,
    successUrl: appUrl ? `${appUrl}/#billing?checkout=success` : "",
    cancelUrl: appUrl ? `${appUrl}/#billing?checkout=cancelled` : "",
    portalReturnUrl: appUrl ? `${appUrl}/#billing` : "",
    prices: {
      pro: process.env.STRIPE_PRO_PRICE_ID || "",
      elite: process.env.STRIPE_ELITE_PRICE_ID || "",
      pack10: process.env.STRIPE_CREDITS_10_PRICE_ID || "",
      pack50: process.env.STRIPE_CREDITS_50_PRICE_ID || "",
      pack100: process.env.STRIPE_CREDITS_100_PRICE_ID || ""
    },
    priceEnvironmentKeys: {
      pro: "STRIPE_PRO_PRICE_ID",
      elite: "STRIPE_ELITE_PRICE_ID",
      pack10: "STRIPE_CREDITS_10_PRICE_ID",
      pack50: "STRIPE_CREDITS_50_PRICE_ID",
      pack100: "STRIPE_CREDITS_100_PRICE_ID"
    }
  }
};

export function getStripeConfigurationStatus() {
  const presence = Object.fromEntries(
    stripeEnvironmentKeys.map((key) => [key, Boolean(process.env[key]?.trim())])
  );
  const present = stripeEnvironmentKeys.filter((key) => presence[key]);
  const missing = stripeEnvironmentKeys.filter((key) => !presence[key]);
  const secretKey = process.env.STRIPE_SECRET_KEY || "";

  return {
    presence,
    present,
    missing,
    checkoutConfigured: presence.STRIPE_SECRET_KEY && Boolean(appConfig.stripe.appUrl),
    webhookConfigured: presence.STRIPE_WEBHOOK_SECRET,
    appUrlConfigured: Boolean(appConfig.stripe.appUrl),
    checkoutMissing: [
      ...(!presence.STRIPE_SECRET_KEY ? ["STRIPE_SECRET_KEY"] : []),
      ...(!appConfig.stripe.appUrl ? ["APP_URL"] : [])
    ],
    mode: getStripeMode(secretKey)
  };
}

export function resolveAppUrl(rawAppUrl, nodeEnv = "development", port = 4173) {
  const value = String(rawAppUrl || "").trim();
  if (!value) {
    return nodeEnv === "production" ? "" : `http://localhost:${port}`;
  }

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function resolveSessionMaxAgeSeconds(rawDays) {
  const days = Number(rawDays || 180);
  if (!Number.isFinite(days) || days < 1) return 60 * 60 * 24 * 180;
  return 60 * 60 * 24 * Math.min(days, 365);
}

export function resolveCookieDomain(resolvedAppUrl, nodeEnv = "development") {
  if (nodeEnv !== "production" || !resolvedAppUrl) return "";

  try {
    const hostname = new URL(resolvedAppUrl).hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      return "";
    }

    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}

export function getStripeMode(secretKey = appConfig.stripe.secretKey) {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  return secretKey ? "unknown" : "unconfigured";
}

export function logStripeConfiguration() {
  const status = getStripeConfigurationStatus();
  console.info(
    `[stripe] mode=${status.mode} present=${status.present.join(",") || "none"} ` +
    `missing=${status.missing.join(",") || "none"} ` +
    `app_url=${status.appUrlConfigured ? "configured" : "missing"}`
  );
}

export function logEmailConfiguration() {
  console.info(`[email] features_enabled=${appConfig.email.featuresEnabled}`);
}
