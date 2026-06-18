import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL("../migrations/003_ensure_sessions_expires_at.sql", import.meta.url)
);
const repositoryPath = fileURLToPath(
  new URL("../src/db/repositories.js", import.meta.url)
);

const migration = await readFile(migrationPath, "utf8");
const repository = await readFile(repositoryPath, "utf8");
const normalizedMigration = migration.toLowerCase();

const result = {
  addsColumnIdempotently: /add column if not exists expires_at/i.test(migration),
  backfillsExistingSessions: /update sessions[\s\S]*where expires_at is null/i.test(migration),
  setsDefault: /alter column expires_at set default/i.test(migration),
  setsNotNull: /alter column expires_at set not null/i.test(migration),
  createsIndexIdempotently: /create index if not exists idx_sessions_expires_at/i.test(migration),
  containsNoDelete: !/\bdelete\s+from\b/i.test(normalizedMigration),
  containsNoDrop: !/\bdrop\s+(table|column)\b/i.test(normalizedMigration),
  sessionInsertUsesExpiresAt: /insert into sessions \(id, user_id, expires_at\)/i.test(repository),
  sessionLookupUsesExpiresAt: /where id = \$1 and expires_at > now\(\)/i.test(repository)
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
