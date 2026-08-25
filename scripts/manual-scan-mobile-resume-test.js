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

const browserStorage = new Map();
const frontendContext = {
  state: { user: { id: "user-a" } },
  SCAN_ALL_JOB_KEY: "signalforge-active-scan-all-job",
  navigator: { onLine: true },
  localStorage: {
    getItem: (key) => browserStorage.get(key) ?? null,
    setItem: (key, value) => browserStorage.set(key, value),
    removeItem: (key) => browserStorage.delete(key)
  }
};
vm.createContext(frontendContext);
vm.runInContext([
  extractNamedFunction(appSource, "rememberScanAllJob"),
  extractNamedFunction(appSource, "getStoredScanAllJobId"),
  extractNamedFunction(appSource, "forgetScanAllJob"),
  extractNamedFunction(appSource, "isTransientScanPollingError")
].join("\n\n"), frontendContext);
frontendContext.rememberScanAllJob("scanjob-browser");
assert.equal(frontendContext.getStoredScanAllJobId(), "scanjob-browser");
frontendContext.state.user = { id: "user-b" };
assert.equal(frontendContext.getStoredScanAllJobId(), null, "a browser job id is bound to its authenticated user");
frontendContext.state.user = { id: "user-a" };
assert.equal(frontendContext.isTransientScanPollingError(new TypeError("offline")), true);
assert.equal(frontendContext.isTransientScanPollingError({ statusCode: 503 }), true);
assert.equal(frontendContext.isTransientScanPollingError({ statusCode: 404 }), false);
frontendContext.forgetScanAllJob("scanjob-browser");
assert.equal(frontendContext.getStoredScanAllJobId(), null);

async function run() {
const backend = new DetachedScanServer(350);
const phone = new MobileScanClient(backend, "user-a");

const firstStart = phone.start();
assert.equal(firstStart.jobId, "scanjob-1");
assert.equal(backend.createdJobs, 1);
backend.advance("user-a", 40, [readySetup("setup-a", "A-USD")]);
phone.poll();
assert.equal(phone.results.length, 1);
assert.equal(phone.progress, 40);

const requestsAtSuspension = backend.statusRequests;
phone.suspend();
backend.advance("user-a", 150, [
  readySetup("setup-a", "A-USD"),
  readySetup("setup-b", "B-USD")
]);
assert.equal(backend.statusRequests, requestsAtSuspension, "the suspended client must make no status requests");
assert.equal(phone.progress, 40);

const duplicateStart = backend.start("user-a");
assert.equal(duplicateStart.jobId, firstStart.jobId);
assert.equal(backend.createdJobs, 1, "restarting the UI must not create a second active scan");

phone.resume();
assert.equal(phone.progress, 150);
assert.deepEqual(phone.results.map((setup) => setup.setupKey), ["setup-a", "setup-b"]);

phone.goOffline();
backend.advance("user-a", 260, [
  readySetup("setup-a", "A-USD"),
  readySetup("setup-b", "B-USD"),
  readySetup("setup-c", "C-USD")
]);
assert.equal(phone.poll(), null);
assert.equal(phone.message, "Reconnecting to scan...");
assert.equal(phone.jobId, firstStart.jobId);
assert.equal(phone.progress, 150);
assert.equal(phone.terminalStatus, null);
assert.equal(backend.get("user-a").status, "running");

phone.goOnline();
phone.resume();
assert.equal(phone.progress, 260);
assert.equal(phone.results.length, 3);

phone.close();
assert.equal(backend.get("user-a").status, "running", "closing the app must not cancel the backend job");
backend.complete("user-a", [
  readySetup("setup-a", "A-USD"),
  readySetup("setup-b", "B-USD"),
  readySetup("setup-c", "C-USD"),
  readySetup("setup-d", "D-USD")
]);

const reopened = new MobileScanClient(backend, "user-a", phone.storage);
reopened.resume();
assert.equal(reopened.progress, 350);
assert.equal(reopened.terminalStatus, "completed");
assert.equal(reopened.results.length, 4);
assert.equal(backend.createdJobs, 1);

const unlocked = backend.unlock("user-a", reopened.jobId, "setup-c");
assert.equal(unlocked.entryPrice, 100);
assert.equal(unlocked.stopLoss, 98);
assert.equal(unlocked.takeProfit, 105);
assert.equal(backend.unlock("user-b", reopened.jobId, "setup-c"), null);
assert.equal(backend.resume("user-b"), null);

const staleStorage = new Map([["scan-job", JSON.stringify({ jobId: "stale-job", userId: "user-a" })]]);
const staleClient = new MobileScanClient(backend, "user-a", staleStorage);
staleClient.resume();
assert.equal(staleClient.jobId, "scanjob-1", "the authenticated backend replaces a stale local job id");

const missingJobStorage = new Map([["scan-job", JSON.stringify({ jobId: "gone-job", userId: "user-a" })]]);
const missingJobClient = new MobileScanClient(new DetachedScanServer(350), "user-a", missingJobStorage);
assert.equal(missingJobClient.resume(), null);
assert.equal(missingJobStorage.has("scan-job"), false, "a stale local id is cleared when the backend has no resumable job");

const cancellableBackend = new DetachedScanServer(350);
const cancellableClient = new MobileScanClient(cancellableBackend, "user-a");
cancellableClient.start();
cancellableClient.close();
assert.equal(cancellableBackend.get("user-a").status, "running");
cancellableClient.cancel();
assert.equal(cancellableBackend.get("user-a").status, "cancelled");

console.log(JSON.stringify({
  manualScanMobileResume: {
    selectedMarkets: 350,
    progressBeforeSuspension: 40,
    progressAfterFirstReconnect: 150,
    progressAfterNetworkRecovery: 260,
    finalScannedMarkets: reopened.progress,
    finalReadySetups: reopened.results.length,
    backendJobsCreated: backend.createdJobs,
    explicitCancelWorks: cancellableBackend.get("user-a").status === "cancelled",
    closeDoesNotCancel: true,
    userIsolation: true,
    resumedUnlockUsesPrivateCanonicalSetup: true
  },
  railwayRestartLimitation: {
    survivesBrowserSuspension: true,
    survivesNodeProcessRestart: false,
    reason: "Active scan jobs and their progress are held in the process-local scanAllJobs Map for one hour."
  }
}, null, 2));
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

class MobileScanClient {
  constructor(backend, userId, storage = new Map()) {
    this.backend = backend;
    this.userId = userId;
    this.storage = storage;
    this.jobId = null;
    this.progress = 0;
    this.results = [];
    this.terminalStatus = null;
    this.suspended = false;
    this.online = true;
    this.message = "";
  }

  start() {
    const snapshot = this.backend.start(this.userId);
    this.remember(snapshot.jobId);
    this.apply(snapshot);
    return snapshot;
  }

  poll() {
    if (this.suspended) {
      return null;
    }
    if (!this.online) {
      this.message = "Reconnecting to scan...";
      return null;
    }
    return this.apply(this.backend.status(this.userId, this.jobId));
  }

  resume() {
    this.suspended = false;
    if (!this.online) {
      this.message = "Reconnecting to scan...";
      return null;
    }
    const snapshot = this.backend.resume(this.userId);
    if (!snapshot) {
      this.storage.delete("scan-job");
      return null;
    }
    this.remember(snapshot.jobId);
    return this.apply(snapshot);
  }

  suspend() { this.suspended = true; }
  close() { this.suspended = true; }
  goOffline() { this.online = false; }
  goOnline() { this.online = true; }

  cancel() {
    return this.apply(this.backend.cancel(this.userId, this.jobId));
  }

  remember(jobId) {
    this.jobId = jobId;
    this.storage.set("scan-job", JSON.stringify({ jobId, userId: this.userId }));
  }

  apply(snapshot) {
    if (!snapshot) return null;
    this.jobId = snapshot.jobId;
    this.progress = snapshot.progress.scannedMarkets;
    this.results = snapshot.setups;
    this.terminalStatus = ["completed", "failed", "cancelled"].includes(snapshot.status)
      ? snapshot.status
      : null;
    return snapshot;
  }
}

await run();

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
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${name}`);
}
