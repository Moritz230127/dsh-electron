/**
 * health: bounded HTTP readiness probe for the dsh web URL.
 * Pure Node, loopback only; http/https request is injectable for tests.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_INTERVAL_MS = 250;

/**
 * Production request seam: like http(s).get(url, onResponse); errors surface as
 * an 'error' event on the returned request object.
 */
function defaultRequest(url, onResponse) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return transport.get(url, onResponse);
}

/**
 * Resolve as soon as any HTTP response arrives (200/303/401 all count).
 * Connection/protocol errors are retried every intervalMs until timeoutMs.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=15000] overall deadline
 * @param {number} [options.intervalMs=250] delay between connection-error retries
 * @param {(url: string, onResponse: Function, onError: Function) => any} [options.request] injectable seam
 * @returns {Promise<import('node:http').IncomingMessage|any>}
 */
function waitForHealth(url, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  const intervalMs = options.intervalMs === undefined ? DEFAULT_INTERVAL_MS : Number(options.intervalMs);
  const request = typeof options.request === 'function' ? options.request : defaultRequest;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new TypeError('waitForHealth: options.timeoutMs must be a non-negative finite number'));
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    return Promise.reject(new TypeError('waitForHealth: options.intervalMs must be a non-negative finite number'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let lastError = null;
    let activeRequest = null;
    let retryTimer = null;
    let timeoutTimer = null;

    const clearTimers = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const destroyActiveRequest = () => {
      if (activeRequest === null) return;
      try {
        if (typeof activeRequest.destroy === 'function') activeRequest.destroy();
        else if (typeof activeRequest.abort === 'function') activeRequest.abort();
      } catch {
        // best-effort cleanup only
      }
      activeRequest = null;
    };

    const succeed = (response) => {
      if (settled) return;
      settled = true;
      clearTimers();
      activeRequest = null;
      // Drain the response so its socket cannot keep the process alive.
      try {
        if (response !== null && typeof response === 'object' && typeof response.resume === 'function') {
          response.resume();
        }
      } catch {
        // ignore drain failures; the status line already arrived
      }
      resolve(response);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      destroyActiveRequest();
      reject(error);
    };

    const onError = (error) => {
      if (settled) return;
      lastError = error instanceof Error ? error : new Error(String(error));
      // A misbehaving seam may emit 'error' more than once; keep one retry pending.
      if (retryTimer !== null) return;
      retryTimer = setTimeout(attempt, intervalMs);
    };

    const attempt = () => {
      if (settled) return;
      retryTimer = null;
      try {
        activeRequest = request(url, succeed, onError);
        if (activeRequest !== null && typeof activeRequest === 'object' && typeof activeRequest.on === 'function') {
          activeRequest.on('error', onError);
        }
      } catch (error) {
        activeRequest = null;
        onError(error);
      }
    };

    timeoutTimer = setTimeout(() => {
      const detail = lastError === null ? '' : `: ${lastError.message}`;
      fail(new Error(`waitForHealth timed out after ${timeoutMs}ms waiting for ${url}${detail}`));
    }, timeoutMs);

    attempt();
  });
}

module.exports = { waitForHealth };
