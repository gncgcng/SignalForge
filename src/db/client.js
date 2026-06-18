import pg from "pg";

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    const connectionString = getDatabaseUrl();

    pool = new Pool({
      connectionString
    });

    pool.on("error", (error) => {
      console.error(`[database] PostgreSQL pool error: ${formatDatabaseError(error)}`);
    });
  }

  return pool;
}

export async function query(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (error) {
    error.message = `[database] ${formatDatabaseError(error)}`;
    throw error;
  }
}

export async function transaction(callback) {
  let client;

  try {
    client = await getPool().connect();
  } catch (error) {
    error.message = `[database] ${formatDatabaseError(error)}`;
    throw error;
  }

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyDatabaseConnection() {
  const database = validateDatabaseUrl();
  await query("SELECT 1");
  console.log(`[database] Connected to PostgreSQL host ${database.hostname}`);
}

export function validateDatabaseUrl(value = process.env.DATABASE_URL) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    throw new Error("[database] DATABASE_URL is required.");
  }

  let parsed;

  try {
    parsed = new URL(normalizedValue);
  } catch {
    throw new Error("[database] DATABASE_URL is not a valid PostgreSQL connection URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("[database] DATABASE_URL must use the postgres:// or postgresql:// protocol.");
  }

  return {
    connectionString: normalizedValue,
    hostname: parsed.hostname
  };
}

function getDatabaseUrl() {
  return validateDatabaseUrl().connectionString;
}

function formatDatabaseError(error) {
  const target = error.hostname || error.address || error.host;
  const targetText = target ? ` Target: ${target}.` : "";
  return `${maskDatabaseCredentials(error.message)}${targetText}`;
}

function maskDatabaseCredentials(message = "") {
  return String(message).replace(
    /(postgres(?:ql)?:\/\/)([^:\s/@]+)(?::[^@\s/]*)?@/gi,
    "$1***:***@"
  );
}
