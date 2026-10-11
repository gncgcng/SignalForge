-- Coinbase 24h USD volume per market, refreshed every 6h from GET /products/{id}/stats (volume x last).
-- Kept separate from crypto_markets on purpose: that table is being replaced by the generic markets table.
CREATE TABLE IF NOT EXISTS market_liquidity (
  symbol text PRIMARY KEY,
  volume_24h_usd numeric,
  last_price numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);
