import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const envPath = join(rootDir, ".env");

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export const appConfig = {
  appName: "SignalForge",
  port: Number(process.env.PORT || 4173),
  sessionCookieName: "signalforge_session",
  freeSignalAllowance: 3,
  supportedTimeframes: ["5m", "15m", "1h", "4h"],
  database: {
    url: process.env.DATABASE_URL || "postgres://signalforge:signalforge@localhost:5432/signalforge",
    ssl: process.env.DATABASE_SSL === "true"
  },
  marketData: {
    provider: "coinbase-exchange",
    baseUrl: process.env.MARKET_DATA_BASE_URL || "https://api.exchange.coinbase.com",
    candleLimit: 120,
    requestTimeoutMs: 8000,
    cacheTtlMs: 20000
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
