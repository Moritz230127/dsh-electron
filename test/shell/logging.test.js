'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogger, createNullLogger } = require('../../src/main/logging');

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function captureStream() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('createLogger appends to <userDataDir>/logs/main.log', () => {
  const userData = makeTempDir('dsh-shell-log-');
  const out = captureStream();
  const err = captureStream();
  const logger = createLogger({ userDataDir: userData, level: 'debug', stdout: out, stderr: err });

  logger.info('hello', { port: 1234 });
  logger.warn('careful');
  logger.error(new Error('boom'));
  logger.debug('detail');

  const content = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  const logLines = content
    .split('\n')
    .filter((line) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(DEBUG|INFO|WARN|ERROR)\]/.test(line));
  assert.equal(logLines.length, 4);
  assert.match(content, /\[INFO\] hello \{"port":1234\}/);
  assert.match(content, /\[WARN\] careful/);
  assert.match(content, /\[ERROR\] Error: boom/);
  assert.match(content, /\[DEBUG\] detail/);

  assert.equal(out.chunks.length, 2, 'info + debug on stdout');
  assert.equal(err.chunks.length, 2, 'warn + error on stderr');
  assert.equal(logger.filePath, path.join(userData, 'logs', 'main.log'));
});

test('log level filters debug below the threshold', () => {
  const userData = makeTempDir('dsh-shell-log-');
  const out = captureStream();
  const logger = createLogger({
    userDataDir: userData,
    level: 'info',
    stdout: out,
    stderr: captureStream(),
  });

  assert.equal(logger.isEnabled('debug'), false);
  assert.equal(logger.isEnabled('error'), true);
  logger.debug('hidden');
  logger.info('shown');

  const content = fs.readFileSync(logger.filePath, 'utf8');
  assert.equal(content.includes('hidden'), false);
  assert.equal(content.includes('shown'), true);
  assert.equal(out.chunks.length, 1);
});

test('serializes circular and Error values without throwing', () => {
  const userData = makeTempDir('dsh-shell-log-');
  const logger = createLogger({
    userDataDir: userData,
    level: 'debug',
    stdout: captureStream(),
    stderr: captureStream(),
  });
  const circular = { name: 'loop' };
  circular.self = circular;

  assert.doesNotThrow(() => logger.info('circular', circular));
  assert.doesNotThrow(() => logger.error('err', new Error('nested')));

  const content = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(content, /\[INFO\] circular \[object Object\]/);
  assert.match(content, /\[ERROR\] err Error: nested/);
});

test('degrades to stream-only when the log directory cannot be created', () => {
  const blocker = makeTempDir('dsh-shell-log-');
  const filePath = path.join(blocker, 'not-a-dir');
  fs.writeFileSync(filePath, 'file');
  const out = captureStream();
  const logger = createLogger({ userDataDir: path.join(filePath, 'child'), stdout: out });

  assert.equal(logger.filePath, null);
  assert.doesNotThrow(() => logger.info('still works'));
  assert.equal(out.chunks.length, 1);
});

test('createNullLogger is a safe no-op', () => {
  const logger = createNullLogger();
  assert.equal(logger.isEnabled('error'), false);
  assert.doesNotThrow(() => {
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
  });
  assert.equal(logger.flush(), true);
});

test('flush/close do not throw and close stops file writes', () => {
  const userData = makeTempDir('dsh-shell-log-');
  const logger = createLogger({
    userDataDir: userData,
    level: 'info',
    stdout: captureStream(),
    stderr: captureStream(),
  });
  logger.info('before');
  assert.equal(logger.flush(), true);
  logger.close();
  assert.doesNotThrow(() => logger.info('after'));

  const content = fs.readFileSync(logger.filePath, 'utf8');
  assert.equal(content.includes('before'), true);
  assert.equal(content.includes('after'), false);
});
