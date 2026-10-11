// Renders every transactional email with sample data into .email-previews/ (gitignored):
// one .html and one .txt per email, plus index.html linking them. Sends nothing.
//
//   npm run email:preview
// Links use APP_URL (default https://signalforge-app.com here); EMAIL_FOOTER_ADDRESS shows the footer address line.
process.env.APP_URL ||= "https://signalforge-app.com";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { emailSamples } = await import("./test-support/email-samples.js");
const outputDirectory = fileURLToPath(new URL("../.email-previews/", import.meta.url));
mkdirSync(outputDirectory, { recursive: true });

const samples = emailSamples();
for (const { name, email } of samples) {
  writeFileSync(join(outputDirectory, `${name}.html`), email.html);
  writeFileSync(join(outputDirectory, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
}

const rows = samples.map(({ name, email }) =>
  `<li><a href="${name}.html">${name}</a> · <a href="${name}.txt">text</a> — ${escape(email.subject)}</li>`).join("\n");
writeFileSync(join(outputDirectory, "index.html"), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SignalForge email previews</title>
<style>body{font:15px/1.6 Arial,sans-serif;margin:32px;max-width:760px}li{margin:6px 0}</style></head>
<body><h1>SignalForge email previews</h1><p>Links point at ${escape(process.env.APP_URL)}.</p><ul>
${rows}
</ul></body></html>
`);

console.log(`Wrote ${samples.length} emails to ${outputDirectory}`);
console.log(`Open ${join(outputDirectory, "index.html")}`);

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
