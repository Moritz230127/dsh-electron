# Deploying the DSH host (v0.2) — internal runbook

Audience: the Lead / maintainer performing the final switchover on this machine.
Nothing in this document is executed automatically, and **no agent may run the
live deployment**. The final "start the service" step is a user-approved action.

> **WARNING — the start is disruptive.** `dsh-host.service` has
> `Conflicts=dsh-web.service`. Running
> `systemctl --user start dsh-host.service` immediately **stops the currently
> running `dsh-web.service`** and therefore the old session. Install/enable is
> deliberately non-destructive; only the explicit user action starts the host.
> On the next login the unit starts automatically (`WantedBy=default.target`).

## 1. What gets installed where

| Item | Path |
|---|---|
| unit template (repo) | `packaging/dsh-host.service` |
| installed unit | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/dsh-host.service` |
| supervisor (packaged) | `/opt/DSH Electron/resources/host/supervisor.js` |
| supervisor (dev) | `<repo>/src/host/supervisor.js` via `<repo>/scripts/run-dsh-host.js` |
| optional env overrides | `~/.config/dsh-host.env` (may not exist) |
| install manifest | `${XDG_STATE_HOME:-~/.local/state}/dsh-host/install-manifest.env` |
| niri backup | `…/dsh-host/install-backups/<timestamp>/niri-config.kdl` |

Runtime files (created by the supervisor, not the installer):
`$XDG_RUNTIME_DIR/dsh-host/current-url`, `…/status.json`, and
`$XDG_STATE_HOME/dsh-host/` (logs, known-good runtimes, UI profile).

## 2. Build (after T11/T12 land)

```bash
cd /home/Arch/工作区/dsh-electron

# unpacked dir (host files land in dist/linux-unpacked/resources/…)
npm run package:dir

# full package set; the pacman target needs the libcrypt-compat workaround
# documented in packaging/electron-builder-notes.md (no sudo):
LD_LIBRARY_PATH=/tmp/t6-libxcrypt/usr/lib npm run package:linux
```

Packaged layout produced by the `extraResources` mapping:

```
dist/linux-unpacked/
  dsh-electron
  resources/
    host/supervisor.js          # + src/host siblings
    main/runtime/*.js           # for require('../main/runtime/…')
    main/config.js
    scripts/run-dsh-host.js
    dsh-host.service            # unit template
```

## 3. Install (non-destructive)

```bash
cd /home/Arch/工作区/dsh-electron

# 1) preview — default is dry-run; changes nothing
packaging/install-host.sh --dry-run

# 2) apply (user-level only, no sudo)
packaging/install-host.sh --deploy            # auto-detects /opt/DSH Electron, else dev
packaging/install-host.sh --deploy --dev --app-root "$PWD"   # force dev layout
packaging/install-host.sh --deploy --skip-niri               # skip niri edits
```

`--deploy` does exactly this:

1. renders `packaging/dsh-host.service` with the resolved `ExecStart`
   (packaged: `/usr/bin/node "/opt/DSH Electron/resources/host/supervisor.js"`;
   dev: `/usr/bin/node "<repo>/scripts/run-dsh-host.js"` + `DSH_HOST_DEV_APP=1`)
   and installs it under `~/.config/systemd/user/`;
2. `systemctl --user daemon-reload`;
3. `systemctl --user enable dsh-host.service` — **enabled, not started**;
4. records and then `systemctl --user disable dsh-web.service` — **disabled,
   never stopped**;
5. backs up `~/.config/niri/config.kdl` and edits it:
   - comments old DSH/PWA `spawn-at-startup` / `spawn-sh-at-startup` lines with
     a `// dsh-host-disabled: …` marker (idempotent; already commented lines are
     skipped, and a redeploy keeps the original backup for rollback),
   - appends `packaging/niri-window-rule.kdl` if the `dsh-electron` rule is not
     present,
   - runs `niri validate` on the edited file; on failure the original config is
     left untouched and the script exits non-zero (a manifest checkpoint is
     written first, so `--rollback` still works).

It never touches `~/.dsh`, never stops a service, never uses sudo, and never
starts `dsh-host.service`.

## 4. Final switchover (user-approved, one action)

After reviewing the install and when the work session can be interrupted:

```bash
systemctl --user start dsh-host.service
```

Consequences (expected):

- `dsh-web.service` is stopped by `Conflicts=`;
- the old Chrome PWA window closes; the niri `spawn-at-startup` line was already
  commented out, so it will not return after logout;
- the supervisor starts `dsh web`, writes
  `$XDG_RUNTIME_DIR/dsh-host/current-url`, then launches the packaged Electron
  in attach mode.

Do not run this from an automated agent or during an active DSH task.

## 5. Verify

```bash
systemctl --user status dsh-host.service      # active (running)
systemctl --user is-enabled dsh-host.service  # enabled
systemctl --user is-active dsh-web.service    # inactive
pgrep -af 'src/host/supervisor.js|resources/host/supervisor.js'
pgrep -af 'dsh web'                           # exactly one, child of supervisor

cat "$XDG_RUNTIME_DIR/dsh-host/current-url"   # 0600, ready URL with token
cat "$XDG_RUNTIME_DIR/dsh-host/status.json"   # state=running|fallback
journalctl --user -u dsh-host.service -n 50 --no-pager

NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock niri msg windows | grep -i 'dsh'
```

The official UI must load unmodified; `~/.dsh` must be untouched (same files,
same profile). If the UI or DSH crashes, the supervisor recovers internally —
the user does not run commands.

## 6. Rollback

```bash
cd /home/Arch/工作区/dsh-electron
packaging/install-host.sh --rollback            # uses the install manifest
packaging/install-host.sh --rollback --dry-run  # preview only
```

Rollback:

1. disables `dsh-host.service` (does **not** stop it);
2. removes the installed unit, or restores the previous unit from the backup;
3. `systemctl --user daemon-reload`;
4. restores the niri config from the *original* pre-deploy backup, strips any
   remaining `// dsh-host-disabled:` markers (so exactly the lines this
   installer commented are active again) and re-validates it;
5. re-enables `dsh-web.service` only if it had been enabled before deploy.

If `dsh-host.service` is still running after rollback, stop it manually before
starting the old service:

```bash
systemctl --user stop dsh-host.service     # user-approved
systemctl --user start dsh-web.service
```

## 7. Dev variant / manual run

```bash
# from the repo, no systemd involved:
DSH_HOST_DEV_APP=1 node scripts/run-dsh-host.js --help
node scripts/run-dsh-host.js --app-root "$PWD"
npm run host
```

The systemd dev variant is selected with
`packaging/install-host.sh --deploy --dev --app-root "$PWD"`, which uses the
launcher so `DSH_HOST_STATE_DIR` / `DSH_HOST_ELECTRON` / `DSH_HOST_DEV_APP` are
resolved before `execve`ing `/usr/bin/node <repo>/src/host/supervisor.js`.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `install-host.sh` says "no supervisor found" | T11/T12 artifacts are not built; run `npm run package:dir` or pass `--app-root`/`--dev`. |
| dry-run shows `/opt/DSH Electron/...` but you want a dev install | use `--deploy --dev --app-root "$PWD"`. |
| `niri validate rejected the edited config` | nothing was changed; inspect the backup path printed by the script, fix `niri-window-rule.kdl` or use `--skip-niri`. |
| unit starts but UI never appears | `journalctl --user -u dsh-host.service`; check `$XDG_RUNTIME_DIR/dsh-host/status.json`, Electron resolution and `WAYLAND_DISPLAY`. |
| want to test without touching systemd | `--skip-systemctl` is test/CI-only; combine with a throwaway `HOME`/`XDG_CONFIG_HOME`. |


## 9. Launcher registration (v0.2, user-level)

The live dev deployment also installed:
- `~/.local/share/applications/deepseek-harness.desktop` (template `packaging/deepseek-harness.desktop`) -> `systemctl --user start dsh-host.service`;
- `~/.local/share/icons/hicolor/{scalable,256x256}/apps/deepseek-harness.{svg,png}`;
- hid the old Chrome PWA launcher with `NoDisplay=true` (file preserved for rollback; backup under `~/.local/state/dsh-host/install-backups/launcher-*`).

This is a user-level registration only. `install-host.sh --deploy` still covers the
service + autostart + niri integration; run the launcher registration separately
if rebuilding on another user profile.


## 10. GUI close and tray behaviour (v0.2)

- Window close hides to the tray; DSH continues running under `dsh-host.service`.
- Tray: `显示 DSH`, `重启 Harness`, `隐藏界面（DSH 后台继续）`.
- Tray icon comes from `packaging/icon.png` (official DSH favicon); packaged builds include it via `extraResources` as `resources/icon.png`.
- Full stop: `systemctl --user stop dsh-host.service` (this stops the supervisor, DSH and UI).
