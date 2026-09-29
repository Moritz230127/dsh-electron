'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { HostSupervisor, readUrlFile, writeAtomic } = require('../../src/host/supervisor.js');

const READY_URL = 'http://127.0.0.1:41111/?token=system-token';
const KNOWN_GOOD_URL = 'http://127.0.0.1:42222/?token=known-good-token';

function createBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-unit-'));
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(path.join(runtimeRoot, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
  );
  const entry = path.join(runtimeRoot, 'lib', 'bin.js');
  fs.writeFileSync(entry, '// fake dsh entry\n');
  return {
    base,
    runtimeRoot,
    entry,
    stateDir: path.join(base, 'state'),
    runtimeDir: path.join(base, 'run'),
    home: path.join(base, 'home'),
  };
}

function createRuntimeClass(behaviors, options = {}) {
  const instances = [];
  class FakeHarnessRuntime extends EventEmitter {
    constructor(runtimeOptions) {
      super();
      this.options = runtimeOptions;
      this.instanceIndex = instances.length;
      const fallback = { type: 'ready', url: `http://127.0.0.1:${43000 + this.instanceIndex}/?token=t${this.instanceIndex}` };
      this.behavior = behaviors[this.instanceIndex] || options.defaultBehavior || fallback;
      this.running = false;
      instances.push(this);
    }

    isRunning() {
      return this.running;
    }

    async start() {
      this.running = true;
      const behavior = this.behavior;
      if (behavior.type === 'fatal') {
        setImmediate(() =>
          this.emit('fatal', {
            error: new Error(behavior.message || 'runtime exploded'),
            message: behavior.message || 'runtime exploded',
            logTail: '',
          }),
        );
      } else {
        const url = behavior.url || `http://127.0.0.1:${43000 + this.instanceIndex}/?token=t${this.instanceIndex}`;
        setImmediate(() => this.emit('ready', { url, host: '127.0.0.1', port: 43000 + this.instanceIndex, token: `t${this.instanceIndex}` }));
      }
      return { pid: 6000 + this.instanceIndex };
    }

    async stop() {
      if (!this.running) {
        this.emit('exit', { code: 0, signal: null, expected: true, logTail: '' });
        return;
      }
      this.running = false;
      setImmediate(() => this.emit('exit', { code: 0, signal: null, expected: true, logTail: '' }));
    }
  }
  return { instances, Runtime: FakeHarnessRuntime };
}

function createSpawnRecorder(options = {}) {
  const calls = [];
  const cpCount = () => calls.filter((call) => call.command === 'cp').length;
  const spawn = (command, args, spawnOptions) => {
    const call = { command, args, options: spawnOptions };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = 7000 + calls.length;
    child.exitCode = null;
    child.signalCode = null;
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      setImmediate(() => {
        child.exitCode = signal === 'SIGKILL' ? null : 0;
        child.signalCode = signal === 'SIGKILL' ? 'SIGKILL' : null;
        child.emit('exit', child.exitCode, child.signalCode);
      });
      return true;
    };
    call.child = child;

    if (command === 'cp') {
      setImmediate(() => {
        if (options.failFirstCp && cpCount() === 1) {
          child.emit('exit', 1, null);
          return;
        }
        if (typeof options.onCp === 'function') options.onCp(call);
        child.emit('exit', 0, null);
      });
    }
    return child;
  };
  return { calls, cpCount, spawn };
}

function writeKnownGood(base, version = '9.9.8') {
  const root = path.join(base.base, 'known-good');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  const entry = path.join(root, 'lib', 'bin.js');
  fs.writeFileSync(entry, '// known-good entry\n');
  const record = { version, root, entry, recordedAt: new Date(0).toISOString() };
  const knownGoodFile = path.join(base.stateDir, 'known-good.json');
  fs.mkdirSync(base.stateDir, { recursive: true });
  writeAtomic(knownGoodFile, JSON.stringify(record), { mode: 0o600 });
  return { root, entry, record, knownGoodFile };
}

function makeConfig(base, overrides = {}) {
  return {
    dshCommand: base.entry,
    dshHome: base.home,
    stateDir: base.stateDir,
    runtimeDir: base.runtimeDir,
    electronExecutable: '/fake/electron',
    snapshotEnabled: false,
    stableSecondsForPromotion: 999,
    healthIntervalMs: 60000,
    restartWindowMs: 60000,
    maxChildRestarts: 5,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('starts the system runtime, writes URL/status and launches Electron in attach mode', async () => {
  const base = createBase();
  const { instances, Runtime } = createRuntimeClass([{ type: 'ready', url: READY_URL }]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(makeConfig(base), {
    HarnessRuntime: Runtime,
    spawn: recorder.spawn,
    waitForHealth: async () => ({ statusCode: 200 }),
    env: {},
  });

  try {
    await supervisor.start();

    assert.equal(readUrlFile(supervisor.paths.urlFile), READY_URL);
    const status = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(status.state, 'running');
    assert.equal(status.dshVersion, '9.9.9');
    assert.equal(status.runtimeSource, 'system');
    assert.equal(status.message, 'Running from system runtime 9.9.9');
    assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(instances.length, 1);
    assert.equal(instances[0].options.command, process.execPath);
    assert.deepEqual(instances[0].options.args, [
      base.entry,
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ]);
    assert.equal(instances[0].options.env.DSH_HOME, base.home);
    assert.equal(instances[0].options.spawn, recorder.spawn);

    const uiCalls = recorder.calls.filter((call) => call.command === '/fake/electron');
    assert.equal(uiCalls.length, 1);
    assert.equal(uiCalls[0].options.shell, false);
    assert.equal(uiCalls[0].options.env.DSH_ELECTRON_ATTACH_URL_FILE, supervisor.paths.urlFile);
    assert.equal(uiCalls[0].options.env.DSH_ELECTRON_USER_DATA, path.join(base.stateDir, 'ui-profile'));
    assert.ok(uiCalls[0].args.includes(`--attach-url-file=${supervisor.paths.urlFile}`));
    assert.equal(
      uiCalls[0].args[0],
      path.resolve(__dirname, '..', '..'),
      'a plain electron executable gets the app root as its first argument',
    );
    assert.equal(supervisor.currentRuntime.source, 'system');
    assert.equal(supervisor.currentRuntime.version, '9.9.9');
  } finally {
    await supervisor.stop('test');
    assert.equal(readUrlFile(supervisor.paths.urlFile), null, 'URL file removed on shutdown');
    const stoppedStatus = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(stoppedStatus.state, 'stopped');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('system failure falls back to the known-good runtime and records attempt.json', async () => {
  const base = createBase();
  const knownGood = writeKnownGood(base);
  const { instances, Runtime } = createRuntimeClass([
    { type: 'fatal', message: 'system runtime is broken' },
    { type: 'ready', url: KNOWN_GOOD_URL },
  ]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(makeConfig(base), {
    HarnessRuntime: Runtime,
    spawn: recorder.spawn,
    waitForHealth: async () => ({ statusCode: 200 }),
    env: {},
  });

  try {
    await supervisor.start();

    assert.equal(instances.length, 2, 'system runtime was attempted before the fallback');
    assert.equal(instances[0].options.args[0], base.entry);
    assert.equal(instances[1].options.args[0], knownGood.entry);
    assert.equal(supervisor.currentRuntime.source, 'known-good');
    assert.equal(supervisor.currentRuntime.version, '9.9.8');
    assert.equal(readUrlFile(supervisor.paths.urlFile), KNOWN_GOOD_URL);

    const status = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(status.state, 'fallback');
    assert.equal(status.runtimeSource, 'known-good');
    assert.equal(status.dshVersion, '9.9.8');
    assert.equal(status.message, 'Running from known-good fallback 9.9.8 (system 9.9.9 failed)');

    const attempt = JSON.parse(fs.readFileSync(path.join(base.stateDir, 'attempt.json'), 'utf8'));
    assert.equal(attempt.systemVersion, '9.9.9');
    assert.equal(attempt.failureCount, 1);
    assert.ok(Number.isFinite(attempt.failedAt));
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('a fresh same-version failure takes the known-good fast path on startup', async () => {
  const base = createBase();
  const knownGood = writeKnownGood(base);
  fs.writeFileSync(
    path.join(base.stateDir, 'attempt.json'),
    JSON.stringify({ systemVersion: '9.9.9', failedAt: Date.now(), failureCount: 1 }),
  );
  const { instances, Runtime } = createRuntimeClass([{ type: 'ready', url: KNOWN_GOOD_URL }]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(makeConfig(base), {
    HarnessRuntime: Runtime,
    spawn: recorder.spawn,
    waitForHealth: async () => ({ statusCode: 200 }),
    env: {},
  });

  try {
    await supervisor.start();

    assert.equal(instances.length, 1, 'system runtime is not attempted during the fast path');
    assert.equal(instances[0].options.args[0], knownGood.entry);
    assert.equal(supervisor.currentRuntime.source, 'known-good');
    const status = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(status.state, 'fallback');
    assert.equal(status.message, 'Running from known-good fallback 9.9.8 (system 9.9.9 failed)');
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('repeated health failures switch from the system runtime to known-good', async () => {
  const base = createBase();
  const knownGood = writeKnownGood(base);
  const { Runtime } = createRuntimeClass([
    { type: 'ready', url: READY_URL },
    { type: 'ready', url: KNOWN_GOOD_URL },
  ]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(
    makeConfig(base, { healthIntervalMs: 20, healthFailureThreshold: 2, maxChildRestarts: 3 }),
    {
      HarnessRuntime: Runtime,
      spawn: recorder.spawn,
      waitForHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
      env: {},
    },
  );

  try {
    await supervisor.start();
    assert.equal(supervisor.currentRuntime.source, 'system');

    await waitFor(() => supervisor.currentRuntime !== null && supervisor.currentRuntime.source === 'known-good', 5000);
    assert.equal(readUrlFile(supervisor.paths.urlFile), KNOWN_GOOD_URL);
    const status = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(status.runtimeSource, 'known-good');
    const attempt = JSON.parse(fs.readFileSync(path.join(base.stateDir, 'attempt.json'), 'utf8'));
    assert.equal(attempt.systemVersion, '9.9.9');
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('promotes a stable system runtime into a snapshot and known-good.json', async () => {
  const base = createBase();
  fs.mkdirSync(base.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(base.stateDir, 'attempt.json'),
    JSON.stringify({ systemVersion: '9.9.9', failedAt: Date.now(), failureCount: 1 }),
  );
  const { Runtime } = createRuntimeClass([{ type: 'ready', url: READY_URL }]);
  const recorder = createSpawnRecorder({
    onCp: (call) => {
      const source = call.args[2];
      const target = call.args[3];
      fs.cpSync(source, target, { recursive: true });
    },
  });
  const supervisor = new HostSupervisor(
    makeConfig(base, { snapshotEnabled: true, stableSecondsForPromotion: 0 }),
    {
      HarnessRuntime: Runtime,
      spawn: recorder.spawn,
      waitForHealth: async () => ({ statusCode: 200 }),
      env: {},
    },
  );

  try {
    await supervisor.start();
    const knownGoodFile = path.join(base.stateDir, 'known-good.json');
    await waitFor(() => fs.existsSync(knownGoodFile), 3000);

    const record = JSON.parse(fs.readFileSync(knownGoodFile, 'utf8'));
    assert.equal(record.version, '9.9.9');
    assert.match(path.basename(record.root), /^9\.9\.9-[0-9a-f]{12}$/);
    assert.equal(record.entry, path.join(record.root, 'lib', 'bin.js'));
    assert.ok(fs.existsSync(record.entry));
    assert.ok(fs.existsSync(path.join(record.root, 'package.json')));

    const cpCall = recorder.calls.find((call) => call.command === 'cp');
    assert.deepEqual(cpCall.args.slice(0, 2), ['-a', '--reflink=auto']);
    assert.equal(supervisor.currentRuntime.promoted, true);
    assert.equal(
      fs.existsSync(path.join(base.stateDir, 'attempt.json')),
      false,
      'a successful promotion clears the stale same-version failure record',
    );
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('snapshotEnabled=false skips cp and known-good promotion entirely', async () => {
  const base = createBase();
  const { Runtime } = createRuntimeClass([{ type: 'ready', url: READY_URL }]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(
    makeConfig(base, { snapshotEnabled: false, stableSecondsForPromotion: 0 }),
    {
      HarnessRuntime: Runtime,
      spawn: recorder.spawn,
      waitForHealth: async () => ({ statusCode: 200 }),
      env: {},
    },
  );

  try {
    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(recorder.cpCount(), 0, 'no cp processes are spawned');
    assert.equal(fs.existsSync(path.join(base.stateDir, 'known-good.json')), false);
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('windowed restart budget backs off exponentially and then retries at 60s', async () => {
  const base = createBase();
  const delays = [];
  const { Runtime } = createRuntimeClass([], { defaultBehavior: { type: 'fatal', message: 'always broken' } });
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(
    makeConfig(base, { maxChildRestarts: 2, restartWindowMs: 60000 }),
    {
      HarnessRuntime: Runtime,
      spawn: recorder.spawn,
      sleep: (ms) => {
        delays.push(ms);
        return new Promise((resolve) => setImmediate(resolve));
      },
      waitForHealth: async () => ({ statusCode: 200 }),
      env: {},
    },
  );

  try {
    await supervisor.start();
    await waitFor(() => delays.includes(60000), 2000, 5);
    assert.deepEqual(delays.slice(0, 2), [1000, 2000]);
    assert.ok(delays.includes(60000), 'budget exhaustion retries at a fixed 60s');

    const status = JSON.parse(fs.readFileSync(supervisor.paths.statusFile, 'utf8'));
    assert.equal(status.state, 'error');
    assert.match(status.message, /exhausted/);
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('a crashed UI is restarted without stopping the DSH runtime', async () => {
  const base = createBase();
  const { Runtime } = createRuntimeClass([{ type: 'ready', url: READY_URL }]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(makeConfig(base), {
    HarnessRuntime: Runtime,
    spawn: recorder.spawn,
    waitForHealth: async () => ({ statusCode: 200 }),
    env: {},
  });

  try {
    await supervisor.start();
    const uiCalls = () => recorder.calls.filter((call) => call.command === '/fake/electron');
    assert.equal(uiCalls().length, 1);

    uiCalls()[0].child.emit('exit', 1, null);
    await waitFor(() => uiCalls().length === 2, 5000);
    assert.equal(supervisor.currentRuntime.source, 'system');
    assert.equal(supervisor.currentRuntime.runtime.isRunning(), true, 'DSH survived the UI crash');
    assert.equal(readUrlFile(supervisor.paths.urlFile), READY_URL);
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});

test('intentional UI exit (code 0) is not restarted', async () => {
  const base = createBase();
  const { Runtime } = createRuntimeClass([{ type: 'ready', url: READY_URL }]);
  const recorder = createSpawnRecorder();
  const supervisor = new HostSupervisor(makeConfig(base), {
    HarnessRuntime: Runtime,
    spawn: recorder.spawn,
    waitForHealth: async () => ({ statusCode: 200 }),
    env: {},
  });

  try {
    await supervisor.start();
    const uiCalls = recorder.calls.filter((call) => call.command === '/fake/electron');
    assert.equal(uiCalls.length, 1);
    uiCalls[0].child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(recorder.calls.filter((call) => call.command === '/fake/electron').length, 1);
  } finally {
    await supervisor.stop('test');
    fs.rmSync(base.base, { recursive: true, force: true });
  }
});
