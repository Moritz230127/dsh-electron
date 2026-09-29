'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

const { HarnessRuntime } = require('../../src/main/runtime/harness-runtime.js');

const READY_LINE = 'dsh web: http://127.0.0.1:4321/?token=abc123';

function createFakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return Object.assign(child, overrides);
}

function createRuntime(child, options = {}) {
  const spawnCalls = [];
  const runtime = new HarnessRuntime({
    command: options.command || '/usr/bin/dsh',
    args: options.args || ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    cwd: options.cwd || '/tmp/runtime-test',
    env: options.env || { DSH_HOME: '/tmp/runtime-test-home', PATH: '/usr/bin' },
    logger: options.logger,
    stopTimeoutMs: options.stopTimeoutMs === undefined ? 50 : options.stopTimeoutMs,
    spawn: (command, args, spawnOptions) => {
      spawnCalls.push({ command, args, spawnOptions });
      return child;
    },
  });
  return { runtime, spawnCalls };
}

test('start() spawns without a shell and splits stdout/stderr into lines', async () => {
  const child = createFakeChild();
  const { runtime, spawnCalls } = createRuntime(child);
  const started = [];
  const stdoutLines = [];
  const stderrLines = [];
  let ready = null;

  runtime.on('starting', (payload) => started.push(payload));
  runtime.on('stdout', ({ line }) => stdoutLines.push(line));
  runtime.on('stderr', ({ line }) => stderrLines.push(line));
  runtime.on('ready', (payload) => {
    ready = payload;
  });

  const startResult = await runtime.start();

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, '/usr/bin/dsh');
  assert.deepEqual(spawnCalls[0].args, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0']);
  assert.equal(spawnCalls[0].spawnOptions.shell, false);
  assert.deepEqual(spawnCalls[0].spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(spawnCalls[0].spawnOptions.cwd, '/tmp/runtime-test');
  assert.deepEqual(started, [{ command: '/usr/bin/dsh', args: ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'] }]);
  assert.equal(startResult.command, '/usr/bin/dsh');
  assert.equal(startResult.pid, 4242);
  assert.equal(runtime.isRunning(), true);

  // A line split across two chunks must be reassembled before parsing.
  child.stdout.emit('data', 'dsh web: http://127.0.0.1:4321/?to');
  child.stderr.emit('data', 'warning line\r\n');
  child.stdout.emit('data', 'ken=abc123\nnext line\n');

  assert.deepEqual(stdoutLines, [READY_LINE, 'next line']);
  assert.deepEqual(stderrLines, ['warning line']);
  assert.deepEqual(ready, { url: 'http://127.0.0.1:4321/?token=abc123', host: '127.0.0.1', port: 4321, token: 'abc123' });
  assert.deepEqual(runtime.readyInfo, ready);
});

test('start() rejects when already running', async () => {
  const child = createFakeChild();
  const { runtime } = createRuntime(child);
  await runtime.start();
  await assert.rejects(runtime.start(), /already running/);
});

test('unexpected exit before ready emits fatal with logTail', async () => {
  const child = createFakeChild();
  const { runtime, spawnCalls } = createRuntime(child);
  const stdout = [];
  runtime.on('stdout', ({ line }) => stdout.push(line));

  await runtime.start();
  child.stdout.emit('data', 'booting up'); // partial line must be flushed on exit
  const fatalPromise = once(runtime, 'fatal');
  child.emit('exit', 2, null);
  const [fatal] = await fatalPromise;

  assert.equal(fatal.error instanceof Error, true);
  assert.match(fatal.message, /before ready/);
  assert.match(fatal.message, /code=2/);
  assert.match(fatal.logTail, /booting up/);
  assert.deepEqual(stdout, ['booting up']);
  assert.equal(runtime.isRunning(), false);
  assert.equal(spawnCalls.length, 1);
});

test('child error before ready emits fatal with the original error', async () => {
  const child = createFakeChild();
  const { runtime } = createRuntime(child);
  await runtime.start();

  const spawnError = new Error('spawn dsh ENOENT');
  const fatalPromise = once(runtime, 'fatal');
  child.emit('error', spawnError);
  const [fatal] = await fatalPromise;

  assert.equal(fatal.error, spawnError);
  assert.match(fatal.message, /ENOENT/);
  assert.equal(runtime.isRunning(), false);
});

test('unexpected exit after ready emits exit with expected=false', async () => {
  const child = createFakeChild();
  const { runtime } = createRuntime(child);
  await runtime.start();

  const readyPromise = once(runtime, 'ready');
  child.stdout.emit('data', `${READY_LINE}\n`);
  await readyPromise;

  const exitPromise = once(runtime, 'exit');
  child.emit('exit', 0, null);
  const [exit] = await exitPromise;

  assert.equal(exit.expected, false);
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.equal(runtime.isRunning(), false);
});

test('stop() sends SIGTERM and the following exit is expected=true', async () => {
  const child = createFakeChild();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('exit', 0, null));
    return true;
  };
  const { runtime } = createRuntime(child);
  await runtime.start();

  const readyPromise = once(runtime, 'ready');
  child.stdout.emit('data', `${READY_LINE}\n`);
  await readyPromise;

  const exitPromise = once(runtime, 'exit');
  await runtime.stop();
  const [exit] = await exitPromise;

  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(exit.expected, true);
  assert.equal(exit.code, 0);
  assert.equal(runtime.isRunning(), false);
});

test('stop() escalates to SIGKILL after stopTimeoutMs and resolves', async () => {
  const child = createFakeChild(); // ignores SIGTERM
  const { runtime } = createRuntime(child, { stopTimeoutMs: 25 });
  await runtime.start();

  const first = runtime.stop();
  const second = runtime.stop();
  assert.equal(first, second);
  await first;

  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(runtime.isRunning(), false);
});

test('stop() resolves when the child is already gone', async () => {
  const child = createFakeChild();
  const { runtime } = createRuntime(child);
  await runtime.start();

  const fatalPromise = once(runtime, 'fatal');
  child.emit('exit', 0, null);
  await fatalPromise;

  await runtime.stop();
  assert.deepEqual(child.killSignals, []);
});

test('start() can be called again after an unexpected fatal exit', async () => {
  const firstChild = createFakeChild();
  const secondChild = createFakeChild();
  const children = [firstChild, secondChild];
  let index = 0;
  const runtime = new HarnessRuntime({
    command: '/usr/bin/dsh',
    args: ['web'],
    stopTimeoutMs: 25,
    spawn: () => children[index++],
  });

  await runtime.start();
  const fatalPromise = once(runtime, 'fatal');
  firstChild.emit('exit', 1, null);
  await fatalPromise;
  assert.equal(runtime.isRunning(), false);

  await runtime.start();
  assert.equal(index, 2);
  assert.equal(runtime.isRunning(), true);
  assert.equal(runtime.readyInfo, null);
});

test('stop() before ready still emits exit with expected=true', async () => {
  const child = createFakeChild();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('exit', 0, null));
    return true;
  };
  const { runtime } = createRuntime(child);
  await runtime.start();

  const exitPromise = once(runtime, 'exit');
  await runtime.stop();
  const [exit] = await exitPromise;

  assert.equal(exit.expected, true);
  assert.equal(runtime.isRunning(), false);
});

test('a spawn seam that throws emits fatal and rejects start()', async () => {
  const spawnError = new Error('EACCES');
  const runtime = new HarnessRuntime({
    command: '/usr/bin/dsh',
    args: ['web'],
    stopTimeoutMs: 25,
    spawn: () => {
      throw spawnError;
    },
  });

  const fatalPromise = once(runtime, 'fatal');
  await assert.rejects(runtime.start(), spawnError);
  const [fatal] = await fatalPromise;

  assert.equal(fatal.error, spawnError);
  assert.match(fatal.message, /failed to spawn/);
  assert.equal(runtime.isRunning(), false);
});

test('keeps only the last 200 log lines', async () => {
  const child = createFakeChild();
  const { runtime } = createRuntime(child);
  await runtime.start();

  const payload = `${Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n')}\n`;
  child.stdout.emit('data', payload);

  const fatalPromise = once(runtime, 'fatal');
  child.emit('exit', 3, null);
  const [fatal] = await fatalPromise;

  const tailLines = fatal.logTail.split('\n');
  assert.equal(tailLines.length, 200);
  assert.equal(tailLines[0], 'line-50');
  assert.equal(tailLines[199], 'line-249');
  assert.equal(runtime.getLogTailLines().length, 200);
});

test('restart() stops the old child and starts a new one', async () => {
  const firstChild = createFakeChild();
  firstChild.kill = (signal) => {
    firstChild.killSignals.push(signal);
    if (signal === 'SIGTERM') setImmediate(() => firstChild.emit('exit', 0, null));
    return true;
  };
  const secondChild = createFakeChild();
  const children = [firstChild, secondChild];
  let index = 0;

  const runtime = new HarnessRuntime({
    command: '/usr/bin/dsh',
    args: ['web'],
    stopTimeoutMs: 25,
    spawn: () => children[index++],
  });

  await runtime.start();
  await runtime.restart();

  assert.equal(index, 2);
  assert.equal(runtime.isRunning(), true);
  assert.equal(runtime._child, secondChild);
});
