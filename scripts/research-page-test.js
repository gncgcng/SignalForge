import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatCount, formatPercent, formatR } from "../public/trackRecords.js";
import { loadTrackRecords } from "../src/modules/track-records/trackRecordService.js";
import { loadResearchSummary } from "../src/modules/research/researchSummary.js";
import { RESEARCH_URL, renderResearchPage, researchFigures } from "../src/modules/research/researchPage.js";
import { handleResearchPage, loadResearchData } from "../src/modules/research/researchController.js";

const trackRecords = loadTrackRecords();
const summary = loadResearchSummary();
const html = renderResearchPage({ trackRecords, summary });
const text = html
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&#039;", "'")
  .replace(/\s+/g, " ");
const results = {};
const check = (name, fn) => { fn(); results[name] = true; };
const meta = (attribute, name) => html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`))?.[1];

check("real HTML head: title, description, canonical, og and twitter tags", () => {
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>We tested our own trading signals\. They lost money\. \| SignalForge<\/title>/);
  assert.ok(meta("name", "description").length > 50);
  assert.match(html, new RegExp(`<link rel="canonical" href="${RESEARCH_URL}" />`));
  assert.equal(meta("property", "og:url"), RESEARCH_URL);
  assert.equal(meta("property", "og:title"), "We tested our own trading signals. They lost money.");
  assert.ok(meta("property", "og:description"));
  assert.ok(meta("property", "og:image"));
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  assert.ok(meta("name", "twitter:title"));
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css" \/>/);
});

check("every number on the page comes from the data files", () => {
  const figures = researchFigures(trackRecords, summary);
  const all = trackRecords.records.find((record) => record.key === "all-setups");
  assert.equal(figures.intraday.cases, all.n);
  for (const expected of [
    `Across ${formatCount(all.n)} past long setups`,
    `on ${trackRecords.pairs.length} liquid crypto pairs (Jan 2022 – Oct 2026)`,
    `won ${formatPercent(all.winRate)} of the time but needed ${formatPercent(all.breakEvenWinRate)} to break even`,
    `Average result: ${formatR(all.avgR)} per trade after low fees (0.20% round trip), and ${formatR(all.retailAvgR)} at typical retail fees (1.20% round trip)`,
    "none of the 226 strategy, direction and timeframe combinations we could judge passed",
    "12 versions tested on 2016–2024. One passed, then failed on 2025–2026 data it had never seen (−0.079R per trade after fees)",
    "5 rules × 2 coins. None cut the worst crash by the 40% we required: the deepest falls were 64.3–87.4%",
    "They did better in 2022–2026",
    `${formatR(all.avgR)} means that for every $100 risked per trade, you lost about $${Math.round(Math.abs(all.avgR) * 100)} on average`,
    "a round trip costs 1.20% in fees"
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
});

check("table: All setups first, then only records with at least 30 cases", () => {
  const tbody = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const rowNames = [...tbody.matchAll(/<th scope="row">([^<]*)/g)].map((match) => match[1].trim());
  assert.equal(rowNames[0], "All setups");
  const expected = trackRecords.records.filter((record) => record.scope === "setup" && record.n >= 30);
  assert.equal(rowNames.length, expected.length + 1);
  assert.ok(!rowNames.some((name) => / · short · /.test(name)), "no short records");
  for (const label of new Set(expected.map((record) => record.label))) assert.ok(tbody.includes(label));
});

check("methodology, disclaimer and calculator are on the page", () => {
  for (const expected of [
    "What a replay is", "Why history may look better than it was", "How closely the replay matches live",
    "52 of the 56 live setups (92.9%)", "21 of 24 replay setups matched a live one (87.5%)",
    "Past results do not guarantee future results.", "SignalForge provides information and tools, not financial advice.",
    "What do fees cost you per trade?"
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
  for (const id of ["fc-entry", "fc-stop", "fc-fee", "fc-slippage", "fc-target", "fee-calculator-results"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const preset of ["0.10", "0.25", "0.60"]) assert.match(html, new RegExp(`data-fee-preset="${preset}"`));
  assert.match(html, /<script type="module" src="\/research\.js"><\/script>/);
});

check("served at /research without a session; landing and sitemap link to it", () => {
  loadResearchData();
  const response = { headers: null, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(chunk = "") { this.body += chunk; } };
  assert.equal(handleResearchPage({ method: "GET", headers: {} }, response, "/research"), true);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /We tested our own trading signals/);
  assert.equal(handleResearchPage({ method: "GET", headers: {} }, { writeHead() {}, end() {} }, "/research/x"), false);
  const landing = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(landing, /<a class="secondary-anchor hero-research-link" href="\/research">See our research<\/a>/);
  assert.match(landing, /<div class="footer-links">[\s\S]*?<a href="\/research">Research<\/a>/);
  assert.match(readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8"), /<loc>https:\/\/signalforge-app\.com\/research<\/loc>/);
});

console.log(JSON.stringify(results, null, 2));
