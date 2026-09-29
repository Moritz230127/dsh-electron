#!/usr/bin/env node
/**
 * run-smoke: CLI entry for the real DSH Electron acceptance smoke.
 *
 * Usage:
 *   node test/acceptance/run-smoke.js [--binary=<path>] [--packaged]
 *        [--dsh-command=<path>] [--timeout=<ms>] [--exit-timeout=<ms>]
 *        [--keep] [--json]
 *
 * Default: launches `electron .` from the project root with a temporary
 * DSH_HOME/userData/HOME, waits for the DSH_ELECTRON_SMOKE JSON snapshot and
 * asserts the UI loaded, the app exited cleanly and no dsh child leaked.
 *
 * Exit code 0 = all checks passed, 1 = failure, 2 = usage/setup error.
 * This file is not a node:test file and is intentionally not named *.test.js.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT, runSmoke } = require('./smoke-lib');

function parseArgs(argv) {
  const options = { packaged: false, keep: false, json: false };
  for (const arg of argv) {
    if (arg === '--packaged') options.packaged = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--binary=')) options.binary = arg.slice('--binary='.length);
    else if (arg.startsWith('--dsh-command=')) options.dshCommand = arg.slice('--dsh-command='.length);
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice('--timeout='.length));
    else if (arg.startsWith('--exit-timeout=')) options.appExitTimeoutMs = Number(arg.slice('--exit-timeout='.length));
    else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function defaultPackagedBinary() {
  return path.join(PROJECT_ROOT, 'dist', 'linux-unpacked', 'dsh-electron');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`run-smoke: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n') + '\n');
    return 0;
  }
  if (options.packaged && !options.binary) options.binary = defaultPackagedBinary();

  const result = await runSmoke(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`smoke mode        : ${result.mode}\n`);
    process.stdout.write(`binary            : ${result.binary} (exists=${result.binaryExists})\n`);
    process.stdout.write(`dsh command       : ${result.dshCommand}\n`);
    process.stdout.write(`snapshot          : ${JSON.stringify(result.snapshot)}\n`);
    process.stdout.write(`exit              : ${JSON.stringify(result.exit)}\n`);
    process.stdout.write(`observed dsh env  : ${JSON.stringify(result.observedDuringRun)}\n`);
    process.stdout.write(`dsh orphans by HOME: ${JSON.stringify(result.orphansByHome)}\n`);
    process.stdout.write(`dsh orphans in pgid: ${JSON.stringify(result.dshPgidOrphans)}\n`);
    process.stdout.write(`other pgid procs   : ${JSON.stringify(result.pgidProcesses)}\n`);
    process.stdout.write(`spawned pid seen  : ${result.spawnedPid === null ? 'unknown' : result.spawnedPid}`);
    process.stdout.write(` (alive after exit=${result.spawnedPidAlive})\n`);
    for (const [name, value] of Object.entries(result.checks)) {
      process.stdout.write(`check ${value ? 'PASS' : 'FAIL'} ${name}\n`);
    }
    if (!result.passed) {
      process.stdout.write(`--- app stderr tail ---\n${result.appStderrTail}\n`);
      process.stdout.write(`--- main.log tail ---\n${result.mainLogTail}\n`);
    }
    if (result.kept) process.stdout.write(`temp root kept at : ${result.tempRoot}\n`);
    process.stdout.write(`SMOKE ${result.passed ? 'PASS' : 'FAIL'}\n`);
  }
  return result.passed ? 0 : 1;
}

if (require.main === module && require.main.filename === __filename) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`run-smoke: fatal: ${error.stack || error.message}\n`);
      process.exitCode = 2;
    });
}

module.exports = { defaultPackagedBinary, main, parseArgs };
