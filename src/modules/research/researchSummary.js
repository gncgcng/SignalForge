import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Research figures quoted on /research. Each figure in data/research/summary.v1.json names the committed report it was
// copied from and a pattern that finds it in that report's text; verifyResearchSummary re-extracts every one.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SUMMARY_PATH = join(REPO_ROOT, "data", "research", "summary.v1.json");

export function loadResearchSummary(path = SUMMARY_PATH) {
  const summary = JSON.parse(readFileSync(path, "utf8"));
  if (summary?.schema !== "signalforge.research-summary" || summary?.version !== 1) {
    throw new Error(`Unexpected research summary schema ${summary?.schema} v${summary?.version}`);
  }
  return summary;
}

export function figureValue(summary, id) {
  const figure = summary.figures.find((item) => item.id === id);
  if (!figure) throw new Error(`Research summary has no figure ${id}`);
  return figure.value;
}

// Git's blob id for text content. Checkouts may convert line endings, so it is computed on LF text, the form the
// reports are stored in.
export function gitBlobId(text) {
  const body = Buffer.from(String(text).replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest("hex");
}

function extract(figure, text) {
  if (figure.aggregate) {
    const matches = [...text.matchAll(new RegExp(figure.pattern, "gm"))].map((match) => Number(match[1]));
    if (figure.expectedMatches != null && matches.length !== figure.expectedMatches) {
      return { error: `expected ${figure.expectedMatches} matches, found ${matches.length}` };
    }
    if (!matches.length) return { error: "pattern not found" };
    return { value: figure.aggregate === "min" ? Math.min(...matches) : Math.max(...matches) };
  }
  const match = text.match(new RegExp(figure.pattern, "m"));
  if (!match) return { error: "pattern not found" };
  const raw = match[1];
  return { value: typeof figure.value === "number" ? Number(raw) : raw };
}

// Returns a list of problems; empty means every figure and every source copy checks out.
export function verifyResearchSummary(summary, readText = (path) => readFileSync(join(REPO_ROOT, path), "utf8")) {
  const problems = [];
  const texts = new Map();
  for (const [key, source] of Object.entries(summary.sources)) {
    let text;
    try {
      text = readText(source.path).replace(/\r\n/g, "\n");
    } catch (error) {
      problems.push(`${key}: cannot read ${source.path} (${error.message})`);
      continue;
    }
    texts.set(key, text);
    const blob = gitBlobId(text);
    if (blob !== source.blob) problems.push(`${key}: ${source.path} is not the recorded copy (blob ${blob}, recorded ${source.blob})`);
  }
  for (const figure of summary.figures) {
    const text = texts.get(figure.source);
    if (text === undefined) {
      problems.push(`${figure.id}: unknown or unreadable source ${figure.source}`);
      continue;
    }
    const result = extract(figure, text);
    if (result.error) problems.push(`${figure.id}: ${result.error} in ${summary.sources[figure.source].path}`);
    else if (result.value !== figure.value) problems.push(`${figure.id}: summary says ${JSON.stringify(figure.value)}, ${summary.sources[figure.source].path} says ${JSON.stringify(result.value)}`);
  }
  return problems;
}
