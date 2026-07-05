import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import {
  createEmailVerificationToken,
  createPasswordResetToken as createPasswordResetTokenRecord,
  createSession as createSessionRecord,
  createUser,
  deleteSession,
  findAuthRestoreToken,
  findUserById,
  findUserByEmail,
  findUserByUsername,
  getDeviceTrialHistory,
  getSignupVelocity,
  markAuthRestoreTokenUsed,
  recordSignupAttempt,
  refreshSession,
  resetPasswordWithToken,
  revokeAuthRestoreToken,
  revokeAuthRestoreTokensForUserDevice,
  storeAuthRestoreToken,
  verifyEmailToken
} from "../../db/repositories.js";
import { isDemoOrTesterIdentity } from "./authPolicy.js";
import {
  assertSignupVelocity,
  calculateSignupAbuseScore,
  getEmailDomain,
  getSignupContext,
  isDisposableEmail
} from "./abuseProtectionService.js";
import {
  createVerificationToken,
  hashVerificationToken,
  sendVerificationEmail
} from "./emailVerificationService.js";
import { trackProductEvent } from "../analytics/productAnalyticsService.js";
import { attributeAffiliateReferral } from "../affiliates/affiliateRepository.js";
import {
  sendPasswordResetEmail,
  sendWelcomeEmail
} from "../notifications/transactionalEmailService.js";

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return { salt, hash };
}

function isValidPassword(password, record) {
  const candidate = hashPassword(password, record.salt).hash;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(record.hash));
}

function publicUser(user) {
  const profile = publicUserProfile(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: profile.username,
    usernameRequired: profile.usernameRequired,
    publicProfileEnabled: profile.publicProfileEnabled,
    usernameUpdatedAt: profile.usernameUpdatedAt,
    profile,
    role: user.role,
    isAdmin: appConfig.adminEmails.has(user.email.toLowerCase()),
    plan: user.plan,
    emailVerified: Boolean(user.emailVerifiedAt),
    trialUsed: Boolean(user.trialUsed),
    abuseReviewStatus: user.abuseReviewStatus || "clear",
    trialSignalsUsed: user.trialSignalsUsed,
    freeSignalAllowance: user.freeSignalAllowance ?? appConfig.freeSignalAllowance
  };
}

function publicUserProfile(user) {
  return {
    username: user?.username || "",
    usernameRequired: !user?.username,
    publicProfileEnabled: Boolean(user?.publicProfileEnabled),
    publicLeaderboardEnabled: Boolean(user?.publicLeaderboardEnabled),
    usernameUpdatedAt: user?.usernameUpdatedAt || null
  };
}

export async function registerOrLogin({
  name,
  email,
  password,
  deviceFingerprint,
  affiliateCode,
  legalConsentAccepted,
  username,
  publicProfileEnabled
}, req, options = {}) {
  if (!email || !password || password.length < 6) {
    throw new Error("Use a valid email and a password with at least 6 characters.");
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (appConfig.isProduction && isDemoOrTesterIdentity(normalizedEmail)) {
    throw new Error("Invalid email or password.");
  }

  const existing = await findUserByEmail(normalizedEmail);

  if (existing) {
    if (!isValidPassword(password, existing.password)) {
      throw new Error("Invalid email or password.");
    }

    return { ...(await createSession(existing)), verificationRequired: !existing.emailVerifiedAt };
  }

  if (!options.bypassVerification && legalConsentAccepted !== true) {
    const error = new Error("Agree to the Terms, Privacy Policy, and Risk Disclaimer before creating an account.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedUsername = assertValidSignupUsername(username, options);
  if (normalizedUsername && await findUserByUsername(normalizedUsername)) {
    const error = new Error("Username is already taken.");
    error.code = "USERNAME_TAKEN";
    error.statusCode = 409;
    throw error;
  }

  const signupContext = getSignupContext(req, deviceFingerprint);
  const emailDomain = getEmailDomain(normalizedEmail);
  const disposableEmail = isDisposableEmail(normalizedEmail);
  const velocity = await getSignupVelocity(signupContext.ipHash);

  if (!options.bypassVerification && !signupContext.deviceHash) {
    const error = new Error("Device verification is required to create an account.");
    error.statusCode = 400;
    throw error;
  }

  try {
    assertSignupVelocity(velocity);
  } catch (error) {
    await recordSignupAttempt({
      ...signupContext,
      emailDomain,
      disposableEmail,
      successful: false,
      reason: "rate_limited"
    });
    throw error;
  }

  if (disposableEmail) {
    await recordSignupAttempt({
      ...signupContext,
      emailDomain,
      disposableEmail: true,
      successful: false,
      reason: "disposable_email"
    });
    const error = new Error("Temporary or disposable email addresses are not supported.");
    error.statusCode = 400;
    throw error;
  }

  const repeatedDevice = Boolean(await getDeviceTrialHistory(signupContext.deviceHash));
  const abuse = calculateSignupAbuseScore({
    ...velocity,
    repeatedDevice,
    disposableEmail
  });
  const passwordRecord = hashPassword(password);
  const user = await createUser({
    id: createId("usr"),
    name: name?.trim() || normalizedEmail.split("@")[0],
    email: normalizedEmail,
    password: passwordRecord,
    emailVerifiedAt: options.bypassVerification ? new Date() : null,
    freeSignalAllowance: options.bypassVerification ? appConfig.freeSignalAllowance : 0,
    signupIpHash: signupContext.ipHash,
    deviceFingerprintHash: signupContext.deviceHash,
    abuseScore: abuse.score,
    abuseFlags: abuse.flags,
    abuseReviewStatus: abuse.reviewStatus,
    username: normalizedUsername,
    publicProfileEnabled: Boolean(publicProfileEnabled),
    publicLeaderboardEnabled: false
  });
  if (!options.bypassVerification) {
    await attributeAffiliateReferral(user.id, affiliateCode);
  }
  await trackProductEvent({
    eventType: "signup",
    userId: user.id,
    authProvider: "email"
  });
  await recordSignupAttempt({
    ...signupContext,
    emailDomain,
    disposableEmail: false,
    successful: true,
    reason: repeatedDevice ? "repeated_device" : "created"
  });

  let verification = null;
  if (!options.bypassVerification) {
    verification = await issueVerification(user);
  }
  sendWelcomeEmail(user);

  return {
    ...(await createSession(user)),
    verificationRequired: !options.bypassVerification,
    verification
  };
}

export async function createSession(user) {
  const sessionId = createId("sess");
  const expiresAt = new Date(Date.now() + appConfig.sessionMaxAgeSeconds * 1000);
  await createSessionRecord({ id: sessionId, userId: user.id, expiresAt });
  console.info(
    `[auth] PostgreSQL session inserted user=${safeLogId(user.id)} ` +
    `expiresAt=${expiresAt.toISOString()}`
  );

  return {
    sessionId,
    user: publicUser(user)
  };
}

export async function createDemoSession() {
  if (!appConfig.demoEnabled) {
    const error = new Error("Demo access is disabled.");
    error.statusCode = 404;
    throw error;
  }

  return registerOrLogin({
    name: "Demo Trader",
    email: `demo-${Date.now()}-${randomBytes(4).toString("hex")}@signalforge.local`,
    password: randomBytes(24).toString("hex"),
    deviceFingerprint: randomBytes(24).toString("hex")
  }, { headers: {}, socket: { remoteAddress: "demo-local" } }, { bypassVerification: true });
}

export async function resendVerification(user) {
  if (user.emailVerifiedAt) {
    return { verificationRequired: false };
  }
  return {
    verificationRequired: true,
    verification: await issueVerification(user, { enforceCooldown: true })
  };
}

export async function verifyEmail(token) {
  const result = await verifyEmailToken(hashVerificationToken(token));
  if (!result) {
    const error = new Error("Verification link is invalid or expired.");
    error.statusCode = 400;
    throw error;
  }
  return result;
}

export async function requestPasswordReset(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return passwordResetRequestResult();
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user || (appConfig.isProduction && isDemoOrTesterIdentity(user.email))) {
    return passwordResetRequestResult();
  }

  const token = createPasswordResetToken();
  await createPasswordResetTokenRecord(user.id, token.tokenHash, token.expiresAt);
  const resetUrl = `${appConfig.abuseProtection.publicAppUrl}/?reset=${encodeURIComponent(token.token)}`;
  sendPasswordResetEmail(user, resetUrl);
  return passwordResetRequestResult(!appConfig.isProduction ? resetUrl : null);
}

export async function completePasswordReset({ token, password }) {
  if (!password || password.length < 6) {
    const error = new Error("Use a password with at least 6 characters.");
    error.statusCode = 400;
    throw error;
  }

  const result = await resetPasswordWithToken(hashPasswordResetToken(token), hashPassword(password));
  if (!result) {
    const error = new Error("Password reset link is invalid or expired.");
    error.statusCode = 400;
    throw error;
  }
  return { ok: true };
}

export async function destroySession(sessionId) {
  if (sessionId) {
    await deleteSession(sessionId);
  }
}

export async function createPersistentRestoreToken(userId, req, deviceFingerprint) {
  const deviceHash = getSignupContext(req, deviceFingerprint).deviceHash;
  if (!deviceHash) {
    console.info("[auth] Restore token skipped: missing device fingerprint.");
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + appConfig.restoreTokenMaxAgeSeconds * 1000);
  await storeAuthRestoreToken({
    userId,
    tokenHash: hashRestoreToken(token),
    deviceFingerprintHash: deviceHash,
    expiresAt
  });
  console.info(`[auth] Restore token issued user=${safeLogId(userId)}`);
  return {
    token,
    expiresAt: expiresAt.toISOString()
  };
}

export async function restoreSessionFromToken({ restoreToken, deviceFingerprint }, req) {
  const token = sanitizeRestoreToken(restoreToken);
  if (!token) {
    throw restoreError("Restore token is missing.");
  }

  const deviceHash = getSignupContext(req, deviceFingerprint).deviceHash;
  if (!deviceHash) {
    console.warn("[auth] Restore failed: missing device fingerprint.");
    throw restoreError("Device verification is required to restore the session.");
  }

  const stored = await findAuthRestoreToken(hashRestoreToken(token), deviceHash);
  if (!stored) {
    console.warn("[auth] Restore failed: token invalid or expired.");
    throw restoreError("Saved session expired. Please sign in again.");
  }

  await markAuthRestoreTokenUsed(stored.id);
  const user = await findUserById(stored.user_id);
  if (!user || (appConfig.isProduction && isDemoOrTesterIdentity(user.email))) {
    await revokeAuthRestoreToken(hashRestoreToken(token));
    console.warn("[auth] Restore failed: user unavailable.");
    throw restoreError("Saved session expired. Please sign in again.");
  }

  await revokeAuthRestoreToken(hashRestoreToken(token));
  const session = await createSession(user);
  const replacement = await createPersistentRestoreToken(user.id, req, deviceFingerprint);
  console.info(`[auth] Restore succeeded user=${safeLogId(user.id)}`);
  return {
    ...session,
    restoreToken: replacement?.token || null,
    restoreTokenExpiresAt: replacement?.expiresAt || null
  };
}

export async function revokePersistentRestoreToken({
  restoreToken,
  user,
  deviceFingerprint
}, req) {
  const token = sanitizeRestoreToken(restoreToken);
  if (token) {
    await revokeAuthRestoreToken(hashRestoreToken(token));
  }

  if (user?.id) {
    const deviceHash = getSignupContext(req, deviceFingerprint).deviceHash;
    if (deviceHash) {
      await revokeAuthRestoreTokensForUserDevice(user.id, deviceHash);
    }
  }
  console.info(`[auth] Restore token revoked user=${safeLogId(user?.id || "unknown")}`);
}

export async function refreshSessionExpiry(sessionId) {
  if (!sessionId) return null;
  const expiresAt = new Date(Date.now() + appConfig.sessionMaxAgeSeconds * 1000);
  const refreshed = await refreshSession(sessionId, expiresAt);
  return refreshed ? { expiresAt: expiresAt.toISOString() } : null;
}

export function toPublicUser(user) {
  return user ? publicUser(user) : null;
}

export function isAdminUser(user) {
  return Boolean(user?.email && appConfig.adminEmails.has(user.email.toLowerCase()));
}

async function issueVerification(user, { enforceCooldown = false } = {}) {
  const token = createVerificationToken();
  await createEmailVerificationToken(
    user.id,
    token.tokenHash,
    token.expiresAt,
    enforceCooldown ? appConfig.abuseProtection.verificationResendSeconds : 0
  );
  return sendVerificationEmail(user, token.token);
}

function createPasswordResetToken() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  };
}

function hashRestoreToken(token) {
  return createHmac("sha256", appConfig.abuseProtection.hashSecret)
    .update(`auth-restore:${token}`)
    .digest("hex");
}

function hashPasswordResetToken(token) {
  return createHmac("sha256", appConfig.abuseProtection.hashSecret)
    .update(`password-reset:${String(token || "")}`)
    .digest("hex");
}

function passwordResetRequestResult(developmentResetUrl = null) {
  return {
    ok: true,
    message: "If an account exists for that email, a password reset link has been sent.",
    developmentResetUrl
  };
}

function sanitizeRestoreToken(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{32,160}$/.test(token) ? token : "";
}

function restoreError(message) {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function assertValidSignupUsername(username, options = {}) {
  const value = String(username || "").trim();

  if (!value && options.bypassVerification) {
    return null;
  }

  if (!value) {
    const error = new Error("Choose a username to create your account.");
    error.code = "USERNAME_REQUIRED";
    error.statusCode = 400;
    throw error;
  }

  if (!/^[A-Za-z0-9_]{3,20}$/.test(value)) {
    const error = new Error("Username must be 3-20 characters using only letters, numbers, and underscores.");
    error.code = "INVALID_USERNAME";
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function safeLogId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}
