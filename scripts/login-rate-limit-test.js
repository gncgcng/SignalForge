import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertLoginVelocity,
  hashIdentifier
} from "../src/modules/auth/abuseProtectionService.js";

const migration = readFileSync(new URL("../migrations/056_login_rate_limiting.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const authService = readFileSync(new URL("../src/modules/auth/authService.js", import.meta.url), "utf8");

// --- assertLoginVelocity: throws at the threshold, not below it ---

assert.doesNotThrow(() => assertLoginVelocity({ failuresByEmail15m: 7, failuresByIp15m: 0 }));
assert.throws(
  () => assertLoginVelocity({ failuresByEmail15m: 8, failuresByIp15m: 0 }),
  (error) => error.statusCode === 429 && /this account/.test(error.message)
);
assert.throws(
  () => assertLoginVelocity({ failuresByEmail15m: 100, failuresByIp15m: 0 }),
  (error) => error.statusCode === 429 && /this account/.test(error.message)
);

assert.doesNotThrow(() => assertLoginVelocity({ failuresByEmail15m: 0, failuresByIp15m: 19 }));
assert.throws(
  () => assertLoginVelocity({ failuresByEmail15m: 0, failuresByIp15m: 20 }),
  (error) => error.statusCode === 429 && /this network/.test(error.message)
);

// the email-scoped limit is checked first
assert.throws(
  () => assertLoginVelocity({ failuresByEmail15m: 8, failuresByIp15m: 20 }),
  (error) => /this account/.test(error.message)
);

// --- hashIdentifier: exported, deterministic, scoped by prefix ---

assert.equal(typeof hashIdentifier, "function");
assert.equal(hashIdentifier("email:person@example.com"), hashIdentifier("email:person@example.com"));
assert.notEqual(hashIdentifier("email:person@example.com"), hashIdentifier("ip:person@example.com"));

// --- structural checks: migration shape, repository queries, and wiring order ---

const existingUserBranch = extractBlock(authService, "if (existing) {");
assert.ok(existingUserBranch, "the existing-user branch of registerOrLogin must exist");

const velocityCheckIndex = existingUserBranch.indexOf("assertLoginVelocity(velocity)");
const passwordCheckIndex = existingUserBranch.indexOf("isValidPassword(password, existing.password)");
const recordCallIndex = existingUserBranch.indexOf("recordLoginAttempt({ emailHash, ipHash, successful: passwordValid })");
const failureThrowIndex = existingUserBranch.indexOf("if (!passwordValid) {");

const result = {
  migrationMatchesSignupAttemptsShape:
    migration.includes("CREATE TABLE IF NOT EXISTS login_attempts") &&
    migration.includes("email_hash text NOT NULL") &&
    migration.includes("ip_hash text NOT NULL") &&
    migration.includes("successful boolean NOT NULL") &&
    migration.includes("idx_login_attempts_email_hash_created") &&
    migration.includes("idx_login_attempts_ip_hash_created"),
  repositoryMirrorsSignupPattern:
    repositories.includes("export async function recordLoginAttempt({ emailHash, ipHash, successful })") &&
    repositories.includes("export async function getLoginAttemptVelocity({ emailHash, ipHash })") &&
    repositories.includes("INSERT INTO login_attempts") &&
    repositories.includes("created_at >= now() - interval '15 minutes'"),
  velocityCheckRunsBeforePasswordComparison:
    velocityCheckIndex !== -1 &&
    passwordCheckIndex !== -1 &&
    velocityCheckIndex < passwordCheckIndex,
  attemptRecordedUnconditionallyOnBothBranches:
    recordCallIndex !== -1 &&
    passwordCheckIndex !== -1 &&
    failureThrowIndex !== -1 &&
    passwordCheckIndex < recordCallIndex &&
    recordCallIndex < failureThrowIndex,
  emailHashedNeverRawInQuery:
    authService.includes("hashIdentifier(`email:${normalizedEmail}`)") &&
    !repositories.includes("normalizedEmail")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Login rate limit check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));

function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, index + 1);
    }
  }
  return null;
}
