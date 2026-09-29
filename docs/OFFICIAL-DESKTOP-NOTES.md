# Official DeepSeek Harness Desktop — inspection notes (2026-09-29)

Source: <https://www.deepseek.com/en/harness/> download links.

## Artifacts published

| Platform | URL | Size | SHA-256 |
|---|---|---|---|
| Windows x64 | `https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe` | 289,313,640 B | `d61cd8882f8b8a1251144320493ad27920d15139503eba2465b9579eee720cfc` |
| macOS arm64 | `https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg` | 369,764,183 B | (not downloaded) |

No Linux artifact exists on the official page. Probes for
`dsh-latest-linux-x64.AppImage`, `.deb`, `.tar.gz` and a Linux electron-updater feed
all returned HTTP 404 on 2026-09-29.

## What is inside the Windows installer (NSIS)

- Product version: **0.2.0-rc.2**
- Electron: **44.0.0**
- Bundled Node runtime: **24.18.1** (`resources/runtime/primary-runtime/runtime.json` says node 24.21.0)
- Bundled pnpm: **11.7.0**
- Bundled Harness runtime: `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2**,
  containing the full `@deepseek-ai/*` package set at 0.2.0-rc.2.
- Bundled LibreOffice kit and Python packages for the PPT/Office features.
- Update feed: `electron-updater`, generic provider
  `https://download.deepseek.com/dsh-desk/feeds/win-x64/`, channel `nightly`;
  `publisherName` is Hangzhou DeepSeek Artificial Intelligence Co., Ltd.
- `resources/runtime/bin/node` is a small POSIX shell wrapper that sets
  `ELECTRON_RUN_AS_NODE=1` and executes `$DSH_DESKTOP_NODE_EXECUTABLE --expose-internals` —
  i.e. the official desktop reuses the packaged Electron binary as its Node runtime.

## Architecture relevance to this project

- Official Desktop is the same fundamental model we chose for Linux:
  **Electron 44 shell + sandboxed renderer + bundled/managed DSH runtime + auto-update.**
  Our host uses Electron 44.4.5 (same major) and the official Web UI unchanged.
- Because there is no Linux feed or installer, there is currently no official Linux
  counterpart. This project remains a thin Linux host for the same official Web UI.
- Our v0.2 stability plan (single supervisor, UI/server lifecycle separation,
  internal known-good runtime fallback, bounded renderer/GPU recovery) mirrors the
  official desktop's bundled-runtime and recovery philosophy without forking the UI.
- If DeepSeek later ships an official Linux desktop (or the upstream `apps/desktop`
  Linux packaging matures), this host can be retired with no data migration:
  `~/.dsh` stays the source of truth and the official Web UI is already used here.
- Official Desktop's `render-process-gone` handling and update coordinator are useful
  reference implementations; no code was copied.
