export class MarketDataProviderError extends Error {
  constructor(message, { statusCode, code } = {}) {
    super(message);
    this.name = "MarketDataProviderError";
    this.statusCode = statusCode;
    this.code = code || "MARKET_DATA_ERROR";
  }
}
