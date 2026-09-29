/**
 * Unit tests for the packaged runtime-module resolver in main.js.
 *
 * electron-builder excludes src/main/runtime from app.asar when those files
 * are also copied to resources/main/runtime via extraResources, so the loader
 * must try __dirname/runtime first and then process.resourcesPath/main/runtime.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const main = require('../../src/main/main');

function moduleNotFound(request) {
  const error = new Error(`Cannot find module '${request}'`);
  error.code = 'MODULE_NOT_FOUND';
  return error;
}

const BASE_DIR = path.join('/', 'app', 'src', 'main');
const RESOURCES = path.join('/', 'app', 'resources');
const DEV_RUNTIME = path.join(BASE_DIR, 'runtime', 'harness-runtime');
const DEV_HEALTH = path.join(BASE_DIR, 'runtime', 'health');
const PACKAGED_RUNTIME = path.join(RESOURCES, 'main', 'runtime', 'harness-runtime');
const PACKAGED_HEALTH = path.join(RESOURCES, 'main', 'runtime', 'health');

test('runtimeModuleCandidates builds dev then packaged candidates', () => {
  assert.deepEqual(
    main.runtimeModuleCandidates('harness-runtime', { baseDir: BASE_DIR, resourcesPath: RESOURCES }),
    [DEV_RUNTIME, PACKAGED_RUNTIME],
  );
  assert.deepEqual(
    main.runtimeModuleCandidates('health', { baseDir: BASE_DIR, resourcesPath: '' }),
    [DEV_HEALTH],
  );
  assert.deepEqual(
    main.runtimeModuleCandidates('health', { baseDir: BASE_DIR, resourcesPath: null }),
    [DEV_HEALTH],
  );
});

test('requireRuntimeConstructor uses the dev path first and returns the class', () => {
  const calls = [];
  const HarnessRuntime = class HarnessRuntime {};
  const requireFn = (request) => {
    calls.push(request);
    if (request === DEV_RUNTIME) return { HarnessRuntime };
    throw moduleNotFound(request);
  };

  const resolved = main.requireRuntimeConstructor({ requireFn, baseDir: BASE_DIR, resourcesPath: RESOURCES });
  assert.equal(resolved, HarnessRuntime);
  assert.deepEqual(calls, [DEV_RUNTIME], 'packaged fallback must not be touched when dev path works');
});

test('requireRuntimeConstructor falls back to resources/main/runtime when dev path is missing', () => {
  const calls = [];
  const HarnessRuntime = class HarnessRuntime {};
  const requireFn = (request) => {
    calls.push(request);
    if (request === DEV_RUNTIME) throw moduleNotFound(request);
    if (request === PACKAGED_RUNTIME) return { HarnessRuntime };
    throw moduleNotFound(request);
  };

  const resolved = main.requireRuntimeConstructor({ requireFn, baseDir: BASE_DIR, resourcesPath: RESOURCES });
  assert.equal(resolved, HarnessRuntime);
  assert.deepEqual(calls, [DEV_RUNTIME, PACKAGED_RUNTIME]);
});

test('missing both runtime candidates throws a clear MODULE_NOT_FOUND error', () => {
  const calls = [];
  const requireFn = (request) => {
    calls.push(request);
    throw moduleNotFound(request);
  };

  assert.throws(
    () => main.requireRuntimeConstructor({ requireFn, baseDir: BASE_DIR, resourcesPath: RESOURCES }),
    (error) => {
      assert.equal(error.code, 'MODULE_NOT_FOUND');
      assert.match(error.message, /Cannot find runtime module 'harness-runtime'/);
      assert.match(error.message, /tried/);
      assert.ok(error.cause, 'original resolution error is preserved as cause');
      return true;
    },
  );
  assert.deepEqual(calls, [DEV_RUNTIME, PACKAGED_RUNTIME]);
});

test('non-MODULE_NOT_FOUND errors propagate immediately without trying the fallback', () => {
  const calls = [];
  const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const requireFn = (request) => {
    calls.push(request);
    throw accessError;
  };

  assert.throws(
    () => main.requireRuntimeConstructor({ requireFn, baseDir: BASE_DIR, resourcesPath: RESOURCES }),
    (error) => error === accessError,
  );
  assert.deepEqual(calls, [DEV_RUNTIME], 'a real module error must not be masked by the fallback');
});

test('without resourcesPath only the dev candidate is attempted', () => {
  const calls = [];
  const requireFn = (request) => {
    calls.push(request);
    throw moduleNotFound(request);
  };

  assert.throws(
    () => main.loadRuntimeModule('health', { requireFn, baseDir: BASE_DIR, resourcesPath: undefined }),
    /Cannot find runtime module 'health'/,
  );
  assert.deepEqual(calls, [DEV_HEALTH]);
});

test('requireWaitForHealth resolves dev and packaged candidates and preserves errors', () => {
  const waitForHealth = () => {};

  const devResolved = main.requireWaitForHealth({
    requireFn: (request) => {
      if (request === DEV_HEALTH) return { waitForHealth };
      throw moduleNotFound(request);
    },
    baseDir: BASE_DIR,
    resourcesPath: RESOURCES,
  });
  assert.equal(devResolved, waitForHealth);

  const packagedResolved = main.requireWaitForHealth({
    requireFn: (request) => {
      if (request === PACKAGED_HEALTH) return waitForHealth;
      throw moduleNotFound(request);
    },
    baseDir: BASE_DIR,
    resourcesPath: RESOURCES,
  });
  assert.equal(packagedResolved, waitForHealth);

  assert.throws(
    () => main.requireWaitForHealth({
      requireFn: () => { throw moduleNotFound('health'); },
      baseDir: BASE_DIR,
      resourcesPath: RESOURCES,
    }),
    /Cannot find runtime module 'health'/,
  );
});

test('helpers reject modules with the wrong export shape', () => {
  assert.throws(
    () => main.requireRuntimeConstructor({
      requireFn: () => ({}),
      baseDir: BASE_DIR,
      resourcesPath: RESOURCES,
    }),
    /does not export a constructor/,
  );
  assert.throws(
    () => main.requireWaitForHealth({
      requireFn: () => ({}),
      baseDir: BASE_DIR,
      resourcesPath: RESOURCES,
    }),
    /does not export waitForHealth/,
  );
});

test('real Node require loads the packaged extraResources fallback layout', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-resolver-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const runtimeDir = path.join(tempDir, 'resources', 'main', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'harness-runtime.js'),
    "'use strict'; module.exports = { HarnessRuntime: class PackagedRuntime {} };\n",
  );
  fs.writeFileSync(
    path.join(runtimeDir, 'health.js'),
    "'use strict'; module.exports = { waitForHealth: () => 'ok' };\n",
  );

  const missingDevBase = path.join(tempDir, 'not-present-src-main');
  const HarnessRuntime = main.requireRuntimeConstructor({
    baseDir: missingDevBase,
    resourcesPath: path.join(tempDir, 'resources'),
  });
  assert.equal(HarnessRuntime.name, 'PackagedRuntime');

  const waitForHealth = main.requireWaitForHealth({
    baseDir: missingDevBase,
    resourcesPath: path.join(tempDir, 'resources'),
  });
  assert.equal(waitForHealth(), 'ok');
});

test('real repository layout resolves both runtime modules', () => {
  assert.equal(typeof main.requireRuntimeConstructor(), 'function');
  assert.equal(typeof main.requireWaitForHealth(), 'function');
});
