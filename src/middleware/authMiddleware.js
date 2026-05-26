import { appConfig } from "../config/appConfig.js";
import { findSessionUser } from "../db/repositories.js";
import { parseCookies } from "../shared/http.js";

export async function attachAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[appConfig.sessionCookieName];

  if (!sessionId) {
    req.user = null;
    return;
  }

  req.user = await findSessionUser(sessionId);
}
