ALTER TABLE saved_signals
  ADD COLUMN IF NOT EXISTS setup_key text;

UPDATE saved_signals
SET setup_key = CONCAT(symbol, ':', timeframe, ':', direction, ':', EXTRACT(EPOCH FROM generated_at)::bigint)
WHERE setup_key IS NULL;

CREATE TEMP TABLE signal_setup_key_dedup
ON COMMIT DROP
AS
WITH ranked AS (
  SELECT
    s.id,
    s.user_id,
    s.setup_key,
    first_value(s.id) OVER (
      PARTITION BY s.user_id, s.setup_key
      ORDER BY
        (pt.id IS NOT NULL) DESC,
        (j.paper_trade_id IS NOT NULL) DESC,
        (u.id IS NOT NULL) DESC,
        (o.saved_signal_id IS NOT NULL) DESC,
        (
          (s.entry_price IS NOT NULL)::integer +
          (s.stop_loss IS NOT NULL)::integer +
          (s.take_profit IS NOT NULL)::integer +
          (s.risk_reward_ratio IS NOT NULL)::integer +
          (s.confidence_score IS NOT NULL)::integer +
          (s.quality_score IS NOT NULL)::integer +
          (s.setup_type IS NOT NULL)::integer +
          (s.reasoning IS NOT NULL AND length(s.reasoning) > 0)::integer
        ) DESC,
        s.created_at ASC,
        s.id ASC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY s.user_id, s.setup_key
      ORDER BY
        (pt.id IS NOT NULL) DESC,
        (j.paper_trade_id IS NOT NULL) DESC,
        (u.id IS NOT NULL) DESC,
        (o.saved_signal_id IS NOT NULL) DESC,
        (
          (s.entry_price IS NOT NULL)::integer +
          (s.stop_loss IS NOT NULL)::integer +
          (s.take_profit IS NOT NULL)::integer +
          (s.risk_reward_ratio IS NOT NULL)::integer +
          (s.confidence_score IS NOT NULL)::integer +
          (s.quality_score IS NOT NULL)::integer +
          (s.setup_type IS NOT NULL)::integer +
          (s.reasoning IS NOT NULL AND length(s.reasoning) > 0)::integer
        ) DESC,
        s.created_at ASC,
        s.id ASC
    ) AS duplicate_rank
  FROM saved_signals s
  LEFT JOIN unlocked_signals u ON u.saved_signal_id = s.id
  LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
  LEFT JOIN paper_trades pt ON pt.saved_signal_id = s.id
  LEFT JOIN trade_journals j ON j.paper_trade_id = pt.id
  WHERE s.setup_key IS NOT NULL
)
SELECT id, user_id, setup_key, keep_id
FROM ranked
WHERE duplicate_rank > 1;

UPDATE signal_outcomes o
SET saved_signal_id = d.keep_id
FROM signal_setup_key_dedup d
WHERE o.saved_signal_id = d.id
  AND NOT EXISTS (
    SELECT 1
    FROM signal_outcomes existing
    WHERE existing.saved_signal_id = d.keep_id
  );

DELETE FROM signal_outcomes o
USING signal_setup_key_dedup d
WHERE o.saved_signal_id = d.id;

UPDATE unlocked_signals u
SET saved_signal_id = d.keep_id
FROM signal_setup_key_dedup d
WHERE u.saved_signal_id = d.id
  AND NOT EXISTS (
    SELECT 1
    FROM unlocked_signals existing
    WHERE existing.saved_signal_id = d.keep_id
  );

DELETE FROM unlocked_signals u
USING signal_setup_key_dedup d
WHERE u.saved_signal_id = d.id;

INSERT INTO trade_journals (
  paper_trade_id, user_id, notes_before_entry, notes_after_exit,
  emotion_tags, rating, screenshot_url, created_at, updated_at
)
SELECT
  keeper_paper.id,
  j.user_id,
  j.notes_before_entry,
  j.notes_after_exit,
  j.emotion_tags,
  j.rating,
  j.screenshot_url,
  j.created_at,
  j.updated_at
FROM signal_setup_key_dedup d
JOIN paper_trades duplicate_paper ON duplicate_paper.saved_signal_id = d.id
JOIN trade_journals j ON j.paper_trade_id = duplicate_paper.id
JOIN paper_trades keeper_paper
  ON keeper_paper.user_id = duplicate_paper.user_id
  AND keeper_paper.saved_signal_id = d.keep_id
WHERE NOT EXISTS (
  SELECT 1
  FROM trade_journals existing
  WHERE existing.paper_trade_id = keeper_paper.id
);

UPDATE paper_trades p
SET saved_signal_id = d.keep_id
FROM signal_setup_key_dedup d
WHERE p.saved_signal_id = d.id
  AND NOT EXISTS (
    SELECT 1
    FROM paper_trades existing
    WHERE existing.user_id = p.user_id
      AND existing.saved_signal_id = d.keep_id
  );

DELETE FROM paper_trades p
USING signal_setup_key_dedup d
WHERE p.saved_signal_id = d.id;

DELETE FROM saved_signals s
USING signal_setup_key_dedup d
WHERE s.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_signals_user_setup_key
  ON saved_signals(user_id, setup_key)
  WHERE setup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detected_alerts_cooldown
  ON detected_alerts(user_id, symbol, timeframe, direction, detected_at DESC);
