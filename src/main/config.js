/**
 * config: user configuration for the Electron shell.
 *
 * Resolution order for each setting is CLI > app env (DSH_ELECTRON_*) >
 * <userDataDir>/config.json > built-in defaults. The config file is written
 * atomically (tmp+rename). GPU fallback state lives in gpu-fallback.json and
 * is surfaced on the returned frozen config object.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultGpuFallbackState, loadGpuFallbackState } = require('./gpu-fallback');

const DEFAULT_CONFIG_FILE = 'config.json';
const DEFAULT_HOST = '127.0.0.1';
const MAX_PORT = 65535;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/** Read the file only for known keys; ignores unknown/invalid values. */
function pickConfigFileValues(raw) {
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const dshCommand = nonEmptyString(raw.dshCommand);
  if (typeof raw.dshCommand === 'string') out.dshCommand = dshCommand;
  const dshHome = nonEmptyString(raw.dshHome);
  if (typeof raw.dshHome === 'string') out.dshHome = dshHome;
  if (raw.runtimeMode === 'managed' || raw.runtimeMode === 'attach') {
    out.runtimeMode = raw.runtimeMode;
  }
  const attachUrl = nonEmptyString(raw.attachUrl);
  if (typeof raw.attachUrl === 'string') out.attachUrl = attachUrl;
  const attachUrlFile = nonEmptyString(raw.attachUrlFile);
  if (typeof raw.attachUrlFile === 'string') out.attachUrlFile = attachUrlFile;
  const host = nonEmptyString(raw.host);
  if (host) out.host = host;
  if (Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= MAX_PORT) {
    out.port = raw.port;
  }
  if (typeof raw.closeToTray === 'boolean') out.closeToTray = raw.closeToTray;
  if (typeof raw.showDevTools === 'boolean') out.showDevTools = raw.showDevTools;
  if (Array.isArray(raw.extraSwitches)) {
    out.extraSwitches = raw.extraSwitches
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return out;
}

/**
 * First existing dsh executable, or the bare name for PATH lookup at spawn.
 * @param {{env?: object, homedir?: string, existsSync?: Function}} options
 */
function resolveDshCommand({ env = process.env, homedir = os.homedir(), existsSync } = {}) {
  const exists = typeof existsSync === 'function' ? existsSync : fs.existsSync;
  const candidates = [
    path.join(homedir, '.npm-global', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ];
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Ignore an unreadable candidate and keep searching.
    }
  }
  return 'dsh';
}

/** Parse the documented CLI overrides; unknown arguments are ignored. */
function parseCliOverrides(argv = []) {
  const out = {};
  const args = Array.isArray(argv) ? argv : [];
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    index += 1;
    if (typeof token !== 'string' || !token.startsWith('--')) continue;

    const body = token.slice(2);
    const equalsAt = body.indexOf('=');
    const name = equalsAt >= 0 ? body.slice(0, equalsAt) : body;
    let value = equalsAt >= 0 ? body.slice(equalsAt + 1) : null;

    if (value === null && (name === 'dsh-home' || name === 'dsh-command' || name === 'port' || name === 'attach-url' || name === 'attach-url-file')) {
      const next = args[index];
      if (typeof next === 'string' && !next.startsWith('--')) {
        value = next;
        index += 1;
      }
    }

    switch (name) {
      case 'dev':
        out.showDevTools = true;
        break;
      case 'no-tray':
        out.closeToTray = false;
        break;
      case 'dsh-home':
        if (value !== null && value.trim().length > 0) out.dshHome = value.trim();
        break;
      case 'dsh-command':
        if (value !== null && value.trim().length > 0) out.dshCommand = value.trim();
        break;
      case 'attach-url':
        if (value !== null && value.trim().length > 0) out.attachUrl = value.trim();
        break;
      case 'attach-url-file':
        if (value !== null && value.trim().length > 0) out.attachUrlFile = value.trim();
        break;
      case 'port': {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PORT) out.port = parsed;
        break;
      }
      default:
        break;
    }
  }

  return out;
}

function resolveConfigPath({ userDataDir, env = process.env } = {}) {
  const explicit = nonEmptyString(env.DSH_ELECTRON_CONFIG);
  if (explicit) return path.resolve(explicit);
  if (userDataDir) return path.join(userDataDir, DEFAULT_CONFIG_FILE);
  return null;
}

function readConfigFile(configPath, readFileSync) {
  if (!configPath) return {};
  try {
    return pickConfigFileValues(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * Load the frozen effective configuration.
 *
 * @param {{
 *   argv?: string[],
 *   userDataDir?: string|null,
 *   env?: object,
 *   homedir?: string,
 *   existsSync?: Function,
 *   readFileSync?: Function
 * }} options
 */
function loadConfig({
  argv = [],
  userDataDir,
  env = process.env,
  homedir = os.homedir(),
  existsSync,
  readFileSync,
} = {}) {
  const resolvedUserDataDir = userDataDir || nonEmptyString(env.DSH_ELECTRON_USER_DATA) || null;
  const configPath = resolveConfigPath({ userDataDir: resolvedUserDataDir, env });
  const fileValues = readConfigFile(
    configPath,
    typeof readFileSync === 'function' ? readFileSync : fs.readFileSync,
  );
  const cli = parseCliOverrides(argv);

  const envDshHome = nonEmptyString(env.DSH_ELECTRON_HOME);
  const genericDshHome = nonEmptyString(env.DSH_HOME);
  const defaultDshHome = genericDshHome || path.join(homedir, '.dsh');

  const dshHome = cli.dshHome
    || envDshHome
    || nonEmptyString(fileValues.dshHome)
    || defaultDshHome;

  const commandSetting = cli.dshCommand !== undefined
    ? cli.dshCommand
    : nonEmptyString(fileValues.dshCommand);
  const dshCommand = commandSetting
    || resolveDshCommand({ env, homedir, existsSync });

  let attachUrl = cli.attachUrl !== undefined ? cli.attachUrl : nonEmptyString(fileValues.attachUrl);
  const attachUrlFile = cli.attachUrlFile !== undefined
    ? cli.attachUrlFile
    : (nonEmptyString(env.DSH_ELECTRON_ATTACH_URL_FILE) || nonEmptyString(fileValues.attachUrlFile));
  let runtimeMode = 'managed';
  if (attachUrlFile) {
    // URL-file handoff always selects attach mode; the Electron shell must
    // never spawn its own DSH child in this mode.
    runtimeMode = 'attach';
  } else if (cli.attachUrl !== undefined) {
    // An explicit --attach-url always selects attach mode.
    runtimeMode = attachUrl ? 'attach' : 'managed';
  } else if (fileValues.runtimeMode === 'attach') {
    runtimeMode = 'attach';
  } else if (fileValues.runtimeMode === 'managed') {
    // Explicit managed mode ignores any stray attachUrl in config.json.
    runtimeMode = 'managed';
    attachUrl = '';
  } else if (attachUrl) {
    runtimeMode = 'attach';
  }

  const config = {
    dshCommand,
    dshHome,
    runtimeMode,
    attachUrl,
    attachUrlFile,
    host: nonEmptyString(fileValues.host) || DEFAULT_HOST,
    port: cli.port !== undefined ? cli.port : (fileValues.port !== undefined ? fileValues.port : 0),
    closeToTray: cli.closeToTray !== undefined ? cli.closeToTray : (fileValues.closeToTray !== undefined ? fileValues.closeToTray : true),
    showDevTools: cli.showDevTools !== undefined ? cli.showDevTools : (fileValues.showDevTools === true),
    extraSwitches: Object.freeze([...(fileValues.extraSwitches || [])]),
    gpuFallback: Object.freeze(
      loadGpuFallbackState(resolvedUserDataDir) || defaultGpuFallbackState(),
    ),
  };

  return Object.freeze(config);
}

function serializeConfig(config) {
  return {
    dshCommand: config.dshCommand,
    dshHome: config.dshHome,
    runtimeMode: config.runtimeMode,
    attachUrl: config.attachUrl,
    attachUrlFile: typeof config.attachUrlFile === 'string' ? config.attachUrlFile : '',
    host: config.host,
    port: config.port,
    closeToTray: config.closeToTray,
    showDevTools: config.showDevTools === true,
    extraSwitches: [...(config.extraSwitches || [])],
  };
}

/**
 * Atomically write <userDataDir>/config.json (or DSH_ELECTRON_CONFIG).
 * @returns {string} the written path
 */
function saveConfig(userDataDir, config, deps = {}) {
  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env;
  const configPath = deps.configPath || resolveConfigPath({ userDataDir, env });
  if (!configPath) throw new TypeError('saveConfig requires userDataDir or DSH_ELECTRON_CONFIG');
  if (config === null || typeof config !== 'object') {
    throw new TypeError('saveConfig requires a config object');
  }

  const payload = `${JSON.stringify(serializeConfig(config), null, 2)}\n`;
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fsImpl.renameSync(tmpPath, configPath);
  } catch (error) {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; surface the original error.
    }
    throw error;
  }
  return configPath;
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  DEFAULT_HOST,
  loadConfig,
  saveConfig,
  resolveDshCommand,
  parseCliOverrides,
  resolveConfigPath,
  serializeConfig,
};
