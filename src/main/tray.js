/**
 * tray: optional system tray with Show / Restart Harness / Quit.
 * Electron objects are injected; every failure degrades to "no tray" instead
 * of crashing the app (many Linux shells have no StatusNotifier host).
 */
'use strict';

// Small self-contained 16x16 PNG (a blue status dot) so a tray entry exists
// even when the packaged app has no separate icon asset.
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR42mNgoAVYdeTXf3RMtkYQrlr0HY4p0ozXEGI1YzWAFM1YDSFVM14DiNGM0wBiNWM1gBTNWAOSIs1UMYBYQ4hK0mRrHBAAADzpsPtNxZDvAAAAAElFTkSuQmCC';

function safeCallback(fn, label, logger) {
  return function handleMenuClick(...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`tray ${label} action failed: ${error.message}`);
      }
    }
  };
}

/** Pure menu template shared by the tray and unit tests. */
function buildTrayMenuTemplate({ onShow, onRestart, onHide, onQuit, logger } = {}) {
  const hide = typeof onHide === 'function' ? onHide : onQuit;
  return [
    { label: '显示 DSH', click: safeCallback(onShow, 'show', logger) },
    { label: '重启 Harness', click: safeCallback(onRestart, 'restart', logger) },
    { type: 'separator' },
    { label: '隐藏界面（DSH 后台继续）', click: safeCallback(hide, 'hide', logger) },
  ];
}

/**
 * Create a tray icon, or return null when Electron/tray support is missing.
 *
 * @param {{
 *   Tray?: Function,
 *   Menu?: object,
 *   nativeImage?: object,
 *   icon?: object,
 *   iconPath?: string,
 *   tooltip?: string,
 *   onShow?: Function,
 *   onRestart?: Function,
 *   onHide?: Function,
 *   onQuit?: Function,
 *   logger?: object
 * }} deps
 */
function createTray({
  Tray,
  Menu,
  nativeImage,
  icon,
  iconPath,
  tooltip = 'DSH Electron',
  onShow,
  onRestart,
  onHide,
  onQuit,
  logger,
} = {}) {
  if (typeof Tray !== 'function') {
    if (logger && typeof logger.warn === 'function') logger.warn('tray unavailable: Tray API missing');
    return null;
  }

  let image = icon;
  if (!image && iconPath && nativeImage && typeof nativeImage.createFromPath === 'function') {
    try {
      const candidate = nativeImage.createFromPath(iconPath);
      if (candidate && (!candidate.isEmpty || !candidate.isEmpty())) image = candidate;
    } catch {
      image = undefined;
    }
  }
  if (!image && nativeImage && typeof nativeImage.createFromDataURL === 'function') {
    try {
      const candidate = nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL);
      if (candidate && (!candidate.isEmpty || !candidate.isEmpty())) image = candidate;
    } catch {
      image = undefined;
    }
  }
  if (!image && nativeImage && typeof nativeImage.createEmpty === 'function') {
    try {
      image = nativeImage.createEmpty();
    } catch {
      image = undefined;
    }
  }

  try {
    const tray = new Tray(image);
    if (tray && typeof tray.setToolTip === 'function') tray.setToolTip(tooltip);
    if (tray && typeof tray.setContextMenu === 'function' && Menu && typeof Menu.buildFromTemplate === 'function') {
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({ onShow, onRestart, onHide, onQuit, logger })));
    }
    return tray;
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`tray unavailable: ${error.message}`);
    }
    return null;
  }
}

module.exports = {
  FALLBACK_ICON_DATA_URL,
  buildTrayMenuTemplate,
  createTray,
};
