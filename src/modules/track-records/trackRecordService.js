import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Per-setup track records, exported locally from the replay harness (scripts/research/export-track-records.js) and
// committed as one versioned JSON file. Loaded once at boot; there is no table and nothing is computed on Railway.
export const TRACK_RECORDS_PATH = fileURLToPath(new URL("../../../data/track-records/track-records.v1.json", import.meta.url));
const EXPECTED_SCHEMA = "signalforge.track-records";
const EXPECTED_VERSION = 1;

let loaded = { available: false, reason: "not_loaded" };

export function parseTrackRecordsFile(text) {
  const file = JSON.parse(text);
  if (file?.schema !== EXPECTED_SCHEMA || file?.version !== EXPECTED_VERSION) {
    throw new Error(`Unexpected track-records schema ${file?.schema} v${file?.version}`);
  }
  if (!Array.isArray(file.records) || !file.records.length) throw new Error("Track-records file has no records");
  return file;
}

// A missing or malformed file must not stop the server: cards then show "No track record yet".
export function loadTrackRecords(path = TRACK_RECORDS_PATH) {
  try {
    const file = parseTrackRecordsFile(readFileSync(path, "utf8"));
    loaded = { available: true, ...file };
    console.info(`[track-records] loaded records=${file.records.length} generated_at=${file.generated_at} harness=${String(file.harness?.commit || "").slice(0, 12)}`);
  } catch (error) {
    loaded = { available: false, reason: "unavailable" };
    console.warn(`[track-records] not loaded: ${error.message}`);
  }
  return loaded;
}

export function getTrackRecords() {
  return loaded;
}
