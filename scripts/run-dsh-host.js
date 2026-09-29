#!/usr/bin/env node
'use strict';

/**
 * Safe launcher for the DSH host supervisor (v0.2).
 *
 * Resolves the app root, exports DSH_HOST_STATE_DIR / DSH_HOST_ELECTRON /
 * DSH_HOST_DEV_APP and then replaces this process with
 *   /usr/bin/node <app-root>/[resources/]host/supervisor.js
 * using process.execve(2) when available (no shell, no PID change for
 * systemd). Falls back to spawn(..., { shell: false }) with signal
 * forwarding on older Node versions.
 *
 * Resolution order for the app root:
 *   --app-root=<dir> > $DSH_HOST_APP_ROOT > inferred from this file's layout.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SYSTEM_NODE = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath;

function usage() {
  process.stdout.write(
    [
      'Usage: run-dsh-host.js [--app-root=<dir>] [--state-dir=<dir>] [--electron=<path>] [--help]',
      '',
      'Resolves the app root (packaged or dev checkout), sets DSH_HOST_* env vars and',
      'execs /usr/bin/node on the host supervisor.',
      '',
      '  --app-root=<dir>   app root; packaged: <root>/resources/host/supervisor.js,',
      '                     dev: <root>/src/host/supervisor.js',
      '  --state-dir=<dir>  override $DSH_HOST_STATE_DIR (default: $XDG_STATE_HOME/dsh-host)',
      '  --electron=<path>  override $DSH_HOST_ELECTRON (Electron executable)',
      '  --help             print this help and exit',
      '',
      `node: ${SYSTEM_NODE}`,
    ].join('\n') + '\n',
  );
}

function parseArgs(argv) {
  const out = { appRoot: '', stateDir: '', electron: '', help: false, passthrough: [] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--app-root=')) out.appRoot = arg.slice('--app-root='.length);
    else if (arg.startsWith('--state-dir=')) out.stateDir = arg.slice('--state-dir='.length);
    else if (arg.startsWith('--electron=')) out.electron = arg.slice('--electron='.length);
    else out.passthrough.push(arg);
  }
  return out;
}

/** Infer the app root from this launcher's location. */
function inferAppRoot() {
  const scriptDir = path.dirname(fs.realpathSync(__filename));
  const parent = path.dirname(scriptDir);
  // dev checkout: <repo>/scripts/run-dsh-host.js
  if (fs.existsSync(path.join(parent, 'src', 'host', 'supervisor.js'))) return parent;
  // packaged: <app>/resources/scripts/run-dsh-host.js
  if (fs.existsSync(path.join(parent, 'host', 'supervisor.js'))) return path.dirname(parent);
  return parent;
}

/** Return { supervisor, packaged } for an app root, or null. */
function resolveLayout(appRoot) {
  const candidates = [
    { supervisor: path.join(appRoot, 'resources', 'host', 'supervisor.js'), packaged: true },
    { supervisor: path.join(appRoot, 'host', 'supervisor.js'), packaged: true },
    { supervisor: path.join(appRoot, 'src', 'host', 'supervisor.js'), packaged: false },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.supervisor)) return candidate;
  }
  return null;
}

function resolveElectron(appRoot, override) {
  if (override) return path.resolve(override);
  if (process.env.DSH_HOST_ELECTRON) return process.env.DSH_HOST_ELECTRON;
  const packaged = path.join(appRoot, 'dsh-electron');
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(dev)) return dev;
  return '';
}

function resolveStateDir(override) {
  if (override) return path.resolve(override);
  if (process.env.DSH_HOST_STATE_DIR) return process.env.DSH_HOST_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'dsh-host');
}

function execSupervisor(supervisor, args, env) {
  if (typeof process.execve === 'function') {
    try {
      // Replaces this process; systemd keeps tracking the same PID.
      // execve(2) argv must include argv[0] (the node executable itself).
      process.execve(SYSTEM_NODE, [SYSTEM_NODE, supervisor, ...args], env);
      return; // unreachable on success
    } catch (error) {
      process.stderr.write(`[run-dsh-host] execve failed (${error.message}); falling back to spawn\n`);
    }
  }

  const child = spawn(SYSTEM_NODE, [supervisor, ...args], {
    stdio: 'inherit',
    env,
    shell: false,
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Child already gone.
      }
    });
  }
  child.on('error', (error) => {
    process.stderr.write(`[run-dsh-host] failed to start supervisor: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(128 + (os.constants.signals[signal] || 0));
    }
    process.exit(code == null ? 1 : code);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const appRoot = path.resolve(options.appRoot || process.env.DSH_HOST_APP_ROOT || inferAppRoot());
  const layout = resolveLayout(appRoot);
  if (!layout) {
    process.stderr.write(
      `[run-dsh-host] no host supervisor found under ${appRoot}\n` +
        '  looked for resources/host/supervisor.js (packaged) and src/host/supervisor.js (dev)\n' +
        '  build the app first or pass --app-root=<dir>\n',
    );
    process.exit(2);
  }

  const electron = resolveElectron(appRoot, options.electron);
  const stateDir = resolveStateDir(options.stateDir);
  const env = {
    ...process.env,
    DSH_HOST_APP_ROOT: appRoot,
    DSH_HOST_STATE_DIR: stateDir,
  };
  if (electron) env.DSH_HOST_ELECTRON = electron;
  if (!layout.packaged && !env.DSH_HOST_DEV_APP) env.DSH_HOST_DEV_APP = '1';

  execSupervisor(layout.supervisor, options.passthrough, env);
}

main();
