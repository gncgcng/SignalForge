import { runPendingMigrations, verifySessionSchema } from "../src/db/migrations.js";

const result = await runPendingMigrations();
await verifySessionSchema();

if (result.pendingCount === 0) {
  console.log("No pending migrations.");
}
