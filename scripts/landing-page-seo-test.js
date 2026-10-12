import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
const landingMockup = html.slice(
  html.indexOf('aria-label="SignalForge app preview"'),
  html.indexOf('id="quick-start"')
);

const result = {
  seoMetadata:
    html.includes("<title>SignalForge | Know the odds before you trade</title>") &&
    html.includes('name="description" content="Know the odds before you trade. SignalForge scans crypto markets for rule-based trading setups') &&
    html.includes('rel="canonical" href="https://signalforge-app.com/"') &&
    html.includes('property="og:title" content="SignalForge | Know the odds before you trade"') &&
    html.includes('property="og:description" content="Know the odds before you trade.') &&
    html.includes('name="twitter:description" content="Know the odds before you trade.') &&
    html.includes('name="twitter:card" content="summary_large_image"'),
  structuredData:
    html.includes('"@type": "SoftwareApplication"') &&
    html.includes('"@type": "FAQPage"') &&
    html.includes("Know the odds before you trade. SignalForge scans crypto markets for rule-based trading setups") &&
    // Pro/Elite are not purchasable while checkout is paused, so they are not offered.
    !html.includes('"name": "Pro"') &&
    !html.includes('"name": "Elite"'),
  conversionHero:
    html.includes("<h1>Know the odds before you trade</h1>") &&
    html.includes("We test our own rules honestly and publish the results, good or bad. Every long setup now shows its historical track record.") &&
    !html.includes("track records are coming soon") &&
    html.includes("href=\"/research\">See our research</a>") &&
    html.includes("Start Free") &&
    html.includes("3 Free Setup Unlocks") &&
    html.includes("Watch Demo") &&
    html.includes("Telegram Ready") &&
    html.includes("Educational Tool Only. Not Financial Advice."),
  requiredSections:
    html.includes('id="quick-start"') &&
    html.includes('id="public-how-it-works-page"') &&
    html.includes('id="why-signalforge"') &&
    html.includes('id="features"') &&
    html.includes('id="live-preview"') &&
    html.includes('id="markets-covered"') &&
    html.includes('id="pricing"') &&
    html.includes('id="affiliate-program"') &&
    html.includes('id="faq"'),
  targetCopy:
    html.includes("crypto trading setups") &&
    html.includes("BTC and Ethereum pairs") &&
    html.includes("Gold setups") &&
    html.includes("Telegram trading alerts") &&
    html.includes("Paper trading journal") &&
    !/trading signals/i.test(html.slice(0, html.indexOf('id="auth-screen"'))),
  pricingPaused:
    html.includes("<h2>Start free. A new plan is coming soon.</h2>") &&
    html.includes("A new plan is coming soon. Everything in your account stays free until then.") &&
    !html.includes("$9.99") &&
    !html.includes("$19.99") &&
    !html.includes("Choose Pro") &&
    !html.includes("Choose Elite"),
  affiliateDisclosure:
    html.includes("Earn While Others Trade.") &&
    html.includes("20% recurring commission") &&
    html.includes("New subscriptions are paused until the new plan launches.") &&
    html.includes("Become an Affiliate") &&
    html.includes("Affiliate disclosure"),
  premiumSaasUx:
    html.includes("Manual Trading") &&
    html.includes("SignalForge") &&
    html.includes("Automatic scanning") &&
    html.includes('id="landing-run-scan"') &&
    html.includes("Setup Found") &&
    !html.includes("AI-assisted") &&
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
    robots.includes("https://signalforge-app.com/sitemap.xml") &&
    sitemap.includes("<loc>https://signalforge-app.com/</loc>") &&
    sitemap.includes("<loc>https://signalforge-app.com/#pricing</loc>"),
  pwaDescription:
    manifest.description.includes("Know the odds before you trade.") &&
    manifest.theme_color === "#061B22" &&
    manifest.background_color === "#061B22"
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Landing page SEO check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
