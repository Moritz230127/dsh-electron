/**
 * recovery: bounded reload policy for a lost/unresponsive main-window renderer.
 *
 * Pure decision functions: the classic single-step policy plus the rolling
 * per-app-run budget planner used by main.js. main.js owns the counters and
 * performs the actual reload; this module keeps the decision testable and
 * keeps crashes from turning into an unbounded reload loop.
 */
'use strict';

const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_MAX_RELOADS = 3;
const DEFAULT_WINDOW_MS = 60000;

/**
 * Should the main window be reloaded after a renderer loss?
 *
 * @param {{
 *   now: number,
 *   lastReloadAt: number,
 *   reloadCount: number,
 *   cooldownMs?: number,
 *   maxReloads?: number
 * }} input
 * @returns {boolean} true when a reload is allowed right now
 */
function shouldReloadAfterMainWindowRendererLoss({
  now,
  lastReloadAt = 0,
  reloadCount = 0,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxReloads = DEFAULT_MAX_RELOADS,
} = {}) {
  if (!Number.isFinite(now) || now < 0) return false;
  if (!Number.isFinite(lastReloadAt) || lastReloadAt < 0) return false;
  if (!Number.isInteger(reloadCount) || reloadCount < 0) return false;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) return false;
  if (!Number.isInteger(maxReloads) || maxReloads <= 0) return false;
  if (reloadCount >= maxReloads) return false;
  if (now - lastReloadAt < cooldownMs) return false;
  return true;
}

/**
 * Plan one renderer-loss response using a rolling, per-app-run reload budget.
 *
 * The budget is intentionally NOT refunded by a successful page load: the
 * caller increments the counter whenever a reload is actually performed.
 * `lastReloadAt` doubles as the start of the rolling window and as the 5 s
 * cooldown anchor. Once `now - lastReloadAt > windowMs` the window has expired
 * and the counter is reset before the normal cooldown/cap checks.
 *
 * @returns {{
 *   allowed: boolean,
 *   reloadCount: number,          // effective count BEFORE this reload
 *   windowReset: boolean,         // true when a non-zero budget was reset
 *   reason: 'invalid'|'budget-exhausted'|'cooldown'|'within-budget'|'window-reset',
 *   cooldownRemainingMs: number
 * }}
 */
function planMainWindowRendererRecovery({
  now,
  lastReloadAt = 0,
  reloadCount = 0,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxReloads = DEFAULT_MAX_RELOADS,
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  const valid = Number.isFinite(now) && now >= 0
    && Number.isFinite(lastReloadAt) && lastReloadAt >= 0
    && Number.isInteger(reloadCount) && reloadCount >= 0
    && Number.isFinite(cooldownMs) && cooldownMs >= 0
    && Number.isInteger(maxReloads) && maxReloads > 0
    && Number.isFinite(windowMs) && windowMs >= 0;
  if (!valid) {
    return {
      allowed: false,
      reloadCount: 0,
      windowReset: false,
      reason: 'invalid',
      cooldownRemainingMs: 0,
    };
  }

  const windowExpired = now - lastReloadAt > windowMs;
  const windowReset = windowExpired && reloadCount > 0;
  const effectiveCount = windowExpired ? 0 : reloadCount;
  const cooldownRemainingMs = Math.max(0, cooldownMs - (now - lastReloadAt));

  if (effectiveCount >= maxReloads) {
    return {
      allowed: false,
      reloadCount: effectiveCount,
      windowReset,
      reason: 'budget-exhausted',
      cooldownRemainingMs,
    };
  }
  if (cooldownRemainingMs > 0) {
    return {
      allowed: false,
      reloadCount: effectiveCount,
      windowReset,
      reason: 'cooldown',
      cooldownRemainingMs,
    };
  }
  return {
    allowed: true,
    reloadCount: effectiveCount,
    windowReset,
    reason: windowReset ? 'window-reset' : 'within-budget',
    cooldownRemainingMs: 0,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_RELOADS,
  DEFAULT_WINDOW_MS,
  shouldReloadAfterMainWindowRendererLoss,
  planMainWindowRendererRecovery,
};
