# Building and running DSH Electron (Arch Linux)

Scope: Node 26 / npm 12, Electron 44.4.5, electron-builder 26.x, Wayland + niri,
NVIDIA. There are no runtime dependencies — only the two `devDependencies`
`electron` and `electron-builder`.

The repository lives at `/home/Arch/工作区/dsh-electron` and is also reachable
through the symlink `/home/Arch/Projects/dsh-electron`; either path works.

## 1. Prerequisites

- `node` / `npm` (verified with Node v26.10.0 and npm 12.1.0).
- Normal Arch desktop GTK/NSS/X11 libraries (already present on a running niri
  desktop).
- No compiler is required: the app has no native modules and packaging sets
  `build.npmRebuild = false`.
- Optional: `fuse2` (`sudo pacman -S fuse2`) if you want to execute AppImages
  directly. `--appimage-extract-and-run` avoids FUSE entirely.

## 2. Install dependencies (npm 12 caveat)

```bash
cd /home/Arch/工作区/dsh-electron   # or ~/Projects/dsh-electron

ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  npm install --foreground-scripts

# npm 12 may skip lifecycle scripts (electron's own postinstall included).
# This script is idempotent and repairs a missing binary explicitly:
node scripts/ensure-electron.js
```

Notes:

- `--foreground-scripts` forces npm to actually run package install scripts and
  to show their output. If your npm has `ignore-scripts=true`, plain
  `npm install` will silently leave the Electron binary missing.
- `scripts/ensure-electron.js` honours `ELECTRON_MIRROR`, respects
  `ELECTRON_SKIP_BINARY_DOWNLOAD`, and prints the exact commands to run if the
  download fails.
- Repair an existing tree with either of:
  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node scripts/ensure-electron.js
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm rebuild electron --foreground-scripts
  ```
- Check the installation:
  ```bash
  node -p "require('electron/package.json').version"   # -> 44.4.5
  npx electron --version
  npm config get ignore-scripts
  ```

## 3. Tests

```bash
npm test              # node:test unit tests (runtime + shell, no Electron)
npm run test:smoke    # acceptance smoke; needs test/acceptance/run-smoke.js
```

`npm run test:smoke` must use a temporary `DSH_HOME` and the
`DSH_ELECTRON_SMOKE=<file>` hook from `docs/ARCHITECTURE.md` §3.4; it must never
touch the live `~/.dsh` or the running `dsh-web.service`.

## 4. Run in development

`prestart` / `predev` run `scripts/ensure-electron.js` automatically.

```bash
# Recommended for development: throwaway DSH_HOME, no ~/.dsh and no service
# contention. The temp dir is the only place dsh writes its state.
DSH_HOME="$(mktemp -d /tmp/dsh-electron-dev.XXXXXX)" npm start

# Normal run against the real ~/.dsh — only when dsh-web.service is stopped
# (two `dsh web` processes sharing ~/.dsh can contend over state):
npm start

# Same as start but with the --dev flag (DevTools where config allows):
npm run dev
```

Useful CLI overrides (see `docs/ARCHITECTURE.md` §3.1):
`--dsh-home=DIR`, `--dsh-command=PATH`, `--port=PORT`, `--attach-url=URL`,
`--dev`, `--no-tray`. Automated smoke hook:
`DSH_ELECTRON_SMOKE=/tmp/dsh-smoke.json npm start`, then read the JSON snapshot.

## 5. Package

```bash
npm run package:dir      # unpacked app -> dist/linux-unpacked/dsh-electron
npm run package:linux    # pacman + AppImage -> dist/
```

electron-builder downloads its own Electron zip and AppImage tooling into the
user cache. On a network that cannot reach GitHub, point it at a mirror:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run package:linux
```

Run the unpacked binary:

```bash
./dist/linux-unpacked/dsh-electron
# isolated verification home:
DSH_HOME="$(mktemp -d /tmp/dsh-electron-run.XXXXXX)" ./dist/linux-unpacked/dsh-electron
# packaged smoke:
DSH_HOME="$(mktemp -d /tmp/dsh-electron-run.XXXXXX)" \
  DSH_ELECTRON_SMOKE=/tmp/dsh-packaged-smoke.json ./dist/linux-unpacked/dsh-electron
cat /tmp/dsh-packaged-smoke.json
```

Sandbox note (Arch unprivileged user namespaces):

```bash
cat /proc/sys/kernel/unprivileged_userns_clone   # normally 1
```

If the binary aborts with “The SUID sandbox helper binary was found, but is not
configured correctly”, either restore the helper permissions:

```bash
sudo chown root:root dist/linux-unpacked/chrome-sandbox
sudo chmod 4755 dist/linux-unpacked/chrome-sandbox
```

or, for local testing only, accept reduced isolation:

```bash
./dist/linux-unpacked/dsh-electron --no-sandbox
```

The app's persisted GPU fallback ladder (`docs/ARCHITECTURE.md` §3.2) handles
Electron 44 + Wayland + NVIDIA glitches automatically; its state lives in the
Electron userData dir (normally `~/.config/DSH Electron/gpu-fallback.json`).
Deleting that file resets the ladder to `default`.

Install the packaged artifacts (this is part of the live switchover — do NOT
run it during development without the user's explicit go-ahead, see
`docs/MIGRATION.md`):

```bash
ls dist/                                             # confirm exact file names
chmod +x dist/dsh-electron-0.1.0-x86_64.AppImage
./dist/dsh-electron-0.1.0-x86_64.AppImage            # or --appimage-extract-and-run
sudo pacman -U dist/dsh-electron-0.1.0-x64.pkg.tar.xz
```

The AppImage needs `fuse2` to run directly; without it use
`--appimage-extract-and-run`. For the pacman target electron-builder downloads
its own prebuilt `fpm` (Ruby included) into its cache on first use, so no system
Ruby/fpm is required; set `USE_SYSTEM_FPM=true` if you prefer a system `fpm`.
Both pacman and AppImage builds need network access on the first run (use the
mirror variables above).

Until a brand icon is added, packages use Electron's default icon.

## 6. Desktop entry and niri window rule (manual)

Both are templates. Copy/apply them only as part of the user-approved
switchover.

```bash
# Application launcher (assumes dsh-electron is on PATH; for the unpacked dir
# build, edit Exec or symlink ~/.local/bin/dsh-electron -> dist/linux-unpacked/dsh-electron)
install -Dm644 packaging/dsh-electron.desktop ~/.local/share/applications/dsh-electron.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true

# Optional autostart (use this OR a niri spawn-at-startup line, not both)
install -Dm644 packaging/dsh-electron.desktop ~/.config/autostart/dsh-electron.desktop
```

niri window rule — append the `window-rule` block from
`packaging/niri-window-rule.kdl` to the end of `~/.config/niri/config.kdl`
(after the global opacity/blur rules), then validate:

```bash
niri validate
```

Verify the real Wayland app-id while the app is running:

```bash
ls -l /run/user/$(id -u)/niri.*.sock
NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock niri msg windows
NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock niri msg --json windows | grep -i app_id
# inside the niri session plain `niri msg windows` also works
```

Expected app-id: `dsh-electron`. If the observed value differs, update the
`match app-id=` regex in the rule. niri also reloads the config on save; you can
force it with `niri msg action load-config-file`.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `electron: command not found`, `Electron failed to install correctly` | npm 12 skipped install scripts. Run `node scripts/ensure-electron.js`; if the download fails use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --foreground-scripts`. |
| `ensure-electron: electron/install.js failed` | GitHub is blocked or slow; set `ELECTRON_MIRROR` as printed by the script. |
| electron-builder AppImage build fails downloading tools | Set `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`. |
| Window shows stale/blank content after a GPU glitch | The persisted fallback ladder restarts the harness; delete `gpu-fallback.json` in the Electron userData dir to reset, then restart. |
| Window is translucent / blurred despite the niri rule | The app-id does not match. Run `niri msg windows`, read the real `App ID`, update `packaging/niri-window-rule.kdl`, then `niri validate`. |
| Two `dsh web` processes / state contention | The old `dsh-web.service` is still running. Stop and disable it first (see `docs/MIGRATION.md`); never run both hosts at once. |

## 8. Development safety rules

- Do not modify `~/.dsh`, `~/.config/niri`, `~/.config/systemd`, or the running
  `dsh-web.service` while developing. Use temporary homes
  (`/tmp/dsh-electron-*`) and a separate Electron userData dir in tests.
- `node_modules/`, `dist/`, `dist-dev/` and logs are git-ignored; never commit
  them.
- The live switchover described in `docs/MIGRATION.md` is a manual,
  user-approved step and must not be performed by agents during development.
