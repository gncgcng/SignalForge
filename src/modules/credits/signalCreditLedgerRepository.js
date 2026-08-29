const refundableStatuses = new Set(["Hit SL", "Expired"]);

export async function consumeSignalUnlockCredit(client, {
  transactionId,
  userId,
  savedSignalId
}) {
  const idempotencyKey = `signal-credit-charge:${savedSignalId}`;
  const result = await client.query(`
    WITH charge_transaction AS (
      INSERT INTO signal_credit_transactions (
        id, idempotency_key, user_id, saved_signal_id, transaction_type,
        quantity, balance_delta, credit_pool, reason
      )
      SELECT $1, $2, $3, $4, 'unlock_charge', 1, -1,
        'unlock_credits_balance', 'Signal unlock consumed one credit.'
      FROM credit_balances c
      WHERE c.user_id = $3
        AND c.unlock_credits_balance > 0
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING user_id
    )
    UPDATE credit_balances c
    SET unlock_credits_balance = c.unlock_credits_balance - 1,
      lifetime_unlocks_used = c.lifetime_unlocks_used + 1,
      trial_signals_used = c.trial_signals_used + CASE WHEN u.plan = 'free' THEN 1 ELSE 0 END,
      updated_at = now()
    FROM charge_transaction charge
    JOIN users u ON u.id = charge.user_id
    WHERE c.user_id = charge.user_id
    RETURNING c.user_id, c.unlock_credits_balance
  `, [transactionId, idempotencyKey, userId, savedSignalId]);

  return {
    charged: Boolean(result.rows[0]),
    idempotencyKey,
    balance: result.rows[0] ? Number(result.rows[0].unlock_credits_balance) : null
  };
}

export async function refundSignalCreditForTerminalOutcome(client, {
  savedSignalId,
  status
}) {
  if (!refundableStatuses.has(status)) {
    return { refunded: false, reason: "not_refundable_outcome" };
  }

  const idempotencyKey = `signal-credit-refund:${savedSignalId}`;
  const reason = status === "Hit SL" ? "Stop Loss" : "Expired";
  const result = await client.query(`
    WITH refund_transaction AS (
      INSERT INTO signal_credit_transactions (
        id, idempotency_key, user_id, saved_signal_id, transaction_type,
        quantity, balance_delta, credit_pool, reason, original_transaction_id
      )
      SELECT $1, $2, charge.user_id, charge.saved_signal_id, 'terminal_refund',
        1, 1, charge.credit_pool, $4, charge.id
      FROM signal_credit_transactions charge
      JOIN signal_outcomes outcome ON outcome.saved_signal_id = charge.saved_signal_id
      WHERE charge.saved_signal_id = $3
        AND charge.transaction_type = 'unlock_charge'
        AND outcome.status = $5
        AND $5 IN ('Hit SL', 'Expired')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING user_id
    )
    UPDATE credit_balances c
    SET unlock_credits_balance = c.unlock_credits_balance + 1,
      updated_at = now()
    FROM refund_transaction refund
    WHERE c.user_id = refund.user_id
    RETURNING c.user_id, c.unlock_credits_balance
  `, [idempotencyKey, idempotencyKey, savedSignalId, reason, status]);

  return {
    refunded: Boolean(result.rows[0]),
    idempotencyKey,
    reason,
    userId: result.rows[0]?.user_id || null,
    balance: result.rows[0] ? Number(result.rows[0].unlock_credits_balance) : null
  };
}

