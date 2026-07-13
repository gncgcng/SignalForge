import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

export async function upsertSetupCandidate(candidate) {
  const result = await query(`
    INSERT INTO setup_candidates (
      id, setup_key, symbol, provider, timeframe, direction, setup_type, status,
      expires_at, candidate_score, readiness_score, confidence_estimate, entry_quality,
      current_price, ideal_entry_zone, invalidation_level, potential_stop_loss,
      potential_take_profit, potential_rr, reasons_for_watching, missing_confirmations,
      rejection_reason, promoted_signal_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (setup_key) DO UPDATE SET
      status = CASE
        WHEN setup_candidates.status IN ('promoted_to_signal', 'rejected', 'expired') THEN setup_candidates.status
        ELSE EXCLUDED.status
      END,
      last_checked_at = now(),
      expires_at = EXCLUDED.expires_at,
      candidate_score = EXCLUDED.candidate_score,
      readiness_score = EXCLUDED.readiness_score,
      confidence_estimate = EXCLUDED.confidence_estimate,
      entry_quality = EXCLUDED.entry_quality,
      current_price = EXCLUDED.current_price,
      ideal_entry_zone = EXCLUDED.ideal_entry_zone,
      invalidation_level = EXCLUDED.invalidation_level,
      potential_stop_loss = EXCLUDED.potential_stop_loss,
      potential_take_profit = EXCLUDED.potential_take_profit,
      potential_rr = EXCLUDED.potential_rr,
      reasons_for_watching = EXCLUDED.reasons_for_watching,
      missing_confirmations = EXCLUDED.missing_confirmations,
      rejection_reason = COALESCE(EXCLUDED.rejection_reason, setup_candidates.rejection_reason),
      promoted_signal_id = COALESCE(EXCLUDED.promoted_signal_id, setup_candidates.promoted_signal_id),
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `, [
    candidate.id || createId("cand"), candidate.setupKey, candidate.symbol, candidate.provider,
    candidate.timeframe, candidate.direction, candidate.setupType, candidate.status,
    candidate.expiresAt, candidate.candidateScore, candidate.readinessScore,
    candidate.confidenceEstimate, candidate.entryQuality, candidate.currentPrice,
    JSON.stringify(candidate.idealEntryZone || {}), candidate.invalidationLevel,
    candidate.potentialStopLoss, candidate.potentialTakeProfit, candidate.potentialRr,
    JSON.stringify(candidate.reasonsForWatching || []), JSON.stringify(candidate.missingConfirmations || []),
    candidate.rejectionReason || null, candidate.promotedSignalId || null,
    JSON.stringify(candidate.metadata || {})
  ]);
  return mapCandidate(result.rows[0]);
}

export async function listVisibleSetupCandidates(limit = 40) {
  const result = await query(`
    SELECT * FROM setup_candidates
    WHERE status IN ('watching', 'ready', 'rejected', 'expired')
      AND updated_at >= now() - interval '72 hours'
    ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'watching' THEN 1 ELSE 2 END,
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
    WHERE status IN ('watching', 'ready') AND expires_at <= now()
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
    WHERE id = $1 AND status IN ('watching', 'ready')
    RETURNING *
  `, [candidateId, signalId]);
  return result.rows[0] ? mapCandidate(result.rows[0]) : null;
}

export async function rejectCandidate(candidateId, reason) {
  const result = await query(`
    UPDATE setup_candidates
    SET status = 'rejected', rejection_reason = $2,
      last_checked_at = now(), updated_at = now()
    WHERE id = $1 AND status IN ('watching', 'ready')
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
      readiness_score, final_status, would_have_hit_tp, would_have_hit_sl,
      went_nowhere, max_favorable_excursion, max_adverse_excursion,
      reason_not_promoted, resolved_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
    ON CONFLICT (candidate_id) DO UPDATE SET
      readiness_score = EXCLUDED.readiness_score,
      final_status = EXCLUDED.final_status,
      would_have_hit_tp = COALESCE(EXCLUDED.would_have_hit_tp, candidate_learning_events.would_have_hit_tp),
      would_have_hit_sl = COALESCE(EXCLUDED.would_have_hit_sl, candidate_learning_events.would_have_hit_sl),
      went_nowhere = COALESCE(EXCLUDED.went_nowhere, candidate_learning_events.went_nowhere),
      max_favorable_excursion = COALESCE(EXCLUDED.max_favorable_excursion, candidate_learning_events.max_favorable_excursion),
      max_adverse_excursion = COALESCE(EXCLUDED.max_adverse_excursion, candidate_learning_events.max_adverse_excursion),
      reason_not_promoted = EXCLUDED.reason_not_promoted,
      resolved_at = now()
  `, [
    createId("clearn"), candidate.id, candidate.symbol, candidate.timeframe, candidate.direction,
    candidate.setupType, candidate.candidateScore, candidate.readinessScore, candidate.status,
    outcome.wouldHaveHitTp ?? null, outcome.wouldHaveHitSl ?? null, outcome.wentNowhere ?? null,
    outcome.maxFavorableExcursion ?? null, outcome.maxAdverseExcursion ?? null,
    candidate.rejectionReason || outcome.reasonNotPromoted || null
  ]);
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
  const [result, reasons, entryQuality] = await Promise.all([query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at::date = current_date)::integer AS created_today,
      COUNT(*) FILTER (WHERE status = 'promoted_to_signal' AND updated_at::date = current_date)::integer AS promoted,
      COUNT(*) FILTER (WHERE status = 'rejected' AND updated_at::date = current_date)::integer AS rejected,
      COUNT(*) FILTER (WHERE status = 'expired' AND updated_at::date = current_date)::integer AS expired,
      COUNT(*) FILTER (WHERE status IN ('watching','ready'))::integer AS watching,
      (SELECT COUNT(*)::integer FROM paper_orders WHERE status = 'Expired unfilled' AND closed_at::date = current_date) AS expired_unfilled
    FROM setup_candidates
  `), query(`
    SELECT COALESCE(rejection_reason, 'Unspecified') AS reason, COUNT(*)::integer AS count
    FROM setup_candidates WHERE status IN ('rejected','expired')
    GROUP BY reason ORDER BY count DESC LIMIT 6
  `), query(`
    SELECT entry_quality, COUNT(*)::integer AS count
    FROM setup_candidates GROUP BY entry_quality ORDER BY count DESC
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
    entryQualityDistribution: entryQuality.rows.map((item) => ({ quality: item.entry_quality, count: Number(item.count || 0) }))
  };
}

function mapCandidate(row) {
  if (!row) return null;
  return {
    id: row.id, setupKey: row.setup_key, symbol: row.symbol, provider: row.provider,
    timeframe: row.timeframe, direction: row.direction, setupType: row.setup_type,
    status: row.status, firstDetectedAt: row.first_detected_at, lastCheckedAt: row.last_checked_at,
    expiresAt: row.expires_at, candidateScore: Number(row.candidate_score || 0),
    readinessScore: Number(row.readiness_score || 0), confidenceEstimate: Number(row.confidence_estimate || 0),
    entryQuality: row.entry_quality, currentPrice: Number(row.current_price || 0),
    idealEntryZone: row.ideal_entry_zone || {}, invalidationLevel: Number(row.invalidation_level || 0),
    potentialStopLoss: Number(row.potential_stop_loss || 0), potentialTakeProfit: Number(row.potential_take_profit || 0),
    potentialRr: Number(row.potential_rr || 0), reasonsForWatching: row.reasons_for_watching || [],
    missingConfirmations: row.missing_confirmations || [], rejectionReason: row.rejection_reason,
    promotedSignalId: row.promoted_signal_id || null
  };
}
