import { readJson, sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";
import { getPendingCryptoVerificationJob, startPendingCryptoVerification, verifyCryptoMarket } from "./cryptoMarketMonitor.js";
import { syncCoinbaseCryptoMarkets } from "./cryptoMarketSyncService.js";
import { listCryptoMarketSettings, replaceLegacyCryptoMarket, updateCryptoMarketSettings } from "./cryptoMarketService.js";

export async function handleAdminCryptoMarketRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/admin/crypto-markets")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  if (pathname === "/api/admin/crypto-markets" && req.method === "GET") {
    const allMarkets = listCryptoMarketSettings();
    const markets = filterMarkets(allMarkets, url.searchParams);
    return sendJson(res, 200, { markets, summary: summarize(allMarkets), displayed: markets.length, verificationJob: getPendingCryptoVerificationJob() });
  }

  if (pathname === "/api/admin/crypto-markets/sync" && req.method === "POST") {
    try {
      return sendJson(res, 200, { sync: await syncCoinbaseCryptoMarkets() });
    } catch (error) {
      return sendError(res, error.statusCode || 502, error.message);
    }
  }

  if (pathname === "/api/admin/crypto-markets/verify-pending" && req.method === "POST") {
    return sendJson(res, 202, { verificationJob: startPendingCryptoVerification() });
  }

  if (pathname === "/api/admin/crypto-markets/verification-job" && req.method === "GET") {
    return sendJson(res, 200, { verificationJob: getPendingCryptoVerificationJob() });
  }

  const verifyMatch = pathname.match(/^\/api\/admin\/crypto-markets\/([^/]+)\/verify$/);
  if (verifyMatch && req.method === "POST") {
    try {
      return sendJson(res, 200, { verification: await verifyCryptoMarket(decodeURIComponent(verifyMatch[1]), { force: true }) });
    } catch (error) {
      return sendError(res, error.statusCode || 422, error.message);
    }
  }

  const replaceMatch = pathname.match(/^\/api\/admin\/crypto-markets\/([^/]+)\/replace$/);
  if (replaceMatch && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { market: await replaceLegacyCryptoMarket(decodeURIComponent(replaceMatch[1]), body.replacementSymbol) });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  const marketMatch = pathname.match(/^\/api\/admin\/crypto-markets\/([^/]+)$/);
  if (marketMatch && req.method === "PATCH") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { market: await updateCryptoMarketSettings(decodeURIComponent(marketMatch[1]), body) });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }
  return false;
}

export function filterCryptoMarkets(markets, params) {
  const status = String(params.get("status") || "all");
  const tier = String(params.get("tier") || "all");
  const query = String(params.get("q") || "").trim().toLowerCase();
  return markets.filter((market) => {
    if (["active", "pending", "unavailable", "legacy", "disabled", "provider_error"].includes(status) && market.marketStatus !== status) return false;
    if (status === "scanner" && !market.effectiveScannerEnabled) return false;
    if (status === "paper" && !market.effectivePaperTradingEnabled) return false;
    if (tier !== "all" && market.liquidityTier !== tier) return false;
    if (query && ![market.symbol, market.displaySymbol, market.name, market.providerSymbol, market.baseAsset, "Coinbase"].join(" ").toLowerCase().includes(query)) return false;
    return true;
  });
}

export function summarizeCryptoMarkets(markets) {
  return {
    totalDiscovered: markets.length,
    active: markets.filter((market) => market.marketStatus === "active").length,
    pending: markets.filter((market) => market.marketStatus === "pending").length,
    unavailable: markets.filter((market) => market.marketStatus === "unavailable").length,
    legacy: markets.filter((market) => market.marketStatus === "legacy").length,
    disabled: markets.filter((market) => market.marketStatus === "disabled" || market.enabled === false && market.marketStatus !== "legacy").length,
    providerError: markets.filter((market) => market.marketStatus === "provider_error").length,
    scannerEnabled: markets.filter((market) => market.effectiveScannerEnabled).length,
    paperTradingEnabled: markets.filter((market) => market.effectivePaperTradingEnabled).length
  };
}

const filterMarkets = filterCryptoMarkets;
const summarize = summarizeCryptoMarkets;
