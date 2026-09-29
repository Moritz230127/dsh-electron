/**
 * window-manager: BrowserWindow construction and the main-window security
 * policy (navigation allow-list, window.open denial, audio-only media
 * permission). Electron is injected so the policy helpers stay plain-Node
 * testable and main.js is the only place that touches the real Electron API.
 */
'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');

function getUrlOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function redactUrl(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/([?&]token=)[^&#]*/gi, '$1<redacted>');
}

function isPathInside(targetPath, rootDir) {
  if (typeof targetPath !== 'string' || typeof rootDir !== 'string') return false;
  const target = path.resolve(targetPath);
  const root = path.resolve(rootDir);
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

/** True for file:// URLs inside src/renderer (lexical containment). */
function isRendererPageUrl(targetUrl, rendererDir = RENDERER_DIR) {
  let parsed;
  try {
    parsed = new URL(String(targetUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  let filePath;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return false;
  }
  return isPathInside(filePath, rendererDir);
}

/** Allow-list for will-navigate: runtime origin, or a local renderer page. */
function isAllowedNavigation(targetUrl, { runtimeOrigin, rendererDir = RENDERER_DIR } = {}) {
  if (isRendererPageUrl(targetUrl, rendererDir)) return true;
  if (!runtimeOrigin) return false;
  let parsed;
  try {
    parsed = new URL(String(targetUrl));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.origin === runtimeOrigin;
}

/** Clipboard permissions the official Web UI uses for copy/paste buttons. */
const CLIPBOARD_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'clipboard-write',
]);

function isClipboardPermission(permission) {
  return CLIPBOARD_PERMISSIONS.has(permission);
}

/** Pure permission decision for a media request: audio from the runtime only; clipboard from the runtime only. */
function decidePermissionRequest({ permission, mediaTypes, requestingOrigin, runtimeOrigin } = {}) {
  if (!runtimeOrigin || !requestingOrigin) return false;
  if (requestingOrigin !== runtimeOrigin) return false;
  if (isClipboardPermission(permission)) return true;
  if (permission !== 'media') return false;
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  return types.includes('audio') && !types.includes('video') && !types.includes('unknown');
}

/**
 * Permission *check* must be at least as strict as the request handler.
 * setPermissionCheckHandler may deliver `mediaTypes` (array) or a single
 * `mediaType`; allow only an explicit audio signal from the runtime origin.
 * Missing, `unknown`, `video` and mixed audio+video are all denied.
 */
function decidePermissionCheck({ permission, mediaTypes, mediaType, requestingOrigin, runtimeOrigin } = {}) {
  if (!runtimeOrigin || !requestingOrigin) return false;
  if (requestingOrigin !== runtimeOrigin) return false;
  if (isClipboardPermission(permission)) return true;
  if (permission !== 'media') return false;

  const declaredTypes = [];
  if (Array.isArray(mediaTypes)) declaredTypes.push(...mediaTypes);
  if (typeof mediaType === 'string' && mediaType.length > 0) declaredTypes.push(mediaType);
  if (declaredTypes.length === 0) return false;

  const hasAudio = declaredTypes.includes('audio');
  const hasVideo = declaredTypes.includes('video');
  const hasUnknown = declaredTypes.some((type) => type !== 'audio' && type !== 'video');
  return hasAudio && !hasVideo && !hasUnknown;
}

function createExternalOpener({ shell, openExternal, logger } = {}) {
  return function open(url) {
    const fn = typeof openExternal === 'function'
      ? openExternal
      : (shell && typeof shell.openExternal === 'function' ? shell.openExternal.bind(shell) : null);
    if (!fn) {
      if (logger && typeof logger.warn === 'function') logger.warn(`openExternal unavailable for ${redactUrl(url)}`);
      return Promise.resolve(false);
    }
    try {
      const result = fn(url);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          if (logger && typeof logger.warn === 'function') {
            logger.warn(`openExternal failed for ${redactUrl(url)}: ${error.message}`);
          }
        });
      }
      return result;
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`openExternal failed for ${redactUrl(url)}: ${error.message}`);
      }
      return Promise.resolve(false);
    }
  };
}

/** Returns a setWindowOpenHandler for the main window: deny all. */
function makeWindowOpenHandler({ shell, openExternal, logger } = {}) {
  const open = createExternalOpener({ shell, openExternal, logger });
  return function windowOpenHandler({ url } = {}) {
    if (isHttpUrl(url)) open(url);
    return { action: 'deny' };
  };
}

/** The exact sandboxed webPreferences required by ARCHITECTURE.md 3.5. */
function buildWebPreferences(config = {}, preloadPath) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    backgroundThrottling: false,
    devTools: config.showDevTools === true || config.dev === true,
  };
}

/** Create the hidden main window; the caller loads a page and shows it later. */
function createMainWindow({ BrowserWindow, config = {}, preloadPath } = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('createMainWindow requires BrowserWindow');
  }
  return new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'DSH Electron',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: buildWebPreferences(config, preloadPath),
  });
}

function resolveRequestingOrigin(webContents, details) {
  const candidates = [
    details && details.requestingUrl,
    details && details.securityOrigin,
    details && details.embeddingOrigin,
    webContents && typeof webContents.getURL === 'function' ? webContents.getURL() : null,
  ];
  for (const candidate of candidates) {
    const origin = getUrlOrigin(candidate);
    if (origin !== null && origin !== 'null') return origin;
  }
  return null;
}

/**
 * Install the security policy on one window.
 *
 * @param {{
 *   win: object,
 *   session?: object,
 *   shell?: object,
 *   getRuntimeOrigin?: Function|string|null,
 *   rendererDir?: string,
 *   logger?: object,
 *   openExternal?: Function
 * }} deps
 */
function installSecurityPolicy({
  win,
  session,
  shell,
  getRuntimeOrigin,
  rendererDir = RENDERER_DIR,
  logger,
  openExternal,
} = {}) {
  if (!win || !win.webContents) throw new TypeError('installSecurityPolicy requires a window');
  const contents = win.webContents;
  const open = createExternalOpener({ shell, openExternal, logger });
  const currentRuntimeOrigin = () => {
    const value = typeof getRuntimeOrigin === 'function' ? getRuntimeOrigin() : getRuntimeOrigin;
    return getUrlOrigin(value);
  };

  if (typeof contents.on === 'function') {
    contents.on('will-navigate', (event, url) => {
      if (isAllowedNavigation(url, { runtimeOrigin: currentRuntimeOrigin(), rendererDir })) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (isHttpUrl(url)) open(url);
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`blocked main-window navigation: ${redactUrl(url)}`);
      }
    });

    // webviewTag is false, but never let an attached guest slip through.
    contents.on('will-attach-webview', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
  }

  if (typeof contents.setWindowOpenHandler === 'function') {
    contents.setWindowOpenHandler(makeWindowOpenHandler({ shell, openExternal, logger }));
  }

  const ses = session || contents.session;
  if (ses && typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const decision = decidePermissionRequest({
        permission,
        mediaTypes: details && details.mediaTypes,
        requestingOrigin: resolveRequestingOrigin(webContents, details),
        runtimeOrigin: currentRuntimeOrigin(),
      });
      if (typeof callback === 'function') callback(decision);
    });
  }
  if (ses && typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const normalized = resolveRequestingOrigin(webContents, {
        requestingUrl: requestingOrigin,
        ...(details || {}),
      });
      return decidePermissionCheck({
        permission,
        mediaTypes: details && details.mediaTypes,
        mediaType: details && details.mediaType,
        requestingOrigin: normalized,
        runtimeOrigin: currentRuntimeOrigin(),
      });
    });
  }

  return win;
}

function rendererPagePath(name, rendererDir = RENDERER_DIR) {
  return path.join(rendererDir, name);
}

function loadingPagePath(rendererDir = RENDERER_DIR) {
  return rendererPagePath('loading.html', rendererDir);
}

function errorPagePath(rendererDir = RENDERER_DIR) {
  return rendererPagePath('error.html', rendererDir);
}

module.exports = {
  RENDERER_DIR,
  getUrlOrigin,
  isHttpUrl,
  redactUrl,
  isPathInside,
  isRendererPageUrl,
  isAllowedNavigation,
  decidePermissionRequest,
  decidePermissionCheck,
  createExternalOpener,
  makeWindowOpenHandler,
  buildWebPreferences,
  createMainWindow,
  installSecurityPolicy,
  rendererPagePath,
  loadingPagePath,
  errorPagePath,
};
