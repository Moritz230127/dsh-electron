#!/usr/bin/env node
/**
 * run-sandbox-probe: spawn a real Electron process using the production
 * webPreferences and assert the renderer cannot see Node globals.
 *
 * All persistent paths (HOME, XDG_*, userData) are redirected to mkdtemp, so
 * the live ~/.config/DSH Electron profile is never opened. Exit 0 = isolated.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { getElectronBinary, runtimeDirFor, discoverWaylandDisplay } = require('./smoke-lib');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-probe-'));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_RUNTIME_DIR: runtimeDirFor(process.env),
    WAYLAND_DISPLAY: discoverWaylandDisplay(runtimeDirFor(process.env), process.env),
    DISPLAY: process.env.DISPLAY || ':0',
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || 'wayland',
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || 'niri',
    SANDBOX_PROBE_USER_DATA: path.join(root, 'userdata'),
  };
  for (const dir of ['home', 'config', 'cache', 'data', 'userdata']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  }

  const args = [path.join(__dirname, 'sandbox-probe-main.js')];
  const child = spawn(getElectronBinary(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));

  fs.rmSync(root, { recursive: true, force: true });

  const line = stdout.split('\n').find((item) => item.startsWith('SANDBOX_PROBE '));
  process.stdout.write(`sandbox probe exit : ${code}\n`);
  process.stdout.write(`observed           : ${line ? line.slice('SANDBOX_PROBE '.length) : '<no result>'}\n`);
  if (code !== 0 || line === undefined) {
    process.stderr.write(`stderr tail: ${stderr.slice(-1200)}\n`);
    process.exitCode = 1;
    return;
  }
  const parsed = JSON.parse(line.slice('SANDBOX_PROBE '.length));
  const checks = {
    noProcess: parsed.hasProcess === 'undefined',
    noRequire: parsed.hasRequire === 'undefined',
    noBuffer: parsed.hasBuffer === 'undefined',
    dshShellExposed: parsed.hasDshShell === 'object',
    onlyRetryQuit: Array.isArray(parsed.dshShellKeys) && parsed.dshShellKeys.join(',') === 'quit,retry',
  };
  let pass = true;
  for (const [name, value] of Object.entries(checks)) {
    process.stdout.write(`check ${value ? 'PASS' : 'FAIL'} ${name}\n`);
    if (!value) pass = false;
  }
  process.stdout.write(`SANDBOX PROBE ${pass ? 'PASS' : 'FAIL'}\n`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`run-sandbox-probe: fatal: ${error.stack || error.message}\n`);
  process.exitCode = 2;
});
