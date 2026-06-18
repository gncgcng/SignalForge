import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import { createSession as createSessionRecord, createUser, deleteSession, findUserByEmail } from "../../db/repositories.js";
import { isDemoOrTesterIdentity } from "./authPolicy.js";

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
    plan: user.plan,
    trialSignalsUsed: user.trialSignalsUsed,
    freeSignalAllowance: user.freeSignalAllowance || appConfig.freeSignalAllowance
  };
}

export async function registerOrLogin({ name, email, password }) {
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

    return await createSession(existing);
  }

  const passwordRecord = hashPassword(password);
  const user = await createUser({
    id: createId("usr"),
    name: name?.trim() || normalizedEmail.split("@")[0],
    email: normalizedEmail,
    password: passwordRecord
  });

  return await createSession(user);
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
    password: randomBytes(24).toString("hex")
  });
}

export async function destroySession(sessionId) {
  if (sessionId) {
    await deleteSession(sessionId);
  }
}

export function toPublicUser(user) {
  return user ? publicUser(user) : null;
}
