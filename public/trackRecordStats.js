// Statistics shared by the setup track records (scripts/research/track-records/stats.js re-exports these) and the
// user's own trade record ("My trades", public/journalStats.js). Pure: no I/O, no clock, seeded randomness only.
// Lives in public/ so the browser computes a user's record with exactly the same rules as the published records.

export const MIN_CASES = 30;
// Same defaults as the harness's month-block bootstrap (scripts/research/daily-trend/metrics.js, research/in-out).
export const BOOTSTRAP = Object.freeze({ samples: 10000, seed: 20261011 });
const WILSON_Z = 1.96;

// Fixed before looking at the output. Evaluated top to bottom; the first match wins.
export const LABELS = Object.freeze({
  notEnoughHistory: "Not enough history yet",
  lostMoney: "Has lost money historically",
  madeMoney: "Has made money historically",
  noClearEdge: "No clear edge either way"
});

export function trackRecordLabel({ n, avgR95 }) {
  if (!(n >= MIN_CASES)) return LABELS.notEnoughHistory;
  if (avgR95 && avgR95.high < 0) return LABELS.lostMoney;
  if (avgR95 && avgR95.low > 0) return LABELS.madeMoney;
  return LABELS.noClearEdge;
}

const round = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

// Wilson score interval for a win rate, in percent with one decimal. Same as the helper in
// scripts/weekly-realized-r-decomposition.js (a test keeps the two identical).
export function wilsonInterval(successes, trials, z = WILSON_Z) {
  if (!trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { low: round(Math.max(0, center - halfWidth) * 100, 1), high: round(Math.min(1, center + halfWidth) * 100, 1) };
}

// ---- ported verbatim from the harness helper (research/in-out: scripts/research/daily-trend/metrics.js) ----

// mulberry32: small, fast, fully determined by its seed.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (position - lower);
}

// 95% percentile interval for the mean R per trade, resampling whole calendar months of entries (months that have
// trades) with replacement. Trades in one month across products move together; resampling them as a block keeps that.
export function monthBlockBootstrap(rows, { samples = BOOTSTRAP.samples, seed = BOOTSTRAP.seed } = {}) {
  const blocks = new Map();
  for (const row of rows) {
    const block = blocks.get(row.month) || { sum: 0, count: 0 };
    block.sum += row.r;
    block.count += 1;
    blocks.set(row.month, block);
  }
  const list = [...blocks.values()];
  if (list.length < 2) return null;
  const random = seededRandom(seed);
  const means = new Float64Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < list.length; draw += 1) {
      const block = list[Math.floor(random() * list.length)];
      sum += block.sum;
      count += block.count;
    }
    means[sample] = sum / count;
  }
  means.sort();
  return { low: percentile(means, 0.025), high: percentile(means, 0.975), months: list.length };
}
