/**
 * fake-ui: attach-mode UI double used by the host integration test.
 * Writes a marker (pid + attach env) and stays alive until SIGTERM.
 */
'use strict';

const fs = require('node:fs');

const markerPath = process.env.DSH_HOST_TEST_UI_MARKER;
if (typeof markerPath === 'string' && markerPath.length > 0) {
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      pid: process.pid,
      attachUrlFile: process.env.DSH_ELECTRON_ATTACH_URL_FILE || null,
      userData: process.env.DSH_ELECTRON_USER_DATA || null,
      waylandDisplay: process.env.WAYLAND_DISPLAY || null,
      display: process.env.DISPLAY || null,
    }),
  );
}

process.on('SIGTERM', () => {
  process.exit(0);
});

setInterval(() => {}, 1000);
