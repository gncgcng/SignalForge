import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/db/client.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(rootDir, "migrations");

await query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = await query("SELECT filename FROM schema_migrations");
const appliedFiles = new Set(applied.rows.map((row) => row.filename));
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  if (appliedFiles.has(file)) {
    continue;
  }

  const sql = await readFile(join(migrationsDir, file), "utf8");
  await query(sql);
  await query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
  console.log(`Applied ${file}`);
}

if (files.every((file) => appliedFiles.has(file))) {
  console.log("No pending migrations.");
}
