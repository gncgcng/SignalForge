# My trades (real-trade journal) vs paper trading

Phase 2c adds a log of **real** trades, called "My trades". Before building it, this note records what paper trading already stores, so the two don't get mixed up.

## What paper trading stores today

All paper data is simulated and lives in four tables. Each has `user_id` referencing `users(id)` with `ON DELETE CASCADE`.

| Table | Migration | What it holds |
|---|---|---|
| `paper_accounts` | 030 | One simulated balance per user: `starting_balance`, `balance`, `realized_pnl` (all `numeric`, default 10,000). Can be reset. |
| `paper_orders` | 030 | The paper-trading terminal's orders. Each one has symbol, timeframe, direction, market or limit type, and a status (`Pending`, `Open`, `Hit TP`, `Hit SL`, `Expired`, `Closed`, `Cancelled`). It also stores quantity, position size in USD, entry, limit, stop, take-profit, exit price, `realized_pnl` and `r_multiple`. All prices are `numeric`. Optionally linked to a `saved_signals` row. Fills and exits are simulated against market candles, and no fees are recorded. |
| `paper_trades` | 009, 011 | The older "paper trade this signal" entries. Each one is always tied to an unlocked `saved_signals` row, with sizing from the Dynamic Risk Engine (`account_size`, risk %, `risk_amount`, `position_size`). The outcome comes from the signal's tracked outcome (TP or SL), not from user input. |
| `trade_journals` | 010 | Notes on a paper trade, keyed by `paper_trade_id`. Holds notes before and after the trade, emotion tags, a 1–5 rating and a screenshot URL. It contains no prices. It is served at `GET /api/journal` and `PUT /api/journal/:paperTradeId`, and shown in the `#journal` view. That view's nav link is now labelled "Paper journal". |

Paper statistics (`calculatePaperStats`) are a plain win rate (TP / (TP + SL)) and an average R with no fees and no interval. They come from simulated or signal-tracked outcomes.

## Why "My trades" is separate

- **Real fills, entered by the user.** Entry, stop, exit, size, the time it opened and closed, and the fees actually paid. Nothing is simulated, and a trade needs no signal.
- **Measured like the setup track records.** Fees are counted in R. The win rate has a Wilson 95% interval. Average net R has a month-block bootstrap interval. The labels and thresholds are the same as the track records'.
- **Own table, own routes.** The table is `real_trades` (migration 067). The name was chosen so it can't be confused with the paper table `trade_journals`. The routes are `/api/trades` and the view is `#my-trades`. Paper-trading tables, routes and behaviour are unchanged.
- **Account deletion.** It doesn't delete the `users` row: the row is anonymized and kept, so `ON DELETE CASCADE` never fires on that path. `real_trades` is therefore added to `HARD_DELETE_TABLES`, the same way the paper tables are deleted. The cascade stays as a second safeguard.

## Reused pieces

- `public/feeCost.js` (the break-even win-rate maths and fee presets).
- The track-record statistics: the Wilson interval, the month-block bootstrap, the label function and its thresholds. These moved into `public/trackRecordStats.js` so the browser can use them. The research export re-exports them, so it is unchanged.
- The look of the track-record block, the existing button and form styles, and `escapeHtml` and the formatting helpers in `app.js`.
