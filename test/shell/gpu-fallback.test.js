'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gpu = require('../../src/main/gpu-fallback');

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultGpuFallbackState returns the canonical fresh state', () => {
  assert.deepEqual(gpu.defaultGpuFallbackState(), {
    level: 'default',
    failures: 0,
    stableLaunches: 0,
  });
});

test('gpuFallbackSwitches maps every ladder level', () => {
  assert.deepEqual(gpu.gpuFallbackSwitches('default'), []);
  assert.deepEqual(gpu.gpuFallbackSwitches('sandbox-disabled'), ['disable-gpu-sandbox']);
  assert.deepEqual(gpu.gpuFallbackSwitches('gpu-disabled'), [
    'disable-gpu-sandbox',
    'disable-gpu',
    'disable-gpu-compositing',
  ]);
});

test('gpuFallbackSwitches rejects unknown levels', () => {
  assert.throws(() => gpu.gpuFallbackSwitches('turbo'), TypeError);
  assert.throws(() => gpu.gpuFallbackSwitches(undefined), TypeError);
});

test('isGpuLossFatal follows clean/killed/device-lost rules', () => {
  assert.equal(gpu.isGpuLossFatal('clean-exit', 0), false);
  assert.equal(gpu.isGpuLossFatal('killed', 137), false);
  assert.equal(gpu.isGpuLossFatal('crashed', gpu.GPU_DEVICE_LOST_EXIT_CODE), false);
  assert.equal(gpu.isGpuLossFatal('crashed', 1), true);
  assert.equal(gpu.isGpuLossFatal('launch-failed', 0), true);
  assert.equal(gpu.isGpuLossFatal(undefined, undefined), true);
});

test('planGpuFallbackResponse escalates immediately when nothing ever rendered', () => {
  const plan = gpu.planGpuFallbackResponse({
    state: gpu.defaultGpuFallbackState(),
    harnessRendered: false,
  });
  assert.equal(plan.action, 'relaunch');
  assert.equal(plan.level, 'sandbox-disabled');
  assert.equal(plan.switched, true);
  assert.deepEqual(plan.state, { level: 'sandbox-disabled', failures: 0, stableLaunches: 0 });
});

test('planGpuFallbackResponse stops at the bottom when nothing ever rendered', () => {
  const plan = gpu.planGpuFallbackResponse({
    state: { level: 'gpu-disabled', failures: 0, stableLaunches: 0 },
    harnessRendered: false,
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.level, 'gpu-disabled');
  assert.equal(plan.switched, false);
  assert.equal(plan.state.failures, 1);
});

test('planGpuFallbackResponse waits for the third rendered failure before escalating', () => {
  const first = gpu.planGpuFallbackResponse({
    state: { level: 'default', failures: 0, stableLaunches: 4 },
    harnessRendered: true,
  });
  assert.equal(first.action, 'wait');
  assert.deepEqual(first.state, { level: 'default', failures: 1, stableLaunches: 0 });

  const second = gpu.planGpuFallbackResponse({
    state: first.state,
    harnessRendered: true,
  });
  assert.equal(second.action, 'wait');
  assert.equal(second.state.failures, 2);

  const third = gpu.planGpuFallbackResponse({
    state: second.state,
    harnessRendered: true,
  });
  assert.equal(third.action, 'relaunch');
  assert.equal(third.level, 'sandbox-disabled');
  assert.deepEqual(third.state, { level: 'sandbox-disabled', failures: 0, stableLaunches: 0 });
});

test('planGpuFallbackResponse stops at the top of the ladder after rendered failures', () => {
  const plan = gpu.planGpuFallbackResponse({
    state: { level: 'gpu-disabled', failures: 2, stableLaunches: 0 },
    harnessRendered: true,
  });
  assert.equal(plan.action, 'stop');
  assert.equal(plan.state.failures, 3);
  assert.equal(plan.level, 'gpu-disabled');
});

test('planStableLaunch counts stable launches and clears failures', () => {
  const plan = gpu.planStableLaunch({ level: 'sandbox-disabled', failures: 2, stableLaunches: 3 });
  assert.equal(plan.steppedUp, false);
  assert.deepEqual(plan.state, { level: 'sandbox-disabled', failures: 0, stableLaunches: 4 });
});

test('planStableLaunch steps one level up after 20 stable launches', () => {
  const plan = gpu.planStableLaunch({ level: 'gpu-disabled', failures: 2, stableLaunches: 19 });
  assert.equal(plan.steppedUp, true);
  assert.equal(plan.level, 'sandbox-disabled');
  assert.deepEqual(plan.state, { level: 'sandbox-disabled', failures: 0, stableLaunches: 0 });
});

test('planStableLaunch never steps above default', () => {
  const plan = gpu.planStableLaunch({ level: 'default', failures: 0, stableLaunches: 19 });
  assert.equal(plan.steppedUp, false);
  assert.deepEqual(plan.state, { level: 'default', failures: 0, stableLaunches: 20 });
});

test('parseGpuFallbackState normalizes junk and clamps bad fields', () => {
  assert.deepEqual(gpu.parseGpuFallbackState(null), gpu.defaultGpuFallbackState());
  assert.deepEqual(gpu.parseGpuFallbackState('not json'), gpu.defaultGpuFallbackState());
  assert.deepEqual(gpu.parseGpuFallbackState('{"level":"nope","failures":-2,"stableLaunches":1.5}'), {
    level: 'default',
    failures: 0,
    stableLaunches: 0,
  });
  assert.deepEqual(gpu.parseGpuFallbackState('{"level":"gpu-disabled","failures":7}'), {
    level: 'gpu-disabled',
    failures: 7,
    stableLaunches: 0,
  });
});

test('serialize/parse round-trips state', () => {
  const state = { level: 'sandbox-disabled', failures: 2, stableLaunches: 5 };
  assert.deepEqual(gpu.parseGpuFallbackState(gpu.serializeGpuFallbackState(state)), state);
});

test('loadGpuFallbackState returns default for missing/corrupt files', () => {
  const dir = makeTempDir('dsh-shell-gpu-');
  assert.deepEqual(gpu.loadGpuFallbackState(dir), gpu.defaultGpuFallbackState());

  fs.writeFileSync(path.join(dir, 'gpu-fallback.json'), '{broken');
  assert.deepEqual(gpu.loadGpuFallbackState(dir), gpu.defaultGpuFallbackState());
  assert.deepEqual(gpu.loadGpuFallbackState(null), gpu.defaultGpuFallbackState());
});

test('saveGpuFallbackState writes atomically and leaves no tmp file', () => {
  const dir = makeTempDir('dsh-shell-gpu-');
  const state = { level: 'gpu-disabled', failures: 1, stableLaunches: 0 };
  const filePath = gpu.saveGpuFallbackState(dir, state);

  assert.equal(filePath, path.join(dir, 'gpu-fallback.json'));
  assert.deepEqual(fs.readdirSync(dir), ['gpu-fallback.json']);
  assert.deepEqual(gpu.loadGpuFallbackState(dir), state);
});
