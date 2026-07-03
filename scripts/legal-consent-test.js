import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const authService = readFileSync(new URL("../src/modules/auth/authService.js", import.meta.url), "utf8");
const authController = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");

const result = {
  signupConsentCheckbox:
    html.includes('id="legal-consent"') &&
    html.includes("I agree to the") &&
    html.includes('data-legal-doc="terms"') &&
    html.includes('data-legal-doc="privacy"') &&
    html.includes('data-legal-doc="risk"'),
  legalDocumentsOpenInModal:
    html.includes('id="legal-modal"') &&
    app.includes("const legalDocuments = {") &&
    app.includes("function openLegalDocument(documentKey)") &&
    app.includes("legalModal.classList.remove(\"hidden\")") &&
    app.includes("document.querySelectorAll(\"[data-legal-doc]\")"),
  footerLinks:
    html.includes("landing-footer") &&
    html.includes("Privacy Policy") &&
    html.includes("Risk Disclaimer") &&
    css.includes(".footer-links"),
  frontendSubmitsConsent:
    app.includes("credentials.legalConsentAccepted = legalConsent.checked") &&
    app.includes("legalConsent.checked") &&
    app.includes("Agree to the Terms, Privacy Policy, and Risk Disclaimer"),
  backendBlocksSignupWithoutConsent:
    authService.includes("legalConsentAccepted") &&
    authService.includes("legalConsentAccepted !== true") &&
    authService.includes("before creating an account"),
  googleStartRequiresConsent:
    authController.includes('pathname === "/api/auth/google/start"') &&
    authController.includes("body.legalConsentAccepted !== true") &&
    app.includes("legalConsentAccepted: true"),
  signalAndCheckoutDisclaimers:
    html.includes("Educational tool only. Not financial advice.") &&
    html.includes("Subscriptions and credit packs provide access to research tools only."),
  affiliateDisclosure:
    html.includes("Affiliates may earn commissions from paid subscriptions.") &&
    app.includes("Affiliate disclosure: Affiliates may earn commissions from paid subscriptions."),
  mobileFriendly:
    css.includes(".consent-row") &&
    css.includes(".legal-modal-panel") &&
    css.includes("@media (max-width: 767px)") &&
    css.includes(".legal-modal {\n    padding: 12px;")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Legal consent check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
