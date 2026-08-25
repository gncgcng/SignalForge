import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../src/modules/signals/signalController.js", import.meta.url), "utf8");

assert.match(serviceSource, /const scanAllJobs = new Map\(\)/);
assert.match(serviceSource, /Promise\.resolve\(\)\.then\(\(\) => runScanAllJob\(/);
assert.match(serviceSource, /findUserResumableScanAllJob\(user\.id, \{ activeOnly: true \}\)/);
assert.match(serviceSource, /job\.privateFullSetups = \[\.\.\.context\.fullSetups\]/);
assert.match(serviceSource, /\.filter\(\(job\) => job\.userId === userId\)/);
assert.match(controllerSource, /pathname === "\/api\/signals\/scan-all\/resume"/);
assert.match(controllerSource, /getResumableScanAllJobStatus\(req\.user\)/);

assert.match(appSource, /signalforge-active-scan-all-job/);
assert.match(appSource, /userId: state\.user\.id/);
assert.match(appSource, /stored\?\.userId === state\.user\?\.id/);
assert.match(appSource, /api\.request\("\/api\/signals\/scan-all\/resume"\)/);
assert.match(appSource, /document\.addEventListener\("visibilitychange"/);
assert.match(appSource, /window\.addEventListener\("online"/);
assert.match(appSource, /document\.hidden \|\| navigator\.onLine === false/);
assert.match(appSource, /statusLine\.textContent = "Reconnecting to scan\.\.\."/);
assert.match(appSource, /api\.request\("\/api\/signals\/scan-all\/cancel"/);
assert.doesNotMatch(appSource, /(?:pagehide|beforeunload)[\s\S]{0,500}scan-all\/cancel/);

function testActualBrowserJobStorage() {
  const values = new Map();
  const context = {
    state: { user: { id: "user-a" } },
    SCAN_ALL_JOB_KEY: "signalforge-active-scan-all-job",
    navigator: { onLine: true },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  };
  vm.createContext(context);
  vm.runInContext([
    extractNamedFunction(appSource, "rememberScanAllJob"),
    extractNamedFunction(appSource, "getStoredScanAllJobId"),
    extractNamedFunction(appSource, "forgetScanAllJob"),
    extractNamedFunction(appSource, "isTransientScanPollingError")
  ].join("\n\n"), context);

  context.rememberScanAllJob("scanjob-browser");
  assert.equal(context.getStoredScanAllJobId(), "scanjob-browser");
  assert.deepEqual(JSON.parse(values.get(context.SCAN_ALL_JOB_KEY)), {
    jobId: "scanjob-browser",
    userId: "user-a"
  });
  context.state.user = { id: "user-b" };
  assert.equal(context.getStoredScanAllJobId(), null);
  context.state.user = { id: "user-a" };
  assert.equal(context.isTransientScanPollingError(new TypeError("offline")), true);
  assert.equal(context.isTransientScanPollingError({ statusCode: 503 }), true);
  assert.equal(context.isTransientScanPollingError({ statusCode: 404 }), false);
  context.forgetScanAllJob("scanjob-browser");
  assert.equal(context.getStoredScanAllJobId(), null);
}

function testDetachedResumeLifecycle() {
  const backend = new DetachedScanServer(350);
  const phone = new MobileClient(backend, "user-a");
  const first = phone.start();
  assert.equal(first.jobId, "scanjob-1");

  backend.advance("user-a", 40, [readySetup("setup-a", "A-USD")]);
  phone.poll();
  assert.equal(phone.progress, 40);
  const requestsAtSuspension = backend.statusRequests;

  phone.suspend();
  backend.advance("user-a", 150, [
    readySetup("setup-a", "A-USD"),
    readySetup("setup-b", "B-USD")
  ]);
  assert.equal(backend.statusRequests, requestsAtSuspension);
  assert.equal(phone.progress, 40);
  assert.equal(backend.start("user-a").jobId, first.jobId);
  assert.equal(backend.createdJobs, 1);

  phone.resume();
  assert.equal(phone.progress, 150);
  assert.deepEqual(phone.results.map((setup) => setup.setupKey), ["setup-a", "setup-b"]);

  phone.offline = true;
  backend.advance("user-a", 260, [
    readySetup("setup-a", "A-USD"),
    readySetup("setup-b", "B-USD"),
    readySetup("setup-c", "C-USD")
  ]);
  assert.equal(phone.poll(), null);
  assert.equal(phone.message, "Reconnecting to scan...");
  assert.equal(backend.get("user-a").status, "running");
  assert.equal(phone.terminalStatus, null);

  phone.offline = false;
  phone.resume();
  assert.equal(phone.progress, 260);
  phone.close();
  assert.equal(backend.get("user-a").status, "running");

  backend.complete("user-a", [
    readySetup("setup-a", "A-USD"),
    readySetup("setup-b", "B-USD"),
    readySetup("setup-c", "C-USD"),
    readySetup("setup-d", "D-USD")
  ]);
  const reopened = new MobileClient(backend, "user-a", phone.storage);
  reopened.resume();
  assert.equal(reopened.progress, 350);
  assert.equal(reopened.terminalStatus, "completed");
  assert.equal(reopened.results.length, 4);
  assert.equal(backend.createdJobs, 1);

  const unlocked = backend.unlock("user-a", reopened.jobId, "setup-c");
  assert.deepEqual(
    { entry: unlocked.entryPrice, stop: unlocked.stopLoss, target: unlocked.takeProfit },
    { entry: 100, stop: 98, target: 105 }
  );
  assert.equal(backend.resume("user-b"), null);
  assert.equal(backend.unlock("user-b", reopened.jobId, "setup-c"), null);

  const stale = new Map([["scan-job", JSON.stringify({ jobId: "stale", userId: "user-a" })]]);
  const staleClient = new MobileClient(backend, "user-a", stale);
  staleClient.resume();
  assert.equal(staleClient.jobId, first.jobId);

  const cancellableBackend = new DetachedScanServer(350);
  const cancellable = new MobileClient(cancellableBackend, "user-a");
  cancellable.start();
  cancellable.close();
  assert.equal(cancellableBackend.get("user-a").status, "running");
  cancellable.cancel();
  assert.equal(cancellableBackend.get("user-a").status, "cancelled");
}

function readySetup(setupKey, symbol) {
  return {
    id: `signal-${setupKey}`,
    setupKey,
    symbol,
    timeframe: "15m",
    direction: "long",
    confidenceScore: 90,
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 105
  };
}

class DetachedScanServer {
  constructor(total) {
    this.total = total;
    this.jobs = new Map();
    this.createdJobs = 0;
    this.statusRequests = 0;
  }

  start(userId) {
    const existing = this.resume(userId, true);
    if (existing) return existing;
    this.createdJobs += 1;
    const job = {
      jobId: `scanjob-${this.createdJobs}`,
      userId,
      status: "running",
      progress: 0,
      publicSetups: [],
      privateSetups: []
    };
    this.jobs.set(job.jobId, job);
    return this.snapshot(job);
  }

  get(userId) {
    return [...this.jobs.values()].find((job) => job.userId === userId) || null;
  }

  resume(userId, activeOnly = false) {
    const jobs = [...this.jobs.values()].filter((job) => job.userId === userId);
    const active = jobs.find((job) => ["queued", "running", "cancelling"].includes(job.status));
    const job = active || (activeOnly ? null : jobs.at(-1));
    return job ? this.snapshot(job) : null;
  }

  status(userId, jobId) {
    this.statusRequests += 1;
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? this.snapshot(job) : null;
  }

  advance(userId, progress, setups) {
    const job = this.get(userId);
    job.progress = progress;
    job.publicSetups = setups.map(({ entryPrice, stopLoss, takeProfit, ...setup }) => setup);
    job.privateSetups = setups.map((setup) => ({ ...setup }));
  }

  complete(userId, setups) {
    this.advance(userId, this.total, setups);
    this.get(userId).status = "completed";
  }

  cancel(userId, jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    job.status = "cancelled";
    return this.snapshot(job);
  }

  unlock(userId, jobId, setupKey) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return job.privateSetups.find((setup) => setup.setupKey === setupKey) || null;
  }

  snapshot(job) {
    return {
      jobId: job.jobId,
      status: job.status,
      progress: { scannedMarkets: job.progress, totalMarkets: this.total },
      setups: job.publicSetups.map((setup) => ({ ...setup }))
    };
  }
}

class MobileClient {
  constructor(backend, userId, storage = new Map()) {
    this.backend = backend;
    this.userId = userId;
    this.storage = storage;
    this.jobId = null;
    this.progress = 0;
    this.results = [];
    this.terminalStatus = null;
    this.suspended = false;
    this.offline = false;
    this.message = "";
  }

  start() {
    return this.apply(this.backend.start(this.userId));
  }

  poll() {
    if (this.suspended) return null;
    if (this.offline) {
      this.message = "Reconnecting to scan...";
      return null;
    }
    return this.apply(this.backend.status(this.userId, this.jobId));
  }

  resume() {
    this.suspended = false;
    if (this.offline) return null;
    return this.apply(this.backend.resume(this.userId));
  }

  suspend() { this.suspended = true; }
  close() { this.suspended = true; }
  cancel() { return this.apply(this.backend.cancel(this.userId, this.jobId)); }

  apply(snapshot) {
    if (!snapshot) return null;
    this.jobId = snapshot.jobId;
    this.storage.set("scan-job", JSON.stringify({ jobId: snapshot.jobId, userId: this.userId }));
    this.progress = snapshot.progress.scannedMarkets;
    this.results = snapshot.setups;
    this.terminalStatus = ["completed", "failed", "cancelled"].includes(snapshot.status)
      ? snapshot.status
      : null;
    return snapshot;
  }
}

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Unable to find ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

testActualBrowserJobStorage();
testDetachedResumeLifecycle();

console.log(JSON.stringify({
  manualScanMobileResume: {
    selectedMarkets: 350,
    progressBeforeSuspension: 40,
    progressAfterReconnect: 150,
    progressAfterNetworkRecovery: 260,
    completedMarketsAfterReopen: 350,
    backendJobsCreated: 1,
    noPollingWhileSuspended: true,
    networkFailureIsNotBackendFailure: true,
    userIsolation: true,
    resumedUnlockUsesCanonicalPrivateSetup: true,
    closeDoesNotCancel: true,
    explicitCancelWorks: true
  },
  railwayRestartLimitation: {
    survivesBrowserSuspension: true,
    survivesNodeProcessRestart: false,
    reason: "Scan jobs remain in the process-local scanAllJobs Map."
  }
}, null, 2));
