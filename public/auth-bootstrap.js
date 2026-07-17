(function signalForgeAuthBootstrap() {
  "use strict";

  var RESTORE_TOKEN_KEY = "signalforge-restore-token";
  var REQUEST_TIMEOUT_MS = 8000;
  var LEGACY_AUTH_KEYS = [
    "signalforge-auth-token",
    "signalforge-session",
    "signalforge-session-token",
    "signalforge-refresh-token",
    "signalforge-user",
    "signalforge-cached-user",
    "auth-token",
    "refresh-token",
    "access-token",
    "token",
    "user"
  ];

  function isAuthStorageKey(key) {
    var normalized = String(key || "").toLowerCase();
    return normalized === RESTORE_TOKEN_KEY ||
      LEGACY_AUTH_KEYS.indexOf(normalized) >= 0 ||
      (/^signalforge[-_:]/.test(normalized) && /(auth|session|token|restore|user)/.test(normalized));
  }

  var storage = {
    saveAuthSession: function (session) {
      var token = session && (session.restoreToken || (session.restore && session.restore.token));
      if (!token) return;
      try {
        window.localStorage.setItem(RESTORE_TOKEN_KEY, token);
      } catch (error) {
        console.warn("[auth-ui] restore token could not be saved reason=storage_unavailable");
      }
    },
    getAuthSession: function () {
      try {
        return { restoreToken: window.localStorage.getItem(RESTORE_TOKEN_KEY) || "" };
      } catch (_) {
        return { restoreToken: "" };
      }
    },
    clearAuthSession: function () {
      [window.localStorage, window.sessionStorage].forEach(function (target) {
        try {
          var keys = [];
          var index;
          for (index = 0; index < target.length; index += 1) keys.push(target.key(index));
          keys.filter(isAuthStorageKey).forEach(function (key) { target.removeItem(key); });
        } catch (_) {}
      });
    }
  };

  window.SignalForgeAuthStorage = storage;
  window.__signalForgeMainAuthReady = false;

  function hasLegacyLocalToken() {
    try {
      return ["signalforge-auth-token", "auth-token", "access-token", "token"]
        .some(function (key) { return Boolean(window.localStorage.getItem(key)); });
    } catch (_) {
      return false;
    }
  }

  function summarizeResponse(payload) {
    if (!payload || typeof payload !== "object") return "invalid_or_empty";
    var errorCode = typeof payload.error === "string" ? payload.error :
      ((payload.error && payload.error.code) || (payload.ok === false ? "request_failed" : "none"));
    return [
      "ok=" + (payload.ok === true),
      "user=" + Boolean(payload.user && typeof payload.user === "object"),
      "token=" + Boolean(payload.token),
      "restoreToken=" + Boolean(payload.restoreToken || (payload.restore && payload.restore.token)),
      "error=" + String(errorCode).replace(/[^a-z0-9_-]/gi, "_").slice(0, 48)
    ].join(" ");
  }

  function setDebug(action, status, errorMessage, responseSummary) {
    var current = window.__signalForgeAuthDebug || {};
    current.route = getHashRoute();
    if (current.authLoading === undefined) current.authLoading = false;
    if (action === "login" && status === "loading") current.signingIn = true;
    if (action === "login" && ["success", "failed", "timeout"].indexOf(status) >= 0) current.signingIn = false;
    current.hasLocalToken = hasLegacyLocalToken();
    current.hasRestoreToken = Boolean(storage.getAuthSession().restoreToken);
    current.lastAuthAction = action || current.lastAuthAction || "none";
    current.lastAuthStatus = status || current.lastAuthStatus || "idle";
    current.lastLoginStage = action === "login" ? status : (current.lastLoginStage || "idle");
    current.lastErrorMessage = errorMessage || "";
    if (responseSummary) current.lastResponseSummary = responseSummary;
    window.__signalForgeAuthDebug = current;
    var hashParams = new URLSearchParams(String(window.location.hash || "").split("?")[1] || "");
    var enabled = new URLSearchParams(window.location.search).get("debugAuth") === "1" || hashParams.get("debugAuth") === "1";
    var panel = document.getElementById("auth-debug-panel");
    if (enabled && panel) {
      panel.classList.remove("hidden");
      panel.textContent = [
        "Build: " + (current.buildVersion || "development"),
        "Route: " + current.route,
        "Auth loading: " + current.authLoading,
        "Signing in: " + current.signingIn,
        "Saved restore token: " + current.hasLocalToken,
        "Last action: " + current.lastAuthAction,
        "Last stage: " + current.lastLoginStage,
        "HTTP status: " + (current.lastHttpStatus == null ? "none" : current.lastHttpStatus),
        "Endpoint: " + (current.endpoint || "none"),
        "Response: " + (current.lastResponseSummary || "none"),
        "Local token: " + current.hasLocalToken,
        "Restore token: " + current.hasRestoreToken,
        "Last error: " + (current.lastErrorMessage || "none")
      ].join(" | ");
    }
  }

  function showAuthRoute(route) {
    window.history.pushState({}, "", window.location.pathname + window.location.search + "#" + route);
    var authScreen = document.getElementById("auth-screen");
    var authForm = document.getElementById("auth-form");
    var resetForm = document.getElementById("password-reset-request-form");
    var confirmForm = document.getElementById("password-reset-confirm-form");
    var recovery = document.getElementById("account-recovery-support-page");
    document.getElementById("landing-page")?.classList.add("hidden");
    document.getElementById("dashboard")?.classList.add("hidden");
    recovery?.classList.toggle("hidden", route !== "account-recovery-support");
    authScreen?.classList.toggle("hidden", route === "account-recovery-support");
    authForm?.classList.toggle("hidden", route === "reset-password");
    resetForm?.classList.toggle("hidden", route !== "reset-password");
    confirmForm?.classList.add("hidden");
    if (route === "reset-password") {
      document.getElementById("password-reset-unavailable")?.classList.remove("hidden");
      document.getElementById("password-reset-email-field")?.classList.add("hidden");
      document.getElementById("password-reset-submit")?.classList.add("hidden");
      var note = document.getElementById("password-reset-request-note");
      if (note) note.textContent = "Password reset by email is not available yet. If you can’t access your account, submit an account recovery request.";
    }
    setDebug("navigate", "complete", "");
  }

  function errorMessageFor(error) {
    if (error && error.code === "timeout") return "Sign in timed out. Please try again.";
    if (error && (error.status === 401 || error.status === 403 || error.code === "invalid_credentials")) {
      return "Invalid email or password.";
    }
    if (error && error.status === 404) return "Sign in is currently unavailable.";
    if (error && error.code === "invalid_json") return "Sign in failed. Server returned an invalid response.";
    if (error && (error.code === "network_error" || error.status >= 500)) {
      return "Could not sign in right now. Please try again.";
    }
    return "Sign in failed. Please try again.";
  }

  function getDeviceFingerprint() {
    var browser = window.navigator || {};
    var display = window.screen || {};
    var timezone = "unknown";
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"; } catch (_) {}
    return [
      browser.userAgent || "unknown",
      browser.language || "unknown",
      browser.platform || "unknown",
      timezone,
      String(display.width || 0) + "x" + String(display.height || 0),
      String(display.colorDepth || 0)
    ].join("|").slice(0, 200);
  }

  async function requestJson(path, options) {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      var response = await fetch(path, Object.assign({}, options, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: Object.assign({
          "content-type": "application/json",
          "x-device-fingerprint": getDeviceFingerprint()
        }, options && options.headers)
      }));
      if (path === "/api/auth/login") {
        console.info("[auth-ui] login:request:response status=" + response.status);
        setDebug("login", "response_received", "");
        window.__signalForgeAuthDebug.lastHttpStatus = response.status;
        window.__signalForgeAuthDebug.endpoint = path;
      }
      var text = await response.text();
      var payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (_) {
        var invalidResponse = new Error("unexpected_response");
        invalidResponse.status = response.status;
        invalidResponse.code = "invalid_json";
        throw invalidResponse;
      }
      if (path === "/api/auth/login") {
        console.info("[auth-ui] login:response_json_ok=true");
        setDebug("login", "response_parsed", "", summarizeResponse(payload));
      }
      if (!response.ok) {
        var requestError = new Error(payload.message || (payload.error && payload.error.message) || payload.error || "request_failed");
        requestError.status = response.status;
        requestError.code = typeof payload.error === "string" ? payload.error : (payload.code || "request_failed");
        requestError.responseSummary = summarizeResponse(payload);
        throw requestError;
      }
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        var timeoutError = new Error("timeout");
        timeoutError.code = "timeout";
        throw timeoutError;
      }
      if (error && error.name === "TypeError") error.code = "network_error";
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  var authForm = document.getElementById("auth-form");
  var authNote = document.getElementById("auth-note");
  var submitButton = authForm && authForm.querySelector("button[type='submit']");
  authForm?.addEventListener("submit", async function (event) {
    if (window.__signalForgeMainAuthReady) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    console.info("[auth-ui] login:submit");
    if (window.__signalForgeAuthDebug?.signingIn) {
      if (authNote) authNote.textContent = "Sign in is already in progress.";
      return;
    }
    if (!authForm.reportValidity()) {
      if (authNote) authNote.textContent = "Enter a valid email and password.";
      setDebug("login", "validation_failed", "Enter a valid email and password.");
      return;
    }

    var credentials = Object.fromEntries(new FormData(authForm));
    credentials.affiliateCode = window.sessionStorage.getItem("signalforge-affiliate-code") || "";
    credentials.legalConsentAccepted = Boolean(document.getElementById("legal-consent")?.checked);
    credentials.publicProfileEnabled = Boolean(credentials.publicProfileEnabled);
    try {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Signing in...";
      }
      if (authNote) authNote.textContent = "Signing in...";
      console.info("[auth-ui] login:request:start");
      console.info("[auth-ui] login:endpoint=/api/auth/login");
      setDebug("login", "loading", "");
      window.__signalForgeAuthDebug.endpoint = "/api/auth/login";
      console.info("[auth-ui] login:request_sent");
      var result = await requestJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials)
      });
      if (result.ok !== true || !result.user || typeof result.user !== "object") {
        var unexpected = new Error("unexpected_response");
        unexpected.code = "unexpected_response";
        throw unexpected;
      }
      console.info("[auth-ui] login:save_session:start");
      storage.saveAuthSession(result);
      console.info("[auth-ui] login:save_session:done");
      console.info("[auth-ui] login:success");
      setDebug("login", "success", "", summarizeResponse(result));
      window.history.replaceState({}, "", window.location.pathname + window.location.search + "#scanner");
      console.info("[auth-ui] login:navigate:dashboard");
      window.location.reload();
    } catch (error) {
      var message = errorMessageFor(error);
      if (error.code === "timeout") console.warn("[auth-ui] login:timeout");
      console.warn("[auth-ui] login:failed reason=" + String(error.code || error.status || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 64));
      console.warn("[auth-ui] login:request:error");
      if (authNote) authNote.textContent = message;
      setDebug("login", "failed", message, error.responseSummary || "response_unavailable");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Enter Dashboard";
      }
      console.info("[auth-ui] login:finally");
    }
  });

  document.getElementById("forgot-password-button")?.addEventListener("click", function () {
    if (!window.__signalForgeMainAuthReady) showAuthRoute("reset-password");
  });
  document.getElementById("back-to-login-button")?.addEventListener("click", function () {
    if (!window.__signalForgeMainAuthReady) showAuthRoute("signin");
  });
  document.getElementById("password-reset-contact-support")?.addEventListener("click", function (event) {
    if (window.__signalForgeMainAuthReady) return;
    event.preventDefault();
    showAuthRoute("account-recovery-support");
  });
  document.getElementById("recovery-back-to-sign-in")?.addEventListener("click", function (event) {
    if (window.__signalForgeMainAuthReady) return;
    event.preventDefault();
    showAuthRoute("signin");
  });
  ["start-free-button", "landing-login-button"].forEach(function (id) {
    document.getElementById(id)?.addEventListener("click", function () {
      if (!window.__signalForgeMainAuthReady) showAuthRoute("signin");
    });
  });

  var googleButton = document.getElementById("google-auth-button");
  googleButton?.addEventListener("click", async function (event) {
    if (window.__signalForgeMainAuthReady || googleButton.disabled) return;
    event?.stopImmediatePropagation?.();
    if (!document.getElementById("legal-consent")?.checked) {
      if (authNote) authNote.textContent = "Agree to the Terms, Privacy Policy, and Risk Disclaimer before using Google sign-in.";
      return;
    }
    try {
      googleButton.disabled = true;
      if (authNote) authNote.textContent = "Opening Google sign-in...";
      setDebug("google_login", "loading", "");
      var result = await requestJson("/api/auth/google/start", {
        method: "POST",
        body: JSON.stringify({
          legalConsentAccepted: true,
          affiliateCode: window.sessionStorage.getItem("signalforge-affiliate-code") || ""
        })
      });
      if (!result.authorizationUrl || !/^https:\/\//.test(result.authorizationUrl)) throw new Error("unexpected_response");
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      var message = error.code === "network_error" || error.code === "timeout"
        ? "Could not open Google sign-in right now. Please try again."
        : "Google sign-in failed. Please try again.";
      if (authNote) authNote.textContent = message;
      setDebug("google_login", "failed", message);
    } finally {
      googleButton.disabled = googleButton.dataset.enabled !== "true";
      console.info("[auth-ui] google:finally");
    }
  });

  requestJson("/api/auth/config", { method: "GET" }).then(function (config) {
    if (!googleButton || window.__signalForgeMainAuthReady) return;
    googleButton.classList.remove("hidden");
    googleButton.dataset.enabled = String(Boolean(config.googleEnabled));
    googleButton.disabled = !config.googleEnabled;
    googleButton.textContent = config.googleEnabled ? "Continue with Google" : "Google sign-in temporarily unavailable";
    googleButton.setAttribute("aria-disabled", String(!config.googleEnabled));
  }).catch(function () {
    if (!googleButton || window.__signalForgeMainAuthReady) return;
    googleButton.classList.remove("hidden");
    googleButton.dataset.enabled = "false";
    googleButton.disabled = true;
    googleButton.textContent = "Google sign-in temporarily unavailable";
  });

  function getHashRoute() {
    var rawHash = String(window.location.hash || "").trim();
    var cleanHash = rawHash.split("?")[0].toLowerCase();
    return cleanHash || "#landing";
  }

  var authApiTestButton = document.getElementById("auth-api-test");
  var authDebugParams = new URLSearchParams(String(window.location.hash || "").split("?")[1] || "");
  if (authApiTestButton && authDebugParams.get("debugAuth") === "1") {
    authApiTestButton.classList.remove("hidden");
    authApiTestButton.addEventListener("click", async function () {
      if (window.__signalForgeMainAuthReady) return;
      try {
        authApiTestButton.disabled = true;
        authApiTestButton.textContent = "Testing auth API...";
        setDebug("auth_api_test", "loading", "");
        await requestJson("/api/auth/health", { method: "GET" });
        setDebug("auth_api_test", "success", "");
        authApiTestButton.textContent = "Auth API reachable";
      } catch (error) {
        setDebug("auth_api_test", "failed", error.message);
        authApiTestButton.textContent = "Auth API test failed";
      } finally {
        authApiTestButton.disabled = false;
      }
    });
  }

  var initialRoute = getHashRoute();
  if (initialRoute === "#reset-password" || initialRoute === "#forgot-password") showAuthRoute("reset-password");
  setDebug("bootstrap", "ready", "");
}());
