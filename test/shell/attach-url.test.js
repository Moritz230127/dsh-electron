/**
 * Unit tests for src/main/attach-url.js: poll-based URL file + status.json.
 * Real temp files exercise atomic rename semantics; timers/fs are injectable.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AttachUrlWatcher,
  readStatusFile,
  readUrlFile,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATUS_INTERVAL_MS,
} = require('../../src/main/attach-url');

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    tick() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.fn();
    },
    firstDelay() {
      const first = pending.values().next();
      return first.done ? null : first.value.ms;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('readUrlFile trims content and returns null for empty/missing files', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  assert.equal(readUrlFile(filePath), null);

  fs.writeFileSync(filePath, '  http://127.0.0.1:1/?token=abc  \n');
  assert.equal(readUrlFile(filePath), 'http://127.0.0.1:1/?token=abc');

  fs.writeFileSync(filePath, '   \n');
  assert.equal(readUrlFile(filePath), null);
  assert.equal(readUrlFile('', fs), null);
});

test('watcher emits url when the file appears, changes, and missing when removed', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  const watcher = new AttachUrlWatcher({ filePath });
  const events = [];
  watcher.on('url', (event) => events.push({ type: 'url', ...event }));
  watcher.on('missing', (event) => events.push({ type: 'missing', ...event }));

  watcher.poll();
  assert.deepEqual(events.map((event) => event.type), ['missing']);
  assert.equal(events[0].previousUrl, null);

  const url1 = 'http://127.0.0.1:41001/?token=one';
  fs.writeFileSync(filePath, `${url1}\n`);
  watcher.poll();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'url');
  assert.equal(events[1].url, url1);
  assert.equal(events[1].changed, false, 'first URL is not a change');

  // Same content -> no duplicate emission.
  fs.writeFileSync(filePath, `${url1}\n`);
  watcher.poll();
  assert.equal(events.length, 2);

  // Atomic rename to a new URL -> one 'url' change event.
  const url2 = 'http://127.0.0.1:41002/?token=two';
  atomicWrite(filePath, url2);
  watcher.poll();
  assert.equal(events.length, 3);
  assert.equal(events[2].type, 'url');
  assert.equal(events[2].url, url2);
  assert.equal(events[2].previousUrl, url1);
  assert.equal(events[2].changed, true);

  // Removal -> one 'missing' event, no repeats while still missing.
  fs.unlinkSync(filePath);
  watcher.poll();
  watcher.poll();
  const missingEvents = events.filter((event) => event.type === 'missing');
  assert.equal(missingEvents.length, 2);
  assert.equal(missingEvents[1].previousUrl, url2);
});

test('atomic tmp+rename replacement is read as a complete new URL', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  fs.writeFileSync(filePath, 'http://127.0.0.1:42001/?token=old');
  const watcher = new AttachUrlWatcher({ filePath });
  const urls = [];
  watcher.on('url', ({ url }) => urls.push(url));
  watcher.poll();
  assert.deepEqual(urls, ['http://127.0.0.1:42001/?token=old']);

  atomicWrite(filePath, 'http://127.0.0.1:42002/?token=new');
  watcher.poll();
  assert.deepEqual(urls, [
    'http://127.0.0.1:42001/?token=old',
    'http://127.0.0.1:42002/?token=new',
  ]);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('status.json parse failures never throw and recover when valid JSON returns', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  const statusPath = path.join(dir, 'status.json');
  const watcher = new AttachUrlWatcher({ filePath, statusPath });
  const statuses = [];
  const errors = [];
  watcher.on('status', (status) => statuses.push(status));
  watcher.on('status-error', (error) => errors.push(error));

  watcher.poll(); // tick 1: no status read (status interval = 2 ticks)
  fs.writeFileSync(statusPath, '{not json');
  watcher.poll(); // tick 2: parse failure
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /JSON|Unexpected|token/i);

  watcher.poll(); // tick 3: no status read
  watcher.poll(); // tick 4: same parse failure -> no duplicate error
  assert.equal(errors.length, 1);

  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'running',
    message: 'server ready',
    dshVersion: '0.2.0',
    runtimeSource: 'system',
    updatedAt: '2026-09-30T00:00:00Z',
  }));
  watcher.poll(); // tick 5
  watcher.poll(); // tick 6: valid status emitted once
  watcher.poll(); // tick 7
  watcher.poll(); // tick 8: unchanged -> no duplicate
  assert.deepEqual(statuses, [{
    state: 'running',
    message: 'server ready',
    dshVersion: '0.2.0',
    runtimeSource: 'system',
    updatedAt: '2026-09-30T00:00:00Z',
  }]);
});

test('status is polled once per second (two 500 ms ticks)', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  const statusPath = path.join(dir, 'status.json');
  let statusReads = 0;
  const fsImpl = {
    readFileSync(target, encoding) {
      if (target === statusPath) statusReads += 1;
      return fs.readFileSync(target, encoding);
    },
  };
  const timers = makeFakeTimers();
  const watcher = new AttachUrlWatcher({
    filePath,
    statusPath,
    fs: fsImpl,
    timers,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    statusIntervalMs: DEFAULT_STATUS_INTERVAL_MS,
  });
  watcher.start();
  assert.equal(timers.firstDelay(), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(statusReads, 0, 'first immediate tick does not read status');
  timers.tick(); // tick 2
  timers.tick(); // tick 3
  timers.tick(); // tick 4
  assert.equal(statusReads, 2);
  watcher.stop();
});

test('stop() clears the polling timer and emits nothing afterwards', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const filePath = path.join(dir, 'current-url');
  const timers = makeFakeTimers();
  const watcher = new AttachUrlWatcher({ filePath, timers });
  const events = [];
  watcher.on('missing', () => events.push('missing'));
  watcher.on('url', () => events.push('url'));

  watcher.start();
  assert.equal(watcher.running, true);
  assert.equal(events.length, 1, 'start() polls immediately');
  assert.equal(timers.pendingCount, 1);
  watcher.start(); // idempotent
  assert.equal(timers.pendingCount, 1);

  watcher.stop();
  assert.equal(watcher.running, false);
  assert.equal(timers.pendingCount, 0);
  atomicWrite(filePath, 'http://127.0.0.1:43001/?token=late');
  timers.tick();
  assert.equal(events.length, 1, 'no poll after stop()');
});

test('readStatusFile rejects non-objects and unreadable files without throwing', () => {
  const dir = makeTempDir('dsh-shell-attach-');
  const statusPath = path.join(dir, 'status.json');
  assert.equal(readStatusFile(statusPath).ok, false);

  fs.writeFileSync(statusPath, '[1,2,3]');
  const arrayResult = readStatusFile(statusPath);
  assert.equal(arrayResult.ok, false);
  assert.match(arrayResult.reason, /object/);

  const throwingFs = {
    readFileSync() {
      throw new Error('EACCES');
    },
  };
  const denied = readStatusFile(statusPath, throwingFs);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'EACCES');
});
