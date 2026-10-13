import { query, transaction } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

// Every statement is scoped by user_id: a trade that belongs to someone else looks exactly like a missing one.
const COLUMNS = `id, user_id, created_at, updated_at, status, market, direction, setup_key, timeframe,
  entry_price, stop_price, target_price, size_units, opened_at, exit_price, closed_at, fees_paid, fee_rate_pct, notes`;

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
const toIso = (value) => (value ? new Date(value).toISOString() : null);

export function mapRealTrade(row) {
  return {
    id: row.id,
    status: row.status,
    market: row.market,
    direction: row.direction,
    setupKey: row.setup_key,
    timeframe: row.timeframe,
    entryPrice: toNumber(row.entry_price),
    stopPrice: toNumber(row.stop_price),
    targetPrice: toNumber(row.target_price),
    sizeUnits: toNumber(row.size_units),
    openedAt: toIso(row.opened_at),
    exitPrice: toNumber(row.exit_price),
    closedAt: toIso(row.closed_at),
    feesPaid: toNumber(row.fees_paid),
    feeRatePct: toNumber(row.fee_rate_pct),
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

const values = (trade) => [
  trade.status, trade.market, trade.direction, trade.setupKey, trade.timeframe,
  trade.entryPrice, trade.stopPrice, trade.targetPrice, trade.sizeUnits, trade.openedAt,
  trade.exitPrice, trade.closedAt, trade.feesPaid, trade.feeRatePct, trade.notes
];

export async function listRealTrades(userId) {
  const result = await query(
    `SELECT ${COLUMNS} FROM real_trades WHERE user_id = $1 ORDER BY opened_at DESC, created_at DESC, id`,
    [userId]
  );
  return result.rows.map(mapRealTrade);
}

export async function findRealTrade(userId, id) {
  const result = await query(`SELECT ${COLUMNS} FROM real_trades WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rows[0] ? mapRealTrade(result.rows[0]) : null;
}

// Inserts unless the user is at the cap. The user row is locked so two concurrent requests can't both pass the count.
export async function insertRealTrade(userId, trade, { maxTrades }) {
  return transaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const count = (await client.query(`SELECT COUNT(*)::integer AS n FROM real_trades WHERE user_id = $1`, [userId])).rows[0].n;
    if (count >= maxTrades) return { limitReached: true };
    const result = await client.query(`
      INSERT INTO real_trades (id, user_id, status, market, direction, setup_key, timeframe,
        entry_price, stop_price, target_price, size_units, opened_at, exit_price, closed_at, fees_paid, fee_rate_pct, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING ${COLUMNS}
    `, [createId("rt"), userId, ...values(trade)]);
    return { trade: mapRealTrade(result.rows[0]) };
  });
}

export async function updateRealTrade(userId, id, trade) {
  const result = await query(`
    UPDATE real_trades
    SET status = $3, market = $4, direction = $5, setup_key = $6, timeframe = $7,
      entry_price = $8, stop_price = $9, target_price = $10, size_units = $11, opened_at = $12,
      exit_price = $13, closed_at = $14, fees_paid = $15, fee_rate_pct = $16, notes = $17, updated_at = now()
    WHERE id = $1 AND user_id = $2
    RETURNING ${COLUMNS}
  `, [id, userId, ...values(trade)]);
  return result.rows[0] ? mapRealTrade(result.rows[0]) : null;
}

export async function deleteRealTrade(userId, id) {
  const result = await query(`DELETE FROM real_trades WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rowCount > 0;
}
