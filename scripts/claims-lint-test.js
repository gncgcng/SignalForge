import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Claims lint: user-facing copy must not promise accuracy, wins or profit. Every sentence has to
// be true on the day it ships, and SignalForge doesn't publish a track record yet. This scans the
// sources that render text users see and fails on any banned phrase.

const root = fileURLToPath(new URL("..", import.meta.url));

export const BANNED_PHRASES = [
  "high-probability",
  "high probability",
  "near-perfect",
  "guaranteed",
  "proven",
  "beat the market",
  "accurate signals",
  "winning signals",
  "profitable signals"
];

// "elite" is banned as a confidence label. These are the only allowed uses, and each one is about
// the old Elite *plan* or maps a legacy confidence label to its replacement.
export const ELITE_ALLOWED_LINES = [
  /\bvalue === "elite"\) return "Elite";/, // plan badge for existing Elite subscribers
  /\["New Elite", overview\.users\?\.newElite\]/, // admin count of Elite-plan signups
  /^\s*elite: "Strong match",\s*$/ // legacy stored confidence band -> new label
];

export function userFacingSources() {
  const htmlFiles = readdirSync(join(root, "public"))
    .filter((name) => name.endsWith(".html"))
    .map((name) => `public/${name}`);
  return [
    ...htmlFiles,
    "public/app.js", // app copy, tooltips, signal cards and the legal-text renderer (legalDocuments)
    "public/manifest.json",
    "src/modules/notifications/emailTemplates.js",
    "src/modules/notifications/notificationService.js" // Telegram message templates
  ];
}

export function findClaimViolations(text, file) {
  const violations = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      const pattern = new RegExp(`(^|[^a-z0-9])${phrase.replace(/[-\s]/g, (c) => (c === "-" ? "-" : "\\s+"))}(?![a-z0-9])`, "i");
      if (pattern.test(lower)) violations.push({ file, line: index + 1, phrase, text: line.trim().slice(0, 160) });
    }
    if (/\belite\b/i.test(line) && !ELITE_ALLOWED_LINES.some((allowed) => allowed.test(line))) {
      violations.push({ file, line: index + 1, phrase: "elite", text: line.trim().slice(0, 160) });
    }
  });
  return violations;
}

// Self-check: the matcher catches what it should and ignores what it should.
assert.equal(findClaimViolations("Start Finding High-Probability Setups", "x").length, 1);
assert.equal(findClaimViolations("high   probability", "x").length, 1);
assert.equal(findClaimViolations("Results are GUARANTEED", "x").length, 1);
assert.equal(findClaimViolations('if (value >= 95) return "Elite";', "x").length, 1);
assert.equal(findClaimViolations("function findProvenExactSourceStrategyTimeframe() {}", "x").length, 0);
assert.equal(findClaimViolations("Past results do not guarantee future results.", "x").length, 0);
assert.equal(findClaimViolations('  if (value === "elite") return "Elite";', "x").length, 0);

const sources = userFacingSources();
const violations = sources.flatMap((file) =>
  findClaimViolations(readFileSync(join(root, file), "utf8"), relative(root, join(root, file)).replaceAll("\\", "/")));

if (violations.length) {
  console.error(`Claims lint found ${violations.length} banned phrase(s):`);
  for (const item of violations) console.error(`  ${item.file}:${item.line} [${item.phrase}] ${item.text}`);
}
assert.equal(violations.length, 0, "user-facing copy contains banned claims");
console.log(JSON.stringify({ filesScanned: sources, bannedPhrases: [...BANNED_PHRASES, "elite (as a label)"], violations: 0 }, null, 2));
