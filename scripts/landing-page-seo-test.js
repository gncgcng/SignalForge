import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");

const result = {
  seoMetadata:
    html.includes("<title>SignalForge | Crypto Trading Signal Scanner</title>") &&
    html.includes('name="description" content="SignalForge is a trading signal scanner for crypto markets') &&
    html.includes('rel="canonical" href="https://signalforge-app.xyz/"') &&
    html.includes('property="og:title" content="SignalForge | Crypto Trading Signal Scanner"') &&
    html.includes('name="twitter:card" content="summary_large_image"'),
  structuredData:
    html.includes('"@type": "SoftwareApplication"') &&
    html.includes('"@type": "FAQPage"') &&
    html.includes("SignalForge is a crypto trading signal scanner and trading setup assistant"),
  conversionHero:
    html.includes("Find high-probability trading setups in seconds.") &&
    html.includes("Start with 3 free unlocks") &&
    html.includes("View demo") &&
    html.includes("Telegram alert ready") &&
    html.includes("Educational tool only. Not financial advice."),
  requiredSections:
    html.includes('id="how-it-works"') &&
    html.includes('id="features"') &&
    html.includes('id="markets-covered"') &&
    html.includes('id="pricing"') &&
    html.includes('id="affiliate-program"') &&
    html.includes('id="faq"'),
  targetCopy:
    html.includes("crypto trading signals") &&
    html.includes("BTC trading signals") &&
    html.includes("Ethereum trading signals") &&
    html.includes("Gold trading signals") &&
    html.includes("Telegram trading alerts") &&
    html.includes("Paper trading journal"),
  affiliateDisclosure:
    html.includes("Earn recurring commissions by referring paid subscribers.") &&
    html.includes("20% recurring commission") &&
    html.includes("Affiliate disclosure"),
  mobileResponsiveStyles:
    styles.includes(".hero-layout") &&
    styles.includes(".hero-signal-card") &&
    styles.includes("@media (max-width: 760px)") &&
    styles.includes(".feature-grid") &&
    styles.includes(".faq-grid"),
  crawlFiles:
    robots.includes("Allow: /") &&
    robots.includes("https://signalforge-app.xyz/sitemap.xml") &&
    sitemap.includes("<loc>https://signalforge-app.xyz/</loc>") &&
    sitemap.includes("<loc>https://signalforge-app.xyz/#pricing</loc>"),
  pwaDescription:
    manifest.description.includes("Crypto trading signal scanner") &&
    manifest.theme_color === "#000000" &&
    manifest.background_color === "#000000"
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Landing page SEO check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
