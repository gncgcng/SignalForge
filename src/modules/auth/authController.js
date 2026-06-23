import { appConfig } from "../../config/appConfig.js";
import { readJson, sendError, sendJson, parseCookies } from "../../shared/http.js";
import {
  createDemoSession,
  destroySession,
  registerOrLogin,
  resendVerification,
  refreshSessionExpiry,
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
    return sendJson(res, 200, {
      user: toPublicUser(req.user),
      sessionExpiresAt: refreshed?.expiresAt || null
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

  if (pathname === "/api/auth/google/start" && req.method === "POST") {
    try {
      const body = await readJson(req);
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
      return sendJson(res, 200, { user: result.user }, {
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
      const result = await registerOrLogin({
        ...body,
        deviceFingerprint: req.headers["x-device-fingerprint"] || body.deviceFingerprint
      }, req);
      return sendJson(res, 200, {
        user: result.user,
        verificationRequired: result.verificationRequired,
        developmentVerificationUrl: result.verification?.developmentUrl || null
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
    const cookies = parseCookies(req.headers.cookie);
    const sessionIds = new Set([
      cookies[appConfig.sessionCookieName],
      cookies[appConfig.legacySessionCookieName]
    ].filter(Boolean));

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
  return `${appConfig.sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${appConfig.sessionMaxAgeSeconds}${secure}`;
}

export function buildClearCookies() {
  const names = new Set([appConfig.sessionCookieName, appConfig.legacySessionCookieName]);

  return [...names].flatMap((name) => {
    const cookies = [
      `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `${name}=; SameSite=Lax; Path=/; Max-Age=0`
    ];

    if (appConfig.isProduction) {
      cookies.push(`${name}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0`);
      cookies.push(`${name}=; SameSite=Lax; Secure; Path=/; Max-Age=0`);
    }

    return cookies;
  });
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
