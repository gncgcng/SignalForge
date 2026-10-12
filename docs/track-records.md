# Track records

Every setup card shows a "Track record" block: what happened, historically, when the current scanner rules were
replayed over past Coinbase candles. It is a historical frequency, not a prediction, and it is never combined with the
match score.

## Where the numbers come from

- **Source:** the replay harness (`scripts/replay/`, branch `research/replay-harness`, commit `2100547`), run `main`,
  i.e. the run behind the "0 of 226 cells show an EDGE" verdict. See `docs/replay-harness.md` on that branch.
- **Variant:** V1 "longs only". Production blocks short setups (`signal_strategy_statuses`
  `direction:short = disabled_by_admin` since 2026-10-10), which is exactly the harness's V1 filter: it re-runs the live
  cooldown/duplicate gate with shorts removed. No daily-trend gate (V2-V4) exists in production code.
- **Pairs:** the 26-pair verdict universe (`verdict-universe.json`), the same pairs as the verdicts.
- **Timeframes:** 5m, 15m, 1h and 4h, the ones the live scanner emits. 5m is labelled "approximate" because its replay
  precision against live could not be verified.
- **Period:** every replayed month, the research hold-out (2026-07-13 onward) included. This describes history; it is
  not a test.
- **Shorts:** never shown. A short setup gets no block at all.

Not used: `production-parity-risk-replay.js` (99 signals; the script is missing from the repo and the sample is too
small).

## What is published

`data/track-records/track-records.v1.json` (about 40 KB): one entry per strategy x direction x timeframe plus an
"All setups" roll-up, with `generated_at`, the harness commit, the date range, the pairs, the fee assumptions and the
replay-vs-live fidelity figures. It holds statistics only, with no per-trade rows and no secrets. The server loads it at
boot (`src/modules/track-records/trackRecordService.js`) and serves it read-only at `GET /api/track-records`. If the file
is missing or malformed, the server still starts and cards show "No track record yet".

### Statistics per record

| Field | Meaning |
|---|---|
| `n` | TP + SL. Expired setups are reported separately (`expired`). |
| `winRate`, `winRate95` | TP / (TP + SL), with a Wilson 95% interval. |
| `breakEvenWinRate` | 1 / (1 + the record's average planned reward-to-risk). |
| `avgR`, `avgR95` | Average R per resolved setup (expired included: TP = planned R, SL = -1R, expired = 0R) after a 0.20% round-trip fee, with a 95% interval from a block bootstrap by calendar month (10,000 samples, seed 20261011, ported from the harness helper `monthBlockBootstrap`). |
| `retailAvgR` | The same average at 1.20% round trip (Coinbase retail taker, about 0.6% per side). |
| `byYear` | Average R after the 0.20% fee for each calendar year, with `n` per year. |

Fees are converted to R as round-trip fee / stop distance, both as a fraction of the entry price. This is the harness's
own formula, and every record has a stop distance, so the retail line is always computed.

### Labels (fixed before the first export; do not tune them to the output)

Exactly one label per record, evaluated in this order:

1. `n < 30`: "Not enough history yet"
2. upper 95% bound of `avgR` < 0: "Has lost money historically"
3. lower 95% bound of `avgR` > 0: "Has made money historically"
4. otherwise: "No clear edge either way"

Card colour: neutral for 1 and 4, muted red for 2, and green only for 3.

## Refreshing

The harness and its candle cache (about 750 MB) run on a workstation, never on Railway (the volume is nearly full).

1. Re-run the harness locally (see `docs/replay-harness.md` on `research/replay-harness`): fetch candles,
   `run-shards.js`, the fidelity check, then `report.js`.
2. Re-export:

   ```bash
   node scripts/research/export-track-records.js \
     --run <harness worktree>/.replay-cache/runs/main \
     --variant V1 \
     --variant-reason "Production blocks short setups (direction:short disabled_by_admin), the harness's V1 filter." \
     --harness-commit <full harness commit>
   ```

   If production starts allowing shorts or adds a daily-trend gate, export the matching variant (V0 or V2-V4) and the
   matching `--directions`. Then update this document.
3. Run `npm run test:track-records` and `npm run test:claims-lint`, review the diff of the JSON, commit it and deploy.

Only the label wording and thresholds above are fixed. A refresh can move any record into a different label, and that
is expected.
