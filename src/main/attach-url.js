/**
 * attach-url: poll-based URL-file handoff for the v0.2 attach UI.
 *
 * The host supervisor publishes `current-url` (and optional `status.json`)
 * with atomic tmp+rename writes. This helper polls the path every 500 ms
 * instead of using fs.watch, so an atomic rename is observed as a complete
 * new URL and a removed file is observed as null. It emits:
 *   'url'          {url, previousUrl, changed}
 *   'missing'      {previousUrl}
 *   'status'       {state, message, dshVersion, runtimeSource, updatedAt}
 *   'status-error' {error, reason}
 *
 * No Electron imports; fs/timers are injectable so unit tests stay pure.
 */
'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STATUS_INTERVAL_MS = 1000;

/** Read the URL file; missing/empty/unreadable -> null. */
function readUrlFile(filePath, fsImpl = fs) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const text = (typeof raw === 'string' ? raw : String(raw)).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read and validate status.json.
 * Malformed/unreadable input returns {ok:false, reason}; never throws.
 */
function readStatusFile(filePath, fsImpl = fs) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'status path not configured' };
  }
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'status.json must contain an object' };
    }
    return {
      ok: true,
      status: {
        state: typeof parsed.state === 'string' ? parsed.state : '',
        message: typeof parsed.message === 'string' ? parsed.message : '',
        dshVersion: typeof parsed.dshVersion === 'string' ? parsed.dshVersion : '',
        runtimeSource: typeof parsed.runtimeSource === 'string' ? parsed.runtimeSource : '',
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.message ? error.message : 'status.json is unreadable',
      error,
    };
  }
}

class AttachUrlWatcher extends EventEmitter {
  /**
   * @param {{
   *   filePath: string,
   *   statusPath?: string|null,
   *   intervalMs?: number,
   *   statusIntervalMs?: number,
   *   fs?: object,
   *   timers?: {setTimeout: Function, clearTimeout: Function},
   *   now?: Function
   * }} options
   */
  constructor({
    filePath,
    statusPath = null,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    statusIntervalMs = DEFAULT_STATUS_INTERVAL_MS,
    fs: fsImpl = fs,
    timers = { setTimeout, clearTimeout },
    now = () => Date.now(),
  } = {}) {
    super();
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('AttachUrlWatcher requires filePath');
    }
    if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
      throw new TypeError('AttachUrlWatcher requires setTimeout/clearTimeout seams');
    }
    this.filePath = filePath;
    this.statusPath = typeof statusPath === 'string' && statusPath.length > 0 ? statusPath : null;
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_POLL_INTERVAL_MS;
    this.statusIntervalMs = Number.isFinite(statusIntervalMs) && statusIntervalMs > 0
      ? statusIntervalMs
      : DEFAULT_STATUS_INTERVAL_MS;
    this.fs = fsImpl;
    this.timers = timers;
    this.now = now;

    this.running = false;
    this.currentUrl = null;
    this.lastStatus = null;

    this._timer = null;
    this._ticks = 0;
    this._statusEvery = Math.max(1, Math.round(this.statusIntervalMs / this.intervalMs));
    this._missingEmitted = false;
    this._lastStatusKey = null;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.poll();
    this._schedule();
    return this;
  }

  stop() {
    this.running = false;
    if (this._timer !== null) {
      this.timers.clearTimeout(this._timer);
      this._timer = null;
    }
    return true;
  }

  _schedule() {
    if (!this.running) return;
    this._timer = this.timers.setTimeout(() => {
      this._timer = null;
      if (!this.running) return;
      this.poll();
      this._schedule();
    }, this.intervalMs);
  }

  /** One synchronous poll; public so tests can drive it without timers. */
  poll() {
    const url = readUrlFile(this.filePath, this.fs);
    if (url !== null) {
      this._missingEmitted = false;
      if (url !== this.currentUrl) {
        const previousUrl = this.currentUrl;
        this.currentUrl = url;
        this.emit('url', { url, previousUrl, changed: previousUrl !== null, at: this.now() });
      }
    } else if (!this._missingEmitted) {
      const previousUrl = this.currentUrl;
      this.currentUrl = null;
      this._missingEmitted = true;
      this.emit('missing', { previousUrl, at: this.now() });
    }

    this._ticks += 1;
    if (this.statusPath !== null && this._ticks % this._statusEvery === 0) {
      this._pollStatus();
    }
    return { url: this.currentUrl, missing: this._missingEmitted };
  }

  _pollStatus() {
    const result = readStatusFile(this.statusPath, this.fs);
    if (!result.ok) {
      const key = `error:${result.reason}`;
      if (key !== this._lastStatusKey) {
        this._lastStatusKey = key;
        this.emit('status-error', { error: result.error, reason: result.reason, at: this.now() });
      }
      return;
    }
    const key = JSON.stringify(result.status);
    if (key !== this._lastStatusKey) {
      this._lastStatusKey = key;
      this.lastStatus = result.status;
      this.emit('status', result.status);
    }
  }
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_INTERVAL_MS,
  AttachUrlWatcher,
  readUrlFile,
  readStatusFile,
};
