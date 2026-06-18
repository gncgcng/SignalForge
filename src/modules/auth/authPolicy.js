export function isDemoOrTesterIdentity(email = "") {
  const normalized = email.trim().toLowerCase();
  const localPart = normalized.split("@")[0] || "";

  return normalized.endsWith("@signalforge.local") ||
    normalized === "demo@signalforge.app" ||
    normalized === "tester@signalforge.app" ||
    localPart === "demo" ||
    localPart === "tester" ||
    localPart.startsWith("demo-") ||
    localPart.startsWith("tester-");
}
