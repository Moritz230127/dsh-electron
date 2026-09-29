/**
 * HarnessRuntime: supervises the `dsh web` child process.
 * Pure Node (EventEmitter + child_process), no Electron imports and no shell.
 *
 * Events (per docs/ARCHITECTURE.md section 2):
 *   starting ({command, args})
 *   stdout   ({line})
 *   stderr   ({line})
 *   ready    ({url, host, port, token})
 *   fatal    ({error, message, logTail})  child died before ready, unexpectedly
 *   exit     ({code, signal, expected, logTail})
 */
'use strict';

const { EventEmitter } = require('node:events');
const { spawn: nodeSpawn } = require('node:child_process');
const { parseReadyUrl } = require('./ready-url');

const MAX_LOG_TAIL_LINES = 200;
const DEFAULT_STOP_TIMEOUT_MS = 8000;

function noop() {}

function normalizeLogger(logger) {
  if (logger === null || typeof logger !== 'object') {
    return { debug: noop, info: noop, warn: noop, error: noop };
  }
  return {
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

function stripTrailingCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function normalizeStopTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_STOP_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError('HarnessRuntime: options.stopTimeoutMs must be a non-negative finite number');
  }
  return parsed;
}

class HarnessRuntime extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command absolute path or PATH name of the dsh binary
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {{info?: Function, warn?: Function, error?: Function, debug?: Function}} [options.logger]
   * @param {Function} [options.spawn] injected spawn seam (child_process.spawn shape)
   * @param {number} [options.stopTimeoutMs]
   */
  constructor(options = {}) {
    super();

    if (typeof options.command !== 'string' || options.command.length === 0) {
      throw new TypeError('HarnessRuntime: options.command must be a non-empty string');
    }
    if (options.args !== undefined && !Array.isArray(options.args)) {
      throw new TypeError('HarnessRuntime: options.args must be an array');
    }

    this.command = options.command;
    this.args = options.args === undefined ? [] : options.args.slice();
    this.cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd();
    this.env = options.env === undefined || options.env === null ? process.env : options.env;
    this.stopTimeoutMs = normalizeStopTimeout(options.stopTimeoutMs);

    this._logger = normalizeLogger(options.logger);
    this._spawn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn;

    this._child = null;
    this._running = false;
    this._ready = false;
    this._finalized = false;
    this._stopRequested = false;
    this._stopPromise = null;
    this._stopResolve = null;
    this._killTimer = null;
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._tail = [];

    /** @type {{url: string, host: string, port: number, token: string}|null} */
    this.readyInfo = null;
  }

  /** True while a child process has been spawned and has not been finalized. */
  isRunning() {
    return this._running === true && this._child !== null;
  }

  /** Last <=200 diagnostic lines, joined with '\n'. */
  getLogTail() {
    return this._tail.join('\n');
  }

  /** Copy of the bounded diagnostic tail (each entry is one line). */
  getLogTailLines() {
    return this._tail.slice();
  }

  /**
   * Spawn the child. Resolves once the process has been spawned (not once ready).
   * @returns {Promise<{pid: number|undefined, command: string}>}
   */
  start() {
    if (this._running) {
      return Promise.reject(new Error('HarnessRuntime: already running'));
    }

    this._resetRunState();
    this.emit('starting', { command: this.command, args: this.args.slice() });
    this._logger.debug(`runtime: spawning ${this.command} ${this.args.join(' ')}`.trim());

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (child === null || typeof child !== 'object' || typeof child.on !== 'function') {
          throw new TypeError('spawn seam must return a ChildProcess-like EventEmitter');
        }
      } catch (error) {
        this._running = false;
        this._finalized = true;
        this._logger.error(`runtime: failed to spawn ${this.command}: ${error.message}`);
        this.emit('fatal', {
          error,
          message: `failed to spawn ${this.command}: ${error.message}`,
          logTail: this.getLogTail(),
        });
        reject(error);
        return;
      }

      this._child = child;
      this._running = true;
      this._attachChild(child);
      this._logger.info(`runtime: spawned ${this.command} (pid ${child.pid === undefined ? 'unknown' : child.pid})`);
      resolve({ pid: child.pid, command: this.command });
    });
  }

  /**
   * SIGTERM, then SIGKILL after stopTimeoutMs. Resolves even when the child is
   * already gone or does not report its exit after SIGKILL.
   * @returns {Promise<void>}
   */
  stop() {
    if (this._stopPromise !== null) return this._stopPromise;

    if (this._child === null || !this._running) {
      this._stopRequested = true;
      return Promise.resolve();
    }

    this._stopRequested = true;
    const child = this._child;

    this._stopPromise = new Promise((resolve) => {
      this._stopResolve = resolve;

      const alreadyGone =
        (child.exitCode !== undefined && child.exitCode !== null) ||
        (child.signalCode !== undefined && child.signalCode !== null);
      if (alreadyGone) {
        this._settleStop();
        return;
      }

      this._logger.info(`runtime: stopping ${this.command} with SIGTERM`);
      try {
        child.kill('SIGTERM');
      } catch (error) {
        this._logger.warn(`runtime: failed to send SIGTERM: ${error.message}`);
      }

      // A synchronous fake child may have exited during kill(); do not arm the timer then.
      if (this._finalized || child !== this._child) {
        this._settleStop();
        return;
      }

      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        if (this._finalized || child !== this._child) {
          this._settleStop();
          return;
        }
        this._logger.warn(`runtime: SIGTERM timed out after ${this.stopTimeoutMs}ms; sending SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch (error) {
          this._logger.warn(`runtime: failed to send SIGKILL: ${error.message}`);
        }
        setImmediate(() => {
          if (!this._finalized && child === this._child) {
            // SIGKILL is authoritative even if no exit event is observed.
            this._running = false;
          }
          this._settleStop();
        });
      }, this.stopTimeoutMs);
    });

    return this._stopPromise;
  }

  /** Stop (if needed) and start a fresh child process. */
  async restart() {
    await this.stop();
    return this.start();
  }

  _resetRunState() {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    this._child = null;
    this._running = false;
    this._ready = false;
    this._finalized = false;
    this._stopRequested = false;
    this._stopPromise = null;
    this._stopResolve = null;
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._tail = [];
    this.readyInfo = null;
  }

  _attachChild(child) {
    if (child.stdout !== null && typeof child.stdout === 'object' && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => this._onData(child, 'stdout', chunk));
    }
    if (child.stderr !== null && typeof child.stderr === 'object' && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => this._onData(child, 'stderr', chunk));
    }

    // 'error' must always have a listener or Node throws.
    child.on('error', (error) => this._onChildError(child, error));
    child.on('exit', (code, signal) => this._finalize(child, code, signal, null));
    child.on('close', (code, signal) => this._finalize(child, code, signal, null));
  }

  _onData(child, stream, chunk) {
    if (child !== this._child || this._finalized) return;

    let text;
    if (typeof chunk === 'string') text = chunk;
    else if (Buffer.isBuffer(chunk)) text = chunk.toString('utf8');
    else text = String(chunk);

    if (stream === 'stdout') this._stdoutBuffer += text;
    else this._stderrBuffer += text;
    this._drainLines(stream);
  }

  _drainLines(stream) {
    let buffer = stream === 'stdout' ? this._stdoutBuffer : this._stderrBuffer;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stripTrailingCr(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      this._handleLine(stream, line);
      newlineIndex = buffer.indexOf('\n');
    }
    if (stream === 'stdout') this._stdoutBuffer = buffer;
    else this._stderrBuffer = buffer;
  }

  _handleLine(stream, line) {
    this._pushTail(line);

    if (stream === 'stdout') {
      this.emit('stdout', { line });
      if (!this._ready) {
        const ready = parseReadyUrl(line);
        if (ready !== null) {
          this._ready = true;
          this.readyInfo = ready;
          this._logger.info(`runtime: ready at ${ready.url}`);
          this.emit('ready', ready);
        }
      }
      return;
    }

    this.emit('stderr', { line });
  }

  _pushTail(line) {
    this._tail.push(line);
    if (this._tail.length > MAX_LOG_TAIL_LINES) {
      this._tail.splice(0, this._tail.length - MAX_LOG_TAIL_LINES);
    }
  }

  _flushBuffers() {
    if (this._stdoutBuffer.length > 0) {
      const line = stripTrailingCr(this._stdoutBuffer);
      this._stdoutBuffer = '';
      this._handleLine('stdout', line);
    }
    if (this._stderrBuffer.length > 0) {
      const line = stripTrailingCr(this._stderrBuffer);
      this._stderrBuffer = '';
      this._handleLine('stderr', line);
    }
  }

  _onChildError(child, error) {
    if (child !== this._child) return;
    this._logger.error(`runtime: child error: ${error.message}`);
    this._finalize(child, null, null, error);
  }

  /**
   * Emit exactly one terminal event for the current child.
   * Unexpected exit before ready -> 'fatal'; unexpected exit after ready -> 'exit'
   * expected=false; exit after stop() -> 'exit' expected=true.
   */
  _finalize(child, code, signal, error) {
    if (child !== this._child || this._finalized) return;

    this._finalized = true;
    this._running = false;
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    this._flushBuffers();

    const logTail = this.getLogTail();
    const exitCode = code === undefined ? null : code;
    const exitSignal = signal === undefined ? null : signal;

    if (this._stopRequested) {
      this._logger.info(`runtime: stopped (code=${exitCode}, signal=${exitSignal})`);
      this.emit('exit', { code: exitCode, signal: exitSignal, expected: true, logTail });
    } else if (!this._ready) {
      const failure =
        error instanceof Error
          ? error
          : new Error(`dsh exited before ready (code=${exitCode}, signal=${exitSignal})`);
      const message = error instanceof Error ? `dsh failed before ready: ${error.message}` : failure.message;
      this._logger.error(`runtime: ${message}`);
      this.emit('fatal', { error: failure, message, logTail });
    } else {
      this._logger.warn(`runtime: exited unexpectedly (code=${exitCode}, signal=${exitSignal})`);
      this.emit('exit', { code: exitCode, signal: exitSignal, expected: false, logTail });
    }

    this._settleStop();
  }

  _settleStop() {
    if (this._stopResolve === null) return;
    const resolve = this._stopResolve;
    this._stopResolve = null;
    resolve();
  }
}

module.exports = { HarnessRuntime };
