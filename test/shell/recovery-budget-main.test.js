/**
 * Integration-level test for the bounded renderer reload budget in main.run().
 *
 * Drives the real main.js bootstrap with fake Electron objects in attach mode
 * (no child process), a controllable Date.now clock and a local HTTP health
 * endpoint. Mirrors the verifier's adversarial repro, but asserts the fixed
 * contract: success-then-crash cycles cannot refund the budget, a >60 s
 * stability window resets it, and the explicit Retry IPC resets it.
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

const CLOCK_STEP_MS = 5001; // just past the 5 s cooldown
const RELOAD_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, label, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (performance.now() >= deadline) {
      assert.fail(`timeout waiting for ${label}`);
    }
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
    async executeJavaScript() {
      return {};
    },
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

  isMinimized() {
    return false;
  }

  show() {
    this._shown = true;
  }

  focus() {}

  hide() {}

  restore() {}

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
      return 'shell-test';
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
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    ipcHandlers,
    shell: {},
    Tray: undefined,
    Menu: {},
    nativeImage: {},
  };
}

test('main.run keeps renderer reloads bounded, self-heals after 60 s, and resets on explicit retry', { timeout: 30000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-budget-'));
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
  const attachUrl = `http://127.0.0.1:${port}/?token=budget-test`;

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

  const fake = makeFakeElectron();
  FakeBrowserWindow.instances.length = 0;
  const app = main.run(fake);
  assert.equal(app, fake.app);

  await waitFor(
    () => FakeBrowserWindow.instances.length > 0
      && FakeBrowserWindow.instances[0].loadCalls.includes(attachUrl),
    'initial attach load',
  );
  const win = FakeBrowserWindow.instances[0];
  const harnessLoads = () => win.loadCalls.filter((url) => url === attachUrl).length;
  const errorPageLoaded = () => win.loadCalls.some((url) => url.includes('error.html'));
  const markHarnessLoaded = () => win.webContents.emit('did-finish-load');
  const crashRenderer = () => win.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed', exitCode: 133 },
  );

  // ---- Phase A: four rapid success-then-crash cycles -> 3 reloads, then error page.
  let cycles = 0;
  while (cycles < 4) {
    markHarnessLoaded();
    clock += CLOCK_STEP_MS;
    const before = harnessLoads();
    crashRenderer();
    if (cycles < 3) {
      await waitFor(() => harnessLoads() > before, `reload after cycle ${cycles + 1}`);
    } else {
      await waitFor(errorPageLoaded, 'error page after budget exhaustion');
      await sleep(RELOAD_DELAY_MS + 500);
      assert.equal(harnessLoads(), 1 + main.MAX_RENDERER_RELOADS, 'no reload beyond the 3-reload cap');
    }
    cycles += 1;
  }
  assert.equal(harnessLoads(), 4);
  assert.equal(errorPageLoaded(), true);

  // ---- Phase B: a crash after >60 s of stability resets the rolling budget.
  const beforeWindowReset = harnessLoads();
  clock += main.RENDERER_RELOAD_WINDOW_MS + 1;
  crashRenderer();
  await waitFor(() => harnessLoads() > beforeWindowReset, 'reload after 60 s window reset');
  assert.equal(harnessLoads(), 5);

  // ---- Phase C: explicit error-page Retry resets a spent budget.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    markHarnessLoaded();
    clock += CLOCK_STEP_MS;
    const before = harnessLoads();
    crashRenderer();
    await waitFor(() => harnessLoads() > before, `reload while rebuilding budget (${cycle + 1})`);
  }
  markHarnessLoaded();
  clock += CLOCK_STEP_MS;
  crashRenderer();
  await waitFor(errorPageLoaded, 'error page before explicit retry');
  assert.equal(harnessLoads(), 7, 'budget exhausted again after 3 more reloads');

  const senderUrl = win.webContents.getURL();
  assert.match(senderUrl, /error\.html/);
  const ipsRetry = fake.ipcHandlers.get(main.RETRY_CHANNEL);
  assert.equal(typeof ipsRetry, 'function');
  const beforeRetry = harnessLoads();
  const retryResult = ipsRetry({
    sender: { id: win.webContents.id, getURL: () => senderUrl },
    senderFrame: { url: senderUrl },
  });
  assert.deepEqual(retryResult, { ok: true });
  await waitFor(() => harnessLoads() > beforeRetry, 'reload after explicit retry');
  assert.equal(harnessLoads(), 8);

  // The reset is real: one more crash must still be allowed a reload.
  markHarnessLoaded();
  clock += CLOCK_STEP_MS;
  const beforePostRetryCrash = harnessLoads();
  crashRenderer();
  await waitFor(() => harnessLoads() > beforePostRetryCrash, 'reload after post-retry crash');
  assert.equal(harnessLoads(), 9);

  // ---- Shutdown through the real before-quit path.
  const beforeQuit = { prevented: false, preventDefault() { this.prevented = true; } };
  fake.app.emit('before-quit', beforeQuit);
  assert.equal(beforeQuit.prevented, true);
  // Cleanup completes with app.exit(0); a second app.quit() never completes
  // when a tray + window-all-closed listener exist (the launcher-reopen hang).
  await waitFor(() => (fake.app.exitCount || 0) >= 1, 'app.exit after before-quit');
  assert.deepEqual(fake.app.exitCodes, [0]);
  assert.equal(fake.app.quitCount || 0, 0, 'no second app.quit() after the prevented one');
});
