/**
 * Independent adversarial tests for the runtime contract (ARCHITECTURE.md §2).
 *
 * These intentionally re-derive boundaries instead of trusting test/runtime/**.
 * The HarnessRuntime cases below use REAL child processes (node -e scripts),
 * not the injected fake-child seam, so SIGTERM/SIGKILL escalation and orphan
 * cleanup are observed against the actual kernel.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { HarnessRuntime } = require('../../src/main/runtime/harness-runtime');
const { parseReadyUrl } = require('../../src/main/runtime/ready-url');
const { waitForHealth } = require('../../src/main/runtime/health');

const READY = 'dsh web: http://127.0.0.1:45678/?token=real-token';

function processExists(pid) {
  try {
    fs.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

function realRuntime(script, options = {}) {
  return new HarnessRuntime({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    env: { ...process.env },
    logger: options.logger,
    stopTimeoutMs: options.stopTimeoutMs === undefined ? 500 : options.stopTimeoutMs,
  });
}

async function stopQuietly(runtime) {
  if (!runtime.isRunning()) return;
  try {
    await runtime.stop();
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// parseReadyUrl boundaries
// ---------------------------------------------------------------------------

test('parseReadyUrl: independent edge-case matrix', () => {
  const exact = parseReadyUrl(READY);
  assert.deepEqual(exact, {
    url: 'http://127.0.0.1:45678/?token=real-token',
    host: '127.0.0.1',
    port: 45678,
    token: 'real-token',
  });

  // Boundary ports.
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:1/?token=x').port, 1);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:65535/?token=x').port, 65535);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:0/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:65536/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:00000/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:-1/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:+80/?token=x'), null);

  // Surrounding text / whitespace / ANSI.
  assert.equal(parseReadyUrl(`log: ${READY} trailing`).token, 'real-token');
  assert.equal(parseReadyUrl(`dsh\tweb:\thttp://127.0.0.1:45678/?token=x`).port, 45678);
  assert.equal(parseReadyUrl('\u001b[32mdsh web: http://127.0.0.1:45678/?token=ansi\u001b[0m').token, 'ansi');
  assert.equal(parseReadyUrl(`boot\r${READY}\r`).token, 'real-token');
  // Case sensitivity is part of the exact output contract.
  assert.equal(parseReadyUrl('DSH WEB: http://127.0.0.1:45678/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web : http://127.0.0.1:45678/?token=x'), null);

  // Host must be the exact IPv4 loopback literal.
  assert.equal(parseReadyUrl('dsh web: http://localhost:45678/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1.:45678/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: http://user@127.0.0.1:45678/?token=x'), null);
  assert.equal(parseReadyUrl('dsh web: https://127.0.0.1:45678/?token=x'), null);

  // Token terminates at query separators / whitespace / closing punctuation.
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=abc&x=1'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=abc#frag'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=abc?x=1').token, 'abc');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=abc.').token, 'abc');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=abc)').token, 'abc');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=a.b.c').token, 'a.b.c');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token=.'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?token='), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:45678/?notoken=x'), null);

  // Multiple occurrences: the first well-formed URL wins.
  const two = parseReadyUrl(`${READY} then dsh web: http://127.0.0.1:1/?token=second`);
  assert.equal(two.port, 45678);
  assert.equal(two.token, 'real-token');

  // Non-strings are rejected without throwing.
  for (const value of [null, undefined, 0, 123, {}, [], Buffer.from(READY)]) {
    assert.equal(parseReadyUrl(value), null);
  }
});

// ---------------------------------------------------------------------------
// HarnessRuntime with real child processes
// ---------------------------------------------------------------------------

test('harness runtime: unexpected exit before ready emits fatal with stderr tail', { timeout: 15000 }, async (t) => {
  const runtime = realRuntime("process.stderr.write('boom stderr'); process.stdout.write('partial boot'); process.exit(3)");
  t.after(() => stopQuietly(runtime));
  const fatalPromise = once(runtime, 'fatal');
  await runtime.start();
  const [fatal] = await fatalPromise;
  assert.match(fatal.message, /before ready/);
  assert.match(fatal.message, /code=3/);
  assert.match(fatal.logTail, /boom stderr/);
  assert.match(fatal.logTail, /partial boot/);
  assert.equal(runtime.isRunning(), false);
});

test('harness runtime: exit after ready is unexpected and keeps the parsed URL', { timeout: 15000 }, async (t) => {
  const script = `process.stdout.write(${JSON.stringify(READY)} + '\\n'); setTimeout(() => process.exit(7), 120);`;
  const runtime = realRuntime(script);
  t.after(() => stopQuietly(runtime));
  const readyPromise = once(runtime, 'ready');
  const exitPromise = once(runtime, 'exit');
  await runtime.start();
  const [ready] = await readyPromise;
  assert.equal(ready.token, 'real-token');
  const [exit] = await exitPromise;
  assert.equal(exit.expected, false);
  assert.equal(exit.code, 7);
});

test('harness runtime: stop() SIGTERM is enough for a cooperative child', { timeout: 15000 }, async (t) => {
  const script = `process.on('SIGTERM', () => process.exit(0)); process.stdout.write(${JSON.stringify(READY)} + '\\n'); setInterval(() => {}, 1000);`;
  const runtime = realRuntime(script, { stopTimeoutMs: 3000 });
  t.after(() => stopQuietly(runtime));
  const readyPromise = once(runtime, 'ready');
  const exitPromise = once(runtime, 'exit');
  await runtime.start();
  await readyPromise;

  const started = Date.now();
  await runtime.stop();
  const [exit] = await exitPromise;
  assert.equal(exit.expected, true);
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.ok(Date.now() - started < 3000, 'cooperative child should exit before the SIGKILL timeout');
  assert.equal(runtime.isRunning(), false);
});

test('harness runtime: stop() escalates to real SIGKILL and reaps the child', { timeout: 15000 }, async (t) => {
  const script = `process.on('SIGTERM', () => {}); process.stdout.write('dsh web: http://127.0.0.1:45678/?token=sigkill' + '\\n'); setInterval(() => {}, 1000);`;
  const runtime = realRuntime(script, { stopTimeoutMs: 250 });
  t.after(() => stopQuietly(runtime));
  const readyPromise = once(runtime, 'ready');
  const exitPromise = once(runtime, 'exit');
  const { pid } = await runtime.start();
  await readyPromise;
  assert.equal(typeof pid, 'number');
  assert.equal(processExists(pid), true);

  const started = Date.now();
  await runtime.stop();
  const [exit] = await exitPromise;
  const elapsed = Date.now() - started;
  assert.equal(exit.expected, true);
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(elapsed >= 250, `SIGKILL must wait for the grace period (waited ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `SIGKILL escalation hung (waited ${elapsed}ms)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(processExists(pid), false, `pid ${pid} survived SIGKILL`);
  assert.equal(runtime.isRunning(), false);
});

test('harness runtime: stop() before ready emits expected=true and never fatal', { timeout: 15000 }, async (t) => {
  const runtime = realRuntime('setInterval(() => {}, 1000);', { stopTimeoutMs: 2000 });
  t.after(() => stopQuietly(runtime));
  let sawFatal = false;
  runtime.on('fatal', () => {
    sawFatal = true;
  });
  await runtime.start();
  const exitPromise = once(runtime, 'exit');
  await runtime.stop();
  const [exit] = await exitPromise;
  assert.equal(exit.expected, true);
  assert.equal(sawFatal, false);
  assert.equal(runtime.isRunning(), false);
});

test('harness runtime: a ready line without a trailing newline is not lost', { timeout: 15000 }, async (t) => {
  const runtime = realRuntime(`process.stdout.write(${JSON.stringify('dsh web: http://127.0.0.1:45678/?token=no-newline')}); setTimeout(() => process.exit(0), 80);`);
  t.after(() => stopQuietly(runtime));
  const readyPromise = once(runtime, 'ready');
  const exitPromise = once(runtime, 'exit');
  await runtime.start();
  const [ready] = await readyPromise;
  assert.equal(ready.token, 'no-newline');
  const [exit] = await exitPromise;
  assert.equal(exit.expected, false);
  assert.equal(exit.code, 0);
});

// ---------------------------------------------------------------------------
// waitForHealth boundaries
// ---------------------------------------------------------------------------

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('waitForHealth: resolves on 401 and 303 from a real server', { timeout: 15000 }, async () => {
  await withServer((request, response) => {
    response.statusCode = 401;
    response.end('unauthorized');
  }, async (port) => {
    const response = await waitForHealth(`http://127.0.0.1:${port}/?token=x`, { timeoutMs: 3000, intervalMs: 20 });
    assert.equal(response.statusCode, 401);
    response.resume();
  });

  await withServer((request, response) => {
    response.statusCode = 303;
    response.setHeader('location', '/');
    response.end();
  }, async (port) => {
    const response = await waitForHealth(`http://127.0.0.1:${port}/?token=x`, { timeoutMs: 3000, intervalMs: 20 });
    assert.equal(response.statusCode, 303);
    response.resume();
  });
});

test('waitForHealth: rejects within the deadline on a closed port', { timeout: 15000 }, async () => {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const started = Date.now();
  await assert.rejects(
    waitForHealth(`http://127.0.0.1:${port}/`, { timeoutMs: 200, intervalMs: 25 }),
    /timed out/i,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 190, `timeout fired too early (${elapsed}ms)`);
  assert.ok(elapsed < 3000, `timeout fired far too late (${elapsed}ms)`);
});

test('waitForHealth: invalid timeouts reject with TypeError', async () => {
  await assert.rejects(waitForHealth('http://127.0.0.1:1/', { timeoutMs: -1 }), TypeError);
  await assert.rejects(waitForHealth('http://127.0.0.1:1/', { timeoutMs: NaN }), TypeError);
  await assert.rejects(waitForHealth('http://127.0.0.1:1/', { intervalMs: -5 }), TypeError);
});

test('waitForHealth: a synchronously throwing request seam is retried to timeout', { timeout: 15000 }, async () => {
  let calls = 0;
  await assert.rejects(
    waitForHealth('http://127.0.0.1:1/', {
      timeoutMs: 120,
      intervalMs: 10,
      request: () => {
        calls += 1;
        throw new Error('synthetic failure');
      },
    }),
    /timed out/i,
  );
  assert.ok(calls >= 2, `expected retries, saw ${calls}`);
});
