// MANUAL ONE-OFF, not part of any test suite: depends on Postgres's deadlock_timeout, so it
// would be flaky in CI. Replays reviewTesterAccessRequest's lock order (child row, then users)
// against deleteAccountData's (users, then child row) on two real connections and prints which
// side Postgres aborted with 40P01. Local Postgres only:
//   DATABASE_URL=postgres://signalforge:signalforge@localhost:5432/signalforge node scripts/account-deletion-deadlock-repro.js
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const uid = `usr_deltest_lockdemo_${Date.now().toString(36)}`;
const req = `tar_${uid}`;
await pool.query(`INSERT INTO users (id, name, email, password_salt, password_hash, plan, role) VALUES ($1,'x',$1 || '@example.test','','','free','user')`, [uid]);
await pool.query(`INSERT INTO tester_access_requests (id, user_id) VALUES ($1, $2)`, [req, uid]);
const review = await pool.connect();
const del = await pool.connect();
const out = {};
try {
  await review.query("BEGIN");
  await del.query("BEGIN");
  // reviewTesterAccessRequest: lock the request row first.
  await review.query(`SELECT id FROM tester_access_requests WHERE id = $1 FOR UPDATE`, [req]);
  // deleteAccountData: lock the user row first.
  await del.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [uid]);
  // Each now reaches for the other's row.
  const a = review.query(`UPDATE users SET role = 'tester' WHERE id = $1`, [uid])
    .then(() => "ok", (e) => `${e.code} ${e.message}`);
  const b = del.query(`DELETE FROM tester_access_requests WHERE user_id = $1`, [uid])
    .then(() => "ok", (e) => `${e.code} ${e.message}`);
  [out.review, out.deletion] = await Promise.all([a, b]);
} finally {
  await review.query("ROLLBACK").catch(() => {});
  await del.query("ROLLBACK").catch(() => {});
  review.release(); del.release();
  await pool.query(`DELETE FROM tester_access_requests WHERE id = $1`, [req]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [uid]);
  await pool.end();
}
console.log(JSON.stringify(out, null, 2));
