import { createHash, randomBytes } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";

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

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${appConfig.abuseProtection.resendApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: appConfig.abuseProtection.emailFrom,
      to: [user.email],
      subject: "Verify your SignalForge email",
      html: `<p>Verify your SignalForge email to activate free trial signals.</p><p><a href="${verificationUrl}">Verify email</a></p><p>This link expires in ${appConfig.abuseProtection.verificationTokenHours} hours.</p>`
    })
  });

  if (!response.ok) {
    const error = new Error("Verification email could not be delivered.");
    error.statusCode = 502;
    throw error;
  }

  return { delivered: true, developmentUrl: null };
}
