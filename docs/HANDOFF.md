# DSH Electron v0.1 — final handoff

Status: **v0.1.0 complete and independently verified (T9 verdict: ACCEPT).**
Date: 2026-09-29 (Asia/Shanghai). Live system untouched during development; switchover documented only.

## 1. What was built

A dedicated Electron host for the local DeepSeek Harness Web UI, replacing the Chrome PWA wrapper.

```text
Electron main (sandboxed window)
  └─ managed Node child: dsh web --no-open --host 127.0.0.1 --port 0
       ├─ stdout ready line -> parse token URL
       ├─ health check -> BrowserWindow.loadURL(token URL)
       ├─ bounded renderer/GPU recovery + persisted GPU fallback ladder
       ├─ single-instance lock, tray, close-to-tray, logging
       └─ DSH_ELECTRON_SMOKE acceptance hook
```

Key properties: dedicated Electron profile/process/GPU, no Chrome PWA, no shared daily-browser process, token parsed from the child (no journalctl scraping), sandboxed renderer (`contextIsolation`, `nodeIntegration:false`, `sandbox:true`, `webViewTag:false`), navigation/permission allow-lists, bounded reload budget, GPU fallback levels (`default -> disable-gpu-sandbox -> disable-gpu + disable-gpu-compositing`), and atomic config/log persistence.

## 2. Team execution ledger

| Task | Owner | Result |
|---|---|---|
| T1 runtime supervisor (`HarnessRuntime`, ready-URL parser, health) | `runtime` | complete, 33 tests |
| T2 Electron shell (main/config/window/recovery/GPU/tray/preload/renderer) | `shell` | complete, 67 tests |
| T3 packaging + integration + migration docs | `packaging` | complete, AppImage/dir built |
| T4 independent verification + smoke + security review | `verifier` | complete, verdict REJECT (1 counterexample) |
| T5 packaged artifact smoke | `packaging` | complete |
| T6 pacman metadata + build | `packaging` | complete |
| T7 pacman dependency set (21 verified Arch packages) | `packaging` | complete |
| T8 fix bounded reload + strict audio permission | `shell` | complete |
| T9 re-verification after T8 | `verifier` | complete, **ACCEPT** |
| T10 final artifact rebuild after T8 | `packaging` | complete |

## 3. Final evidence (all reproduced on this machine)

- `npm test` -> **148 pass / 0 fail / 0 skipped / 0 todo**, 5.53 s.
- `npm run test:smoke` -> **PASS 8/8** with a fresh temporary `DSH_HOME`:
  `{"ok":true,"title":"DeepSeek Harness","readyState":"complete","bodyTextLength":337,"appRootFound":true}`, exit 0, no orphan `dsh`.
- Packaged smoke (`dist/linux-unpacked/dsh-electron`) -> **PASS 8/8**; asar source files byte-identical to repo.
- Sandbox probe (real Electron renderer) -> no `process`/`require`/`Buffer`; only the minimal `dshShell.retry/quit` surface.
- Wayland app-id -> `dsh-electron` (matches the niri rule); niri validate of the rule -> valid.
- Sandbox -> runs without `--no-sandbox` (unprivileged user namespaces).
- Live system -> `dsh-web.service` PID 1102 untouched; `~/.dsh` mtime unchanged; no niri/systemd edits during development.

## 4. Final artifacts

| Artifact | Size | SHA-256 (short) |
|---|---|---|
| `dist/linux-unpacked/dsh-electron` | 228,605,256 B | `ee9faf5b...` |
| `dist/dsh-electron-0.1.0-x86_64.AppImage` | 125,069,034 B | `39a67d7a...` |
| `dist/dsh-electron-0.1.0-x64.pkg.tar.xz` | 91,386,308 B | `fe79ce3c...` |

Full hashes and build caveats: `packaging/electron-builder-notes.md`.
Package caveats: local/unsigned build, placeholder homepage/author metadata, default Electron icon; not for distribution as-is.

## 5. Switchover (manual, reversible)

The live switchover stops the service that currently hosts the DSH session, so it must be run by the user, not by an agent mid-session. Full runbook with rollback: `docs/MIGRATION.md`. Short version:

1. `systemctl --user stop dsh-web.service && systemctl --user disable dsh-web.service`
2. Comment out the old PWA/niri `spawn-at-startup` line in `~/.config/niri/config.kdl`; keep the Chrome PWA installed as fallback.
3. Append `packaging/niri-window-rule.kdl` to the niri config (after the global opacity/blur rule); `niri validate`.
4. Install one autostart entry: `packaging/dsh-electron.desktop` -> `~/.config/autostart/` and `~/.local/share/applications/`.
5. Launch `dist/linux-unpacked/dsh-electron` (or install the pacman artifact with `sudo pacman -U dist/dsh-electron-0.1.0-x64.pkg.tar.xz`). It starts its own `dsh web` against the unchanged `~/.dsh`.
6. Verify: one `dsh web` process; Electron window title DeepSeek Harness; app-id `dsh-electron`; old service inactive/disabled.

Rollback: quit the Electron tray app, remove the two launcher/autostart files, restore the niri backup or uncomment the PWA line, then `systemctl --user enable --now dsh-web.service`. `~/.dsh` is never moved or rewritten.

## 6. Accepted residual risks for v0.1

- Subframe navigations are not covered by the main-frame `will-navigate` allow-list (renderer is sandboxed, no Node, no webview tag; DSH may legitimately embed content). Tracked for v0.2.
- The real GPU-crash relaunch path is policy-tested and dynamically simulated, not provoked on real hardware.
- Live `getUserMedia`/device permission behaviour of DSH voice input is not exercised by the smoke suite.
- `extraSwitches` in the local config are unvalidated (same-user trust boundary).
- Tray/StatusNotifier behaviour and pacman installation were verified structurally/with `pacman -Qip`, not by a real login-session tray test.
- Real-profile compatibility was smoke-checked against a read-only copy of the user's `profiles/web` + `settings.yaml`; the final live switchover remains a user action.
