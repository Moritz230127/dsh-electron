'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  saveConfig,
  resolveDshCommand,
  parseCliOverrides,
  resolveConfigPath,
} = require('../../src/main/config');
const { saveGpuFallbackState } = require('../../src/main/gpu-fallback');

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig returns frozen defaults with no config file', () => {
  const home = makeTempDir('dsh-shell-home-');
  const userData = makeTempDir('dsh-shell-cfg-');
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: home,
    existsSync: () => false,
  });

  assert.equal(config.dshCommand, 'dsh');
  assert.equal(config.dshHome, path.join(home, '.dsh'));
  assert.equal(config.runtimeMode, 'managed');
  assert.equal(config.attachUrl, '');
  assert.equal(config.attachUrlFile, '');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 0);
  assert.equal(config.closeToTray, true);
  assert.equal(config.showDevTools, false);
  assert.deepEqual(config.extraSwitches, []);
  assert.deepEqual(config.gpuFallback, { level: 'default', failures: 0, stableLaunches: 0 });

  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.extraSwitches), true);
  assert.equal(Object.isFrozen(config.gpuFallback), true);
});

test('CLI overrides win and support --flag=value and --flag value', () => {
  const home = makeTempDir('dsh-shell-home-');
  const config = loadConfig({
    argv: [
      '--dsh-home=/cli/home',
      '--dsh-command',
      '/cli/bin/dsh',
      '--port=8123',
      '--attach-url=http://127.0.0.1:8124/?token=t',
      '--dev',
      '--no-tray',
      'ignored-positional',
      '--unknown=1',
    ],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: {},
    homedir: home,
    existsSync: () => false,
  });

  assert.equal(config.dshHome, '/cli/home');
  assert.equal(config.dshCommand, '/cli/bin/dsh');
  assert.equal(config.port, 8123);
  assert.equal(config.attachUrl, 'http://127.0.0.1:8124/?token=t');
  assert.equal(config.runtimeMode, 'attach');
  assert.equal(config.showDevTools, true);
  assert.equal(config.closeToTray, false);
});

test('CLI ignores invalid ports and empty path values', () => {
  const home = makeTempDir('dsh-shell-home-');
  const config = loadConfig({
    argv: ['--port=not-a-port', '--port=99999', '--dsh-home=', '--dsh-command='],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: {},
    homedir: home,
    existsSync: () => false,
  });

  assert.equal(config.port, 0);
  assert.equal(config.dshHome, path.join(home, '.dsh'));
  assert.equal(config.dshCommand, 'dsh');
});

test('config file values load and CLI overrides them', () => {
  const home = makeTempDir('dsh-shell-home-');
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      dshCommand: '/file/bin/dsh',
      dshHome: '/file/home',
      host: '127.0.0.2',
      port: 4321,
      closeToTray: false,
      showDevTools: true,
      extraSwitches: ['alpha', '--beta=1', '', 42],
    }),
  );

  const fromFile = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromFile.dshCommand, '/file/bin/dsh');
  assert.equal(fromFile.dshHome, '/file/home');
  assert.equal(fromFile.host, '127.0.0.2');
  assert.equal(fromFile.port, 4321);
  assert.equal(fromFile.closeToTray, false);
  assert.equal(fromFile.showDevTools, true);
  assert.deepEqual(fromFile.extraSwitches, ['alpha', '--beta=1']);

  const overridden = loadConfig({
    argv: ['--port=4322', '--dev'],
    userDataDir: userData,
    env: {},
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(overridden.port, 4322);
  assert.equal(overridden.showDevTools, true);
  assert.equal(overridden.dshHome, '/file/home');
});

test('file runtimeMode=attach with attachUrl yields attach mode', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ runtimeMode: 'attach', attachUrl: 'http://127.0.0.1:9999/' }),
  );
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(config.runtimeMode, 'attach');
  assert.equal(config.attachUrl, 'http://127.0.0.1:9999/');
});

test('file runtimeMode=managed ignores a stray attachUrl', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ runtimeMode: 'managed', attachUrl: 'http://127.0.0.1:9999/' }),
  );
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(config.runtimeMode, 'managed');
  assert.equal(config.attachUrl, '');
  assert.equal(config.attachUrlFile, '');
});

test('--attach-url-file selects attach mode and CLI beats env/file', () => {
  const home = makeTempDir('dsh-shell-home-');
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ attachUrlFile: '/file/current-url' }),
  );

  const fromEnv = loadConfig({
    argv: [],
    userDataDir: userData,
    env: { DSH_ELECTRON_ATTACH_URL_FILE: '/env/current-url' },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromEnv.attachUrlFile, '/env/current-url');
  assert.equal(fromEnv.runtimeMode, 'attach');

  const fromCliEquals = loadConfig({
    argv: ['--attach-url-file=/cli/current-url'],
    userDataDir: userData,
    env: { DSH_ELECTRON_ATTACH_URL_FILE: '/env/current-url' },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromCliEquals.attachUrlFile, '/cli/current-url');
  assert.equal(fromCliEquals.runtimeMode, 'attach');

  const fromCliSpace = loadConfig({
    argv: ['--attach-url-file', '/cli-space/current-url'],
    userDataDir: userData,
    env: {},
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromCliSpace.attachUrlFile, '/cli-space/current-url');
  assert.equal(fromCliSpace.runtimeMode, 'attach');
});

test('attachUrlFile from config.json forces attach even with runtimeMode managed', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ runtimeMode: 'managed', attachUrlFile: '/file/current-url' }),
  );
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(config.attachUrlFile, '/file/current-url');
  assert.equal(config.runtimeMode, 'attach');
});

test('no attach settings keeps managed mode', () => {
  const config = loadConfig({
    argv: [],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(config.attachUrlFile, '');
  assert.equal(config.runtimeMode, 'managed');
});

test('env overrides: DSH_ELECTRON_HOME, DSH_ELECTRON_CONFIG, DSH_ELECTRON_USER_DATA, DSH_HOME', () => {
  const home = makeTempDir('dsh-shell-home-');
  const fromAppHome = loadConfig({
    argv: [],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: { DSH_ELECTRON_HOME: '/env/app-home' },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromAppHome.dshHome, '/env/app-home');

  const fromGenericHome = loadConfig({
    argv: [],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: { DSH_HOME: '/env/generic-home' },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromGenericHome.dshHome, '/env/generic-home');

  const explicitConfig = path.join(makeTempDir('dsh-shell-cfg-'), 'custom-config.json');
  fs.writeFileSync(explicitConfig, JSON.stringify({ port: 7777 }));
  const fromExplicit = loadConfig({
    argv: [],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: { DSH_ELECTRON_CONFIG: explicitConfig },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromExplicit.port, 7777);

  const envUserData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(path.join(envUserData, 'config.json'), JSON.stringify({ host: '127.0.0.3' }));
  const fromUserData = loadConfig({
    argv: [],
    env: { DSH_ELECTRON_USER_DATA: envUserData },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(fromUserData.host, '127.0.0.3');

  const cliBeatsEnv = loadConfig({
    argv: ['--dsh-home=/cli-home'],
    userDataDir: makeTempDir('dsh-shell-cfg-'),
    env: { DSH_ELECTRON_HOME: '/env/app-home' },
    homedir: home,
    existsSync: () => false,
  });
  assert.equal(cliBeatsEnv.dshHome, '/cli-home');
});

test('gpu-fallback.json is surfaced on the frozen config object', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  saveGpuFallbackState(userData, { level: 'sandbox-disabled', failures: 2, stableLaunches: 1 });
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.deepEqual(config.gpuFallback, { level: 'sandbox-disabled', failures: 2, stableLaunches: 1 });
  assert.equal(Object.isFrozen(config.gpuFallback), true);
});

test('malformed config.json and gpu-fallback.json fall back to defaults', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  fs.writeFileSync(path.join(userData, 'config.json'), '{not json');
  fs.writeFileSync(path.join(userData, 'gpu-fallback.json'), '{not json either');
  const config = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(config.port, 0);
  assert.equal(config.dshCommand, 'dsh');
  assert.deepEqual(config.gpuFallback, { level: 'default', failures: 0, stableLaunches: 0 });
});

test('saveConfig writes atomically and round-trips core fields', () => {
  const userData = makeTempDir('dsh-shell-cfg-');
  const config = {
    dshCommand: '/custom/bin/dsh',
    dshHome: '/custom/home',
    runtimeMode: 'attach',
    attachUrl: 'http://127.0.0.1:7777/',
    attachUrlFile: '/tmp/host/current-url',
    host: '127.0.0.2',
    port: 7777,
    closeToTray: false,
    showDevTools: true,
    extraSwitches: ['alpha', 'beta=1'],
    gpuFallback: { level: 'default', failures: 0, stableLaunches: 0 },
  };

  const filePath = saveConfig(userData, config);
  assert.equal(filePath, path.join(userData, 'config.json'));
  assert.deepEqual(fs.readdirSync(userData), ['config.json']);

  const reloaded = loadConfig({
    argv: [],
    userDataDir: userData,
    env: {},
    homedir: makeTempDir('dsh-shell-home-'),
    existsSync: () => false,
  });
  assert.equal(reloaded.dshCommand, '/custom/bin/dsh');
  assert.equal(reloaded.dshHome, '/custom/home');
  assert.equal(reloaded.runtimeMode, 'attach');
  assert.equal(reloaded.attachUrl, 'http://127.0.0.1:7777/');
  assert.equal(reloaded.attachUrlFile, '/tmp/host/current-url');
  assert.equal(reloaded.host, '127.0.0.2');
  assert.equal(reloaded.port, 7777);
  assert.equal(reloaded.closeToTray, false);
  assert.equal(reloaded.showDevTools, true);
  assert.deepEqual(reloaded.extraSwitches, ['alpha', 'beta=1']);
});

test('saveConfig honours DSH_ELECTRON_CONFIG', () => {
  const dir = makeTempDir('dsh-shell-cfg-');
  const customPath = path.join(dir, 'nested', 'custom.json');
  const written = saveConfig(dir, { port: 1234 }, { env: { DSH_ELECTRON_CONFIG: customPath } });
  assert.equal(written, customPath);
  assert.equal(JSON.parse(fs.readFileSync(customPath, 'utf8')).port, 1234);
});

test('parseCliOverrides is exported and conservative', () => {
  assert.deepEqual(parseCliOverrides(['--dev', '--no-tray', '--port', '8080', '--junk']), {
    showDevTools: true,
    closeToTray: false,
    port: 8080,
  });
  assert.deepEqual(parseCliOverrides(['--port=-1', '--port=abc']), {});
  assert.deepEqual(parseCliOverrides(null), {});
});

test('resolveConfigPath prefers DSH_ELECTRON_CONFIG', () => {
  assert.equal(
    resolveConfigPath({ userDataDir: '/data', env: { DSH_ELECTRON_CONFIG: '/explicit/config.json' } }),
    '/explicit/config.json',
  );
  assert.equal(resolveConfigPath({ userDataDir: '/data', env: {} }), path.join('/data', 'config.json'));
  assert.equal(resolveConfigPath({ env: {} }), null);
});

test('resolveDshCommand finds the first existing candidate then falls back to PATH lookup', () => {
  const home = '/home/tester';
  const first = path.join(home, '.npm-global', 'bin', 'dsh');
  assert.equal(resolveDshCommand({ homedir: home, existsSync: (p) => p === first }), first);
  assert.equal(resolveDshCommand({ homedir: home, existsSync: (p) => p === '/usr/bin/dsh' }), '/usr/bin/dsh');
  assert.equal(resolveDshCommand({ homedir: home, existsSync: () => false }), 'dsh');
  assert.equal(
    resolveDshCommand({
      homedir: home,
      existsSync: (p) => {
        if (p === first) throw new Error('EACCES');
        return p === '/usr/local/bin/dsh';
      },
    }),
    '/usr/local/bin/dsh',
  );
});
