'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');

const { HostSupervisor, readUrlFile } = require('../../src/host/supervisor.js');

const FAKE_UI_SCRIPT = path.join(__dirname, 'fixtures', 'fake-ui.js');

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createFakeRuntimeRoot(base) {
  const root = path.join(base, 'runtime');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0-e2e' }),
  );
  const entry = path.join(root, 'lib', 'bin.js');
  fs.writeFileSync(
    entry,
    [
      "'use strict';",
      "const http = require('node:http');",
      'const server = http.createServer((request, response) => {',
      "  response.statusCode = 200;",
      "  response.end('ok');",
      '});',
      "server.listen(0, '127.0.0.1', () => {",
      '  const address = server.address();',
      '  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}/?token=e2e-token\\n`);',
      '});',
      "process.on('SIGTERM', () => { server.close(); process.exit(0); });",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  return { root, entry };
}

test('supervisor drives a real fake DSH process + fake UI through UI crash and DSH restart', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-e2e-'));
  const { entry } = createFakeRuntimeRoot(base);
  const marker = path.join(base, 'ui-marker.json');
  const stateDir = path.join(base, 'state');
  const runtimeDir = path.join(base, 'run');

  const dshSpawns = [];
  const uiSpawns = [];
  const spawn = (command, args, options) => {
    const child = realSpawn(command, args, options);
    const record = { command, args, options, child };
    if (options && options.env && options.env.DSH_ELECTRON_ATTACH_URL_FILE) {
      uiSpawns.push(record);
    } else if (Array.isArray(args) && args.includes('web')) {
      dshSpawns.push(record);
    }
    return child;
  };

  const supervisor = new HostSupervisor(
    {
      dshCommand: entry,
      dshHome: path.join(base, 'home'),
      stateDir,
      runtimeDir,
      electronExecutable: process.execPath,
      electronArgs: [FAKE_UI_SCRIPT],
      snapshotEnabled: false,
      readyTimeoutMs: 8000,
      healthIntervalMs: 60000,
      stableSecondsForPromotion: 999,
      restartWindowMs: 60000,
      maxChildRestarts: 3,
    },
    {
      spawn,
      env: {
        ...process.env,
        DSH_HOST_TEST_UI_MARKER: marker,
        DSH_HOST_DEV_APP: '0',
        WAYLAND_DISPLAY: '',
        DISPLAY: '',
      },
    },
  );

  try {
    await supervisor.start();

    assert.equal(dshSpawns.length, 1, 'one DSH child is spawned');
    assert.equal(uiSpawns.length, 1, 'one UI child is spawned');
    const firstUrl = readUrlFile(supervisor.paths.urlFile);
    assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=e2e-token$/);

    await waitFor(() => fs.existsSync(marker));
    const firstMarker = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(firstMarker.attachUrlFile, supervisor.paths.urlFile);
    assert.equal(firstMarker.userData, path.join(stateDir, 'ui-profile'));
    assert.equal(firstMarker.pid, uiSpawns[0].child.pid);
    assert.ok(
      firstMarker.display !== null || firstMarker.waylandDisplay !== null,
      'a discovered WAYLAND_DISPLAY or DISPLAY fallback is passed to the UI',
    );
    assert.equal(typeof uiSpawns[0].options.env.DSH_ELECTRON_ATTACH_URL_FILE, 'string');

    // UI crash: DSH must stay alive and the UI must be restarted.
    uiSpawns[0].child.kill('SIGKILL');
    await waitFor(() => uiSpawns.length === 2, 8000);
    assert.equal(dshSpawns.length, 1, 'UI crash did not restart DSH');
    assert.equal(dshSpawns[0].child.exitCode, null);
    assert.equal(dshSpawns[0].child.signalCode, null);
    assert.equal(readUrlFile(supervisor.paths.urlFile), firstUrl, 'URL file survives the UI crash');

    const markerDeadline = Date.now() + 5000;
    while (JSON.parse(fs.readFileSync(marker, 'utf8')).pid === firstMarker.pid) {
      if (Date.now() > markerDeadline) throw new Error('restarted UI did not update the marker');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const secondMarker = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(secondMarker.pid, uiSpawns[1].child.pid);

    // DSH crash: supervisor restarts DSH, UI is left running.
    dshSpawns[0].child.kill('SIGKILL');
    await waitFor(() => dshSpawns.length === 2 && readUrlFile(supervisor.paths.urlFile) !== null, 8000);
    assert.equal(uiSpawns.length, 2, 'DSH restart did not restart or kill the UI');
    assert.equal(uiSpawns[1].child.exitCode, null);
    assert.equal(uiSpawns[1].child.signalCode, null);
    assert.equal(dshSpawns[1].child.exitCode, null);

    const restartedUrl = readUrlFile(supervisor.paths.urlFile);
    assert.match(restartedUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=e2e-token$/);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).pid, uiSpawns[1].child.pid);

    // Shutdown: URL removed, both children gone, no respawn.
    await supervisor.stop('integration-test');
    assert.equal(readUrlFile(supervisor.paths.urlFile), null);
    await waitFor(
      () =>
        (uiSpawns[1].child.exitCode !== null || uiSpawns[1].child.signalCode !== null) &&
        (dshSpawns[1].child.exitCode !== null || dshSpawns[1].child.signalCode !== null),
      8000,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(dshSpawns.length, 2, 'no DSH respawn after shutdown');
    assert.equal(uiSpawns.length, 2, 'no UI respawn after shutdown');
  } finally {
    await supervisor.stop('integration-cleanup').catch(() => {});
    for (const record of dshSpawns.concat(uiSpawns)) {
      try {
        if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
      } catch {
        // Best-effort cleanup.
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
