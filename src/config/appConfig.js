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
    priceId: process.env.STRIPE_PRICE_ID || ""
  }
};
