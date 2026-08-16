import { query } from "../../db/client.js";

export async function findReviewableSignal(signalId, userId, admin = false) {
  const generated = await query(`
    SELECT g.*
    FROM generated_signals g
    WHERE (g.id = $1 OR g.signal_id = $1)
      AND (
        $3::boolean = true
        OR EXISTS (
          SELECT 1
          FROM saved_signals s
          JOIN unlocked_signals u
            ON u.saved_signal_id = s.id
           AND u.user_id = $2
          WHERE s.user_id = $2
            AND (s.id = g.signal_id OR (s.setup_key IS NOT NULL AND s.setup_key = g.setup_key))
        )
        OR EXISTS (
          SELECT 1
          FROM telegram_notification_queue q
          WHERE q.user_id = $2
            AND q.setup_key = g.setup_key
            AND q.status = 'sent'
        )
      )
    ORDER BY CASE WHEN g.id = $1 THEN 0 ELSE 1 END, g.created_at DESC
    LIMIT 1
  `, [signalId, userId, admin]);

  if (generated.rows[0]) return mapGeneratedReviewSignal(generated.rows[0]);

  const saved = await query(`
    SELECT s.*, o.status, o.status_reason, o.resolved_at
    FROM saved_signals s
    JOIN unlocked_signals u ON u.saved_signal_id = s.id
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    WHERE s.id = $1
      AND ($3::boolean = true OR (s.user_id = $2 AND u.user_id = $2))
    LIMIT 1
  `, [signalId, userId, admin]);
  return saved.rows[0] ? mapSavedReviewSignal(saved.rows[0]) : null;
}

function mapGeneratedReviewSignal(row) {
  return {
    id: row.id,
    signalId: row.signal_id,
    setupKey: row.setup_key,
    symbol: row.pair,
    displaySymbol: row.display_pair,
    provider: row.provider,
    timeframe: row.timeframe,
    direction: row.direction,
    strategy: row.strategy,
    entry: Number(row.entry),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    riskReward: Number(row.risk_reward),
    confidence: Number(row.calibrated_confidence ?? row.confidence),
    status: row.status || "Active",
    source: row.source,
    createdAt: row.created_at,
    validUntil: row.valid_until,
    hitTpAt: row.hit_tp_at,
    hitSlAt: row.hit_sl_at,
    expiredAt: row.expired_at,
    outcomeEvaluatedAt: row.outcome_evaluated_at,
    realizedR: row.realized_r == null ? null : Number(row.realized_r),
    resultReason: row.result_reason || null,
    legacy: false
  };
}

function mapSavedReviewSignal(row) {
  return {
    id: row.id,
    signalId: row.id,
    setupKey: row.setup_key,
    symbol: row.symbol,
    displaySymbol: String(row.symbol || "").replace(/[-/]/g, ""),
    provider: row.market_source,
    timeframe: row.timeframe,
    direction: row.direction,
    strategy: row.setup_type || "Qualified setup",
    entry: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    riskReward: Number(row.risk_reward_ratio),
    confidence: Number(row.confidence_score),
    status: row.status || "Active",
    source: "legacy_unlocked_signal",
    createdAt: row.generated_at || row.created_at,
    validUntil: row.valid_until,
    hitTpAt: row.status === "Hit TP" ? row.resolved_at : null,
    hitSlAt: row.status === "Hit SL" ? row.resolved_at : null,
    expiredAt: row.status === "Expired" ? row.resolved_at : row.expired_at,
    outcomeEvaluatedAt: row.resolved_at,
    realizedR: null,
    resultReason: row.status_reason || null,
    legacy: true
  };
}

