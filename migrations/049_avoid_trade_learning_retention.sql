CREATE TABLE IF NOT EXISTS avoid_trade_learning_stats (
  id text PRIMARY KEY,
  market text NOT NULL,
  timeframe text NOT NULL,
  reason text NOT NULL,
  day date NOT NULL,
  result text NOT NULL DEFAULT 'avoid_trade',
  count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market, timeframe, reason, day, result)
);

CREATE INDEX IF NOT EXISTS idx_avoid_trade_learning_stats_day
  ON avoid_trade_learning_stats (day DESC);

CREATE INDEX IF NOT EXISTS idx_avoid_trade_learning_stats_reason
  ON avoid_trade_learning_stats (reason, day DESC);

INSERT INTO avoid_trade_learning_stats (
  id, market, timeframe, reason, day, result, count, first_seen_at, last_seen_at
)
SELECT
  'avoidstat_' || md5(market || ':' || timeframe || ':' || reason || ':' || created_at::date || ':avoid_trade'),
  market,
  timeframe,
  reason,
  created_at::date AS day,
  'avoid_trade' AS result,
  COUNT(*)::integer AS count,
  MIN(created_at) AS first_seen_at,
  MAX(last_observed_at) AS last_seen_at
FROM avoid_trade_learning_events
GROUP BY market, timeframe, reason, created_at::date
ON CONFLICT (market, timeframe, reason, day, result) DO UPDATE SET
  count = GREATEST(avoid_trade_learning_stats.count, EXCLUDED.count),
  first_seen_at = LEAST(avoid_trade_learning_stats.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(avoid_trade_learning_stats.last_seen_at, EXCLUDED.last_seen_at);

CREATE INDEX IF NOT EXISTS idx_avoid_trade_learning_dedup
  ON avoid_trade_learning_events (market, timeframe, reason, created_at DESC);

DELETE FROM avoid_trade_learning_events
WHERE created_at < now() - interval '7 days';

WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS row_number
  FROM avoid_trade_learning_events
)
DELETE FROM avoid_trade_learning_events e
USING ranked r
WHERE e.id = r.id
  AND r.row_number > 25000;

ANALYZE avoid_trade_learning_events;
ANALYZE avoid_trade_learning_stats;
