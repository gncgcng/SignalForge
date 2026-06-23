import { appConfig } from "../config/appConfig.js";
import { deleteSession, findSessionUser } from "../db/repositories.js";
import { isDemoOrTesterIdentity } from "../modules/auth/authPolicy.js";
import { parseCookies } from "../shared/http.js";

export async function attachAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[appConfig.sessionCookieName] ||
    cookies[appConfig.legacySessionCookieName];

  if (!sessionId) {
    req.user = null;
    req.sessionId = null;
    return;
  }

  const user = await findSessionUser(sessionId);

  if (appConfig.isProduction && user && isDemoOrTesterIdentity(user.email)) {
    await deleteSession(sessionId);
    req.user = null;
    req.sessionId = null;
    return;
  }

  req.user = user;
  req.sessionId = user ? sessionId : null;
}
