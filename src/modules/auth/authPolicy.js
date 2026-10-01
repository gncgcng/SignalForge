export function isDemoOrTesterIdentity(email = "") {
  const normalized = email.trim().toLowerCase();
  const localPart = normalized.split("@")[0] || "";

  return normalized.endsWith("@signalforge.local") ||
    normalized === "demo@signalforge.app" ||
    normalized === "tester@signalforge.app" ||
    localPart === "demo" ||
    localPart === "tester" ||
    localPart.startsWith("demo-") ||
    localPart.startsWith("tester-");
}

// Bump whenever the Terms, Privacy Policy, or Risk Disclaimer text in public/app.js
// (legalDocuments) changes materially. Recorded on each new account; nothing enforces
// re-consent against it yet.
export const CURRENT_LEGAL_CONSENT_VERSION = "2026-09-30";

// Columns written on account creation. Only confirmations the user actually gave are stamped,
// so accounts created without them (demo sessions) keep NULLs rather than a false record.
export function buildSignupConsentRecord({ legalConsentAccepted, ageConfirmed }, now = new Date()) {
  return {
    legalConsentAcceptedAt: legalConsentAccepted === true ? now : null,
    legalConsentVersion: legalConsentAccepted === true ? CURRENT_LEGAL_CONSENT_VERSION : null,
    ageConfirmedAt: ageConfirmed === true ? now : null
  };
}
