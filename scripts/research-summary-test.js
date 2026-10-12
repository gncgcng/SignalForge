import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadResearchSummary, verifyResearchSummary } from "../src/modules/research/researchSummary.js";

// Every research figure quoted on /research must match the committed report it was copied from. Hand-editing a number
// in data/research/summary.v1.json, or editing a report copy, makes this fail.

const summary = loadResearchSummary();
const results = {};
const check = (name, fn) => { fn(); results[name] = true; };

check("every figure matches its source report", () => {
  assert.deepEqual(verifyResearchSummary(summary), []);
});

check("every figure names a known source with a pattern", () => {
  assert.ok(summary.figures.length >= 20);
  for (const figure of summary.figures) {
    assert.ok(summary.sources[figure.source], `${figure.id} has unknown source ${figure.source}`);
    assert.equal(typeof figure.pattern, "string");
    for (const field of ["path", "originalBranch", "originalCommit", "blob"]) {
      assert.ok(summary.sources[figure.source][field], `${figure.source} is missing ${field}`);
    }
  }
});

check("changing any figure by hand is caught", () => {
  for (const figure of summary.figures) {
    const tampered = structuredClone(summary);
    const target = tampered.figures.find((item) => item.id === figure.id);
    target.value = typeof target.value === "number" ? target.value + 1 : `${target.value}x`;
    const problems = verifyResearchSummary(tampered);
    assert.ok(problems.some((problem) => problem.startsWith(`${figure.id}:`)), `tampering ${figure.id} was not caught`);
  }
});

check("editing a source copy is caught", () => {
  const source = summary.sources.dailyTrendHoldout;
  const original = readFileSync(join(REPO_ROOT, source.path), "utf8");
  const problems = verifyResearchSummary(summary, (path) =>
    path === source.path ? original.replace("avg R -0.079", "avg R -0.010") : readFileSync(join(REPO_ROOT, path), "utf8"));
  assert.ok(problems.some((problem) => problem.startsWith("dailyTrendHoldout:")), "blob change not caught");
  assert.ok(problems.some((problem) => problem.startsWith("dailyTrendHoldoutAvgR:")), "figure change not caught");
});

check("the draft's corrected figure is the source's", () => {
  // The draft said the deepest falls were 66.8-87.4%; the in-out development report's ten cells give 64.3-87.4%.
  assert.equal(summary.figures.find((figure) => figure.id === "inOutDeepestFallMin").value, 64.3);
  assert.equal(summary.figures.find((figure) => figure.id === "inOutDeepestFallMax").value, 87.4);
});

console.log(JSON.stringify(results, null, 2));
