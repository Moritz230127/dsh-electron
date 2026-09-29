/**
 * gpu-fallback: pure GPU fallback ladder policy.
 *
 * Owns the level ladder (default -> sandbox-disabled -> gpu-disabled),
 * switch generation, loss classification and the persisted state shape.
 * Persistence uses <userDataDir>/gpu-fallback.json with an atomic tmp+rename
 * write. No Electron imports: unit-testable with plain Node.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = Object.freeze(['default', 'sandbox-disabled', 'gpu-disabled']);
const GPU_DEVICE_LOST_EXIT_CODE = 34;
const FAILURES_BEFORE_ESCALATION = 3;
const STABLE_LAUNCHES_BEFORE_STEP_UP = 20;
const STATE_FILE_NAME = 'gpu-fallback.json';

/** Canonical fresh state. */
function defaultGpuFallbackState() {
  return { level: 'default', failures: 0, stableLaunches: 0 };
}

function isKnownGpuFallbackLevel(level) {
  return LEVELS.includes(level);
}

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeGpuFallbackState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return defaultGpuFallbackState();
  }
  return {
    level: isKnownGpuFallbackLevel(state.level) ? state.level : 'default',
    failures: normalizeNonNegativeInteger(state.failures, 0),
    stableLaunches: normalizeNonNegativeInteger(state.stableLaunches, 0),
  };
}

/** One step down the ladder, or null when already at the bottom. */
function lowerGpuFallbackLevel(level) {
  const index = LEVELS.indexOf(level);
  if (index < 0 || index >= LEVELS.length - 1) return null;
  return LEVELS[index + 1];
}

/** One step up the ladder, or null when already at 'default'. */
function higherGpuFallbackLevel(level) {
  const index = LEVELS.indexOf(level);
  if (index <= 0) return null;
  return LEVELS[index - 1];
}

/** Chromium switches (without leading dashes) for one ladder level. */
function gpuFallbackSwitches(level) {
  if (!isKnownGpuFallbackLevel(level)) {
    throw new TypeError(`unknown GPU fallback level: ${String(level)}`);
  }
  if (level === 'gpu-disabled') {
    return ['disable-gpu-sandbox', 'disable-gpu', 'disable-gpu-compositing'];
  }
  if (level === 'sandbox-disabled') {
    return ['disable-gpu-sandbox'];
  }
  return [];
}

/**
 * A GPU loss is fatal (worth escalating the ladder for) unless Chromium
 * reports a clean/killed exit or the self-recovering device-lost code.
 */
function isGpuLossFatal(reason, exitCode) {
  if (reason === 'clean-exit' || reason === 'killed') return false;
  if (exitCode === GPU_DEVICE_LOST_EXIT_CODE) return false;
  return true;
}

/**
 * Decide the response to one fatal GPU process loss.
 *
 * @returns {{
 *   action: 'relaunch'|'wait'|'stop',
 *   level: string,
 *   state: {level: string, failures: number, stableLaunches: number},
 *   switched: boolean
 * }}
 *
 * - never-rendered loss: escalate one level immediately and ask for relaunch.
 * - rendered loss: keep the current level while failures < 3; on the third
 *   failure escalate (relaunch applies the persisted level) or stop at the
 *   bottom of the ladder.
 * - top level: stop automatic escalation and let the user retry manually.
 */
function planGpuFallbackResponse({ state, harnessRendered } = {}) {
  const current = normalizeGpuFallbackState(state);
  const failures = current.failures + 1;
  const countedState = { level: current.level, failures, stableLaunches: 0 };

  if (!harnessRendered) {
    const lower = lowerGpuFallbackLevel(current.level);
    if (lower === null) {
      return { action: 'stop', level: current.level, state: countedState, switched: false };
    }
    return {
      action: 'relaunch',
      level: lower,
      state: { level: lower, failures: 0, stableLaunches: 0 },
      switched: true,
    };
  }

  if (failures >= FAILURES_BEFORE_ESCALATION) {
    const lower = lowerGpuFallbackLevel(current.level);
    if (lower === null) {
      return { action: 'stop', level: current.level, state: countedState, switched: false };
    }
    return {
      action: 'relaunch',
      level: lower,
      state: { level: lower, failures: 0, stableLaunches: 0 },
      switched: true,
    };
  }

  return { action: 'wait', level: current.level, state: countedState, switched: false };
}

/**
 * Account one stable 60 s launch. Every stable launch clears the failure
 * streak; after 20 stable launches at a reduced level, step one level back up.
 */
function planStableLaunch(state) {
  const current = normalizeGpuFallbackState(state);
  const stableLaunches = current.stableLaunches + 1;

  if (current.level !== 'default' && stableLaunches >= STABLE_LAUNCHES_BEFORE_STEP_UP) {
    const higher = higherGpuFallbackLevel(current.level);
    if (higher !== null) {
      return {
        state: { level: higher, failures: 0, stableLaunches: 0 },
        level: higher,
        steppedUp: true,
      };
    }
  }

  return {
    state: {
      level: current.level,
      failures: 0,
      stableLaunches: Math.min(stableLaunches, STABLE_LAUNCHES_BEFORE_STEP_UP),
    },
    level: current.level,
    steppedUp: false,
  };
}

/** Parse a persisted state value; malformed input yields the default state. */
function parseGpuFallbackState(raw) {
  if (typeof raw === 'string') {
    try {
      return normalizeGpuFallbackState(JSON.parse(raw));
    } catch {
      return defaultGpuFallbackState();
    }
  }
  return normalizeGpuFallbackState(raw);
}

function serializeGpuFallbackState(state) {
  return JSON.stringify(normalizeGpuFallbackState(state));
}

function gpuFallbackFilePath(userDataDir) {
  return path.join(userDataDir, STATE_FILE_NAME);
}

/** Read <userDataDir>/gpu-fallback.json; missing/corrupt file -> default. */
function loadGpuFallbackState(userDataDir, deps = {}) {
  if (!userDataDir) return defaultGpuFallbackState();
  const fsImpl = deps.fs || fs;
  try {
    return parseGpuFallbackState(fsImpl.readFileSync(gpuFallbackFilePath(userDataDir), 'utf8'));
  } catch {
    return defaultGpuFallbackState();
  }
}

/** Atomically persist the state to <userDataDir>/gpu-fallback.json. */
function saveGpuFallbackState(userDataDir, state, deps = {}) {
  if (!userDataDir) throw new TypeError('saveGpuFallbackState requires userDataDir');
  const fsImpl = deps.fs || fs;
  const filePath = gpuFallbackFilePath(userDataDir);
  const payload = `${serializeGpuFallbackState(state)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    fsImpl.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fsImpl.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; surface the original error.
    }
    throw error;
  }
  return filePath;
}

module.exports = {
  LEVELS,
  GPU_DEVICE_LOST_EXIT_CODE,
  FAILURES_BEFORE_ESCALATION,
  STABLE_LAUNCHES_BEFORE_STEP_UP,
  STATE_FILE_NAME,
  defaultGpuFallbackState,
  isKnownGpuFallbackLevel,
  normalizeGpuFallbackState,
  gpuFallbackSwitches,
  isGpuLossFatal,
  planGpuFallbackResponse,
  planStableLaunch,
  parseGpuFallbackState,
  serializeGpuFallbackState,
  gpuFallbackFilePath,
  loadGpuFallbackState,
  saveGpuFallbackState,
};
