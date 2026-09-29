'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = require('../../src/main/main');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

test('buildDshArgs builds the managed child arguments', () => {
  assert.deepEqual(main.buildDshArgs({ host: '127.0.0.1', port: 0 }), [
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  assert.deepEqual(main.buildDshArgs({ host: '127.0.0.2', port: 8123 }), [
    'web',
    '--no-open',
    '--host',
    '127.0.0.2',
    '--port',
    '8123',
  ]);
  assert.deepEqual(main.buildDshArgs({}), ['web', '--no-open', '--host', '127.0.0.1', '--port', '0']);
});

test('applyGpuFallback appends the ladder switches and handles extra switches', () => {
  const appendSwitch = (name, value) => {
    appended.push(value === undefined ? name : `${name}=${value}`);
  };
  const appended = [];
  const commandLine = { appendSwitch };
  let hardwareDisabled = false;
  const fakeApp = { disableHardwareAcceleration: () => { hardwareDisabled = true; } };

  main.applyGpuFallback({ commandLine, app: fakeApp, level: 'default', extraSwitches: [] });
  assert.deepEqual(appended, []);
  assert.equal(hardwareDisabled, false);

  appended.length = 0;
  main.applyGpuFallback({ commandLine, app: fakeApp, level: 'sandbox-disabled', extraSwitches: ['--foo=bar', 'baz'] });
  assert.deepEqual(appended, ['disable-gpu-sandbox', 'foo=bar', 'baz']);
  assert.equal(hardwareDisabled, false);

  appended.length = 0;
  main.applyGpuFallback({ commandLine, app: fakeApp, level: 'gpu-disabled' });
  assert.deepEqual(appended, ['disable-gpu-sandbox', 'disable-gpu', 'disable-gpu-compositing']);
  assert.equal(hardwareDisabled, true);
});

test('isLoopbackUrl accepts only loopback http(s) URLs', () => {
  assert.equal(main.isLoopbackUrl('http://127.0.0.1:4321/?token=x'), true);
  assert.equal(main.isLoopbackUrl('http://127.0.0.2:80/'), true);
  assert.equal(main.isLoopbackUrl('http://localhost:8080/'), true);
  assert.equal(main.isLoopbackUrl('http://[::1]:8080/'), true);
  assert.equal(main.isLoopbackUrl('https://127.0.0.1:443/'), true);
  assert.equal(main.isLoopbackUrl('http://example.com/'), false);
  assert.equal(main.isLoopbackUrl('http://127.0.0.1.evil.example/'), false);
  assert.equal(main.isLoopbackUrl('file:///tmp/x.html'), false);
  assert.equal(main.isLoopbackUrl('javascript:alert(1)'), false);
  assert.equal(main.isLoopbackUrl(''), false);
});

test('normalizeSmokeSnapshot produces the acceptance snapshot fields', () => {
  const snapshot = main.normalizeSmokeSnapshot({
    title: 'DeepSeek Harness',
    url: 'http://127.0.0.1:4321/?token=secret',
    readyState: 'complete',
    bodyTextLength: 42,
    appRootFound: true,
  });
  assert.deepEqual(snapshot, {
    ok: true,
    title: 'DeepSeek Harness',
    url: 'http://127.0.0.1:4321/?token=secret',
    readyState: 'complete',
    bodyTextLength: 42,
    appRootFound: true,
  });

  const notReady = main.normalizeSmokeSnapshot({ readyState: 'loading' }, 'http://127.0.0.1:1/');
  assert.equal(notReady.ok, false);
  assert.equal(notReady.url, 'http://127.0.0.1:1/');
  assert.equal(notReady.appRootFound, false);

  const bodyOnly = main.normalizeSmokeSnapshot({ readyState: 'complete', bodyTextLength: 3 });
  assert.equal(bodyOnly.appRootFound, true);
  assert.equal(bodyOnly.ok, true);

  const junk = main.normalizeSmokeSnapshot(null, '');
  assert.deepEqual(junk, {
    ok: false,
    title: '',
    url: '',
    readyState: '',
    bodyTextLength: 0,
    appRootFound: false,
  });
});

test('smokeSnapshotScript probes the documented DSH shell markers', () => {
  const script = main.smokeSnapshotScript();
  assert.equal(script, main.SMOKE_SNAPSHOT_SCRIPT);
  assert.match(script, /\[data-slot\], #root/);
  assert.match(script, /bodyTextLength/);
  assert.match(script, /appRootFound/);
  assert.match(script, /document\.readyState/);
});

test('createRuntimeLogger redacts auth tokens before they reach the log', () => {
  const seen = [];
  const base = {
    debug: (...a) => seen.push(['debug', ...a]),
    info: (...a) => seen.push(['info', ...a]),
    warn: (...a) => seen.push(['warn', ...a]),
    error: (...a) => seen.push(['error', ...a]),
  };
  const wrapped = main.createRuntimeLogger(base);
  wrapped.info('runtime: ready at http://127.0.0.1:1/?token=secret', { token: 'object untouched' });
  assert.equal(seen[0][0], 'info');
  assert.equal(seen[0][1], 'runtime: ready at http://127.0.0.1:1/?token=<redacted>');
  assert.deepEqual(seen[0][2], { token: 'object untouched' });
});

test('run rejects a missing Electron module instead of crashing ambiguously', () => {
  assert.throws(() => main.run({}), TypeError);
  assert.throws(() => main.run(null), TypeError);
});

test('renderer pages are local-only and declare a deny-by-default CSP', () => {
  const rendererDir = path.join(PROJECT_ROOT, 'src', 'renderer');
  const loading = fs.readFileSync(path.join(rendererDir, 'loading.html'), 'utf8');
  const error = fs.readFileSync(path.join(rendererDir, 'error.html'), 'utf8');

  for (const page of [loading, error]) {
    assert.match(page, /http-equiv="Content-Security-Policy"/);
    assert.match(page, /default-src 'none'/);
    assert.doesNotMatch(page, /src="https?:/);
    assert.doesNotMatch(page, /href="https?:/);
  }
  assert.match(loading, /Starting DeepSeek Harness/);
  assert.match(error, /window\.dshShell/);
  assert.match(error, /params\.get\('message'\)/);
  assert.doesNotMatch(error, /src="\.\/error\.js"/);
});

test('preload exposes only the validated retry/quit surface', () => {
  const preload = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('dshShell'/);
  assert.match(preload, new RegExp(main.RETRY_CHANNEL));
  assert.match(preload, new RegExp(main.QUIT_CHANNEL));
  assert.doesNotMatch(preload, /require\('node:fs'\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\b/);
});
