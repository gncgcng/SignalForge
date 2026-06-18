import { validateDatabaseUrl } from "../src/db/client.js";

const postgresUrl = validateDatabaseUrl("postgres://user:password@postgres.railway.internal:5432/railway");
const postgresqlUrl = validateDatabaseUrl("postgresql://user:password@postgres.railway.internal:5432/railway");
const arbitraryHost = validateDatabaseUrl("postgres://user:password@base:5432/railway");
let rejectedInvalidProtocol = false;
let rejectedConcatenatedNodeEnv = false;
let rejectedMultiline = false;

try {
  validateDatabaseUrl("mysql://user:password@database.internal:3306/app");
} catch (error) {
  rejectedInvalidProtocol = error.message.includes("postgres:// or postgresql://");
}

try {
  validateDatabaseUrl("postgres://user:password@postgres.railway.internal:5432/railwayNODE_ENV=production");
} catch (error) {
  rejectedConcatenatedNodeEnv = error.message.includes("separate Railway variables");
}

try {
  validateDatabaseUrl("postgres://user:password@postgres.railway.internal:5432/railway\nNODE_ENV=production");
} catch (error) {
  rejectedMultiline = error.message.includes("single-line");
}

console.log(JSON.stringify({
  postgresHostname: postgresUrl.hostname,
  postgresDatabase: postgresUrl.database,
  postgresqlHostname: postgresqlUrl.hostname,
  postgresqlDatabase: postgresqlUrl.database,
  arbitraryHostname: arbitraryHost.hostname,
  rejectedInvalidProtocol,
  rejectedConcatenatedNodeEnv,
  rejectedMultiline
}, null, 2));

if (
  postgresUrl.hostname !== "postgres.railway.internal" ||
  postgresUrl.database !== "railway" ||
  postgresqlUrl.hostname !== "postgres.railway.internal" ||
  postgresqlUrl.database !== "railway" ||
  arbitraryHost.hostname !== "base" ||
  !rejectedInvalidProtocol ||
  !rejectedConcatenatedNodeEnv ||
  !rejectedMultiline
) {
  process.exitCode = 1;
}
