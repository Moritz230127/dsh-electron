# Local AUR package

`aur/dsh-electron/PKGBUILD` builds and installs the complete Linux host:

```bash
cd aur/dsh-electron
makepkg --printsrcinfo > .SRCINFO   # regenerate after PKGBUILD edits
makepkg -si
systemctl --user enable --now dsh-host.service   # enable/start the user service
```

The package installs:

- `/opt/DSH Electron/` — the packaged Electron app plus supervisor/runtime helpers
- `/usr/lib/systemd/user/dsh-host.service` — user unit, auto-enabled for
  `default.target` via `default.target.wants/dsh-host.service`
- `/usr/share/applications/deepseek-harness.desktop` — app-launcher entry
  (`systemctl --user start dsh-host.service`)
- `/usr/share/icons/hicolor/{256x256,32x32}/apps/deepseek-harness.png`
- `/usr/share/doc/dsh-electron/` — niri window rule, deployment/handoff docs
- `/usr/share/licenses/dsh-electron/LICENSE`

## Publishing to the official AUR

This repository only prepares a **local** AUR package. Publishing to
<https://aur.archlinux.org/> requires your own AUR account and an SSH key
registered there:

```bash
# one-time
git clone ssh://aur@aur.archlinux.org/dsh-electron.git
cd dsh-electron
cp /path/to/repo/aur/dsh-electron/PKGBUILD .
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO
git commit -m 'Initial import: dsh-electron 0.1.0'
git push
```

Maintainer/contact: **moritz001@163.com**.
