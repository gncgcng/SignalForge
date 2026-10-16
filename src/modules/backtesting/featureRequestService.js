import { query } from "../../db/client.js";

// "Want stocks & ETFs? Tell us" on the backtesting page. One row per user and feature: clicking again is not counted
// again. Nothing here fetches stock data; it only measures demand.
export const STOCKS_ETFS_FEATURE = "stocks_etfs";

export async function recordFeatureRequest(userId, feature = STOCKS_ETFS_FEATURE) {
  const result = await query(`INSERT INTO feature_requests (user_id, feature) VALUES ($1, $2)
    ON CONFLICT (user_id, feature) DO NOTHING`, [userId, feature]);
  return { requested: true, counted: result.rowCount === 1 };
}

export async function hasFeatureRequest(userId, feature = STOCKS_ETFS_FEATURE) {
  const result = await query("SELECT 1 FROM feature_requests WHERE user_id = $1 AND feature = $2", [userId, feature]);
  return result.rows.length > 0;
}

export async function countFeatureRequests(feature = STOCKS_ETFS_FEATURE) {
  const result = await query("SELECT COUNT(*)::integer AS count FROM feature_requests WHERE feature = $1", [feature]);
  return result.rows[0]?.count || 0;
}
