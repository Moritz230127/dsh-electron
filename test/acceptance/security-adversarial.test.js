/**
 * Independent adversarial security review tests for ARCHITECTURE.md §3.5.
 *
 * Strategy: drive the *exported* policy helpers and a fake window/session with
 * hostile inputs, then statically assert the wiring in src/main/main.js and
 * src/main/window-manager.js. Any invariant that is not fully enforced is
 * called out in REPORT.md; the "KNOWN BOUNDARY" test documents the coarse
 * permission-check handler rather than hiding it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wm = require('../../src/main/window-manager');
const main = require('../../src/main/main');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(PROJECT_ROOT, 'src', 'renderer');
const MAIN_SRC = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'main.js'), 'utf8');
const WM_SRC = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'window-manager.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:4567';

function makeWebContents({ currentUrl = ORIGIN + '/', session = null } = {}) {
  const handlers = new Map();
  return {
    id: 42,
    session,
    handlers,
    windowOpenHandler: null,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, ...args) {
      let result;
      for (const handler of handlers.get(event) || []) result = handler(...args);
      return result;
    },
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    },
    getURL() {
      return typeof currentUrl === 'function' ? currentUrl() : currentUrl;
    },
  };
}

function makeSession() {
  return {
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler(handler) {
      this.requestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.checkHandler = handler;
    },
  };
}

test('§3.5: buildWebPreferences pins every sandboxing switch', () => {
  const prefs = wm.buildWebPreferences({ showDevTools: false, dev: false }, '/tmp/preload.js');
  assert.deepEqual(Object.keys(prefs).sort(), [
    'backgroundThrottling',
    'contextIsolation',
    'devTools',
    'nodeIntegration',
    'preload',
    'sandbox',
    'webSecurity',
    'webviewTag',
  ]);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.backgroundThrottling, false);
  assert.equal(prefs.preload, '/tmp/preload.js');

  // createMainWindow must actually pass these prefs to BrowserWindow.
  let captured;
  class FakeBrowserWindow {
    constructor(options) {
      captured = options;
      this.webContents = makeWebContents({ session: makeSession() });
    }
  }
  wm.createMainWindow({ BrowserWindow: FakeBrowserWindow, config: {}, preloadPath: '/p.js' });
  assert.deepEqual(captured.webPreferences, wm.buildWebPreferences({}, '/p.js'));
  assert.equal(captured.show, false);
});

test('§3.5: will-navigate blocks every hostile URL and only opens http(s) externally', () => {
  const session = makeSession();
  const contents = makeWebContents({ session });
  const opened = [];
  wm.installSecurityPolicy({
    win: { webContents: contents },
    session,
    getRuntimeOrigin: () => ORIGIN,
    rendererDir: RENDERER_DIR,
    openExternal: (url) => opened.push(url),
    logger: { warn() {} },
  });

  const navigate = (url) => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    contents.emit('will-navigate', event, url);
    return event;
  };

  // Allowed: exact runtime origin (path/query/fragment all fine).
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/chat?x=1#frag`]) {
    const event = navigate(url);
    assert.equal(event.prevented, false, `should allow ${url}`);
  }
  // Allowed: local renderer pages.
  for (const file of ['loading.html', 'error.html']) {
    const event = navigate(pathToFileURL(path.join(RENDERER_DIR, file)).href);
    assert.equal(event.prevented, false, `should allow renderer ${file}`);
  }

  // Blocked without external open (non-http(s)).
  const blockedNoOpen = [
    'file:///etc/passwd',
    pathToFileURL(path.join(RENDERER_DIR, '..', 'main', 'main.js')).href,
    `${pathToFileURL(RENDERER_DIR).href}/%2e%2e/main/main.js`,
    'file://host/etc/passwd',
    'javascript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'not a url',
    '',
    null,
  ];
  for (const url of blockedNoOpen) {
    const event = navigate(url);
    assert.equal(event.prevented, true, `should block ${JSON.stringify(url)}`);
  }

  // Blocked http(s) is opened in the OS browser instead, even loopback look-alikes
  // on another origin (the runtime origin itself never reaches this branch).
  const external = [
    'https://127.0.0.1:4567/',
    'http://127.0.0.1:9999/',
    'http://127.0.0.1:4567@evil.example/',
    'http://evil.example/',
    'https://example.com/',
    'http://example.com/path',
  ];
  for (const url of external) {
    const event = navigate(url);
    assert.equal(event.prevented, true);
  }
  assert.deepEqual(opened, external);

  // webviewTag is false, but an attach attempt must still be prevented.
  const attach = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-attach-webview', attach);
  assert.equal(attach.prevented, true);
});

test('§3.5: window.open is denied wholesale; only http(s) reaches the shell', () => {
  const opened = [];
  const handler = wm.makeWindowOpenHandler({ openExternal: (url) => opened.push(url) });
  assert.deepEqual(handler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(handler({ url: 'http://example.com/' }), { action: 'deny' });
  assert.deepEqual(handler({ url: pathToFileURL(path.join(RENDERER_DIR, 'error.html')).href }), { action: 'deny' });
  assert.deepEqual(handler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(handler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(handler({}), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/', 'http://example.com/']);

  // installSecurityPolicy must wire the handler on the real webContents.
  const contents = makeWebContents({ session: makeSession() });
  wm.installSecurityPolicy({
    win: { webContents: contents },
    getRuntimeOrigin: () => ORIGIN,
    rendererDir: RENDERER_DIR,
    openExternal: () => {},
  });
  assert.equal(typeof contents.windowOpenHandler, 'function');
  assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
});

test('§3.5: permission request handler allows audio only, runtime origin only', () => {
  const session = makeSession();
  const contents = makeWebContents({ session });
  wm.installSecurityPolicy({
    win: { webContents: contents },
    session,
    getRuntimeOrigin: () => ORIGIN,
    rendererDir: RENDERER_DIR,
    openExternal: () => {},
  });
  assert.equal(typeof session.requestHandler, 'function');

  const decide = (details, perm = 'media') => {
    let value = null;
    session.requestHandler(contents, perm, (allowed) => { value = allowed; }, details);
    return value;
  };

  assert.equal(decide({ mediaTypes: ['audio'], requestingUrl: `${ORIGIN}/page` }), true);
  assert.equal(decide({ mediaTypes: ['audio', 'video'], requestingUrl: `${ORIGIN}/page` }), false);
  assert.equal(decide({ mediaTypes: ['audio', 'unknown'], requestingUrl: `${ORIGIN}/page` }), false, 'unknown media type is denied');
  assert.equal(decide({ mediaTypes: ['video'], requestingUrl: `${ORIGIN}/page` }), false);
  assert.equal(decide({ mediaTypes: [], requestingUrl: `${ORIGIN}/page` }), false);
  assert.equal(decide({ requestingUrl: `${ORIGIN}/page` }), false);
  assert.equal(decide({ mediaTypes: ['audio'], requestingUrl: 'http://127.0.0.1:9999/page' }), false);
  assert.equal(decide({ mediaTypes: ['audio'], requestingUrl: 'https://evil.example/' }), false);
  assert.equal(decide({ mediaTypes: ['audio'] }, 'geolocation'), false);
  // Without requestingUrl, the sender URL is used; a hostile current page is denied.
  contents.getURL = () => 'https://evil.example/';
  assert.equal(decide({ mediaTypes: ['audio'] }), false);

  // Pure decision helper boundary: mediaTypes must be an array containing audio.
  assert.equal(wm.decidePermissionRequest({ permission: 'media', mediaTypes: 'audio', requestingOrigin: ORIGIN, runtimeOrigin: ORIGIN }), false);
  assert.equal(wm.decidePermissionRequest({}), false);
});

test('§3.5: permission-check handler is strict: explicit audio from runtime origin only', () => {
  // T8 made the check handler at least as strict as the request handler:
  // unknown / absent / video / mixed are all denied for media.
  const base = { permission: 'media', requestingOrigin: ORIGIN, runtimeOrigin: ORIGIN };
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'audio' }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'] }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'], mediaType: undefined }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'video' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['video'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio', 'unknown'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'unknown' }), false, 'unknown must be denied');
  assert.equal(wm.decidePermissionCheck({ ...base }), false, 'absent media info must be denied');
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: [] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: '' }), false);
  assert.equal(wm.decidePermissionCheck({ permission: 'notifications', mediaType: 'audio', requestingOrigin: ORIGIN, runtimeOrigin: ORIGIN }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'audio', requestingOrigin: 'http://127.0.0.1:9999' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'audio', runtimeOrigin: null }), false);
  assert.equal(wm.decidePermissionCheck({}), false);

  // The installed check handler must use the same strict decision.
  const session = makeSession();
  const contents = makeWebContents({ session });
  wm.installSecurityPolicy({
    win: { webContents: contents },
    session,
    getRuntimeOrigin: () => ORIGIN,
    rendererDir: RENDERER_DIR,
    openExternal: () => {},
  });
  assert.equal(typeof session.checkHandler, 'function');
  const decideCheck = (details) => session.checkHandler(contents, 'media', `${ORIGIN}/page`, details);
  assert.equal(decideCheck({ mediaType: 'audio' }), true);
  assert.equal(decideCheck({ mediaTypes: ['audio'] }), true);
  assert.equal(decideCheck({ mediaType: 'unknown' }), false);
  assert.equal(decideCheck({}), false);
  assert.equal(decideCheck({ mediaTypes: ['audio', 'video'] }), false);
  assert.equal(decideCheck({ mediaType: 'audio' }), true);
  // A non-runtime requester is denied even for audio.
  assert.equal(session.checkHandler(contents, 'media', 'http://127.0.0.1:9999/page', { mediaType: 'audio' }), false);
  assert.equal(session.checkHandler(contents, 'notifications', `${ORIGIN}/page`, { mediaType: 'audio' }), false);
});

test('§3.4/§3.5: DSH_ELECTRON_SMOKE is a post-load snapshot hook, not a navigation bypass', () => {
  const smokeFn = MAIN_SRC.slice(
    MAIN_SRC.indexOf('function captureSmokeSnapshot'),
    MAIN_SRC.indexOf('function handleRendererLoss'),
  );
  const didFinish = MAIN_SRC.slice(
    MAIN_SRC.indexOf('function handleDidFinishLoad'),
    MAIN_SRC.indexOf('function handleDidFailLoad'),
  );

  // Defined once and called exactly once, from the successful harness load path.
  assert.equal((MAIN_SRC.match(/maybeRunSmokeHook\(/g) || []).length, 2);
  assert.match(MAIN_SRC, /function maybeRunSmokeHook\(win\)/);
  assert.match(didFinish, /if \(!state\.pendingHarnessLoad\)[\s\S]*?return;/);
  const smokeCallAt = didFinish.indexOf('maybeRunSmokeHook(win)');
  assert.ok(smokeCallAt > didFinish.indexOf('state.harnessRendered = true'));

  // The hook only observes/writes/quits: no navigation, no security-policy changes.
  assert.doesNotMatch(smokeFn, /loadURL|loadFile|will-navigate|setWindowOpenHandler|installSecurityPolicy/);
  assert.doesNotMatch(smokeFn, /runtimeOrigin\s*=|state\.currentHarnessUrl\s*=/);
  assert.match(smokeFn, /function captureSmokeSnapshot\(win\)/);
  assert.match(smokeFn, /executeJavaScript\(SMOKE_SNAPSHOT_SCRIPT, true\)/);
  assert.match(smokeFn, /function maybeRunSmokeHook\(win\)/);
  assert.match(smokeFn, /captureSmokeSnapshot\(win\)/);
  assert.match(smokeFn, /path\.resolve\(smokePath\)/);
  assert.match(smokeFn, /fs\.writeFileSync/);
  assert.match(smokeFn, /app\.quit\(\)/);

  // Smoke snapshot values cannot fake a pass: readyState+bodyText are re-checked.
  const snapshot = main.normalizeSmokeSnapshot(
    { ok: true, readyState: 'loading', bodyTextLength: 0, title: 'spoofed' },
    ORIGIN,
  );
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.appRootFound, false);

  // Navigation policy is env-independent: window-manager never reads process.env.
  assert.doesNotMatch(WM_SRC, /process\.env|DSH_ELECTRON/);
});

test('§3.5: main.js wires the policy on the only BrowserWindow and sets userData first', () => {
  // Exactly one BrowserWindow construction site, in window-manager.
  assert.equal((MAIN_SRC.match(/new BrowserWindow/g) || []).length, 0);
  assert.equal((WM_SRC.match(/new BrowserWindow/g) || []).length, 1);
  assert.equal((MAIN_SRC.match(/installSecurityPolicy\(/g) || []).length, 1); // one call site
  assert.match(MAIN_SRC, /createMainWindow\(\{ BrowserWindow, config, preloadPath \}\)/);
  assert.match(MAIN_SRC, /installSecurityPolicy\(\{/);

  // No dangerous switch anywhere in src/main.
  for (const src of [MAIN_SRC, WM_SRC]) {
    assert.doesNotMatch(src, /nodeIntegration\s*:\s*true/);
    assert.doesNotMatch(src, /enableRemoteModule\s*:\s*true/);
    assert.doesNotMatch(src, /webviewTag\s*:\s*true/);
    assert.doesNotMatch(src, /allowRunningInsecureContent\s*:\s*true/);
    assert.doesNotMatch(src, /webSecurity\s*:\s*false/);
    assert.doesNotMatch(src, /sandbox\s*:\s*false/);
  }

  // userData override is applied before the single-instance lock and config read.
  const setPathAt = MAIN_SRC.indexOf("app.setPath('userData'");
  const lockAt = MAIN_SRC.indexOf('app.requestSingleInstanceLock()');
  const getPathAt = MAIN_SRC.indexOf("app.getPath('userData')");
  assert.ok(setPathAt > 0 && setPathAt < lockAt && lockAt < getPathAt);

  // Loopback gate before any harness URL is loaded.
  assert.match(MAIN_SRC, /if \(!isLoopbackUrl\(url\)\)/);
  assert.match(MAIN_SRC, /if \(!url \|\| !isLoopbackUrl\(url\)\)/);

  // IPC retry/quit must re-validate the sender as a local renderer page.
  assert.match(MAIN_SRC, /isRendererPageUrl\(senderUrl, RENDERER_DIR\)/);
  assert.match(MAIN_SRC, /rejected retry IPC from untrusted sender/);
  assert.match(MAIN_SRC, /rejected quit IPC from untrusted sender/);
});

test('§3.5: local error page cannot be navigated to a remote URL through query params', () => {
  const errorHtml = fs.readFileSync(path.join(RENDERER_DIR, 'error.html'), 'utf8');
  assert.match(errorHtml, /default-src 'none'/);
  assert.match(errorHtml, /connect-src 'none'/);
  assert.doesNotMatch(errorHtml, /window\.location\s*=/);
  assert.doesNotMatch(errorHtml, /location\.href/);
  assert.doesNotMatch(errorHtml, /https?:\/\//);
  assert.match(errorHtml, /window\.dshShell/);
});

test('isLoopbackUrl accepts only real loopback forms', () => {
  const yes = [
    'http://127.0.0.1:4321/?token=x',
    'http://127.0.0.2/',
    'http://127.255.255.254:9/',
    'https://127.0.0.1/',
    'http://localhost:8080/',
    'http://[::1]:8080/',
  ];
  const no = [
    'http://example.com/',
    'http://127.0.0.1.evil.example/',
    'http://127.0.0.1@evil.example/',
    'http://127.0.0.999/',
    'http://10.0.0.1/',
    'file:///tmp/x.html',
    'javascript:alert(1)',
    '//evil.example/',
    '',
    undefined,
    null,
  ];
  for (const url of yes) assert.equal(main.isLoopbackUrl(url), true, `expected loopback: ${url}`);
  for (const url of no) assert.equal(main.isLoopbackUrl(url), false, `expected non-loopback: ${url}`);
});

test('redactUrl never leaves an auth token in logs', () => {
  assert.equal(
    wm.redactUrl('http://127.0.0.1:4567/?token=SECRET&x=1'),
    'http://127.0.0.1:4567/?token=<redacted>&x=1',
  );
  assert.equal(wm.redactUrl('ready at http://127.0.0.1:4567/?token=a-b_c#frag'), 'ready at http://127.0.0.1:4567/?token=<redacted>#frag');
  assert.equal(wm.redactUrl(null), '');
});
