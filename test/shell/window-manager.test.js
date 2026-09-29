'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wm = require('../../src/main/window-manager');

const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer');
const RUNTIME_ORIGIN = 'http://127.0.0.1:4567';

function makeWebContents(overrides = {}) {
  const handlers = new Map();
  return {
    id: 7,
    session: null,
    windowOpenHandler: null,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
    handlers,
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    },
    getURL() {
      return '';
    },
    ...overrides,
  };
}

test('isAllowedNavigation allows only the runtime origin and local renderer files', () => {
  const opts = { runtimeOrigin: RUNTIME_ORIGIN, rendererDir: RENDERER_DIR };

  assert.equal(wm.isAllowedNavigation('http://127.0.0.1:4567/', opts), true);
  assert.equal(wm.isAllowedNavigation('http://127.0.0.1:4567/chat?x=1#frag', opts), true);
  assert.equal(wm.isAllowedNavigation('http://127.0.0.1:9999/', opts), false);
  assert.equal(wm.isAllowedNavigation('https://127.0.0.1:4567/', opts), false);
  assert.equal(wm.isAllowedNavigation('http://127.0.0.1:4567.evil.example/', opts), false);
  assert.equal(wm.isAllowedNavigation('javascript:alert(1)', opts), false);
  assert.equal(wm.isAllowedNavigation('not a url', opts), false);
  assert.equal(wm.isAllowedNavigation('http://127.0.0.1:4567/', { rendererDir: RENDERER_DIR }), false);

  const loadingUrl = pathToFileURL(path.join(RENDERER_DIR, 'loading.html')).href;
  const errorUrl = pathToFileURL(path.join(RENDERER_DIR, 'error.html')).href;
  assert.equal(wm.isAllowedNavigation(loadingUrl, opts), true);
  assert.equal(wm.isAllowedNavigation(errorUrl, opts), true);
  assert.equal(wm.isAllowedNavigation(pathToFileURL(path.join(RENDERER_DIR, '..', 'main', 'main.js')).href, opts), false);
  assert.equal(wm.isAllowedNavigation(pathToFileURL(path.join(RENDERER_DIR, '..', 'renderer', 'loading.html')).href, opts), true);
  assert.equal(wm.isAllowedNavigation('file:///tmp/evil.html', opts), false);

  // Percent-encoded traversal must be normalized and rejected too.
  const encodedTraversal = `${pathToFileURL(RENDERER_DIR).href}/%2e%2e/main/main.js`;
  assert.equal(wm.isAllowedNavigation(encodedTraversal, opts), false);
  assert.equal(wm.isRendererPageUrl(encodedTraversal, RENDERER_DIR), false);
});

test('isRendererPageUrl rejects traversal and non-file URLs', () => {
  const inside = pathToFileURL(path.join(RENDERER_DIR, 'error.html')).href;
  const traversal = pathToFileURL(path.join(RENDERER_DIR, '..', 'main', 'config.js')).href;
  assert.equal(wm.isRendererPageUrl(inside, RENDERER_DIR), true);
  assert.equal(wm.isRendererPageUrl(traversal, RENDERER_DIR), false);
  assert.equal(wm.isRendererPageUrl('http://127.0.0.1:1/error.html', RENDERER_DIR), false);
  assert.equal(wm.isRendererPageUrl('file://host/error.html', RENDERER_DIR), false);
  assert.equal(wm.isRendererPageUrl(null, RENDERER_DIR), false);
});

test('makeWindowOpenHandler denies every popup and opens only http(s) externally', () => {
  const opened = [];
  const handler = wm.makeWindowOpenHandler({
    openExternal: (url) => opened.push(url),
    logger: { warn() {} },
  });

  assert.deepEqual(handler({ url: 'https://example.com/path' }), { action: 'deny' });
  assert.deepEqual(handler({ url: 'http://example.com/' }), { action: 'deny' });
  assert.deepEqual(handler({ url: pathToFileURL(path.join(RENDERER_DIR, 'error.html')).href }), { action: 'deny' });
  assert.deepEqual(handler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(handler({}), { action: 'deny' });

  assert.deepEqual(opened, ['https://example.com/path', 'http://example.com/']);
});

test('makeWindowOpenHandler survives a throwing openExternal', () => {
  const warnings = [];
  const handler = wm.makeWindowOpenHandler({
    openExternal: () => {
      throw new Error('no browser');
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(handler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(warnings.length, 1);
});

test('decidePermissionRequest allows audio media from the runtime origin only', () => {
  const base = { permission: 'media', requestingOrigin: RUNTIME_ORIGIN, runtimeOrigin: RUNTIME_ORIGIN };
  assert.equal(wm.decidePermissionRequest({ ...base, mediaTypes: ['audio'] }), true);
  assert.equal(wm.decidePermissionRequest({ ...base, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, mediaTypes: ['audio', 'unknown'] }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, mediaTypes: ['video'] }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, mediaTypes: [] }), false);
  assert.equal(wm.decidePermissionRequest({ ...base }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, permission: 'notifications', mediaTypes: ['audio'] }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, requestingOrigin: 'http://127.0.0.1:9999' }), false);
  assert.equal(wm.decidePermissionRequest({ ...base, runtimeOrigin: null }), false);
});

test('decidePermissionCheck allows only explicit audio media from the runtime origin', () => {
  const base = { permission: 'media', requestingOrigin: RUNTIME_ORIGIN, runtimeOrigin: RUNTIME_ORIGIN };
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'] }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'audio' }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'], mediaType: 'audio' }), true);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'], mediaType: 'video' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio'], mediaType: 'unknown' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['video'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'video' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: ['audio', 'unknown'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaType: 'unknown' }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: [] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, mediaTypes: [] , mediaType: undefined }), false);
  assert.equal(wm.decidePermissionCheck({ ...base }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, permission: 'notifications', mediaTypes: ['audio'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, requestingOrigin: 'http://127.0.0.1:9999', mediaTypes: ['audio'] }), false);
  assert.equal(wm.decidePermissionCheck({ ...base, runtimeOrigin: null, mediaType: 'audio' }), false);
});

test('clipboard permissions are allowed only from the runtime origin', () => {
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write']) {
    assert.equal(
      wm.decidePermissionRequest({ permission, requestingOrigin: RUNTIME_ORIGIN, runtimeOrigin: RUNTIME_ORIGIN }),
      true,
    );
    assert.equal(
      wm.decidePermissionCheck({ permission, requestingOrigin: RUNTIME_ORIGIN, runtimeOrigin: RUNTIME_ORIGIN }),
      true,
    );
    assert.equal(
      wm.decidePermissionRequest({ permission, requestingOrigin: 'http://127.0.0.1:9999', runtimeOrigin: RUNTIME_ORIGIN }),
      false,
    );
    assert.equal(
      wm.decidePermissionCheck({ permission, requestingOrigin: 'http://127.0.0.1:9999', runtimeOrigin: RUNTIME_ORIGIN }),
      false,
    );
  }
});

test('buildWebPreferences matches the sandbox policy exactly', () => {
  const prefs = wm.buildWebPreferences({ showDevTools: false }, '/app/preload.js');
  assert.deepEqual(prefs, {
    preload: '/app/preload.js',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: false,
    devTools: false,
  });
  assert.equal(wm.buildWebPreferences({ showDevTools: true }, '/p').devTools, true);
  assert.equal(wm.buildWebPreferences({ dev: true }, '/p').devTools, true);
});

test('createMainWindow builds a hidden window with the security prefs', () => {
  let captured = null;
  class FakeBrowserWindow {
    constructor(options) {
      captured = options;
      this.webContents = makeWebContents();
    }
  }

  const win = wm.createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    config: { showDevTools: true },
    preloadPath: '/app/preload.js',
  });

  assert.equal(win instanceof FakeBrowserWindow, true);
  assert.equal(captured.show, false);
  assert.equal(captured.webPreferences.preload, '/app/preload.js');
  assert.equal(captured.webPreferences.contextIsolation, true);
  assert.equal(captured.webPreferences.nodeIntegration, false);
  assert.equal(captured.webPreferences.sandbox, true);
  assert.equal(captured.webPreferences.webSecurity, true);
  assert.equal(captured.webPreferences.webviewTag, false);
  assert.equal(captured.webPreferences.backgroundThrottling, false);
  assert.equal(captured.webPreferences.devTools, true);

  assert.throws(() => wm.createMainWindow({ config: {} }), TypeError);
});

test('installSecurityPolicy blocks hostile navigation and opens http(s) externally', () => {
  const opened = [];
  const webContents = makeWebContents({
    session: {},
    getURL: () => RUNTIME_ORIGIN + '/',
  });
  const win = { webContents };

  wm.installSecurityPolicy({
    win,
    session: {},
    shell: { openExternal: (url) => opened.push(url) },
    getRuntimeOrigin: () => RUNTIME_ORIGIN,
    rendererDir: RENDERER_DIR,
    logger: { warn() {}, debug() {} },
  });

  const allowedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  webContents.emit('will-navigate', allowedEvent, `${RUNTIME_ORIGIN}/chat`);
  assert.equal(allowedEvent.prevented, false);

  const blockedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  webContents.emit('will-navigate', blockedEvent, 'https://evil.example/');
  assert.equal(blockedEvent.prevented, true);
  assert.deepEqual(opened, ['https://evil.example/']);

  const fileEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  webContents.emit('will-navigate', fileEvent, 'file:///tmp/evil.html');
  assert.equal(fileEvent.prevented, true);
  assert.deepEqual(opened, ['https://evil.example/']);

  const webviewEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  webContents.emit('will-attach-webview', webviewEvent);
  assert.equal(webviewEvent.prevented, true);

  assert.deepEqual(webContents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://evil.example/', 'https://example.com/']);
});

test('installSecurityPolicy wires media/clipboard permission handlers', () => {
  let requestHandler = null;
  let checkHandler = null;
  const fakeSession = {
    setPermissionRequestHandler(fn) { requestHandler = fn; },
    setPermissionCheckHandler(fn) { checkHandler = fn; },
  };
  const webContents = makeWebContents({ session: fakeSession, getURL: () => RUNTIME_ORIGIN + '/' });
  const win = { webContents };

  wm.installSecurityPolicy({
    win,
    session: fakeSession,
    shell: { openExternal() {} },
    getRuntimeOrigin: () => RUNTIME_ORIGIN,
    rendererDir: RENDERER_DIR,
    logger: { warn() {} },
  });

  const request = (permission, details, requestingUrl) => {
    let decision = null;
    requestHandler(
      { getURL: () => requestingUrl || RUNTIME_ORIGIN + '/' },
      permission,
      (value) => { decision = value; },
      details || {},
    );
    return decision;
  };

  assert.equal(request('media', { requestingUrl: RUNTIME_ORIGIN + '/', mediaTypes: ['audio'] }), true);
  assert.equal(request('media', { requestingUrl: RUNTIME_ORIGIN + '/', mediaTypes: ['audio', 'video'] }), false);
  assert.equal(request('media', { requestingUrl: 'http://127.0.0.1:9999/', mediaTypes: ['audio'] }), false);
  assert.equal(request('notifications', { requestingUrl: RUNTIME_ORIGIN + '/' }), false);
  assert.equal(request('media', {}, 'http://127.0.0.1:9999/'), false);
  assert.equal(request('clipboard-sanitized-write', { requestingUrl: RUNTIME_ORIGIN + '/' }), true);
  assert.equal(request('clipboard-read', { requestingUrl: RUNTIME_ORIGIN + '/' }), true);
  assert.equal(request('clipboard-read', { requestingUrl: 'http://127.0.0.1:9999/' }), false);

  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaTypes: ['audio'] }), true);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaTypes: ['video'] }), false);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaType: 'audio' }), true);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaType: 'video' }), false);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', { mediaType: 'unknown' }), false);
  assert.equal(checkHandler({}, 'media', RUNTIME_ORIGIN + '/', {}), false);
  assert.equal(checkHandler({}, 'media', 'http://127.0.0.1:9999/', {}), false);
  assert.equal(checkHandler({}, 'geolocation', RUNTIME_ORIGIN + '/', {}), false);
  assert.equal(checkHandler({}, 'clipboard-read', RUNTIME_ORIGIN + '/', {}), true);
  assert.equal(checkHandler({}, 'clipboard-sanitized-write', RUNTIME_ORIGIN + '/', {}), true);
  assert.equal(checkHandler({}, 'clipboard-read', 'http://127.0.0.1:9999/', {}), false);
});

test('page path helpers point at local renderer files', () => {
  assert.equal(wm.loadingPagePath(), path.join(wm.RENDERER_DIR, 'loading.html'));
  assert.equal(wm.errorPagePath(), path.join(wm.RENDERER_DIR, 'error.html'));
  assert.equal(wm.rendererPagePath('loading.html', RENDERER_DIR), path.join(RENDERER_DIR, 'loading.html'));
  assert.equal(wm.isHttpUrl('https://example.com'), true);
  assert.equal(wm.isHttpUrl('file:///tmp/a.html'), false);
  assert.equal(wm.redactUrl('http://127.0.0.1:1/?token=secret&x=1'), 'http://127.0.0.1:1/?token=<redacted>&x=1');
});
