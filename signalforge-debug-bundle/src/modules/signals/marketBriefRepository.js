import { query } from "../../db/client.js";

export async function upsertMarketBriefObservations(observations, scannerSnapshotId) {
  if (!observations.length) return;
  const rows = observations.map((observation) => ({
    symbol: observation.symbol,
    timeframe: observation.timeframe,
    scanner_snapshot_id: scannerSnapshotId,
    observation,
    observed_at: new Date(observation.observedAt || Date.now()).toISOString()
  }));
  await query(`
    INSERT INTO daily_market_brief_observations (
      symbol, timeframe, scanner_snapshot_id, observation, observed_at
    )
    SELECT symbol, timeframe, scanner_snapshot_id, observation, observed_at
    FROM jsonb_to_recordset($1::jsonb) AS input(
      symbol text,
      timeframe text,
      scanner_snapshot_id text,
      observation jsonb,
      observed_at timestamptz
    )
    ON CONFLICT (symbol, timeframe) DO UPDATE SET
      scanner_snapshot_id = EXCLUDED.scanner_snapshot_id,
      observation = EXCLUDED.observation,
      observed_at = EXCLUDED.observed_at
  `, [JSON.stringify(rows)]);
}

export async function listRecentMarketBriefObservations(maxAgeHours = 24) {
  const result = await query(`
    SELECT observation
    FROM daily_market_brief_observations
    WHERE observed_at >= now() - make_interval(hours => $1::integer)
    ORDER BY observed_at DESC
  `, [Math.min(72, Math.max(1, Number(maxAgeHours || 24)))]);
  return result.rows.map((row) => row.observation).filter(Boolean);
}

export async function saveLatestMarketBrief(brief) {
  const result = await query(`
    INSERT INTO daily_market_briefs (
      id, scope, generated_at, market_condition, strongest_pairs, weakest_pairs,
      watching_count, avoid_count, ready_signal_count, main_reasons, pair_summaries,
      watching_breakdown, scanner_snapshot_id, pairs_scanned
    ) VALUES ($1,'crypto',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (scope) DO UPDATE SET
      id = EXCLUDED.id,
      generated_at = EXCLUDED.generated_at,
      market_condition = EXCLUDED.market_condition,
      strongest_pairs = EXCLUDED.strongest_pairs,
      weakest_pairs = EXCLUDED.weakest_pairs,
      watching_count = EXCLUDED.watching_count,
      avoid_count = EXCLUDED.avoid_count,
      ready_signal_count = EXCLUDED.ready_signal_count,
      main_reasons = EXCLUDED.main_reasons,
      pair_summaries = EXCLUDED.pair_summaries,
      watching_breakdown = EXCLUDED.watching_breakdown,
      scanner_snapshot_id = EXCLUDED.scanner_snapshot_id,
      pairs_scanned = EXCLUDED.pairs_scanned,
      updated_at = now()
    RETURNING *
  `, [
    brief.id, brief.generatedAt, brief.marketCondition,
    JSON.stringify(brief.strongestPairs), JSON.stringify(brief.weakestPairs),
    brief.watchingCount, brief.avoidCount, brief.readySignalCount,
    JSON.stringify(brief.mainReasons), JSON.stringify(brief.pairSummaries),
    JSON.stringify(brief.watchingBreakdown || []), brief.scannerSnapshotId, brief.pairsScanned
  ]);
  return mapBrief(result.rows[0]);
}

export async function findLatestMarketBrief() {
  const result = await query(`
    SELECT * FROM daily_market_briefs WHERE scope = 'crypto' LIMIT 1
  `);
  return mapBrief(result.rows[0]);
}

function mapBrief(row) {
  if (!row) return null;
  return {
    id: row.id,
    generatedAt: row.generated_at,
    marketCondition: row.market_condition,
    strongestPairs: row.strongest_pairs || [],
    weakestPairs: row.weakest_pairs || [],
    watchingCount: Number(row.watching_count || 0),
    avoidCount: Number(row.avoid_count || 0),
    readySignalCount: Number(row.ready_signal_count || 0),
    mainReasons: row.main_reasons || [],
    pairSummaries: row.pair_summaries || [],
    watchingBreakdown: row.watching_breakdown || [],
    scannerSnapshotId: row.scanner_snapshot_id,
    pairsScanned: Number(row.pairs_scanned || 0),
    available: true
  };
}
