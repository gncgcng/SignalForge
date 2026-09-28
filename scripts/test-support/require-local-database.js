// Import this FIRST in every DB-backed test or script. It exits before any other module loads
// or any connection opens unless DATABASE_URL points at a local Postgres.
// scripts/local-database-guard-test.js fails if a DB-backed test is missing this import.
import { assertLocalDatabaseUrl } from "./local-database-guard.js";

try {
  assertLocalDatabaseUrl();
} catch (error) {
  console.error(`[local-db-guard] ${error.message}`);
  process.exit(1);
}
