'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  decideRuntimeChoice,
  discoverDisplayEnvironment,
  planChildRestart,
  promoteSnapshot,
  pruneSnapshots,
  readJsonFile,
  readUrlFile,
  resolveElectronLaunch,
  resolveRuntimeRootFromEntry,
  runtimeVersion,
  writeUrlFileAtomic,
} = require('../../src/host/supervisor.js');

function createMemoryFs(options = {}) {
  const dirs = new Set(options.dirs || []);
  const files = new Map(Object.entries(options.files || {}));
  const mtimes = new Map(options.mtimes || []);
  const ensureDir = (target) => {
    let current = path.isAbsolute(target) ? path.parse(target).root : '';
    for (const part of target.split(path.sep)) {
      if (part.length === 0) continue;
      current = current === '' ? part : path.join(current, part);
      dirs.add(current);
      if (!mtimes.has(current)) mtimes.set(current, 1);
    }
  };
  return {
    dirs,
    files,
    existsSync: (target) => dirs.has(target) || files.has(target),
    mkdirSync: (target) => ensureDir(target),
    rmSync: (target) => {
      dirs.delete(target);
      for (const dir of [...dirs]) if (dir.startsWith(`${target}${path.sep}`)) dirs.delete(dir);
      for (const file of [...files.keys()]) if (file === target || file.startsWith(`${target}${path.sep}`)) files.delete(file);
    },
    renameSync: (from, to) => {
      if (dirs.has(from)) {
        dirs.delete(from);
        dirs.add(to);
        for (const dir of [...dirs]) {
          if (dir.startsWith(`${from}${path.sep}`)) {
            dirs.delete(dir);
            dirs.add(path.join(to, dir.slice(from.length + 1)));
          }
        }
        for (const [file, content] of [...files]) {
          if (file.startsWith(`${from}${path.sep}`)) {
            files.delete(file);
            files.set(path.join(to, file.slice(from.length + 1)), content);
          }
        }
      } else if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
      }
    },
    writeFileSync: (target, content) => {
      files.set(target, content);
    },
    readFileSync: (target) => {
      if (files.has(target)) return files.get(target);
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
    unlinkSync: (target) => {
      files.delete(target);
    },
    chmodSync: () => {},
    readdirSync: (target) => {
      const names = new Set();
      for (const dir of dirs) if (path.dirname(dir) === target) names.add(path.basename(dir));
      for (const file of files.keys()) if (path.dirname(file) === target) names.add(path.basename(file));
      return [...names];
    },
    statSync: (target) => {
      if (files.has(target)) return { isDirectory: () => false, mtimeMs: mtimes.get(target) || 1 };
      if (dirs.has(target)) return { isDirectory: () => true, mtimeMs: mtimes.get(target) || 1 };
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

function createFakeSpawn(handler) {
  const calls = [];
  const spawn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = 9000 + calls.length;
    setImmediate(() => {
      try {
        const result = handler ? handler(call) : { code: 0, signal: null };
        child.emit('exit', result.code, result.signal === undefined ? null : result.signal);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };
  return { calls, spawn };
}

// ---------------------------------------------------------------------------
// resolveRuntimeRootFromEntry / runtimeVersion
// ---------------------------------------------------------------------------

test('resolveRuntimeRootFromEntry follows a symlinked entry to the @deepseek-ai/dsh package root', () => {
  const root = '/prefix/lib/node_modules/@deepseek-ai/dsh';
  const fsModule = {
    realpathSync: (target) => {
      if (target === '/prefix/bin/dsh') return path.join(root, 'lib', 'bin.js');
      throw new Error('ENOENT');
    },
    statSync: () => ({ isDirectory: () => false }),
    readFileSync: (target) => {
      if (target === path.join(root, 'package.json')) {
        return JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' });
      }
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  };

  assert.equal(resolveRuntimeRootFromEntry('/prefix/bin/dsh', { fs: fsModule }), root);
  assert.equal(runtimeVersion(root, { fs: fsModule }), '1.0.0');
});

test('resolveRuntimeRootFromEntry returns null for non-dsh packages and unreadable entries', () => {
  const fsModule = {
    realpathSync: (target) => target,
    statSync: () => ({ isDirectory: () => true }),
    readFileSync: (target) => {
      if (target === '/opt/other/package.json') return JSON.stringify({ name: 'not-dsh', version: '1.0.0' });
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  };
  assert.equal(resolveRuntimeRootFromEntry('/opt/other/lib/bin.js', { fs: fsModule }), null);
  assert.equal(runtimeVersion('/opt/other', { fs: fsModule }), '1.0.0');

  const brokenFs = { realpathSync: () => { throw new Error('ENOENT'); } };
  assert.equal(resolveRuntimeRootFromEntry('/nope/dsh', { fs: brokenFs }), null);
  assert.equal(resolveRuntimeRootFromEntry('', { fs: brokenFs }), null);
});

// ---------------------------------------------------------------------------
// decideRuntimeChoice
// ---------------------------------------------------------------------------

test('decideRuntimeChoice is system-first when there is no recent same-version failure', () => {
  const decision = decideRuntimeChoice({
    systemVersion: '2.0.0',
    knownGood: { version: '1.9.0', root: '/kg', entry: '/kg/lib/bin.js' },
    attempt: null,
    now: 1000,
    retryAfterMs: 86400000,
  });
  assert.equal(decision.source, 'system');
  assert.equal(decision.version, '2.0.0');
});

test('decideRuntimeChoice takes the known-good fast path after a same-version failure', () => {
  const knownGood = { version: '1.9.0', root: '/kg', entry: '/kg/lib/bin.js' };
  const decision = decideRuntimeChoice({
    systemVersion: '2.0.0',
    knownGood,
    attempt: { systemVersion: '2.0.0', failedAt: 900, failureCount: 1 },
    now: 1000,
    retryAfterMs: 5000,
  });
  assert.equal(decision.source, 'known-good');
  assert.equal(decision.reason, 'fast-path-after-failure');
  assert.equal(decision.knownGood, knownGood);
});

test('decideRuntimeChoice retries system when the failure is stale or for another version', () => {
  const knownGood = { version: '1.9.0', root: '/kg', entry: '/kg/lib/bin.js' };
  const stale = decideRuntimeChoice({
    systemVersion: '2.0.0',
    knownGood,
    attempt: { systemVersion: '2.0.0', failedAt: 1000 },
    now: 1000 + 60000,
    retryAfterMs: 5000,
  });
  assert.equal(stale.source, 'system');

  const otherVersion = decideRuntimeChoice({
    systemVersion: '2.1.0',
    knownGood,
    attempt: { systemVersion: '2.0.0', failedAt: 2000 },
    now: 3000,
    retryAfterMs: 86400000,
  });
  assert.equal(otherVersion.source, 'system');
});

test('decideRuntimeChoice skips to known-good when the system runtime cannot resolve', () => {
  const knownGood = { version: '1.0.0', root: '/kg', entry: '/kg/lib/bin.js' };
  const decision = decideRuntimeChoice({ systemVersion: null, knownGood, now: 1 });
  assert.equal(decision.source, 'known-good');
  assert.equal(decision.reason, 'system-unresolved');
  assert.deepEqual(decideRuntimeChoice({ systemVersion: null, knownGood: null, now: 1 }), {
    source: 'system',
    reason: 'system-unresolved',
    version: null,
  });
});

// ---------------------------------------------------------------------------
// planChildRestart
// ---------------------------------------------------------------------------

test('planChildRestart returns exponential backoff capped at 30s', () => {
  const now = 100000;
  assert.equal(planChildRestart({ timestamps: [], now }).delayMs, 1000);
  assert.equal(planChildRestart({ timestamps: [now], now }).delayMs, 2000);
  assert.equal(planChildRestart({ timestamps: [now, now], now }).delayMs, 4000);
  assert.equal(planChildRestart({ timestamps: [now, now, now], now }).delayMs, 8000);
  assert.equal(planChildRestart({ timestamps: [now, now, now, now], now }).delayMs, 16000);
  assert.equal(
    planChildRestart({ timestamps: [now, now, now, now, now, now], now, maxRestarts: 10 }).delayMs,
    30000,
    '16s -> 32s is capped at 30s',
  );
});

test('planChildRestart marks the window budget exhausted and retries at 60s', () => {
  const now = 100000;
  const timestamps = [now, now, now, now, now];
  const plan = planChildRestart({ timestamps, now, maxRestarts: 5, windowMs: 300000 });
  assert.equal(plan.allowed, false);
  assert.equal(plan.count, 5);
  assert.equal(plan.delayMs, 60000);
});

test('planChildRestart ignores timestamps outside the window', () => {
  const now = 100000;
  const plan = planChildRestart({
    timestamps: [now - 400000, now - 1000000, now - 1],
    now,
    maxRestarts: 5,
    windowMs: 300000,
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.count, 1);
  assert.equal(plan.delayMs, 2000);
});

// ---------------------------------------------------------------------------
// resolveElectronLaunch
// ---------------------------------------------------------------------------

test('resolveElectronLaunch prefers config, then env, then packaged, then dev', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const packaged = '/opt/DSH Electron/dsh-electron';
  const devElectron = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');

  // Packaged-style custom executable: no app argument.
  const fromConfig = resolveElectronLaunch({
    config: { electronExecutable: '/custom/dsh-electron', electronArgs: ['--x'] },
    env: {},
    exists: () => true,
  });
  assert.deepEqual(fromConfig, {
    command: '/custom/dsh-electron',
    args: ['--x'],
    source: 'config',
    appPath: null,
  });

  // Packaged-style env executable: no app argument.
  const fromEnv = resolveElectronLaunch({
    config: {},
    env: { DSH_HOST_ELECTRON: '/env/dsh-electron' },
    exists: () => true,
  });
  assert.deepEqual(fromEnv, {
    command: '/env/dsh-electron',
    args: [],
    source: 'env',
    appPath: null,
  });

  const fromPackaged = resolveElectronLaunch({
    config: {},
    env: {},
    exists: (target) => target === packaged,
    platform: 'linux',
  });
  assert.deepEqual(fromPackaged, { command: packaged, args: [], source: 'packaged', appPath: null });

  const fromDev = resolveElectronLaunch({
    config: { electronArgs: ['--dev-arg'] },
    env: { DSH_HOST_DEV_APP: '1' },
    exists: (target) => target === devElectron,
    platform: 'linux',
  });
  assert.equal(fromDev.source, 'dev');
  assert.equal(fromDev.command, devElectron);
  assert.equal(fromDev.appPath, repoRoot);
  assert.deepEqual(fromDev.args, [repoRoot, '--dev-arg']);
});

test('resolveElectronLaunch prepends the app root for dev / plain electron commands', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const devCommand = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');

  // Lead E2E regression: DSH_HOST_ELECTRON points at the electron binary and
  // DSH_HOST_DEV_APP=1 must prepend the app root.
  const devFromEnv = resolveElectronLaunch({
    config: {},
    env: { DSH_HOST_ELECTRON: devCommand, DSH_HOST_DEV_APP: '1' },
    exists: () => true,
  });
  assert.equal(devFromEnv.source, 'env');
  assert.equal(devFromEnv.appPath, repoRoot);
  assert.equal(devFromEnv.args[0], repoRoot);

  // A plain `electron` basename is treated as a dev launch even without the flag.
  const fromAppRoot = resolveElectronLaunch({
    config: {},
    env: { DSH_HOST_ELECTRON: '/env/electron', DSH_HOST_APP_ROOT: '/tmp/dsh-electron-app-root' },
    exists: () => true,
  });
  assert.equal(fromAppRoot.appPath, '/tmp/dsh-electron-app-root');
  assert.equal(fromAppRoot.args[0], '/tmp/dsh-electron-app-root');

  // DSH_HOST_ELECTRON_APP wins over DSH_HOST_APP_ROOT.
  const fromElectronApp = resolveElectronLaunch({
    config: {},
    env: {
      DSH_HOST_ELECTRON: '/env/electron',
      DSH_HOST_ELECTRON_APP: '/app/specific',
      DSH_HOST_APP_ROOT: '/app/root',
    },
    exists: () => true,
  });
  assert.equal(fromElectronApp.args[0], '/app/specific');

  // config.electronAppPath wins over both env app paths.
  const fromConfigApp = resolveElectronLaunch({
    config: { electronExecutable: '/config/electron', electronAppPath: '/config/app' },
    env: { DSH_HOST_APP_ROOT: '/env/app' },
    exists: () => true,
  });
  assert.deepEqual(fromConfigApp, {
    command: '/config/electron',
    args: ['/config/app'],
    source: 'config',
    appPath: '/config/app',
  });

  // A dev flag also adds the app root for a packaged-looking binary path.
  const devFlagPackaged = resolveElectronLaunch({
    config: {},
    env: { DSH_HOST_ELECTRON: '/app/dsh-electron', DSH_HOST_APP_ROOT: '/app', DSH_HOST_DEV_APP: '1' },
    exists: () => true,
  });
  assert.deepEqual(devFlagPackaged.args, ['/app']);
});

test('resolveElectronLaunch returns null when nothing is available or dev mode is off', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  assert.equal(resolveElectronLaunch({ config: {}, env: {}, exists: () => false }), null);

  const devElectron = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
  assert.equal(
    resolveElectronLaunch({
      config: {},
      env: {},
      exists: (target) => target === devElectron,
    }),
    null,
    'dev binary is not used without DSH_HOST_DEV_APP=1',
  );
});

// ---------------------------------------------------------------------------
// discoverDisplayEnvironment
// ---------------------------------------------------------------------------

test('discoverDisplayEnvironment passes env values through', () => {
  const result = discoverDisplayEnvironment({
    env: { WAYLAND_DISPLAY: 'wayland-7', DISPLAY: ':3' },
    fs: { readdirSync: () => [] },
  });
  assert.deepEqual(result, { waylandDisplay: 'wayland-7', display: ':3' });
});

test('discoverDisplayEnvironment discovers the first wayland socket', () => {
  const result = discoverDisplayEnvironment({
    env: {},
    uid: 1000,
    fs: { readdirSync: (target) => (target === '/run/user/1000' ? ['wayland-2', 'wayland-0', 'other'] : []) },
  });
  assert.deepEqual(result, { waylandDisplay: 'wayland-0', display: '' });
});

test('discoverDisplayEnvironment falls back to :0 when Wayland is not usable', () => {
  const result = discoverDisplayEnvironment({
    env: {},
    uid: 1000,
    fs: { readdirSync: () => { throw new Error('ENOENT'); } },
  });
  assert.deepEqual(result, { waylandDisplay: '', display: ':0' });
});

// ---------------------------------------------------------------------------
// URL file writes
// ---------------------------------------------------------------------------

test('writeUrlFileAtomic writes 0600 via tmp+rename and readUrlFile reads it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-url-'));
  try {
    const file = path.join(dir, 'current-url');
    writeUrlFileAtomic(file, 'http://127.0.0.1:4321/?token=tok');
    assert.equal(readUrlFile(file), 'http://127.0.0.1:4321/?token=tok');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['current-url'], 'no tmp file is left behind');
    assert.equal(readUrlFile(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUrlFileAtomic uses a same-directory temp file and rename', () => {
  const operations = [];
  const fsModule = {
    writeFileSync: (target, content, options) => operations.push({ type: 'write', target, content, mode: options.mode }),
    chmodSync: () => {},
    renameSync: (from, to) => operations.push({ type: 'rename', from, to }),
    unlinkSync: () => {},
  };

  writeUrlFileAtomic('/run/dsh-host/current-url', 'http://x', { fs: fsModule });

  assert.equal(operations.length, 2);
  assert.equal(operations[0].type, 'write');
  assert.equal(operations[0].mode, 0o600);
  assert.match(operations[0].target, /^\/run\/dsh-host\/current-url\.tmp-/);
  assert.deepEqual(operations[1], {
    type: 'rename',
    from: operations[0].target,
    to: '/run/dsh-host/current-url',
  });
});

test('writeUrlFileAtomic cleans up the temp file and rethrows on rename failure', () => {
  const removed = [];
  const fsModule = {
    writeFileSync: () => {},
    chmodSync: () => {},
    renameSync: () => {
      throw new Error('EXDEV');
    },
    unlinkSync: (target) => removed.push(target),
  };

  assert.throws(() => writeUrlFileAtomic('/run/current-url', 'http://x', { fs: fsModule }), /EXDEV/);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /^\/run\/current-url\.tmp-/);
});

// ---------------------------------------------------------------------------
// promoteSnapshot / pruneSnapshots
// ---------------------------------------------------------------------------

test('promoteSnapshot copies with cp -a --reflink=auto, writes known-good.json and reuses existing snapshots', async () => {
  const runtimesDir = '/state/runtimes';
  const knownGoodFile = '/state/known-good.json';
  const root = '/runtime/root';
  const fsModule = createMemoryFs({ dirs: [runtimesDir, root], files: { [`${root}/package.json`]: '{}' } });
  const { calls, spawn } = createFakeSpawn((call) => {
    if (call.command !== 'cp') return { code: 0, signal: null };
    const target = call.args[call.args.length - 1];
    fsModule.mkdirSync(path.join(target, 'lib'));
    fsModule.writeFileSync(path.join(target, 'lib', 'bin.js'), '// copied\n');
    return { code: 0, signal: null };
  });

  const first = await promoteSnapshot({
    root,
    version: '3.1.4',
    entryRel: 'lib/bin.js',
    runtimesDir,
    knownGoodFile,
    fs: fsModule,
    spawn,
    now: () => 1700000000000,
    logger: {},
  });

  assert.equal(first.copied, true);
  assert.equal(path.dirname(first.record.root), runtimesDir);
  assert.match(path.basename(first.record.root), /^3\.1\.4-[0-9a-f]{12}$/);
  assert.equal(first.record.entry, path.join(first.record.root, 'lib', 'bin.js'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-a', '--reflink=auto', root]);
  assert.equal(calls[0].options.shell, false);

  const knownGood = JSON.parse(fsModule.readFileSync(knownGoodFile, 'utf8'));
  assert.equal(knownGood.version, '3.1.4');
  assert.equal(knownGood.root, first.record.root);
  assert.equal(knownGood.recordedAt, new Date(1700000000000).toISOString());

  const second = await promoteSnapshot({
    root,
    version: '3.1.4',
    entryRel: 'lib/bin.js',
    runtimesDir,
    knownGoodFile,
    fs: fsModule,
    spawn,
    now: () => 1700000000001,
    logger: {},
  });
  assert.equal(second.copied, false);
  assert.equal(calls.length, 1, 'an existing snapshot directory is reused');
});

test('promoteSnapshot falls back to cp -a when --reflink=auto fails', async () => {
  const runtimesDir = '/state/runtimes';
  const knownGoodFile = '/state/known-good.json';
  const root = '/runtime/root';
  const fsModule = createMemoryFs({ dirs: [runtimesDir, root] });
  let copyCalls = 0;
  const { calls, spawn } = createFakeSpawn((call) => {
    if (call.command !== 'cp') return { code: 0, signal: null };
    copyCalls += 1;
    if (copyCalls === 1) return { code: 1, signal: null };
    const target = call.args[call.args.length - 1];
    fsModule.mkdirSync(path.join(target, 'lib'));
    fsModule.writeFileSync(path.join(target, 'lib', 'bin.js'), '// copied\n');
    return { code: 0, signal: null };
  });

  const result = await promoteSnapshot({
    root,
    version: '3.1.4',
    runtimesDir,
    knownGoodFile,
    fs: fsModule,
    spawn,
    now: () => 1700000000000,
    logger: {},
  });

  assert.equal(result.copied, true);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-a', '--reflink=auto', root]);
  assert.deepEqual(calls[1].args, ['-a', root, calls[0].args[3]]);
});

test('pruneSnapshots keeps at most two snapshots and preserves the active one', () => {
  const runtimesDir = '/state/runtimes';
  const fsModule = createMemoryFs({
    dirs: ['/state/runtimes/oldest', '/state/runtimes/middle', '/state/runtimes/newest', '/state/runtimes/preserved'],
    mtimes: [
      ['/state/runtimes/oldest', 10],
      ['/state/runtimes/middle', 20],
      ['/state/runtimes/newest', 30],
      ['/state/runtimes/preserved', 15],
    ],
  });

  const removed = pruneSnapshots({
    runtimesDir,
    keep: 2,
    preserve: '/state/runtimes/preserved',
    fs: fsModule,
    logger: {},
  });

  assert.deepEqual([...fsModule.dirs].sort(), ['/state/runtimes/newest', '/state/runtimes/preserved']);
  assert.deepEqual(removed.sort(), ['/state/runtimes/middle', '/state/runtimes/oldest']);
});

test('readJsonFile returns the fallback for missing or malformed files', () => {
  const fsModule = createMemoryFs({ files: { '/bad.json': '{not json' } });
  assert.deepEqual(readJsonFile('/missing.json', { fs: fsModule, fallback: { ok: false } }), { ok: false });
  assert.equal(readJsonFile('/bad.json', { fs: fsModule, fallback: null }), null);
});
