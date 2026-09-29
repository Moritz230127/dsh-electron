/**
 * smoke-lib: independent acceptance smoke driver for DSH Electron.
 *
 * Starts the real app (source `electron .` or a packaged binary) with a
 * temporary HOME, DSH_HOME, Electron userData and XDG dirs, waits for the
 * DSH_ELECTRON_SMOKE JSON snapshot, then asserts the app exits cleanly and no
 * `dsh web` child leaks. It never points at the live ~/.dsh or the running
 * dsh-web.service: the temporary DSH_HOME is a unique mkdtemp path and the
 * spawned child is identified by its DSH_HOME *environment*, not by argv.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_APP_EXIT_TIMEOUT_MS = 30000;
const POLL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Find an absolute dsh executable: HOME candidates first, then PATH. */
function findDshCommand({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const candidates = [
    path.join(home, '.npm-global', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'dsh'));
  }
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error('dsh executable not found in HOME or PATH; pass --dsh-command=<path>');
}

function getElectronBinary() {
  try {
    const value = require('electron');
    const binary = typeof value === 'string' ? value : null;
    if (binary && isExecutable(binary)) return binary;
  } catch {
    // fall through to the explicit message
  }
  throw new Error('local Electron binary not found; run npm install/scripts/ensure-electron.js');
}

function runtimeDirFor(env) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return `/run/user/${uid}`;
}

function discoverWaylandDisplay(runtimeDir, env = {}) {
  if (env.WAYLAND_DISPLAY) return env.WAYLAND_DISPLAY;
  try {
    const matches = fs.readdirSync(runtimeDir).filter((name) => /^wayland-\d+$/.test(name)).sort();
    if (matches.length > 0) return matches[0];
  } catch {
    // fall through
  }
  return 'wayland-1';
}

function discoverNiriSocket(runtimeDir, env = {}) {
  if (env.NIRI_SOCKET) return env.NIRI_SOCKET;
  try {
    const matches = fs.readdirSync(runtimeDir).filter((name) => /^niri\.wayland-\d+\.sock$/.test(name)).sort();
    if (matches.length > 0) return path.join(runtimeDir, matches[0]);
  } catch {
    // fall through
  }
  return '';
}

/** Build the GUI-safe environment with every persistent path redirected to temp. */
function buildSmokeEnv({ dirs, dshHome, snapshotPath, baseEnv = process.env } = {}) {
  const runtimeDir = runtimeDirFor(baseEnv);
  const env = {
    ...baseEnv,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_DATA_HOME: dirs.data,
    XDG_RUNTIME_DIR: runtimeDir,
    WAYLAND_DISPLAY: discoverWaylandDisplay(runtimeDir, baseEnv),
    DISPLAY: baseEnv.DISPLAY || ':0',
    XDG_SESSION_TYPE: baseEnv.XDG_SESSION_TYPE || 'wayland',
    XDG_CURRENT_DESKTOP: baseEnv.XDG_CURRENT_DESKTOP || 'niri',
    DSH_ELECTRON_HOME: dshHome,
    DSH_ELECTRON_USER_DATA: dirs.userData,
    DSH_ELECTRON_SMOKE: snapshotPath,
  };
  const niriSocket = discoverNiriSocket(runtimeDir, baseEnv);
  if (niriSocket) env.NIRI_SOCKET = niriSocket;
  return env;
}

function createTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-electron-acceptance-'));
  const dirs = {
    root,
    home: path.join(root, 'home'),
    dshHome: path.join(root, 'dsh-home'),
    userData: path.join(root, 'userdata'),
    config: path.join(root, 'xdg-config'),
    cache: path.join(root, 'xdg-cache'),
    data: path.join(root, 'xdg-data'),
    stdout: path.join(root, 'app-stdout.log'),
    stderr: path.join(root, 'app-stderr.log'),
  };
  for (const dir of [dirs.home, dirs.dshHome, dirs.userData, dirs.config, dirs.cache, dirs.data]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

function readTextFile(file, limit = 8000) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > limit ? text.slice(-limit) : text;
  } catch {
    return '';
  }
}

function redactToken(value) {
  return String(value).replace(/([?&]token=)[^&#\s]*/gi, '$1<redacted>');
}

/** All processes whose environment contains exactly DSH_HOME=<dshHome>. */
function findProcessesWithEnv(envName, envValue) {
  const needle = `${envName}=${envValue}`;
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = fs.readFileSync(`/proc/${entry}/environ`, 'utf8');
      const match = raw.split('\0').includes(needle);
      if (!match) continue;
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      found.push({
        pid: Number(entry),
        ppid: Number(after[1]),
        pgid: Number(after[2]),
        cmdline: redactToken(cmdline.join(' ')),
      });
    } catch {
      // exited or unreadable; ignore
    }
  }
  return found;
}

/** All live processes in one process group. */
function findProcessesByPgid(pgid) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(after[2]) !== pgid) continue;
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      found.push({
        pid: Number(entry),
        ppid: Number(after[1]),
        pgid,
        state: after[0],
        cmdline: redactToken(cmdline.join(' ')),
      });
    } catch {
      // ignore
    }
  }
  return found;
}

function processExists(pid) {
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** True when a cmdline refers to the dsh harness binary (not dsh-electron). */
function isDshCmdline(cmdline) {
  return /(^|[\s/])dsh([\s]|$)/.test(String(cmdline)) || /(^|[\s/])dsh web([\s]|$)/.test(String(cmdline));
}

function parseSpawnedPid(logText) {
  const match = /runtime: spawned .*?\(pid (\d+)\)/.exec(logText);
  return match === null ? null : Number(match[1]);
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function killRemaining(orphans) {
  for (const item of orphans) {
    try {
      process.kill(item.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Run one real acceptance smoke.
 *
 * @param {object} [options]
 * @param {string} [options.binary] Electron/app binary (defaults to local Electron)
 * @param {boolean} [options.packaged] true when binary is a packaged app
 * @param {string} [options.dshCommand] absolute dsh path (defaults to discovery)
 * @param {number} [options.timeoutMs] snapshot deadline
 * @param {number} [options.appExitTimeoutMs] clean-exit deadline
 * @param {boolean} [options.keep] keep the temp root for inspection
 */
async function runSmoke(options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const appExitTimeoutMs = options.appExitTimeoutMs === undefined
    ? DEFAULT_APP_EXIT_TIMEOUT_MS
    : options.appExitTimeoutMs;
  const packaged = options.packaged === true;
  const binary = path.resolve(options.binary || getElectronBinary());
  const dshCommand = options.dshCommand || findDshCommand({ env: process.env });
  const dirs = createTempRoot();
  const snapshotPath = path.join(dirs.root, 'snapshot.json');
  const env = buildSmokeEnv({
    dirs,
    dshHome: dirs.dshHome,
    snapshotPath,
    baseEnv: process.env,
  });
  const args = [];
  if (!packaged) args.push('.');
  args.push(`--dsh-home=${dirs.dshHome}`, `--dsh-command=${dshCommand}`, '--no-tray');

  const outFd = fs.openSync(dirs.stdout, 'a');
  const errFd = fs.openSync(dirs.stderr, 'a');
  let child;
  try {
    child = spawn(binary, args, {
      cwd: PROJECT_ROOT,
      env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const exitPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', (error) => finish({ error, code: null, signal: null }));
  });

  let snapshot = null;
  let snapshotError = null;
  let exitedBeforeSnapshot = false;
  let exitInfo = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      break;
    } catch (error) {
      snapshotError = error;
    }
    const raced = await Promise.race([exitPromise, sleep(POLL_MS).then(() => null)]);
    if (raced !== null) {
      exitInfo = raced;
      exitedBeforeSnapshot = true;
      await sleep(300);
      try {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      } catch (error) {
        snapshotError = error;
      }
      break;
    }
  }

  // Observe the live harness child while the app is still shutting down.
  const observedDuringRun = findProcessesWithEnv('DSH_HOME', dirs.dshHome);

  if (exitInfo === null) {
    exitInfo = await Promise.race([exitPromise, sleep(appExitTimeoutMs).then(() => null)]);
  }
  let killedAfterTimeout = false;
  if (exitInfo === null) {
    killedAfterTimeout = true;
    signalProcessGroup(child.pid, 'SIGTERM');
    await sleep(500);
    signalProcessGroup(child.pid, 'SIGKILL');
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
    exitInfo = await Promise.race([exitPromise, sleep(5000).then(() => null)]);
  }

  const logText = readTextFile(path.join(dirs.userData, 'logs', 'main.log'), 20000);
  const spawnedPid = parseSpawnedPid(logText);

  // Give the process table a moment to reap transient Chromium zombies, then
  // look specifically for a leaked harness: same DSH_HOME env, or a `dsh`
  // cmdline that is still a member of the app's process group.
  let orphansByHome = findProcessesWithEnv('DSH_HOME', dirs.dshHome);
  let pgidProcesses = findProcessesByPgid(child.pid);
  let dshPgidOrphans = pgidProcesses.filter((item) => isDshCmdline(item.cmdline));
  let spawnedPidAlive = spawnedPid !== null && processExists(spawnedPid);
  const settleDeadline = Date.now() + 2500;
  while ((orphansByHome.length > 0 || dshPgidOrphans.length > 0 || spawnedPidAlive)
    && Date.now() < settleDeadline) {
    await sleep(250);
    orphansByHome = findProcessesWithEnv('DSH_HOME', dirs.dshHome);
    pgidProcesses = findProcessesByPgid(child.pid);
    dshPgidOrphans = pgidProcesses.filter((item) => isDshCmdline(item.cmdline));
    spawnedPidAlive = spawnedPid !== null && processExists(spawnedPid);
  }

  // Clean up any leak before removing the temp tree, but report it as a failure.
  if (orphansByHome.length > 0 || dshPgidOrphans.length > 0) {
    killRemaining(orphansByHome.concat(dshPgidOrphans));
    signalProcessGroup(child.pid, 'SIGKILL');
    await sleep(200);
  }

  const snapshotValue = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
  const checks = {
    snapshotWritten: snapshot !== null,
    ok: snapshotValue.ok === true,
    titleNonEmpty: typeof snapshotValue.title === 'string' && snapshotValue.title.trim().length > 0,
    readyStateComplete: snapshotValue.readyState === 'complete',
    bodyTextLengthPositive:
      typeof snapshotValue.bodyTextLength === 'number' && snapshotValue.bodyTextLength > 0,
    appRootFound: snapshotValue.appRootFound === true,
    cleanExit: !killedAfterTimeout && exitInfo !== null
      && exitInfo.error === undefined && exitInfo.code === 0 && exitInfo.signal === null,
    noOrphans: orphansByHome.length === 0 && dshPgidOrphans.length === 0 && !spawnedPidAlive,
  };
  const passed = Object.values(checks).every(Boolean);

  const result = {
    passed,
    checks,
    mode: packaged ? 'packaged' : 'source',
    binary,
    binaryExists: isExecutable(binary),
    dshCommand,
    tempRoot: dirs.root,
    snapshotPath,
    snapshot: {
      ok: snapshotValue.ok === true,
      title: typeof snapshotValue.title === 'string' ? snapshotValue.title : '',
      url: redactToken(snapshotValue.url || ''),
      readyState: snapshotValue.readyState || '',
      bodyTextLength: snapshotValue.bodyTextLength,
      appRootFound: snapshotValue.appRootFound === true,
    },
    exit: exitInfo,
    killedAfterTimeout,
    exitedBeforeSnapshot,
    spawnedPid,
    spawnedPidAlive,
    observedDuringRun,
    orphansByHome,
    dshPgidOrphans,
    pgidProcesses,
    snapshotError: snapshotError === null ? null : String(snapshotError.message || snapshotError),
    appStdoutTail: readTextFile(dirs.stdout),
    appStderrTail: readTextFile(dirs.stderr),
    mainLogTail: readTextFile(path.join(dirs.userData, 'logs', 'main.log'), 4000),
    kept: options.keep === true,
  };

  if (!options.keep) {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
  return result;
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_APP_EXIT_TIMEOUT_MS,
  buildSmokeEnv,
  createTempRoot,
  discoverWaylandDisplay,
  discoverNiriSocket,
  findDshCommand,
  findProcessesByPgid,
  findProcessesWithEnv,
  getElectronBinary,
  parseSpawnedPid,
  redactToken,
  runSmoke,
  runtimeDirFor,
};
