import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

const terminalPriority = Object.freeze({ "Hit TP": 6, "Hit SL": 5, "Manually closed": 4, Expired: 3, Active: 2 });

export async function upsertGeneratedSignal(signal, context = {}) {
  const dedupeKey = buildGeneratedSignalKey(signal);
  const pattern = signal.patternContext || signal.indicators?.patternContext || null;
  const source = normalizeSource(context.source);
  const result = await query(`
    INSERT INTO generated_signals (
      id, signal_id, dedupe_key, setup_key, pair, display_pair, provider, timeframe, direction,
      strategy, pattern, pattern_context, entry, stop_loss, take_profit, risk_reward, confidence,
      original_confidence, confidence_calibration,
      setup_quality_score, entry_readiness_score, status, valid_until, source, source_history,
      generated_by, promoted_from_candidate_id, validation_summary, warning_reasons,
      quality_breakdown, full_analysis, result_reason, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,jsonb_build_array($24::text),$25,$26,$27,$28,$29,$30,$31,$32,now())
    ON CONFLICT (dedupe_key) DO UPDATE SET
      source_history = (SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements_text(generated_signals.source_history || jsonb_build_array(EXCLUDED.source)) AS sources(value)),
      promoted_from_candidate_id = COALESCE(generated_signals.promoted_from_candidate_id, EXCLUDED.promoted_from_candidate_id),
      confidence = EXCLUDED.confidence,
      original_confidence = COALESCE(generated_signals.original_confidence, EXCLUDED.original_confidence),
      confidence_calibration = EXCLUDED.confidence_calibration,
      validation_summary = EXCLUDED.validation_summary,
      warning_reasons = EXCLUDED.warning_reasons,
      quality_breakdown = EXCLUDED.quality_breakdown,
      full_analysis = EXCLUDED.full_analysis,
      result_reason = COALESCE(EXCLUDED.result_reason, generated_signals.result_reason),
      updated_at = now()
    RETURNING *
  `, [
    createId("agen"), signal.id, dedupeKey, signal.setupKey || null, signal.symbol,
    displayPair(signal.symbol), signal.marketSource || "unknown", signal.timeframe, signal.direction,
    signal.setupType || "Qualified setup", pattern?.pattern || null, JSON.stringify(pattern || {}),
    signal.entryPrice, signal.stopLoss, signal.takeProfit, signal.riskRewardRatio,
    signal.confidenceScore, signal.confidenceCalibration?.originalConfidence ?? signal.indicators?.confidenceCalibration?.originalConfidence ?? signal.confidenceScore,
    JSON.stringify(signal.confidenceCalibration || signal.indicators?.confidenceCalibration || {}),
    signal.qualityScore || 0,
    signal.readinessScore ?? signal.indicators?.readinessScore ?? 0,
    signal.status || "Active", signal.validUntil,
    source, String(context.generatedBy || "system"), context.candidateId || null,
    JSON.stringify({ passed: signal.validationPassed !== false, score: signal.validationScore ?? 100, reasons: signal.rejectedReasons || [] }),
    JSON.stringify(signal.rejectedReasons || pattern?.warnings || []),
    JSON.stringify(signal.signalQuality || {}),
    JSON.stringify(toFullAnalysis(signal)),
    signal.resultReason || signal.statusReason || signal.indicators?.generatedQualityBlockReason || null,
    signal.generatedAt || new Date()
  ]);
  await recordGeneratedSignalConfidenceAdjustment(result.rows[0], signal);
  return mapGeneratedSignal(result.rows[0]);
}

export async function listGeneratedSignals(filters = {}) {
  const values = [];
  const clauses = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (filters.status && filters.status !== "all") {
    if (filters.status === "closed") clauses.push("g.status IN ('Hit TP','Hit SL','Expired','Manually closed')");
    else if (filters.status === "expiring-soon") clauses.push("g.status = 'Active' AND g.valid_until > now() AND g.valid_until <= now() + LEAST(interval '30 minutes', (g.valid_until - g.created_at) * 0.2)");
    else add("g.status = ?", filters.status);
  }
  if (filters.pair) {
    values.push(filters.pair);
    clauses.push(`(g.pair ILIKE $${values.length} OR g.display_pair ILIKE replace(replace($${values.length}, '-', ''), '/', ''))`);
  }
  if (filters.timeframe) add("g.timeframe = ?", filters.timeframe);
  if (filters.direction) add("g.direction = ?", filters.direction);
  if (filters.strategy) { values.push(`%${filters.strategy}%`); clauses.push(`g.strategy ILIKE $${values.length}`); }
  if (filters.pattern) { values.push(`%${filters.pattern}%`); clauses.push(`COALESCE(g.pattern,'') ILIKE $${values.length}`); }
  if (filters.source) {
    values.push(filters.source);
    clauses.push(`(g.source = $${values.length} OR g.source_history ? $${values.length})`);
  }
  if (Number.isFinite(filters.confidenceMin)) add("g.confidence >= ?", filters.confidenceMin);
  if (Number.isFinite(filters.confidenceMax)) add("g.confidence <= ?", filters.confidenceMax);
  if (Number.isFinite(filters.qualityMin)) add("g.setup_quality_score >= ?", filters.qualityMin);
  if (Number.isFinite(filters.qualityMax)) add("g.setup_quality_score <= ?", filters.qualityMax);
  if (filters.from) add("g.created_at >= ?::timestamptz", filters.from);
  if (filters.to) add("g.created_at <= ?::timestamptz", filters.to);
  if (filters.search) {
    values.push(`%${filters.search}%`);
    clauses.push(`(g.pair ILIKE $${values.length} OR g.display_pair ILIKE $${values.length} OR g.strategy ILIKE $${values.length} OR COALESCE(g.pattern,'') ILIKE $${values.length} OR g.signal_id ILIKE $${values.length} OR g.full_analysis::text ILIKE $${values.length})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sort = {
    oldest: "g.created_at ASC", confidence: "g.confidence DESC, g.created_at DESC",
    rr: "g.risk_reward DESC, g.created_at DESC", newest: "g.created_at DESC"
  }[filters.sort] || "g.created_at DESC";
  const page = Math.max(1, Number(filters.page || 1));
  const limit = Math.min(100, Math.max(10, Number(filters.limit || 25)));
  values.push(limit, (page - 1) * limit);
  const [rows, count] = await Promise.all([
    query(`SELECT g.*, CASE WHEN g.status = 'Active' AND g.valid_until <= now() + LEAST(interval '30 minutes', (g.valid_until - g.created_at) * 0.2) THEN true ELSE false END AS expiring_soon FROM generated_signals g ${where} ORDER BY ${sort} LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
    query(`SELECT COUNT(*)::integer AS total FROM generated_signals g ${where}`, values.slice(0, -2))
  ]);
  return { signals: rows.rows.map(mapGeneratedSignal), page, limit, total: Number(count.rows[0]?.total || 0), totalPages: Math.max(1, Math.ceil(Number(count.rows[0]?.total || 0) / limit)) };
}

export async function getGeneratedSignalById(id) {
  const result = await query(`
    SELECT g.*, c.status AS candidate_status, c.candidate_score, c.readiness_score,
      c.missing_confirmations, c.first_detected_at, c.last_checked_at,
      cle.max_favorable_excursion, cle.max_adverse_excursion,
      COALESCE(sle.post_mortem_tags, g.post_mortem_tags) AS resolved_post_mortem_tags
    FROM generated_signals g
    LEFT JOIN setup_candidates c ON c.id = g.promoted_from_candidate_id
    LEFT JOIN candidate_learning_events cle ON cle.candidate_id = c.id
    LEFT JOIN signal_learning_events sle ON sle.signal_id = g.signal_id
    WHERE g.id = $1
  `, [id]);
  return mapGeneratedSignal(result.rows[0]);
}

export async function getGeneratedSignalStats() {
  const result = await query(`
    SELECT COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE status = 'Active' AND valid_until > now())::integer AS active,
      COUNT(*) FILTER (WHERE status = 'Active' AND valid_until > now() AND valid_until <= now() + LEAST(interval '30 minutes', (valid_until-created_at)*0.2))::integer AS expiring_soon,
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COUNT(*) FILTER (WHERE status = 'Expired')::integer AS expired,
      COUNT(*) FILTER (WHERE status = 'Duplicate blocked')::integer AS duplicate_blocked,
      COUNT(*) FILTER (WHERE status = 'Cooldown blocked')::integer AS cooldown_blocked,
      COUNT(*) FILTER (WHERE status = 'Correlated duplicate')::integer AS correlated_duplicate,
      COUNT(*) FILTER (WHERE status = 'Quarantined timeframe')::integer AS quarantined_timeframe,
      COUNT(*) FILTER (WHERE status = 'Readiness failed')::integer AS readiness_failed,
      COUNT(*) FILTER (WHERE status = 'Invalid legacy ready signal')::integer AS invalid_legacy_ready,
      COUNT(*) FILTER (WHERE created_at::date = current_date)::integer AS today,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::integer AS week,
      COALESCE(AVG(risk_reward),0) AS average_rr,
      COALESCE(AVG(confidence),0) AS average_confidence
    FROM generated_signals
  `);
  const row = result.rows[0] || {};
  const closed = Number(row.hit_tp || 0) + Number(row.hit_sl || 0);
  return { total: Number(row.total || 0), active: Number(row.active || 0), expiringSoon: Number(row.expiring_soon || 0), hitTp: Number(row.hit_tp || 0), hitSl: Number(row.hit_sl || 0), expired: Number(row.expired || 0), duplicateBlocked: Number(row.duplicate_blocked || 0), cooldownBlocked: Number(row.cooldown_blocked || 0), correlatedDuplicate: Number(row.correlated_duplicate || 0), quarantinedTimeframe: Number(row.quarantined_timeframe || 0), readinessFailed: Number(row.readiness_failed || 0), invalidLegacyReady: Number(row.invalid_legacy_ready || 0), today: Number(row.today || 0), week: Number(row.week || 0), winRate: closed ? Number(((Number(row.hit_tp) / closed) * 100).toFixed(1)) : 0, averageRiskReward: Number(Number(row.average_rr || 0).toFixed(2)), averageConfidence: Number(Number(row.average_confidence || 0).toFixed(1)) };
}

export async function listActiveGeneratedSignals(limit = 500) {
  const result = await query("SELECT * FROM generated_signals WHERE status = 'Active' ORDER BY created_at ASC LIMIT $1", [limit]);
  return result.rows.map(mapGeneratedSignal);
}

export async function updateGeneratedSignalStatus(id, status, details = {}) {
  const result = await query(`
    UPDATE generated_signals SET
      status = CASE WHEN (CASE status WHEN 'Hit TP' THEN 6 WHEN 'Hit SL' THEN 5 WHEN 'Manually closed' THEN 4 WHEN 'Expired' THEN 3 ELSE 2 END) > $3 THEN status ELSE $2 END,
      hit_tp_at = CASE WHEN $2 = 'Hit TP' THEN COALESCE(hit_tp_at,$4) ELSE hit_tp_at END,
      hit_sl_at = CASE WHEN $2 = 'Hit SL' THEN COALESCE(hit_sl_at,$4) ELSE hit_sl_at END,
      manually_closed_at = CASE WHEN $2 = 'Manually closed' THEN COALESCE(manually_closed_at,$4) ELSE manually_closed_at END,
      expired_at = CASE WHEN $2 = 'Expired' AND status NOT IN ('Hit TP','Hit SL','Manually closed') THEN COALESCE(expired_at,$4) ELSE expired_at END,
      result_reason = COALESCE($5,result_reason), updated_at = now()
    WHERE id = $1 RETURNING *
  `, [id, status, terminalPriority[status] || 2, details.resolvedAt || new Date(), details.reason || null]);
  return mapGeneratedSignal(result.rows[0]);
}

export async function syncGeneratedSignalOutcome(signal) {
  if (!signal?.id || !signal.status) return null;
  const result = await query("SELECT id FROM generated_signals WHERE signal_id = $1 OR setup_key = $2 LIMIT 1", [signal.id, signal.setupKey || null]);
  if (!result.rows[0]) return null;
  const id = result.rows[0].id;
  await query(`UPDATE generated_signals SET
    post_mortem_tags = CASE WHEN $2::jsonb = '[]'::jsonb THEN post_mortem_tags ELSE $2::jsonb END,
    max_favorable_excursion = COALESCE($3, max_favorable_excursion),
    max_adverse_excursion = COALESCE($4, max_adverse_excursion),
    result_reason = COALESCE($5, result_reason), updated_at = now()
    WHERE id = $1`, [
    id,
    JSON.stringify(signal.postMortemTags || signal.postMortem?.tags || []),
    finiteOrNull(signal.maxFavorableExcursion ?? signal.postMortem?.maxFavorableExcursion),
    finiteOrNull(signal.maxAdverseExcursion ?? signal.postMortem?.maxAdverseExcursion),
    signal.statusReason || signal.postMortem?.summary || null
  ]);
  return updateGeneratedSignalStatus(id, signal.status, { resolvedAt: signal.resolvedAt, reason: signal.statusReason });
}

export function buildGeneratedSignalKey(signal) {
  if (signal.setupKey) return String(signal.setupKey).toLowerCase();
  const created = new Date(signal.generatedAt || Date.now()).getTime();
  const windowMs = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 }[signal.timeframe] || 900000;
  return [signal.symbol, signal.timeframe, signal.direction, signal.setupType, Number(signal.entryPrice).toPrecision(10), Math.floor(created / windowMs)].join(":").toLowerCase();
}

function toFullAnalysis(signal) { return { reasoning: signal.reasoning, confirmations: signal.confirmations || [], indicators: signal.indicators || {}, analyst: signal.analyst || null, marketStructure: signal.marketStructure || null, smc: signal.smc || null, confluence: signal.confluence || null, riskPlan: signal.riskPlan || null, patternContext: signal.patternContext || signal.indicators?.patternContext || null }; }
function normalizeSource(source) { return ["manual_scan","auto_crypto_watcher","telegram_alert","candidate_promotion","backtest_shadow","admin_test","legacy_saved_signal","legacy_unlocked_signal"].includes(source) ? source : "manual_scan"; }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function displayPair(symbol) { return String(symbol || "").toUpperCase().replace(/[-/]/g, ""); }
function mapGeneratedSignal(row) { if (!row) return null; return { id: row.id, signalId: row.signal_id, setupKey: row.setup_key, pair: row.pair, displayPair: row.display_pair, provider: row.provider, timeframe: row.timeframe, direction: row.direction, strategy: row.strategy, pattern: row.pattern, patternContext: row.pattern_context || {}, entry: Number(row.entry), stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit), riskReward: Number(row.risk_reward), confidence: Number(row.confidence), originalConfidence: row.original_confidence == null ? Number(row.confidence) : Number(row.original_confidence), finalConfidence: Number(row.confidence), confidenceCalibration: row.confidence_calibration || {}, setupQualityScore: Number(row.setup_quality_score || 0), entryReadinessScore: Number(row.entry_readiness_score || 0), status: row.status, expiringSoon: Boolean(row.expiring_soon), validUntil: row.valid_until, expiredAt: row.expired_at, hitTpAt: row.hit_tp_at, hitSlAt: row.hit_sl_at, source: row.source, sourceHistory: row.source_history || [], generatedBy: row.generated_by, promotedFromCandidateId: row.promoted_from_candidate_id, validationSummary: row.validation_summary || {}, warningReasons: row.warning_reasons || [], qualityBreakdown: row.quality_breakdown || {}, fullAnalysis: row.full_analysis || {}, postMortemTags: row.resolved_post_mortem_tags || row.post_mortem_tags || [], maxFavorableExcursion: row.max_favorable_excursion == null ? null : Number(row.max_favorable_excursion), maxAdverseExcursion: row.max_adverse_excursion == null ? null : Number(row.max_adverse_excursion), resultReason: row.result_reason, candidateOrigin: row.candidate_status ? { status: row.candidate_status, setupQualityScore: Number(row.candidate_score || 0), entryReadinessScore: Number(row.readiness_score || 0), missingConfirmations: row.missing_confirmations || [], firstDetectedAt: row.first_detected_at, lastCheckedAt: row.last_checked_at } : null, createdAt: row.created_at, updatedAt: row.updated_at }; }

async function recordGeneratedSignalConfidenceAdjustment(row, signal) {
  const calibration = signal.confidenceCalibration || signal.indicators?.confidenceCalibration || {};
  if (!calibration?.originalConfidence && !calibration?.totalPenalty && !calibration?.confidenceCap) return;
  await query(`
    INSERT INTO signal_confidence_adjustments (
      id, signal_id, group_key, original_confidence, final_confidence,
      confidence_cap, penalty, reason, context, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (id) DO UPDATE SET
      original_confidence = EXCLUDED.original_confidence,
      final_confidence = EXCLUDED.final_confidence,
      confidence_cap = EXCLUDED.confidence_cap,
      penalty = EXCLUDED.penalty,
      reason = EXCLUDED.reason,
      context = EXCLUDED.context,
      created_at = now()
  `, [
    `scadj_${hash(row.id)}`,
    row.signal_id,
    calibration.groups?.[0]?.groupKey || null,
    calibration.originalConfidence ?? row.original_confidence ?? row.confidence,
    calibration.finalConfidence ?? row.confidence,
    calibration.confidenceCap ?? null,
    calibration.totalPenalty ?? 0,
    calibration.message || null,
    JSON.stringify(calibration)
  ]);
}

function hash(value) {
  let result = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    result = ((result << 5) - result + text.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(16);
}
