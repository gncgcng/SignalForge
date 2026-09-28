// Tests the local-only DATABASE_URL guard, and that every DB-backed test/script is wired to it.
// Needs no database: guarded scripts are launched with non-local URLs and must exit first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertLocalDatabaseUrl } from "./test-support/local-database-guard.js";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const GUARD_IMPORT = "./test-support/require-local-database.js";

// 1. Helper: rejects non-local and unset, accepts the docker-compose URL.
const rejected = [
  ["railway internal", "postgres://postgres:secret@postgres.railway.internal:5432/railway"],
  ["railway public proxy", "postgresql://postgres:secret@switchback.proxy.rlwy.net:41234/railway"],
  ["unset", undefined],
  ["empty", ""],
  ["whitespace", "   "],
  ["not a url", "localhost:5432/signalforge"],
  ["lookalike host", "postgres://u:p@localhost.proxy.rlwy.net:5432/db"],
  ["?host= override", "postgres://signalforge:signalforge@localhost:5432/signalforge?host=postgres.railway.internal"],
  ["?hostaddr= override", "postgres://signalforge:signalforge@localhost:5432/signalforge?hostaddr=10.0.0.5"],
  ["wrong protocol", "mysql://u:p@localhost:3306/db"]
];
for (const [label, url] of rejected) {
  assert.throws(() => assertLocalDatabaseUrl(url), /DATABASE_URL|Refusing/, `should reject ${label}`);
}
assert.throws(() => assertLocalDatabaseUrl(undefined), /not set/);
assert.throws(() => assertLocalDatabaseUrl(rejected[0][1]), /postgres\.railway\.internal/);
// The password never appears in the error.
assert.ok(!(() => { try { assertLocalDatabaseUrl(rejected[1][1]); } catch (e) { return e.message; } })().includes("secret"));

const accepted = [
  ["docker-compose", "postgres://signalforge:signalforge@localhost:5432/signalforge", "localhost"],
  ["127.0.0.1", "postgresql://signalforge:signalforge@127.0.0.1:5432/signalforge", "127.0.0.1"],
  ["::1", "postgres://signalforge:signalforge@[::1]:5432/signalforge", "::1"],
  ["uppercase", "postgres://signalforge:signalforge@LOCALHOST:5432/signalforge", "localhost"]
];
for (const [label, url, host] of accepted) {
  assert.equal(assertLocalDatabaseUrl(url), host, `should accept ${label}`);
}

// 2. Wiring: any test/repro/fixture that opens a real connection must import the guard FIRST,
// so a new DB-backed test can't forget it. Local-only seed scripts are named seed-local-*.
// Operational tools (db-seed, db-migrate, reports) are meant for real databases and are not scanned.
const DB_ACCESS = /getPool\(|from "pg"|account-deletion-fixtures\.js/;
const candidates = readdirSync(scriptsDir)
  .filter((name) => (/(-test|-repro|-fixtures)\.js$/.test(name) || /^seed-local-.*\.js$/.test(name)) &&
    name !== "local-database-guard-test.js");
const guarded = [];
for (const name of candidates) {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  if (!DB_ACCESS.test(source)) continue;
  const firstImport = source.split("\n").find((line) => /^import\s/.test(line));
  assert.ok(firstImport?.includes(GUARD_IMPORT), `${name} opens a real DB connection but does not import ${GUARD_IMPORT} first`);
  guarded.push(name);
}
for (const required of [
  "account-deletion-test.js", "account-deletion-customer-test.js", "account-deletion-retry-test.js",
  "promo-code-redemption-race-test.js", "account-deletion-deadlock-repro.js", "seed-local-promo-ui-users.js"
]) {
  assert.ok(guarded.includes(required), `${required} not detected as guarded`);
}

// 3. End to end: each guarded runnable script exits with the guard message before doing anything.
const runnable = guarded.filter((name) => !name.endsWith("-fixtures.js"));
for (const name of runnable) {
  for (const url of [rejected[0][1], rejected[1][1], undefined]) {
    const env = { ...process.env };
    if (url === undefined) delete env.DATABASE_URL; else env.DATABASE_URL = url;
    const run = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 1, `${name} with ${url ?? "unset"} should exit 1, got ${run.status}: ${run.stderr}`);
    assert.match(run.stderr, /\[local-db-guard\]/, `${name}: guard message missing`);
    assert.doesNotMatch(run.stdout + run.stderr, /\[database\]|ECONNREFUSED|ENOTFOUND/, `${name}: tried to connect`);
  }
}

console.log(JSON.stringify({ localDatabaseGuard: "ok", rejected: rejected.length, accepted: accepted.length, guarded }, null, 2));
