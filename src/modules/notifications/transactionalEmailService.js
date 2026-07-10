import { appConfig } from "../../config/appConfig.js";

const resendEmailEndpoint = "https://api.resend.com/emails";

export async function sendTransactionalEmail({ to, subject, html, text, category = "transactional" }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient || !subject || (!html && !text)) {
    return { delivered: false, skipped: true, reason: "missing_email_fields" };
  }

  if (!appConfig.abuseProtection.resendApiKey) {
    if (!appConfig.isProduction) {
      console.info(`[email] Development ${category} email to=${maskEmail(recipient)} subject=${safeSubject(subject)}`);
    } else {
      console.warn(`[email] Transactional email provider missing category=${safeCategory(category)} to=${maskEmail(recipient)}`);
    }
    return { delivered: false, skipped: true, reason: "provider_not_configured" };
  }

  try {
    const response = await fetch(resendEmailEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appConfig.abuseProtection.resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: appConfig.abuseProtection.emailFrom,
        to: [recipient],
        subject,
        html,
        text
      })
    });

    if (!response.ok) {
      console.warn(
        `[email] Send failed category=${safeCategory(category)} to=${maskEmail(recipient)} ` +
        `status=${response.status}`
      );
      return { delivered: false, skipped: false, reason: "provider_error" };
    }

    console.info(`[email] Sent category=${safeCategory(category)} to=${maskEmail(recipient)}`);
    return { delivered: true, skipped: false, reason: null };
  } catch (error) {
    console.warn(
      `[email] Send failed category=${safeCategory(category)} to=${maskEmail(recipient)} ` +
      `error=${safeError(error)}`
    );
    return { delivered: false, skipped: false, reason: "send_failed" };
  }
}

export function sendWelcomeEmail(user) {
  return sendTransactionalEmail({
    to: user.email,
    subject: "Welcome to SignalForge",
    category: "welcome",
    html: buildButtonEmail({
      title: "Welcome to SignalForge",
      intro: "Your SignalForge account is ready. You can scan markets, unlock setups, and track outcomes from your dashboard.",
      buttonLabel: "Open dashboard",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#scanner`,
      footer: "This is a transactional account email."
    }),
    text: "Welcome to SignalForge. Open your dashboard to start scanning markets."
  });
}

export function sendPasswordResetEmail(user, resetUrl) {
  return sendTransactionalEmail({
    to: user.email,
    subject: "Reset your SignalForge password",
    category: "password_reset",
    html: buildButtonEmail({
      title: "Reset your SignalForge password",
      intro: "Use this secure link to reset your password. If you did not request this, you can ignore this email.",
      buttonLabel: "Reset password",
      buttonUrl: resetUrl,
      footer: "This link expires soon and can be used once."
    }),
    text: `Reset your SignalForge password: ${resetUrl}`
  });
}

export function sendSubscriptionConfirmationEmail(user, plan) {
  const planName = String(plan || "paid").toUpperCase();
  return sendTransactionalEmail({
    to: user.email,
    subject: `SignalForge ${planName} subscription confirmed`,
    category: "subscription_confirmation",
    html: buildButtonEmail({
      title: "Subscription confirmed",
      intro: `Your SignalForge ${planName} subscription is active. Your plan credits will appear in Billing.`,
      buttonLabel: "View billing",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#billing`,
      footer: "This is a transactional billing confirmation."
    }),
    text: `Your SignalForge ${planName} subscription is active.`
  });
}

export function sendFailedPaymentEmail(user) {
  return sendTransactionalEmail({
    to: user.email,
    subject: "SignalForge payment issue",
    category: "failed_payment",
    html: buildButtonEmail({
      title: "Payment issue",
      intro: "Stripe reported a failed payment for your SignalForge subscription. Please review your billing details to avoid interruption.",
      buttonLabel: "Review billing",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#billing`,
      footer: "This is a transactional billing notice."
    }),
    text: "Stripe reported a failed payment for your SignalForge subscription. Please review your billing details."
  });
}

export function sendAffiliateCommissionEmail(user, { plan, commissionCents }) {
  return sendTransactionalEmail({
    to: user.email,
    subject: "SignalForge affiliate commission earned",
    category: "affiliate_commission",
    html: buildButtonEmail({
      title: "Affiliate commission earned",
      intro: `A referred ${String(plan || "paid").toUpperCase()} subscription generated a ${formatCents(commissionCents)} commission.`,
      buttonLabel: "View affiliate dashboard",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#affiliate`,
      footer: "This is a transactional affiliate account email."
    }),
    text: `A referred subscription generated a ${formatCents(commissionCents)} affiliate commission.`
  });
}

export function sendSupportConfirmationEmail(user, ticket) {
  return sendTransactionalEmail({
    to: user.email,
    subject: `SignalForge support request ${ticket.id}`,
    category: "support_confirmation",
    html: buildButtonEmail({
      title: "Support request received",
      intro: `We received “${ticket.subject}”. Your request is open and the SignalForge team will review it as soon as possible.`,
      buttonLabel: "View support requests",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#support`,
      footer: `Reference: ${ticket.id}. This is a transactional support email.`
    }),
    text: `We received your SignalForge support request ${ticket.id}: ${ticket.subject}`
  });
}

export function sendSupportAdminNotificationEmail(email, ticket) {
  return sendTransactionalEmail({
    to: email,
    subject: `SignalForge ${String(ticket.priority).toUpperCase()} support request`,
    category: "support_admin_notification",
    html: buildButtonEmail({
      title: "Support request needs review",
      intro: `${ticket.topic}: ${ticket.subject}`,
      buttonLabel: "Open support queue",
      buttonUrl: `${appConfig.appUrl || appConfig.abuseProtection.publicAppUrl}/#admin-support`,
      footer: `Reference: ${ticket.id}`
    }),
    text: `${ticket.priority} support request ${ticket.id}: ${ticket.subject}`
  });
}

export function buildButtonEmail({ title, intro, buttonLabel, buttonUrl, footer }) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.55;color:#111827">
      <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1>
      <p>${escapeHtml(intro)}</p>
      ${buttonUrl ? `<p><a href="${escapeAttribute(buttonUrl)}" style="display:inline-block;background:#06b6d4;color:#001018;text-decoration:none;font-weight:700;padding:10px 14px;border-radius:8px">${escapeHtml(buttonLabel || "Open SignalForge")}</a></p>` : ""}
      ${footer ? `<p style="color:#6b7280;font-size:13px">${escapeHtml(footer)}</p>` : ""}
      <p style="color:#6b7280;font-size:12px">Educational tool only. Not financial advice.</p>
    </div>
  `;
}

function formatCents(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(value || 0) / 100);
}

export function maskEmail(email = "") {
  const [name, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

function safeSubject(subject) {
  return String(subject || "").replace(/[^\w .:!?-]/g, "").slice(0, 120);
}

function safeCategory(category) {
  return String(category || "transactional").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
}

function safeError(error) {
  return String(error?.message || "unknown")
    .replace(/\b(?:re|r)_[A-Za-z0-9_]+\b/g, "[redacted-key]")
    .slice(0, 180);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
