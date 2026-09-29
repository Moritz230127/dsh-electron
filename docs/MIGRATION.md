# Migration: Chrome PWA + dsh-web.service → DSH Electron

> **AGENTS: STOP. This document is a plan, not a development action list.**
> Nothing here may be executed by an agent during development. The commands
> below stop/disable a systemd user service, edit niri config, and change what
> starts at login. They are for **the user to run manually**, after explicitly
> approving the live switchover.
>
> Hard rules from `docs/ARCHITECTURE.md` §5 still apply: do not touch `~/.dsh`,
> the running `dsh-web.service`, niri config, or systemd config while
> developing. Use `docs/BUILD.md` with temporary `DSH_HOME` dirs instead.

## 1. What changes, and what does not

Current setup:

- a systemd **user** service `dsh-web.service` runs `dsh web` (fixed port);
- niri starts the DeepSeek Harness **Chrome PWA** window at login
  (`spawn-at-startup` line; observed app-id
  `chrome-hgiemfgfjhalibdoboikeiepnnjapnpc-Default`);
- the PWA and the service are two halves of the same web UI.

Target setup:

- **DSH Electron** owns a single `dsh web` child process (ephemeral port),
  captures the authenticated URL, and hosts it in a sandboxed Electron window;
- the old service is stopped and disabled (not uninstalled);
- the old niri startup line is commented out (not deleted);
- the Chrome PWA is left installed as the rollback path.

What does **not** change:

- **`~/.dsh` is untouched.** DSH Electron uses the same `DSH_HOME` as before;
  there is no profile migration, no copy, no delete, no re-init. Both hosts read
  the same harness home — which is exactly why they must not run at the same
  time.
- No DSH fork, no frontend changes, no data format changes.

## 2. Pre-flight checklist (all must be true)

- [ ] `npm test` passes.
- [ ] `npm run test:smoke` passes with a temp `DSH_HOME` and writes
      `"ok": true`.
- [ ] `npm run package:dir` produced `dist/linux-unpacked/dsh-electron`, and
      launching it with a temp `DSH_HOME` passes the smoke hook.
- [ ] You have read this whole document and accept that the old service stops.
- [ ] No DSH Electron instance is currently running (tray → Quit).

If any box is unchecked, stop; do not switch over yet.

## 3. Step 0 — record the rollback baseline

Run these first and keep the output (terminal scrollback or a file outside the
repo). Without a recorded baseline, rollback is guesswork.

```bash
# systemd unit state and definition
systemctl --user status dsh-web.service
systemctl --user is-enabled dsh-web.service
systemctl --user cat dsh-web.service

# what is running now
pgrep -af 'dsh web'

# niri config backup (timestamped; this file is the rollback source)
cp ~/.config/niri/config.kdl ~/.config/niri/config.kdl.bak-$(date +%Y%m%d-%H%M%S)
ls -l ~/.config/niri/config.kdl.bak-*

# find the startup line you will comment out (note its line number)
grep -nE 'spawn-at-startup|chrome|dsh' ~/.config/niri/config.kdl

# where the app will store its own state (Electron userData; NOT ~/.dsh)
ls -la "$HOME/.config/DSH Electron" 2>/dev/null || true
```

## 4. Step 1 — stop the old stack

Quit the Chrome PWA window first, then:

```bash
systemctl --user stop dsh-web.service
systemctl --user disable dsh-web.service

# verify it is really gone
systemctl --user is-active dsh-web.service     # expected: inactive
pgrep -af 'dsh web'                            # expected: no output
pgrep -af 'dsh-electron'                       # expected: no output
```

Do **not** uninstall or delete the unit; `disable` keeps it available for
rollback.

## 5. Step 2 — remove the old niri startup line, install the new entry

With your editor, open `~/.config/niri/config.kdl` and comment out the
`spawn-at-startup` line that launches the Chrome PWA (prefix it with `//`).
Do not delete it — keeping the commented line makes rollback trivial.

```bash
nano ~/.config/niri/config.kdl      # comment out the PWA spawn-at-startup line
niri validate                       # must print: config is valid
niri msg action load-config-file    # only if niri did not reload on save
```

Install the launcher, and choose **exactly one** autostart mechanism:

```bash
# launcher
install -Dm644 packaging/dsh-electron.desktop \
  ~/.local/share/applications/dsh-electron.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true

# Option A (recommended): XDG autostart
install -Dm644 packaging/dsh-electron.desktop \
  ~/.config/autostart/dsh-electron.desktop

# Option B: instead of Option A, add a niri spawn-at-startup line for
# `dsh-electron`. Do not do both, or two app windows will start.

# niri window rule: append the window-rule block from
# packaging/niri-window-rule.kdl to the end of ~/.config/niri/config.kdl
niri validate
```

## 6. Step 3 — launch DSH Electron

Use the build you verified in the checklist. Examples:

```bash
# unpacked dir build (no system install needed)
/home/Arch/工作区/dsh-electron/dist/linux-unpacked/dsh-electron

# pacman artifact (local/unsigned build; its depends are real Arch packages
# verified against the configured repos and are pulled in by pacman)
ls dist/dsh-electron-*.pkg.tar.*
sudo pacman -U dist/dsh-electron-0.1.0-x64.pkg.tar.xz
# The package installs a desktop entry with an absolute Exec; there is no
# /usr/bin/dsh-electron symlink. Launch via the app grid, or directly:
"/opt/DSH Electron/dsh-electron"

# XDG autostart: use the packaged absolute Exec. If you copied
# packaging/dsh-electron.desktop instead, edit its Exec line to the absolute
# path above (or symlink the binary into ~/.local/bin/dsh-electron).

# AppImage
chmod +x dist/dsh-electron-0.1.0-x86_64.AppImage
./dist/dsh-electron-0.1.0-x86_64.AppImage
```

The first launch uses the real `~/.dsh`; nothing is copied or rewritten by the
migration itself.

## 7. Step 4 — verify

```bash
# exactly one dsh web process: the child of DSH Electron
pgrep -af 'dsh web'
pgrep -af dsh-electron

# old service stays down
systemctl --user is-active dsh-web.service    # inactive
systemctl --user is-enabled dsh-web.service   # disabled

# window rule: app-id must be dsh-electron
NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock niri msg windows
```

Checklist:

- [ ] The DSH UI loads in the Electron window (not in Chrome).
- [ ] The window is opaque under the global niri opacity/blur rule.
- [ ] Closing the window hides to tray (per config); tray → Quit exits and
      leaves no `dsh web` process behind.
- [ ] Tray → Restart Harness recovers the UI.
- [ ] After a logout/login, only one host starts (no duplicate window).
- [ ] `~/.dsh` still contains your original data; nothing was moved.

## 8. Rollback (exact)

If anything is wrong, restore the old stack in this order:

```bash
# 0. Quit DSH Electron via tray → Quit, or:
pkill -x dsh-electron || true
pgrep -af 'dsh web'                          # should be empty before continuing

# 1. remove the new launcher/autostart files (only these)
rm -f ~/.config/autostart/dsh-electron.desktop
rm -f ~/.local/share/applications/dsh-electron.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true

# 2. restore the niri config from the Step 0 backup
cp ~/.config/niri/config.kdl.bak-<timestamp> ~/.config/niri/config.kdl
niri validate
niri msg action load-config-file
# (or just uncomment the PWA spawn-at-startup line if you edited by hand;
#  the DSH Electron window-rule block may stay — it simply never matches)

# 3. re-enable the old service
systemctl --user enable --now dsh-web.service
systemctl --user is-active dsh-web.service   # expected: active

# 4. start the Chrome PWA again (app menu, or log out/in so the restored
#    niri spawn-at-startup line fires)

# 5. verify rollback
pgrep -af 'dsh web'
```

Optional cleanup of the new app (does not affect rollback):

```bash
# pacman install
sudo pacman -Rns dsh-electron
# AppImage / unpacked build: just delete the file or dist/ directory
```

`~/.dsh` needs no restore step: it was never moved, copied, or deleted. Do not
delete or re-initialize it as part of a rollback.

## 9. Persistent state created by DSH Electron

Outside `~/.dsh`, the app may create:

- the Electron userData dir, normally `~/.config/DSH Electron/`
  (`config.json`, `gpu-fallback.json`, logs);
- the launcher/autostart files from Step 2;
- packaged artifacts in `dist/` (git-ignored).

None of these contain harness data and none need to be migrated. When in doubt,
deleting the userData dir only resets the app's own settings/GPU ladder.

## 10. Why the old and new hosts must not run together

Both ultimately manage a `dsh web` process against the same `DSH_HOME`
(`~/.dsh`). Running them simultaneously gives two writers on the same harness
state and two UI windows, which can cause confusing behaviour. This is why the
switchover stops and disables the old service first, and why the niri startup
line is commented out before the new autostart entry is installed.
