import { createHmac } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";

// One free trial per email address and per Google account, surviving account deletion.
// trial_identity_claims stores only keyed hashes of these identities, never the email itself.

export const TRIAL_ALREADY_USED_MESSAGE = "This email has already used its free trial.";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Lowercase and trim; drop a +suffix everywhere; for Gmail also drop dots, and treat
// googlemail.com as gmail.com (they are one mailbox).
export function normalizeTrialEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return value;
  let local = value.slice(0, at).split("+")[0];
  let domain = value.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

// [{ kind, hash }] for whichever identities are given. Without TRIAL_IDENTITY_SECRET this logs
// an error and returns [], so callers skip the check and grant as they did before.
export function trialIdentities({ email = null, googleSubjects = [] } = {}) {
  // Distinct subjects: a repeated hash would read as "already claimed" when claimed in one insert.
  const subjects = [...new Set(googleSubjects.filter(Boolean).map(String))];
  if (!email && !subjects.length) return [];
  const secret = appConfig.trialIdentitySecret;
  if (!secret) {
    console.error("[trial] TRIAL_IDENTITY_SECRET is not set; skipping the one-trial-per-identity check.");
    return [];
  }
  const identities = [];
  if (email) identities.push({ kind: "email", hash: keyedHash(secret, `email:${normalizeTrialEmail(email)}`) });
  for (const subject of subjects) {
    identities.push({ kind: "google", hash: keyedHash(secret, `google:${subject}`) });
  }
  return identities;
}

function keyedHash(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}
