/**
 * v02-e2e: independent end-to-end verification for the v0.2 host supervisor.
 *
 * Phases (run all by default):
 *   A  real DSH + real Electron attach UI DOM smoke; URL/status files; clean shutdown
 *   B  persistent UI: kill UI (DSH survives) then kill DSH (URL refresh, UI follows)
 *   C  broken fake system runtime -> pre-seeded known-good fallback, UI still loads
 *   D  broken runtime only: restart budget is bounded (no tight loop)
 *   P  packaging: asar/resource completeness, packed smoke, unit static checks,
 *      install-host.sh dry-run makes no changes, systemd unit static checks
 *
 * All state lives in mkdtemp temp roots; HOME/XDG/DSH_HOME/DSH_HOST_STATE_DIR
 * are redirected so the live ~/.dsh and dsh-web.service are never used.
 *
 * Usage: node test/acceptance/v02-e2e.js [--phase=A,B,...] [--keep] [--quick-packaged]
 * Exit 0 = all checks passed.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DSH_COMMAND = process.env.V02_DSH_COMMAND || '/home/Arch/.npm-global/bin/dsh';
const ELECTRON = require('electron');
const ASAR = (() => {
  try {
    return require('@electron/asar');
  } catch {
    return null;
  }
})();

const checks = [];
let currentPhase = '';
function check(name, ok, detail = '') {
  checks.push({ phase: currentPhase, name, ok: Boolean(ok), detail: String(detail || '') });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} [${currentPhase}] ${name}${detail ? ` :: ${detail}` : ''}\n`);
  return Boolean(ok);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = predicate();
    } catch (error) {
      last = undefined;
    }
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readUrlFile(file) {
  const raw = readFileSafe(file);
  if (raw === null) return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** Minimal /proc scan with cmdline and environment for same-user processes. */
function scanProcesses() {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      let env = {};
      try {
        for (const line of fs.readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')) {
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      } catch {
        env = {};
      }
      out.push({
        pid,
        ppid: Number(after[1]),
        pgid: Number(after[2]),
        state: after[0],
        cmdline,
        env,
      });
    } catch {
      // Process exited or unreadable.
    }
  }
  return out;
}

function dshChildren(dirs) {
  return scanProcesses().filter(
    (p) => p.env.DSH_HOME === dirs.dshHome
      && p.cmdline.includes('web')
      && p.cmdline.includes('--no-open'),
  );
}

function uiChildren(supervisorPid) {
  return scanProcesses().filter(
    (p) => p.ppid === supervisorPid && p.cmdline.includes('--attach-url-file='),
  );
}

function descendants(pid) {
  const all = scanProcesses();
  const seen = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of all) {
      if (seen.has(proc.ppid) && !seen.has(proc.pid)) {
        seen.add(proc.pid);
        changed = true;
      }
    }
  }
  seen.delete(pid);
  return all.filter((proc) => seen.has(proc.pid));
}

function httpStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = http.get(url, (response) => {
        response.resume();
        done({ ok: true, status: response.statusCode });
      });
    } catch (error) {
      done({ ok: false, error: error.message });
      return;
    }
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      done({ ok: false, error: 'timeout' });
    });
    request.on('error', (error) => done({ ok: false, error: error.message }));
  });
}

function makeDirs(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dirs = {
    root,
    home: path.join(root, 'home'),
    config: path.join(root, 'xdg-config'),
    cache: path.join(root, 'xdg-cache'),
    data: path.join(root, 'xdg-data'),
    state: path.join(root, 'state'),
    runtime: path.join(root, 'runtime'),
    dshHome: path.join(root, 'dsh-home'),
  };
  for (const dir of Object.values(dirs)) {
    if (dir !== root) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  dirs.urlFile = path.join(dirs.runtime, 'current-url');
  dirs.statusFile = path.join(dirs.runtime, 'status.json');
  dirs.uiProfile = path.join(dirs.state, 'ui-profile');
  dirs.uiLog = path.join(dirs.uiProfile, 'logs', 'main.log');
  return dirs;
}

function discoverRuntimeDir(env) {
  return env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
}

function discoverWaylandDisplay(runtimeDir) {
  try {
    const match = fs.readdirSync(runtimeDir).filter((n) => /^wayland-\d+$/.test(n)).sort()[0];
    if (match) return match;
  } catch {
    // ignore
  }
  return 'wayland-1';
}

function discoverNiriSocket(runtimeDir) {
  try {
    const match = fs.readdirSync(runtimeDir).filter((n) => /^niri\.wayland-\d+\.sock$/.test(n)).sort()[0];
    if (match) return path.join(runtimeDir, match);
  } catch {
    // ignore
  }
  return '';
}

function baseEnv(dirs, extra = {}) {
  const runtimeDir = discoverRuntimeDir(process.env);
  const env = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: path.join(dirs.root, 'xdg-state'),
    XDG_RUNTIME_DIR: runtimeDir,
    WAYLAND_DISPLAY: discoverWaylandDisplay(runtimeDir),
    DISPLAY: process.env.DISPLAY || ':0',
    XDG_SESSION_TYPE: 'wayland',
    XDG_CURRENT_DESKTOP: 'niri',
    DSH_HOME: dirs.dshHome,
    DSH_HOST_STATE_DIR: dirs.state,
    DSH_HOST_RUNTIME_DIR: dirs.runtime,
    DSH_HOST_APP_ROOT: REPO,
    DSH_HOST_ELECTRON_APP: REPO,
    DSH_HOST_ELECTRON: ELECTRON,
    DSH_HOST_DISABLE_SNAPSHOT: '1',
    DSH_HOST_READY_TIMEOUT_MS: '20000',
    DSH_HOST_HEALTH_INTERVAL_MS: '2000',
    DSH_HOST_STABLE_SECONDS: '999',
    DSH_HOST_RESTART_WINDOW_MS: '120000',
    DSH_HOST_MAX_CHILD_RESTARTS: '5',
    ...extra,
  };
  fs.mkdirSync(env.XDG_STATE_HOME, { recursive: true, mode: 0o700 });
  const niri = discoverNiriSocket(runtimeDir);
  if (niri) env.NIRI_SOCKET = niri;
  return env;
}

function spawnSupervisor(dirs, extraEnv = {}) {
  const env = baseEnv(dirs, extraEnv);
  const outFile = path.join(dirs.root, 'supervisor.out.log');
  const errFile = path.join(dirs.root, 'supervisor.err.log');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');
  const args = [
    path.join(REPO, 'scripts', 'run-dsh-host.js'),
    `--app-root=${REPO}`,
    `--electron=${ELECTRON}`,
    `--state-dir=${dirs.state}`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env,
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  child.on('error', () => {});
  return { child, env, outFile, errFile };
}

function spawnSupervisorScript(dirs, extraEnv, scriptPath, cwd) {
  const env = baseEnv(dirs, extraEnv);
  const outFile = path.join(dirs.root, 'supervisor.out.log');
  const errFile = path.join(dirs.root, 'supervisor.err.log');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  child.on('error', () => {});
  return { child, env, outFile, errFile };
}

async function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return { code: child.exitCode, signal: null };
  if (child.signalCode !== null && child.signalCode !== undefined) return { code: null, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => null),
  ]);
}

async function shutdownSupervisor(sup, dirs, name) {
  const pid = sup.child.pid;
  if (processExists(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  const exit = await waitChildExit(sup.child, 15000);
  await sleep(500);
  let leftovers = descendants(pid).concat(dshChildren(dirs));
  if (leftovers.length > 0 || (exit && exit.code === null && exit.signal === null)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ignore
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
    await sleep(300);
    leftovers = descendants(pid).concat(dshChildren(dirs));
  }
  return { exit, leftovers };
}

function cleanupDirs(dirs, keep) {
  if (!keep) fs.rmSync(dirs.root, { recursive: true, force: true });
}

function installHostDryRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-dryrun-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  for (const dir of [home, config, state, bin]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const systemctlLog = path.join(root, 'systemctl.log');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "SYSTEMCTL $*" >> ${JSON.stringify(systemctlLog)}\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync('bash', [path.join(REPO, 'packaging', 'install-host.sh'), '--dry-run', '--dev', `--app-root=${REPO}`], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  const created = [];
  for (const dir of [home, config, state]) {
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        created.push(full);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(dir);
  }
  const systemctlCalled = fs.existsSync(systemctlLog);
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  fs.rmSync(root, { recursive: true, force: true });
  return { status: result.status, created, systemctlCalled, out };
}

function sourceGrep(file, pattern) {
  const text = readFileSafe(file) || '';
  return new RegExp(pattern).test(text);
}

// ---------------------------------------------------------------------------
// Phase A: real DSH + real Electron attach UI DOM smoke
// ---------------------------------------------------------------------------

async function phaseA(opts) {
  currentPhase = 'A';
  const dirs = makeDirs('dsh-v02-a-');
  const snapshotPath = path.join(dirs.root, 'snapshot.json');
  const sup = spawnSupervisor(dirs, { DSH_ELECTRON_SMOKE: snapshotPath, DSH_HOST_DSH_COMMAND: DSH_COMMAND });
  try {
    let snapshot = null;
    try {
      snapshot = await waitFor(() => readJsonSafe(snapshotPath), { timeoutMs: 120000, label: 'phase A snapshot' });
    } catch (error) {
      check('A.snapshot', false, `${error.message}; supervisor err=${(readFileSafe(sup.errFile) || '').slice(-300)}`);
      return;
    }
    check('A.snapshot.ok', snapshot.ok === true, JSON.stringify(snapshot));
    check('A.snapshot.title', typeof snapshot.title === 'string' && snapshot.title.trim().length > 0, snapshot.title);
    check('A.snapshot.readyState', snapshot.readyState === 'complete', snapshot.readyState);
    check('A.snapshot.bodyTextLength', typeof snapshot.bodyTextLength === 'number' && snapshot.bodyTextLength > 0, String(snapshot.bodyTextLength));
    check('A.snapshot.appRootFound', snapshot.appRootFound === true);

    let urlFile = null;
    try {
      urlFile = await waitFor(() => readUrlFile(dirs.urlFile), { timeoutMs: 10000, label: 'phase A URL file' });
    } catch (error) {
      check('A.urlFile.exists', false, error.message);
    }
    check('A.urlFile.exists', typeof urlFile === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(urlFile), urlFile ? urlFile.replace(/token=[^&]*/, 'token=<redacted>') : 'null');
    check('A.urlFile.mode0600', fileMode(dirs.urlFile) === 0o600, String(fileMode(dirs.urlFile)));

    const status = readJsonSafe(dirs.statusFile) || {};
    check('A.status.mode0600', fileMode(dirs.statusFile) === 0o600, String(fileMode(dirs.statusFile)));
    check('A.status.running', status.state === 'running', JSON.stringify(status));
    check('A.status.sourceSystem', status.runtimeSource === 'system', String(status.runtimeSource));

    let dsh = null;
    try {
      dsh = await waitFor(() => dshChildren(dirs)[0], { timeoutMs: 15000, label: 'phase A DSH child' });
    } catch (error) {
      check('A.dshChild', false, error.message);
    }
    if (dsh) {
      check('A.dshChildAlive', processExists(dsh.pid), `pid=${dsh.pid} cmd=${dsh.cmdline.slice(0, 120)}`);
      const health = await httpStatus(urlFile);
      check('A.dshServing', health.ok === true, JSON.stringify(health));
    }

    // The smoke UI intentionally exits; the DSH child must remain alive and serving.
    await sleep(3000);
    const remainingDsh = dshChildren(dirs);
    check('A.dshSurvivesUiExit', remainingDsh.length === 1 && processExists(remainingDsh[0].pid), `dsh=${remainingDsh.map((p) => p.pid).join(',')}`);
    check('A.urlFileKeptForUiRestart', readUrlFile(dirs.urlFile) !== null);

    const shutdown = await shutdownSupervisor(sup, dirs, 'A');
    check('A.supervisorExit0', shutdown.exit !== null && shutdown.exit.code === 0, JSON.stringify(shutdown.exit));
    check('A.dshGoneAfterSigterm', dshChildren(dirs).length === 0, `leftovers=${shutdown.leftovers.map((p) => p.pid).join(',')}`);
    check('A.urlFileRemovedOnStop', readUrlFile(dirs.urlFile) === null);
    const stopped = readJsonSafe(dirs.statusFile) || {};
    check('A.statusStopped', stopped.state === 'stopped', JSON.stringify(stopped));
  } finally {
    cleanupDirs(dirs, opts.keep);
  }
}

// ---------------------------------------------------------------------------
// Phase B: UI-kill independence + DSH restart + UI follows URL
// ---------------------------------------------------------------------------

async function phaseB(opts) {
  currentPhase = 'B';
  const dirs = makeDirs('dsh-v02-b-');
  process.stdout.write(`PHASE_B_ROOT ${dirs.root}\n`);
  const sup = spawnSupervisor(dirs, { DSH_HOST_DSH_COMMAND: DSH_COMMAND });
  try {
    let firstUrl = null;
    try {
      firstUrl = await waitFor(() => {
        const url = readUrlFile(dirs.urlFile);
        const status = readJsonSafe(dirs.statusFile);
        return url && status && status.state === 'running' ? url : null;
      }, { timeoutMs: 60000, label: 'phase B running URL' });
    } catch (error) {
      check('B.start', false, error.message);
      return;
    }
    check('B.firstUrl', /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(firstUrl), firstUrl.replace(/token=[^&]*/, 'token=<redacted>'));
    const dsh1 = await waitFor(() => dshChildren(dirs)[0], { timeoutMs: 10000, label: 'phase B first DSH' });
    const ui1 = await waitFor(() => uiChildren(sup.child.pid)[0], { timeoutMs: 15000, label: 'phase B first UI' });
    check('B.oneDshOneUi', dshChildren(dirs).length === 1 && uiChildren(sup.child.pid).length === 1,
      `dsh=${dshChildren(dirs).length} ui=${uiChildren(sup.child.pid).length}`);
    check('B.uiHasAppArg', ui1.cmdline.includes(REPO), ui1.cmdline.slice(0, 160));
    check('B.uiHasAttachFileArg', ui1.cmdline.includes(`--attach-url-file=${dirs.urlFile}`), ui1.cmdline.slice(0, 160));

    await waitFor(() => (readFileSafe(dirs.uiLog) || '').includes('harness UI loaded'), { timeoutMs: 30000, label: 'first UI load' });
    const firstLoads = countOccurrences(readFileSafe(dirs.uiLog) || '', 'harness UI loaded');
    check('B.firstUiLoaded', firstLoads >= 1, `loads=${firstLoads}`);

    // Kill the UI: DSH must survive and keep serving; supervisor must restart UI.
    process.kill(ui1.pid, 'SIGKILL');
    await sleep(500);
    check('B.dshAliveAfterUiKill', processExists(dsh1.pid) && dshChildren(dirs).some((p) => p.pid === dsh1.pid), `dsh=${dsh1.pid}`);
    const stillServing = await httpStatus(firstUrl);
    check('B.dshServingAfterUiKill', stillServing.ok === true, JSON.stringify(stillServing));
    const ui2 = await waitFor(() => uiChildren(sup.child.pid).find((p) => p.pid !== ui1.pid), { timeoutMs: 20000, label: 'restarted UI' });
    check('B.uiRestarted', ui2.pid !== ui1.pid, `old=${ui1.pid} new=${ui2.pid}`);
    check('B.dshNotRestartedByUiKill', dshChildren(dirs).length === 1 && dshChildren(dirs)[0].pid === dsh1.pid);
    await waitFor(() => countOccurrences(readFileSafe(dirs.uiLog) || '', 'harness UI loaded') > firstLoads,
      { timeoutMs: 30000, label: 'restarted UI load' });
    check('B.restartedUiLoaded', true);

    // Kill DSH: supervisor restarts it, URL file changes, UI stays and follows.
    const loadsBeforeDshKill = countOccurrences(readFileSafe(dirs.uiLog) || '', 'harness UI loaded');
    process.kill(dsh1.pid, 'SIGKILL');
    const dsh2 = await waitFor(() => dshChildren(dirs).find((p) => p.pid !== dsh1.pid), { timeoutMs: 30000, label: 'restarted DSH' });
    const secondUrl = await waitFor(() => {
      const url = readUrlFile(dirs.urlFile);
      return url && url !== firstUrl ? url : null;
    }, { timeoutMs: 30000, label: 'refreshed URL file' });
    check('B.dshRestarted', dsh2.pid !== dsh1.pid, `old=${dsh1.pid} new=${dsh2.pid} cmd=${dsh2.cmdline.slice(0, 120)}`);
    check('B.urlRefreshed', secondUrl !== firstUrl, `${firstUrl} -> ${secondUrl}`);
    check('B.newUrlDifferentPort', new URL(firstUrl).port !== new URL(secondUrl).port, `${new URL(firstUrl).port} -> ${new URL(secondUrl).port}`);
    const health2 = await httpStatus(secondUrl);
    check('B.newDshServing', health2.ok === true, JSON.stringify(health2));
    check('B.uiNotRestartedByDshKill', processExists(ui2.pid) && uiChildren(sup.child.pid).some((p) => p.pid === ui2.pid), `ui=${ui2.pid}`);
    check('B.onlyOneDsh', dshChildren(dirs).length === 1, `dsh=${dshChildren(dirs).length}`);

    try {
      await waitFor(() => {
        const log = readFileSafe(dirs.uiLog) || '';
        const newLoad = countOccurrences(log, 'harness UI loaded') > loadsBeforeDshKill;
        // The supervisor removes current-url on DSH exit, so the UI observes
        // 'missing' then 'attach URL found' (changed=false) for the new URL.
        const sawTransition = log.includes('attach URL file missing')
          && countOccurrences(log, 'attach URL found:') + countOccurrences(log, 'attach URL changed:') >= 2;
        return newLoad && sawTransition;
      }, { timeoutMs: 60000, label: 'UI follows refreshed URL' });
      check('B.uiFollowedNewUrl', true, 'missing -> new URL -> new harness UI loaded log');
    } catch (error) {
      const log = readFileSafe(dirs.uiLog) || '<missing>';
      check('B.uiFollowedNewUrl', false, `${error.message}; ui log tail=${log.slice(-1200)}`);
    }

    const shutdown = await shutdownSupervisor(sup, dirs, 'B');
    check('B.supervisorExit0', shutdown.exit !== null && shutdown.exit.code === 0, JSON.stringify(shutdown.exit));
    check('B.noOrphansAfterSigterm', dshChildren(dirs).length === 0 && descendants(sup.child.pid).length === 0,
      `leftovers=${shutdown.leftovers.map((p) => p.pid).join(',')}`);
  } finally {
    cleanupDirs(dirs, opts.keep);
  }
}

function countOccurrences(text, needle) {
  if (!text) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

// ---------------------------------------------------------------------------
// Phase C: broken system runtime -> known-good fallback
// ---------------------------------------------------------------------------

function writeFakeRuntime(root, version, script) {
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  const entry = path.join(root, 'lib', 'bin.js');
  fs.writeFileSync(entry, script, { mode: 0o644 });
  return { root, entry };
}

async function phaseC(opts) {
  currentPhase = 'C';
  const dirs = makeDirs('dsh-v02-c-');
  process.stdout.write(`PHASE_C_ROOT ${dirs.root}\n`);
  const snapshotPath = path.join(dirs.root, 'snapshot.json');
  try {
    const broken = writeFakeRuntime(path.join(dirs.root, 'broken-runtime'), '9.9.9', [
      "'use strict';",
      "const fs = require('node:fs'); const path = require('node:path');",
      "fs.mkdirSync(process.env.DSH_HOME, { recursive: true });",
      "fs.appendFileSync(path.join(process.env.DSH_HOME, 'broken-attempts.log'), 'attempt\\n');",
      "process.stderr.write('broken runtime: exiting before ready\\n');",
      'process.exit(7);',
      '',
    ].join('\n'));

    const knownGood = writeFakeRuntime(path.join(dirs.root, 'known-good-runtime'), '1.0.0', [
      "'use strict';",
      "const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');",
      "fs.mkdirSync(process.env.DSH_HOME, { recursive: true });",
      "fs.writeFileSync(path.join(process.env.DSH_HOME, 'known-good-child.json'), JSON.stringify({ dshHome: process.env.DSH_HOME, argv: process.argv.slice(2) }));",
      "const args = process.argv.slice(2);",
      "const portIndex = args.indexOf('--port');",
      "const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;",
      "const server = http.createServer((request, response) => {",
      "  response.statusCode = 200; response.setHeader('content-type', 'text/html');",
      "  response.end('<!doctype html><html><head><title>Known Good UI</title></head><body><div data-slot>kg</div>Known-good fallback runtime is serving the official UI contract.</body></html>');",
      '});',
      "server.listen(requestedPort, '127.0.0.1', () => {",
      "  const address = server.address();",
      "  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}/?token=kg-token\\n`);",
      '});',
      "process.on('SIGTERM', () => { server.close(); process.exit(0); });",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));

    fs.mkdirSync(dirs.state, { recursive: true, mode: 0o700 });
    const knownGoodRecord = {
      version: '1.0.0',
      root: knownGood.root,
      entry: knownGood.entry,
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dirs.state, 'known-good.json'), JSON.stringify(knownGoodRecord, null, 2), { mode: 0o600 });

    const sup = spawnSupervisor(dirs, {
      DSH_ELECTRON_SMOKE: snapshotPath,
      DSH_HOST_DSH_COMMAND: broken.entry,
      DSH_HOST_MAX_CHILD_RESTARTS: '5',
    });
    try {
      let snapshot = null;
      try {
        snapshot = await waitFor(() => readJsonSafe(snapshotPath), { timeoutMs: 90000, label: 'phase C snapshot' });
      } catch (error) {
        check('C.snapshot', false, `${error.message}; status=${JSON.stringify(readJsonSafe(dirs.statusFile))}; err=${(readFileSafe(sup.errFile) || '').slice(-300)}`);
        return;
      }
      check('C.snapshot.ok', snapshot.ok === true, JSON.stringify(snapshot));
      check('C.snapshot.titleKnownGood', snapshot.title === 'Known Good UI', snapshot.title);
      check('C.snapshot.bodyTextLength', typeof snapshot.bodyTextLength === 'number' && snapshot.bodyTextLength > 0, String(snapshot.bodyTextLength));

      const status = readJsonSafe(dirs.statusFile) || {};
      check('C.statusFallback', status.state === 'fallback' && (status.runtimeSource === 'known-good' || status.runtimeSource === 'fallback'), JSON.stringify(status));
      check('C.statusVersion', status.dshVersion === '1.0.0', String(status.dshVersion));
      check('C.urlFile0600', fileMode(dirs.urlFile) === 0o600, String(fileMode(dirs.urlFile)));

      const dsh = await waitFor(() => dshChildren(dirs)[0], { timeoutMs: 15000, label: 'phase C child' });
      check('C.knownGoodChild', dsh.cmdline.includes(knownGood.entry), dsh.cmdline.slice(0, 160));
      check('C.knownGoodChildUsesTempHome', dsh.env.DSH_HOME === dirs.dshHome, `DSH_HOME=${dsh.env.DSH_HOME}`);
      check('C.brokenSystemAttempted', fs.existsSync(path.join(dirs.dshHome, 'broken-attempts.log')));
      const marker = readJsonSafe(path.join(dirs.dshHome, 'known-good-child.json'));
      check('C.knownGoodMarker', marker !== null && marker.dshHome === dirs.dshHome, JSON.stringify(marker));
      const attempt = readJsonSafe(path.join(dirs.state, 'attempt.json'));
      check('C.attemptRecorded', attempt !== null && attempt.systemVersion === '9.9.9', JSON.stringify(attempt));
      check('C.onlyOneDsh', dshChildren(dirs).length === 1, `dsh=${dshChildren(dirs).length}`);

      const urlForHealth = readUrlFile(dirs.urlFile);
      const health = await httpStatus(urlForHealth);
      check('C.fallbackServing', health.ok === true, JSON.stringify(health));

      const shutdown = await shutdownSupervisor(sup, dirs, 'C');
      check('C.supervisorExit0', shutdown.exit !== null && shutdown.exit.code === 0, JSON.stringify(shutdown.exit));
      check('C.noOrphans', dshChildren(dirs).length === 0 && descendants(sup.child.pid).length === 0,
        `leftovers=${shutdown.leftovers.map((p) => p.pid).join(',')}`);
    } finally {
      cleanupDirs(dirs, opts.keep);
    }
  } finally {
    cleanupDirs(dirs, opts.keep);
  }
}

// ---------------------------------------------------------------------------
// Phase D: bounded restart budget with a permanently broken runtime
// ---------------------------------------------------------------------------

async function phaseD(opts) {
  currentPhase = 'D';
  const dirs = makeDirs('dsh-v02-d-');
  try {
    const broken = writeFakeRuntime(path.join(dirs.root, 'broken-runtime'), '9.9.9', [
      "'use strict';",
      "const fs = require('node:fs'); const path = require('node:path');",
      "fs.mkdirSync(process.env.DSH_HOME, { recursive: true });",
      "fs.appendFileSync(path.join(process.env.DSH_HOME, 'attempts.log'), 'x\\n');",
      'process.exit(9);',
      '',
    ].join('\n'));
    const attemptsFile = path.join(dirs.dshHome, 'attempts.log');
    const sup = spawnSupervisor(dirs, {
      DSH_HOST_DSH_COMMAND: broken.entry,
      DSH_HOST_MAX_CHILD_RESTARTS: '2',
      DSH_HOST_RESTART_WINDOW_MS: '60000',
      DSH_HOST_READY_TIMEOUT_MS: '2000',
      DSH_HOST_HEALTH_INTERVAL_MS: '2000',
    });
    try {
      await waitFor(() => {
        const text = readFileSafe(attemptsFile) || '';
        return text.split('\n').filter(Boolean).length >= 3;
      }, { timeoutMs: 20000, label: 'three broken attempts' });
      const attemptsAtThree = (readFileSafe(attemptsFile) || '').split('\n').filter(Boolean).length;
      check('D.threeAttempts', attemptsAtThree === 3, `attempts=${attemptsAtThree}`);
      await sleep(4000);
      const attemptsAfter = (readFileSafe(attemptsFile) || '').split('\n').filter(Boolean).length;
      check('D.budgetBoundedNoTightLoop', attemptsAfter === 3, `after4s=${attemptsAfter}`);
      const status = readJsonSafe(dirs.statusFile) || {};
      check('D.statusError', status.state === 'error', JSON.stringify(status));
      check('D.supervisorStillAlive', processExists(sup.child.pid));

      const shutdown = await shutdownSupervisor(sup, dirs, 'D');
      check('D.cleanShutdown', shutdown.exit !== null && shutdown.exit.code === 0, JSON.stringify(shutdown.exit));
      check('D.noOrphans', dshChildren(dirs).length === 0 && descendants(sup.child.pid).length === 0);
    } finally {
      cleanupDirs(dirs, opts.keep);
    }
  } finally {
    cleanupDirs(dirs, opts.keep);
  }
}

// ---------------------------------------------------------------------------
// Phase E: packaged critical path - packaged supervisor + packaged attach UI
// ---------------------------------------------------------------------------

async function phaseE(opts) {
  currentPhase = 'E';
  const dist = path.join(REPO, 'dist', 'linux-unpacked');
  const supervisorScript = path.join(dist, 'resources', 'host', 'supervisor.js');
  const packagedElectron = path.join(dist, 'dsh-electron');
  const dirs = makeDirs('dsh-v02-e-');
  const snapshotPath = path.join(dirs.root, 'snapshot.json');
  process.stdout.write(`PHASE_E_ROOT ${dirs.root}\n`);

  check('E.packedSupervisorExists', fs.existsSync(supervisorScript), supervisorScript);
  check('E.packedElectronExists', fs.existsSync(packagedElectron), packagedElectron);
  if (!fs.existsSync(supervisorScript) || !fs.existsSync(packagedElectron)) {
    cleanupDirs(dirs, opts.keep);
    return;
  }

  const sup = spawnSupervisorScript(dirs, {
    DSH_ELECTRON_SMOKE: snapshotPath,
    DSH_HOST_DSH_COMMAND: DSH_COMMAND,
    DSH_HOST_ELECTRON: packagedElectron,
    DSH_HOST_ELECTRON_APP: dist,
    DSH_HOST_APP_ROOT: dist,
    DSH_HOST_DEV_APP: '0',
  }, supervisorScript, dist);

  try {
    let snapshot = null;
    try {
      snapshot = await waitFor(() => readJsonSafe(snapshotPath), { timeoutMs: 90000, label: 'phase E packaged attach snapshot' });
    } catch (error) {
      check('E.snapshot', false, `${error.message}; mainLog=${(readFileSafe(dirs.uiLog) || '').slice(-500)}; err=${(readFileSafe(sup.errFile) || '').slice(-300)}`);
      return;
    }
    check('E.snapshot.ok', snapshot.ok === true, JSON.stringify(snapshot));
    check('E.snapshot.title', typeof snapshot.title === 'string' && snapshot.title.trim().length > 0, snapshot.title);
    check('E.snapshot.complete', snapshot.readyState === 'complete' && snapshot.bodyTextLength > 0, JSON.stringify({ readyState: snapshot.readyState, bodyTextLength: snapshot.bodyTextLength }));
    check('E.snapshot.appRootFound', snapshot.appRootFound === true);

    await waitFor(() => readUrlFile(dirs.urlFile), { timeoutMs: 10000, label: 'phase E URL file' });
    check('E.urlFile0600', fileMode(dirs.urlFile) === 0o600, String(fileMode(dirs.urlFile)));
    const status = readJsonSafe(dirs.statusFile) || {};
    check('E.statusRunning', status.state === 'running' && status.runtimeSource === 'system', JSON.stringify(status));

    const dsh = await waitFor(() => dshChildren(dirs)[0], { timeoutMs: 15000, label: 'phase E DSH child' });
    const ui = await waitFor(() => uiChildren(sup.child.pid)[0], { timeoutMs: 20000, label: 'phase E packaged UI child' });
    check('E.packagedUiBinary', ui.cmdline.includes(packagedElectron), ui.cmdline.slice(0, 160));
    check('E.packagedUiAttachArg', ui.cmdline.includes(`--attach-url-file=${dirs.urlFile}`), ui.cmdline.slice(0, 160));
    check('E.packagedUiNoAppArg', !ui.cmdline.split(' ').includes(dist), `argv=${ui.cmdline.slice(0, 200)}`);
    check('E.oneDsh', dshChildren(dirs).length === 1);

    const url = readUrlFile(dirs.urlFile);
    check('E.dshServing', (await httpStatus(url)).ok === true);

    await waitFor(() => (readFileSafe(dirs.uiLog) || '').includes('harness UI loaded'), { timeoutMs: 20000, label: 'packaged UI load' });
    const loadsBefore = countOccurrences(readFileSafe(dirs.uiLog) || '', 'harness UI loaded');

    // Packaged UI crash: DSH survives and a fresh packaged UI is spawned.
    process.kill(ui.pid, 'SIGKILL');
    const ui2 = await waitFor(() => uiChildren(sup.child.pid).find((p) => p.pid !== ui.pid), { timeoutMs: 25000, label: 'packaged UI restart' });
    check('E.packagedUiRestarted', ui2.pid !== ui.pid && ui2.cmdline.includes(packagedElectron), `old=${ui.pid} new=${ui2.pid}`);
    check('E.dshSurvivesPackagedUiKill', processExists(dsh.pid) && dshChildren(dirs).some((p) => p.pid === dsh.pid), `dsh=${dsh.pid}`);
    await waitFor(() => countOccurrences(readFileSafe(dirs.uiLog) || '', 'harness UI loaded') > loadsBefore,
      { timeoutMs: 30000, label: 'packaged UI reload' });
    check('E.packagedUiReloaded', true);

    const shutdown = await shutdownSupervisor(sup, dirs, 'E');
    check('E.supervisorExit0', shutdown.exit !== null && shutdown.exit.code === 0, JSON.stringify(shutdown.exit));
    check('E.noOrphans', dshChildren(dirs).length === 0 && descendants(sup.child.pid).length === 0,
      `leftovers=${shutdown.leftovers.map((p) => p.pid).join(',')}`);
    check('E.urlFileRemoved', readUrlFile(dirs.urlFile) === null);
  } finally {
    cleanupDirs(dirs, opts.keep);
  }
}

// ---------------------------------------------------------------------------
// Phase P: packaging / installer static + packed smoke
// ---------------------------------------------------------------------------

async function phaseP(opts) {
  currentPhase = 'P';
  const dist = path.join(REPO, 'dist', 'linux-unpacked');
  const asarPath = path.join(dist, 'resources', 'app.asar');
  if (ASAR && fs.existsSync(asarPath)) {
    const entries = ASAR.listPackage(asarPath);
    const mainInAsar = ASAR.extractFile(asarPath, 'src/main/main.js').toString();
    check('P.asar.mainFallbackLoader',
      entries.includes('/src/main/main.js') && mainInAsar.includes('loadRuntimeModule') && mainInAsar.includes("'main', 'runtime'"));
    check('P.asar.shellEntries', entries.includes('/src/main/main.js') && entries.includes('/src/main/attach-url.js'));
  } else {
    check('P.asar.readable', false, '<asar module or app.asar missing>');
  }

  const resourcePairs = [
    ['resources/host/supervisor.js', 'src/host/supervisor.js'],
    ['resources/host/config.js', 'src/host/config.js'],
    ['resources/main/runtime/harness-runtime.js', 'src/main/runtime/harness-runtime.js'],
    ['resources/main/runtime/health.js', 'src/main/runtime/health.js'],
    ['resources/main/runtime/ready-url.js', 'src/main/runtime/ready-url.js'],
    ['resources/scripts/run-dsh-host.js', 'scripts/run-dsh-host.js'],
    ['resources/dsh-host.service', 'packaging/dsh-host.service'],
  ];
  for (const [packed, source] of resourcePairs) {
    const packedPath = path.join(dist, packed);
    const sourcePath = path.join(REPO, source);
    const same = fs.existsSync(packedPath) && fs.existsSync(sourcePath)
      && fs.readFileSync(packedPath).equals(fs.readFileSync(sourcePath));
    check(`P.resource.${source.replace(/\//g, '_')}`, same, `${packed} vs ${source}`);
  }

  const unit = readFileSafe(path.join(REPO, 'packaging', 'dsh-host.service')) || '';
  check('P.unit.conflicts', /^Conflicts=dsh-web\.service$/m.test(unit));
  check('P.unit.restartAlways', /^Restart=always$/m.test(unit));
  check('P.unit.restartSec3', /^RestartSec=3$/m.test(unit));
  check('P.unit.ordering', /^After=graphical-session\.target$/m.test(unit) && /^PartOf=graphical-session\.target$/m.test(unit));
  check('P.unit.wantedBy', /^WantedBy=default\.target$/m.test(unit));
  check('P.unit.execStartSupervisor', /supervisor\.js/.test(unit) && /^ExecStart=/m.test(unit));
  check('P.unit.startLimit0', /^StartLimitIntervalSec=0$/m.test(unit));

  const installScript = readFileSafe(path.join(REPO, 'packaging', 'install-host.sh')) || '';
  const systemctlStartStopLines = installScript
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && !trimmed.startsWith('*');
    })
    .filter((line) => /systemctl[^\n]*\b(start|stop|restart)\b/.test(line));
  check('P.install.noSystemctlStartStop', systemctlStartStopLines.length === 0, systemctlStartStopLines.join(' | '));
  check('P.install.dryRunDefault', /Default mode is --dry-run/.test(installScript));

  const artifacts = [
    'dist/linux-unpacked/dsh-electron',
    'dist/linux-unpacked/resources/host/supervisor.js',
    'dist/linux-unpacked/resources/dsh-host.service',
    'dist/dsh-electron-0.1.0-x64.pkg.tar.xz',
    'dist/dsh-electron-0.1.0-x86_64.AppImage',
  ];
  for (const artifact of artifacts) {
    check(`P.artifact.${path.basename(artifact)}`, fs.existsSync(path.join(REPO, artifact)));
  }

  const dry = installHostDryRun();
  check('P.installDryRun.exit0', dry.status === 0, `status=${dry.status} out=${dry.out.slice(-200)}`);
  check('P.installDryRun.noFilesCreated', dry.created.length === 0, `created=${dry.created.join(',')}`);
  check('P.installDryRun.noSystemctl', dry.systemctlCalled === false);

  // Static no-live-home writes for the supervisor.
  const supervisorSrc = readFileSafe(path.join(REPO, 'src', 'host', 'supervisor.js')) || '';
  check('P.static.noDshHomeWrites',
    !/(?:writeFileSync|appendFileSync|mkdirSync|writeAtomic)\([^;\n]*dshHome/.test(supervisorSrc));
  check('P.static.dshHomeEnvOnly',
    /env:\s*\{\s*\.\.\.this\._env,\s*DSH_HOME:\s*this\.config\.dshHome\s*\}/.test(supervisorSrc));
  check('P.static.urlFileMode0600', /writeUrlFileAtomic\([^)]*mode:\s*0o600/.test(supervisorSrc)
    || /writeUrlFileAtomic\(/.test(supervisorSrc) && /mode:\s*0o600/.test(supervisorSrc));

  // Packed app functional smoke: managed mode must fail if asar lacks runtime modules.
  const packedSmoke = spawnSync(
    process.execPath,
    [path.join(REPO, 'test', 'acceptance', 'run-smoke.js'), '--packaged', '--timeout=25000', '--exit-timeout=5000'],
    { cwd: REPO, encoding: 'utf8', timeout: 90000 },
  );
  check('P.packedSmoke.pass', packedSmoke.status === 0,
    `status=${packedSmoke.status} tail=${(packedSmoke.stdout || packedSmoke.stderr || '').split('\n').slice(-6).join(' | ')}`);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const phasesArg = (args.find((a) => a.startsWith('--phase=')) || '').slice('--phase='.length);
  const keep = args.includes('--keep');
  const selected = phasesArg
    ? phasesArg.split(',').map((p) => p.trim().toUpperCase())
    : ['A', 'B', 'C', 'D', 'E', 'P'];
  const runners = { A: phaseA, B: phaseB, C: phaseC, D: phaseD, E: phaseE, P: phaseP };

  for (const phase of selected) {
    if (!runners[phase]) {
      check(`runner.phase${phase}`, false, 'unknown phase');
      continue;
    }
    currentPhase = phase;
    try {
      await runners[phase]({ keep });
    } catch (error) {
      check(`${phase}.phaseCrash`, false, error && error.stack ? error.stack.split('\n')[0] : String(error));
    }
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\nV02 E2E summary: ${checks.length - failed.length}/${checks.length} passed\n`);
  if (failed.length > 0) {
    process.stdout.write('FAILED CHECKS:\n');
    for (const item of failed) process.stdout.write(`  [${item.phase}] ${item.name} :: ${item.detail}\n`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
  return { total: checks.length, failed: failed.length, checks };
}

const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
if (require.main === module && !underTestRunner) {
  main().catch((error) => {
    process.stderr.write(`v02-e2e fatal: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  });
}

module.exports = { main, checks };
