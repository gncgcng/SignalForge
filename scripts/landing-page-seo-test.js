import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
const landingMockup = html.slice(
  html.indexOf('aria-label="SignalForge app preview"'),
  html.indexOf('id="how-it-works"')
);

const result = {
  seoMetadata:
    html.includes("<title>SignalForge | Crypto Trading Signal Scanner</title>") &&
    html.includes('name="description" content="SignalForge is a crypto trading signal scanner and setup assistant') &&
    html.includes('rel="canonical" href="https://signalforge-app.xyz/"') &&
    html.includes('property="og:title" content="SignalForge | Crypto Trading Signal Scanner"') &&
    html.includes('name="twitter:card" content="summary_large_image"'),
  structuredData:
    html.includes('"@type": "SoftwareApplication"') &&
    html.includes('"@type": "FAQPage"') &&
    html.includes("SignalForge is a crypto trading signal scanner and trading setup assistant"),
  conversionHero:
    html.includes("Stop Searching Charts. Start Finding High-Probability Setups.") &&
    html.includes("Start Free") &&
    html.includes("3 Free Signal Unlocks") &&
    html.includes("Watch Demo") &&
    html.includes("Telegram Ready") &&
    html.includes("Educational Tool Only. Not Financial Advice."),
  requiredSections:
    html.includes('id="how-it-works"') &&
    html.includes('id="why-signalforge"') &&
    html.includes('id="features"') &&
    html.includes('id="live-preview"') &&
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
    html.includes("Earn While Others Trade.") &&
    html.includes("20% recurring commission") &&
    html.includes("Become an Affiliate") &&
    html.includes("Affiliate disclosure"),
  premiumSaasUx:
    html.includes("Manual Trading") &&
    html.includes("SignalForge") &&
    html.includes("Automatic scanning") &&
    html.includes('id="landing-run-scan"') &&
    html.includes("Signal Found") &&
    html.includes("Unlock Preview") &&
    html.includes('class="landing-band performance-preview hidden"'),
  landingDemoDoesNotLeakFakeLevels:
    /<span>Entry<\/span>\s*<strong>Unlock to view<\/strong>/.test(landingMockup) &&
    /<span>Take Profit<\/span>\s*<strong>Unlock to view<\/strong>/.test(landingMockup) &&
    /<span>Stop Loss<\/span>\s*<strong>Unlock to view<\/strong>/.test(landingMockup) &&
    !/68,?420|70,?060|67,?730/.test(landingMockup),
  mobileResponsiveStyles:
    styles.includes(".premium-hero-layout") &&
    styles.includes(".app-mockup-card") &&
    styles.includes(".comparison-table") &&
    styles.includes(".landing-demo-shell") &&
    styles.includes("@media (max-width: 760px)") &&
    styles.includes(".premium-feature-grid") &&
    styles.includes(".faq-accordion"),
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
