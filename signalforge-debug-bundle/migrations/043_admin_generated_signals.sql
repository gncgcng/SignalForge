CREATE TABLE IF NOT EXISTS generated_signals (
  id text PRIMARY KEY,
  signal_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  setup_key text,
  pair text NOT NULL,
  display_pair text NOT NULL,
  provider text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  strategy text NOT NULL,
  pattern text,
  pattern_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry numeric NOT NULL,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  risk_reward numeric NOT NULL,
  confidence numeric NOT NULL,
  setup_quality_score numeric NOT NULL DEFAULT 0,
  entry_readiness_score numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Active',
  valid_until timestamptz NOT NULL,
  expired_at timestamptz,
  hit_tp_at timestamptz,
  hit_sl_at timestamptz,
  manually_closed_at timestamptz,
  source text NOT NULL,
  source_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by text NOT NULL DEFAULT 'system',
  promoted_from_candidate_id text,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  warning_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  full_analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  post_mortem_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_favorable_excursion numeric,
  max_adverse_excursion numeric,
  result_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_signals_created ON generated_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_signals_pair ON generated_signals(pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_signals_timeframe ON generated_signals(timeframe, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_signals_status ON generated_signals(status, valid_until);
CREATE INDEX IF NOT EXISTS idx_generated_signals_source ON generated_signals(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_signals_strategy ON generated_signals(strategy, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_signals_pattern ON generated_signals(pattern, created_at DESC) WHERE pattern IS NOT NULL;

INSERT INTO generated_signals (
  id, signal_id, dedupe_key, setup_key, pair, display_pair, provider, timeframe, direction,
  strategy, pattern, pattern_context, entry, stop_loss, take_profit, risk_reward, confidence,
  setup_quality_score, entry_readiness_score, status, valid_until, expired_at, hit_tp_at,
  hit_sl_at, source, source_history, generated_by, validation_summary, warning_reasons,
  quality_breakdown, full_analysis, post_mortem_tags, result_reason, created_at, updated_at
)
SELECT DISTINCT ON (COALESCE(s.setup_key, concat_ws(':', s.symbol, s.timeframe, s.direction, s.setup_type, date_trunc('minute', s.generated_at))))
  'ags_' || substr(md5(COALESCE(s.setup_key, s.id)), 1, 24),
  s.id,
  COALESCE(s.setup_key, concat_ws(':', s.symbol, s.timeframe, s.direction, s.setup_type, date_trunc('minute', s.generated_at))),
  s.setup_key,
  s.symbol,
  replace(replace(s.symbol, '-', ''), '/', ''),
  s.market_source,
  s.timeframe,
  s.direction,
  COALESCE(s.setup_type, 'Qualified setup'),
  NULLIF(s.indicators->'patternContext'->>'pattern', ''),
  COALESCE(s.indicators->'patternContext', '{}'::jsonb),
  s.entry_price,
  s.stop_loss,
  s.take_profit,
  s.risk_reward_ratio,
  s.confidence_score,
  COALESCE(s.quality_score, 0),
  CASE WHEN COALESCE(s.indicators->>'readinessScore', '') ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN (s.indicators->>'readinessScore')::numeric ELSE 0 END,
  COALESCE(o.status, CASE WHEN s.valid_until <= now() THEN 'Expired' ELSE 'Active' END),
  s.valid_until,
  s.expired_at,
  CASE WHEN o.status = 'Hit TP' THEN o.resolved_at END,
  CASE WHEN o.status = 'Hit SL' THEN o.resolved_at END,
  CASE WHEN u.saved_signal_id IS NOT NULL THEN 'legacy_unlocked_signal' ELSE 'legacy_saved_signal' END,
  jsonb_build_array(CASE WHEN u.saved_signal_id IS NOT NULL THEN 'legacy_unlocked_signal' ELSE 'legacy_saved_signal' END),
  'legacy',
  jsonb_build_object('passed', COALESCE(s.validation_passed, true), 'score', COALESCE(s.validation_score, 100)),
  COALESCE(s.indicators->'validationRejectedReasons', '[]'::jsonb),
  COALESCE(s.indicators->'signalQuality', '{}'::jsonb),
  jsonb_build_object('reasoning', s.reasoning, 'confirmations', s.confirmations, 'indicators', s.indicators),
  COALESCE(le.post_mortem_tags, '[]'::jsonb),
  o.status_reason,
  COALESCE(s.created_at, s.generated_at),
  COALESCE(o.updated_at, s.created_at, s.generated_at)
FROM saved_signals s
LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
LEFT JOIN unlocked_signals u ON u.saved_signal_id = s.id
LEFT JOIN signal_learning_events le ON le.signal_id = s.id
WHERE s.validation_passed IS DISTINCT FROM false
ORDER BY COALESCE(s.setup_key, concat_ws(':', s.symbol, s.timeframe, s.direction, s.setup_type, date_trunc('minute', s.generated_at))),
  (u.saved_signal_id IS NOT NULL) DESC,
  s.created_at ASC
ON CONFLICT (dedupe_key) DO UPDATE SET
  status = CASE
    WHEN generated_signals.status IN ('Hit TP', 'Hit SL', 'Manually closed') THEN generated_signals.status
    ELSE EXCLUDED.status
  END,
  expired_at = COALESCE(generated_signals.expired_at, EXCLUDED.expired_at),
  hit_tp_at = COALESCE(generated_signals.hit_tp_at, EXCLUDED.hit_tp_at),
  hit_sl_at = COALESCE(generated_signals.hit_sl_at, EXCLUDED.hit_sl_at),
  post_mortem_tags = CASE WHEN EXCLUDED.post_mortem_tags = '[]'::jsonb THEN generated_signals.post_mortem_tags ELSE EXCLUDED.post_mortem_tags END,
  updated_at = GREATEST(generated_signals.updated_at, EXCLUDED.updated_at);
