'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseReadyUrl } = require('../../src/main/runtime/ready-url.js');

test('parses the exact ready line', () => {
  assert.deepEqual(parseReadyUrl('dsh web: http://127.0.0.1:34567/?token=abc123'), {
    url: 'http://127.0.0.1:34567/?token=abc123',
    host: '127.0.0.1',
    port: 34567,
    token: 'abc123',
  });
});

test('tolerates ANSI colours, surrounding text, CRLF and the LAN suffix', () => {
  const line =
    'boot \u001b[32mdsh web: http://127.0.0.1:43210/?token=A-b_c9\u001b[0m' +
    ' (LAN: http://192.168.1.7:43210/?token=A-b_c9)\r\n';
  assert.deepEqual(parseReadyUrl(line), {
    url: 'http://127.0.0.1:43210/?token=A-b_c9',
    host: '127.0.0.1',
    port: 43210,
    token: 'A-b_c9',
  });
});

test('handles surrounding text directly before the prefix', () => {
  const parsed = parseReadyUrl('ready: dsh web: http://127.0.0.1:8080/?token=tok trailing text');
  assert.equal(parsed.url, 'http://127.0.0.1:8080/?token=tok');
  assert.equal(parsed.port, 8080);
});

test('only accepts the 127.0.0.1 host', () => {
  assert.equal(parseReadyUrl('dsh web: http://localhost:3000/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://0.0.0.0:3000/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://[::1]:3000/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1.evil.example:3000/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: https://127.0.0.1:3000/?token=abc'), null);
});

test('keeps internal token punctuation and trims trailing punctuation', () => {
  assert.deepEqual(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token=abc.def'), {
    url: 'http://127.0.0.1:3000/?token=abc.def',
    host: '127.0.0.1',
    port: 3000,
    token: 'abc.def',
  });
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token=abc123.').token, 'abc123');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token=abc123)').token, 'abc123');
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token=abc, extra').token, 'abc');
});

test('rejects additional query parameters after the token', () => {
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token=abc&x=1'), null);
});

test('rejects malformed or out-of-range ports', () => {
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:0/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:65536/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:999999/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:12x/?token=abc'), null);
});

test('rejects lines without prefix or token', () => {
  assert.equal(parseReadyUrl('http://127.0.0.1:3000/?token=abc'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/'), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?token='), null);
  assert.equal(parseReadyUrl('dsh web: http://127.0.0.1:3000/?notoken=abc'), null);
});

test('rejects non-string input and empty input', () => {
  assert.equal(parseReadyUrl(null), null);
  assert.equal(parseReadyUrl(undefined), null);
  assert.equal(parseReadyUrl(1234), null);
  assert.equal(parseReadyUrl(Buffer.from('dsh web: http://127.0.0.1:3000/?token=abc')), null);
  assert.equal(parseReadyUrl(''), null);
});

test('is pure: repeated parses return independent equal objects', () => {
  const line = '\u001b[36mdsh web: http://127.0.0.1:3000/?token=abc\u001b[0m';
  const first = parseReadyUrl(line);
  const second = parseReadyUrl(line);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
});
