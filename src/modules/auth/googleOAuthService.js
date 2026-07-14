import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import {
  consumeOAuthLoginState,
  createOAuthLoginState,
  createUser,
  findUserByEmail,
  findUserByOAuthIdentity,
  getDeviceTrialHistory,
  getSignupVelocity,
  grantOAuthFreeTrial,
  linkOAuthIdentity,
  recordSignupAttempt
} from "../../db/repositories.js";
import {
  assertSignupVelocity,
  calculateSignupAbuseScore,
  getEmailDomain,
  getSignupContext,
  isDisposableEmail
} from "./abuseProtectionService.js";
import { createSession } from "./authService.js";
import { isDemoOrTesterIdentity } from "./authPolicy.js";
import { trackProductEvent } from "../analytics/productAnalyticsService.js";
import { attributeAffiliateReferral } from "../affiliates/affiliateRepository.js";
import { sendWelcomeEmail } from "../notifications/transactionalEmailService.js";

const provider = "google";
const stateTtlMs = 10 * 60 * 1000;
let jwksCache = { expiresAt: 0, keys: [] };

export async function startGoogleOAuth(req, deviceFingerprint, affiliateCode) {
  assertGoogleConfigured();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const signupContext = getSignupContext(req, deviceFingerprint);

  await createOAuthLoginState({
    stateHash: hashState(state),
    provider,
    nonce,
    signupIpHash: signupContext.ipHash,
    deviceFingerprintHash: signupContext.deviceHash,
    affiliateCode: sanitizeAffiliateCode(affiliateCode),
    expiresAt: new Date(Date.now() + stateTtlMs)
  });

  const url = new URL(appConfig.googleOAuth.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: appConfig.googleOAuth.clientId,
    redirect_uri: appConfig.googleOAuth.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account"
  }).toString();

  return { authorizationUrl: url.toString(), state };
}

export async function completeGoogleOAuth({ code, state, oauthError }) {
  assertGoogleConfigured();
  if (!state) {
    throw oauthFailure("Google sign-in response is incomplete.", "invalid_callback");
  }

  const loginState = await consumeOAuthLoginState(hashState(state), provider);
  if (!loginState) {
    throw oauthFailure("Google sign-in expired. Please try again.", "invalid_state");
  }
  if (oauthError) {
    throw oauthFailure(
      oauthError === "access_denied"
        ? "Google sign-in was cancelled."
        : "Google sign-in was not completed.",
      "google_denied"
    );
  }
  if (!code) {
    throw oauthFailure("Google sign-in response is incomplete.", "invalid_callback");
  }

  const tokenResponse = await exchangeAuthorizationCode(code);
  const claims = await validateGoogleIdToken(tokenResponse.id_token, loginState.nonce);
  const normalizedEmail = claims.email.trim().toLowerCase();

  if (appConfig.isProduction && isDemoOrTesterIdentity(normalizedEmail)) {
    throw oauthFailure("Google sign-in is unavailable for this account.", "account_blocked");
  }

  let user = await findUserByOAuthIdentity(provider, claims.sub);
  if (user) {
    if (!user.emailVerifiedAt) {
      user = await linkOAuthIdentity({
        provider,
        providerSubject: claims.sub,
        userId: user.id,
        providerEmail: normalizedEmail
      });
      await grantOAuthFreeTrial(user.id, loginState.deviceFingerprintHash);
      user = await findUserByEmail(normalizedEmail);
    }
    return createSession(user);
  }

  user = await findUserByEmail(normalizedEmail);
  if (user) {
    const verificationWasRequired = !user.emailVerifiedAt;
    user = await linkOAuthIdentity({
      provider,
      providerSubject: claims.sub,
      userId: user.id,
      providerEmail: normalizedEmail
    });
    if (verificationWasRequired) {
      await grantOAuthFreeTrial(user.id, loginState.deviceFingerprintHash);
      user = await findUserByEmail(normalizedEmail);
    }
    return createSession(user);
  }

  return createGoogleUser(claims, loginState);
}

export function validateGoogleClaims(claims, { nonce, now = Date.now() / 1000 } = {}) {
  const issuers = new Set(["https://accounts.google.com", "accounts.google.com"]);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (!issuers.has(claims.iss)) throw oauthFailure("Google identity issuer is invalid.", "invalid_token");
  if (!audience.includes(appConfig.googleOAuth.clientId)) {
    throw oauthFailure("Google identity audience is invalid.", "invalid_token");
  }
  if (audience.length > 1 && claims.azp !== appConfig.googleOAuth.clientId) {
    throw oauthFailure("Google authorized party is invalid.", "invalid_token");
  }
  if (!claims.exp || Number(claims.exp) <= now) {
    throw oauthFailure("Google sign-in token has expired.", "expired_token");
  }
  if (claims.iat && Number(claims.iat) > now + 300) {
    throw oauthFailure("Google sign-in token time is invalid.", "invalid_token");
  }
  if (!secureStringEqual(claims.nonce, nonce)) {
    throw oauthFailure("Google sign-in state is invalid.", "invalid_token");
  }
  if (!claims.sub || !claims.email || claims.email_verified !== true) {
    throw oauthFailure("Google account email is not verified.", "unverified_email");
  }
  return claims;
}

async function createGoogleUser(claims, loginState) {
  const normalizedEmail = claims.email.trim().toLowerCase();
  const emailDomain = getEmailDomain(normalizedEmail);
  const disposableEmail = isDisposableEmail(normalizedEmail);
  const velocity = await getSignupVelocity(loginState.signupIpHash);

  assertSignupVelocity(velocity);
  if (disposableEmail) {
    await recordSignupAttempt({
      ipHash: loginState.signupIpHash,
      deviceHash: loginState.deviceFingerprintHash,
      emailDomain,
      disposableEmail: true,
      successful: false,
      reason: "disposable_email"
    });
    throw oauthFailure(
      "Temporary or disposable email addresses are not supported.",
      "disposable_email"
    );
  }

  const repeatedDevice = Boolean(
    await getDeviceTrialHistory(loginState.deviceFingerprintHash)
  );
  const abuse = calculateSignupAbuseScore({
    ...velocity,
    repeatedDevice,
    disposableEmail: false
  });
  const password = randomPasswordRecord();
  let user = await createUser({
    id: createId("usr"),
    name: String(claims.name || normalizedEmail.split("@")[0]).trim().slice(0, 120),
    email: normalizedEmail,
    password,
    emailVerifiedAt: new Date(),
    freeSignalAllowance: 0,
    signupIpHash: loginState.signupIpHash,
    deviceFingerprintHash: loginState.deviceFingerprintHash,
    abuseScore: abuse.score,
    abuseFlags: abuse.flags,
    abuseReviewStatus: abuse.reviewStatus
  });
  await grantOAuthFreeTrial(user.id, loginState.deviceFingerprintHash);
  await attributeAffiliateReferral(user.id, loginState.affiliateCode);
  await trackProductEvent({
    eventType: "signup",
    userId: user.id,
    authProvider: "google"
  });
  user = await linkOAuthIdentity({
    provider,
    providerSubject: claims.sub,
    userId: user.id,
    providerEmail: normalizedEmail
  });
  await recordSignupAttempt({
    ipHash: loginState.signupIpHash,
    deviceHash: loginState.deviceFingerprintHash,
    emailDomain,
    disposableEmail: false,
    successful: true,
    reason: repeatedDevice ? "google_repeated_device" : "google_created"
  });
  sendWelcomeEmail(user);
  return createSession(user);
}

async function exchangeAuthorizationCode(code) {
  const response = await fetch(appConfig.googleOAuth.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: appConfig.googleOAuth.clientId,
      client_secret: appConfig.googleOAuth.clientSecret,
      redirect_uri: appConfig.googleOAuth.redirectUri,
      grant_type: "authorization_code"
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.id_token) {
    throw oauthFailure("Google sign-in could not be verified.", "token_exchange_failed");
  }
  return payload;
}

export async function validateGoogleIdToken(idToken, nonce, suppliedJwks = null) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) {
    throw oauthFailure("Google identity token is invalid.", "invalid_token");
  }
  const header = parseJwtPart(parts[0]);
  const claims = parseJwtPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) {
    throw oauthFailure("Google identity token algorithm is invalid.", "invalid_token");
  }

  const jwk = (suppliedJwks || await getGoogleJwks())
    .find((key) => key.kid === header.kid);
  if (!jwk) throw oauthFailure("Google signing key was not found.", "invalid_token");

  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url")
  );
  if (!valid) throw oauthFailure("Google identity signature is invalid.", "invalid_token");
  return validateGoogleClaims(claims, { nonce });
}

export function validateOAuthStateCookie(queryState, cookieState) {
  return Boolean(queryState && cookieState) && secureStringEqual(queryState, cookieState);
}

async function getGoogleJwks() {
  if (jwksCache.expiresAt > Date.now() && jwksCache.keys.length) {
    return jwksCache.keys;
  }
  const response = await fetch(appConfig.googleOAuth.jwksUrl);
  const payload = await response.json();
  if (!response.ok || !Array.isArray(payload.keys)) {
    throw oauthFailure("Google signing keys are unavailable.", "provider_unavailable");
  }
  const maxAge = Number(
    response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 3600
  );
  jwksCache = {
    keys: payload.keys,
    expiresAt: Date.now() + Math.max(60, maxAge) * 1000
  };
  return jwksCache.keys;
}

function parseJwtPart(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw oauthFailure("Google identity token is invalid.", "invalid_token");
  }
}

function hashState(state) {
  return createHash("sha256").update(String(state)).digest("hex");
}

function sanitizeAffiliateCode(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function randomPasswordRecord() {
  const salt = randomBytes(16).toString("hex");
  const password = randomBytes(32).toString("base64url");
  return {
    salt,
    hash: createHash("sha256").update(`${salt}:${password}`).digest("hex")
  };
}

function secureStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertGoogleConfigured() {
  if (!appConfig.googleOAuth.enabled) {
    const error = new Error("Google sign-in is temporarily unavailable.");
    error.statusCode = 503;
    error.oauthCode = "disabled";
    throw error;
  }
  const missing = [
    ["GOOGLE_CLIENT_ID", appConfig.googleOAuth.clientId],
    ["GOOGLE_CLIENT_SECRET", appConfig.googleOAuth.clientSecret],
    ["GOOGLE_REDIRECT_URI", appConfig.googleOAuth.redirectUri]
  ].filter(([, value]) => !value).map(([key]) => key);
  if (!missing.length) return;
  const error = new Error(`Google sign-in is not configured: missing ${missing.join(", ")}.`);
  error.statusCode = 503;
  error.oauthCode = "not_configured";
  throw error;
}

function oauthFailure(message, code) {
  const error = new Error(message);
  error.statusCode = 400;
  error.oauthCode = code;
  return error;
}
