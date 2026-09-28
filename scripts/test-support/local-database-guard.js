// Refuses any DATABASE_URL that doesn't point at a local Postgres. DB-backed tests create and
// delete users and install triggers on `users`; a crash mid-test against production would
// leave that trigger in place. There is deliberately no override.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// With no argument it checks process.env.DATABASE_URL; an explicit undefined means "unset"
// (a default parameter would silently substitute the environment's URL instead).
export function assertLocalDatabaseUrl(...args) {
  const value = args.length ? args[0] : process.env.DATABASE_URL;
  if (!value || !String(value).trim()) {
    throw new Error("DATABASE_URL is not set. DB-backed tests only run against the local docker-compose Postgres.");
  }
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("DATABASE_URL is not a valid URL. DB-backed tests only run against the local docker-compose Postgres.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`DATABASE_URL must use postgres:// or postgresql://, got ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL host "${host}" is not local. DB-backed tests create/delete users ` +
      "and install triggers, so they only run against localhost, 127.0.0.1 or ::1. There is no override."
    );
  }
  // pg merges query parameters into the connection config, so ?host= would silently win.
  for (const key of ["host", "hostaddr"]) {
    if (url.searchParams.has(key)) {
      throw new Error(`Refusing to run: DATABASE_URL sets ?${key}=, which overrides the local host.`);
    }
  }
  return host;
}
