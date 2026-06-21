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

export const appConfig = {
  appName: "SignalForge",
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT || 4173),
  sessionCookieName: process.env.NODE_ENV === "production" ? "__Host-signalforge_session" : "signalforge_session",
  legacySessionCookieName: "signalforge_session",
  sessionMaxAgeSeconds: 60 * 60 * 24 * 7,
  demoEnabled: process.env.NODE_ENV !== "production" && process.env.ENABLE_DEMO !== "false",
  freeSignalAllowance: 3,
  adminEmails,
  testerCreditAllowance: 1000000,
  abuseProtection: {
    hashSecret: process.env.ABUSE_HASH_SECRET || process.env.DATABASE_URL || "signalforge-local",
    signupAttemptsPerHour: Number(process.env.SIGNUP_ATTEMPTS_PER_HOUR || 10),
    accountsPerDay: Number(process.env.ACCOUNTS_PER_IP_PER_DAY || 3),
    accountsPerWeek: Number(process.env.ACCOUNTS_PER_IP_PER_WEEK || 5),
    verificationTokenHours: Number(process.env.EMAIL_VERIFICATION_TOKEN_HOURS || 24),
    publicAppUrl: process.env.PUBLIC_APP_URL || `http://localhost:${Number(process.env.PORT || 4173)}`,
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
  twelveData: {
    baseUrl: process.env.TWELVEDATA_API_BASE_URL || "https://api.twelvedata.com",
    apiKey: process.env.TWELVEDATA_API_KEY || "",
    cacheTtlMs: Number(process.env.TWELVEDATA_CACHE_TTL_MS || 300000)
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
    intervalMs: Number(process.env.SIGNAL_TRACKING_INTERVAL_MS || 60000),
    expirationHours: Number(process.env.SIGNAL_EXPIRATION_HOURS || 24)
  },
  stripe: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    successUrl: process.env.STRIPE_SUCCESS_URL || "http://localhost:4173/#billing",
    cancelUrl: process.env.STRIPE_CANCEL_URL || "http://localhost:4173/#billing",
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL || "http://localhost:4173/#billing",
    prices: {
      pro: process.env.STRIPE_PRO_PRICE_ID || "",
      elite: process.env.STRIPE_ELITE_PRICE_ID || "",
      pack25: process.env.STRIPE_CREDIT_PACK_25_PRICE_ID || "",
      pack100: process.env.STRIPE_CREDIT_PACK_100_PRICE_ID || "",
      pack300: process.env.STRIPE_CREDIT_PACK_300_PRICE_ID || ""
    }
  }
};
