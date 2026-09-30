/**
 * Adversarial re-verification of the renderer recovery loop after T8.
 *
 * Contract: ARCHITECTURE.md §3.3 — recovery must be bounded and must never
 * become an unbounded reload loop. T8 replaced the "reset on successful load"
 * behavior with a rolling budget planner (`planMainWindowRendererRecovery`)
 * that is only reset by the stability window (default 60 s) or by explicit
 * tray/error-page retry actions.
 *
 * These tests drive the real main.run() bootstrap with a fake Electron app,
 * fake BrowserWindow, captured ipcMain handlers and a controllable clock in
 * attach mode (no child process). They assert:
 *   1. success-then-crash cycles stop after exactly maxReloads reloads;
 *   2. the error page is surfaced when the budget is exhausted;
 *   3. a crash after >windowMs gets a fresh budget (dynamic + unit);
 *   4. trusted Retry IPC resets the budget while an untrusted sender is rejected;
 *   5. the did-finish-load path does not touch the recovery counters.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const main = require('../../src/main/main');
const recovery = require('../../src/main/recovery');

const COOLDOWN_MS = recovery.DEFAULT_COOLDOWN_MS;
const WINDOW_MS = recovery.DEFAULT_WINDOW_MS;
const MAX_RELOADS = recovery.DEFAULT_MAX_RELOADS;
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer');
const ERROR_PAGE_URL = pathToFileURL(path.join(RENDERER_DIR, 'error.html')).href;
const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  // Monotonic clock, independent of the Date.now() override used by main.js.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (performance.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function makeFakeSession() {
  return {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  };
}

function makeFakeWebContents() {
  const handlers = new Map();
  return {
    id: 9001,
    session: makeFakeSession(),
    _url: '',
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
    setWindowOpenHandler() {},
    getURL() {
      return this._url;
    },
    executeJavaScript: async () => ({}),
  };
}

class FakeBrowserWindow {
  static instances = [];

  constructor() {
    this.webContents = makeFakeWebContents();
    this._destroyed = false;
    this._shown = false;
    this._events = new Map();
    this.loadCalls = [];
    FakeBrowserWindow.instances.push(this);
  }

  loadFile(file) {
    this.webContents._url = pathToFileURL(file).href;
    this.loadCalls.push(this.webContents._url);
    return Promise.resolve();
  }

  loadURL(url) {
    this.webContents._url = url;
    this.loadCalls.push(url);
    return Promise.resolve();
  }

  isDestroyed() {
    return this._destroyed;
  }

  show() {
    this._shown = true;
  }

  focus() {}

  on(event, handler) {
    const list = this._events.get(event) || [];
    list.push(handler);
    this._events.set(event, list);
  }
}

function makeFakeElectron() {
  const appEvents = new Map();
  const ipcHandlers = new Map();
  const app = {
    _userData: '',
    commandLine: { appendSwitch() {} },
    setPath(key, value) {
      if (key === 'userData') app._userData = value;
    },
    getPath() {
      return app._userData;
    },
    requestSingleInstanceLock() {
      return true;
    },
    whenReady() {
      return Promise.resolve();
    },
    on(event, handler) {
      const list = appEvents.get(event) || [];
      list.push(handler);
      appEvents.set(event, list);
    },
    emit(event, ...args) {
      for (const handler of appEvents.get(event) || []) handler(...args);
    },
    quit() {
      app.quitCount = (app.quitCount || 0) + 1;
    },
    exit(code) {
      app.exitCount = (app.exitCount || 0) + 1;
      app.exitCodes = (app.exitCodes || []).concat([code]);
    },
    relaunch() {},
    disableHardwareAcceleration() {},
    getVersion() {
      return 'verify';
    },
  };
  const ipcMain = {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler);
    },
    removeHandler(channel) {
      ipcHandlers.delete(channel);
    },
  };
  return {
    ipcMain,
    ipcHandlers,
    electron: { app, BrowserWindow: FakeBrowserWindow, ipcMain, shell: {}, Tray: undefined, Menu: {}, nativeImage: {} },
  };
}

/**
 * Start the real main.run() in attach mode against a local 200 server, with
 * temporary HOME/XDG/userData and a fake clock. Returns a small control API.
 */
async function startAttachFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-recovery-'));
  const previous = {
    DSH_ELECTRON_USER_DATA: process.env.DSH_ELECTRON_USER_DATA,
    DSH_ELECTRON_HOME: process.env.DSH_ELECTRON_HOME,
    DSH_ELECTRON_SMOKE: process.env.DSH_ELECTRON_SMOKE,
  };
  const realDateNow = Date.now;
  let clock = 1_000_000;

  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const attachUrl = `http://127.0.0.1:${port}/?token=verify-retry`;

  t.after(async () => {
    Date.now = realDateNow;
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  process.env.DSH_ELECTRON_USER_DATA = tempDir;
  process.env.DSH_ELECTRON_HOME = path.join(tempDir, 'dsh-home');
  delete process.env.DSH_ELECTRON_SMOKE;
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    runtimeMode: 'attach',
    attachUrl,
    closeToTray: false,
    showDevTools: false,
  }));
  Date.now = () => clock;

  const { ipcHandlers, electron } = makeFakeElectron();
  FakeBrowserWindow.instances.length = 0;
  const app = main.run(electron);
  assert.equal(app, electron.app);

  const loaded = await waitFor(() => FakeBrowserWindow.instances.length > 0
    && FakeBrowserWindow.instances[0].loadCalls.some((url) => url === attachUrl));
  assert.equal(loaded, true, 'attach URL was never loaded');
  const win = FakeBrowserWindow.instances[0];

  const countHarnessLoads = () => win.loadCalls.filter((url) => url === attachUrl).length;
  return {
    app,
    attachUrl,
    ipcHandlers,
    get win() {
      return FakeBrowserWindow.instances[0];
    },
    harnessLoadCount: countHarnessLoads,
    errorPageLoaded: () => win.loadCalls.some((url) => url.includes('error.html')),
    advanceClock: (ms) => {
      clock += ms;
    },
    markLoaded: () => win.webContents.emit('did-finish-load'),
    crash: () => win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 }),
    retryIpc: (senderUrl) => ipcHandlers.get(main.RETRY_CHANNEL)({
      sender: { id: win.webContents.id, getURL: () => senderUrl },
      senderFrame: { url: senderUrl },
    }),
  };
}

// ---------------------------------------------------------------------------
// Unit-level rolling-budget matrix (fake clock, no Electron)
// ---------------------------------------------------------------------------

test('planMainWindowRendererRecovery: rolling budget, cooldown and window reset', () => {
  const plan = recovery.planMainWindowRendererRecovery;
  assert.equal(recovery.DEFAULT_COOLDOWN_MS, 5000);
  assert.equal(recovery.DEFAULT_MAX_RELOADS, 3);
  assert.equal(recovery.DEFAULT_WINDOW_MS, 60000);

  // Three allowed reloads, then exhausted. Success cannot refund anything:
  // the planner never sees "load success"; only time or an explicit reset does.
  let lastReloadAt = 0;
  let reloadCount = 0;
  const now = 1_000_000_000;
  const decisions = [];
  for (let i = 0; i < MAX_RELOADS + 1; i += 1) {
    const result = plan({ now: now + i * (COOLDOWN_MS + 1), lastReloadAt, reloadCount });
    decisions.push(result);
    if (result.allowed) {
      reloadCount = result.reloadCount + 1;
      lastReloadAt = now + i * (COOLDOWN_MS + 1);
    }
  }
  assert.deepEqual(decisions.map((d) => d.allowed), [true, true, true, false]);
  assert.deepEqual(decisions.map((d) => d.reason), [
    'within-budget', 'within-budget', 'within-budget', 'budget-exhausted',
  ]);
  assert.equal(reloadCount, MAX_RELOADS);

  // Cooldown refuses within 5 s, with an exact remaining time.
  const cooling = plan({ now: 10_000, lastReloadAt: 6_000, reloadCount: 0 });
  assert.equal(cooling.allowed, false);
  assert.equal(cooling.reason, 'cooldown');
  assert.equal(cooling.cooldownRemainingMs, 1000);

  // Exactly windowMs is still the same window; windowMs+1 starts a fresh budget.
  const atBoundary = plan({ now: lastReloadAt + WINDOW_MS, lastReloadAt, reloadCount: MAX_RELOADS });
  assert.equal(atBoundary.allowed, false);
  assert.equal(atBoundary.reason, 'budget-exhausted');
  assert.equal(atBoundary.windowReset, false);
  const afterWindow = plan({ now: lastReloadAt + WINDOW_MS + 1, lastReloadAt, reloadCount: MAX_RELOADS });
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.reason, 'window-reset');
  assert.equal(afterWindow.windowReset, true);
  assert.equal(afterWindow.reloadCount, 0);

  // Invalid input never reloads.
  for (const bad of [
    {},
    { now: NaN },
    { now: 0, lastReloadAt: -1 },
    { now: 0, reloadCount: 1.5 },
    { now: 0, maxReloads: 0 },
    { now: 0, cooldownMs: -1 },
    { now: 0, windowMs: -1 },
  ]) {
    const result = plan(bad);
    assert.equal(result.allowed, false, JSON.stringify(bad));
    assert.equal(result.reason, 'invalid', JSON.stringify(bad));
  }
});

test('source: a successful did-finish-load never touches the recovery counters', () => {
  const didFinish = MAIN_SRC.slice(
    MAIN_SRC.indexOf('function handleDidFinishLoad'),
    MAIN_SRC.indexOf('function handleDidFailLoad'),
  );
  assert.doesNotMatch(didFinish, /recovery\.(?:reloadCount|lastReloadAt)\s*=/);

  // Only tray Restart Harness and error-page Retry reset the budget.
  const restart = MAIN_SRC.slice(MAIN_SRC.indexOf('function restartHarness'), MAIN_SRC.indexOf('function retryFromErrorPage'));
  const retry = MAIN_SRC.slice(MAIN_SRC.indexOf('function retryFromErrorPage'), MAIN_SRC.indexOf('function createAppTray'));
  for (const body of [restart, retry]) {
    assert.match(body, /recovery\.reloadCount = 0/);
    assert.match(body, /recovery\.lastReloadAt = 0/);
  }
  assert.match(MAIN_SRC, /plan\.reloadCount \+ 1/);
  assert.match(MAIN_SRC, /state\.recovery\.lastReloadAt = now/);
});

// ---------------------------------------------------------------------------
// Dynamic: real main.run() loop stops at the budget and surfaces the error page
// ---------------------------------------------------------------------------

test('success-then-crash cycles stop at maxReloads, surface error.html, then reset after the window', { timeout: 40000 }, async (t) => {
  const fx = await startAttachFixture(t);
  const initialLoads = fx.harnessLoadCount();
  assert.equal(initialLoads, 1);

  // Three success -> crash cycles: each one is allowed and consumes budget.
  for (let cycle = 1; cycle <= MAX_RELOADS; cycle += 1) {
    fx.markLoaded();
    fx.advanceClock(COOLDOWN_MS + 1);
    const before = fx.harnessLoadCount();
    fx.crash();
    const reloaded = await waitFor(() => fx.harnessLoadCount() > before, { timeoutMs: 3000 });
    assert.equal(reloaded, true, `cycle ${cycle}: crash should have been reloaded while budget remains`);
  }
  assert.equal(fx.harnessLoadCount(), initialLoads + MAX_RELOADS, 'exactly maxReloads reloads');

  // Fourth success -> crash: budget exhausted, error page shown, no reload.
  fx.markLoaded();
  fx.advanceClock(COOLDOWN_MS + 1);
  const beforeFourth = fx.harnessLoadCount();
  fx.crash();
  const errorShown = await waitFor(() => fx.errorPageLoaded(), { timeoutMs: 3000 });
  assert.equal(errorShown, true, 'budget exhaustion must surface error.html');
  await sleep(600); // no delayed reload should arrive
  assert.equal(fx.harnessLoadCount(), beforeFourth, 'exhausted budget must not reload again');

  // More than windowMs later, the rolling window expires: fresh budget.
  fx.advanceClock(WINDOW_MS + 1);
  fx.crash();
  const resetReload = await waitFor(() => fx.harnessLoadCount() > beforeFourth, { timeoutMs: 3000 });
  assert.equal(resetReload, true, 'a crash after >windowMs should get a fresh budget');
  assert.equal(fx.harnessLoadCount(), beforeFourth + 1);
});

// ---------------------------------------------------------------------------
// Dynamic: explicit Retry IPC resets the budget; untrusted sender is rejected
// ---------------------------------------------------------------------------

test('trusted Retry IPC resets the renderer budget while an untrusted sender is rejected', { timeout: 40000 }, async (t) => {
  const fx = await startAttachFixture(t);

  // Untrusted sender: no action, no reload.
  const beforeUntrusted = fx.harnessLoadCount();
  const rejected = fx.retryIpc('https://evil.example/');
  assert.deepEqual(rejected, { ok: false });
  await sleep(300);
  assert.equal(fx.harnessLoadCount(), beforeUntrusted, 'untrusted retry must not reload');

  // Consume one budget unit with a normal crash -> reload.
  fx.markLoaded();
  fx.advanceClock(COOLDOWN_MS + 1);
  const afterFirstCrash = fx.harnessLoadCount();
  fx.crash();
  assert.equal(await waitFor(() => fx.harnessLoadCount() > afterFirstCrash, { timeoutMs: 3000 }), true);

  // Trusted sender (error page is a local renderer page) resets and reloads.
  const beforeRetry = fx.harnessLoadCount();
  const accepted = fx.retryIpc(ERROR_PAGE_URL);
  assert.deepEqual(accepted, { ok: true });
  assert.equal(await waitFor(() => fx.harnessLoadCount() > beforeRetry, { timeoutMs: 3000 }), true, 'trusted retry should reload');

  // If the reset worked, three more success->crash cycles fit in the budget.
  for (let cycle = 1; cycle <= MAX_RELOADS; cycle += 1) {
    fx.markLoaded();
    fx.advanceClock(COOLDOWN_MS + 1);
    const before = fx.harnessLoadCount();
    fx.crash();
    const reloaded = await waitFor(() => fx.harnessLoadCount() > before, { timeoutMs: 3000 });
    assert.equal(reloaded, true, `post-retry cycle ${cycle}: budget was not reset`);
  }

  // And the next one is exhausted again.
  fx.markLoaded();
  fx.advanceClock(COOLDOWN_MS + 1);
  const beforeExhausted = fx.harnessLoadCount();
  fx.crash();
  assert.equal(await waitFor(() => fx.errorPageLoaded(), { timeoutMs: 3000 }), true);
  await sleep(400);
  assert.equal(fx.harnessLoadCount(), beforeExhausted);
});
