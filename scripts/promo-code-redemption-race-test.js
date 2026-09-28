import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { getPool, query } from "../src/db/client.js";
import { redeemCreditGrantCode } from "../src/modules/promo-codes/promoCodeRepository.js";
import { createId } from "../src/shared/ids.js";

// This test exercises real concurrent Postgres transactions (separate pool
// connections racing each other), not a mocked client -- a mock cannot reproduce
// the row-lock contention the FOR UPDATE guard in redeemCreditGrantCode depends
// on. It requires a real database: run against the project's local Postgres
// (docker-compose.yml), never against production.
const CREDIT_QUANTITY = 5;

const scenarios = [
  {
    name: "2 concurrent redemptions vs max_redemptions=1",
    concurrentAttempts: 2,
    maxRedemptions: 1,
    iterations: Number(process.env.RACE_ITERATIONS_SMALL || 20)
  },
  {
    // Higher cap, higher concurrency: confirms the boundary is exact (not
    // off-by-one either direction) once more than one winner is possible and
    // more than two transactions are contending for the same lock at once.
    name: "10 concurrent redemptions vs max_redemptions=5",
    concurrentAttempts: 10,
    maxRedemptions: 5,
    iterations: Number(process.env.RACE_ITERATIONS_LARGE || 10)
  }
];

async function createTestUser(label) {
  const id = createId("user");
  await query(`
    INSERT INTO users (id, name, email, password_salt, password_hash)
    VALUES ($1, $2, $3, 'salt', 'hash')
  `, [id, `Race Test ${label}`, `${id}@race-test.local`]);
  await query("INSERT INTO credit_balances (user_id) VALUES ($1)", [id]);
  return id;
}

async function createCreditGrantPromoCode(adminId, maxRedemptions) {
  const id = createId("promo");
  const code = createId("race").toUpperCase();
  await query(`
    INSERT INTO promo_codes (
      id, code, type, max_redemptions, active, created_by_admin_id, credit_quantity
    ) VALUES ($1, $2, 'credit_grant', $3, true, $4, $5)
  `, [id, code, maxRedemptions, adminId, CREDIT_QUANTITY]);
  return { id, code };
}

async function getBalance(userId) {
  const result = await query(
    "SELECT unlock_credits_balance FROM credit_balances WHERE user_id = $1", [userId]
  );
  return Number(result.rows[0]?.unlock_credits_balance || 0);
}

async function redemptionCount(promoCodeId) {
  const result = await query(
    "SELECT COUNT(*)::int AS count FROM promo_code_redemptions WHERE promo_code_id = $1", [promoCodeId]
  );
  return Number(result.rows[0]?.count || 0);
}

async function cleanupIteration({ userIds, promoCodeId }) {
  // Users cascade into credit_balances and promo_code_redemptions; the promo
  // code itself has no ON DELETE CASCADE from redemptions, so it comes after.
  await query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await query("DELETE FROM promo_codes WHERE id = $1", [promoCodeId]);
}

async function runIteration(scenario, index, adminId) {
  const userIds = await Promise.all(
    Array.from({ length: scenario.concurrentAttempts }, (_, slot) =>
      createTestUser(`${scenario.name}-${index}-${slot}`)
    )
  );
  const promo = await createCreditGrantPromoCode(adminId, scenario.maxRedemptions);

  try {
    // The actual race: N independent pool connections, each opening its own
    // transaction, hitting the same promo code's FOR UPDATE lock at the same time.
    const results = await Promise.all(
      userIds.map((userId) => redeemCreditGrantCode({ code: promo.code, userId }))
    );

    const expectedRejections = scenario.concurrentAttempts - scenario.maxRedemptions;
    const succeeded = results.filter((result) => result.redeemed);
    const rejected = results.filter((result) => !result.redeemed);

    assert.equal(
      succeeded.length, scenario.maxRedemptions,
      `expected exactly ${scenario.maxRedemptions} winners, got ${succeeded.length}`
    );
    assert.equal(
      rejected.length, expectedRejections,
      `expected exactly ${expectedRejections} rejections, got ${rejected.length}`
    );
    for (const rejection of rejected) {
      assert.equal(
        rejection.reason, "redemption_cap_reached",
        `every rejection should be redemption_cap_reached, got ${rejection.reason}`
      );
    }

    const totalRedemptions = await redemptionCount(promo.id);
    assert.equal(
      totalRedemptions, scenario.maxRedemptions,
      `expected exactly ${scenario.maxRedemptions} redemption rows, found ${totalRedemptions}`
    );

    const winnerIds = new Set(userIds.filter((_, slot) => results[slot].redeemed));
    let totalGranted = 0;
    for (const userId of userIds) {
      const balance = await getBalance(userId);
      if (winnerIds.has(userId)) {
        assert.equal(balance, CREDIT_QUANTITY, `winner balance should be ${CREDIT_QUANTITY}, got ${balance}`);
        totalGranted += balance;
      } else {
        assert.equal(balance, 0, `loser balance should remain 0, got ${balance}`);
      }
    }
    assert.equal(
      totalGranted, scenario.maxRedemptions * CREDIT_QUANTITY,
      `total credits granted should be exactly ${scenario.maxRedemptions * CREDIT_QUANTITY}, got ${totalGranted}`
    );
  } finally {
    await cleanupIteration({ userIds, promoCodeId: promo.id });
  }
}

let totalFailures = 0;
const adminId = createId("admin");
await query(`
  INSERT INTO users (id, name, email, password_salt, password_hash)
  VALUES ($1, 'Race Test Admin', $2, 'salt', 'hash')
`, [adminId, `${adminId}@race-test.local`]);

try {
  for (const scenario of scenarios) {
    console.log(`\n--- ${scenario.name} (${scenario.iterations} iterations) ---`);
    let scenarioFailures = 0;
    for (let index = 0; index < scenario.iterations; index += 1) {
      try {
        await runIteration(scenario, index, adminId);
        console.log(`PASS iteration ${index + 1}/${scenario.iterations}`);
      } catch (error) {
        scenarioFailures += 1;
        totalFailures += 1;
        console.error(`FAIL iteration ${index + 1}/${scenario.iterations}`);
        console.error(error.stack || error.message);
      }
    }
    console.log(`Scenario result: ${scenario.iterations - scenarioFailures}/${scenario.iterations} passed.`);
  }
} finally {
  await query("DELETE FROM users WHERE id = $1", [adminId]);
}

console.log(`\nPromo code redemption race test: ${totalFailures === 0 ? "all scenarios passed" : `${totalFailures} iteration(s) failed`}.`);
if (totalFailures) process.exitCode = 1;
await getPool().end();
