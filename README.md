# DSH Electron — a stable Linux host for the official DeepSeek Harness Web UI

**Unofficial.** DeepSeek Harness (DSH) officially ships a desktop app for Windows and macOS only.
This project provides the missing Linux equivalent: a self-healing, version-decoupled host that
loads the **official, unmodified** DSH Web UI.

- Contact: **moritz001@163.com**
- Repository: <https://github.com/Moritz230127/dsh-electron>
- License: MIT (see `LICENSE`)
- Status: `v0.1.0`, independently verified; see `docs/V0.2-HANDOFF.md` and `verification/REPORT.md`

DSH Electron is not a DSH fork. It never patches the frontend, never replaces the official assets,
and never copies or rewrites your `~/.dsh` data. It only supervises the official `dsh web` process
and displays the official Web UI in a sandboxed window.

---

## What problem does it solve?

The official DSH Web UI is normally run as `dsh web` and displayed in a browser. On Linux, using a
Chrome installed-PWA window as the host has real problems:

- the PWA shares one browser process, GPU process and resource budget with everyday browsing;
- it bypasses the user's browser wrapper flags;
- it has no supervisor: renderer/GPU crashes leave a blank window;
- DSH is a preview project that changes quickly and sometimes ships a broken release.

DSH Electron separates the concerns:

| Layer | Responsibility |
|---|---|
| `dsh web` child | official server: profiles, sessions, plugins, tasks |
| supervisor | lifecycle, health, known-good fallback, restarts, logs |
| Electron UI | display only: sandboxed official Web UI + tray |
| systemd user unit | starts the supervisor at login and restarts it if it dies |

## Core principles

1. **Official Web UI untouched**
   The window loads the real loopback URL printed by `dsh web`. No frontend patches, no injected
   scripts, no modified static assets.
2. **Lifecycle separation**
   The DSH server and the Electron UI are independent children of one supervisor. Closing or
   crashing the UI does not stop tasks; restarting DSH does not kill the UI.
3. **Self-healing**
   systemd restarts the supervisor. The supervisor restarts DSH or the UI with bounded,
   windowed budgets and exponential backoff; it never tight-loops.
4. **Internal known-good runtime fallback**
   After a DSH runtime starts successfully, the supervisor snapshots that runtime locally. If a
   newly installed DSH version fails to start, it automatically falls back to the snapshot against
   the same `~/.dsh`; the user sees the normal official UI, not a rollback procedure.
5. **Zero user maintenance**
   Install once, start automatically at login. DSH updates are picked up on the next host start;
   a broken preview update is handled internally. No version picker, no check script, no manual
   rollback command.
6. **Small compatibility surface**
   The host only depends on the `dsh web` CLI flags, the ready-URL line on stdout, an atomic URL
   file and the official HTTP/WebSocket UI. It does not import DSH internals.

## Architecture

```text
systemd --user dsh-host.service          (enabled, Restart=always)
└── supervisor (Node, no Electron import)
    ├── dsh web child                    (official server, random loopback port)
    │   └── ready URL → $XDG_RUNTIME_DIR/dsh-host/current-url  (0600)
    │                  $XDG_RUNTIME_DIR/dsh-host/status.json   (0600)
    └── Electron child (attach mode)     (sandboxed official Web UI + tray)
        └── polls current-url, loads/reloads the official UI
```

Known-good snapshots and state live under `$XDG_STATE_HOME/dsh-host/` (default
`~/.local/state/dsh-host/`). `~/.dsh` remains the single source of truth and is never managed by
this project.

### GUI close / quit behaviour

- Closing the window hides it to the tray and logs
  `main window hidden to tray; DSH host keeps running`. DSH tasks continue in the background.
- Tray menu: **显示 DSH** / **重启 Harness** / **隐藏界面（DSH 后台继续）**.
- To stop the whole platform (supervisor + DSH + UI):
  `systemctl --user stop dsh-host.service`.

### DSH update behaviour

1. The host starts the currently installed `dsh` from the system.
2. If it becomes ready and stays stable, that runtime is snapshotted as known-good.
3. If the newly installed runtime fails before becoming ready, the supervisor records the failure
   and starts the known-good snapshot instead.
4. A later successful version automatically becomes the new known-good snapshot.
5. The same-version fast path avoids repeatedly waiting on a known-broken DSH version.

The supervisor only sees the `dsh web` CLI and its ready line. A DSH update therefore normally
requires no change in this host; if the CLI contract changes, only
`src/main/runtime/ready-url.js` / `src/host/supervisor.js` need a small adaptation.

## Features

- official Web UI, zero frontend patches
- sandboxed renderer: `contextIsolation`, `nodeIntegration:false`, `sandbox:true`, no `webViewTag`
- strict navigation and permission allow-lists (audio media + clipboard, runtime origin only)
- bounded renderer recovery (rolling 60 s / 3 reloads / 5 s cooldown)
- GPU fallback ladder: `default → --disable-gpu-sandbox → --disable-gpu --disable-gpu-compositing`
- internal known-good DSH runtime fallback
- atomic 0600 URL/status files
- systemd user unit, XDG autostart/launcher integration, official DSH tray icon
- niri/Wayland-friendly window rule (exclude the window from global blur/opacity)
- Linux packaging: unpacked dir, AppImage, pacman package

## Install

### AUR package (source)

A PKGBUILD is provided at `aur/dsh-electron/PKGBUILD`. It builds the host from the GitHub release
tarball with `npm ci` and `npm run package:dir`, then installs it under `/opt/DSH Electron`.

```bash
cd aur/dsh-electron
makepkg -si
systemctl --user enable --now dsh-host.service
```

The package also installs a user systemd unit and a desktop launcher. It is **not** published to
the official AUR by this repository; users must submit it with their own AUR account if desired
(see `aur/README.md`).

### From source

```bash
npm install --foreground-scripts
npm test
npm run package:dir
# development run:
node scripts/run-dsh-host.js --app-root "$PWD"
```

### Packaged artifacts

`npm run package:dir` → `dist/linux-unpacked/`
`npm run package:linux` → AppImage and pacman package (needs `libcrypt-compat` for electron-builder's
fpm on Arch; see `packaging/electron-builder-notes.md`).

## Verification

`npm test` currently passes **207/207** tests. The v0.2 feature set was verified with real DSH and
real Electron E2E phases (official UI load, UI-kill independence, DSH restart + URL refresh,
known-good fallback, bounded restart budget, packaged attach/managed smoke) by an independent
verifier. See `verification/REPORT.md`.

## Security notes

- The supervisor, URL file and status file are user-level and mode `0600`; the UI only loads the
  loopback URL published by the official server.
- The DSH server binds `127.0.0.1` on an ephemeral port (`--port 0`).
- The Electron window blocks navigation outside the runtime origin and local recovery pages.
- Permission requests are denied by default; only explicit audio media from the runtime origin is
  allowed.
- The project never reads or writes credentials beyond what the official `dsh web` process owns.

## Disclaimer

DeepSeek Harness, DeepSeek and related marks belong to their respective owners. This is an
independent, unofficial Linux host. The official DSH Web UI is loaded unmodified and remains the
work of the DeepSeek Harness project.

## Contact

Email: **moritz001@163.com**
