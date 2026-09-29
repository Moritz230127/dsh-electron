# DSH host v0.2 — binding contract

Supersedes nothing in `docs/ARCHITECTURE.md` for the existing Electron shell; extends it with the host supervisor.

## 0. Topology

```text
systemd --user (dsh-host.service, Restart=always)
└── /usr/bin/node src/host/supervisor.js        # one supervisor process
    ├── dsh web child (HarnessRuntime)          # official server, random loopback port
    │   └── stdout ready line -> URL file + status file
    └── Electron child (attach mode)            # official WebUI display layer
        └── reads URL file, (re)loads official UI
```

- The supervisor owns both children. UI exit does not stop DSH; DSH exit does not stop/close the UI intentionally.
- systemd only knows one service: `dsh-host.service`. Restarting the supervisor never leaves a `dsh web` orphan.

## 1. Paths and files

| Path | Purpose | Mode |
|---|---|---|
| `$XDG_RUNTIME_DIR/dsh-host/current-url` | ready URL with token for the UI | 0600, atomic tmp+rename |
| `$XDG_RUNTIME_DIR/dsh-host/status.json` | `{state,message,dshVersion,runtimeSource,updatedAt}` | 0600 |
| `$XDG_STATE_HOME/dsh-host/` (default `~/.local/state/dsh-host`) | logs, state, known-good runtimes | 0700 |
| `$XDG_STATE_HOME/dsh-host/known-good.json` | `{version,root,entry,recordedAt}` | 0600 |
| `$XDG_STATE_HOME/dsh-host/runtimes/<version>-<hash>/` | snapshot of a working DSH runtime | 0700 |
| `$XDG_STATE_HOME/dsh-host/ui-profile/` | Electron userData for the attach UI | 0700 |

`current-url` is always written after the DSH child reaches ready and is removed on supervisor shutdown. The UI must tolerate the file being absent or changing.

## 2. Supervisor contract (`src/host/supervisor.js`)

Node CommonJS, no Electron import. Must expose pure/testable helpers and a `run()` entry.
Constructor seams: `spawn`, `fs`, `now`, `logger`, `HarnessRuntime`, `waitForHealth`, `sleep`.

### 2.1 Config

Defaults, overridable by `$DSH_HOST_STATE_DIR/config.json` and env:

```js
{
  dshCommand: '',                 // resolved by config.resolveDshCommand
  dshHome: '',                    // default: ~/.dsh
  stateDir: '',                   // default: $XDG_STATE_HOME/dsh-host
  electronExecutable: '',         // default: env DSH_HOST_ELECTRON or packaged/dev resolution
  electronArgs: [],               // extra UI args
  host: '127.0.0.1',
  readyTimeoutMs: 30000,
  healthIntervalMs: 30000,
  healthFailureThreshold: 3,
  stableSecondsForPromotion: 15,
  restartWindowMs: 300000,
  maxChildRestarts: 5,
  fallbackRetrySystemAfterMs: 86400000
}
```

Electron resolution order:
1. `config.electronExecutable`
2. `env.DSH_HOST_ELECTRON`
3. `/opt/DSH Electron/dsh-electron` if it exists (packaged)
4. `<repo>/node_modules/electron/dist/electron` + `<repo>` as app arg (dev; `DSH_HOST_DEV_APP=1`)

### 2.2 Runtime resolution

- `resolveRuntimeRootFromEntry(entry)`: walk up from the real path of the `dsh` entry until a directory whose `package.json` has `name === '@deepseek-ai/dsh'`. If not found, return `null`.
- `runtimeVersion(root)`: `package.json.version`.
- Spawn: `spawn(process.execPath, [<root>/lib/bin.js, 'web', '--no-open', '--host', host, '--port', '0'], { env: { ...process.env, DSH_HOME }, shell: false })`. Reuse `HarnessRuntime` with `command = process.execPath`, `args = [entry, 'web', ...]`.
- If the real `dsh` entry is a symlink to another prefix, the resolved root is that prefix's package; snapshots therefore work for npm/pnpm/global installs.

### 2.3 Known-good fallback

State `attempt.json`: `{systemVersion, failedAt, failureCount}`.

Startup decision, in order:
1. Resolve current system runtime. If it fails to resolve, skip to known-good.
2. If `known-good.json` exists and `attempt.systemVersion === systemVersion` and `now - attempt.failedAt < fallbackRetrySystemAfterMs`, start known-good directly (fast path; do not wait for the broken system version again).
3. Otherwise try system runtime. It is considered healthy only after:
   - ready line received within `readyTimeoutMs`, and
   - process alive for `stableSecondsForPromotion`.
4. If system fails before promotion: stop it, record `attempt.json`, log the failure, and start known-good if present; otherwise exponentially retry system.
5. If system succeeds and stays stable: asynchronously snapshot the runtime root to `runtimes/<version>-<hash>` using `cp -a --reflink=auto` when available (fallback `cp -a`), atomically replace `known-good.json`, and keep at most 2 snapshots.
6. If the currently running runtime becomes unhealthy (health check fails `healthFailureThreshold` times): stop it and run the same fallback decision. A system runtime that failed mid-run is recorded as failed for that version.

Snapshot must not block the UI path; failures to snapshot only log and do not affect the running server.

### 2.4 Child management

- DSH restart budget: windowed `restartWindowMs`, `maxChildRestarts`; exponential backoff 1s -> 2s -> 4s -> 8s, cap 30s. On budget exhaustion write `status.state = 'error'` and keep retrying at a slow fixed 60s interval (never tight-loop).
- UI management:
  - exit code 0 or signal `SIGTERM` from supervisor shutdown = intentional; do not restart.
  - non-zero exit = crash; restart with the same windowed budget; after exhaustion keep DSH running and set `status.state='ui-error'`, retry at 60s.
- On supervisor SIGTERM/SIGINT: stop UI (SIGTERM, then SIGKILL after 5s), stop DSH (HarnessRuntime.stop), remove `current-url`, exit 0.
- On startup: write `status.state='starting'`; after DSH ready write `running` with `runtimeSource`; after fallback write `fallback` with the old version; on fatal write `error` with a short message.

### 2.5 Test seams and pure helpers

Export at least:
- `resolveRuntimeRootFromEntry`, `runtimeVersion`
- `decideRuntimeChoice({ systemVersion, knownGood, attempt, now, retryAfterMs })`
- `planChildRestart({ timestamps, now, maxRestarts, windowMs })`
- `resolveElectronLaunch({ config, env, exists, platform })`
- `writeUrlFileAtomic`, `readUrlFile`
- `run(config, seams)` and a CLI entry when `require.main === module`.

Unit tests must cover: system success; system fail -> known-good; fast path after failure; snapshot promotion; unhealthy runtime fallback; windowed restart cap; URL file atomic write/read; Electron resolution.

## 3. Electron attach mode contract (`src/main/**` + `src/main/attach-url.js`)

- Config additions: `attachUrlFile` from `--attach-url-file=<path>` and `DSH_ELECTRON_ATTACH_URL_FILE`.
- When `attachUrlFile` is set:
  - No DSH child is spawned; mode is effectively attach.
  - A file watcher polls every 500 ms (mtime+content; atomic rename safe) and emits the URL when the file content changes.
  - On URL: `waitForHealth(url)` then `win.loadURL(url)`; if the file disappears, show the loading page and keep polling; after 15 s show the error page but keep polling.
  - If the URL changes while the window is showing the old URL, reload with the new URL (no full app restart).
  - `status.json` may be polled once per second; its `message` is shown on loading/error pages (`Runtime status: ...`) but never blocks loading.
  - UI exit via tray Quit or window close (when closeToTray is false) must exit with code 0; supervisor treats that as intentional.
- Existing managed mode must remain unchanged and fully tested.

## 4. systemd / autostart contract

- `packaging/dsh-host.service` is a user unit:
  - `ExecStart=/usr/bin/node <host>/supervisor.js`
  - `Restart=always`, `RestartSec=3`
  - `Conflicts=dsh-web.service` (prevents two servers at login)
  - `After=graphical-session.target`, `PartOf=graphical-session.target`
  - `WantedBy=default.target`
- The supervisor must discover `WAYLAND_DISPLAY`/`DISPLAY` if systemd lacks them: if `WAYLAND_DISPLAY` is absent, pick the first `/run/user/<uid>/wayland-*`; if `DISPLAY` is absent and Wayland is not usable, try `:0`. It passes the discovered values to the Electron child.
- Packaging installs the unit and enables it for the current user without stopping the running `dsh-web.service` during development.
- The old `dsh-web.service` is disabled (not stopped) and the old niri spawn line is commented out only at final deployment; both actions are reversible and backed up.

## 5. Acceptance

- Real smoke with temp `DSH_HOME` proves supervisor + attach UI + official page load.
- Fake-runtime tests prove system-fail -> known-good fallback and UI/server independent restarts.
- `npm test` includes all new tests and stays green.
- Verifier independently reproduces the above, inspects the systemd unit, and reports ACCEPT/REJECT.
