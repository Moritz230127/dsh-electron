# DSH Electron — implementation contract

Status: **binding for all contributors in this repository.**
The Lead owns this file. If an implementation needs to change it, the Lead edits it first.

## 0. Goal and non-goals

Goal: a Linux desktop app that hosts the existing `dsh web` UI in a controlled Electron shell.

In scope for v0.1:

- own the `dsh web` child process (managed mode), using the user's existing `DSH_HOME` (`~/.dsh` by default);
- capture the authenticated URL from the child's stdout;
- health-check, then load the URL into a sandboxed BrowserWindow;
- bounded recovery for renderer / GPU / main-frame load failures;
- persisted GPU fallback ladder (`default` -> `--disable-gpu-sandbox` -> `--disable-gpu --disable-gpu-compositing`);
- a small config file, structured logs, single-instance lock, optional tray / close-to-tray;
- Linux packaging (`dir`, `pacman`, `AppImage`).

Non-goals for v0.1:

- no DSH fork, no frontend patches, no phone bridge, no PPT runtime, no auto-updater;
- no profile migration; the app uses the existing `DSH_HOME`;
- no native menu / native directory picker beyond what Electron/web already provide;
- no `dsh-app://` custom protocol; the BrowserWindow loads the real loopback URL.

## 1. Repository layout and write ownership

| Path | Owner | Notes |
|---|---|---|
| `package.json` | packaging | build config + scripts; Lead may edit dependencies |
| `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `README.md` | Lead | binding contract |
| `src/main/runtime/**` | runtime | no Electron imports; pure Node, unit-testable |
| `src/main/main.js`, `config.js`, `window-manager.js`, `recovery.js`, `gpu-fallback.js`, `tray.js`, `logging.js` | shell | Electron main process |
| `src/preload/**`, `src/renderer/**` | shell | sandboxed preload + local loading/error pages |
| `test/runtime/**` | runtime | unit tests for pure runtime modules |
| `test/shell/**` | shell | unit tests for pure shell modules |
| `test/acceptance/**`, `verification/**` | verifier | E2E + independent review; verifier never edits `src/**` |
| `scripts/**`, `packaging/**` | packaging | build helpers, desktop entry, niri rule, migration docs |
| `docs/BUILD.md`, `docs/MIGRATION.md` | packaging | |

Rule: one writer per file. If you need a change in another owner's file, post the request in the shared task, do not edit it.

## 2. Runtime contract (`src/main/runtime/harness-runtime.js`)

`HarnessRuntime` is a Node `EventEmitter`, no Electron dependency.

```js
const runtime = new HarnessRuntime({
  command: '/home/Arch/.npm-global/bin/dsh', // absolute or PATH name
  args: ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
  cwd: '/home/Arch',
  env: { ...process.env, DSH_HOME: '/home/Arch/.dsh' },
  logger: { info(){}, warn(){}, error(){}, debug(){} },
  spawn,                 // optional injected test seam (child_process.spawn shape)
  stopTimeoutMs: 8000
});
runtime.on('starting', () => {});
runtime.on('ready', ({ url, host, port, token }) => {});
runtime.on('stdout', ({ line }) => {});
runtime.on('stderr', ({ line }) => {});
runtime.on('fatal', ({ error, message, logTail }) => {}); // exited before ready
runtime.on('exit', ({ code, signal, expected, logTail }) => {}); // exited after ready
await runtime.start();
await runtime.stop();
runtime.isRunning();
```

Semantics:

- `start()` resolves once the process has been spawned (not once ready).
- The ready line has this exact shape (allow extra surrounding text):
  `dsh web: http://127.0.0.1:<port>/?token=<token>`
- `parseReadyUrl(line)` returns `{ url, host, port, token }` or `null`; pure, no side effects.
- stdout/stderr are consumed as lines; a bounded tail (last 200 lines) is kept for diagnostics.
- if the child exits while `stop()` was not requested, emit `fatal` when not yet ready, otherwise `exit`; `expected` is `true` only after `stop()` was requested.
- `stop()` sends `SIGTERM`, waits `stopTimeoutMs`, then sends `SIGKILL`; it resolves even if the child is already gone.
- no shell injection: always use `spawn(command, args, { shell: false })`.

`waitForHealth(url, { timeoutMs = 15000, intervalMs = 250, request })`
returns a promise resolved once an HTTP response (any status, including 401/303) is received. Connection errors retry until timeout. `request` is injectable for tests.

## 3. Shell contract (`src/main/**`)

### 3.1 Config (`config.js`)

`loadConfig({ argv, userDataDir, env, homedir })` returns a frozen object:

```js
{
  dshCommand: 'dsh',                 // empty -> resolveDshCommand()
  dshHome: '/home/Arch/.dsh',
  runtimeMode: 'managed',            // 'managed' | 'attach'
  attachUrl: '',                      // managed: ignored; attach: required
  host: '127.0.0.1',
  port: 0,                            // 0 = OS picks a free port
  closeToTray: true,
  showDevTools: false,
  extraSwitches: [],
  gpuFallback: { level: 'default', failures: 0, stableLaunches: 0 }
}
```

- CLI overrides: `--dsh-home=`, `--dsh-command=`, `--port=`, `--attach-url=`, `--dev`, `--no-tray`.
- Environment overrides (for tests/automation): `DSH_ELECTRON_HOME` -> `dshHome`, `DSH_ELECTRON_CONFIG` -> explicit config file, `DSH_ELECTRON_USER_DATA` -> Electron userData root (main must call `app.setPath('userData', ...)` before `app.whenReady` when set).
- Config file: `<userDataDir>/config.json`, atomic write via tmp+rename.
- `resolveDshCommand({ env, homedir })`: empty setting -> first existing of
  `~/.npm-global/bin/dsh`, `/usr/local/bin/dsh`, `/usr/bin/dsh`, else `dsh` (PATH lookup at spawn time).
- Never mutate `~/.dsh`; tests pass temp dirs.

### 3.2 GPU fallback (`gpu-fallback.js`)

Pure functions, unit-tested:

- `defaultGpuFallbackState()`
- `gpuFallbackSwitches(level)`:
  - `default` -> `[]`
  - `sandbox-disabled` -> `['disable-gpu-sandbox']`
  - `gpu-disabled` -> `['disable-gpu-sandbox', 'disable-gpu', 'disable-gpu-compositing']`
- `isGpuLossFatal(reason, exitCode)`: `clean-exit` and `killed` are not fatal; exit code 34 (`GPU_DEVICE_LOST_EXIT_CODE`) is self-recovery, not fatal.
- `planGpuFallbackResponse({ state, harnessRendered })`: never-rendered loss escalates and asks for immediate relaunch; rendered loss escalates after 3 failures without relaunch; top level stops.
- `planStableLaunch(state)`: after 20 stable launches, step one level back up.
- `parseGpuFallbackState(raw)` / `serializeGpuFallbackState(state)`.
- Persist to `<userDataDir>/gpu-fallback.json`.

### 3.3 Recovery (`recovery.js`)

- `shouldReloadAfterMainWindowRendererLoss({ now, lastReloadAt, reloadCount, cooldownMs = 5000, maxReloads = 3 })`.
- Main wires: `render-process-gone`, `child-process-gone` (type `GPU`), `did-fail-load` (main frame, ignore `-3` aborted), `unresponsive`.
- All recovery is bounded and logged; never an unbounded reload loop.

### 3.4 Main flow (`main.js`)

1. `app.requestSingleInstanceLock()`; second instance shows/focuses the window.
2. Load config; read GPU fallback state; `app.commandLine.appendSwitch` for the active level; `app.disableHardwareAcceleration()` when level is `gpu-disabled` (before `app.whenReady()`).
3. Create a hidden window with `src/renderer/loading.html`.
4. Start runtime (managed) or load `attachUrl` (attach).
5. On `ready`: `waitForHealth(url)` -> `window.loadURL(url)`.
6. On first successful `did-finish-load`: show/focus window, schedule the 60 s stable-launch check.
7. On `fatal` / unexpected `exit`: bounded restart; after repeated failures show `src/renderer/error.html` with a short diagnostic + retry action (retry can be an in-app button handled by `ipcMain`, or a tray item).
8. `before-quit`: stop runtime, flush logs.
9. Window close: hide to tray when `closeToTray`, otherwise quit. Tray menu: Show, Restart Harness, Quit.
10. Environment hook: if `DSH_ELECTRON_SMOKE` is set to a file path, after `did-finish-load` write a JSON snapshot `{ok, title, url, readyState, bodyTextLength, appRootFound}` and quit after 1 s. `appRootFound` is true when the loaded document contains a stable DSH shell marker (for example `[data-slot]`, `#root`, or a non-empty body text). This is the automated acceptance hook and must not depend on the user's live `~/.dsh`; tests pass a fresh temporary `DSH_HOME`, which `dsh web` initialises as the default web profile.

### 3.5 Window security (`window-manager.js`)

BrowserWindow options:

```js
webPreferences: {
  preload: <src/preload/preload.js>,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  backgroundThrottling: false,
  devTools: <config.showDevTools || config.dev>
}
```

Invariants:

- `will-navigate`: allow only the runtime origin and `file://` pages inside `src/renderer/`; everything else is prevented and, for `http(s)`, opened with `shell.openExternal`.
- `setWindowOpenHandler`: deny all; open `http(s)` externally.
- `session.setPermissionRequestHandler`: allow `media` only for audio; deny everything else by default.
- never enable `nodeIntegration` / `enableRemoteModule` / `webviewTag`; never load remote content into the main window.

## 4. Testing contract

- Unit tests: `node:test` + `node:assert/strict`, run by `npm test`.
- Runtime and shell pure modules must be testable without Electron; inject `spawn` / `request` / clock.
- Acceptance smoke: `npm run test:smoke` starts the real app with a temporary `DSH_HOME` and `DSH_ELECTRON_SMOKE=<file>`, waits for the JSON snapshot, then exits. It must not touch `~/.dsh` or the running `dsh-web.service`.
- Verifier owns `test/acceptance/**` and `verification/**`; it must independently reproduce the smoke test and review the security invariants.

## 5. Constraints

- Do not modify `~/.dsh`, `~/.config/niri`, `~/.config/systemd`, or the running `dsh-web.service` during development. Use temporary homes (`/tmp/dsh-electron-e2e-*`) and a separate Electron userData dir (`--user-data-dir` / `app.setPath('userData', ...)` only under test).
- Do not add runtime dependencies unless the Lead approves; v0.1 uses Node built-ins + Electron only.
- Do not commit `node_modules`, `dist`, logs, or generated artifacts.
- Code style: CommonJS, 2-space indent, semicolons, `node:` prefix for built-ins, no `console.log` in modules (use the injected logger).
- Every module gets a short header comment explaining its single responsibility.
- License: MIT for this shell; do not copy large code blocks from other projects. The DSH Desktop architecture is inspiration only.
