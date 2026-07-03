import { appConfig } from "../../config/appConfig.js";
import { readJson, sendError, sendJson, parseCookies } from "../../shared/http.js";
import {
  createDemoSession,
  createPersistentRestoreToken,
  destroySession,
  registerOrLogin,
  resendVerification,
  refreshSessionExpiry,
  restoreSessionFromToken,
  revokePersistentRestoreToken,
  toPublicUser,
  verifyEmail
} from "./authService.js";
import {
  completeGoogleOAuth,
  startGoogleOAuth,
  validateOAuthStateCookie
} from "./googleOAuthService.js";

export async function handleAuthRoutes(req, res, pathname) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    const refreshed = req.user && req.sessionId
      ? await refreshSessionExpiry(req.sessionId)
      : null;
    logSessionCheck(req, Boolean(refreshed));
    return sendJson(res, 200, {
      user: toPublicUser(req.user),
      sessionExpiresAt: refreshed?.expiresAt || null,
      restore: req.user
        ? await createPersistentRestoreToken(
          req.user.id,
          req,
          req.headers["x-device-fingerprint"]
        )
        : null
    }, {
      ...authResponseHeaders(),
      ...(refreshed ? { "set-cookie": buildSessionCookie(req.sessionId) } : {})
    });
  }

  if (pathname === "/api/auth/config" && req.method === "GET") {
    return sendJson(res, 200, {
      demoEnabled: appConfig.demoEnabled,
      googleEnabled: Boolean(
        appConfig.googleOAuth.clientId &&
        appConfig.googleOAuth.clientSecret &&
        appConfig.googleOAuth.redirectUri
      )
    }, {
      "cache-control": "no-store"
    });
  }

  if (pathname === "/api/auth/restore" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await restoreSessionFromToken({
        restoreToken: body.restoreToken,
        deviceFingerprint: req.headers["x-device-fingerprint"] || body.deviceFingerprint
      }, req);
      logSessionCookieIssued("restore");
      return sendJson(res, 200, {
        user: result.user,
        restore: {
          token: result.restoreToken,
          expiresAt: result.restoreTokenExpiresAt
        }
      }, {
        ...authResponseHeaders(),
        "set-cookie": buildSessionCookie(result.sessionId)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/google/start" && req.method === "POST") {
    try {
      const body = await readJson(req);
      if (body.legalConsentAccepted !== true) {
        const error = new Error("Agree to the Terms, Privacy Policy, and Risk Disclaimer before creating an account.");
        error.statusCode = 400;
        throw error;
      }
      const result = await startGoogleOAuth(
        req,
        req.headers["x-device-fingerprint"] || body.deviceFingerprint,
        body.affiliateCode
      );
      return sendJson(res, 200, {
        authorizationUrl: result.authorizationUrl
      }, {
        ...authResponseHeaders(),
        "set-cookie": buildGoogleStateCookie(result.state)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/google/callback" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cookies = parseCookies(req.headers.cookie);
    const queryState = url.searchParams.get("state");
    try {
      if (!validateOAuthStateCookie(queryState, cookies[googleStateCookieName()])) {
        const error = new Error("Google sign-in state is invalid.");
        error.oauthCode = "invalid_state";
        throw error;
      }
      const result = await completeGoogleOAuth({
        code: url.searchParams.get("code"),
        state: queryState,
        oauthError: url.searchParams.get("error")
      });
      logSessionCookieIssued("google");
      return sendRedirect(res, googleAppRedirect("oauth=success"), {
        "set-cookie": [
          buildSessionCookie(result.sessionId),
          buildClearGoogleStateCookie()
        ]
      });
    } catch (error) {
      const code = error.oauthCode || "login_failed";
      console.warn(`[auth] Google OAuth failed code=${safeOAuthCode(code)}`);
      return sendRedirect(
        res,
        googleAppRedirect(`oauth_error=${encodeURIComponent(code)}`),
        { "set-cookie": buildClearGoogleStateCookie() }
      );
    }
  }

  if (pathname === "/api/auth/demo" && req.method === "POST") {
    try {
      const result = await createDemoSession();
      const restore = await createPersistentRestoreToken(
        result.user.id,
        req,
        req.headers["x-device-fingerprint"]
      );
      logSessionCookieIssued("demo");
      return sendJson(res, 200, { user: result.user, restore }, {
        ...authResponseHeaders(),
        "set-cookie": buildSessionCookie(result.sessionId)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const deviceFingerprint = req.headers["x-device-fingerprint"] || body.deviceFingerprint;
      const result = await registerOrLogin({
        ...body,
        deviceFingerprint
      }, req);
      const restore = await createPersistentRestoreToken(
        result.user.id,
        req,
        deviceFingerprint
      );
      logSessionCookieIssued("login");
      return sendJson(res, 200, {
        user: result.user,
        verificationRequired: result.verificationRequired,
        developmentVerificationUrl: result.verification?.developmentUrl || null,
        restore
      }, {
        ...authResponseHeaders(),
        "set-cookie": buildSessionCookie(result.sessionId)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/verify-email" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, await verifyEmail(body.token), authResponseHeaders());
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/resend-verification" && req.method === "POST") {
    if (!req.user) return sendError(res, 401, "Authentication required.");
    try {
      const result = await resendVerification(req.user);
      return sendJson(res, 200, {
        verificationRequired: result.verificationRequired,
        developmentVerificationUrl: result.verification?.developmentUrl || null
      }, authResponseHeaders());
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const body = await readJson(req);
    const cookies = parseCookies(req.headers.cookie);
    const sessionIds = new Set(getSessionCookieNames().map((name) => cookies[name]).filter(Boolean));

    await revokePersistentRestoreToken({
      restoreToken: body.restoreToken,
      user: req.user,
      deviceFingerprint: req.headers["x-device-fingerprint"] || body.deviceFingerprint
    }, req);
    await Promise.all([...sessionIds].map((sessionId) => destroySession(sessionId)));
    return sendJson(res, 200, { ok: true }, {
      ...authResponseHeaders(),
      "set-cookie": buildClearCookies()
    });
  }

  return false;
}

function authResponseHeaders() {
  return {
    "cache-control": "no-store, private",
    vary: "Cookie"
  };
}

export function buildSessionCookie(sessionId) {
  const secure = appConfig.isProduction ? "; Secure" : "";
  const domain = appConfig.sessionCookieDomain ? `; Domain=${appConfig.sessionCookieDomain}` : "";
  const expires = new Date(Date.now() + appConfig.sessionMaxAgeSeconds * 1000).toUTCString();
  return `${appConfig.sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${appConfig.sessionMaxAgeSeconds}; Expires=${expires}${domain}${secure}`;
}

export function buildClearCookies() {
  const names = new Set(getSessionCookieNames());
  const expired = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";

  return [...names].flatMap((name) => {
    const domains = [...new Set(["", appConfig.sessionCookieDomain ? `; Domain=${appConfig.sessionCookieDomain}` : ""])];
    const cookies = domains.flatMap((domain) => [
      `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; ${expired}${domain}`,
      `${name}=; SameSite=Lax; Path=/; Max-Age=0; ${expired}${domain}`
    ]);

    if (appConfig.isProduction) {
      cookies.push(...domains.flatMap((domain) => [
        `${name}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0; ${expired}${domain}`,
        `${name}=; SameSite=Lax; Secure; Path=/; Max-Age=0; ${expired}${domain}`
      ]));
    }

    return cookies;
  });
}

function getSessionCookieNames() {
  return [
    appConfig.sessionCookieName,
    appConfig.legacySessionCookieName,
    ...(appConfig.legacySessionCookieNames || [])
  ].filter(Boolean);
}

function logSessionCookieIssued(context) {
  console.info(
    `[auth] Set-Cookie issued context=${safeLogContext(context)} ` +
    `name=${appConfig.sessionCookieName} httpOnly=true secure=${appConfig.isProduction} ` +
    `sameSite=Lax path=/ persistent=true maxAgeSeconds=${appConfig.sessionMaxAgeSeconds} ` +
    `domain=${appConfig.sessionCookieDomain || "host-only"}`
  );
}

function logSessionCheck(req, refreshed) {
  console.info(
    `[auth] Session check cookiePresent=${Boolean(req.sessionCookiePresent)} ` +
    `dbSession=${req.user ? "found" : "missing"} refreshed=${Boolean(refreshed)}`
  );
}

function safeLogContext(context) {
  return String(context || "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "unknown";
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
    ...headers
  });
  res.end();
  return true;
}

function googleAppRedirect(query) {
  const fallbackOrigin = new URL(appConfig.googleOAuth.redirectUri).origin;
  const root = appConfig.appUrl || fallbackOrigin;
  return `${root}/?${query}`;
}

function safeOAuthCode(code) {
  return String(code).replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "login_failed";
}

function googleStateCookieName() {
  return appConfig.isProduction
    ? "__Host-signalforge_google_oauth"
    : "signalforge_google_oauth";
}

function buildGoogleStateCookie(state) {
  const secure = appConfig.isProduction ? "; Secure" : "";
  return `${googleStateCookieName()}=${encodeURIComponent(state)}; HttpOnly; ` +
    `SameSite=Lax; Path=/; Max-Age=600${secure}`;
}

function buildClearGoogleStateCookie() {
  const secure = appConfig.isProduction ? "; Secure" : "";
  return `${googleStateCookieName()}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
