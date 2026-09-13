import { createHmac } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";

const knownDisposableDomains = new Set([
  "10minutemail.com",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "mohmal.com",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "yopmail.com"
]);

export function getSignupContext(req, deviceFingerprint) {
  const ip = getClientIp(req);
  return {
    ipHash: hashIdentifier(`ip:${ip}`),
    deviceHash: normalizeDeviceFingerprint(deviceFingerprint)
      ? hashIdentifier(`device:${deviceFingerprint.trim()}`)
      : null
  };
}

export function isDisposableEmail(email) {
  const domain = getEmailDomain(email);
  const blockedDomains = [
    ...knownDisposableDomains,
    ...appConfig.abuseProtection.disposableEmailDomains
  ];
  return blockedDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

export function getEmailDomain(email) {
  return String(email || "").trim().toLowerCase().split("@")[1] || "";
}

export function calculateSignupAbuseScore({
  attemptsLastHour,
  accountsLastDay,
  accountsLastWeek,
  repeatedDevice,
  disposableEmail
}) {
  const flags = [];
  let score = 0;

  if (disposableEmail) {
    score += 70;
    flags.push("disposable_email");
  }
  if (repeatedDevice) {
    score += 50;
    flags.push("repeated_trial_device");
  }
  if (accountsLastDay >= 2) {
    score += 15;
    flags.push("multiple_accounts_same_ip_day");
  }
  if (accountsLastWeek >= 4) {
    score += 20;
    flags.push("multiple_accounts_same_ip_week");
  }
  if (attemptsLastHour >= Math.max(4, appConfig.abuseProtection.signupAttemptsPerHour - 3)) {
    score += 10;
    flags.push("high_signup_velocity");
  }

  return {
    score: Math.min(100, score),
    flags,
    reviewStatus: score >= 40 ? "flagged" : "clear"
  };
}

export function assertSignupVelocity(velocity) {
  if (velocity.attemptsLastHour >= appConfig.abuseProtection.signupAttemptsPerHour) {
    throw rateLimitError("Too many signup attempts. Please try again later.");
  }
  if (velocity.accountsLastDay >= appConfig.abuseProtection.accountsPerDay) {
    throw rateLimitError("Daily account creation limit reached. Please try again tomorrow.");
  }
  if (velocity.accountsLastWeek >= appConfig.abuseProtection.accountsPerWeek) {
    throw rateLimitError("Weekly account creation limit reached. Please try again later.");
  }
}

// Thresholds are a starting point: 8 failed attempts per email / 20 per IP in a 15-minute
// window tolerates real users mistyping a password a few times while still meaningfully
// slowing an automated attack. Revisit once real traffic patterns are visible.
export function assertLoginVelocity(velocity) {
  if (velocity.failuresByEmail15m >= 8) {
    throw rateLimitError("Too many failed login attempts for this account. Please try again in 15 minutes.");
  }
  if (velocity.failuresByIp15m >= 20) {
    throw rateLimitError("Too many failed login attempts from this network. Please try again in 15 minutes.");
  }
}

function getClientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded ||
    String(req?.headers?.["cf-connecting-ip"] || "").trim() ||
    String(req?.socket?.remoteAddress || "unknown");
}

function normalizeDeviceFingerprint(value) {
  const fingerprint = String(value || "").trim();
  return fingerprint.length >= 16 && fingerprint.length <= 200;
}

export function hashIdentifier(value) {
  return createHmac("sha256", appConfig.abuseProtection.hashSecret)
    .update(value)
    .digest("hex");
}

function rateLimitError(message) {
  const error = new Error(message);
  error.statusCode = 429;
  return error;
}
