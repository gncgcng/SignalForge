-- Restore the cache identity expected by cacheScanResult() on drifted schemas.
WITH ranked_scan_result_cache AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY user_id, scan_key
      ORDER BY expires_at DESC, created_at DESC, ctid DESC
    ) AS row_number
  FROM scan_result_cache
)
DELETE FROM scan_result_cache AS cache
USING ranked_scan_result_cache AS ranked
WHERE cache.ctid = ranked.ctid
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_result_cache_user_scan_key_unique
  ON scan_result_cache(user_id, scan_key);
