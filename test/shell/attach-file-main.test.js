/**
 * Integration-level test for Electron attach-url-file mode in main.run().
 *
 * Uses fake Electron objects, a real temp URL file, a local HTTP health
 * server and an injected spawn spy. The 15 s missing-file timeout is
 * compressed by wrapping global.setTimeout for exactly that value, so the
 * test stays fast while still driving the real main.js logic.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const main = require('../../src/main/main');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate, label, { timeoutMs = 6000, intervalMs = 25 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (performance.now() >= deadline) assert.fail(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
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
    id: 7001,
    session: makeFakeSession(),
    _url: '',
    executed: [],
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
    async executeJavaScript(script) {
      this.executed.push(String(script));
      return true;
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
    relaunch() {
      app.relaunchCalled = true;
    },
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

test('attach-url-file mode loads, reloads, recovers after missing and never spawns dsh', { timeout: 30000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-attach-main-'));
  const urlFile = path.join(tempDir, 'current-url');
  const statusFile = path.join(tempDir, 'status.json');
  const previous = {
    DSH_ELECTRON_USER_DATA: process.env.DSH_ELECTRON_USER_DATA,
    DSH_ELECTRON_HOME: process.env.DSH_ELECTRON_HOME,
    DSH_ELECTRON_SMOKE: process.env.DSH_ELECTRON_SMOKE,
    DSH_ELECTRON_ATTACH_URL_FILE: process.env.DSH_ELECTRON_ATTACH_URL_FILE,
  };
  const realSetTimeout = global.setTimeout;
  const realSpawn = childProcess.spawn;
  const spawnCalls = [];

  const server = http.createServer((request, response) => {
    response.statusCode = 200;
    response.end('attached ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const urlOne = `http://127.0.0.1:${port}/?token=attach-one`;
  const urlTwo = `http://127.0.0.1:${port}/?token=attach-two`;
  const urlThree = `http://127.0.0.1:${port}/?token=attach-three`;

  t.after(async () => {
    global.setTimeout = realSetTimeout;
    childProcess.spawn = realSpawn;
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
  delete process.env.DSH_ELECTRON_ATTACH_URL_FILE;
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'starting', message: 'booting' }));
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    runtimeMode: 'attach',
    attachUrlFile: urlFile,
    closeToTray: false,
    showDevTools: false,
  }));

  // No DSH child is allowed in attach mode: fail loudly if one is spawned.
  childProcess.spawn = (...args) => {
    spawnCalls.push(args);
    throw new Error('attach mode must not spawn a child process');
  };
  // Compress only the missing-file timeout so the test exercises the real path.
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(
    fn,
    ms === main.ATTACH_MISSING_TIMEOUT_MS ? 250 : ms,
    ...args,
  );

  const fake = makeFakeElectron();
  FakeBrowserWindow.instances.length = 0;
  const app = main.run(fake);
  assert.equal(app, fake.app);

  await waitFor(() => FakeBrowserWindow.instances.length > 0, 'main window creation');
  const win = FakeBrowserWindow.instances[0];
  const loadingCount = () => win.loadCalls.filter((url) => url.includes('loading.html')).length;
  const errorCount = () => win.loadCalls.filter((url) => url.includes('error.html')).length;
  const hasHarness = (url) => win.loadCalls.includes(url);

  // Initial state: no URL file -> loading page, still polling.
  await waitFor(() => loadingCount() >= 1, 'initial loading page');
  assert.equal(hasHarness(urlOne), false);
  assert.equal(errorCount(), 0);

  // status.json message is surfaced on the local loading page without blocking.
  await waitFor(
    () => win.webContents.executed.some((script) => script.includes('Runtime status: booting')),
    'runtime status annotation',
  );

  // URL appears (atomic rename) -> health -> loadURL.
  atomicWrite(urlFile, `${urlOne}\n`);
  await waitFor(() => hasHarness(urlOne), 'load URL one');
  win.webContents.emit('did-finish-load');
  await waitFor(() => win._shown, 'window shown after harness load');

  // URL changes -> reload new URL without an app restart.
  atomicWrite(urlFile, `${urlTwo}\n`);
  await waitFor(() => hasHarness(urlTwo), 'load URL two');
  assert.equal(fake.app.relaunchCalled, undefined);
  assert.equal(spawnCalls.length, 0, 'no DSH child spawned');

  // File removed -> loading page immediately, error page after 15 s, polling continues.
  const loadingBeforeRemoval = loadingCount();
  fs.unlinkSync(urlFile);
  await waitFor(() => loadingCount() > loadingBeforeRemoval, 'loading page after file removal');
  await waitFor(() => errorCount() >= 1, 'error page after missing timeout');

  // URL appears again after the error page -> recover without restart.
  atomicWrite(urlFile, `${urlThree}\n`);
  await waitFor(() => hasHarness(urlThree), 'load URL three after recovery');
  assert.equal(spawnCalls.length, 0);
  assert.equal(fake.app.relaunchCalled, undefined);

  // Shutdown through the real before-quit path; the watcher timer must clear.
  const beforeQuit = { prevented: false, preventDefault() { this.prevented = true; } };
  fake.app.emit('before-quit', beforeQuit);
  assert.equal(beforeQuit.prevented, true);
  // Cleanup completes with app.exit(0) (a second app.quit() never completes
  // with a tray + window-all-closed listener; see launcher reopen fix).
  await waitFor(() => (fake.app.exitCount || 0) >= 1, 'app.exit after before-quit');
  assert.deepEqual(fake.app.exitCodes, [0]);
  assert.equal(spawnCalls.length, 0);
});
