import { createHash, randomBytes } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { buildVerifyEmail } from "../notifications/emailTemplates.js";
import { sendTransactionalEmail } from "../notifications/transactionalEmailService.js";

export function createVerificationToken() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashVerificationToken(token),
    expiresAt: new Date(
      Date.now() + appConfig.abuseProtection.verificationTokenHours * 60 * 60 * 1000
    )
  };
}

export function hashVerificationToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

// trialAvailable: whether verifying will (as far as signup can tell) grant the free unlocks, so
// the email only promises them when they're coming.
export async function sendVerificationEmail(user, token, { trialAvailable = true } = {}) {
  const verificationUrl = `${appConfig.abuseProtection.publicAppUrl}/?verify=${encodeURIComponent(token)}`;

  if (!appConfig.abuseProtection.resendApiKey) {
    if (!appConfig.isProduction) {
      console.info(`[auth] Development verification URL for ${user.email}: ${verificationUrl}`);
      return { delivered: false, developmentUrl: verificationUrl };
    }
    const error = new Error("Email verification provider is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const delivery = await sendTransactionalEmail({
    to: user.email,
    category: "email_verification",
    ...buildVerifyEmail({
      verificationUrl,
      trialAvailable,
      expiresInHours: appConfig.abuseProtection.verificationTokenHours
    })
  });

  if (!delivery.delivered) {
    const error = new Error("Verification email could not be delivered.");
    error.statusCode = 502;
    throw error;
  }

  return { delivered: true, developmentUrl: null };
}
