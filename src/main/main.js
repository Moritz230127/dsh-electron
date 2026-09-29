/**
 * main: Electron main-process orchestration for DSH Electron.
 *
 * Owns the single-instance lock, config/GPU bootstrap, the HarnessRuntime
 * child process, health -> loadURL flow, bounded renderer/GPU recovery, tray,
 * the DSH_ELECTRON_SMOKE acceptance hook and orderly shutdown.
 * Pure helpers are exported; the Electron app flow starts only when this file
 * is executed as the main module.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { loadConfig } = require('./config');
const { createLogger } = require('./logging');
const {
  gpuFallbackSwitches,
  isGpuLossFatal,
  planGpuFallbackResponse,
  planStableLaunch,
  saveGpuFallbackState,
  STABLE_LAUNCHES_BEFORE_STEP_UP,
} = require('./gpu-fallback');
const {
  DEFAULT_COOLDOWN_MS,
  planMainWindowRendererRecovery,
} = require('./recovery');
const {
  RENDERER_DIR,
  getUrlOrigin,
  isRendererPageUrl,
  loadingPagePath,
  errorPagePath,
  createMainWindow,
  installSecurityPolicy,
  redactUrl,
} = require('./window-manager');
const { createTray } = require('./tray');

const APP_TITLE = 'DSH Electron';
const HEALTH_TIMEOUT_MS = 15000;
const HEALTH_INTERVAL_MS = 250;
const STABLE_LAUNCH_MS = 60000;
// Rolling renderer-reload budget: at most 3 reloads per 60 s window and
// per app run; explicit user action is required once the budget is spent.
const RENDERER_RELOAD_WINDOW_MS = 60000;
const MAX_RENDERER_RELOADS = 3;
const RUNTIME_STOP_TIMEOUT_MS = 8000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 1000;
const RESTART_MAX_DELAY_MS = 8000;
const RECOVERY_RELOAD_DELAY_MS = 500;
const ATTACH_POLL_INTERVAL_MS = 500;
const ATTACH_STATUS_INTERVAL_MS = 1000;
const ATTACH_MISSING_TIMEOUT_MS = 15000;
const SMOKE_CAPTURE_DELAY_MS = 250;
const SMOKE_CAPTURE_TIMEOUT_MS = 5000;
const SMOKE_QUIT_DELAY_MS = 1000;
const RETRY_CHANNEL = 'dsh-shell:retry';
const QUIT_CHANNEL = 'dsh-shell:quit';

const SMOKE_SNAPSHOT_SCRIPT = `(() => {
  const rootMarker = document.querySelector('[data-slot], #root');
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const bodyTextLength = bodyText.trim().length;
  return {
    title: document.title || '',
    url: location.href,
    readyState: document.readyState || '',
    bodyTextLength,
    appRootFound: Boolean(rootMarker) || bodyTextLength > 0
  };
})()`;

/**
 * HarnessRuntime logs the ready URL (including the auth token) with its
 * injected logger. Wrap the real logger so every string argument is passed
 * through redactUrl first; the app-side logger stays untouched for exact
 * diagnostics about local pages.
 */
function createRuntimeLogger(baseLogger) {
  const redactArgs = (args) => args.map((arg) => (typeof arg === 'string' ? redactUrl(arg) : arg));
  return {
    debug: (...args) => baseLogger.debug(...redactArgs(args)),
    info: (...args) => baseLogger.info(...redactArgs(args)),
    warn: (...args) => baseLogger.warn(...redactArgs(args)),
    error: (...args) => baseLogger.error(...redactArgs(args)),
  };
}

/**
 * Candidate paths for a runtime module.
 *
 * electron-builder excludes src/main/runtime from app.asar when the same files
 * are also shipped via extraResources; packaged builds therefore have to fall
 * back to <resources>/main/runtime.
 */
function runtimeModuleCandidates(name, options = {}) {
  const baseDir = typeof options.baseDir === 'string' && options.baseDir.length > 0
    ? options.baseDir
    : __dirname;
  const resourcesPath = options.resourcesPath !== undefined
    ? options.resourcesPath
    : process.resourcesPath;

  const candidates = [path.join(baseDir, 'runtime', name)];
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, 'main', 'runtime', name));
  }
  return candidates;
}

/**
 * Require a runtime module from the dev/asar layout first, then from the
 * packaged extraResources layout. Only MODULE_NOT_FOUND marks a candidate as
 * absent; any other error is rethrown immediately so real breakage is visible.
 *
 * @param {string} name module basename ('harness-runtime' | 'health')
 * @param {{requireFn?: Function, baseDir?: string, resourcesPath?: string}} [options]
 */
function loadRuntimeModule(name, options = {}) {
  const requireFn = typeof options.requireFn === 'function' ? options.requireFn : require;
  const candidates = runtimeModuleCandidates(name, options);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return requireFn(candidate);
    } catch (error) {
      if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
      lastError = error;
    }
  }

  const error = new Error(
    `Cannot find runtime module '${name}'; tried ${candidates.join(', ')}`,
  );
  error.code = 'MODULE_NOT_FOUND';
  if (lastError) error.cause = lastError;
  throw error;
}

function requireRuntimeConstructor(options) {
  const mod = loadRuntimeModule('harness-runtime', options);
  const Constructor = typeof mod === 'function' ? mod : mod && (mod.HarnessRuntime || mod.default);
  if (typeof Constructor !== 'function') {
    throw new TypeError('runtime/harness-runtime does not export a constructor');
  }
  return Constructor;
}

function requireWaitForHealth(options) {
  const mod = loadRuntimeModule('health', options);
  const waitForHealth = typeof mod === 'function' ? mod : mod && (mod.waitForHealth || mod.default);
  if (typeof waitForHealth !== 'function') {
    throw new TypeError('runtime/health does not export waitForHealth');
  }
  return waitForHealth;
}

/** `dsh web` arguments for the managed child process. */
function buildDshArgs(config = {}) {
  return [
    'web',
    '--no-open',
    '--host',
    typeof config.host === 'string' && config.host ? config.host : '127.0.0.1',
    '--port',
    String(Number.isInteger(config.port) && config.port >= 0 ? config.port : 0),
  ];
}

function appendSwitchList(commandLine, extraSwitches) {
  if (!commandLine || typeof commandLine.appendSwitch !== 'function') return;
  for (const raw of extraSwitches || []) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.replace(/^--/, '').trim();
    if (!trimmed) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt >= 0) commandLine.appendSwitch(trimmed.slice(0, equalsAt), trimmed.slice(equalsAt + 1));
    else commandLine.appendSwitch(trimmed);
  }
}

/**
 * Apply GPU fallback switches and extra switches before app.whenReady().
 * Must be called before ready; app.disableHardwareAcceleration() is only
 * valid/meaningful at that point.
 */
function applyGpuFallback({ commandLine, app, level = 'default', extraSwitches = [] } = {}) {
  for (const switchName of gpuFallbackSwitches(level)) {
    if (commandLine && typeof commandLine.appendSwitch === 'function') {
      commandLine.appendSwitch(switchName);
    }
  }
  appendSwitchList(commandLine, extraSwitches);
  if (level === 'gpu-disabled' && app && typeof app.disableHardwareAcceleration === 'function') {
    app.disableHardwareAcceleration();
  }
}

/** Accept only loopback http(s) URLs as harness/attach targets. */
function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;

  // Accept only a real 127.0.0.0/8 IPv4 literal, never a look-alike such as
  // 127.0.0.1.evil.example.
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets[0] !== '127') return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** Normalize the browser-side smoke snapshot (pure, exported for tests). */
function normalizeSmokeSnapshot(raw, fallbackUrl = '') {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const numericLength = Number(value.bodyTextLength);
  const bodyTextLength = Number.isFinite(numericLength) ? Math.max(0, Math.trunc(numericLength)) : 0;
  const readyState = typeof value.readyState === 'string' ? value.readyState : '';
  const complete = readyState === 'complete' && bodyTextLength > 0;
  return {
    ok: complete,
    title: typeof value.title === 'string' ? value.title : '',
    url: typeof value.url === 'string' && value.url ? value.url : String(fallbackUrl || ''),
    readyState,
    bodyTextLength,
    appRootFound: value.appRootFound === true || bodyTextLength > 0,
  };
}

function smokeSnapshotScript() {
  return SMOKE_SNAPSHOT_SCRIPT;
}

function run(electron) {
  const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = electron || {};
  if (!app || !BrowserWindow) throw new TypeError('run() requires the Electron module');

  const env = process.env;
  const homedir = os.homedir();

  // 1. userData override must be applied before whenReady/app.getPath and
  //    before the single-instance lock so the lock lives under the override.
  const userDataOverride = typeof env.DSH_ELECTRON_USER_DATA === 'string'
    ? env.DSH_ELECTRON_USER_DATA.trim()
    : '';
  if (userDataOverride) {
    try {
      app.setPath('userData', path.resolve(userDataOverride));
    } catch (error) {
      process.stderr.write(`[dsh-electron] failed to set userData: ${error.message}\n`);
    }
  }

  // 2. Single instance: never start a second harness/runtime.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const userDataDir = app.getPath('userData');
  let config;
  try {
    config = loadConfig({ argv: process.argv.slice(1), userDataDir, env, homedir });
  } catch (error) {
    const fallbackHome = path.join(homedir, '.dsh');
    config = Object.freeze({
      dshCommand: 'dsh',
      dshHome: fallbackHome,
      runtimeMode: 'managed',
      attachUrl: '',
      host: '127.0.0.1',
      port: 0,
      closeToTray: true,
      showDevTools: false,
      extraSwitches: Object.freeze([]),
      gpuFallback: Object.freeze({ level: 'default', failures: 0, stableLaunches: 0 }),
    });
    process.stderr.write(`[dsh-electron] config load failed, using defaults: ${error.message}\n`);
  }

  const logger = createLogger({ userDataDir, level: config.showDevTools ? 'debug' : 'info' });
  logger.info(`${APP_TITLE} starting`, { pid: process.pid, userDataDir });

  // 3. Apply GPU fallback + extra switches before whenReady (contract 3.4 step 2).
  try {
    applyGpuFallback({
      commandLine: app.commandLine,
      app,
      level: config.gpuFallback.level,
      extraSwitches: config.extraSwitches,
    });
  } catch (error) {
    logger.error('failed to apply GPU fallback switches', error);
  }

  const state = {
    quitting: false,
    runtimeStopped: false,
    window: null,
    tray: null,
    runtime: null,
    runtimeOrigin: null,
    currentHarnessUrl: '',
    harnessRendered: false,
    pendingHarnessLoad: false,
    restartAttempts: 0,
    restartTimer: null,
    stableTimer: null,
    smokeQuitTimer: null,
    attachWatcher: null,
    attachMissingTimer: null,
    attachStatusMessage: '',
    attachLoadToken: 0,
    smokeStarted: false,
    recovery: { lastReloadAt: 0, reloadCount: 0 },
    gpuFallback: { ...config.gpuFallback },
  };

  function persistGpuState(nextState) {
    state.gpuFallback = { ...nextState };
    try {
      saveGpuFallbackState(userDataDir, state.gpuFallback);
    } catch (error) {
      logger.error('failed to persist GPU fallback state', error);
    }
  }

  function clearRestartTimer() {
    if (state.restartTimer !== null) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
  }

  function clearAppTimers() {
    clearRestartTimer();
    if (state.stableTimer !== null) {
      clearTimeout(state.stableTimer);
      state.stableTimer = null;
    }
    if (state.smokeQuitTimer !== null) {
      clearTimeout(state.smokeQuitTimer);
      state.smokeQuitTimer = null;
    }
    if (state.attachMissingTimer !== null) {
      clearTimeout(state.attachMissingTimer);
      state.attachMissingTimer = null;
    }
  }

  function showMainWindow() {
    const win = state.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (error) {
      logger.warn(`failed to show main window: ${error.message}`);
    }
  }

  function hideMainWindow() {
    const win = state.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      win.hide();
      logger.info('main window hidden to tray; DSH host keeps running');
    } catch (error) {
      logger.warn(`failed to hide main window: ${error.message}`);
    }
  }

  function resolveTrayIconPath() {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : '',
      path.join(__dirname, '..', '..', 'packaging', 'icon.png'),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // fall through
      }
    }
    return '';
  }

  function ensureWindow() {
    const existing = state.window;
    if (existing && !(typeof existing.isDestroyed === 'function' && existing.isDestroyed())) {
      return existing;
    }

    const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
    const win = createMainWindow({ BrowserWindow, config, preloadPath });
    installSecurityPolicy({
      win,
      session: win.webContents && win.webContents.session,
      shell,
      getRuntimeOrigin: () => state.runtimeOrigin,
      rendererDir: RENDERER_DIR,
      logger,
    });

    win.webContents.on('did-finish-load', () => handleDidFinishLoad(win));
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      handleDidFailLoad(win, { errorCode, errorDescription, validatedURL, isMainFrame });
    });
    win.webContents.on('render-process-gone', (event, details) => handleRendererGone(details));
    win.webContents.on('unresponsive', () => handleRendererLoss('unresponsive'));

    win.on('close', (event) => {
      if (state.quitting || config.closeToTray !== true) return;
      if (!state.tray) return; // No tray icon: closing must actually quit.
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      if (state.window === win) state.window = null;
    });

    state.window = win;
    return win;
  }

  /**
   * Annotate a local loading/error page with the supervisor status message.
   * Injected via executeJavaScript so src/renderer stays untouched and CSP
   * remains strict. Failures are debug-only and never block page flow.
   */
  async function applyRuntimeStatus(win, message) {
    const text = message ? `Runtime status: ${message}` : '';
    const script = `(() => {
      let node = document.getElementById('runtime-status');
      if (!node) {
        node = document.createElement('p');
        node.id = 'runtime-status';
        node.setAttribute('style', 'margin:0.5rem 0 0;color:#8fa3bf;font-size:0.85rem;max-width:42rem;text-align:center;');
        const root = document.querySelector('main') || document.body;
        if (root) root.appendChild(node);
      }
      node.textContent = ${JSON.stringify(text)};
      node.hidden = ${text ? 'false' : 'true'};
    })()`;
    try {
      await win.webContents.executeJavaScript(script, true);
    } catch (error) {
      logger.debug(`runtime status display skipped: ${error.message}`);
    }
  }

  async function loadLoadingPage(options = {}) {
    const statusMessage = typeof options.statusMessage === 'string'
      ? options.statusMessage
      : state.attachStatusMessage;
    state.pendingHarnessLoad = false;
    const win = ensureWindow();
    try {
      await win.loadFile(loadingPagePath());
    } catch (error) {
      logger.warn(`failed to load loading page: ${error.message}`);
    }
    if (statusMessage) await applyRuntimeStatus(win, statusMessage);
    return win;
  }

  async function showErrorPage({ title, message, detail, statusMessage = state.attachStatusMessage } = {}) {
    if (state.quitting) return;
    state.pendingHarnessLoad = false;
    const win = ensureWindow();
    const params = new URLSearchParams({
      title: title || 'Harness could not be started',
      message: message || 'The local DeepSeek Harness web UI did not become available.',
    });
    if (detail) params.set('detail', String(detail).slice(0, 4000));
    const url = `${pathToFileURL(errorPagePath()).href}?${params.toString()}`;
    try {
      await win.loadURL(url);
    } catch (error) {
      logger.error(`failed to load local error page: ${error.message}`);
    }
    if (statusMessage) await applyRuntimeStatus(win, statusMessage);
    showMainWindow();
  }

  function isErrorPageVisible() {
    const win = state.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    try {
      const current = win.webContents.getURL();
      return isRendererPageUrl(current, RENDERER_DIR) && current.includes('error.html');
    } catch {
      return false;
    }
  }

  async function loadHarnessUrl(url) {
    if (state.quitting) return false;
    const win = ensureWindow();
    state.pendingHarnessLoad = true;
    try {
      await win.loadURL(url);
      return true;
    } catch (error) {
      state.pendingHarnessLoad = false;
      logger.error(`failed to load harness URL: ${error.message}`);
      if (!isErrorPageVisible()) {
        await showErrorPage({
          title: 'Harness page failed to load',
          message: 'The harness UI could not be loaded.',
          detail: `${error.message}\n${redactUrl(url)}`,
        });
      }
      return false;
    }
  }

  function handleDidFinishLoad(win) {
    if (state.quitting || win !== state.window) return;
    let loadedUrl = '';
    try {
      loadedUrl = win.webContents.getURL();
    } catch {
      loadedUrl = state.currentHarnessUrl;
    }
    if (!state.pendingHarnessLoad) {
      logger.debug(`local page finished loading: ${redactUrl(loadedUrl)}`);
      return;
    }

    state.pendingHarnessLoad = false;
    state.harnessRendered = true;
    state.restartAttempts = 0;
    // A successful load must NOT refund the renderer reload budget: recovery
    // stays bounded across success-then-crash cycles (ARCHITECTURE 3.3).
    logger.info(`harness UI loaded: ${redactUrl(loadedUrl)}`);

    showMainWindow();
    if (config.showDevTools && !env.DSH_ELECTRON_SMOKE && typeof win.webContents.openDevTools === 'function') {
      try {
        win.webContents.openDevTools({ mode: 'detach' });
      } catch (error) {
        logger.debug(`openDevTools failed: ${error.message}`);
      }
    }
    scheduleStableLaunchCheck();
    maybeRunSmokeHook(win);
  }

  function handleDidFailLoad(win, { errorCode, errorDescription, validatedURL, isMainFrame } = {}) {
    if (state.quitting || win !== state.window) return;
    if (isMainFrame === false) return;
    if (errorCode === -3) {
      logger.debug(`main-frame load aborted (-3): ${redactUrl(validatedURL)}`);
      return;
    }
    const harnessOrigin = state.runtimeOrigin;
    const failedOrigin = getUrlOrigin(validatedURL);
    const isHarnessFailure = state.pendingHarnessLoad
      || (harnessOrigin !== null && failedOrigin === harnessOrigin);
    if (!isHarnessFailure) {
      logger.warn(`local page failed to load (${errorCode}): ${errorDescription}`);
      return;
    }

    state.pendingHarnessLoad = false;
    logger.error(`harness page failed to load (${errorCode}): ${errorDescription}`, redactUrl(validatedURL));
    void showErrorPage({
      title: 'Harness page failed to load',
      message: `The harness UI could not be loaded (error ${errorCode}: ${errorDescription}).`,
      detail: redactUrl(validatedURL),
    });
  }

  function scheduleStableLaunchCheck() {
    if (state.stableTimer !== null) clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => {
      state.stableTimer = null;
      if (state.quitting || !state.harnessRendered) return;
      const plan = planStableLaunch(state.gpuFallback);
      persistGpuState(plan.state);
      if (plan.steppedUp) {
        logger.info(`GPU fallback stepped up to '${plan.level}' for the next launch`);
      } else {
        logger.debug(`stable launch recorded (${plan.state.stableLaunches}/${STABLE_LAUNCHES_BEFORE_STEP_UP})`);
      }
    }, STABLE_LAUNCH_MS);
    if (state.stableTimer && typeof state.stableTimer.unref === 'function') state.stableTimer.unref();
  }

  async function captureSmokeSnapshot(win) {
    const deadline = Date.now() + SMOKE_CAPTURE_TIMEOUT_MS;
    let snapshot = normalizeSmokeSnapshot({}, state.currentHarnessUrl);
    let lastError = null;

    for (;;) {
      try {
        const raw = await win.webContents.executeJavaScript(SMOKE_SNAPSHOT_SCRIPT, true);
        snapshot = normalizeSmokeSnapshot(raw, state.currentHarnessUrl);
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (snapshot.ok || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (lastError) logger.error(`smoke snapshot capture failed: ${lastError.message}`);
    return snapshot;
  }

  function maybeRunSmokeHook(win) {
    const smokePath = typeof env.DSH_ELECTRON_SMOKE === 'string' ? env.DSH_ELECTRON_SMOKE.trim() : '';
    if (!smokePath || state.smokeStarted) return;
    state.smokeStarted = true;
    const absolutePath = path.resolve(smokePath);

    setTimeout(() => {
      void (async () => {
        const snapshot = await captureSmokeSnapshot(win);
        try {
          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
          logger.info(`smoke snapshot written: ${absolutePath}`, snapshot.ok ? '(ok)' : '(not ok)');
        } catch (error) {
          logger.error(`failed to write smoke snapshot: ${error.message}`);
        }
        state.smokeQuitTimer = setTimeout(() => {
          state.smokeQuitTimer = null;
          app.quit();
        }, SMOKE_QUIT_DELAY_MS);
      })();
    }, SMOKE_CAPTURE_DELAY_MS);
  }

  function handleRendererLoss(reason) {
    if (state.quitting) return;
    const now = Date.now();
    const plan = planMainWindowRendererRecovery({
      now,
      lastReloadAt: state.recovery.lastReloadAt,
      reloadCount: state.recovery.reloadCount,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      maxReloads: MAX_RENDERER_RELOADS,
      windowMs: RENDERER_RELOAD_WINDOW_MS,
    });

    if (plan.windowReset) {
      logger.info(`renderer reload budget reset: >${Math.round(RENDERER_RELOAD_WINDOW_MS / 1000)}s since last reload (${reason})`);
    }
    state.recovery.reloadCount = plan.reloadCount;

    if (!plan.allowed) {
      const exhausted = plan.reason === 'budget-exhausted';
      if (exhausted) {
        logger.error(`renderer reload budget exhausted (${state.recovery.reloadCount}/${MAX_RENDERER_RELOADS}) after ${reason}`);
      } else {
        logger.warn(`renderer reload deferred by ${plan.cooldownRemainingMs}ms cooldown (${reason})`);
      }
      void showErrorPage({
        title: exhausted ? 'Renderer recovery stopped' : 'Renderer recovery paused',
        message: exhausted
          ? `The main window failed ${MAX_RENDERER_RELOADS} times within the recovery window; automatic reloads are stopped. Use Retry or tray Restart Harness to reset the budget.`
          : 'The main window failed again during the recovery cooldown. Use Retry or tray Restart Harness to try again.',
        detail: `reason: ${reason}; policy: ${plan.reason}; reloads: ${state.recovery.reloadCount}/${MAX_RENDERER_RELOADS}`,
      });
      return;
    }

    // Consume one unit of the rolling budget only when a reload is performed.
    state.recovery.reloadCount = plan.reloadCount + 1;
    state.recovery.lastReloadAt = now;
    logger.warn(`recovering main window (${reason}); reload ${state.recovery.reloadCount}/${MAX_RENDERER_RELOADS}${plan.windowReset ? ' (window reset)' : ''}`);
    void loadLoadingPage();
    setTimeout(() => {
      if (state.quitting) return;
      void reloadHarness();
    }, RECOVERY_RELOAD_DELAY_MS).unref?.();
  }

  function handleRendererGone(details = {}) {
    logger.error(`main window renderer gone: ${details.reason || 'unknown'}`, {
      exitCode: details.exitCode,
    });
    handleRendererLoss(`render-process-gone:${details.reason || 'unknown'}`);
  }

  function clearAttachMissingTimer() {
    if (state.attachMissingTimer !== null) {
      clearTimeout(state.attachMissingTimer);
      state.attachMissingTimer = null;
    }
  }

  function stopAttachWatcher() {
    const watcher = state.attachWatcher;
    state.attachWatcher = null;
    if (watcher && typeof watcher.stop === 'function') {
      try {
        watcher.stop();
      } catch (error) {
        logger.warn(`attach watcher stop failed: ${error.message}`);
      }
    }
  }

  /** Show the loading page and arm the 15 s "still missing" error page. */
  function beginAttachWaiting(reason) {
    if (state.quitting || !state.attachWatcher) return;
    state.attachLoadToken += 1;
    state.currentHarnessUrl = '';
    state.runtimeOrigin = null;
    logger.debug(`attach mode waiting for URL (${reason})`);
    void loadLoadingPage({ statusMessage: state.attachStatusMessage });
    if (state.attachMissingTimer !== null) return;
    state.attachMissingTimer = setTimeout(() => {
      state.attachMissingTimer = null;
      if (state.quitting || !state.attachWatcher) return;
      void showErrorPage({
        title: 'Waiting for the DSH host',
        message: 'The supervisor has not published a DSH URL yet. The app keeps polling and will recover automatically when the file appears.',
        detail: String(reason || ''),
        statusMessage: state.attachStatusMessage,
      });
    }, ATTACH_MISSING_TIMEOUT_MS);
  }

  function handleAttachStatus(status = {}) {
    const message = typeof status.message === 'string' ? status.message.trim() : '';
    if (message === state.attachStatusMessage) return;
    state.attachStatusMessage = message;
    if (message) logger.info(`runtime status: ${message}`);
    const win = state.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try {
      // Only annotate local loading/error pages, never the official UI.
      if (isRendererPageUrl(win.webContents.getURL(), RENDERER_DIR)) {
        void applyRuntimeStatus(win, message);
      }
    } catch {
      // The page/window is going away; status is advisory only.
    }
  }

  async function handleAttachUrl(url, { changed = false } = {}) {
    if (state.quitting || !state.attachWatcher) return;
    if (!isLoopbackUrl(url)) {
      logger.warn(`ignoring non-loopback URL from attach URL file: ${redactUrl(url)}`);
      beginAttachWaiting('URL file contained a non-loopback URL');
      return;
    }

    clearAttachMissingTimer();
    const token = ++state.attachLoadToken;
    state.currentHarnessUrl = url;
    state.runtimeOrigin = getUrlOrigin(url);
    logger.info(`attach URL ${changed ? 'changed' : 'found'}: ${redactUrl(url)}`);

    try {
      const waitForHealth = requireWaitForHealth();
      const healthy = await waitForHealth(url, {
        timeoutMs: HEALTH_TIMEOUT_MS,
        intervalMs: HEALTH_INTERVAL_MS,
      });
      if (state.quitting || token !== state.attachLoadToken) return;
      if (healthy === false) throw new Error('health check timed out');
    } catch (error) {
      if (state.quitting || token !== state.attachLoadToken) return;
      logger.error(`attach URL health check failed: ${error.message}`);
      await showErrorPage({
        title: 'DSH host is not ready',
        message: 'The supervisor published a URL but the DSH server did not answer the health check. Waiting for the next URL update.',
        detail: redactUrl(url),
        statusMessage: state.attachStatusMessage,
      });
      return;
    }

    if (state.quitting || token !== state.attachLoadToken) return;
    await loadHarnessUrl(url);
  }

  async function startAttachFileMode() {
    if (state.quitting) return;
    const filePath = path.resolve(config.attachUrlFile);
    const statusPath = path.join(path.dirname(filePath), 'status.json');
    const { AttachUrlWatcher } = require('./attach-url');
    const watcher = new AttachUrlWatcher({
      filePath,
      statusPath,
      intervalMs: ATTACH_POLL_INTERVAL_MS,
      statusIntervalMs: ATTACH_STATUS_INTERVAL_MS,
    });
    state.attachWatcher = watcher;

    watcher.on('url', ({ url, changed }) => {
      void handleAttachUrl(url, { changed });
    });
    watcher.on('missing', ({ previousUrl } = {}) => {
      logger.warn(`attach URL file missing${previousUrl ? ` (previous ${redactUrl(previousUrl)})` : ''}`);
      beginAttachWaiting('URL file is missing');
    });
    watcher.on('status', (status) => {
      handleAttachStatus(status);
    });
    watcher.on('status-error', ({ reason } = {}) => {
      logger.debug(`status.json not usable yet: ${reason}`);
    });

    logger.info(`attach-file mode: polling ${filePath}`);
    watcher.start();
  }

  async function reloadHarness() {
    if (state.quitting) return;
    if (state.attachWatcher) {
      if (state.currentHarnessUrl) {
        await loadHarnessUrl(state.currentHarnessUrl);
        return;
      }
      beginAttachWaiting('reload requested while no attach URL is known');
      return;
    }
    if (state.currentHarnessUrl) {
      await loadHarnessUrl(state.currentHarnessUrl);
      return;
    }
    await showErrorPage({
      title: 'Harness is not running',
      message: 'No harness URL is known yet. Use Retry to start it again.',
    });
  }

  function handleChildProcessGone(details = {}) {
    if (state.quitting) return;
    if (details.type !== 'GPU') {
      logger.warn(`child process gone (${details.type || 'unknown'}): ${details.reason || 'unknown'}`);
      return;
    }
    if (!isGpuLossFatal(details.reason, details.exitCode)) {
      logger.warn(`non-fatal GPU process loss ignored (${details.reason || 'unknown'}${details.exitCode !== undefined ? `/${details.exitCode}` : ''})`);
      return;
    }

    const plan = planGpuFallbackResponse({
      state: state.gpuFallback,
      harnessRendered: state.harnessRendered,
    });
    logger.error(`fatal GPU process loss: ${details.reason || 'unknown'}`, {
      exitCode: details.exitCode,
      action: plan.action,
      level: plan.level,
    });
    persistGpuState(plan.state);

    if (plan.action === 'stop') {
      void showErrorPage({
        title: 'GPU fallback exhausted',
        message: 'The harness lost its GPU process repeatedly and no fallback level is left. Restart to retry.',
        detail: `level: ${plan.level}; reason: ${details.reason || 'unknown'}`,
      });
      return;
    }
    if (plan.action === 'relaunch') {
      logger.warn(`GPU fallback stepping to '${plan.level}'; relaunching the app`);
      void relaunchApp();
    }
  }

  async function stopRuntimeSafely() {
    const runtime = state.runtime;
    state.runtime = null;
    if (!runtime) return;
    try {
      if (typeof runtime.removeAllListeners === 'function') runtime.removeAllListeners();
    } catch {
      // Listener cleanup is best effort.
    }
    if (typeof runtime.stop === 'function') {
      try {
        await runtime.stop();
      } catch (error) {
        logger.error(`runtime stop failed: ${error.message}`);
      }
    }
  }

  async function relaunchApp() {
    if (state.quitting) return;
    state.quitting = true;
    clearAppTimers();
    stopAttachWatcher();
    await stopRuntimeSafely();
    try {
      // Preserve the launch arguments (dev `.`, --user-data-dir, extra flags);
      // the GPU level itself is persisted and read from config on boot.
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(0);
    } catch (error) {
      logger.error(`relaunch failed: ${error.message}`);
      app.quit();
    }
  }

  function createRuntimeInstance() {
    const HarnessRuntime = requireRuntimeConstructor();
    return new HarnessRuntime({
      command: config.dshCommand,
      args: buildDshArgs(config),
      cwd: homedir,
      env: { ...process.env, DSH_HOME: config.dshHome },
      logger: createRuntimeLogger(logger),
      stopTimeoutMs: RUNTIME_STOP_TIMEOUT_MS,
    });
  }

  function scheduleRestart(reason) {
    if (state.quitting) return;
    if (state.restartTimer !== null) return;

    if (config.runtimeMode === 'attach') {
      logger.warn(`attach mode: not restarting a child (${reason}); reloading attach URL`);
      void reloadHarness();
      return;
    }
    if (state.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.error(`harness restart attempts exhausted (${reason})`);
      void showErrorPage({
        title: 'Harness failed to stay running',
        message: `The harness failed ${state.restartAttempts} times (${reason}). Use Retry to try again.`,
      });
      return;
    }

    state.restartAttempts += 1;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * (2 ** (state.restartAttempts - 1)),
      RESTART_MAX_DELAY_MS,
    );
    logger.warn(`restarting harness in ${delay} ms (${reason}; attempt ${state.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
    void loadLoadingPage();
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      void startManagedRuntime();
    }, delay);
    if (state.restartTimer && typeof state.restartTimer.unref === 'function') state.restartTimer.unref();
  }

  function handleRuntimeFailure(kind, info = {}) {
    if (state.quitting) return;
    const errorMessage = (info.error && info.error.message)
      || info.message
      || (info.code !== undefined ? `exit code ${info.code}` : 'unknown error');
    if (info.signal !== undefined && info.signal !== null) {
      logger.error(`harness ${kind}: ${errorMessage}`, { signal: info.signal });
    } else {
      logger.error(`harness ${kind}: ${errorMessage}`);
    }
    scheduleRestart(kind);
  }

  async function handleRuntimeReady(runtimeInstance, info = {}) {
    if (state.quitting || runtimeInstance !== state.runtime) return;
    const url = typeof info.url === 'string' ? info.url : '';
    if (!url) {
      logger.error('harness reported ready without a URL');
      scheduleRestart('ready-without-url');
      return;
    }
    if (!isLoopbackUrl(url)) {
      logger.error(`refusing non-loopback harness URL: ${redactUrl(url)}`);
      await showErrorPage({
        title: 'Unsafe harness URL',
        message: 'The harness URL is not loopback; refusing to load it.',
        detail: redactUrl(url),
      });
      return;
    }

    state.runtimeOrigin = getUrlOrigin(url);
    state.currentHarnessUrl = url;
    logger.info(`harness ready at ${redactUrl(url)}${info.port !== undefined ? ` (port ${info.port})` : ''}`);

    try {
      const waitForHealth = requireWaitForHealth();
      const healthy = await waitForHealth(url, {
        timeoutMs: HEALTH_TIMEOUT_MS,
        intervalMs: HEALTH_INTERVAL_MS,
      });
      if (healthy === false) throw new Error('health check timed out');
    } catch (error) {
      if (state.quitting || runtimeInstance !== state.runtime) return;
      logger.error(`harness health check failed: ${error.message}`);
      scheduleRestart('health-check-failed');
      return;
    }

    if (state.quitting || runtimeInstance !== state.runtime) return;
    await loadHarnessUrl(url);
  }

  async function startManagedRuntime() {
    if (state.quitting) return;
    await stopRuntimeSafely();
    if (state.quitting) return;

    let runtime;
    try {
      runtime = createRuntimeInstance();
    } catch (error) {
      logger.error(`failed to construct HarnessRuntime: ${error.message}`);
      scheduleRestart('runtime-constructor-failed');
      return;
    }

    state.runtime = runtime;
    state.runtimeOrigin = null;
    state.currentHarnessUrl = '';
    state.harnessRendered = false;
    state.pendingHarnessLoad = false;

    runtime.on('starting', () => logger.info(`starting harness: ${config.dshCommand} ${buildDshArgs(config).join(' ')}`));
    runtime.on('stdout', ({ line } = {}) => logger.debug(`dsh stdout: ${line}`));
    runtime.on('stderr', ({ line } = {}) => logger.debug(`dsh stderr: ${line}`));
    runtime.on('ready', (info) => {
      void handleRuntimeReady(runtime, info);
    });
    runtime.on('fatal', (info) => handleRuntimeFailure('fatal', info));
    runtime.on('exit', (info = {}) => {
      if (info.expected) {
        logger.info(`harness exited (expected${info.code !== undefined ? `, code ${info.code}` : ''})`);
        return;
      }
      handleRuntimeFailure('unexpected exit', info);
    });

    try {
      await runtime.start();
    } catch (error) {
      if (state.runtime === runtime) {
        logger.error(`failed to spawn harness: ${error.message}`);
        scheduleRestart('spawn-failed');
      }
      return;
    }

    if (state.runtime === runtime && typeof runtime.isRunning === 'function' && !runtime.isRunning()) {
      logger.error('harness did not stay running after start()');
      scheduleRestart('not-running-after-start');
    }
  }

  async function startAttachMode() {
    const url = config.attachUrl;
    if (!url || !isLoopbackUrl(url)) {
      logger.error(`invalid --attach-url: ${redactUrl(url)}`);
      await showErrorPage({
        title: 'Invalid attach URL',
        message: '--attach-url must be a loopback http(s) URL.',
        detail: redactUrl(url),
      });
      return;
    }

    state.runtimeOrigin = getUrlOrigin(url);
    state.currentHarnessUrl = url;
    logger.info(`attach mode: waiting for ${redactUrl(url)}`);

    try {
      const waitForHealth = requireWaitForHealth();
      const healthy = await waitForHealth(url, {
        timeoutMs: HEALTH_TIMEOUT_MS,
        intervalMs: HEALTH_INTERVAL_MS,
      });
      if (healthy === false) throw new Error('health check timed out');
    } catch (error) {
      if (state.quitting) return;
      logger.error(`attach health check failed: ${error.message}`);
      await showErrorPage({
        title: 'Could not attach to harness',
        message: 'The configured attach URL is not responding.',
        detail: redactUrl(url),
      });
      return;
    }

    if (state.quitting) return;
    await loadHarnessUrl(url);
  }

  function restartHarness(source) {
    if (state.quitting) return;
    logger.info(`restart requested (${source}); resetting renderer reload budget`);
    state.restartAttempts = 0;
    state.recovery.reloadCount = 0;
    state.recovery.lastReloadAt = 0;
    clearRestartTimer();
    if (config.attachUrlFile) {
      clearAttachMissingTimer();
      if (state.attachWatcher) state.attachWatcher.poll();
      if (state.currentHarnessUrl) {
        state.pendingHarnessLoad = false;
        void loadHarnessUrl(state.currentHarnessUrl);
      } else {
        beginAttachWaiting('explicit restart while the URL file is absent');
      }
      return;
    }
    if (config.runtimeMode === 'attach') {
      void reloadHarness();
      return;
    }
    void startManagedRuntime();
  }

  function retryFromErrorPage() {
    if (state.quitting) return;
    logger.info('error-page retry requested; resetting renderer reload budget');
    state.restartAttempts = 0;
    state.recovery.reloadCount = 0;
    state.recovery.lastReloadAt = 0;
    if (config.attachUrlFile) {
      clearAttachMissingTimer();
      if (state.attachWatcher) state.attachWatcher.poll();
      if (state.currentHarnessUrl) {
        state.pendingHarnessLoad = false;
        void loadHarnessUrl(state.currentHarnessUrl);
      } else {
        beginAttachWaiting('error-page retry while the URL file is absent');
      }
      return;
    }
    if (config.runtimeMode === 'attach') {
      void reloadHarness();
      return;
    }
    const runtimeRunning = state.runtime
      && typeof state.runtime.isRunning === 'function'
      && state.runtime.isRunning();
    if (runtimeRunning && state.currentHarnessUrl) {
      state.pendingHarnessLoad = false;
      void loadHarnessUrl(state.currentHarnessUrl);
      return;
    }
    void startManagedRuntime();
  }

  function createAppTray() {
    if (config.closeToTray !== true) {
      logger.info('tray disabled (--no-tray / closeToTray=false)');
      return null;
    }
    const iconPath = resolveTrayIconPath();
    return createTray({
      Tray,
      Menu,
      nativeImage,
      iconPath,
      tooltip: 'DeepSeek Harness',
      onShow: showMainWindow,
      onRestart: () => restartHarness('tray'),
      onHide: hideMainWindow,
      onQuit: hideMainWindow, // legacy: never quit the UI from the tray by accident
      logger,
    });
  }

  function isTrustedIpcSender(event) {
    const win = state.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    if (!event || !event.sender || event.sender.id !== win.webContents.id) return false;
    let senderUrl = '';
    try {
      senderUrl = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    } catch {
      senderUrl = '';
    }
    return isRendererPageUrl(senderUrl, RENDERER_DIR);
  }

  function registerIpcHandlers() {
    for (const channel of [RETRY_CHANNEL, QUIT_CHANNEL]) {
      try {
        if (ipcMain && typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel);
      } catch {
        // No handler registered yet.
      }
    }
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;

    ipcMain.handle(RETRY_CHANNEL, (event) => {
      if (!isTrustedIpcSender(event)) {
        logger.warn('rejected retry IPC from untrusted sender');
        return { ok: false };
      }
      retryFromErrorPage();
      return { ok: true };
    });
    ipcMain.handle(QUIT_CHANNEL, (event) => {
      if (!isTrustedIpcSender(event)) {
        logger.warn('rejected quit IPC from untrusted sender');
        return { ok: false };
      }
      app.quit();
      return { ok: true };
    });
  }

  app.on('second-instance', () => {
    logger.info('second instance detected; focusing main window');
    if (!state.window) {
      void loadLoadingPage();
    }
    showMainWindow();
  });

  app.on('child-process-gone', (event, details) => handleChildProcessGone(details));

  app.on('window-all-closed', () => {
    if (state.quitting) return;
    if (config.closeToTray === true && state.tray) return;
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (state.runtimeStopped) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    state.quitting = true;
    clearAppTimers();
    stopAttachWatcher();
    logger.info('quitting: stopping harness runtime/attach watcher');

    Promise.resolve()
      .then(() => stopRuntimeSafely())
      .catch((error) => logger.error(`runtime shutdown failed: ${error.message}`))
      .finally(() => {
        state.runtimeStopped = true;
        try {
          logger.info('shutdown complete');
          logger.flush();
          logger.close();
        } catch {
          // Never block quit on logging.
        }
        app.quit();
      });

    const forceTimer = setTimeout(() => {
      if (!state.runtimeStopped) {
        state.runtimeStopped = true;
        try {
          logger.error('runtime stop timed out; forcing exit');
        } catch {
          // Ignore.
        }
        app.exit(0);
      }
    }, RUNTIME_STOP_TIMEOUT_MS + 4000);
    if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
  });

  app.whenReady()
    .then(async () => {
      registerIpcHandlers();
      await loadLoadingPage();
      state.tray = createAppTray();
      const modeLabel = config.attachUrlFile
        ? `attach-url-file (${config.attachUrlFile})`
        : config.runtimeMode;
      logger.info(`runtime mode: ${modeLabel}; closeToTray: ${config.closeToTray}`);
      if (config.runtimeMode === 'attach') {
        if (config.attachUrlFile) await startAttachFileMode();
        else await startAttachMode();
      } else {
        await startManagedRuntime();
      }
    })
    .catch((error) => {
      logger.error(`startup failed: ${error.message}`);
      void showErrorPage({
        title: 'Startup failed',
        message: 'The app could not start the harness.',
        detail: String(error.stack || error.message || error),
      });
    });

  return app;
}

if (require.main === module || process.type === 'browser') {
  run(require('electron'));
}

module.exports = {
  APP_TITLE,
  HEALTH_TIMEOUT_MS,
  HEALTH_INTERVAL_MS,
  STABLE_LAUNCH_MS,
  RUNTIME_STOP_TIMEOUT_MS,
  MAX_RESTART_ATTEMPTS,
  MAX_RENDERER_RELOADS,
  RENDERER_RELOAD_WINDOW_MS,
  ATTACH_POLL_INTERVAL_MS,
  ATTACH_STATUS_INTERVAL_MS,
  ATTACH_MISSING_TIMEOUT_MS,
  RETRY_CHANNEL,
  QUIT_CHANNEL,
  SMOKE_SNAPSHOT_SCRIPT,
  buildDshArgs,
  applyGpuFallback,
  isLoopbackUrl,
  normalizeSmokeSnapshot,
  smokeSnapshotScript,
  createRuntimeLogger,
  runtimeModuleCandidates,
  loadRuntimeModule,
  requireRuntimeConstructor,
  requireWaitForHealth,
  run,
};
