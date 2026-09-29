/**
 * config: pure configuration resolution for the v0.2 host supervisor.
 *
 * Order: built-in defaults + env-derived paths < <stateDir>/config.json < env
 * overrides < explicit overrides. No Electron imports, no side effects beyond
 * reading the config file when loadConfig() is called.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE_NAME = 'config.json';

const DEFAULTS = Object.freeze({
  dshCommand: '',
  dshHome: '',
  stateDir: '',
  runtimeDir: '',
  electronExecutable: '',
  electronAppPath: '',
  electronArgs: [],
  host: '127.0.0.1',
  readyTimeoutMs: 30000,
  healthIntervalMs: 30000,
  healthFailureThreshold: 3,
  stableSecondsForPromotion: 15,
  restartWindowMs: 300000,
  maxChildRestarts: 5,
  fallbackRetrySystemAfterMs: 86400000,
  // Snapshots of a working system runtime are only useful when the runtime is
  // small enough to copy; E2E runs against the real DSH (~495MB) disable this
  // and still exercise fallback by pre-seeding known-good.json.
  snapshotEnabled: true,
});

const STRING_KEYS = [
  'dshCommand',
  'dshHome',
  'stateDir',
  'runtimeDir',
  'electronExecutable',
  'electronAppPath',
  'host',
];

const NUMBER_KEYS = [
  'readyTimeoutMs',
  'healthIntervalMs',
  'healthFailureThreshold',
  'stableSecondsForPromotion',
  'restartWindowMs',
  'maxChildRestarts',
  'fallbackRetrySystemAfterMs',
];

const NUMBER_LIMITS = Object.freeze({
  readyTimeoutMs: { min: 1, integer: true },
  healthIntervalMs: { min: 1, integer: true },
  healthFailureThreshold: { min: 1, integer: true },
  stableSecondsForPromotion: { min: 0, integer: false },
  restartWindowMs: { min: 1, integer: true },
  maxChildRestarts: { min: 0, integer: true },
  fallbackRetrySystemAfterMs: { min: 0, integer: true },
});

const ENV_STRING_KEYS = Object.freeze({
  DSH_HOST_STATE_DIR: 'stateDir',
  DSH_HOST_RUNTIME_DIR: 'runtimeDir',
  DSH_HOME: 'dshHome',
  DSH_HOST_ELECTRON: 'electronExecutable',
  DSH_HOST_DSH_COMMAND: 'dshCommand',
  DSH_HOST_HOST: 'host',
});

const ENV_NUMBER_KEYS = Object.freeze({
  DSH_HOST_READY_TIMEOUT_MS: 'readyTimeoutMs',
  DSH_HOST_HEALTH_INTERVAL_MS: 'healthIntervalMs',
  DSH_HOST_HEALTH_FAILURE_THRESHOLD: 'healthFailureThreshold',
  DSH_HOST_STABLE_SECONDS: 'stableSecondsForPromotion',
  DSH_HOST_RESTART_WINDOW_MS: 'restartWindowMs',
  DSH_HOST_MAX_CHILD_RESTARTS: 'maxChildRestarts',
  DSH_HOST_FALLBACK_RETRY_AFTER_MS: 'fallbackRetrySystemAfterMs',
});

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function coerceNumber(value, key) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const limits = NUMBER_LIMITS[key] || { min: 0, integer: false };
  if (limits.integer && !Number.isInteger(number)) return undefined;
  if (number < limits.min) return undefined;
  return number;
}

function defaultDirs({ env = process.env, homedir = os.homedir(), uid } = {}) {
  const stateBase = nonEmptyString(env.XDG_STATE_HOME) || path.join(homedir, '.local', 'state');
  const effectiveUid = uid === undefined && typeof process.getuid === 'function' ? process.getuid() : uid;
  const runtimeBase =
    nonEmptyString(env.XDG_RUNTIME_DIR) ||
    (effectiveUid !== undefined ? path.join('/run/user', String(effectiveUid)) : path.join(homedir, '.cache'));
  return {
    stateDir: path.join(stateBase, 'dsh-host'),
    runtimeDir: path.join(runtimeBase, 'dsh-host'),
    dshHome: nonEmptyString(env.DSH_HOME) || path.join(homedir, '.dsh'),
  };
}

/**
 * First existing dsh executable, or the bare name for PATH lookup at spawn time.
 * Mirrors src/main/config.js resolveDshCommand so the host stays self-contained.
 */
function resolveDshCommand({ env = process.env, homedir = os.homedir(), existsSync } = {}) {
  const exists = typeof existsSync === 'function' ? existsSync : fs.existsSync;
  const fromEnv = nonEmptyString(env.DSH_HOST_DSH_COMMAND);
  if (fromEnv) return fromEnv;
  const candidates = [
    path.join(homedir, '.npm-global', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ];
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Ignore unreadable candidates and keep searching.
    }
  }
  return 'dsh';
}

function pickKnownValues(raw) {
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const key of STRING_KEYS) {
    if (typeof raw[key] === 'string') out[key] = nonEmptyString(raw[key]);
  }
  if (Array.isArray(raw.electronArgs)) {
    out.electronArgs = raw.electronArgs
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  for (const key of NUMBER_KEYS) {
    const value = coerceNumber(raw[key], key);
    if (value !== undefined) out[key] = value;
  }
  if (typeof raw.snapshotEnabled === 'boolean') out.snapshotEnabled = raw.snapshotEnabled;
  return out;
}

function applyEnv(config, env) {
  const out = { ...config };
  for (const [envKey, configKey] of Object.entries(ENV_STRING_KEYS)) {
    const value = nonEmptyString(env[envKey]);
    if (value) out[configKey] = value;
  }
  for (const [envKey, configKey] of Object.entries(ENV_NUMBER_KEYS)) {
    const value = coerceNumber(env[envKey], configKey);
    if (value !== undefined) out[configKey] = value;
  }
  const appPath = nonEmptyString(env.DSH_HOST_ELECTRON_APP) || nonEmptyString(env.DSH_HOST_APP_ROOT);
  if (appPath) out.electronAppPath = appPath;
  const disableSnapshot = nonEmptyString(env.DSH_HOST_DISABLE_SNAPSHOT).toLowerCase();
  const snapshotFlag = nonEmptyString(env.DSH_HOST_SNAPSHOT).toLowerCase();
  if (disableSnapshot === '1' || disableSnapshot === 'true') out.snapshotEnabled = false;
  else if (snapshotFlag === '0' || snapshotFlag === 'false') out.snapshotEnabled = false;
  else if (snapshotFlag === '1' || snapshotFlag === 'true') out.snapshotEnabled = true;
  return out;
}

function readJsonObject(filePath, fsModule) {
  try {
    const raw = fsModule.readFileSync(filePath, 'utf8');
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Fill defaults and coerce a partial config object. The returned object is a
 * plain, fully populated config (paths and command resolved).
 */
function normalizeConfig(config = {}, options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const fsModule = options.fs || fs;
  const uid = options.uid;
  const dirs = defaultDirs({ env, homedir, uid });
  const raw = config !== null && typeof config === 'object' ? config : {};
  const picked = pickKnownValues(raw);

  const out = {
    dshCommand: picked.dshCommand || '',
    dshHome: picked.dshHome || dirs.dshHome,
    stateDir: picked.stateDir || dirs.stateDir,
    runtimeDir: picked.runtimeDir || dirs.runtimeDir,
    electronExecutable: picked.electronExecutable || '',
    electronAppPath: picked.electronAppPath || '',
    electronArgs: picked.electronArgs || [],
    host: picked.host || DEFAULTS.host,
  };
  for (const key of NUMBER_KEYS) {
    const value = coerceNumber(picked[key], key);
    out[key] = value === undefined ? DEFAULTS[key] : value;
  }
  if (typeof picked.snapshotEnabled === 'boolean') {
    out.snapshotEnabled = picked.snapshotEnabled;
  } else {
    const disableSnapshot = nonEmptyString(env.DSH_HOST_DISABLE_SNAPSHOT).toLowerCase();
    const snapshotFlag = nonEmptyString(env.DSH_HOST_SNAPSHOT).toLowerCase();
    if (disableSnapshot === '1' || disableSnapshot === 'true') out.snapshotEnabled = false;
    else if (snapshotFlag === '0' || snapshotFlag === 'false') out.snapshotEnabled = false;
    else if (snapshotFlag === '1' || snapshotFlag === 'true') out.snapshotEnabled = true;
    else out.snapshotEnabled = DEFAULTS.snapshotEnabled;
  }

  if (!out.dshCommand) {
    const existsSync =
      fsModule && typeof fsModule.existsSync === 'function' ? (candidate) => fsModule.existsSync(candidate) : undefined;
    out.dshCommand = resolveDshCommand({ env, homedir, existsSync });
  }

  return out;
}

/**
 * Resolve production config: defaults + <stateDir>/config.json + env overrides
 * + optional explicit overrides.
 */
function loadConfig(options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const fsModule = options.fs || fs;
  const uid = options.uid;

  const base = normalizeConfig({}, { env, homedir, fs: fsModule, uid });
  const envStateDir = nonEmptyString(env.DSH_HOST_STATE_DIR);
  const stateDir = envStateDir || base.stateDir;
  const configPath = nonEmptyString(options.configPath) || path.join(stateDir, CONFIG_FILE_NAME);
  const fileValues = pickKnownValues(readJsonObject(configPath, fsModule));

  let merged = { ...base, ...fileValues };
  merged = applyEnv(merged, env);
  merged = { ...merged, ...pickKnownValues(options.overrides || {}) };
  return normalizeConfig(merged, { env, homedir, fs: fsModule, uid });
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULTS,
  defaultDirs,
  loadConfig,
  normalizeConfig,
  resolveDshCommand,
};
