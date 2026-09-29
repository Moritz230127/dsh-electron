/**
 * logging: tiny dependency-free logger used by the Electron main process.
 *
 * Appends structured lines to <userDataDir>/logs/main.log and mirrors them to
 * the process streams (warn/error -> stderr). File failures degrade to
 * stream-only logging and never throw into app flow. Library modules must
 * receive this logger instead of calling console.* themselves.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVEL_VALUES = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

function normalizeLevel(level) {
  if (typeof level !== 'string') return 'info';
  const lower = level.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_VALUES, lower) ? lower : 'info';
}

function formatArgument(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unprintable]';
    }
  }
}

function createLogger({
  userDataDir = null,
  level = 'info',
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
  fsImpl = fs,
} = {}) {
  const threshold = LEVEL_VALUES[normalizeLevel(level)];
  let logFilePath = null;
  let closed = false;

  if (typeof userDataDir === 'string' && userDataDir.length > 0) {
    try {
      const logDir = path.join(userDataDir, 'logs');
      fsImpl.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      logFilePath = path.join(logDir, 'main.log');
    } catch {
      logFilePath = null;
    }
  }

  function isEnabled(name) {
    const normalized = normalizeLevel(name);
    return LEVEL_VALUES[normalized] >= threshold;
  }

  function write(levelName, args) {
    if (closed || !isEnabled(levelName)) return;
    const nowValue = now();
    const timestamp = nowValue instanceof Date ? nowValue.toISOString() : String(nowValue);
    const line = `${timestamp} [${levelName.toUpperCase()}] ${args.map(formatArgument).join(' ')}\n`;

    if (logFilePath !== null) {
      try {
        fsImpl.appendFileSync(logFilePath, line, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // Stream output below remains available; never break app flow.
      }
    }

    const stream = levelName === 'warn' || levelName === 'error' ? stderr : stdout;
    try {
      if (stream && typeof stream.write === 'function') stream.write(line);
    } catch {
      // Last-resort logging must be silent.
    }
  }

  return {
    level: normalizeLevel(level),
    filePath: logFilePath,
    isEnabled,
    flush() {
      // appendFileSync is synchronous, so there is nothing buffered to flush.
      return true;
    },
    close() {
      closed = true;
      return true;
    },
    debug(...args) {
      write('debug', args);
    },
    info(...args) {
      write('info', args);
    },
    warn(...args) {
      write('warn', args);
    },
    error(...args) {
      write('error', args);
    },
  };
}

/** Logger for code paths without userData yet (or tests). */
function createNullLogger() {
  const noop = () => {};
  return {
    level: 'silent',
    filePath: null,
    isEnabled: () => false,
    flush: () => true,
    close: () => true,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

module.exports = {
  LEVEL_VALUES,
  createLogger,
  createNullLogger,
};
