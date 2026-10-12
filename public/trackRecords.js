// Track records on setup cards: historical frequencies from the replay harness, never a prediction. Pure helpers so
// tests can run them under Node. Data comes from GET /api/track-records (data/track-records/track-records.v1.json).

export const ALL_SETUPS_KEY = "all-setups";
export const NO_TRACK_RECORD = "No track record yet";
export const LABEL_TONES = Object.freeze({
  "Not enough history yet": "neutral",
  "No clear edge either way": "neutral",
  "Has lost money historically": "loss",
  "Has made money historically": "gain"
});

export function trackRecordKey(strategy, direction, timeframe) {
  return `${String(strategy || "").trim().toLowerCase()}|${String(direction || "").trim().toLowerCase()}|${String(timeframe || "").trim().toLowerCase()}`;
}

export function indexTrackRecords(file) {
  const index = new Map();
  if (!file?.available || !Array.isArray(file.records)) return index;
  for (const record of file.records) index.set(record.key, record);
  return index;
}

const MINUS = "−";

export function formatR(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  const number = Number(value);
  const text = Math.abs(number).toFixed(digits);
  if (Number(text) === 0) return `${(0).toFixed(digits)}R`;
  return `${number < 0 ? MINUS : "+"}${text}R`;
}

export function formatPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? "n/a" : `${Math.round(Number(value))}%`;
}

export function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function sentenceCase(label) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

// The card's view model. Short setups get no block at all (shorts are blocked in production and have no published
// record); a setup with no matching record gets "No track record yet".
export function buildTrackRecordView(file, setup, index = indexTrackRecords(file)) {
  const direction = String(setup?.direction || "").trim().toLowerCase();
  if (direction === "short") return { render: false };
  const strategy = setup?.setupType || setup?.strategy;
  const record = index.get(trackRecordKey(strategy, direction, setup?.timeframe));
  if (!record) return { render: true, matched: false, tone: "neutral", label: NO_TRACK_RECORD };
  return describeTrackRecord(record, file);
}

export function describeTrackRecord(record, file) {
  const retailAvailable = file?.fees?.retailAvailable !== false && record.retailAvgR != null;
  const retailFee = file?.fees?.retailRoundTrip != null ? `${(file.fees.retailRoundTrip * 100).toFixed(2)}%` : null;
  return {
    render: true,
    matched: true,
    key: record.key,
    tone: LABEL_TONES[record.label] || "neutral",
    label: record.label,
    heading: `Track record: ${sentenceCase(record.label)}`,
    casesLine: [
      `${formatCount(record.n)} past case${record.n === 1 ? "" : "s"}`,
      record.n ? `won ${formatPercent(record.winRate)}${record.breakEvenWinRate != null ? ` (break-even needs ${formatPercent(record.breakEvenWinRate)})` : ""}` : null,
      `average ${formatR(record.avgR)} per trade after fees`
    ].filter(Boolean).join(" · "),
    retailLine: retailAvailable
      ? `At typical retail fees${retailFee ? ` (${retailFee} round trip)` : ""}: ${formatR(record.retailAvgR)}`
      : "Higher fees make these results worse.",
    approximate: Boolean(record.approximate)
  };
}

export function renderTrackRecordBlock(view, escapeHtml) {
  if (!view?.render) return "";
  const link = `<a class="track-record-link" href="#track-records">How we measure this</a>`;
  if (!view.matched) {
    return `
      <section class="track-record track-record-neutral" aria-label="Track record">
        <strong class="track-record-heading">${escapeHtml(view.label)}</strong>
        <p class="track-record-detail">${link}</p>
      </section>`;
  }
  return `
    <section class="track-record track-record-${escapeHtml(view.tone)}" aria-label="Track record" data-track-record-key="${escapeHtml(view.key)}">
      <strong class="track-record-heading">${escapeHtml(view.heading)}</strong>
      <p class="track-record-detail">${escapeHtml(view.casesLine)}</p>
      <p class="track-record-detail">${escapeHtml(view.retailLine)} · ${link}</p>
      ${view.approximate ? `<p class="track-record-note">Approximate: the 5m replay could not be fully checked against live.</p>` : ""}
    </section>`;
}

// Table order: "All setups" always first, then the chosen column.
export const SORTABLE_COLUMNS = Object.freeze({
  n: (record) => record.n,
  winRate: (record) => record.winRate,
  avgR: (record) => record.avgR
});

export function sortTrackRecords(records, column = "n", direction = "desc") {
  const valueOf = SORTABLE_COLUMNS[column] || SORTABLE_COLUMNS.n;
  const sign = direction === "asc" ? 1 : -1;
  const pinned = records.filter((record) => record.key === ALL_SETUPS_KEY);
  const rest = records.filter((record) => record.key !== ALL_SETUPS_KEY).sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (left == null && right == null) return a.key.localeCompare(b.key);
    if (left == null) return 1;
    if (right == null) return -1;
    return (left - right) * sign || a.key.localeCompare(b.key);
  });
  return [...pinned, ...rest];
}
