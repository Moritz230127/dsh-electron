'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_RELOADS,
  DEFAULT_WINDOW_MS,
  shouldReloadAfterMainWindowRendererLoss,
  planMainWindowRendererRecovery,
} = require('../../src/main/recovery');

test('allows the first renderer reload', () => {
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 10000, lastReloadAt: 0, reloadCount: 0 }),
    true,
  );
});

test('uses a 5 s cooldown and max 3 reloads by default', () => {
  assert.equal(DEFAULT_COOLDOWN_MS, 5000);
  assert.equal(DEFAULT_MAX_RELOADS, 3);
});

test('blocks reloads inside the cooldown window', () => {
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 14000, lastReloadAt: 10000, reloadCount: 1 }),
    false,
  );
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 15000, lastReloadAt: 10000, reloadCount: 1 }),
    true,
  );
});

test('blocks reloads once maxReloads is reached', () => {
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 99999, lastReloadAt: 0, reloadCount: 2 }),
    true,
  );
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 99999, lastReloadAt: 0, reloadCount: 3 }),
    false,
  );
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 99999, lastReloadAt: 0, reloadCount: 4 }),
    false,
  );
});

test('honours custom cooldown and maxReloads', () => {
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({
      now: 10100,
      lastReloadAt: 10000,
      reloadCount: 0,
      cooldownMs: 100,
      maxReloads: 5,
    }),
    true,
  );
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({
      now: 20000,
      lastReloadAt: 0,
      reloadCount: 5,
      cooldownMs: 0,
      maxReloads: 5,
    }),
    false,
  );
});

test('rejects invalid inputs instead of reloading', () => {
  assert.equal(shouldReloadAfterMainWindowRendererLoss({}), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: NaN }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, lastReloadAt: NaN }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, lastReloadAt: -1 }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, reloadCount: -1 }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, reloadCount: 1.5 }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, maxReloads: 0 }), false);
  assert.equal(shouldReloadAfterMainWindowRendererLoss({ now: 1, cooldownMs: -5 }), false);
});

test('planMainWindowRendererRecovery allows the first reload and reports a usable count', () => {
  const plan = planMainWindowRendererRecovery({ now: 10_000, lastReloadAt: 0, reloadCount: 0 });
  assert.equal(plan.allowed, true);
  assert.equal(plan.reloadCount, 0);
  assert.equal(plan.windowReset, false);
  assert.equal(plan.reason, 'within-budget');
});

test('planMainWindowRendererRecovery caps a rapid success-then-crash loop at 3 reloads', () => {
  let reloadCount = 0;
  let lastReloadAt = 0;
  const allowed = [];

  for (let cycle = 0; cycle < 4; cycle += 1) {
    const now = 10_000 + cycle * (DEFAULT_COOLDOWN_MS + 1);
    const plan = planMainWindowRendererRecovery({ now, lastReloadAt, reloadCount });
    allowed.push(plan.allowed);
    if (plan.allowed) {
      reloadCount = plan.reloadCount + 1;
      lastReloadAt = now;
    }
  }

  assert.deepEqual(allowed, [true, true, true, false]);
  assert.equal(reloadCount, 3);
  const exhausted = planMainWindowRendererRecovery({ now: 10_000 + 4 * 5001, lastReloadAt, reloadCount });
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, 'budget-exhausted');
  assert.equal(exhausted.reloadCount, DEFAULT_MAX_RELOADS);
});

test('planMainWindowRendererRecovery resets a spent budget after the 60 s window', () => {
  const spentAt = 50_000;
  const plan = planMainWindowRendererRecovery({
    now: spentAt + DEFAULT_WINDOW_MS + 1,
    lastReloadAt: spentAt,
    reloadCount: 3,
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.windowReset, true);
  assert.equal(plan.reloadCount, 0);
  assert.equal(plan.reason, 'window-reset');

  // Exactly at the boundary the rolling window has not expired yet.
  const boundary = planMainWindowRendererRecovery({
    now: spentAt + DEFAULT_WINDOW_MS,
    lastReloadAt: spentAt,
    reloadCount: 3,
  });
  assert.equal(boundary.allowed, false);
  assert.equal(boundary.reason, 'budget-exhausted');
  assert.equal(boundary.windowReset, false);
});

test('planMainWindowRendererRecovery keeps the 5 s cooldown', () => {
  const plan = planMainWindowRendererRecovery({
    now: 14_000,
    lastReloadAt: 10_000,
    reloadCount: 1,
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, 'cooldown');
  assert.equal(plan.cooldownRemainingMs, 1000);

  const atBoundary = planMainWindowRendererRecovery({
    now: 15_000,
    lastReloadAt: 10_000,
    reloadCount: 1,
  });
  assert.equal(atBoundary.allowed, true);
});

test('planMainWindowRendererRecovery rejects invalid inputs', () => {
  assert.equal(planMainWindowRendererRecovery({}).reason, 'invalid');
  assert.equal(planMainWindowRendererRecovery({ now: NaN }).allowed, false);
  assert.equal(planMainWindowRendererRecovery({ now: 10_000, lastReloadAt: -1 }).reason, 'invalid');
  assert.equal(planMainWindowRendererRecovery({ now: 10_000, reloadCount: 1.5 }).reason, 'invalid');
  assert.equal(planMainWindowRendererRecovery({ now: 10_000, maxReloads: 0 }).reason, 'invalid');
  assert.equal(planMainWindowRendererRecovery({ now: 10_000, windowMs: -1 }).reason, 'invalid');
});

test('blocks a reload when lastReloadAt is in the future', () => {
  assert.equal(
    shouldReloadAfterMainWindowRendererLoss({ now: 1000, lastReloadAt: 2000, reloadCount: 0 }),
    false,
  );
});
