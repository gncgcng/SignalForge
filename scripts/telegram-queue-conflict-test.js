import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

process.env.TELEGRAM_BOT_TOKEN = "fixture-token";
process.env.CRYPTO_WATCHER_ENABLED = "false";

const mockSource = `
let mode = "legacy";
let rows = [];
let settings = null;
export function reset(nextMode, nextSettings = null) { mode = nextMode; rows = []; settings = nextSettings; }
export function snapshot() { return structuredClone(rows); }
export function insertProductionVariant({ userId, chatId, setupKey, alertType }) {
  const duplicate = rows.some((row) => row.user_id === userId && row.chat_id === chatId &&
    row.setup_key === setupKey && row.alert_type === alertType);
  if (duplicate) return false;
  rows.push({ id: "variant-" + rows.length, user_id: userId, chat_id: chatId,
    setup_key: setupKey, alert_type: alertType, payload: {} });
  return true;
}
export async function query(sql, params = []) {
  const normalized = String(sql).replace(/\\s+/g, " ").trim().toLowerCase();
  if (normalized.includes("from telegram_notification_settings") && normalized.includes("where user_id = $1")) {
    return { rows: settings ? [structuredClone(settings)] : [] };
  }
  if (normalized.includes("from user_watchlists")) return { rows: [] };
  if (!normalized.includes("insert into telegram_notification_queue")) return { rows: [] };
  const explicitLegacyTarget = normalized.includes("on conflict (user_id, setup_key)");
  if (mode === "production" && explicitLegacyTarget) {
    throw new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification");
  }
  const candidate = { id: params[0], user_id: params[1], setup_key: params[2], chat_id: params[3],
    payload: JSON.parse(params[4]), alert_type: "ready_trade" };
  const duplicate = mode === "legacy"
    ? rows.some((row) => row.user_id === candidate.user_id && row.setup_key === candidate.setup_key)
    : rows.some((row) => row.user_id === candidate.user_id && row.chat_id === candidate.chat_id &&
        row.setup_key === candidate.setup_key && row.alert_type === candidate.alert_type);
  if (duplicate) return { rows: [] };
  rows.push(candidate);
  return { rows: [{ id: candidate.id }] };
}
export async function transaction(callback) { return callback({ query }); }
`;
const mockUrl = `data:text/javascript;base64,${Buffer.from(mockSource).toString("base64")}`;
const loaderSource = `
const mockUrl = ${JSON.stringify(mockUrl)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (String(resolved.url || "").replaceAll("\\\\", "/").endsWith("/src/db/client.js")) {
    return { url: mockUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(`data:text/javascript;base64,${Buffer.from(loaderSource).toString("base64")}`, import.meta.url);

const transport = await import(mockUrl);
const { enqueueTelegramNotification } = await import("../src/db/repositories.js");
const { enqueueMatchingTelegramNotifications } = await import("../src/modules/notifications/notificationService.js");
const repositorySource = await readFile(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const enqueueSource = extractFunction(repositorySource, "enqueueTelegramNotification");

assert.match(enqueueSource, /ON CONFLICT\s+DO NOTHING/i);
assert.doesNotMatch(enqueueSource, /ON CONFLICT\s*\(\s*user_id\s*,\s*setup_key\s*\)/i);
assert.doesNotMatch(enqueueSource, /SELECT[\s\S]*INSERT INTO telegram_notification_queue/i);

const baseSetup = buildSetup();
const legacy = await exerciseSchema("legacy", baseSetup);
assert.equal(legacy.firstInserted, true);
assert.equal(legacy.duplicate, null);
assert.equal(legacy.differentChat, null, "Legacy schema must retain its broader database uniqueness.");
assert.equal(legacy.rows.length, 1);
assert.equal(legacy.rows[0].payload.reasoning, "first payload");

const production = await exerciseSchema("production", baseSetup);
assert.equal(production.firstInserted, true);
assert.equal(production.duplicate, null);
assert.equal(production.differentChatInserted, true);
assert.equal(production.rows.length, 2);
assert.equal(production.rows[0].payload.reasoning, "first payload");
assert.equal(transport.insertProductionVariant({
  userId: "user-queue",
  chatId: "chat-a",
  setupKey: baseSetup.setupKey,
  alertType: "watching"
}), true, "Production schema must permit a distinct alert type.");

transport.reset("production", buildSettings("chat-a"));
const callerFirst = await enqueueMatchingTelegramNotifications({ id: "user-queue" }, [baseSetup]);
const callerDuplicate = await enqueueMatchingTelegramNotifications({ id: "user-queue" }, [baseSetup]);
assert.equal(callerFirst.length, 1);
assert.deepEqual(callerDuplicate, [], "Existing caller must interpret null as a skipped duplicate.");
assert.equal(transport.snapshot().length, 1);

console.log(JSON.stringify({
  sql: "ON CONFLICT DO NOTHING",
  legacy: {
    firstInserted: legacy.firstInserted,
    exactDuplicateReturnedNull: legacy.duplicate === null,
    existingPayloadPreserved: legacy.rows[0].payload.reasoning === "first payload"
  },
  production: {
    firstInserted: production.firstInserted,
    exactDuplicateReturnedNull: production.duplicate === null,
    differentChatInserted: production.differentChatInserted,
    differentAlertTypePermitted: true,
    existingPayloadPreserved: production.rows[0].payload.reasoning === "first payload"
  },
  callerDuplicateSkipped: callerDuplicate.length === 0,
  limitation: "Deterministic database transport models both unique-index generations; it does not parse SQL with a live PostgreSQL server."
}, null, 2));

async function exerciseSchema(mode, setup) {
  transport.reset(mode);
  const first = await enqueueTelegramNotification("user-queue", buildSettings("chat-a"), {
    ...setup,
    reasoning: "first payload"
  });
  const duplicate = await enqueueTelegramNotification("user-queue", buildSettings("chat-a"), {
    ...setup,
    reasoning: "replacement payload"
  });
  const differentChat = await enqueueTelegramNotification("user-queue", buildSettings("chat-b"), {
    ...setup,
    reasoning: "second chat"
  });
  return {
    firstInserted: Boolean(first?.id),
    duplicate,
    differentChat,
    differentChatInserted: Boolean(differentChat?.id),
    rows: transport.snapshot()
  };
}

function buildSettings(chatId) {
  return {
    userId: "user-queue",
    chatId,
    user_id: "user-queue",
    chat_id: chatId,
    enabled: true,
    favoriteMarketsOnly: false,
    favorite_markets_only: false,
    timeframes: ["15m"],
    direction: "both",
    minimumConfidence: 90,
    minimum_confidence: 90
  };
}

function buildSetup() {
  return {
    id: "signal-ready",
    setupKey: "BTC-USD:15m:long:queue-fixture",
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    confidenceScore: 92,
    resultType: "ready_signal",
    validationPassed: true,
    status: "Active",
    generatedQualityBlocked: false,
    confidenceCalibration: { blocked: false, technicalError: false },
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  };
}

function extractFunction(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `Could not find ${name}.`);
  const openingBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unbalanced ${name} source.`);
}
