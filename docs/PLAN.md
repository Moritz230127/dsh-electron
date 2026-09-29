# Team plan — DSH Electron v0.1

## Workstreams

| Task | Owner | Paths | Depends on |
|---|---|---|---|
| T1 runtime supervisor | teammate `runtime` | `src/main/runtime/**`, `test/runtime/**` | contract (ARCHITECTURE.md) |
| T2 Electron shell | teammate `shell` | `src/main/*.js`, `src/preload/**`, `src/renderer/**`, `test/shell/**` | contract |
| T3 packaging + integration | teammate `packaging` | `package.json`, `scripts/**`, `packaging/**`, `docs/BUILD.md`, `docs/MIGRATION.md` | contract |
| V1 independent verification | teammate `verifier` | `test/acceptance/**`, `verification/**` | T1, T2, T3 |
| Lead | lead | scaffold, contract, integration, acceptance, final answer | — |

## Lead decisions

- Plain CommonJS JavaScript, Node 26, Electron 44.4.5; no TypeScript/bundler for v0.1.
- Electron binary is installed via npm with `--foreground-scripts` and `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
- v0.1 owns the `dsh web` child process. Final user switchover is manual: stop/disable the old `dsh-web.service`, launch the app; rollback documented in `docs/MIGRATION.md`.
- Development/E2E must use temporary `DSH_HOME`; never the live `~/.dsh`.
- niri compositor exclusion rule is part of acceptance (`packaging/niri-window-rule.kdl`), applied manually by the user.

## Acceptance criteria

1. `npm test` passes: runtime URL parsing/exit semantics, health retry, GPU fallback planner, recovery reload policy, config resolution.
2. `npm run test:smoke` with a temp home writes a JSON snapshot proving the DSH UI loaded (`ok: true`, non-empty `title`/`bodyTextLength`) and exits cleanly.
3. `npm run package:dir` produces `dist/linux-unpacked/dsh-electron`; launching the unpacked binary with the temp home passes the same smoke hook.
4. Security invariants from ARCHITECTURE.md §3.5 reviewed by the verifier and covered by at least one unit test or explicit static check.
5. `docs/MIGRATION.md` gives exact, reversible switchover/rollback steps; no change is applied to the live system without the user's explicit go-ahead.
6. Report: Lead writes the final handoff with evidence, commands, and remaining risks.

## Lead environment evidence (2026-09-29)

- A fresh temporary `DSH_HOME` works without copying the user's live home: `DSH_HOME=/tmp/... dsh web --no-open --port 0` initialises the default web profile and prints the token line. Use this for smoke tests; never point tests at `~/.dsh`.
- Electron 44.4.5 launches on this Arch + niri + Wayland + NVIDIA 615 machine **without** `--no-sandbox` (probe window loaded, exit 0). Keep `--no-sandbox` only as a documented last-resort fallback.
- Probe app identity on Wayland followed the `package.json`/app directory name (`electron-hello`), so the packaged niri rule should match the real app-id from `niri msg windows`; expected `dsh-electron`.
- Electron npm install works with `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `--foreground-scripts`; the repo's `scripts/ensure-electron.js` covers npm 12 blocked postinstall.

## Risks / open questions

- Electron 44 + Wayland + NVIDIA 615: if the default GPU path glitches, the fallback ladder must be validated; the smoke test may need `--disable-gpu-sandbox` on this machine.
- Arch unprivileged user namespaces / `chrome-sandbox`: packaged app may need `--no-sandbox` as a last resort; document the tradeoff.
- App identity on Wayland: observed niri app-id `electron-hello` for a probe app, i.e. it follows `package.json` name. Final rule must match the packaged `dsh-electron` app-id; verify with `niri msg windows`.
- Running app and old systemd server simultaneously: two `dsh` processes sharing `~/.dsh` may contend. v0.1 avoids this by not running both; final switchover is manual.


## Final status (2026-09-29)

All tasks T1-T10 complete. Independent verification verdict: **ACCEPT** (T9).
Evidence: 148/148 tests, source smoke and packaged smoke 8/8, sandbox probe, asar freshness, live system untouched.
Accepted v0.1 residual risks and the manual switchover runbook are recorded in `docs/HANDOFF.md` and `docs/MIGRATION.md`.


## v0.2 execution (2026-09-29/30)

Tasks T11-T16 complete. Independent T14 verdict: **ACCEPT** (after T15/T16b freshness rebuild).
Highlights: single host supervisor + independent DSH/Electron children; internal known-good runtime fallback; attach-mode UI via URL file; systemd user unit; non-destructive install (`dsh-host` enabled-not-started, `dsh-web` disabled-not-stopped); final artifacts rebuilt and packed sources match repo.
Final status/evidence: `docs/V0.2-HANDOFF.md`, `verification/REPORT.md` Part II.
