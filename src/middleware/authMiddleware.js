import { appConfig } from "../config/appConfig.js";
import { deleteSession, findSessionUser } from "../db/repositories.js";
import { isDemoOrTesterIdentity } from "../modules/auth/authPolicy.js";
import { parseCookies } from "../shared/http.js";

export async function attachAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = getSessionCookieNames()
    .map((name) => cookies[name])
    .find(Boolean);
  req.sessionCookiePresent = Boolean(sessionId);

  if (!sessionId) {
    req.user = null;
    req.sessionId = null;
    return;
  }

  const user = await findSessionUser(sessionId);

  if (!user) {
    console.warn("[auth] Session cookie was present but no active PostgreSQL session was found.");
  }

  if (appConfig.isProduction && user && isDemoOrTesterIdentity(user.email)) {
    await deleteSession(sessionId);
    req.user = null;
    req.sessionId = null;
    return;
  }

  req.user = user;
  req.sessionId = user ? sessionId : null;
}

function getSessionCookieNames() {
  return [
    appConfig.sessionCookieName,
    appConfig.legacySessionCookieName,
    ...(appConfig.legacySessionCookieNames || [])
  ].filter(Boolean);
}
