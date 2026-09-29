/**
 * sandbox-probe-main: Electron main process for the renderer-isolation probe.
 * Run via test/acceptance/run-sandbox-probe.js, never directly by npm test.
 *
 * Uses the production buildWebPreferences() from src/main/window-manager.js to
 * create a hidden window, loads a local page and asks the renderer what Node
 * globals it can see. Expected under sandbox:true + contextIsolation:true:
 * process/require/Buffer all "undefined", and only dshShell.retry/quit exposed.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { buildWebPreferences } = require('../../src/main/window-manager');

const userData = process.env.SANDBOX_PROBE_USER_DATA;
if (userData) app.setPath('userData', userData);

const preloadPath = path.resolve(__dirname, '..', '..', 'src', 'preload', 'preload.js');
const pagePath = path.join(__dirname, 'sandbox-probe-page.html');

app.whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: buildWebPreferences({}, preloadPath),
    });
    await win.loadFile(pagePath);
    const result = await win.webContents.executeJavaScript(`({
      hasProcess: typeof process,
      hasRequire: typeof require,
      hasBuffer: typeof Buffer,
      hasGlobal: typeof global,
      hasDshShell: typeof window.dshShell,
      dshShellKeys: window.dshShell ? Object.keys(window.dshShell).sort() : []
    })`);
    process.stdout.write(`SANDBOX_PROBE ${JSON.stringify(result)}\n`);
    const ok = result.hasProcess === 'undefined'
      && result.hasRequire === 'undefined'
      && result.hasBuffer === 'undefined'
      && result.hasDshShell === 'object'
      && result.dshShellKeys.join(',') === 'quit,retry';
    app.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    process.stderr.write(`SANDBOX_PROBE_ERROR ${error && error.stack ? error.stack : error}\n`);
    app.exit(2);
  });
