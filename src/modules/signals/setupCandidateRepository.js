import { query } from "../../db/client.js";
import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";

const AVOID_TRADE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let avoidTradeLearningCleanupTimer = null;
let nextAvoidTradeLearningCleanupAt = 0;

export async function upsertSetupCandidate(candidate) {
  const result = await query(`
    INSERT INTO setup_candidates (
      id, setup_key, symbol, display_pair, provider, timeframe, direction, setup_type, status,
      expires_at, candidate_score, setup_quality_score, readiness_score, entry_readiness_score,
      confidence_estimate, entry_quality, current_price, ideal_entry, ideal_entry_zone,
      ideal_entry_zone_low, ideal_entry_zone_high, invalidation_level, potential_stop_loss,
      potential_take_profit, potential_rr, reasons_for_watching, missing_confirmations,
      next_conditions, rejection_reason, promoted_signal_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
    ON CONFLICT (setup_key) DO UPDATE SET
      status = CASE
        WHEN setup_candidates.status IN ('promoted_to_signal', 'rejected', 'expired') THEN setup_candidates.status
        ELSE EXCLUDED.status
      END,
      last_checked_at = now(),
      expires_at = EXCLUDED.expires_at,
      candidate_score = EXCLUDED.candidate_score,
      setup_quality_score = EXCLUDED.setup_quality_score,
      readiness_score = EXCLUDED.readiness_score,
      entry_readiness_score = EXCLUDED.entry_readiness_score,
      confidence_estimate = EXCLUDED.confidence_estimate,
      entry_quality = EXCLUDED.entry_quality,
      current_price = EXCLUDED.current_price,
      ideal_entry = EXCLUDED.ideal_entry,
      ideal_entry_zone = EXCLUDED.ideal_entry_zone,
      ideal_entry_zone_low = EXCLUDED.ideal_entry_zone_low,
      ideal_entry_zone_high = EXCLUDED.ideal_entry_zone_high,
      invalidation_level = EXCLUDED.invalidation_level,
      potential_stop_loss = EXCLUDED.potential_stop_loss,
      potential_take_profit = EXCLUDED.potential_take_profit,
      potential_rr = EXCLUDED.potential_rr,
      reasons_for_watching = EXCLUDED.reasons_for_watching,
      missing_confirmations = EXCLUDED.missing_confirmations,
      next_conditions = EXCLUDED.next_conditions,
      rejection_reason = COALESCE(EXCLUDED.rejection_reason, setup_candidates.rejection_reason),
      promoted_signal_id = COALESCE(EXCLUDED.promoted_signal_id, setup_candidates.promoted_signal_id),
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `, [
    candidate.id || createId("cand"), candidate.setupKey, candidate.symbol, candidate.displayPair,
    candidate.provider, candidate.timeframe, candidate.direction, candidate.setupType, candidate.status,
    candidate.expiresAt, candidate.candidateScore, candidate.setupQualityScore,
    candidate.readinessScore, candidate.entryReadinessScore, candidate.confidenceEstimate,
    candidate.entryQuality, candidate.currentPrice, candidate.idealEntry,
    JSON.stringify(candidate.idealEntryZone || {}), candidate.idealEntryZone?.low ?? null,
    candidate.idealEntryZone?.high ?? null, candidate.invalidationLevel,
    candidate.potentialStopLoss, candidate.potentialTakeProfit, candidate.potentialRr,
    JSON.stringify(candidate.reasonsForWatching || []), JSON.stringify(candidate.missingConfirmations || []),
    JSON.stringify(candidate.nextConditions || []),
    candidate.rejectionReason || null, candidate.promotedSignalId || null,
    JSON.stringify(candidate.metadata || {})
  ]);
  return mapCandidate(result.rows[0]);
}

export async function listVisibleSetupCandidates(limit = 40) {
  const result = await query(`
    SELECT * FROM setup_candidates
    WHERE status IN ('watching', 'almost_ready', 'ready', 'rejected', 'expired')
      AND updated_at >= now() - interval '72 hours'
    ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'almost_ready' THEN 1 WHEN 'watching' THEN 2 ELSE 3 END,
      readiness_score DESC, updated_at DESC
    LIMIT $1
  `, [Math.min(100, Math.max(1, Number(limit || 40)))]);
  return result.rows.map(mapCandidate);
}

export async function expireStaleCandidates() {
  const result = await query(`
    UPDATE setup_candidates
    SET status = 'expired', rejection_reason = COALESCE(rejection_reason, 'Setup did not become ready before expiry.'),
      last_checked_at = now(), updated_at = now()
    WHERE status IN ('watching', 'almost_ready', 'ready') AND expires_at <= now()
    RETURNING *
  `);
  for (const row of result.rows) await recordCandidateLearningEvent(mapCandidate(row));
  return result.rows.length;
}

export async function promoteCandidate(candidateId, signalId) {
  const result = await query(`
    UPDATE setup_candidates
    SET status = 'promoted_to_signal', promoted_signal_id = $2,
      last_checked_at = now(), updated_at = now()
    WHERE id = $1 AND status IN ('watching', 'almost_ready', 'ready')
    RETURNING *
  `, [candidateId, signalId]);
  const candidate = result.rows[0] ? mapCandidate(result.rows[0]) : null;
  if (candidate) await recordCandidateLearningEvent(candidate);
  return candidate;
}

export async function rejectCandidate(candidateId, reason) {
  const result = await query(`
    UPDATE setup_candidates
    SET status = 'rejected', rejection_reason = $2,
      last_checked_at = now(), updated_at = now()
    WHERE id = $1 AND status IN ('watching', 'almost_ready', 'ready')
    RETURNING *
  `, [candidateId, reason]);
  const candidate = result.rows[0] ? mapCandidate(result.rows[0]) : null;
  if (candidate) await recordCandidateLearningEvent(candidate);
  return candidate;
}

export async function recordCandidateLearningEvent(candidate, outcome = {}) {
  await query(`
    INSERT INTO candidate_learning_events (
      id, candidate_id, market, timeframe, direction, setup_type, initial_score,
      initial_setup_score, readiness_score, initial_readiness_score, final_status,
      would_have_hit_tp, would_have_hit_sl,
      went_nowhere, max_favorable_excursion, max_adverse_excursion,
      entry_never_filled, reason_not_promoted, detected_pattern, pattern_confidence,
      pattern_bias, pattern_expected_move, pattern_invalidation_hit, pattern_breakout_confirmed,
      resolved_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now())
    ON CONFLICT (candidate_id) DO UPDATE SET
      readiness_score = EXCLUDED.readiness_score,
      initial_readiness_score = COALESCE(candidate_learning_events.initial_readiness_score, EXCLUDED.initial_readiness_score),
      final_status = EXCLUDED.final_status,
      would_have_hit_tp = COALESCE(EXCLUDED.would_have_hit_tp, candidate_learning_events.would_have_hit_tp),
      would_have_hit_sl = COALESCE(EXCLUDED.would_have_hit_sl, candidate_learning_events.would_have_hit_sl),
      went_nowhere = COALESCE(EXCLUDED.went_nowhere, candidate_learning_events.went_nowhere),
      max_favorable_excursion = COALESCE(EXCLUDED.max_favorable_excursion, candidate_learning_events.max_favorable_excursion),
      max_adverse_excursion = COALESCE(EXCLUDED.max_adverse_excursion, candidate_learning_events.max_adverse_excursion),
      entry_never_filled = COALESCE(EXCLUDED.entry_never_filled, candidate_learning_events.entry_never_filled),
      reason_not_promoted = EXCLUDED.reason_not_promoted,
      detected_pattern = COALESCE(EXCLUDED.detected_pattern, candidate_learning_events.detected_pattern),
      pattern_confidence = COALESCE(EXCLUDED.pattern_confidence, candidate_learning_events.pattern_confidence),
      pattern_bias = COALESCE(EXCLUDED.pattern_bias, candidate_learning_events.pattern_bias),
      pattern_expected_move = COALESCE(EXCLUDED.pattern_expected_move, candidate_learning_events.pattern_expected_move),
      pattern_invalidation_hit = COALESCE(EXCLUDED.pattern_invalidation_hit, candidate_learning_events.pattern_invalidation_hit),
      pattern_breakout_confirmed = COALESCE(EXCLUDED.pattern_breakout_confirmed, candidate_learning_events.pattern_breakout_confirmed),
      resolved_at = now()
  `, [
    createId("clearn"), candidate.id, candidate.symbol, candidate.timeframe, candidate.direction,
    candidate.setupType, candidate.candidateScore, candidate.setupQualityScore || candidate.candidateScore,
    candidate.readinessScore, candidate.entryReadinessScore || candidate.readinessScore, candidate.status,
    outcome.wouldHaveHitTp ?? null, outcome.wouldHaveHitSl ?? null, outcome.wentNowhere ?? null,
    outcome.maxFavorableExcursion ?? null, outcome.maxAdverseExcursion ?? null,
    outcome.entryNeverFilled ?? null,
    candidate.rejectionReason || outcome.reasonNotPromoted || null,
    candidate.patternContext?.pattern || null,
    candidate.patternContext?.confidence ?? null,
    candidate.patternContext?.bias || null,
    outcome.wouldHaveHitTp ?? null,
    outcome.wouldHaveHitSl ?? null,
    candidate.patternContext ? candidate.patternContext.warnings?.length === 0 : null
  ]);
  await updateCandidateShadowAdjustment(candidate.id);
  await updatePatternShadowAdjustment(candidate.id);
  if (outcome.wouldHaveHitSl === true) {
    await query(`
      UPDATE avoid_trade_learning_events
      SET would_have_failed = true,
        resolved_at = COALESCE(resolved_at, now())
      WHERE market = $1
        AND timeframe = $2
        AND would_have_failed IS DISTINCT FROM true
        AND last_observed_at >= now() - interval '72 hours'
    `, [candidate.symbol, candidate.timeframe]);
  }
}

export async function recordPromotedCandidatePatternOutcome(signal) {
  const status = String(signal?.status || "");
  if (!signal?.id || !["Hit TP", "Hit SL", "Expired"].includes(status)) return 0;
  const result = await query(`
    UPDATE candidate_learning_events e
    SET final_status = $2,
      pattern_expected_move = CASE WHEN $2 = 'Hit TP' THEN true WHEN $2 = 'Hit SL' THEN false ELSE pattern_expected_move END,
      pattern_invalidation_hit = CASE WHEN $2 = 'Hit SL' THEN true WHEN $2 = 'Hit TP' THEN false ELSE pattern_invalidation_hit END,
      went_nowhere = CASE WHEN $2 = 'Expired' THEN true ELSE went_nowhere END,
      resolved_at = COALESCE($3::timestamptz, now())
    FROM setup_candidates c
    WHERE e.candidate_id = c.id
      AND c.promoted_signal_id = $1
      AND e.detected_pattern IS NOT NULL
    RETURNING e.candidate_id
  `, [signal.id, status, signal.resolvedAt || signal.statusUpdatedAt || null]);
  for (const row of result.rows) await updatePatternShadowAdjustment(row.candidate_id);
  return result.rowCount;
}

async function updateCandidateShadowAdjustment(candidateId) {
  await query(`
    WITH candidate_group AS (
      SELECT market, timeframe, setup_type
      FROM candidate_learning_events
      WHERE candidate_id = $1
    ), stats AS (
      SELECT COUNT(*) FILTER (
          WHERE would_have_hit_tp IS NOT NULL OR would_have_hit_sl IS NOT NULL
        )::integer AS sample_size,
        AVG(CASE WHEN would_have_hit_tp THEN 1.0 WHEN would_have_hit_sl THEN 0.0 END) AS observed_win_rate
      FROM candidate_learning_events e
      JOIN candidate_group g USING (market, timeframe, setup_type)
    )
    UPDATE candidate_learning_events e
    SET shadow_confidence_adjustment = CASE
          WHEN stats.observed_win_rate >= 0.60 THEN 2
          WHEN stats.observed_win_rate < 0.40 THEN -2
          ELSE 0
        END,
        shadow_adjustment_applied = false
    FROM stats
    WHERE e.candidate_id = $1
  `, [candidateId]);
}

async function updatePatternShadowAdjustment(candidateId) {
  await query(`
    WITH candidate_pattern AS (
      SELECT detected_pattern
      FROM candidate_learning_events
      WHERE candidate_id = $1 AND detected_pattern IS NOT NULL
    ), stats AS (
      SELECT COUNT(*) FILTER (
          WHERE pattern_expected_move IS NOT NULL OR pattern_invalidation_hit IS NOT NULL
        )::integer AS sample_size,
        AVG(CASE WHEN pattern_expected_move THEN 1.0 WHEN pattern_invalidation_hit THEN 0.0 END) AS observed_win_rate
      FROM candidate_learning_events e
      JOIN candidate_pattern p USING (detected_pattern)
    )
    UPDATE candidate_learning_events e
    SET pattern_sample_size = stats.sample_size,
        pattern_shadow_adjustment = CASE
          WHEN stats.sample_size < 30 THEN 0
          WHEN stats.observed_win_rate >= 0.60 THEN 2
          WHEN stats.observed_win_rate < 0.40 THEN -2
          ELSE 0
        END,
        pattern_adjustment_applied = false
    FROM stats
    WHERE e.candidate_id = $1
  `, [candidateId]);
}

export async function listCandidatesNeedingOutcome(limit = 20) {
  const result = await query(`
    SELECT c.* FROM setup_candidates c
    LEFT JOIN candidate_learning_events e ON e.candidate_id = c.id
    WHERE c.status IN ('rejected', 'expired')
      AND c.updated_at >= now() - interval '7 days'
      AND (e.candidate_id IS NULL OR (e.would_have_hit_tp IS NULL AND e.would_have_hit_sl IS NULL AND e.went_nowhere IS NULL))
    ORDER BY c.updated_at ASC
    LIMIT $1
  `, [Math.min(100, Math.max(1, Number(limit || 20)))]);
  return result.rows.map(mapCandidate);
}

export async function getCandidateQualitySummary() {
  const [result, reasons, entryQuality, avoidSummary, avoidReasons, avoidMarkets, avoidTimeframes, patterns, recentPatterns] = await Promise.all([query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at::date = current_date)::integer AS created_today,
      COUNT(*) FILTER (WHERE status = 'promoted_to_signal' AND updated_at::date = current_date)::integer AS promoted,
      COUNT(*) FILTER (WHERE status = 'rejected' AND updated_at::date = current_date)::integer AS rejected,
      COUNT(*) FILTER (WHERE status = 'expired' AND updated_at::date = current_date)::integer AS expired,
      COUNT(*) FILTER (WHERE status IN ('watching','almost_ready','ready'))::integer AS watching,
      (SELECT COUNT(*)::integer FROM paper_orders WHERE status = 'Expired unfilled' AND closed_at::date = current_date) AS expired_unfilled
    FROM setup_candidates
  `), query(`
    SELECT COALESCE(rejection_reason, 'Unspecified') AS reason, COUNT(*)::integer AS count
    FROM setup_candidates WHERE status IN ('rejected','expired')
    GROUP BY reason ORDER BY count DESC LIMIT 6
  `), query(`
    SELECT entry_quality, COUNT(*)::integer AS count
    FROM setup_candidates GROUP BY entry_quality ORDER BY count DESC
  `), query(`
    SELECT
      COALESCE((SELECT SUM(count)::integer FROM avoid_trade_learning_stats WHERE day = current_date), 0) AS today,
      COUNT(*) FILTER (WHERE became_good_signal IS TRUE)::integer AS became_signal,
      COUNT(*) FILTER (WHERE would_have_failed IS TRUE)::integer AS would_fail
    FROM avoid_trade_learning_events
  `), query(`
    SELECT reason, SUM(count)::integer AS count
    FROM avoid_trade_learning_stats
    WHERE day >= current_date - interval '7 days'
    GROUP BY reason ORDER BY count DESC LIMIT 6
  `), query(`
    SELECT market, SUM(count)::integer AS count
    FROM avoid_trade_learning_stats
    WHERE day >= current_date - interval '7 days'
    GROUP BY market ORDER BY count DESC LIMIT 6
  `), query(`
    SELECT timeframe, SUM(count)::integer AS count
    FROM avoid_trade_learning_stats
    WHERE day >= current_date - interval '7 days'
    GROUP BY timeframe ORDER BY count DESC LIMIT 6
  `), query(`
    SELECT detected_pattern AS pattern, COUNT(*)::integer AS count,
      ROUND(AVG(pattern_confidence)::numeric, 2) AS average_confidence
    FROM candidate_learning_events
    WHERE detected_pattern IS NOT NULL
    GROUP BY detected_pattern ORDER BY count DESC LIMIT 8
  `), query(`
    SELECT detected_pattern AS pattern, pattern_confidence AS confidence,
      pattern_bias AS bias, final_status, reason_not_promoted
    FROM candidate_learning_events
    WHERE detected_pattern IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 10
  `)]);
  const row = result.rows[0] || {};
  const total = Number(row.created_today || 0);
  return {
    candidatesCreatedToday: total,
    candidatesPromoted: Number(row.promoted || 0),
    candidatesRejected: Number(row.rejected || 0),
    candidatesExpired: Number(row.expired || 0),
    candidatesWatching: Number(row.watching || 0),
    pendingOrdersExpiredUnfilled: Number(row.expired_unfilled || 0),
    promotionRate: total ? Number(((Number(row.promoted || 0) / total) * 100).toFixed(1)) : 0,
    topRejectionReasons: reasons.rows.map((item) => ({ reason: item.reason, count: Number(item.count || 0) })),
    entryQualityDistribution: entryQuality.rows.map((item) => ({ quality: item.entry_quality, count: Number(item.count || 0) })),
    avoidTradesToday: Number(avoidSummary.rows[0]?.today || 0),
    avoidTradesLaterPromoted: Number(avoidSummary.rows[0]?.became_signal || 0),
    avoidTradesWouldHaveFailed: Number(avoidSummary.rows[0]?.would_fail || 0),
    topAvoidReasons: avoidReasons.rows.map((item) => ({ reason: item.reason, count: Number(item.count || 0) })),
    mostAvoidedMarkets: avoidMarkets.rows.map((item) => ({ market: item.market, count: Number(item.count || 0) })),
    mostAvoidedTimeframes: avoidTimeframes.rows.map((item) => ({ timeframe: item.timeframe, count: Number(item.count || 0) })),
    patternShadowSummary: patterns.rows.map((item) => ({
      pattern: item.pattern,
      count: Number(item.count || 0),
      averageConfidence: Number(item.average_confidence || 0)
    })),
    recentPatternObservations: recentPatterns.rows.map((item) => ({
      pattern: item.pattern,
      confidence: Number(item.confidence || 0),
      bias: item.bias,
      finalStatus: item.final_status,
      reason: item.reason_not_promoted || "Pattern remained context-only."
    }))
  };
}

export async function recordAvoidTradeLearningEvent(avoidTrade) {
  const observedAt = new Date(avoidTrade.createdAt || Date.now());
  const market = avoidTrade.symbol || avoidTrade.market || "unknown";
  const timeframe = avoidTrade.timeframe || "unknown";
  const reason = avoidTrade.reason || "Unspecified avoid-trade condition.";
  const dedupMinutes = appConfig.avoidTradeLearning.dedupMinutes;
  const bucket = Math.floor(observedAt.getTime() / (dedupMinutes * 60 * 1000));
  const eventKey = [market, timeframe, reason, bucket]
    .map((value) => String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .join(":");

  await recordAvoidTradeLearningStat({
    market,
    timeframe,
    reason,
    result: avoidTrade.result || "avoid_trade",
    observedAt
  });

  await query(`
    INSERT INTO avoid_trade_learning_events (
      id, event_key, market, timeframe, reason, reasons, market_condition,
      setup_quality_score, entry_readiness_score, created_at, last_observed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
    ON CONFLICT (event_key) DO UPDATE SET
      reasons = EXCLUDED.reasons,
      market_condition = EXCLUDED.market_condition,
      setup_quality_score = EXCLUDED.setup_quality_score,
      entry_readiness_score = EXCLUDED.entry_readiness_score,
      last_observed_at = EXCLUDED.last_observed_at
  `, [
    createId("avoid"), eventKey, market, timeframe,
    reason, JSON.stringify(avoidTrade.reasons || []), avoidTrade.marketCondition || "unknown",
    avoidTrade.setupQualityScore || 0, avoidTrade.entryReadinessScore || 0, observedAt
  ]);

  const now = Date.now();
  if (now >= nextAvoidTradeLearningCleanupAt) {
    nextAvoidTradeLearningCleanupAt = now + AVOID_TRADE_CLEANUP_INTERVAL_MS;
    cleanupAvoidTradeLearningEvents().catch((error) => {
      console.warn(`[avoid-learning] cleanup failed reason=${safeCleanupReason(error)}`);
    });
  }
}

export async function markRelatedAvoidTradesPromoted(symbol, timeframe) {
  const result = await query(`
    UPDATE avoid_trade_learning_events
    SET became_good_signal = true,
      resolved_at = COALESCE(resolved_at, now())
    WHERE market = $1
      AND timeframe = $2
      AND became_good_signal IS DISTINCT FROM true
      AND last_observed_at >= now() - interval '72 hours'
  `, [symbol, timeframe]);
  return result.rowCount;
}

async function recordAvoidTradeLearningStat({ market, timeframe, reason, result, observedAt }) {
  await query(`
    INSERT INTO avoid_trade_learning_stats (
      id, market, timeframe, reason, day, result, count, first_seen_at, last_seen_at
    ) VALUES ($1,$2,$3,$4,$5::date,$6,1,$7,$7)
    ON CONFLICT (market, timeframe, reason, day, result) DO UPDATE SET
      count = avoid_trade_learning_stats.count + 1,
      last_seen_at = EXCLUDED.last_seen_at
  `, [
    createId("avoidstat"), market, timeframe, reason,
    observedAt.toISOString().slice(0, 10), result || "avoid_trade", observedAt
  ]);
}

export async function cleanupAvoidTradeLearningEvents() {
  const retentionDays = appConfig.avoidTradeLearning.retentionDays;
  const maxRows = appConfig.avoidTradeLearning.maxRows;
  const dedupMinutes = appConfig.avoidTradeLearning.dedupMinutes;

  const oldRows = await query(`
    WITH deleted AS (
      DELETE FROM avoid_trade_learning_events
      WHERE created_at < now() - make_interval(days => $1::int)
      RETURNING 1
    )
    SELECT COUNT(*)::integer AS deleted FROM deleted
  `, [retentionDays]);

  const duplicateRows = await query(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY
            market,
            timeframe,
            reason,
            floor(extract(epoch from created_at) / ($1::numeric * 60))
          ORDER BY created_at DESC, id DESC
        ) AS row_number
      FROM avoid_trade_learning_events
      WHERE created_at >= now() - make_interval(days => $2::int)
    ), deleted AS (
      DELETE FROM avoid_trade_learning_events e
      USING ranked r
      WHERE e.id = r.id
        AND r.row_number > 1
      RETURNING 1
    )
    SELECT COUNT(*)::integer AS deleted FROM deleted
  `, [dedupMinutes, retentionDays]);

  const cappedRows = await query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS row_number
      FROM avoid_trade_learning_events
    ), deleted AS (
      DELETE FROM avoid_trade_learning_events e
      USING ranked r
      WHERE e.id = r.id
        AND r.row_number > $1
      RETURNING 1
    )
    SELECT COUNT(*)::integer AS deleted FROM deleted
  `, [maxRows]);

  const deletedOld = Number(oldRows.rows[0]?.deleted || 0);
  const deletedDuplicates = Number(duplicateRows.rows[0]?.deleted || 0);
  const deletedOverCap = Number(cappedRows.rows[0]?.deleted || 0);
  if (deletedOld || deletedDuplicates || deletedOverCap) {
    try {
      await query("VACUUM (ANALYZE) avoid_trade_learning_events");
      await query("ANALYZE avoid_trade_learning_stats");
    } catch (error) {
      console.warn(`[avoid-learning] vacuum skipped reason=${safeCleanupReason(error)}`);
      await query("ANALYZE avoid_trade_learning_events").catch(() => {});
      await query("ANALYZE avoid_trade_learning_stats").catch(() => {});
    }
  }

  console.info(
    `[avoid-learning] cleanup deleted_old=${deletedOld} deleted_duplicates=${deletedDuplicates} ` +
    `deleted_over_cap=${deletedOverCap} retention_days=${retentionDays} ` +
    `max_rows=${maxRows} dedup_minutes=${dedupMinutes}`
  );

  return { deletedOld, deletedDuplicates, deletedOverCap };
}

export function startAvoidTradeLearningCleanupJob() {
  if (avoidTradeLearningCleanupTimer) return avoidTradeLearningCleanupTimer;

  cleanupAvoidTradeLearningEvents().catch((error) => {
    console.warn(`[avoid-learning] startup cleanup failed reason=${safeCleanupReason(error)}`);
  });

  avoidTradeLearningCleanupTimer = setInterval(() => {
    cleanupAvoidTradeLearningEvents().catch((error) => {
      console.warn(`[avoid-learning] scheduled cleanup failed reason=${safeCleanupReason(error)}`);
    });
  }, AVOID_TRADE_CLEANUP_INTERVAL_MS);
  avoidTradeLearningCleanupTimer.unref?.();
  return avoidTradeLearningCleanupTimer;
}

function safeCleanupReason(error) {
  return String(error?.code || error?.message || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function mapCandidate(row) {
  if (!row) return null;
  return {
    id: row.id, setupKey: row.setup_key, symbol: row.symbol,
    displayPair: row.display_pair || String(row.symbol || "").replace(/[-/]/g, ""), provider: row.provider,
    timeframe: row.timeframe, direction: row.direction, setupType: row.setup_type,
    status: row.status, firstDetectedAt: row.first_detected_at, lastCheckedAt: row.last_checked_at,
    expiresAt: row.expires_at, candidateScore: Number(row.candidate_score || 0),
    setupQualityScore: Number(row.setup_quality_score ?? row.candidate_score ?? 0),
    readinessScore: Number(row.readiness_score || 0),
    entryReadinessScore: Number(row.entry_readiness_score ?? row.readiness_score ?? 0),
    confidenceEstimate: Number(row.confidence_estimate || 0),
    entryQuality: row.entry_quality, currentPrice: Number(row.current_price || 0),
    idealEntry: Number(row.ideal_entry || 0), idealEntryZone: row.ideal_entry_zone || {},
    invalidationLevel: Number(row.invalidation_level || 0),
    potentialStopLoss: Number(row.potential_stop_loss || 0), potentialTakeProfit: Number(row.potential_take_profit || 0),
    potentialRr: Number(row.potential_rr || 0), reasonsForWatching: row.reasons_for_watching || [],
    missingConfirmations: row.missing_confirmations || [], nextConditions: row.next_conditions || [],
    rejectionReason: row.rejection_reason,
    promotedSignalId: row.promoted_signal_id || null,
    metadata: row.metadata || {},
    patternContext: row.metadata?.patternContext || null
  };
}
