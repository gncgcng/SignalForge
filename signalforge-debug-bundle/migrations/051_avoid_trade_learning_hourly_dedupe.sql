WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        market,
        timeframe,
        reason,
        floor(extract(epoch from created_at) / (60 * 60))
      ORDER BY created_at DESC, id DESC
    ) AS row_number
  FROM avoid_trade_learning_events
  WHERE created_at >= now() - interval '7 days'
)
DELETE FROM avoid_trade_learning_events e
USING ranked r
WHERE e.id = r.id
  AND r.row_number > 1;

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
