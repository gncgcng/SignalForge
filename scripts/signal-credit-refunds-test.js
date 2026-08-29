import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  consumeSignalUnlockCredit,
  refundSignalCreditForTerminalOutcome
} from "../src/modules/credits/signalCreditLedgerRepository.js";

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

test("Hit TP does not refund a consumed signal credit", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "signal-tp");
  fixture.state.outcomes.set("signal-tp", "Hit TP");
  const result = await refundSignalCreditForTerminalOutcome(fixture.client, {
    savedSignalId: "signal-tp",
    status: "Hit TP"
  });
  assert.equal(result.refunded, false);
  assert.equal(fixture.state.balances.get("user-a"), 1);
  assert.equal(refundCount(fixture.state, "signal-tp"), 0);
});

test("Hit SL refunds exactly one consumed credit", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "signal-sl");
  fixture.state.outcomes.set("signal-sl", "Hit SL");
  const result = await refundSignalCreditForTerminalOutcome(fixture.client, {
    savedSignalId: "signal-sl",
    status: "Hit SL"
  });
  assert.equal(result.refunded, true);
  assert.equal(result.reason, "Stop Loss");
  assert.equal(fixture.state.balances.get("user-a"), 2);
  assert.equal(refundCount(fixture.state, "signal-sl"), 1);
});

test("Expired refunds exactly one consumed credit", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "signal-expired");
  fixture.state.outcomes.set("signal-expired", "Expired");
  const result = await refundSignalCreditForTerminalOutcome(fixture.client, {
    savedSignalId: "signal-expired",
    status: "Expired"
  });
  assert.equal(result.refunded, true);
  assert.equal(result.reason, "Expired");
  assert.equal(fixture.state.balances.get("user-a"), 2);
});

test("No Valid Setup creates neither a charge nor a refund entitlement", () => {
  const fixture = ledgerFixture({ balance: 2 });
  assert.equal(fixture.state.balances.get("user-a"), 2);
  assert.equal(fixture.state.transactions.size, 0);
});

test("ten repeated SL and Expired evaluations refund only once", async () => {
  for (const [savedSignalId, status] of [["repeat-sl", "Hit SL"], ["repeat-expired", "Expired"]]) {
    const fixture = ledgerFixture({ balance: 2 });
    await charge(fixture.client, savedSignalId);
    fixture.state.outcomes.set(savedSignalId, status);
    const results = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await refundSignalCreditForTerminalOutcome(fixture.client, { savedSignalId, status }));
    }
    assert.equal(results.filter((item) => item.refunded).length, 1);
    assert.equal(fixture.state.balances.get("user-a"), 2);
    assert.equal(refundCount(fixture.state, savedSignalId), 1);
  }
});

test("concurrent refund attempts have one database winner", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "concurrent-sl");
  fixture.state.outcomes.set("concurrent-sl", "Hit SL");
  const attempts = await Promise.all(Array.from({ length: 20 }, () =>
    refundSignalCreditForTerminalOutcome(fixture.client, {
      savedSignalId: "concurrent-sl",
      status: "Hit SL"
    })
  ));
  assert.equal(attempts.filter((item) => item.refunded).length, 1);
  assert.equal(fixture.state.balances.get("user-a"), 2);
});

test("restart durability uses persisted ledger state", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "restart-sl");
  fixture.state.outcomes.set("restart-sl", "Hit SL");
  await refundSignalCreditForTerminalOutcome(fixture.client, {
    savedSignalId: "restart-sl",
    status: "Hit SL"
  });
  const restartedClient = createLedgerClient(fixture.state);
  const repeated = await refundSignalCreditForTerminalOutcome(restartedClient, {
    savedSignalId: "restart-sl",
    status: "Hit SL"
  });
  assert.equal(repeated.refunded, false);
  assert.equal(fixture.state.balances.get("user-a"), 2);
});

test("non-credit and Auto Crypto Watcher signals cannot mint refunds", async () => {
  for (const savedSignalId of ["non-credit", "auto-watcher", "admin-test"]) {
    const fixture = ledgerFixture({ balance: 2 });
    fixture.state.outcomes.set(savedSignalId, "Hit SL");
    const result = await refundSignalCreditForTerminalOutcome(fixture.client, {
      savedSignalId,
      status: "Hit SL"
    });
    assert.equal(result.refunded, false);
    assert.equal(fixture.state.balances.get("user-a"), 2);
    assert.equal(fixture.state.transactions.size, 0);
  }
});

test("duplicate charge attempts consume at most one credit", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  const first = await charge(fixture.client, "duplicate-signal");
  const second = await charge(fixture.client, "duplicate-signal");
  assert.equal(first.charged, true);
  assert.equal(second.charged, false);
  assert.equal(fixture.state.balances.get("user-a"), 1);
  assert.equal(chargeCount(fixture.state, "duplicate-signal"), 1);
});

test("refund requires the canonical stored outcome to match", async () => {
  const fixture = ledgerFixture({ balance: 2 });
  await charge(fixture.client, "canonical-status");
  fixture.state.outcomes.set("canonical-status", "Active");
  const claimed = await refundSignalCreditForTerminalOutcome(fixture.client, {
    savedSignalId: "canonical-status",
    status: "Hit SL"
  });
  assert.equal(claimed.refunded, false);
  assert.equal(fixture.state.balances.get("user-a"), 1);
});

test("production wiring is server-owned, transactional, and does not backfill unverifiable charges", async () => {
  const [migration, repositories, ledger, signalService, autoScan] = await Promise.all([
    source("../migrations/055_signal_credit_refunds.sql"),
    source("../src/db/repositories.js"),
    source("../src/modules/credits/signalCreditLedgerRepository.js"),
    source("../src/modules/signals/signalService.js"),
    source("../src/modules/alerts/autoScanService.js")
  ]);
  assert.match(migration, /idempotency_key text NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(saved_signal_id, transaction_type\)/);
  assert.doesNotMatch(migration, /INSERT INTO signal_credit_transactions[\s\S]*SELECT[\s\S]*FROM unlocked_signals/i);
  assert.match(ledger, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(ledger, /JOIN signal_outcomes outcome/);
  assert.match(ledger, /outcome\.status = \$5/);
  assert.match(repositories, /if \(billing\.role !== "tester"\)[\s\S]*consumeSignalUnlockCredit/);
  assert.match(repositories, /expireActiveSignalsPastValidity[\s\S]*refundSignalCreditForTerminalOutcome/);
  assert.match(repositories, /updateSignalOutcome[\s\S]*refundSignalCreditForTerminalOutcome/);
  assert.doesNotMatch(autoScan, /consumeSignalUnlockCredit|refundSignalCreditForTerminalOutcome/);
  assert.match(signalService, /subscription: getSubscriptionSummary\(refreshedUser \|\| user\)/);
});

async function charge(client, savedSignalId) {
  return consumeSignalUnlockCredit(client, {
    transactionId: `charge:${savedSignalId}`,
    userId: "user-a",
    savedSignalId
  });
}

function ledgerFixture({ balance }) {
  const state = {
    balances: new Map([["user-a", balance]]),
    users: new Map([["user-a", { plan: "free" }]]),
    outcomes: new Map(),
    transactions: new Map()
  };
  return { state, client: createLedgerClient(state) };
}

function createLedgerClient(state) {
  return {
    async query(sql, params) {
      await Promise.resolve();
      if (sql.includes("WITH charge_transaction AS")) {
        const [id, idempotencyKey, userId, savedSignalId] = params;
        const duplicateType = [...state.transactions.values()].some((item) =>
          item.savedSignalId === savedSignalId && item.type === "unlock_charge"
        );
        if (state.transactions.has(idempotencyKey) || duplicateType || Number(state.balances.get(userId) || 0) <= 0) {
          return { rows: [] };
        }
        state.transactions.set(idempotencyKey, {
          id, idempotencyKey, userId, savedSignalId, type: "unlock_charge", delta: -1
        });
        state.balances.set(userId, state.balances.get(userId) - 1);
        return { rows: [{ user_id: userId, unlock_credits_balance: state.balances.get(userId) }] };
      }
      if (sql.includes("WITH refund_transaction AS")) {
        const [id, idempotencyKey, savedSignalId, reason, status] = params;
        const charge = [...state.transactions.values()].find((item) =>
          item.savedSignalId === savedSignalId && item.type === "unlock_charge"
        );
        const duplicateType = [...state.transactions.values()].some((item) =>
          item.savedSignalId === savedSignalId && item.type === "terminal_refund"
        );
        if (!charge || state.transactions.has(idempotencyKey) || duplicateType ||
          !["Hit SL", "Expired"].includes(status) || state.outcomes.get(savedSignalId) !== status) {
          return { rows: [] };
        }
        state.transactions.set(idempotencyKey, {
          id, idempotencyKey, userId: charge.userId, savedSignalId,
          type: "terminal_refund", delta: 1, reason, originalTransactionId: charge.id
        });
        state.balances.set(charge.userId, state.balances.get(charge.userId) + 1);
        return { rows: [{ user_id: charge.userId, unlock_credits_balance: state.balances.get(charge.userId) }] };
      }
      throw new Error(`Unexpected ledger SQL: ${sql.slice(0, 80)}`);
    }
  };
}

function chargeCount(state, savedSignalId) {
  return [...state.transactions.values()].filter((item) => item.savedSignalId === savedSignalId && item.type === "unlock_charge").length;
}

function refundCount(state, savedSignalId) {
  return [...state.transactions.values()].filter((item) => item.savedSignalId === savedSignalId && item.type === "terminal_refund").length;
}

function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

let failures = 0;
for (const item of tests) {
  try {
    await item.callback();
    console.log(`PASS ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${item.name}`);
    console.error(error.stack || error.message);
  }
}

console.log(`\nSignal credit refund tests: ${tests.length - failures} passed, ${failures} failed.`);
if (failures) process.exitCode = 1;

