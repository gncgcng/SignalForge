// Every create-account CTA opens "Create your free account" (#signup); sign-in entry points stay sign-in.
// 1. Inventory: every logged-out CTA in index.html and the app.js public templates is classified, so a new
//    "Start …"/"Choose …"/"Unlock …" button can't silently open sign-in.
// 2. app.js: the real CTA listeners, openAuthMode, showAuth and showAuthForm run in a vm with a fake DOM.
// 3. auth-bootstrap.js (fallback before app.js is ready) runs the same clicks.
// 4. Every other showAuth() call site is a known sign-in / follow-the-hash entry point.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { getHashRoute as realGetHashRoute } from "../public/router.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = read("../public/index.html");
const app = read("../public/app.js");
const bootstrap = read("../public/auth-bootstrap.js");
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

const SIGNUP = { hash: "#signup", mode: "signup", heading: "Create your free account", submit: "Create account – get 3 free unlocks" };
const SIGNIN = { hash: "#signin", mode: "signin", heading: "Sign in", submit: "Sign in" };

// ---------- 1. inventory ----------
const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function controls(markup) {
  return [...markup.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(([, tag, attrs, inner]) => ({ tag, attrs, label: textOf(inner) }));
}
const isCreateAccountCta = ({ attrs }) =>
  /id="start-free-button"/.test(attrs) || /class="[^"]*\blaunch-auth-button\b/.test(attrs) || /\bdata-how-it-works-start\b/.test(attrs);
// Everything before the auth screen is shown to logged-out visitors: landing, How it works, public profile, recovery.
const publicMarkup = html.slice(0, html.indexOf('id="auth-screen"'));
const publicCtas = controls(publicMarkup).filter(isCreateAccountCta).map((control) => control.label);
const templateCtas = controls(app).filter(isCreateAccountCta).map((control) => control.label);
// Choose Pro / Choose Elite were removed while new checkouts are paused (BILLING_CHECKOUT_ENABLED).
const EXPECTED_HTML_CTAS = ["Start Free 3 Free Setup Unlocks", "Unlock Preview", "Start Free", "Become an Affiliate", "Start Free", "Start scanning"];
const EXPECTED_TEMPLATE_CTAS = ["Start scanning"];

await check("inventory: the create-account CTAs are exactly the classified ones", () => {
  assert.deepEqual(publicCtas, EXPECTED_HTML_CTAS);
  assert.deepEqual(templateCtas, EXPECTED_TEMPLATE_CTAS);
  // Any other public button that reads like a create-account CTA must be classified above.
  const unclassified = controls(publicMarkup)
    .filter((control) => !isCreateAccountCta(control))
    .filter((control) => /\b(start|free|sign ?up|create|join|get started|choose|unlock|become|try)\b/i.test(control.label));
  assert.deepEqual(unclassified, [], "unclassified create-account-looking control on a public page");
});

// ---------- 2. app.js in a vm ----------
function balancedEnd(source, from) {
  let depth = 0;
  let quote = null;
  for (let index = source.indexOf("{", from); index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  throw new Error(`unbalanced block at ${from}`);
}
const extract = (marker, { through = "" } = {}) => {
  const start = app.indexOf(marker);
  assert.ok(start >= 0, `app.js no longer contains: ${marker}`);
  const end = balancedEnd(app, start);
  return app.slice(start, through ? app.indexOf(through, end) + through.length : end);
};

class ClassList {
  constructor(...initial) { this.values = new Set(initial); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) { if (force ?? !this.values.has(value)) this.values.add(value); else this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}
const element = (extra = {}) => ({ classList: new ClassList(), dataset: {}, textContent: "", listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, ...extra });

function appSandbox() {
  const location = { pathname: "/", search: "", hash: "" };
  const switchToSignup = element({ dataset: { authMode: "signin" } });
  const switchToSignin = element({ dataset: { authMode: "signup" } });
  const forgot = element({ dataset: { authMode: "signin" } });
  const heading = element();
  const submit = element();
  const password = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const authForm = element({
    elements: { namedItem: (name) => (name === "password" ? password : null) },
    querySelector: (selector) => (selector === "h2" ? heading : selector === 'button[type="submit"]' ? submit : null),
    querySelectorAll: (selector) => (selector === "[data-auth-mode]" ? [switchToSignup, switchToSignin, forgot] : [])
  });
  const byId = { "#start-free-button": element(), "#landing-login-button": element() };
  const launchButtons = EXPECTED_HTML_CTAS.slice(1, -1).map(() => element());
  const navigations = [];
  const context = {
    URLSearchParams,
    location,
    history: {
      pushState(_state, _title, url) { location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; },
      replaceState(_state, _title, url) { location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; }
    },
    document: {
      querySelector: (selector) => byId[selector] || null,
      querySelectorAll: (selector) => (selector === ".launch-auth-button" ? launchButtons : [])
    },
    getHashRoute: () => realGetHashRoute(location.hash),
    state: { user: null },
    navigateTo: (route) => navigations.push(route),
    setMobileNavigationOpen() {},
    loginInProgress: false,
    authForm,
    authNote: element(),
    authScreen: element({ classList: new ClassList("hidden") }),
    landingPage: element(),
    dashboard: element(),
    debugBuildPage: null,
    clearSessionPage: null,
    publicProfilePage: null,
    publicHowItWorksPage: element(),
    authRestoreFailure: null,
    accountRecoverySupportPage: null,
    passwordResetRequestForm: null,
    passwordResetConfirmForm: null
  };
  vm.createContext(context);
  vm.runInContext([
    extract("function openAuthMode("),
    extract("function showAuth() {"),
    extract("function isAuthDebugEnabled("),
    extract("function getAuthMode("),
    extract("function authSubmitLabel("),
    extract("function showAuthForm("),
    extract('document.querySelector("#start-free-button").addEventListener', { through: ");" }),
    extract('document.querySelector("#landing-login-button").addEventListener', { through: ");" }),
    extract('document.querySelectorAll(".launch-auth-button").forEach', { through: ");" }),
    `function howItWorksClick(event) { ${extract('if (event.target.closest("[data-how-it-works-start]"))')} }`
  ].join("\n"), context, { filename: "app.js (extracted)" });
  const reset = (hash = "") => {
    location.hash = hash;
    authForm.dataset.mode = "signin";
    context.authScreen.classList.add("hidden");
  };
  const howItWorksStart = () => context.howItWorksClick({ target: { closest: (selector) => selector === "[data-how-it-works-start]" } });
  return { context, location, authForm, heading, submit, password, switchToSignup, switchToSignin, forgot, byId, launchButtons, navigations, reset, howItWorksStart };
}

function assertMode(sandbox, expected, label) {
  assert.equal(sandbox.location.hash, expected.hash, `${label}: hash`);
  assert.equal(sandbox.authForm.dataset.mode, expected.mode, `${label}: form mode`);
  assert.equal(sandbox.heading.textContent, expected.heading, `${label}: heading`);
  assert.equal(sandbox.submit.textContent, expected.submit, `${label}: submit label`);
  assert.equal(sandbox.context.authScreen.classList.contains("hidden"), false, `${label}: auth screen shown`);
  const signup = expected.mode === "signup";
  assert.equal(sandbox.switchToSignin.classList.contains("hidden"), !signup, `${label}: "Already have an account?" link`);
  assert.equal(sandbox.switchToSignup.classList.contains("hidden"), signup, `${label}: "New here?" link`);
  assert.equal(sandbox.forgot.classList.contains("hidden"), signup, `${label}: forgot password`);
}

await check("app.js: every create-account CTA opens Create your free account", () => {
  const sandbox = appSandbox();
  const clicks = [
    ["hero Start Free", () => sandbox.byId["#start-free-button"].listeners.click()],
    ...sandbox.launchButtons.map((button, index) => [EXPECTED_HTML_CTAS[index + 1], () => button.listeners.click()]),
    ["How it works: Start scanning (header and guide card)", () => sandbox.howItWorksStart()]
  ];
  assert.equal(clicks.length, EXPECTED_HTML_CTAS.length, "one click per create-account CTA in index.html");
  for (const [label, click] of clicks) {
    for (const startingHash of ["", "#landing", "#how-it-works", "#signin"]) {
      sandbox.reset(startingHash);
      click();
      assertMode(sandbox, SIGNUP, `${label} from ${startingHash || "/"}`);
      assert.equal(sandbox.password.attributes.autocomplete, "new-password");
    }
  }
});

await check("app.js: Sign In opens sign-in; a logged-in Start scanning goes straight to the scanner", () => {
  const sandbox = appSandbox();
  sandbox.reset("");
  sandbox.byId["#landing-login-button"].listeners.click();
  assertMode(sandbox, SIGNIN, "landing Sign In");
  sandbox.reset("#how-it-works");
  sandbox.context.state.user = { id: "usr_1" };
  sandbox.howItWorksStart();
  assert.deepEqual(sandbox.navigations, ["scanner"]);
  assert.equal(sandbox.location.hash, "#how-it-works", "no detour through the auth form");
});

await check("app.js: a logged-out visitor on a restricted page keeps sign-in mode", () => {
  const sandbox = appSandbox();
  for (const hash of ["#scanner", "#signals", "#billing"]) {
    sandbox.reset(hash);
    sandbox.context.showAuth();
    assert.equal(sandbox.authForm.dataset.mode, "signin", hash);
    assert.equal(sandbox.location.hash, hash, `${hash} is kept so sign-in returns there`);
    assert.equal(sandbox.switchToSignup.classList.contains("hidden"), false, `${hash}: "New here? Create a free account" is offered`);
  }
});

// ---------- 3. auth-bootstrap.js fallback ----------
await check("auth-bootstrap.js: the same CTAs open signup mode before app.js is ready", async () => {
  const location = { hash: "", pathname: "/", search: "" };
  const make = (extra = {}) => element(extra);
  const heading = make();
  const submit = make();
  const modal = [make({ dataset: { authMode: "signin" } }), make({ dataset: { authMode: "signup" } })];
  const authForm = make({
    querySelector: (selector) => (selector === "h2" ? heading : /submit/.test(selector) ? submit : null),
    querySelectorAll: (selector) => (selector === "[data-auth-mode]" ? modal : [])
  });
  const ids = { "auth-form": authForm, "start-free-button": make(), "landing-login-button": make() };
  const ctas = [...EXPECTED_HTML_CTAS.slice(1, -1).map(() => make()), make()]; // every .launch-auth-button, then Start scanning
  let selectorAsked = null;
  const context = {
    URLSearchParams,
    AbortController,
    console: { info() {}, warn() {} },
    location,
    history: { pushState(_s, _t, url) { location.hash = url.slice(url.indexOf("#")); }, replaceState(_s, _t, url) { location.hash = url.slice(url.indexOf("#")); } },
    document: {
      getElementById: (id) => ids[id] || null,
      querySelectorAll: (selector) => { selectorAsked = selector; return ctas; }
    },
    fetch: async () => new Response(JSON.stringify({ googleEnabled: false }), { status: 200, headers: { "content-type": "application/json" } }),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, length: 0 },
    setTimeout,
    clearTimeout
  };
  context.window = context;
  vm.runInNewContext(read("../public/auth-bootstrap.js"), context, { filename: "auth-bootstrap.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(selectorAsked, /\.launch-auth-button/);
  assert.match(selectorAsked, /\[data-how-it-works-start\]/);
  for (const [label, button] of [["hero Start Free", ids["start-free-button"]], ...ctas.map((button, index) => [`CTA ${index}`, button])]) {
    location.hash = "";
    authForm.dataset.mode = "signin";
    button.listeners.click();
    assert.equal(location.hash, "#signup", label);
    assert.equal(authForm.dataset.mode, "signup", label);
    assert.equal(heading.textContent, SIGNUP.heading, label);
    assert.equal(submit.textContent, SIGNUP.submit, label);
  }
  location.hash = "";
  ids["landing-login-button"].listeners.click();
  assert.deepEqual([location.hash, authForm.dataset.mode], ["#signin", "signin"]);
  assert.match(bootstrap, /showAuthRoute\("signup"\)/);
});

// ---------- 4. every other way into the auth form ----------
// Each showAuth() call site, by the function or listener around it. All of these are sign-in or follow the
// current hash (so a #signup link still shows signup); none is a create-account button.
const SHOW_AUTH_CALL_SITES = {
  "fn openAuthMode": "the CTA router itself (mode chosen by the caller)",
  "listener #recovery-back-to-sign-in": "Back to sign in (recovery page)",
  "fn init": "startup: public auth route follows the hash; restricted page, verify link, Telegram unlock, Google error -> sign in",
  "fn emergencyClearSession": "clear-session -> #signin",
  "fn showPasswordResetRequest": "password reset (form hidden)",
  "fn showPasswordResetConfirm": "password reset (form hidden)",
  "fn handleBrowserRouteChange": "hash change to #signin/#signup follows the hash",
  "fn handleStartupFailure": "startup failure on a public auth route follows the hash",
  "fn showAuthRestoreFailure": "restore failure panel (form hidden)",
  "fn openSignInAfterRestoreFailure": "Back to sign in after a failed restore"
};
await check("every other showAuth() call site is a known sign-in or follow-the-hash entry point", () => {
  const lines = app.split("\n");
  const sites = new Set();
  lines.forEach((line, index) => {
    if (!/\bshowAuth\(\)/.test(line) || /function showAuth\(/.test(line)) return;
    for (let at = index; at >= 0; at -= 1) {
      const match = lines[at].match(/^(?:async )?function (\w+)|^document\.querySelector\("([^"]+)"\)\??\.addEventListener|closest\("([^"]+)"\)/);
      if (!match) continue;
      sites.add(match[1] ? `fn ${match[1]}` : match[2] ? `listener ${match[2]}` : `closest ${match[3]}`);
      break;
    }
  });
  const unknown = [...sites].filter((site) => !SHOW_AUTH_CALL_SITES[site]);
  assert.deepEqual(unknown, [], "a new showAuth() entry point must be classified here (create-account CTAs use openAuthMode(\"signup\"))");
});

console.log(`Create-account CTA tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
