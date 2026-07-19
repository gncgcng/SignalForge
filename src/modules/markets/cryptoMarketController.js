import { readJson, sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";
import { verifyCryptoMarket } from "./cryptoMarketMonitor.js";
import { listCryptoMarketSettings, updateCryptoMarketSettings } from "./cryptoMarketService.js";

export async function handleAdminCryptoMarketRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/admin/crypto-markets")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  if (pathname === "/api/admin/crypto-markets" && req.method === "GET") {
    const markets = filterMarkets(listCryptoMarketSettings(), url.searchParams);
    return sendJson(res, 200, { markets, summary: summarize(markets) });
  }

  const verifyMatch = pathname.match(/^\/api\/admin\/crypto-markets\/([^/]+)\/verify$/);
  if (verifyMatch && req.method === "POST") {
    try {
      return sendJson(res, 200, { verification: await verifyCryptoMarket(decodeURIComponent(verifyMatch[1]), { force: true }) });
    } catch (error) {
      return sendError(res, error.statusCode || 422, error.message);
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

function filterMarkets(markets, params) {
  const status = String(params.get("status") || "all");
  const tier = String(params.get("tier") || "all");
  const query = String(params.get("q") || "").trim().toLowerCase();
  return markets.filter((market) => {
    if (status === "enabled" && !market.enabled) return false;
    if (status === "unavailable" && !["unavailable", "provider_issue"].includes(market.providerStatus)) return false;
    if (status === "scanner" && !market.effectiveScannerEnabled) return false;
    if (tier !== "all" && market.liquidityTier !== tier) return false;
    if (query && ![market.symbol, market.displaySymbol, market.name, market.providerSymbol].join(" ").toLowerCase().includes(query)) return false;
    return true;
  });
}

function summarize(markets) {
  return {
    total: markets.length,
    enabled: markets.filter((market) => market.enabled).length,
    scannerReady: markets.filter((market) => market.effectiveScannerEnabled).length,
    available: markets.filter((market) => market.providerStatus === "available").length,
    unavailable: markets.filter((market) => ["unavailable", "provider_issue"].includes(market.providerStatus)).length,
    unchecked: markets.filter((market) => market.providerStatus === "unchecked").length
  };
}
