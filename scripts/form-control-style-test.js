import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("public/styles.css", "utf8");
const html = readFileSync("public/index.html", "utf8");

for (const token of [
  "--control-bg:", "--control-border:", "--control-placeholder:",
  "--control-focus:", "--control-height:", "--control-padding-x:"
]) assert.match(css, new RegExp(token), `missing shared token ${token}`);

for (const selector of [".sf-input", ".sf-select", ".sf-textarea", "textarea::placeholder", "select option"]) {
  assert.ok(css.includes(selector), `missing reusable control selector ${selector}`);
}

assert.match(css, /textarea\s*\{[\s\S]*?resize: vertical;/);
assert.match(css, /textarea:hover:not\(:disabled\)/);
assert.match(css, /textarea:focus[\s\S]*?box-shadow: var\(--control-shadow-focus\)/);
assert.match(css, /textarea:disabled/);
assert.match(css, /input:-webkit-autofill/);
assert.match(css, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/);

for (const field of [
  'id="history-search-filter"', 'name="subject"', 'name="message"',
  'id="paper-order-notes"', 'id="admin-support-search"'
]) assert.ok(html.includes(field), `${field} must remain covered by the shared native-control selectors`);

const lightControlRules = css.match(/(?:input|textarea|select)[^{]*\{[^}]*background:\s*(?:white|#fff(?:fff)?|#f[0-9a-f]{5})/gi) || [];
assert.deepEqual(lightControlRules, [], "no text control may retain a light background");

console.log("Shared premium form-control style tests passed.");
