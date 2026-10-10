// Disposable, read-only diagnostic. Lists every admin override row in signal_strategy_statuses so rows already
// set to disabled_by_admin can be reviewed before admin-disabled blocking ships. SELECT only; writes nothing.
//
// Runs from the repo (node scripts/list-signal-strategy-statuses.js) or pasted standalone into /tmp inside the
// Railway container, where it loads pg from /app (APP_ROOT overrides).
//
//   node scripts/list-signal-strategy-statuses.js [--json]
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT || (existsSync(join(scriptDirectory, "..", "package.json")) && existsSync(join(scriptDirectory, "..", "src")) ? join(scriptDirectory, "..") : "/app");
const { Client } = createRequire(join(APP_ROOT, "package.json"))("pg");

const json = process.argv.includes("--json");
const connectionString = String(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "").trim();
if (!connectionString) {
  console.error("Listing signal_strategy_statuses failed: DATABASE_URL is required.");
  process.exit(1);
}
const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(`
    SELECT group_key, group_type, status, updated_at, updated_by
    FROM signal_strategy_statuses
    ORDER BY (status = 'disabled_by_admin') DESC, updated_at DESC, group_key ASC
  `);
  await client.query("ROLLBACK");
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const disabled = rows.filter((row) => row.status === "disabled_by_admin");
    console.log(`signal_strategy_statuses: ${rows.length} rows, ${disabled.length} disabled_by_admin (these will block publication once admin-disabled blocking ships)`);
    const width = Math.max(9, ...rows.map((row) => row.group_key.length));
    console.log(`${"group_key".padEnd(width)}  ${"status".padEnd(18)}  ${"updated_at".padEnd(24)}  updated_by`);
    for (const row of rows) {
      console.log(`${row.group_key.padEnd(width)}  ${row.status.padEnd(18)}  ${new Date(row.updated_at).toISOString().padEnd(24)}  ${row.updated_by ?? ""}`);
    }
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Listing signal_strategy_statuses failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
