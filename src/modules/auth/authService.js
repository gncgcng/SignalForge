import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import {
  createEmailVerificationToken,
  createSession as createSessionRecord,
  createUser,
  deleteSession,
  findUserByEmail,
  getDeviceTrialHistory,
  getSignupVelocity,
  recordSignupAttempt,
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
import { attributeAffiliateReferral } from "../affiliates/affiliateRepository.js";

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return { salt, hash };
}

function isValidPassword(password, record) {
  const candidate = hashPassword(password, record.salt).hash;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(record.hash));
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
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

export async function registerOrLogin({
  name,
  email,
  password,
  deviceFingerprint,
  affiliateCode
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
    abuseReviewStatus: abuse.reviewStatus
  });
  if (!options.bypassVerification) {
    await attributeAffiliateReferral(user.id, affiliateCode);
  }
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

export async function destroySession(sessionId) {
  if (sessionId) {
    await deleteSession(sessionId);
  }
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
