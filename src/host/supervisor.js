/**
 * supervisor: v0.2 host supervisor.
 *
 * Owns the official `dsh web` child and the Electron attach-mode child:
 * DSH lifecycle -> URL file -> UI lifecycle, with a local known-good runtime
 * snapshot fallback. Pure Node (no Electron import).
 *
 * Package layout note: the CLI/unit entry is copied to resources/host, and the
 * relative requires below expect resources/main/runtime/{harness-runtime,health}.js.
 */
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HarnessRuntime } = require('../main/runtime/harness-runtime');
const { waitForHealth } = require('../main/runtime/health');
const { normalizeConfig } = require('./config');

const SNAPSHOT_RETRY = 'cp -a --reflink=auto';
const FALLBACK_COPY_COMMAND = 'cp -a';
const EXHAUSTED_RETRY_MS = 60000;
const UI_KILL_GRACE_MS = 5000;
const MAX_SNAPSHOTS = 2;
const DEFAULT_ENTRY_REL = path.join('lib', 'bin.js');

function noop() {}

function normalizeLogger(logger) {
  if (logger === null || typeof logger !== 'object') {
    return { debug: noop, info: noop, warn: noop, error: noop };
  }
  return {
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

function mkdirSyncSafe(fsModule, dir, mode) {
  try {
    fsModule.mkdirSync(dir, { recursive: true, mode });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
}

function existsSafe(fsModule, target) {
  try {
    return typeof fsModule.existsSync === 'function' ? fsModule.existsSync(target) : false;
  } catch {
    return false;
  }
}

function removePathSafe(fsModule, target) {
  try {
    if (typeof fsModule.rmSync === 'function') fsModule.rmSync(target, { recursive: true, force: true });
    else if (typeof fsModule.unlinkSync === 'function') fsModule.unlinkSync(target);
  } catch {
    // Best-effort cleanup only.
  }
}

function relativeInside(root, entry) {
  if (typeof root !== 'string' || typeof entry !== 'string') return DEFAULT_ENTRY_REL;
  const rel = path.relative(root, entry);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return DEFAULT_ENTRY_REL;
  return rel;
}

function sanitizeSegment(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, '_');
}

function hashPath(root) {
  return crypto.createHash('sha256').update(String(root)).digest('hex').slice(0, 12);
}

function describeCommandResult(result) {
  if (!result) return 'no result';
  if (result.error) return result.error.message;
  if (result.signal) return `signal=${result.signal}`;
  return `exit=${result.code}`;
}

/**
 * Walk up from the real path of the dsh entry until a directory whose
 * package.json has name === '@deepseek-ai/dsh'.
 */
function resolveRuntimeRootFromEntry(entry, options = {}) {
  const fsModule = options.fs || fs;
  if (typeof entry !== 'string' || entry.length === 0) return null;

  let current = entry;
  if (typeof fsModule.realpathSync === 'function') {
    try {
      current = fsModule.realpathSync(entry);
    } catch {
      return null;
    }
  }
  if (typeof fsModule.statSync === 'function') {
    try {
      const stats = fsModule.statSync(current);
      if (stats && typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
        current = path.dirname(current);
      }
    } catch {
      current = path.dirname(current);
    }
  }

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const raw = fsModule.readFileSync(path.join(current, 'package.json'), 'utf8');
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed !== null && typeof parsed === 'object' && parsed.name === '@deepseek-ai/dsh') {
        return current;
      }
    } catch {
      // No package.json here (or unreadable): keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Read package.json version for a resolved DSH runtime root. */
function runtimeVersion(root, options = {}) {
  const fsModule = options.fs || fs;
  if (typeof root !== 'string' || root.length === 0) return null;
  try {
    const raw = fsModule.readFileSync(path.join(root, 'package.json'), 'utf8');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Startup decision:
 * 1. system runtime when resolvable (or known-good when it is not);
 * 2. known-good fast path when it already failed for the same version recently;
 * 3. otherwise system first.
 */
function decideRuntimeChoice(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : 86400000;
  const systemVersion = typeof options.systemVersion === 'string' && options.systemVersion.length > 0
    ? options.systemVersion
    : null;
  const knownGood =
    options.knownGood !== null &&
    typeof options.knownGood === 'object' &&
    typeof options.knownGood.version === 'string' &&
    options.knownGood.version.length > 0 &&
    typeof options.knownGood.root === 'string' &&
    typeof options.knownGood.entry === 'string'
      ? options.knownGood
      : null;
  const attempt = options.attempt !== null && typeof options.attempt === 'object' ? options.attempt : null;

  if (systemVersion === null) {
    if (knownGood !== null) {
      return { source: 'known-good', reason: 'system-unresolved', knownGood };
    }
    return { source: 'system', reason: 'system-unresolved', version: null };
  }

  const recentlyFailed =
    attempt !== null &&
    attempt.systemVersion === systemVersion &&
    Number.isFinite(attempt.failedAt) &&
    now - attempt.failedAt >= 0 &&
    now - attempt.failedAt < retryAfterMs;

  if (knownGood !== null && recentlyFailed) {
    return { source: 'known-good', reason: 'fast-path-after-failure', knownGood };
  }
  return { source: 'system', reason: 'system-first', version: systemVersion };
}

/**
 * Windowed restart budget + exponential backoff (1s, 2s, 4s, 8s, ... cap 30s).
 * When the budget for the window is exhausted, allowed=false and the caller
 * should keep retrying at a fixed 60s interval.
 */
function planChildRestart(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxRestarts = Number.isFinite(options.maxRestarts) && options.maxRestarts >= 0 ? options.maxRestarts : 5;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 300000;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs > 0 ? options.baseDelayMs : 1000;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs > 0 ? options.maxDelayMs : 30000;
  const exhaustedDelayMs =
    Number.isFinite(options.exhaustedDelayMs) && options.exhaustedDelayMs > 0 ? options.exhaustedDelayMs : EXHAUSTED_RETRY_MS;
  const timestamps = Array.isArray(options.timestamps) ? options.timestamps : [];

  const recent = timestamps.filter(
    (timestamp) => Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < windowMs,
  );
  const count = recent.length;
  if (count >= maxRestarts) {
    return { allowed: false, count, delayMs: exhaustedDelayMs, recent };
  }
  return {
    allowed: true,
    count,
    delayMs: Math.min(baseDelayMs * 2 ** count, maxDelayMs),
    recent,
  };
}

/** True when the command is the Electron binary itself (dev launcher). */
function looksLikeElectronBinary(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'electron' || base === 'electron.exe';
}

/** App root for a dev/electron-binary launch: config > env app > APP_ROOT > repo. */
function resolveElectronAppPath(config, env, repoRoot) {
  for (const candidate of [config.electronAppPath, env.DSH_HOST_ELECTRON_APP, env.DSH_HOST_APP_ROOT]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return repoRoot;
}

/** Resolve the Electron executable + argv per contract section 2.1. */
function resolveElectronLaunch(options = {}) {
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env;
  const exists =
    typeof options.exists === 'function'
      ? options.exists
      : (target) => existsSafe(fs, target);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const electronArgs = Array.isArray(config.electronArgs) ? config.electronArgs.slice() : [];
  const devRequested = String(env.DSH_HOST_DEV_APP || '').trim() === '1';
  const appPath = resolveElectronAppPath(config, env, repoRoot);

  const resolveVariant = (command, source) => {
    // A dev app (DSH_HOST_DEV_APP=1) or a raw `electron` binary needs the app
    // root as an argument; a packaged app binary must not get one.
    if (devRequested || looksLikeElectronBinary(command)) {
      return { command, args: [appPath].concat(electronArgs), source, appPath };
    }
    return { command, args: electronArgs, source, appPath: null };
  };

  const explicit = typeof config.electronExecutable === 'string' ? config.electronExecutable.trim() : '';
  if (explicit.length > 0) return resolveVariant(explicit, 'config');

  const fromEnv = typeof env.DSH_HOST_ELECTRON === 'string' ? env.DSH_HOST_ELECTRON.trim() : '';
  if (fromEnv.length > 0) return resolveVariant(fromEnv, 'env');

  const packaged = '/opt/DSH Electron/dsh-electron';
  if (exists(packaged)) {
    return { command: packaged, args: electronArgs, source: 'packaged', appPath: null };
  }

  const devElectron = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
  if (devRequested && exists(devElectron)) {
    return { command: devElectron, args: [appPath].concat(electronArgs), source: 'dev', appPath };
  }
  return null;
}

/**
 * Discover the graphical session env. If WAYLAND_DISPLAY is absent, pick the
 * first /run/user/<uid>/wayland-*; if DISPLAY is absent and Wayland is not
 * usable, fall back to :0.
 */
function discoverDisplayEnvironment(options = {}) {
  const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env;
  const fsModule = options.fs || fs;
  const uid =
    options.uid !== undefined
      ? options.uid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : undefined;
  const runtimeBase =
    options.runtimeBaseDir ||
    (typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.length > 0
      ? env.XDG_RUNTIME_DIR
      : uid !== undefined
        ? `/run/user/${uid}`
        : '');

  let waylandDisplay = typeof env.WAYLAND_DISPLAY === 'string' ? env.WAYLAND_DISPLAY.trim() : '';
  if (!waylandDisplay && runtimeBase.length > 0 && typeof fsModule.readdirSync === 'function') {
    try {
      const candidates = fsModule
        .readdirSync(runtimeBase)
        .filter((name) => typeof name === 'string' && name.startsWith('wayland-'))
        .sort();
      if (candidates.length > 0) waylandDisplay = candidates[0];
    } catch {
      // No runtime dir / not readable: Wayland not usable.
    }
  }

  let display = typeof env.DISPLAY === 'string' ? env.DISPLAY.trim() : '';
  if (!display && !waylandDisplay) display = ':0';
  return { waylandDisplay, display };
}

let atomicCounter = 0;

/** tmp+rename atomic write (0600 by default). */
function writeAtomic(filePath, content, options = {}) {
  const fsModule = options.fs || fs;
  const mode = options.mode === undefined ? 0o600 : options.mode;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${atomicCounter}`;
  atomicCounter += 1;
  let created = false;
  try {
    fsModule.writeFileSync(tmpPath, content, { mode, encoding: 'utf8' });
    created = true;
    if (typeof fsModule.chmodSync === 'function') {
      try {
        fsModule.chmodSync(tmpPath, mode);
      } catch {
        // chmod is best-effort; writeFileSync mode already requested 0600.
      }
    }
    fsModule.renameSync(tmpPath, filePath);
  } catch (error) {
    if (created && typeof fsModule.unlinkSync === 'function') {
      try {
        fsModule.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup.
      }
    }
    throw error;
  }
  return filePath;
}

function writeUrlFileAtomic(filePath, url, options = {}) {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('writeUrlFileAtomic: url must be a non-empty string');
  return writeAtomic(filePath, url, { mode: 0o600, ...options });
}

function readUrlFile(filePath, options = {}) {
  const fsModule = options.fs || fs;
  try {
    const raw = fsModule.readFileSync(filePath, 'utf8');
    if (typeof raw !== 'string') return null;
    return raw.replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

function writeStatusAtomic(filePath, status, options = {}) {
  return writeAtomic(filePath, JSON.stringify(status), { mode: 0o600, ...options });
}

function readJsonFile(filePath, options = {}) {
  const fsModule = options.fs || fs;
  const fallback = options.fallback === undefined ? null : options.fallback;
  try {
    const raw = fsModule.readFileSync(filePath, 'utf8');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function runCommand(spawnFn, command, args, options = {}) {
  const logger = options.logger || { warn: noop };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (error) {
      resolve({ code: -1, signal: null, error });
      return;
    }
    if (child === null || typeof child !== 'object' || typeof child.once !== 'function') {
      resolve({ code: -1, signal: null, error: new Error('spawn seam did not return a child process') });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ code: -1, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal, error: null }));
  });
}

async function copyRuntimeTree(options) {
  const { root, target, fs: fsModule, spawn: spawnFn, logger, now } = options;
  mkdirSyncSafe(fsModule, path.dirname(target), 0o700);
  removePathSafe(fsModule, target);

  let result = await runCommand(spawnFn, 'cp', ['-a', '--reflink=auto', root, target], { logger });
  if (result.code !== 0) {
    removePathSafe(fsModule, target);
    logger.warn(`host: cp -a --reflink=auto failed (${describeCommandResult(result)}); retrying cp -a`);
    result = await runCommand(spawnFn, 'cp', ['-a', root, target], { logger });
  }
  if (result.code !== 0) {
    removePathSafe(fsModule, target);
    throw new Error(`snapshot copy failed: ${describeCommandResult(result)}`);
  }
  return now;
}

function pruneSnapshots(options) {
  const { runtimesDir, keep = MAX_SNAPSHOTS, preserve, fs: fsModule, logger } = options;
  if (typeof fsModule.readdirSync !== 'function') return [];
  let names;
  try {
    names = fsModule.readdirSync(runtimesDir);
  } catch {
    return [];
  }
  const directories = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.startsWith('.')) continue;
    const fullPath = path.join(runtimesDir, name);
    try {
      const stats = fsModule.statSync(fullPath);
      const isDirectory = stats && typeof stats.isDirectory === 'function' ? stats.isDirectory() : true;
      if (!isDirectory) continue;
      directories.push({ name, fullPath, mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0 });
    } catch {
      // Ignore unreadable entries.
    }
  }
  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepSet = new Set();
  if (typeof preserve === 'string' && preserve.length > 0) keepSet.add(preserve);
  for (const directory of directories) {
    if (keepSet.size >= keep) break;
    keepSet.add(directory.fullPath);
  }
  const removed = [];
  for (const directory of directories) {
    if (keepSet.has(directory.fullPath)) continue;
    removePathSafe(fsModule, directory.fullPath);
    removed.push(directory.fullPath);
  }
  return removed;
}

/**
 * Snapshot a working runtime root to runtimes/<version>-<hash> (cp -a
 * --reflink=auto, fallback cp -a) and atomically replace known-good.json.
 * Failures propagate to the caller; the running server is never affected.
 */
async function promoteSnapshot(options = {}) {
  const root = typeof options.root === 'string' ? options.root : '';
  const version = typeof options.version === 'string' && options.version.length > 0 ? options.version : '';
  const runtimesDir = typeof options.runtimesDir === 'string' ? options.runtimesDir : '';
  const knownGoodFile = typeof options.knownGoodFile === 'string' ? options.knownGoodFile : '';
  if (root.length === 0 || version.length === 0 || runtimesDir.length === 0 || knownGoodFile.length === 0) {
    throw new TypeError('promoteSnapshot: root, version, runtimesDir and knownGoodFile are required');
  }

  const fsModule = options.fs || fs;
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : childProcess.spawn;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const logger = normalizeLogger(options.logger);
  const entryRel = typeof options.entryRel === 'string' && options.entryRel.length > 0 ? options.entryRel : DEFAULT_ENTRY_REL;

  mkdirSyncSafe(fsModule, runtimesDir, 0o700);
  const directoryName = `${sanitizeSegment(version)}-${hashPath(root)}`;
  const destination = path.join(runtimesDir, directoryName);

  let copied = false;
  if (!existsSafe(fsModule, destination)) {
    const tmpTarget = path.join(runtimesDir, `.tmp-${process.pid}-${now()}`);
    await copyRuntimeTree({ root, target: tmpTarget, fs: fsModule, spawn: spawnFn, logger, now: now() });
    removePathSafe(fsModule, destination);
    fsModule.renameSync(tmpTarget, destination);
    copied = true;
  }

  const record = {
    version,
    root: destination,
    entry: path.join(destination, entryRel),
    recordedAt: new Date(now()).toISOString(),
  };
  writeAtomic(knownGoodFile, JSON.stringify(record, null, 2), { fs: fsModule, mode: 0o600 });
  pruneSnapshots({ runtimesDir, keep: MAX_SNAPSHOTS, preserve: destination, fs: fsModule, logger });
  return { record, copied, directory: destination };
}

class HostSupervisor extends EventEmitter {
  constructor(config = {}, seams = {}) {
    super();
    const env = seams.env || process.env;
    const homedir = seams.homedir || os.homedir();
    const fsModule = seams.fs || fs;
    const uid = seams.uid;
    const logger = normalizeLogger(seams.logger);

    this.config = normalizeConfig(config, { env, homedir, fs: fsModule, uid });
    this._env = env;
    this._fs = fsModule;
    this._uid = uid;
    this.seams = {
      spawn: typeof seams.spawn === 'function' ? seams.spawn : childProcess.spawn,
      fs: fsModule,
      now: typeof seams.now === 'function' ? seams.now : Date.now,
      logger,
      HarnessRuntime: seams.HarnessRuntime || HarnessRuntime,
      waitForHealth: typeof seams.waitForHealth === 'function' ? seams.waitForHealth : waitForHealth,
      sleep: typeof seams.sleep === 'function' ? seams.sleep : null,
      exists: typeof seams.exists === 'function' ? seams.exists : (target) => existsSafe(fsModule, target),
    };
    this._logger = logger;
    this._paths = {
      stateDir: this.config.stateDir,
      runtimeDir: this.config.runtimeDir,
      urlFile: path.join(this.config.runtimeDir, 'current-url'),
      statusFile: path.join(this.config.runtimeDir, 'status.json'),
      knownGoodFile: path.join(this.config.stateDir, 'known-good.json'),
      attemptFile: path.join(this.config.stateDir, 'attempt.json'),
      runtimesDir: path.join(this.config.stateDir, 'runtimes'),
      uiProfileDir: path.join(this.config.stateDir, 'ui-profile'),
    };

    this._started = false;
    this._stopping = false;
    this._stopPromise = null;
    this._timers = new Set();
    this._runtimeBusy = false;
    this._runtimeRetryActive = false;
    this._retryToken = 0;
    this._promotionToken = 0;
    this._dshRestarts = [];
    this.currentRuntime = null;
    this._systemRuntime = null;
    this._knownGood = null;
    this._knownGoodDisabled = false;
    this._lastVersion = null;
    this._uiChild = null;
    this._uiRetryActive = false;
    this._uiRetryToken = 0;
    this._uiRestarts = [];
    this._uiIntentionalExit = false;
  }

  get paths() {
    return { ...this._paths };
  }

  async start() {
    if (this._started) return this;
    this._started = true;
    this._ensureDirectories();
    this._setStatus('starting', 'host supervisor starting');
    await this._recoverRuntime('startup');
    return this;
  }

  waitForStop() {
    if (this._stopPromise !== null) return this._stopPromise;
    return new Promise((resolve) => this.once('stopped', resolve));
  }

  async stop(reason = 'shutdown') {
    if (this._stopPromise !== null) return this._stopPromise;
    this._stopping = true;
    this._retryToken += 1;
    this._runtimeRetryActive = false;
    this._uiRetryToken += 1;
    this._uiRetryActive = false;
    for (const entry of this._timers) {
      clearTimeout(entry.handle);
      if (typeof entry.resolve === 'function') entry.resolve();
    }
    this._timers.clear();

    this._stopPromise = (async () => {
      try {
        await this._stopUi();
      } catch (error) {
        this._logger.warn(`host: error while stopping UI: ${error.message}`);
      }

      const record = this.currentRuntime;
      if (record !== null) {
        record.intentionalStop = true;
        this.currentRuntime = null;
        try {
          if (record.runtime && typeof record.runtime.isRunning === 'function' && record.runtime.isRunning()) {
            await record.runtime.stop();
          }
        } catch (error) {
          this._logger.warn(`host: error while stopping DSH runtime: ${error.message}`);
        }
      }

      this._removeUrlFile();
      this._setStatus('stopped', `host stopped: ${reason}`);
      this.emit('stopped');
    })();

    return this._stopPromise;
  }

  // ---------------------------------------------------------------------------
  // runtime lifecycle
  // ---------------------------------------------------------------------------

  async _recoverRuntime(reason) {
    if (this._stopping) return;
    if (this._runtimeBusy) {
      this._logger.debug('host: runtime recovery already in progress');
      return;
    }
    this._runtimeBusy = true;
    try {
      while (!this._stopping) {
        const decision = this._decideRuntime();
        if (decision.source === 'system' && decision.version === null) {
          this._logger.warn('host: no resolvable system DSH runtime and no known-good runtime');
          this._setStatus('error', 'no DSH runtime resolvable');
          break;
        }
        const record = this._buildRecord(decision);
        const result = await this._attemptRuntime(record);
        if (this._stopping) return;
        if (result.ok) {
          this._logger.info(
            `host: runtime ready (source=${record.source}, version=${record.version || 'unknown'}) at ${record.url}`,
          );
          return;
        }
        this._logger.warn(`host: runtime attempt failed (source=${record.source}): ${result.message}`);
        this._recordRuntimeFailure(record);
        if (record.source === 'system' && !this._knownGoodDisabled && this._knownGood !== null) {
          // Fall back immediately; the next loop iteration decides known-good.
          continue;
        }
        break;
      }
    } catch (error) {
      this._logger.error(`host: runtime recovery error: ${error && error.stack ? error.stack : error}`);
    } finally {
      this._runtimeBusy = false;
    }
    if (!this._stopping) this._scheduleRuntimeRetry(reason);
  }

  _decideRuntime() {
    const system = this._resolveSystemRuntime();
    this._systemRuntime = system;
    const knownGood = this._knownGoodDisabled ? null : this._readKnownGood();
    this._knownGood = knownGood;
    const attempt = this._readAttempt();
    const decision = decideRuntimeChoice({
      systemVersion: system.version,
      knownGood,
      attempt,
      now: this._now(),
      retryAfterMs: this.config.fallbackRetrySystemAfterMs,
    });
    if (decision.source === 'known-good') {
      this._logger.warn(`host: choosing known-good runtime ${decision.knownGood.version} (${decision.reason})`);
    }
    return decision;
  }

  _resolveSystemRuntime() {
    const command = this.config.dshCommand;
    let realEntry = command;
    if (typeof this._fs.realpathSync === 'function') {
      try {
        realEntry = this._fs.realpathSync(command);
      } catch {
        realEntry = command;
      }
    }
    const root = resolveRuntimeRootFromEntry(command, { fs: this._fs });
    const version = root ? runtimeVersion(root, { fs: this._fs }) : null;
    const entryRel = root ? relativeInside(root, realEntry) : DEFAULT_ENTRY_REL;
    const entry = root ? path.join(root, entryRel) : command;
    return { command, root, version, entry, entryRel };
  }

  _buildRecord(decision) {
    if (decision.source === 'known-good') {
      const knownGood = decision.knownGood;
      return {
        source: 'known-good',
        version: knownGood.version,
        root: knownGood.root,
        entry: knownGood.entry,
        entryRel: relativeInside(knownGood.root, knownGood.entry),
        runtime: null,
        url: null,
        ready: false,
        intentionalStop: false,
        promoted: false,
      };
    }
    const system = this._systemRuntime || this._resolveSystemRuntime();
    this._lastVersion = system.version || this._lastVersion;
    return {
      source: 'system',
      version: system.version,
      root: system.root,
      entry: system.entry,
      entryRel: system.entryRel,
      runtime: null,
      url: null,
      ready: false,
      intentionalStop: false,
      promoted: false,
    };
  }

  async _attemptRuntime(record) {
    const RuntimeClass = this.seams.HarnessRuntime;
    let runtime;
    try {
      runtime = new RuntimeClass({
        command: process.execPath,
        args: [record.entry, 'web', '--no-open', '--host', this.config.host, '--port', '0'],
        env: { ...this._env, DSH_HOME: this.config.dshHome },
        logger: this._logger,
        spawn: this.seams.spawn,
      });
    } catch (error) {
      return { ok: false, message: `could not construct HarnessRuntime: ${error.message}`, error };
    }
    if (runtime === null || typeof runtime.on !== 'function' || typeof runtime.start !== 'function') {
      return { ok: false, message: 'HarnessRuntime seam returned an invalid runtime' };
    }
    record.runtime = runtime;

    let settled = false;
    const readyOutcome = new Promise((resolve) => {
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      runtime.on('ready', (payload) => settle({ ok: true, payload }));
      runtime.on('fatal', (payload) => settle({
        ok: false,
        message: payload && payload.message ? payload.message : 'runtime fatal before ready',
        error: payload ? payload.error : undefined,
      }));
      runtime.on('exit', (payload) => settle({
        ok: false,
        message: `exited before ready (code=${payload ? payload.code : null}, signal=${payload ? payload.signal : null})`,
      }));
    });

    try {
      await runtime.start();
    } catch (error) {
      return { ok: false, message: `spawn failed: ${error.message}`, error };
    }

    const outcome = await this._withTimeout(
      readyOutcome,
      this.config.readyTimeoutMs,
      () => ({ ok: false, message: `ready timeout after ${this.config.readyTimeoutMs}ms` }),
    );

    if (!outcome.ok) {
      await this._stopRuntimeQuietly(record);
      return outcome;
    }
    const url = outcome.payload && typeof outcome.payload.url === 'string' ? outcome.payload.url : '';
    if (url.length === 0) {
      await this._stopRuntimeQuietly(record);
      return { ok: false, message: 'ready event did not carry a url' };
    }

    record.url = url;
    record.ready = true;
    this.currentRuntime = record;
    this._lastVersion = record.version || this._lastVersion;
    this._writeUrlFile(url);
    const state = record.source === 'known-good' ? 'fallback' : 'running';
    this._setStatus(state, this._runtimeStatusMessage(record));

    runtime.on('exit', (payload) => this._onRuntimeExit(record, payload));
    this._startHealthLoop(record);
    this._schedulePromotion(record);
    this._ensureUi();
    this.emit('runtime-ready', record);
    return { ok: true, record };
  }

  async _stopRuntimeQuietly(record) {
    record.intentionalStop = true;
    if (this.currentRuntime === record) this.currentRuntime = null;
    const runtime = record.runtime;
    if (runtime === null || runtime === undefined) return;
    try {
      if (typeof runtime.isRunning === 'function' && runtime.isRunning() && typeof runtime.stop === 'function') {
        await runtime.stop();
      }
    } catch (error) {
      this._logger.warn(`host: error stopping failed runtime: ${error.message}`);
    }
  }

  _onRuntimeExit(record, payload) {
    if (this._stopping) return;
    if (record.intentionalStop || this.currentRuntime !== record) return;
    this.currentRuntime = null;
    this._removeUrlFile();
    this._recordRuntimeFailure(record);
    this.emit('runtime-exit', payload);
    this._scheduleRuntimeRetry(
      `runtime exited (code=${payload ? payload.code : null}, signal=${payload ? payload.signal : null})`,
    );
  }

  _recordRuntimeFailure(record) {
    if (record.source === 'system' && typeof record.version === 'string' && record.version.length > 0) {
      const previous = this._readAttempt();
      const failureCount =
        previous && previous.systemVersion === record.version ? (Number(previous.failureCount) || 0) + 1 : 1;
      this._writeAttempt({
        systemVersion: record.version,
        failedAt: this._now(),
        failureCount,
      });
    } else if (record.source === 'known-good') {
      this._knownGoodDisabled = true;
      this._logger.warn('host: known-good runtime failed; disabling it for this supervisor run');
    }
  }

  _scheduleRuntimeRetry(reason) {
    if (this._stopping || this._runtimeRetryActive) return;
    this._runtimeRetryActive = true;
    const now = this._now();
    const windowMs = this.config.restartWindowMs;
    this._dshRestarts = this._dshRestarts.filter((timestamp) => now - timestamp >= 0 && now - timestamp < windowMs);
    const plan = planChildRestart({
      timestamps: this._dshRestarts,
      now,
      maxRestarts: this.config.maxChildRestarts,
      windowMs,
    });
    const delayMs = plan.allowed ? plan.delayMs : EXHAUSTED_RETRY_MS;
    if (plan.allowed) this._dshRestarts.push(now);
    this._setStatus(
      'error',
      plan.allowed
        ? `${reason}; DSH restart in ${delayMs}ms`
        : `${reason}; DSH restart budget exhausted, retrying in ${delayMs}ms`,
    );
    const token = ++this._retryToken;
    this._sleep(delayMs)
      .then(() => {
        this._runtimeRetryActive = false;
        if (this._stopping || token !== this._retryToken) return;
        this._recoverRuntime('retry').catch((error) => {
          this._logger.error(`host: scheduled runtime recovery failed: ${error.message}`);
        });
      })
      .catch((error) => {
        this._runtimeRetryActive = false;
        this._logger.error(`host: runtime retry timer failed: ${error.message}`);
      });
  }

  // ---------------------------------------------------------------------------
  // health + promotion
  // ---------------------------------------------------------------------------

  _startHealthLoop(record) {
    const loop = async () => {
      let failures = 0;
      while (!this._stopping && this.currentRuntime === record) {
        await this._sleep(Math.max(10, this.config.healthIntervalMs));
        if (this._stopping || this.currentRuntime !== record) return;
        try {
          await this.seams.waitForHealth(record.url, {
            timeoutMs: Math.max(1000, Math.min(15000, this.config.healthIntervalMs)),
          });
          failures = 0;
        } catch (error) {
          failures += 1;
          this._logger.warn(
            `host: health check failed (${failures}/${this.config.healthFailureThreshold}): ${error.message}`,
          );
          if (failures >= this.config.healthFailureThreshold) {
            await this._handleUnhealthyRuntime(record, failures);
            return;
          }
        }
      }
    };
    loop().catch((error) => this._logger.error(`host: health loop error: ${error.message}`));
  }

  async _handleUnhealthyRuntime(record, failures) {
    if (this._stopping || this.currentRuntime !== record) return;
    this._setStatus('error', `runtime unhealthy (${failures} consecutive health failures); switching`);
    record.intentionalStop = true;
    this.currentRuntime = null;
    this._removeUrlFile();
    await this._stopRuntimeQuietly(record);
    this._recordRuntimeFailure(record);
    this.emit('runtime-unhealthy', record);
    // Same fallback decision as a startup failure; _recoverRuntime falls back to
    // known-good immediately and only schedules backoff if every candidate fails.
    await this._recoverRuntime('unhealthy-runtime');
  }

  _schedulePromotion(record) {
    if (this.config.snapshotEnabled === false) {
      this._logger.debug('host: snapshot promotion disabled by config');
      return;
    }
    if (record.source !== 'system' || typeof record.root !== 'string' || record.root.length === 0) return;
    if (typeof record.version !== 'string' || record.version.length === 0) return;

    const token = ++this._promotionToken;
    const delayMs = Math.max(0, Number(this.config.stableSecondsForPromotion) * 1000);
    this._sleep(delayMs)
      .then(async () => {
        if (
          this._stopping ||
          token !== this._promotionToken ||
          this.currentRuntime !== record ||
          record.runtime === null ||
          typeof record.runtime.isRunning !== 'function' ||
          !record.runtime.isRunning()
        ) {
          return;
        }
        try {
          const result = await promoteSnapshot({
            root: record.root,
            version: record.version,
            entryRel: record.entryRel || DEFAULT_ENTRY_REL,
            runtimesDir: this._paths.runtimesDir,
            knownGoodFile: this._paths.knownGoodFile,
            fs: this._fs,
            spawn: this.seams.spawn,
            now: this.seams.now,
            logger: this._logger,
          });
          record.promoted = true;
          this._knownGood = result.record;
          this._knownGoodDisabled = false;
          this._clearAttempt();
          this.emit('runtime-promoted', result);
          this._logger.info(`host: snapshot promoted (${result.copied ? 'copied' : 'reused'}) for ${result.record.version}`);
        } catch (error) {
          this._logger.warn(`host: snapshot promotion failed: ${error.message}`);
        }
      })
      .catch((error) => this._logger.warn(`host: promotion scheduling failed: ${error.message}`));
  }

  // ---------------------------------------------------------------------------
  // UI lifecycle
  // ---------------------------------------------------------------------------

  _ensureUi() {
    if (this._stopping || this._uiIntentionalExit) return;
    if (this._uiChild !== null) return;

    const launch = resolveElectronLaunch({
      config: this.config,
      env: this._env,
      exists: this.seams.exists,
      platform: process.platform,
    });
    if (launch === null) {
      this._logger.warn('host: Electron executable not found');
      this._scheduleUiRetry('Electron executable not found');
      return;
    }

    const display = discoverDisplayEnvironment({ env: this._env, fs: this._fs, uid: this._uid });
    const env = { ...this._env };
    env.DSH_ELECTRON_ATTACH_URL_FILE = this._paths.urlFile;
    env.DSH_ELECTRON_USER_DATA = this._paths.uiProfileDir;
    if (display.waylandDisplay && !env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = display.waylandDisplay;
    if (display.display && !env.DISPLAY) env.DISPLAY = display.display;
    const args = launch.args.concat([`--attach-url-file=${this._paths.urlFile}`]);

    let child;
    try {
      child = this.seams.spawn(launch.command, args, {
        env,
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      this._logger.error(`host: UI spawn failed: ${error.message}`);
      this._scheduleUiRetry(`UI spawn failed: ${error.message}`);
      return;
    }
    if (child === null || typeof child !== 'object' || typeof child.once !== 'function') {
      this._logger.error('host: spawn seam did not return a UI child process');
      this._scheduleUiRetry('UI spawn failed');
      return;
    }

    this._uiChild = child;
    child.once('error', (error) => this._handleUiExit(child, null, null, error));
    child.once('exit', (code, signal) => this._handleUiExit(child, code, signal, null));
    child.once('close', (code, signal) => this._handleUiExit(child, code, signal, null));
    this.emit('ui-started', { command: launch.command, args, env, source: launch.source, child });
    this._logger.info(`host: UI spawned (${launch.source}, pid=${child.pid === undefined ? 'unknown' : child.pid})`);
    if (this.currentRuntime !== null) {
      const state = this.currentRuntime.source === 'known-good' ? 'fallback' : 'running';
      this._setStatus(state, this._runtimeStatusMessage(this.currentRuntime));
    }
  }

  _handleUiExit(child, code, signal, error) {
    if (child !== this._uiChild) return;
    this._uiChild = null;
    if (this._stopping) return;
    this.emit('ui-exit', { code, signal, error });

    const intentional = error === null && signal === null && code === 0;
    if (intentional) {
      this._uiIntentionalExit = true;
      this._logger.info('host: UI exited intentionally (code 0); not restarting');
      return;
    }
    const reason = error ? `UI failed: ${error.message}` : `UI exited (code=${code}, signal=${signal})`;
    this._logger.warn(`host: ${reason}`);
    this._scheduleUiRetry(reason);
  }

  _scheduleUiRetry(reason) {
    if (this._stopping || this._uiRetryActive) return;
    this._uiRetryActive = true;
    const now = this._now();
    const windowMs = this.config.restartWindowMs;
    this._uiRestarts = this._uiRestarts.filter((timestamp) => now - timestamp >= 0 && now - timestamp < windowMs);
    const plan = planChildRestart({
      timestamps: this._uiRestarts,
      now,
      maxRestarts: this.config.maxChildRestarts,
      windowMs,
    });
    const delayMs = plan.allowed ? plan.delayMs : EXHAUSTED_RETRY_MS;
    if (plan.allowed) this._uiRestarts.push(now);
    this._setStatus(
      'ui-error',
      plan.allowed
        ? `${reason}; UI restart in ${delayMs}ms`
        : `${reason}; UI restart budget exhausted, retrying in ${delayMs}ms`,
    );
    const token = ++this._uiRetryToken;
    this._sleep(delayMs)
      .then(() => {
        this._uiRetryActive = false;
        if (this._stopping || token !== this._uiRetryToken) return;
        this._ensureUi();
      })
      .catch((error) => {
        this._uiRetryActive = false;
        this._logger.error(`host: UI retry timer failed: ${error.message}`);
      });
  }

  async _stopUi() {
    this._uiRetryToken += 1;
    this._uiRetryActive = false;
    const child = this._uiChild;
    this._uiChild = null;
    if (child === null) return;
    const alreadyGone =
      (child.exitCode !== undefined && child.exitCode !== null) ||
      (child.signalCode !== undefined && child.signalCode !== null);
    if (alreadyGone) return;

    let exited = false;
    const exitPromise =
      typeof child.once === 'function'
        ? new Promise((resolve) => {
            const finish = () => {
              exited = true;
              resolve();
            };
            child.once('exit', finish);
            child.once('error', finish);
          })
        : Promise.resolve();

    try {
      child.kill('SIGTERM');
    } catch (error) {
      this._logger.warn(`host: failed to send UI SIGTERM: ${error.message}`);
    }
    const timeoutPromise = new Promise((resolve) => {
      const timer = setTimeout(resolve, UI_KILL_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    await Promise.race([exitPromise, timeoutPromise]);
    if (!exited) {
      this._logger.warn('host: UI did not exit after SIGTERM; sending SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch (error) {
        this._logger.warn(`host: failed to send UI SIGKILL: ${error.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // files, status, timers
  // ---------------------------------------------------------------------------

  _ensureDirectories() {
    for (const dir of [this._paths.stateDir, this._paths.runtimeDir, this._paths.runtimesDir, this._paths.uiProfileDir]) {
      mkdirSyncSafe(this._fs, dir, 0o700);
      try {
        if (typeof this._fs.chmodSync === 'function') this._fs.chmodSync(dir, 0o700);
      } catch {
        // Best-effort only.
      }
    }
  }

  _writeUrlFile(url) {
    try {
      writeUrlFileAtomic(this._paths.urlFile, url, { fs: this._fs, mode: 0o600 });
      this.emit('url-file', url);
    } catch (error) {
      this._logger.error(`host: could not write URL file: ${error.message}`);
    }
  }

  _removeUrlFile() {
    try {
      if (typeof this._fs.rmSync === 'function') this._fs.rmSync(this._paths.urlFile, { force: true });
      else if (typeof this._fs.unlinkSync === 'function') this._fs.unlinkSync(this._paths.urlFile);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        this._logger.warn(`host: could not remove URL file: ${error.message}`);
      }
    }
  }

  _readKnownGood() {
    const parsed = readJsonFile(this._paths.knownGoodFile, { fs: this._fs, fallback: null });
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'string' ||
      typeof parsed.root !== 'string' ||
      typeof parsed.entry !== 'string'
    ) {
      return null;
    }
    return parsed;
  }

  _readAttempt() {
    const parsed = readJsonFile(this._paths.attemptFile, { fs: this._fs, fallback: null });
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed;
  }

  _writeAttempt(attempt) {
    try {
      writeAtomic(this._paths.attemptFile, JSON.stringify(attempt), { fs: this._fs, mode: 0o600 });
    } catch (error) {
      this._logger.warn(`host: could not write attempt state: ${error.message}`);
    }
  }

  _clearAttempt() {
    try {
      const target = this._paths.attemptFile;
      if (typeof this._fs.rmSync === 'function') this._fs.rmSync(target, { force: true });
      else if (typeof this._fs.unlinkSync === 'function') this._fs.unlinkSync(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') this._logger.warn(`host: could not clear attempt state: ${error.message}`);
    }
  }

  /** Human-readable status message that survives UI (re)spawns. */
  _runtimeStatusMessage(record) {
    if (record === null || record === undefined) return 'runtime ready';
    if (record.source === 'known-good') {
      const attempt = this._readAttempt();
      const systemVersion =
        (this._systemRuntime && typeof this._systemRuntime.version === 'string' ? this._systemRuntime.version : null) ||
        (attempt && typeof attempt.systemVersion === 'string' ? attempt.systemVersion : null);
      const suffix = systemVersion ? ` (system ${systemVersion} failed)` : ' (system runtime unavailable)';
      return `Running from known-good fallback ${record.version || 'unknown'}${suffix}`;
    }
    return `Running from system runtime ${record.version || 'unknown'}`;
  }

  _setStatus(state, message) {
    const record = this.currentRuntime;
    const status = {
      state,
      message: message || '',
      dshVersion: record && record.version ? record.version : this._lastVersion,
      runtimeSource: record ? record.source : null,
      updatedAt: new Date(this._now()).toISOString(),
    };
    try {
      writeStatusAtomic(this._paths.statusFile, status, { fs: this._fs, mode: 0o600 });
    } catch (error) {
      this._logger.warn(`host: could not write status file: ${error.message}`);
    }
    this.emit('status', status);
    return status;
  }

  _now() {
    return this.seams.now();
  }

  _sleep(ms) {
    if (this.seams.sleep) return this.seams.sleep(ms);
    return this._wait(ms);
  }

  _setTimeout(fn, ms) {
    if (this._stopping) return null;
    const entry = { handle: null, resolve: null, cancel: null };
    entry.handle = setTimeout(() => {
      this._timers.delete(entry);
      fn();
    }, ms);
    entry.cancel = () => {
      clearTimeout(entry.handle);
      this._timers.delete(entry);
    };
    this._timers.add(entry);
    return entry;
  }

  _clearTimeout(entry) {
    if (entry && typeof entry.cancel === 'function') entry.cancel();
  }

  _wait(ms) {
    if (this._stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { handle: null, resolve: null, cancel: null };
      entry.handle = setTimeout(() => {
        this._timers.delete(entry);
        resolve();
      }, ms);
      entry.resolve = () => {
        clearTimeout(entry.handle);
        this._timers.delete(entry);
        resolve();
      };
      entry.cancel = entry.resolve;
      this._timers.add(entry);
    });
  }

  _withTimeout(promise, ms, timeoutFactory) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this._setTimeout(() => finish(timeoutFactory()), ms);
      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) timer.cancel();
        resolve(value);
      }
      if (timer === null) {
        finish(timeoutFactory());
        return;
      }
      promise.then(finish, (error) =>
        finish({ ok: false, message: error && error.message ? error.message : String(error), error }),
      );
    });
  }
}

/**
 * Build and run a supervisor, install process signal handlers, and resolve when
 * the supervisor has stopped.
 */
async function run(config = {}, seams = {}) {
  const supervisor = new HostSupervisor(config, seams);
  const stopped = new Promise((resolve) => supervisor.once('stopped', resolve));
  const onSignal = (signal) => {
    supervisor.stop(signal).catch((error) => {
      supervisor._logger.error(`host: shutdown after ${signal} failed: ${error.message}`);
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    await supervisor.start();
  } catch (error) {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    await supervisor.stop('startup-error').catch(() => {});
    throw error;
  }

  try {
    await stopped;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
  return supervisor;
}

if (require.main === module) {
  const { loadConfig } = require('./config');
  const config = loadConfig({ env: process.env });
  run(config).then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      // CLI entry point only; modules use the injected logger.
      process.stderr.write(`dsh-host: fatal: ${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  HostSupervisor,
  decideRuntimeChoice,
  discoverDisplayEnvironment,
  planChildRestart,
  promoteSnapshot,
  pruneSnapshots,
  readJsonFile,
  readUrlFile,
  resolveElectronLaunch,
  resolveRuntimeRootFromEntry,
  run,
  runtimeVersion,
  writeAtomic,
  writeStatusAtomic,
  writeUrlFileAtomic,
};
