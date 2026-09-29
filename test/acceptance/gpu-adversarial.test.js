/**
 * Independent adversarial tests for the GPU fallback ladder (§3.2/§3.4),
 * persistence, reload bound (§3.3) and the "disable before ready" bootstrap
 * order in main.js. main.run() is driven with a fake Electron object so the
 * real bootstrap code path (not a summary) is exercised.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gpu = require('../../src/main/gpu-fallback');
const recovery = require('../../src/main/recovery');
const main = require('../../src/main/main');

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Ladder termination (no unbounded relaunch loop)
// ---------------------------------------------------------------------------

function runFailureChain({ level, harnessRendered, maxSteps = 40 }) {
  let state = { level, failures: 0, stableLaunches: 0 };
  const plan = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const result = gpu.planGpuFallbackResponse({ state, harnessRendered });
    plan.push(result);
    state = result.state;
    if (result.action === 'stop') return plan;
  }
  throw new Error(`GPU planner did not terminate for ${level}/rendered=${harnessRendered}`);
}

test('never-rendered GPU loss escalates each level once and then stops', () => {
  for (const start of gpu.LEVELS) {
    const plan = runFailureChain({ level: start, harnessRendered: false });
    assert.equal(plan[plan.length - 1].action, 'stop');
    assert.ok(plan.length <= gpu.LEVELS.length, `chain for ${start} was not bounded: ${plan.length}`);
    const levels = plan.map((item) => item.level);
    for (let i = 1; i < levels.length; i += 1) {
      const down = gpu.LEVELS.indexOf(levels[i]) - gpu.LEVELS.indexOf(levels[i - 1]);
      assert.ok(down === 1 || down === 0, `unexpected level jump ${levels[i - 1]} -> ${levels[i]}`);
    }
  }
});

test('rendered GPU loss waits exactly three failures per level, then stops at the bottom', () => {
  for (const start of gpu.LEVELS) {
    const plan = runFailureChain({ level: start, harnessRendered: true });
    assert.equal(plan[plan.length - 1].action, 'stop');
    // Exactly FAILURES_BEFORE_ESCALATION planner steps per level from `start`
    // through the bottom level; the final step is the stop.
    const maxSteps = (gpu.LEVELS.length - gpu.LEVELS.indexOf(start)) * gpu.FAILURES_BEFORE_ESCALATION;
    assert.ok(plan.length <= maxSteps, `chain for ${start} exceeded bound ${maxSteps}: ${plan.length}`);

    let waitsAtLevel = 0;
    let currentLevel = start;
    for (const item of plan) {
      if (item.action === 'wait') {
        waitsAtLevel += 1;
        assert.equal(item.level, currentLevel);
        assert.ok(waitsAtLevel < gpu.FAILURES_BEFORE_ESCALATION,
          `more than ${gpu.FAILURES_BEFORE_ESCALATION - 1} waits at ${currentLevel}`);
      }
      if (item.action === 'relaunch') {
        assert.notEqual(item.level, currentLevel, 'relaunch must move the level');
        currentLevel = item.level;
        waitsAtLevel = 0;
      }
    }
  }
});

test('bottom-level GPU loss never relaunches (stops automatically)', () => {
  const plan = gpu.planGpuFallbackResponse({
    state: { level: 'gpu-disabled', failures: 99, stableLaunches: 0 },
    harnessRendered: true,
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.level, 'gpu-disabled');
  assert.equal(plan.action === 'relaunch', false);
  assert.match(MAIN_SRC, /if \(plan\.action === 'stop'\)[\s\S]*?showErrorPage/);
});

// ---------------------------------------------------------------------------
// Stable launch boundaries
// ---------------------------------------------------------------------------

test('planStableLaunch steps up on the 20th stable launch, never above default', () => {
  const nineteenth = gpu.planStableLaunch({ level: 'sandbox-disabled', failures: 2, stableLaunches: 19 });
  assert.deepEqual(nineteenth, {
    state: { level: 'default', failures: 0, stableLaunches: 0 },
    level: 'default',
    steppedUp: true,
  });
  const eighteenth = gpu.planStableLaunch({ level: 'gpu-disabled', failures: 2, stableLaunches: 18 });
  assert.equal(eighteenth.steppedUp, false);
  assert.deepEqual(eighteenth.state, { level: 'gpu-disabled', failures: 0, stableLaunches: 19 });

  // At default the counter clamps and never steps up.
  const defaultNineteen = gpu.planStableLaunch({ level: 'default', failures: 0, stableLaunches: 19 });
  assert.equal(defaultNineteen.steppedUp, false);
  assert.deepEqual(defaultNineteen.state, { level: 'default', failures: 0, stableLaunches: 20 });
  const defaultTwenty = gpu.planStableLaunch(defaultNineteen.state);
  assert.equal(defaultTwenty.steppedUp, false);
  assert.equal(defaultTwenty.state.stableLaunches, 20);
});

test('every stable launch clears the failure streak', () => {
  const plan = gpu.planStableLaunch({ level: 'gpu-disabled', failures: 2, stableLaunches: 0 });
  assert.equal(plan.state.failures, 0);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('GPU state persists atomically under <userData>/gpu-fallback.json with mode 0600', () => {
  const dir = makeTempDir('dsh-verify-gpu-');
  const state = { level: 'gpu-disabled', failures: 2, stableLaunches: 7 };
  const file = gpu.saveGpuFallbackState(dir, state);

  assert.equal(file, path.join(dir, 'gpu-fallback.json'));
  assert.deepEqual(fs.readdirSync(dir), ['gpu-fallback.json']);
  assert.deepEqual(gpu.loadGpuFallbackState(dir), state);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(state)}\n`);
});

test('corrupt or hostile GPU state files degrade to default without throwing', () => {
  const dir = makeTempDir('dsh-verify-gpu-');
  const file = path.join(dir, 'gpu-fallback.json');

  fs.writeFileSync(file, 'not-json{{{');
  assert.deepEqual(gpu.loadGpuFallbackState(dir), gpu.defaultGpuFallbackState());

  fs.writeFileSync(file, JSON.stringify({ level: '../../etc/passwd', failures: -1, stableLaunches: 1.5 }));
  assert.deepEqual(gpu.loadGpuFallbackState(dir), gpu.defaultGpuFallbackState());

  fs.writeFileSync(file, JSON.stringify({ level: 'gpu-disabled', failures: 0, __proto__: { polluted: true } }));
  assert.deepEqual(gpu.loadGpuFallbackState(dir), { level: 'gpu-disabled', failures: 0, stableLaunches: 0 });
  assert.equal({}.polluted, undefined);

  assert.deepEqual(gpu.loadGpuFallbackState(''), gpu.defaultGpuFallbackState());
  assert.throws(() => gpu.saveGpuFallbackState('', stateOrDefault()), TypeError);
});

function stateOrDefault() {
  return gpu.defaultGpuFallbackState();
}

// ---------------------------------------------------------------------------
// Bounded renderer reload policy
// ---------------------------------------------------------------------------

test('renderer reload policy is bounded by count and cooldown in both directions', () => {
  const cooldownMs = recovery.DEFAULT_COOLDOWN_MS;
  const maxReloads = recovery.DEFAULT_MAX_RELOADS;

  const t0 = 10 ** 12;
  // main.js seeds lastReloadAt=0 and passes a real clock, so the first loss is allowed.
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: t0, lastReloadAt: 0, reloadCount: 0 }), true);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: t0 + cooldownMs - 1, lastReloadAt: t0, reloadCount: 0 }), false);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: t0 + cooldownMs, lastReloadAt: t0, reloadCount: 1 }), true);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({
    now: t0 + cooldownMs,
    lastReloadAt: t0,
    reloadCount: maxReloads - 1,
  }), true);
  // now=0 with lastReloadAt=0 is inside the cooldown, not a free reload.
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 0, lastReloadAt: 0, reloadCount: 0 }), false);
  // Once the cap is reached, even an ancient lastReloadAt cannot reload again.
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 10 ** 12, lastReloadAt: 0, reloadCount: maxReloads }), false);
  // Clock going backwards or garbage inputs can never trigger a reload.
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 10, lastReloadAt: 1000, reloadCount: 0 }), false);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: NaN, lastReloadAt: 0, reloadCount: 0 }), false);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 0, lastReloadAt: 0, reloadCount: -1 }), false);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 0, lastReloadAt: 0, reloadCount: 0, maxReloads: 0 }), false);
  assert.equal(recovery.shouldReloadAfterMainWindowRendererLoss({ now: 0, lastReloadAt: 0, reloadCount: 0, cooldownMs: -1 }), false);
});

// ---------------------------------------------------------------------------
// main.run() bootstrap order with a fake Electron object
// ---------------------------------------------------------------------------

function makeFakeElectron({ order, userDataDir, neverReady = true } = {}) {
  const app = {
    _userData: userDataDir,
    commandLine: {
      appendSwitch(name, value) {
        order.push(value === undefined ? `switch:${name}` : `switch:${name}=${value}`);
      },
    },
    setPath(key, value) {
      order.push(`setPath:${key}`);
      app._userData = value;
    },
    getPath() {
      order.push('getPath:userData');
      return app._userData;
    },
    requestSingleInstanceLock() {
      order.push('requestSingleInstanceLock');
      return true;
    },
    whenReady() {
      order.push('whenReady');
      return neverReady ? new Promise(() => {}) : Promise.resolve();
    },
    on() {},
    quit() {
      order.push('quit');
    },
    exit() {
      order.push('exit');
    },
    relaunch() {
      order.push('relaunch');
    },
    disableHardwareAcceleration() {
      order.push('disableHardwareAcceleration');
    },
    getVersion() {
      return '0.0.0-verify';
    },
  };
  const ipcMain = {
    handle() {},
    removeHandler() {},
  };
  return {
    app,
    BrowserWindow: function VerificationBrowserWindow() {},
    ipcMain,
    shell: {},
    Tray: undefined,
    Menu: {},
    nativeImage: {},
  };
}

function withTempEnv(fn) {
  const dir = makeTempDir('dsh-verify-boot-');
  const previous = {
    DSH_ELECTRON_USER_DATA: process.env.DSH_ELECTRON_USER_DATA,
    DSH_ELECTRON_HOME: process.env.DSH_ELECTRON_HOME,
  };
  process.env.DSH_ELECTRON_USER_DATA = dir;
  process.env.DSH_ELECTRON_HOME = path.join(dir, 'dsh-home');
  try {
    return fn(dir);
  } finally {
    if (previous.DSH_ELECTRON_USER_DATA === undefined) delete process.env.DSH_ELECTRON_USER_DATA;
    else process.env.DSH_ELECTRON_USER_DATA = previous.DSH_ELECTRON_USER_DATA;
    if (previous.DSH_ELECTRON_HOME === undefined) delete process.env.DSH_ELECTRON_HOME;
    else process.env.DSH_ELECTRON_HOME = previous.DSH_ELECTRON_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('main.run(): persisted gpu-disabled applies switches, disables HW accel, then whenReady', () => {
  withTempEnv((userDataDir) => {
    gpu.saveGpuFallbackState(userDataDir, { level: 'gpu-disabled', failures: 0, stableLaunches: 0 });
    const order = [];
    const fake = makeFakeElectron({ order, userDataDir });
    main.run(fake);

    assert.ok(order.includes('whenReady'), 'whenReady must be reached');
    const index = (prefix) => order.findIndex((item) => item.startsWith(prefix));
    assert.ok(index('setPath:userData') >= 0, 'userData must be overridden');
    assert.ok(index('setPath:userData') < index('requestSingleInstanceLock'),
      'setPath(userData) must happen before the single-instance lock');
    assert.ok(index('requestSingleInstanceLock') < index('getPath:userData'));
    assert.ok(index('switch:disable-gpu-sandbox') >= 0);
    assert.ok(index('switch:disable-gpu') >= 0);
    assert.ok(index('switch:disable-gpu-compositing') >= 0);
    assert.ok(index('disableHardwareAcceleration') >= 0);
    assert.ok(index('disableHardwareAcceleration') < index('whenReady'),
      'disableHardwareAcceleration must run before app.whenReady()');
  });
});

test('main.run(): persisted sandbox-disabled applies only that switch and keeps HW accel', () => {
  withTempEnv((userDataDir) => {
    gpu.saveGpuFallbackState(userDataDir, { level: 'sandbox-disabled', failures: 1, stableLaunches: 0 });
    const order = [];
    main.run(makeFakeElectron({ order, userDataDir }));
    assert.deepEqual(order.filter((item) => item.startsWith('switch:')), ['switch:disable-gpu-sandbox']);
    assert.equal(order.includes('disableHardwareAcceleration'), false);
    assert.ok(order.indexOf('switch:disable-gpu-sandbox') < order.indexOf('whenReady'));
  });
});

test('main.run(): default level adds no switches and extraSwitches from config still apply', () => {
  withTempEnv((userDataDir) => {
    fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
      extraSwitches: ['--verify-flag=1', 'plain-switch'],
    }));
    const order = [];
    main.run(makeFakeElectron({ order, userDataDir }));
    assert.deepEqual(order.filter((item) => item.startsWith('switch:')), [
      'switch:verify-flag=1',
      'switch:plain-switch',
    ]);
    assert.equal(order.includes('disableHardwareAcceleration'), false);
  });
});
