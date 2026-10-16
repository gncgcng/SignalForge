-- When an account is deleted its feature_requests rows are removed and only the number of
-- requests per feature is kept here, with no link to any user. Admin counts both.
CREATE TABLE IF NOT EXISTS feature_request_anonymous_counts (
  feature text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0
);
