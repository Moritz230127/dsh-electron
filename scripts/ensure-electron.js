#!/usr/bin/env node
'use strict';

/**
 * Ensure the Electron binary exists after `npm install`.
 *
 * npm 12 may skip package lifecycle scripts (including electron's own
 * postinstall). If the binary recorded in electron/path.txt is missing, this
 * script invokes electron/install.js explicitly. electron/install.js honours
 * ELECTRON_MIRROR via @electron/get, so the same mirror works here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fail(message, hints = []) {
  console.error(`ensure-electron: ${message}`);
  for (const hint of hints) console.error(`  - ${hint}`);
  process.exit(1);
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  // Respect the standard Electron opt-out instead of fighting the caller.
  console.log('ensure-electron: ELECTRON_SKIP_BINARY_DOWNLOAD is set; not downloading Electron.');
  process.exit(0);
}

let electronDir;
try {
  electronDir = path.dirname(require.resolve('electron/package.json'));
} catch {
  fail('the "electron" package is not installed in this project.', [
    'run: npm install --foreground-scripts',
    'then rerun: node scripts/ensure-electron.js',
  ]);
}

function binaryFromPathFile() {
  const pathFile = path.join(electronDir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const relative = fs.readFileSync(pathFile, 'utf8').trim();
  if (!relative) return null;
  return { relative, absolute: path.join(electronDir, 'dist', relative) };
}

function isExecutable(file) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const existing = binaryFromPathFile();
if (existing && isExecutable(existing.absolute)) {
  console.log(`electron binary present: ${existing.absolute}`);
  process.exit(0);
}

const installScript = path.join(electronDir, 'install.js');
if (!fs.existsSync(installScript)) {
  fail(`electron/install.js not found under ${electronDir}; the install is incomplete.`, [
    'remove node_modules/electron and reinstall:',
    '  npm install --foreground-scripts',
  ]);
}

const mirror = process.env.ELECTRON_MIRROR || '<default: GitHub releases>';
console.log(`electron binary missing; running electron/install.js (ELECTRON_MIRROR=${mirror}) ...`);

try {
  execFileSync(process.execPath, [installScript], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (error) {
  fail(`electron/install.js failed: ${error.message}`, [
    'if the GitHub download is blocked or slow, use the mirror:',
    '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node scripts/ensure-electron.js',
    'npm 12 may have skipped install scripts; re-run:',
    '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --foreground-scripts',
    'or rebuild only electron:',
    '  npm rebuild electron --foreground-scripts',
    'check the setting with: npm config get ignore-scripts',
  ]);
}

const after = binaryFromPathFile();
if (!after || !isExecutable(after.absolute)) {
  fail('electron/install.js finished but the expected binary is still missing.', [
    `expected path (from electron/path.txt): ${after ? after.absolute : '<path.txt missing>'}`,
    'delete node_modules/electron and reinstall with --foreground-scripts.',
  ]);
}

console.log(`electron binary installed: ${after.absolute}`);
