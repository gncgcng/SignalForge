import { validateDatabaseUrl } from "../src/db/client.js";

const postgresUrl = validateDatabaseUrl("postgres://user:password@postgres.railway.internal:5432/railway");
const postgresqlUrl = validateDatabaseUrl("postgresql://user:password@postgres.railway.internal:5432/railway");
const arbitraryHost = validateDatabaseUrl("postgres://user:password@base:5432/railway");
let rejectedInvalidProtocol = false;

try {
  validateDatabaseUrl("mysql://user:password@database.internal:3306/app");
} catch (error) {
  rejectedInvalidProtocol = error.message.includes("postgres:// or postgresql://");
}

console.log(JSON.stringify({
  postgresHostname: postgresUrl.hostname,
  postgresqlHostname: postgresqlUrl.hostname,
  arbitraryHostname: arbitraryHost.hostname,
  rejectedInvalidProtocol
}, null, 2));

if (
  postgresUrl.hostname !== "postgres.railway.internal" ||
  postgresqlUrl.hostname !== "postgres.railway.internal" ||
  arbitraryHost.hostname !== "base" ||
  !rejectedInvalidProtocol
) {
  process.exitCode = 1;
}
