# T4/T9/T14 — Independent verification report: DSH Electron v0.1 + v0.2

> Part I (v0.1, T4/T9) verdict remains ACCEPT. **Part II (v0.2, T14) verdict: ACCEPT after the T16b rebuild and the final E,P re-run (49/49). See Part II §II.0.**

Verifier: teammate `verifier` (adversarial role; no edits outside `test/acceptance/**`, `verification/**`).
Date: 2026-09-29 (Asia/Shanghai). Project: `/home/Arch/工作区/dsh-electron` (symlink `/home/Arch/Projects/dsh-electron`).
Task: **task-4** — independent verification + acceptance smoke + security review;
**task-9** — re-verification after T8 fixes (recovery budget + strict permissions).

## 0. Verdict

**ACCEPT.** The two blocking findings from T4 were fixed by T8 and independently re-verified by T9:

1. **Renderer recovery is bounded.** `src/main/recovery.js` gained the pure rolling-budget planner
   `planMainWindowRendererRecovery`; `src/main/main.js` no longer resets the recovery counters on
   `did-finish-load` (source-scan enforced), consumes one budget unit per performed reload, and
   surfaces `error.html` on budget exhaustion or cooldown denial. Driving the real `main.run()`
   through repeated success→crash cycles shows exactly 3 reloads, then the error page, and a fresh
   budget only after `> 60 s`. Tray Restart Harness / error-page Retry / Retry IPC remain explicit
   reset paths.
2. **Permission checks are strict.** `decidePermissionCheck` and `decidePermissionRequest` allow
   only an explicit `audio` signal from the runtime origin; `unknown`, absent, `video` and mixed
   audio+video are denied by both handlers.

All explicit acceptance criteria pass: `npm test` **148/148** (0 fail/skipped), source smoke and
freshly packaged smoke **8/8 checks**, sandbox probe, and no live-system modification. Remaining
items in §6.2 are low-severity residual risks/uncertainties, not contract violations; the Lead's
T8 change set scoped the fixes to the two blockers. If the Lead requires explicit sign-off on the
remaining residuals (subframe navigation coverage, requesting-origin fallback, unvalidated
`extraSwitches`, lexical path containment, Wayland/Vulkan warning), they are enumerated in §6.2
with their evidence.

---

## 1. Environment facts (reproduced, not trusted)

| Fact | Observed |
|---|---|
| OS / compositor | Arch Linux, niri 26.04 Wayland, NVIDIA 615.71.09 |
| Node / npm | v26.10.0 / 12.1.0 |
| Electron | 44.4.5; binary `/home/Arch/工作区/dsh-electron/node_modules/electron/dist/electron` |
| dsh | `/home/Arch/.npm-global/bin/dsh`, version `0.2.0-rc.2` |
| GUI env used | `XDG_RUNTIME_DIR=/run/user/1000`, `WAYLAND_DISPLAY=wayland-1`, `DISPLAY=:0`, `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=niri`, `NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock` |
| Sandbox | `kernel.unprivileged_userns_clone=1`; **Electron ran without `--no-sandbox`** for source and packaged smoke; packaged renderer cmdline contained `--enable-sandbox` and no `--no-sandbox` |
| Live baseline (read-only) | `dsh-web.service` active, enabled, `ExecMainPID=1102`, `ActiveEnterTimestamp=Tue 2026-09-29 22:31:51 CST` |
| Temporary probes | all used `fs.mkdtempSync(/tmp/...)`; no test pointed at `~/.dsh` or the live service |

Fresh-temp-home probe reproduced: `DSH_HOME=$(mktemp -d) dsh web --no-open --host 127.0.0.1 --port 0`
prints `dsh web: http://127.0.0.1:<port>/?token=<...>`.

---

## 2. Exact commands and observed results

### 2.1 `npm test` (existing + new adversarial tests)

```
cd /home/Arch/工作区/dsh-electron
timeout 300 npm test
```

Observed (final, `verification/npm-test-final.log`):

```
ℹ tests 138
ℹ suites 0
ℹ pass 138
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3189.973103
npm test exit=0
```

The pre-existing suite alone was also run first: `tests 100 / pass 100 / fail 0`
(`verification/npm-test.log`). No test hung; no test needed `timeout` inside the suite.
38 verifier tests were added (11 runtime, 10 security, 11 GPU/recovery/bootstrap,
5 live-write guards, 1 recovery-loop repro).

### 2.2 Acceptance smoke — source app (`npm run test:smoke`)

```
timeout 240 npm run test:smoke
```

Observed (`verification/test-smoke-script.log`), exit 0:

```
snapshot : {"ok":true,"title":"DeepSeek Harness","url":"http://127.0.0.1:46507/","readyState":"complete","bodyTextLength":337,"appRootFound":true}
exit     : {"code":0,"signal":null}
observed dsh env : [{"pid":163743,"cmdline":"node /home/Arch/.npm-global/bin/dsh web --no-open --host 127.0.0.1 --port 0"}]
dsh orphans by HOME: []
dsh orphans in pgid: []
spawned pid seen : 163743 (alive after exit=false)
check PASS snapshotWritten / ok / titleNonEmpty / readyStateComplete /
           bodyTextLengthPositive / appRootFound / cleanExit / noOrphans
SMOKE PASS
```

The runner (`test/acceptance/run-smoke.js` + `smoke-lib.js`) creates a `mkdtemp` tree, redirects
`HOME`, `XDG_CONFIG_HOME/CACHE/DATA`, `DSH_ELECTRON_HOME`, `DSH_ELECTRON_USER_DATA`, writes
`DSH_ELECTRON_SMOKE=<tmp>/snapshot.json`, launches the real app, waits for the JSON,
asserts the eight checks above, waits for clean self-exit, then checks:
child `DSH_HOME` env via `/proc/<pid>/environ`, process-group membership, the logged child PID
(`runtime: spawned ... (pid N)`), and no leftover temp dirs.

First driver run (`verification/smoke-source-1.log`) failed only my *driver's* broad pgid scan
(a transient re-parented Chromium zombie in the app's old process group, empty cmdline,
state `R`); the scanner was tightened to actual `dsh`/`DSH_HOME` matches. This was a verifier-side
false positive, not an app defect.

### 2.3 Acceptance smoke — packaged binary

```
timeout 240 node test/acceptance/run-smoke.js --packaged
```

Observed (`verification/smoke-packaged-final.log`), exit 0:

```
binary  : /home/Arch/工作区/dsh-electron/dist/linux-unpacked/dsh-electron
snapshot: {"ok":true,"title":"DeepSeek Harness","readyState":"complete","bodyTextLength":337,"appRootFound":true}
exit    : {"code":0,"signal":null}
SMOKE PASS (all 8 checks)
```

Packaged bundle freshness was checked independently (`@electron/asar`):

```
checked src files: 13  ["/src/main/config.js", ... "/src/renderer/loading.html"]
mismatches: none
```

(`package.json` inside the asar is intentionally transformed/enriched by electron-builder: 436 B packed
vs ~2.5 kB on disk — build scripts/devDependencies/build config are stripped, author/desktopName are rewritten.)

### 2.4 Renderer sandbox runtime probe

```
timeout 120 node test/acceptance/run-sandbox-probe.js
```

Observed (`verification/sandbox-probe.log`), exit 0:

```
observed : {"hasProcess":"undefined","hasRequire":"undefined","hasBuffer":"undefined",
            "hasGlobal":"undefined","hasDshShell":"object","dshShellKeys":["quit","retry"]}
check PASS noProcess / noRequire / noBuffer / dshShellExposed / onlyRetryQuit
SANDBOX PROBE PASS
```

This uses the production `buildWebPreferences()` from `src/main/window-manager.js` in a real
Electron process (temp HOME/XDG/userData) — runtime proof, not just static config assertions.

### 2.5 Wayland app-id (PLAN risk item)

A packaged instance with a temp profile was queried through niri:

```
NIRI_SOCKET=/run/user/1000/niri.wayland-1.1984.sock niri msg --json windows
=> app_id: "dsh-electron", title: "DeepSeek Harness"
```

The packaged renderer process command line included `--enable-sandbox` and
`--user-data-dir=<temp>/userdata` (isolation and sandbox confirmed). The long-running probe was
explicitly stopped afterwards; no probe process or `dsh` child remained.

### 2.6 T9 re-verification after T8 (2026-09-29 ~23:45-23:53)

```
timeout 300 npm test                                   # 148 pass / 0 fail, 0 skipped (t9-npm-test-final.log)
timeout 240 npm run test:smoke                         # SMOKE PASS 8/8 (t9-test-smoke.log)
timeout 240 node test/acceptance/run-smoke.js --packaged
                                                       # SMOKE PASS 8/8 (t9-smoke-packaged.log)
timeout 120 node test/acceptance/run-sandbox-probe.js  # SANDBOX PROBE PASS (t9-sandbox-probe.log)
timeout 180 node --test test/acceptance/recovery-loop-adversarial.test.js
                                                       # 4/4: rolling-budget matrix, bounded dynamic
                                                       # loop, window reset, Retry-IPC reset
```

Every real smoke observed `ok:true`, title `DeepSeek Harness`, `readyState:"complete"`,
`bodyTextLength:337`, `appRootFound:true`, exit code 0 and zero orphan `dsh` processes.
`dist/linux-unpacked/resources/app.asar` (mtime 2026-09-29 23:44:22, i.e. rebuilt after T8)
matches all 13 current `src/**` files byte-for-byte, so the packaged run exercised the T8 code.

T9 test changes (verifier scope only):
- `runtime-adversarial.test.js`: cooperative-child script now registers its SIGTERM handler
  *before* printing the ready line; this removes a test-side race that made `exit.code` flaky
  (observed exit signal instead of code 0). Implementation was not at fault.
- `recovery-loop-adversarial.test.js`: old “unbounded” repro replaced by 4 tests asserting the
  bounded behavior, rolling-window reset, source-level “no reset on did-finish-load”, and
  trusted/untrusted Retry IPC.
- `security-adversarial.test.js`: old coarse-permission boundary test replaced by a strict
  audio-only matrix (pure + installed check handler).

---

## 3. Acceptance criteria (docs/PLAN.md §Acceptance)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `npm test` passes (runtime/shell/config/GPU/recovery) | **PASS** | **148 pass / 0 fail / 0 skipped** (`verification/t9-npm-test-final.log`); pre-T9 baseline was 138/138 |
| 2 | `npm run test:smoke` temp home → `ok:true`, title/body, clean exit | **PASS** | 8/8 checks, T9 log (`verification/t9-test-smoke.log`) |
| 3 | `package:dir` produces `dist/linux-unpacked/dsh-electron`; unpacked binary passes same smoke | **PASS** | Packaging rebuilt `dist/` at 2026-09-29 23:44:22 (after T8); all 13 packaged `src/**` files byte-identical to the repo and the packaged smoke passed 8/8 (`verification/t9-smoke-packaged.log`). I did not run `package:dir` itself (write scope). |
|
| 4 | Security invariants §3.5 reviewed + at least one unit/static check | **PASS** | `security-adversarial.test.js` (10 tests) + runtime sandbox probe; T4 permission-check residual is fixed and covered by the strict matrix (§6.2) |
| 5 | `docs/MIGRATION.md` exact reversible switchover; no live change without go-ahead | **PASS** | Reviewed doc: stop/disable service, comment niri line, install launcher, backup+restore rollback steps; explicit “AGENTS: STOP … user runs manually”. No agent command was executed against the live system |
| 6 | Lead writes final handoff | Lead-owned; this report is verifier input | — |

---

## 4. Required verification item 3/4 — runtime semantics (independent)

Test file: `test/acceptance/runtime-adversarial.test.js` (11 tests). Real `node -e` children were
used for lifecycle, not only the injected fake-child seam.

| Boundary | Independent result |
|---|---|
| `parseReadyUrl` exact/whitespace/ANSI/CRLF/wrapped text | pass; ports 1 & 65535 accepted, 0/65536/leading sign rejected; only literal `127.0.0.1`, no userinfo/`localhost`/IPv6; `&`/`#` after token rejected; trailing punctuation stripped; multiple URLs → first wins; non-strings null |
| fatal vs expected exit | real child `exit(3)` before ready → `fatal` with code/logTail; real child ready then `exit(7)` → `exit expected=false`; `stop()` before ready → `exit expected=true`, no `fatal`; ready line without trailing newline is flushed and not lost |
| `stop()` SIGKILL escalation | real child ignoring SIGTERM: SIGTERM sent, after 250 ms real `SIGKILL` observed (`exit.signal==='SIGKILL'`), pid reaped, `<5 s` |
| health any-status / timeout | real 401 and 303 responses resolve; closed port with `timeoutMs=200` rejects `timed out` within the bound; negative/NaN options → TypeError; synchronously throwing request seam retried to timeout |

## 5. Required verification items 4/5/6 — security, GPU/lifecycle, live isolation

### 5.1 Security invariants (ARCHITECTURE.md §3.5, lines 164-167)

| Invariant | Status | Evidence |
|---|---|---|
| `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`, `webviewTag:false` | Enforced | `src/main/window-manager.js:141-152,166`; exact-key assertion; real probe shows no `process`/`require`/`Buffer`/`global` |
| Only one BrowserWindow, built with those prefs | Enforced | `src/main/main.js:311-332` (`ensureWindow`), `src/main/window-manager.js:155-168` |
| `will-navigate`: only runtime origin or `file://` under `src/renderer/`; http(s) else `shell.openExternal` | Enforced | `window-manager.js:215-223`; dynamic tests block https/other-port/userinfo-lookalike/file-outside/`%2e%2e`/`javascript:`/`data:`/`about:`/host file URLs; exact origin and loading/error pages allowed |
| `setWindowOpenHandler`: deny all, open http(s) external | Enforced | `window-manager.js:132-139,231`; dynamic matrix, including `file:`/`javascript:`/`{}` |
| `setPermissionRequestHandler`: `media` audio-only from runtime origin; deny default | Enforced | `window-manager.js:236-245`; audio=true, video/mixed/empty/absent mediaTypes=false, other origin=false, non-media=false |
| `will-attach-webview` prevented (defence in depth) | Enforced | `window-manager.js:225-227`; dynamic assertion |
| Harness URL loopback-only before load | Enforced | `main.js:727,812`; `isLoopbackUrl` matrix (127/8, localhost, ::1 yes; evil/lookalikes no) |
| IPC retry/quit only from local renderer pages | Enforced | `main.js:902-941` sender URL must satisfy `isRendererPageUrl`; static assertions |
| `DSH_ELECTRON_SMOKE` cannot bypass navigation | Enforced | Hook is post-load only (`main.js:410-440`, hook at 504-525); static scan shows hook has no `loadURL`/`loadFile`/`will-navigate`/`setWindowOpenHandler`; snapshot re-validates `ok` from `readyState`+`bodyTextLength` |
| `userData` override applied before lock/config | Enforced | `main.js:197-216`; dynamic bootstrap order assertion (`setPath < requestSingleInstanceLock < getPath`) |
| No Chrome/PWA profile sharing | No evidence found | Default userData confirmed as `~/.config/DSH Electron/` with temp `XDG_CONFIG_HOME`; no `--user-data-dir` pointing at Chrome/PWA paths in src |

### 5.2 GPU fallback / lifecycle (ARCHITECTURE.md §3.2-3.4)

Test file: `test/acceptance/gpu-adversarial.test.js` (11 tests), plus bootstrap drive of real
`main.run()` with a fake Electron object.

- Ladder switches by level, `isGpuLossFatal` clean/killed/exit-34 rules: pass.
- Never-rendered loss: immediate escalate, exactly one level per step, stops at bottom (≤3 planner steps per start level).
- Rendered loss: exactly 3 failures per level then escalate; bottom level stops; no relaunch ever at bottom; simulation always terminates.
- Stable launch: steps up on the 20th stable launch (19 existing + current), never above `default`; counter clamps; failures cleared.
- Persistence: `<userData>/gpu-fallback.json`, mode `0600`, atomic tmp+rename leaves no tmp file; corrupt/`__proto__`/bad-level files degrade to default without pollution.
- **Disable-before-ready proven dynamically**: persisted `gpu-disabled` → real `main.run()` appends
  `disable-gpu-sandbox`, `disable-gpu`, `disable-gpu-compositing`, calls
  `app.disableHardwareAcceleration()` **before `app.whenReady()`**; `sandbox-disabled` adds only
  `disable-gpu-sandbox`; `default` adds none; config `extraSwitches` apply after ladder switches.
- Bounded renderer policy (unit): cooldown + count cap + future-clock/garbage rejection.
- **T4 counterexample fixed and re-verified (T9)**: successful loads no longer refund the budget
  (`handleDidFinishLoad` does not touch `recovery.*`); the rolling planner bounds repeated
  success→crash cycles to exactly `maxReloads` reloads, surfaces `error.html` on exhaustion or
  cooldown denial, and grants a fresh budget only after `> windowMs` (60 s). Dynamic integration
  and unit matrix: `test/acceptance/recovery-loop-adversarial.test.js` (4 tests).

### 5.3 Live-system isolation (ARCHITECTURE.md §5)

Static guard: `test/acceptance/no-live-writes.test.js` (5 tests) scans executable code and confirms:
no `.config/systemd`, `dsh-web.service`, `systemctl`, `.config/niri`, `niri msg`, `pkill`/`killall`
in `src/**` + `scripts/**`; no fs write/mkdir/rename/unlink/rm taking `dshHome` or a literal `~/.dsh`
path; the only `.dsh` literals are the production defaults in `config.js`/`main.js`; the smoke
library redirects HOME/XDG/userData to `mkdtemp`; `package.json` scripts never touch systemd;
the niri snippet is not in the packaged payload.

Dynamic evidence after all tests:

| Observation | Value |
|---|---|
| `dsh-web.service` | still `active`, `ExecMainPID=1102`, `ActiveEnterTimestamp` unchanged 22:31:51 |
| Live `dsh web` processes | only PID 1102 (the service) |
| `~/.dsh` mtime | 2026-09-29 22:31:53 — before verification started; untouched |
| `~/.config/niri/config.kdl` mtime | 2026-09-23 18:37 — untouched |
| `~/.config/systemd/user/dsh-web.service` mtime | 2026-09-26 16:50 — untouched |
| Temp roots / orphan Electron or dsh children | none; all smoke runs clean up their `mkdtemp` root |
| Child `DSH_HOME` during smoke | temp path (`observedDuringRun` via `/proc/<pid>/environ`) |

---

## 6. Fixed findings, residual risks and uncertainties

### 6.1 FIXED (T8) — unbounded renderer reload loop after success-then-crash

*T4 finding:* `main.js` reset `recovery.reloadCount = 0` and `recovery.lastReloadAt = 0` on every
successful `did-finish-load`, refunding the 3-reload budget and neutralizing the 5 s cooldown;
a success→crash renderer could be reloaded without bound (`ARCHITECTURE.md:130` violated).

*T8 fix, verified by reading source and driving the real `main.run()`:*

- `src/main/recovery.js`: new pure `planMainWindowRendererRecovery({ now, lastReloadAt, reloadCount,
  cooldownMs: 5000, maxReloads: 3, windowMs: 60000 })`. A successful page load cannot refund the
  budget; `now - lastReloadAt > windowMs` expires the window and resets the count (`>`, so exactly
  60 000 ms is still inside the same window).
- `src/main/main.js`: `handleDidFinishLoad` no longer touches `recovery.*` (source-scan asserted);
  `handleRendererLoss` consumes one unit (`plan.reloadCount + 1`) and stamps `lastReloadAt` only
  when a reload is actually performed; budget exhaustion and cooldown denial load `error.html`;
  only tray Restart Harness, error-page Retry, and the corresponding IPC zero the counters.
- Evidence (`verification/t9-npm-test-final.log`, `t9-test-smoke.log`): `npm test` 148/148;
  dynamic run: 4 success→crash cycles produce exactly 3 reloads, `error.html` on the 4th, no
  further reload, then a fresh reload after a `> 60 s` clock jump; unit matrix covers the exact
  boundary, invalid input, count cap and cooldown.
- Residual nuance: cooldown denial also surfaces `error.html` ("Renderer recovery paused") and
  requires an explicit Retry/Restart; this is the intended T8 behavior and is asserted.

### 6.2 Residual risks / uncertainties (item 1 fixed in T8; items 2-6 remain open)

1. **FIXED (T8) — permission check is no longer over-permissive.** `window-manager.js:73-104,247-258`
   requires an explicit `audio` signal from the runtime origin for both check and request;
   `unknown`, absent, `video` and mixed audio+video are denied. Covered by the strict pure matrix
   and by invoking the installed `setPermissionCheckHandler`/`setPermissionRequestHandler`
   (`test/acceptance/security-adversarial.test.js`). Live `getUserMedia` in the real DSH renderer
   is still not exercised (see §7).
2. **Subframe navigation is not covered** — only `contents.on('will-navigate')` is installed
   (`window-manager.js:215`); it covers main-frame navigations. An iframe inside the harness could
   navigate to a remote origin and render there (no Node access thanks to sandbox; `webviewTag`
   is false). The contract names `will-navigate` only, so this may be intended, but "never load
   remote content into the main window" (§3.5:167) is not fully enforced for subframes.
   `will-frame-navigate` is not used. Not dynamically tested.
3. **Requesting-origin fallback** — `resolveRequestingOrigin` (`window-manager.js:170-182`) falls
   back to `webContents.getURL()` (top-level, runtime origin) if Electron omits
   `requestingUrl`/`securityOrigin`/`embeddingOrigin`. In Electron 44 `details.requestingUrl` is
   normally present; a subframe media request with missing details could be treated as same-origin.
   Not verified live.
4. **`extraSwitches` are unvalidated** — `config.js:45-49,210`, `main.js:121-135,138-152`.
   A local config file can append arbitrary Chromium switches before ready (including
   security-relevant ones such as `--disable-web-security`). Same-user local config is already
   trusted; still worth an allow-list if config can ever be influenced remotely.
5. **Lexical containment only** — `isPathInside` (`window-manager.js:32-38`) does not resolve
   symlinks; a symlink physically inside `src/renderer` pointing outside would be allowed. `src` is
   app-owned, so no practical attacker path found.
6. **Wayland/Vulkan warning** — stderr during smoke:
   `'--ozone-platform=wayland' is not compatible with Vulkan. Consider switching to '--ozone-platform=x11' or disabling Vulkan`.
   UI still loaded (`ok:true`) in source and packaged smoke, so no failure; the GPU fallback ladder
   was not triggered on this machine.

## 7. Explicitly NOT verified

- `npm run package:dir`/`package:linux` **run by me** and pacman/AppImage artifacts: not executed
  by the verifier (`dist`/packaging are outside the write scope). Packaging did rebuild
  `dist/linux-unpacked` at 2026-09-29 23:44:22 after T8; that fresh binary passed packaged smoke
  and all 13 packaged `src/**` files match the repo. Pacman/AppImage artifacts were not tested.
- A **real GPU-process crash** with the real `app.relaunch()` path: only simulated/fake-Electron
  tested (the machine's default GPU path loaded the UI after a Vulkan/Wayland warning).
- Real GPU-process crashes and the real `app.relaunch()` fallback across process restarts:
  policy/fake-Electron level only.
- Tray `Show`/`Restart Harness`/`Quit`, close-to-tray, second-instance focus and devtools:
  not exercised (smoke runs with `--no-tray`; no StatusNotifier integration test).
- Live `getUserMedia` / device permissions and iframe navigation in the real DSH renderer.
- Attach mode against a real external harness (only the fake-window recovery repro used attach mode
  with a local HTTP server).
- niri window-rule application/`niri validate` (manual user step; only app_id was verified).
- Audio output, long-run stability, memory/CPU, multi-monitor/HiDPI, suspend/resume.
- Windows/macOS (out of scope).
- No claim that the *live* `dsh-web.service` is internally quiescent; evidence only shows our code
  and tests did not modify it or `~/.dsh` (PID/mtime unchanged).

---

## 8. Top risks (ranked, post-T9)

1. **Subframes are outside the navigation allow-list** — remote framed content can render inside
   the sandboxed window (no Node access); low exploitability, contract ambiguity around
   "will-navigate" vs "never load remote content". (§6.2.2)
2. **Real GPU-process crash with the real relaunch path is untested** — policy and bootstrap are
   verified with fakes; the live machine showed only a Vulkan/Wayland warning on the default level.
   (§6.2.6, §7)
3. **Live permission/device behavior untested** — strict policy handlers and renderer sandbox are
   proven, but no real `getUserMedia` / `permissions.query` request was exercised in the DSH
   renderer. (§6.2.1, §7)
4. **Requesting-origin fallback** if Electron ever omits request details for a subframe media
   request; denied origin is the documented safe default, but the fallback branch is untested
   against Electron 44 internals. (§6.2.3)
5. **`extraSwitches`/config surface unvalidated** — local-user trust boundary only. (§6.2.4)
6. **Packaging beyond `dir` (pacman/AppImage) not verified**, and tray/close-to-tray behavior is
   untested on niri. (§7)

## 9. Verifier artifacts added (write scope respected)

```
test/acceptance/smoke-lib.js
test/acceptance/run-smoke.js
test/acceptance/runtime-adversarial.test.js       (11 tests; SIGTERM ordering race fixed in T9)
test/acceptance/security-adversarial.test.js      (10 tests; strict permission check as of T9)
test/acceptance/gpu-adversarial.test.js           (11 tests)
test/acceptance/no-live-writes.test.js            (5 tests)
test/acceptance/recovery-loop-adversarial.test.js (4 tests as of T9: bounded loop, window reset, retry IPC)
test/acceptance/sandbox-probe-main.js
test/acceptance/sandbox-probe-page.html
test/acceptance/run-sandbox-probe.js
verification/npm-test.log
verification/npm-test-final.log
verification/smoke-source-1.log   (driver false positive, superseded)
verification/smoke-source-2.log
verification/test-smoke-script.log
verification/smoke-packaged-1.log
verification/smoke-packaged-final.log
verification/sandbox-probe.log
verification/t9-npm-test-before.log   (T9 pre-update run; expected old-behavior failures)
verification/t9-npm-test-final.log    (T9 final: 148/148)
verification/t9-test-smoke.log
verification/t9-smoke-packaged.log
verification/t9-sandbox-probe.log
verification/REPORT.md            (this file, updated for T9)
```

No file under `src/**`, `package.json`, `docs/**` or `packaging/**` was modified by the verifier
(during T4 or T9).

---

# Part II — v0.2 host supervisor verification (T14, final after T16b)

Date: 2026-09-30 (Asia/Shanghai). Contract: `docs/GOAL.md`, `docs/ARCHITECTURE-V0.2.md`.
Artifacts: `test/acceptance/v02-e2e.js` (phases A-E, P), logs `verification/v02-*`.

## II.0 v0.2 verdict

**ACCEPT (v0.2).** Every v0.2 acceptance path passes; the single T14 packaging-freshness
blocker was fixed by the T16b rebuild (00:39) and re-verified:

- `npm test`: **207 pass / 0 fail / 0 skipped**.
- Real supervisor E2E (source + real DSH + real Electron): official UI DOM snapshot, UI-kill
  independence, DSH-kill restart + URL refresh + UI following, broken-runtime -> known-good
  fallback, bounded restart budget, clean SIGTERM with no orphans — all green (phases A-D).
- Packaged critical path on the T16b dist: `node test/acceptance/v02-e2e.js --phase=E,P`
  **49/49 PASS** — packaged attach UI snapshot `bodyTextLength:337`, packaged UI crash/restart,
  clean SIGTERM; managed packaged smoke PASS; all packed resources match source.
- Packed host supervisor is now byte-identical to `src/host/supervisor.js`
  (sha256 `fdb03142202a3d573eb7985257d65d7a4f7a755981ed8aa43e5dead0e5f9d9fc`); the old
  token-bearing status message is gone (phase E status observed
  `"Running from system runtime 0.2.0-rc.2"`).
- install-host.sh dry-run makes no changes; systemd unit/static checks pass.

## II.1 Commands and observed results

```
cd /home/Arch/工作区/dsh-electron

# FINAL run on the T16b dist (00:39):
timeout 280 node test/acceptance/v02-e2e.js --phase=E,P
# V02 E2E summary: 49/49 passed          log: verification/v02-e2e-EP-final.log

timeout 300 npm test
# exit 0; tests 207, pass 207, fail 0, skipped 0, todo 0, 5.58 s
# log: verification/v02-npm-test-final.log

timeout 240 node test/acceptance/v02-e2e.js --phase=A
# V02 E2E summary: 18/18 passed          log: verification/v02-e2e-phaseA.log

timeout 150 node test/acceptance/v02-e2e.js --phase=B,C
# V02 E2E summary: 34/34 passed          log: verification/v02-e2e-bc-green.log

node test/acceptance/v02-e2e.js --phase=D   (run inside the earlier B,C,D invocation)
# D: 6/6 passed                           log: verification/v02-e2e-source-bcd.log

timeout 180 node test/acceptance/v02-e2e.js --phase=E
# V02 E2E summary: 19/19 passed          log: verification/v02-e2e-phaseE.log  (pre-T16b)

timeout 240 node test/acceptance/v02-e2e.js --phase=P
# pre-T16b: 29/30 (only P.resource.src_host_supervisor.js failed, see II.3 history)
# final E,P above: 49/49; log: verification/v02-e2e-phaseP.log (historical)

timeout 180 node test/acceptance/run-smoke.js --packaged --timeout=60000 --exit-timeout=30000
# SMOKE PASS (8/8 checks, packaged managed mode on fresh dist)
# log: verification/v02-packaged-managed-final.log
```

Environment for all E2E: real DSH `0.2.0-rc.2` at `/home/Arch/.npm-global/bin/dsh`, Electron
44.4.5, niri/Wayland + NVIDIA; every run used `mkdtemp` HOME/XDG/DSH_HOME/DSH_HOST_STATE_DIR and
never the live `~/.dsh` or `dsh-web.service`.

## II.2 Required functional checks (all PASS)

| # | Check | Evidence |
|---|---|---|
| 1 | Real DSH starts, URL file appears (0600), Electron attach UI loads official UI | Phase A: snapshot `{ok:true,title:"DeepSeek Harness",readyState:"complete",bodyTextLength:337,appRootFound:true}`; URL file `http://127.0.0.1:<ephemeral>/?token=…` mode `0600`; status `{state:running,runtimeSource:system}` mode `0600`; HTTP 303 |
| 2 | UI exit/crash leaves DSH alive and serving; supervisor restarts UI | Phase A: intentional smoke UI exit -> DSH pid alive; Phase B/E: `kill -9` UI -> same DSH pid serving; new packaged/source UI child within budget and reloads (`E.packagedUiRestarted`, `B.uiRestarted`) |
| 3 | DSH kill restarts DSH, refreshes URL, UI follows without restart | Phase B: old/new DSH pids differ; URL port 42019 -> 35785; same UI pid alive; UI log sequence `attach URL file missing` -> `attach URL found` -> `harness UI loaded` for the new URL; external HTTP on new URL 303 (`B.uiFollowedNewUrl`) |
| 4 | Broken system runtime -> known-good fallback and UI still loads | Phase C: broken fake `@deepseek-ai/dsh@9.9.9` attempted (`broken-attempts.log`), fallback runtime `1.0.0` serves `Known Good UI`; snapshot `ok:true`, `bodyTextLength:67`; status `{state:"fallback",runtimeSource:"known-good",dshVersion:"1.0.0"}`; `attempt.json` records failure; only one DSH |
| 5 | No orphan dsh/electron after supervisor SIGTERM | Phases A, B, C, D, E: supervisor exit code 0; URL file removed (A/E); no DSH child and no descendants (`*/noOrphans`) |
| 6 | Bounded restart budget, no tight loop | Phase D: permanently broken runtime spawns exactly 3 times (maxChildRestarts=2) then status `error` and 60 s retry; count stays 3 after +4 s; unit tests cover window/backoff exhaustion |
| 7 | Attach mode does not spawn a second DSH | `dshChildren()` == 1 in phases A, B, C, E; UI is a direct child with `--attach-url-file=…` and no `dsh web` child of its own |
| 8 | URL/status files 0600; state dirs 0700 | `A.urlFile.mode0600`, `A.status.mode0600`, `C.urlFile0600`, `E.urlFile0600`; `_ensureDirectories` chmod 0700 unit-tested/static |
| 9 | Known-good fallback cannot bypass live home | Child `DSH_HOME` observed as the temp dir in phases A/B/C/E (`dshChildren` filter); fake known-good wrote its env/marker only under the temp DSH_HOME (`C.knownGoodMarker`); supervisor static scan has no fs write taking `dshHome` |
| 10 | systemd unit ordering/restart/conflicts | `P.unit.*`: `Conflicts=dsh-web.service`, `Restart=always`, `RestartSec=3`, `After/PartOf=graphical-session.target`, `WantedBy=default.target`, `StartLimitIntervalSec=0`, ExecStart supervisor |
| 11 | install-host.sh dry-run makes no changes | `P.installDryRun.noFilesCreated`, `P.installDryRun.noSystemctl`, exit 0; dry-run output is plan-only; no `systemctl start/stop/restart` code lines (`P.install.noSystemctlStartStop`) |
| 12 | Packaging contains supervisor + service + launcher + runtime | `P.asar.mainFallbackLoader`; resources `host/config.js`, `main/runtime/*.js`, `scripts/run-dsh-host.js`, `dsh-host.service` all match source; pacman + AppImage artifacts exist |
| 13 | T15 packaged runtime resolver works in both modes | Managed packaged smoke **PASS**; packaged attach phase E **19/19**; asar contains `loadRuntimeModule()` and resources-path fallback; `resources/main/runtime/*` present |
| 14 | Dev-Electron app-path fix | `resolveElectronLaunch` with raw `electron` + `DSH_HOST_DEV_APP=1` returns args `[<app root>]` in source; phase A/B UI cmdline contained the app root (`B.uiHasAppArg`); config `electronAppPath` is present in current source |

## II.3 FIXED (T16b) — packed host supervisor freshness / token-bearing status message

- T14 blocker: `dist` was built 00:28 while `src/host/supervisor.js` changed 00:34; the packed
  line 801 was ``_setStatus(..., `${source} runtime … ready at ${url}`)``, i.e. the ready URL
  **including the auth token** was written into `status.json.message` (0600) and polled by the UI.
- T16b rebuild (00:39) makes `dist/linux-unpacked/resources/host/supervisor.js` byte-identical to
  `src/host/supervisor.js` (both sha256
  `fdb03142202a3d573eb7985257d65d7a4f7a755981ed8aa43e5dead0e5f9d9fc`); packed line 801 is now
  `this._setStatus(state, this._runtimeStatusMessage(record))` and the token-bearing form is
  absent (grep count 0). `resources/host/config.js` also matches source.
- Final artifact hashes: `app.asar 0ea97f8830bf0e884f7cc3cbacb43edbcd4caf6935215b79e626fee62cb84e41`
  (00:39:01), unpacked `dsh-electron ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97`,
  pacman `1812e16b87ad1534e4a41aaffb138187e297b2637fdf6b09a5a7cac4faa0f79c` (00:39:20),
  AppImage `5ff6ba73d4732b1feb944070392804c7762d3d9c764e0046ab30312bcba81d6d` (00:39:06).
- Final `--phase=E,P` run: **49/49 PASS** (`verification/v02-e2e-EP-final.log`); phase E status
  message observed as `"Running from system runtime 0.2.0-rc.2"`; phase P includes packaged
  managed smoke PASS and all resource comparisons.

## II.4 Counterexamples / uncertainties / not verified

1. **FIXED (T16b) — packed supervisor freshness / token in status message** (II.3). Packed
   supervisor now matches source; phase E,P re-run 49/49.
2. **Lead confirmed intentional:** `~/.config/niri/config.kdl` was edited by the Lead via
   `install-host.sh --deploy --dev` (backup exists; `dsh-host.service` enabled-not-started,
   `dsh-web.service` disabled-not-stopped), and `~/.dsh` mtime changes are the live running
   session. Live `dsh-web.service` is still PID 1102, `ActiveEnterTimestamp 22:31:51`; no verifier
   test writes either path (all E2E state is mkdtemp, dry-run uses temp HOME/XDG).
3. `install-host.sh --deploy`/`--rollback` were **not executed** (would write real user units /
   niri config); only dry-run + static inspection were verified. `systemctl enable/disable` were
   never invoked.
4. AppImage contents were not extracted; only its timestamp (post-T16b, 00:39:06) and existence were checked.
5. Snapshot promotion with the real `cp -a --reflink=auto` path was not exercised against the real
   ~495 MB DSH runtime (`DSH_HOST_DISABLE_SNAPSHOT=1` in E2E); promotion/copy/prune is covered by
   unit tests with injected fs/spawn only.
6. Real GPU/renderer crash recovery, tray menus, close-to-tray, multi-monitor, suspend/resume and
   long-run stability are not exercised in v0.2 E2E.
7. systemd starts on next login were not tested (would affect the live session).
8. The known-good fast path across supervisor restarts (attempt.json + fallbackRetrySystemAfterMs)
   is unit-tested; E2E only exercised the first fallback in one supervisor run.

## II.5 v0.2 top risks (post-T14 final)

1. **Switchover timing** — `dsh-host.service` is enabled-not-started and `dsh-web.service` is
   disabled-not-stopped; the old server still runs as PID 1102 until the user approves the final
   start/next login. Ensure exactly one server runs with `~/.dsh` after switchover.
2. **Installer deploy/rollback** — the Lead executed `install-host.sh --deploy --dev`; rollback was
   not exercised end-to-end by the verifier (only dry-run + static + observed state/backups).
3. **Real snapshot promotion / crash recovery** — promotion uses real `cp -a` only on the 495 MB
   DSH runtime after 15 s stable; E2E disabled snapshots, so copy/prune/health-fallback is
   unit-simulated, not field-tested.
4. **AppImage and session-level behaviors** — AppImage contents were not extracted; tray menus,
   close-to-tray, login-time systemd start, GPU crashes, multi-monitor and long-run stability were
   not exercised in v0.2 E2E.
