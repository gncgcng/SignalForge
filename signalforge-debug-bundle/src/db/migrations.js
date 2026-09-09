import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, transaction } from "./client.js";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDir = join(rootDir, "migrations");

export async function runPendingMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = await query("SELECT filename FROM schema_migrations");
  const appliedFiles = new Set(applied.rows.map((row) => row.filename));
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const pending = files.filter((file) => !appliedFiles.has(file));

  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), "utf8");

    await transaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
        [file]
      );
    });

    console.log(`[database] Applied migration ${file}`);
  }

  return {
    applied: pending,
    pendingCount: pending.length
  };
}

export async function verifySessionSchema() {
  const result = await query(`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sessions'
      AND column_name = 'expires_at'
  `);

  const column = result.rows[0];

  if (!column) {
    throw new Error("[database] sessions.expires_at is missing after migrations.");
  }

  if (column.is_nullable !== "NO") {
    throw new Error("[database] sessions.expires_at must be NOT NULL.");
  }

  return true;
}
