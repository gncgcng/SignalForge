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

// ---- Methodology and table markup, shared by the in-app page (#track-records) and the public /research page ----

export function formatTrackRecordDate(isoDate) {
  if (!isoDate) return "unknown";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`));
}

const percentFee = (value) => `${(Number(value) * 100).toFixed(2)}%`;

// The plain-language "how we measure this" text. `tableLinkHtml` is appended to the closing line (trusted markup).
export function renderTrackRecordMethodologyHtml(file, { escapeHtml, tableLinkHtml = "", heading = "h3" }) {
  const h = (text) => `<${heading}>${escapeHtml(text)}</${heading}>`;
  const fidelity = file.fidelity || {};
  const approximate = (file.approximateTimeframes || []).join(", ");
  return `
      <p class="track-records-lead">A track record shows what happened when SignalForge's current rules were replayed over past market data. It is a count of past outcomes, not a prediction, and it is separate from a setup's rule match.</p>

      ${h("What a replay is")}
      <p>We fed past Coinbase candles, one bar at a time, through the same scanner code that runs live, and recorded every setup it would have published. Each setup was then followed on later candles until it reached its take profit, hit its stop loss, or expired. When one candle touched both levels, we counted the stop.</p>

      ${h("What is covered")}
      <p>Setups created from ${escapeHtml(formatTrackRecordDate(file.period?.from))} to ${escapeHtml(formatTrackRecordDate(file.period?.to))} on ${formatCount((file.pairs || []).length)} pairs: ${escapeHtml((file.pairs || []).join(", "))}. Timeframes: ${escapeHtml((file.timeframes || []).join(", "))}. Long setups only, because short setups are switched off in the live scanner.${approximate ? ` Records on ${escapeHtml(approximate)} are marked approximate (see below).` : ""}</p>

      ${h("Fees")}
      <p>Every average subtracts a ${escapeHtml(percentFee(file.fees?.headlineRoundTrip))} round-trip fee, converted to R as the fee divided by the setup's stop distance. Expired setups pay the fee too. The second line on each card repeats the calculation at ${escapeHtml(percentFee(file.fees?.retailRoundTrip))} round trip, which is typical for retail taker orders (about 0.6% per side). Tight stops make fees large in R, so short timeframes are hit hardest.</p>

      ${h("Why history may look better than it was")}
      <p>The pairs were chosen because they are listed and liquid on Coinbase today. Coins that faded away or were delisted are missing, and that survivorship tends to flatter the past.</p>

      ${h("How closely the replay matches live")}
      <p>We compared the replay with what the live scanner actually published. ${fidelity.recallCounts ? `From ${escapeHtml(formatTrackRecordDate(fidelity.recallWindow?.from))} to ${escapeHtml(formatTrackRecordDate(fidelity.recallWindow?.to))}, the replay also found ${formatCount(fidelity.recallCounts.matched)} of the ${formatCount(fidelity.recallCounts.liveSignals)} live setups (${escapeHtml(Number(fidelity.recall).toFixed(1))}%).` : ""} ${fidelity.precisionCounts ? `On 15m bars that live verifiably scanned (${escapeHtml(formatTrackRecordDate(fidelity.precisionWindow?.from))} to ${escapeHtml(formatTrackRecordDate(fidelity.precisionWindow?.to))}), ${formatCount(fidelity.precisionCounts.matched)} of ${formatCount(fidelity.precisionCounts.replaySignalsOnScannedBars)} replay setups matched a live one (${escapeHtml(Number(fidelity.precision).toFixed(1))}%).` : ""} ${fidelity.fiveMinuteNote ? escapeHtml(fidelity.fiveMinuteNote) : ""}</p>

      ${h("How to read a record")}
      <ul>
        <li><strong>Past cases</strong> counts setups that reached their target or their stop. Expired setups are listed separately.</li>
        <li><strong>Won</strong> is the share of past cases that reached the target. <strong>Break-even needs</strong> is the win rate the setup's reward-to-risk requires just to break even.</li>
        <li><strong>Average R per trade</strong> is the average result in units of the risk taken, after fees, across every resolved setup including expired ones. The range in the table is a 95% interval from resampling whole calendar months.</li>
        <li>Each record gets exactly one label, decided in this order: fewer than 30 past cases is "Not enough history yet"; a whole 95% range below zero is "Has lost money historically"; a whole range above zero is "Has made money historically"; anything else is "No clear edge either way".</li>
      </ul>

      <p class="track-records-disclaimer"><strong>Past results do not guarantee future results.</strong> Markets change, and your own fills, fees and slippage will differ. SignalForge provides information and tools, not financial advice.</p>
      <p class="reasoning">Data generated ${escapeHtml(formatTrackRecordDate(String(file.generated_at || "").slice(0, 10)))} from replay commit ${escapeHtml(String(file.harness?.commit || "").slice(0, 7))}.${tableLinkHtml ? ` ${tableLinkHtml}` : ""}</p>`;
}

const labelTone = (label) => (label === "Has lost money historically" ? "loss" : label === "Has made money historically" ? "gain" : "neutral");
const intervalText = (interval, format) => (interval ? `${format(interval.low)} to ${format(interval.high)}` : "n/a");

// The track-record table. `headerCell(key, label)` returns the header content for sortable columns (trusted markup);
// by default it is the escaped label.
export function renderTrackRecordTableHtml(rows, file, { escapeHtml, headerCell = null }) {
  const head = (key, label) => (headerCell ? headerCell(key, label) : escapeHtml(label));
  return `
        <table class="track-records-table">
          <thead>
            <tr>
              <th scope="col">Setup</th>
              <th scope="col">${head("n", "Past cases")}</th>
              <th scope="col">Expired</th>
              <th scope="col">${head("winRate", "Won")}</th>
              <th scope="col">Break-even</th>
              <th scope="col">${head("avgR", "Average R after fees")}</th>
              <th scope="col">At retail fees</th>
              <th scope="col">By year</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((record) => `
              <tr class="${record.key === ALL_SETUPS_KEY ? "track-records-all" : ""}">
                <th scope="row">${escapeHtml(record.key === ALL_SETUPS_KEY ? "All setups" : `${record.strategy} · ${record.direction} · ${record.timeframe}`)}${record.approximate ? ` <span class="track-record-approx">approximate</span>` : ""}</th>
                <td data-label="Past cases">${formatCount(record.n)}</td>
                <td data-label="Expired">${formatCount(record.expired)}</td>
                <td data-label="Won">${escapeHtml(formatPercent(record.winRate))}<small>${escapeHtml(intervalText(record.winRate95, formatPercent))}</small></td>
                <td data-label="Break-even">${escapeHtml(formatPercent(record.breakEvenWinRate))}</td>
                <td data-label="Average R after fees">${escapeHtml(formatR(record.avgR))}<small>${escapeHtml(intervalText(record.avgR95, (value) => formatR(value)))}</small></td>
                <td data-label="At retail fees">${escapeHtml(file.fees?.retailAvailable === false ? "worse" : formatR(record.retailAvgR))}</td>
                <td data-label="By year"><small>${(record.byYear || []).map((year) => `${escapeHtml(String(year.year))}: ${escapeHtml(formatR(year.avgR))} (n ${formatCount(year.n)})`).join("<br>")}</small></td>
                <td data-label="Label"><span class="track-record-label track-record-${labelTone(record.label)}">${escapeHtml(record.label)}</span></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
}

// One line for alerts (Telegram), from the same strategy + direction + timeframe mapping as the cards. Returns null
// for a short: shorts are never sent and never get a record.
export function formatTrackRecordAlertLine(file, setup, index = indexTrackRecords(file)) {
  const view = buildTrackRecordView(file, setup, index);
  if (!view.render) return null;
  if (!view.matched) return "Track record: none yet";
  const record = index.get(view.key);
  return [
    `Track record: ${sentenceCase(record.label)}`,
    record.n ? `won ${formatPercent(record.winRate)}${record.breakEvenWinRate != null ? ` (break-even ${formatPercent(record.breakEvenWinRate)})` : ""}` : null,
    `${formatR(record.avgR)} after fees`
  ].filter(Boolean).join(" · ");
}
