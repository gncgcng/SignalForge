import { validateDatabaseUrl } from "../src/db/client.js";

const valid = validateDatabaseUrl("postgresql://user:password@postgres.railway.internal:5432/railway");
let rejectedBase = false;

try {
  validateDatabaseUrl("postgresql://user:password@base:5432/railway");
} catch (error) {
  rejectedBase = error.message.includes('invalid hostname "base"');
}

console.log(JSON.stringify({
  validHostname: valid.hostname,
  rejectedBase
}, null, 2));

if (valid.hostname !== "postgres.railway.internal" || !rejectedBase) {
  process.exitCode = 1;
}
