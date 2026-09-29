/**
 * ready-url: pure parser for the `dsh web` startup line.
 * No side effects, no I/O; used by HarnessRuntime to detect the authenticated URL.
 */
'use strict';

const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\u001B[@-Z\\-_]/g;

// The ready line is emitted as: `dsh web: http://127.0.0.1:<port>/?token=<token>`
// Surrounding text (including the optional " (LAN: ...)" suffix) is tolerated.
const READY_PATTERN =
  /dsh\s+web:\s*http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=([^\s&?#]+)(?=$|\s|[.,;:!?)\]}"'])/;

// Sentence punctuation / closing brackets directly after the token are surrounding
// text, not part of the token.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"']+$/;

function stripAnsi(text) {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '');
}

/**
 * Parse one log line for the dsh web ready URL.
 * @param {unknown} line raw (possibly ANSI-coloured) log line
 * @returns {{url: string, host: string, port: number, token: string}|null}
 */
function parseReadyUrl(line) {
  if (typeof line !== 'string' || line.length === 0) return null;

  const match = READY_PATTERN.exec(stripAnsi(line));
  if (match === null) return null;

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const token = match[2].replace(TRAILING_PUNCTUATION, '');
  if (token.length === 0) return null;

  const host = '127.0.0.1';
  return {
    url: `http://${host}:${port}/?token=${token}`,
    host,
    port,
    token,
  };
}

module.exports = { parseReadyUrl };
