'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FALLBACK_ICON_DATA_URL, buildTrayMenuTemplate, createTray } = require('../../src/main/tray');

test('buildTrayMenuTemplate exposes Show / Restart Harness / Hide', () => {
  const calls = [];
  const template = buildTrayMenuTemplate({
    onShow: () => calls.push('show'),
    onRestart: () => calls.push('restart'),
    onHide: () => calls.push('hide'),
  });

  assert.deepEqual(
    template.filter((item) => item.type !== 'separator').map((item) => item.label),
    ['显示 DSH', '重启 Harness', '隐藏界面（DSH 后台继续）'],
  );
  assert.equal(template.filter((item) => item.type === 'separator').length, 1);

  for (const item of template) {
    if (typeof item.click === 'function') item.click();
  }
  assert.deepEqual(calls, ['show', 'restart', 'hide']);
});

test('a throwing tray callback is contained and logged', () => {
  const warnings = [];
  const template = buildTrayMenuTemplate({
    onShow: () => {
      throw new Error('boom');
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.doesNotThrow(() => template[0].click());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tray show action failed: boom/);
});

test('createTray wires tooltip and context menu', () => {
  const instances = [];
  class FakeTray {
    constructor(image) {
      this.image = image;
      instances.push(this);
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(value) {
      this.contextMenu = value;
    }
  }
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const nativeImage = { createEmpty: () => ({ empty: true }), isEmpty: () => true };
  const calls = [];

  const tray = createTray({
    Tray: FakeTray,
    Menu,
    nativeImage,
    onShow: () => calls.push('show'),
    onRestart: () => calls.push('restart'),
    onHide: () => calls.push('hide'),
  });

  assert.equal(tray instanceof FakeTray, true);
  assert.equal(instances.length, 1);
  assert.equal(tray.tooltip, 'DSH Electron');
  assert.equal(tray.contextMenu.template.length, 4);
  const hideItem = tray.contextMenu.template.find((item) => item.label === '隐藏界面（DSH 后台继续）');
  hideItem.click();
  assert.deepEqual(calls, ['hide']);
});

test('createTray loads an icon path when provided', () => {
  const loaded = [];
  const nativeImage = {
    createFromPath: (iconPath) => {
      loaded.push(iconPath);
      return { isEmpty: () => false };
    },
    createEmpty: () => ({ empty: true }),
  };
  class FakeTray {
    constructor(image) {
      this.image = image;
    }
  }
  createTray({ Tray: FakeTray, nativeImage, iconPath: '/app/icon.png' });
  assert.deepEqual(loaded, ['/app/icon.png']);
});

test('createTray falls back to the embedded icon data URL', () => {
  const seen = [];
  const nativeImage = {
    createFromDataURL: (url) => {
      seen.push(url);
      return { isEmpty: () => false };
    },
    createEmpty: () => ({ empty: true }),
  };
  class FakeTray {
    constructor(image) {
      this.image = image;
    }
  }
  assert.equal(FALLBACK_ICON_DATA_URL.startsWith('data:image/png;base64,'), true);
  createTray({ Tray: FakeTray, nativeImage });
  assert.deepEqual(seen, [FALLBACK_ICON_DATA_URL]);
});

test('createTray returns null when Tray is unavailable or throws', () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  assert.equal(createTray({ logger }), null);
  assert.equal(warnings.length, 1);

  class ThrowingTray {
    constructor() {
      throw new Error('no StatusNotifier host');
    }
  }
  assert.equal(createTray({ Tray: ThrowingTray, logger }), null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /no StatusNotifier host/);
});
