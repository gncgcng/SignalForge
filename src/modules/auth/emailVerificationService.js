import { createHash, randomBytes } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import {
  buildButtonEmail,
  sendTransactionalEmail
} from "../notifications/transactionalEmailService.js";

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

export async function sendVerificationEmail(user, token) {
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
    subject: "Verify your SignalForge email",
    category: "email_verification",
    html: buildButtonEmail({
      title: "Verify your SignalForge email",
      intro: "Verify your email to activate your free SignalForge unlocks.",
      buttonLabel: "Verify email",
      buttonUrl: verificationUrl,
      footer: `This link expires in ${appConfig.abuseProtection.verificationTokenHours} hours.`
    }),
    text: `Verify your SignalForge email: ${verificationUrl}`
  });

  if (!delivery.delivered) {
    const error = new Error("Verification email could not be delivered.");
    error.statusCode = 502;
    throw error;
  }

  return { delivered: true, developmentUrl: null };
}
