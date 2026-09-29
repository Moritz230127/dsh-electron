'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DEFAULTS,
  loadConfig,
  normalizeConfig,
  resolveDshCommand,
} = require('../../src/host/config.js');

function fakeFs(files = {}, existingPaths = []) {
  const fileMap = new Map(Object.entries(files));
  const existing = new Set(existingPaths);
  return {
    existsSync: (target) => existing.has(target) || fileMap.has(target),
    readFileSync: (target) => {
      if (fileMap.has(target)) return fileMap.get(target);
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

test('normalizeConfig fills contract defaults and env-derived paths', () => {
  const config = normalizeConfig(
    {},
    { env: {}, homedir: '/home/tester', uid: 4242, fs: fakeFs() },
  );

  assert.equal(config.stateDir, '/home/tester/.local/state/dsh-host');
  assert.equal(config.runtimeDir, '/run/user/4242/dsh-host');
  assert.equal(config.dshHome, '/home/tester/.dsh');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.readyTimeoutMs, DEFAULTS.readyTimeoutMs);
  assert.equal(config.healthIntervalMs, DEFAULTS.healthIntervalMs);
  assert.equal(config.healthFailureThreshold, DEFAULTS.healthFailureThreshold);
  assert.equal(config.stableSecondsForPromotion, DEFAULTS.stableSecondsForPromotion);
  assert.equal(config.restartWindowMs, DEFAULTS.restartWindowMs);
  assert.equal(config.maxChildRestarts, DEFAULTS.maxChildRestarts);
  assert.equal(config.fallbackRetrySystemAfterMs, DEFAULTS.fallbackRetrySystemAfterMs);
  assert.equal(config.snapshotEnabled, true);
  assert.equal(config.electronAppPath, '');
  assert.equal(config.dshCommand, 'dsh');
  assert.deepEqual(config.electronArgs, []);
});

test('normalizeConfig coerces numbers, rejects bad values and honours explicit paths', () => {
  const config = normalizeConfig(
    {
      dshCommand: '/opt/dsh/bin/dsh',
      dshHome: '/srv/dsh-home',
      stateDir: '/srv/state',
      runtimeDir: '/srv/run',
      electronExecutable: '/opt/dsh-electron',
      electronArgs: ['--foo', '  ', 42, '--bar'],
      readyTimeoutMs: '1234',
      healthFailureThreshold: 0,
      maxChildRestarts: '4',
      snapshotEnabled: false,
    },
    { env: {}, homedir: '/home/tester', uid: 7, fs: fakeFs() },
  );

  assert.equal(config.dshCommand, '/opt/dsh/bin/dsh');
  assert.equal(config.dshHome, '/srv/dsh-home');
  assert.equal(config.stateDir, '/srv/state');
  assert.equal(config.runtimeDir, '/srv/run');
  assert.equal(config.electronExecutable, '/opt/dsh-electron');
  assert.deepEqual(config.electronArgs, ['--foo', '--bar']);
  assert.equal(config.readyTimeoutMs, 1234);
  assert.equal(config.maxChildRestarts, 4);
  assert.equal(config.snapshotEnabled, false);
  // Invalid (below minimum) falls back to the default.
  assert.equal(config.healthFailureThreshold, DEFAULTS.healthFailureThreshold);
});

test('resolveDshCommand picks the first existing candidate, else PATH name', () => {
  const found = resolveDshCommand({
    env: {},
    homedir: '/home/tester',
    existsSync: (target) => target === '/usr/local/bin/dsh',
  });
  assert.equal(found, '/usr/local/bin/dsh');
  assert.equal(resolveDshCommand({ env: {}, homedir: '/home/tester', existsSync: () => false }), 'dsh');
  assert.equal(
    resolveDshCommand({ env: { DSH_HOST_DSH_COMMAND: '/custom/dsh' }, homedir: '/home/tester', existsSync: () => false }),
    '/custom/dsh',
  );
});

test('electronAppPath resolves from config, DSH_HOST_ELECTRON_APP or DSH_HOST_APP_ROOT', () => {
  const fromConfig = normalizeConfig(
    { electronAppPath: '/app/config' },
    { env: {}, homedir: '/h', uid: 1, fs: fakeFs() },
  );
  assert.equal(fromConfig.electronAppPath, '/app/config');

  const fromAppRootEnv = loadConfig({
    env: { DSH_HOST_APP_ROOT: '/app/root' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs(),
  });
  assert.equal(fromAppRootEnv.electronAppPath, '/app/root');

  const fromElectronAppEnv = loadConfig({
    env: { DSH_HOST_ELECTRON_APP: '/app/specific', DSH_HOST_APP_ROOT: '/app/root' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs(),
  });
  assert.equal(fromElectronAppEnv.electronAppPath, '/app/specific');

  const fromFile = loadConfig({
    env: { DSH_HOST_STATE_DIR: '/srv/state' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs({ '/srv/state/config.json': JSON.stringify({ electronAppPath: '/app/file' }) }),
  });
  assert.equal(fromFile.electronAppPath, '/app/file');
});

test('loadConfig merges config file then env overrides', () => {
  const stateDir = '/srv/dsh-host';
  const configPath = path.join(stateDir, 'config.json');
  const fsModule = fakeFs(
    {
      [configPath]: JSON.stringify({
        stateDir,
        dshHome: '/from-file/home',
        readyTimeoutMs: 555,
        snapshotEnabled: true,
        electronExecutable: '/file/electron',
      }),
    },
    [],
  );

  const config = loadConfig({
    env: {
      DSH_HOST_STATE_DIR: stateDir,
      DSH_HOME: '/from-env/home',
      DSH_HOST_ELECTRON: '/env/electron',
      DSH_HOST_DISABLE_SNAPSHOT: '1',
      DSH_HOST_MAX_CHILD_RESTARTS: '2',
    },
    homedir: '/home/tester',
    uid: 9,
    fs: fsModule,
  });

  assert.equal(config.stateDir, stateDir);
  assert.equal(config.dshHome, '/from-env/home');
  assert.equal(config.electronExecutable, '/env/electron');
  assert.equal(config.readyTimeoutMs, 555);
  assert.equal(config.maxChildRestarts, 2);
  assert.equal(config.snapshotEnabled, false);
});

test('snapshotEnabled can be disabled via config or env flags', () => {
  const fromConfig = normalizeConfig({ snapshotEnabled: false }, { env: {}, homedir: '/h', uid: 1, fs: fakeFs() });
  assert.equal(fromConfig.snapshotEnabled, false);

  const disableEnv = loadConfig({
    env: { DSH_HOST_DISABLE_SNAPSHOT: '1' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs(),
  });
  assert.equal(disableEnv.snapshotEnabled, false);

  const zeroEnv = loadConfig({
    env: { DSH_HOST_SNAPSHOT: '0' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs(),
  });
  assert.equal(zeroEnv.snapshotEnabled, false);

  const reEnable = normalizeConfig({ snapshotEnabled: false }, { env: { DSH_HOST_SNAPSHOT: '1' }, homedir: '/h', uid: 1, fs: fakeFs() });
  assert.equal(reEnable.snapshotEnabled, false, 'normalizeConfig keeps explicit config authoritative');

  const normalizeEnv = normalizeConfig({}, { env: { DSH_HOST_DISABLE_SNAPSHOT: '1' }, homedir: '/h', uid: 1, fs: fakeFs() });
  assert.equal(normalizeEnv.snapshotEnabled, false, 'normalizeConfig honours the env flag when config is silent');

  const fileDisabled = loadConfig({
    env: { DSH_HOST_SNAPSHOT: '1', DSH_HOST_STATE_DIR: '/srv/state' },
    homedir: '/home/tester',
    uid: 1,
    fs: fakeFs({
      '/srv/state/config.json': JSON.stringify({ snapshotEnabled: false }),
    }),
  });
  assert.equal(fileDisabled.snapshotEnabled, true, 'env snapshot flag overrides config file');
});
