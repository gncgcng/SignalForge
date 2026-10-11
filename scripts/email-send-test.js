// Sends one test of every transactional email (sample data, "[Test]" subject prefix) to the
// address given on the command line, through the real Resend sender. Needs RESEND_API_KEY and
// EMAIL_FROM; it turns EMAIL_FEATURES_ENABLED on for this process only.
//
//   npm run email:send-test -- you@example.com
// Links use APP_URL (default https://signalforge-app.com here).
process.env.APP_URL ||= "https://signalforge-app.com";
process.env.EMAIL_FEATURES_ENABLED = "true";

const recipient = String(process.argv[2] || "").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
  console.error("Usage: npm run email:send-test -- you@example.com");
  process.exit(1);
}
if (!process.env.RESEND_API_KEY) {
  console.error("RESEND_API_KEY is not set; nothing was sent.");
  process.exit(1);
}

const { emailSamples, TEMPLATE_NAMES } = await import("./test-support/email-samples.js");
const { sendTransactionalEmail } = await import("../src/modules/notifications/transactionalEmailService.js");

// One per template (the first variant of each).
const samples = TEMPLATE_NAMES.map((template) => emailSamples().find((sample) => sample.template === template));
let failures = 0;
for (const { name, email } of samples) {
  const result = await sendTransactionalEmail({
    to: recipient,
    category: `test_${name.replaceAll("-", "_")}`,
    ...email,
    subject: `[Test] ${email.subject}`
  });
  console.log(`${result.delivered ? "sent  " : "FAILED"} ${name}${result.delivered ? "" : ` (${result.reason})`}`);
  if (!result.delivered) failures += 1;
}
if (failures) process.exitCode = 1;
