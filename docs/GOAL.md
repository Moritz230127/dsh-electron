# Goal — DSH stable WebUI hosting platform (Linux)

## One-sentence goal

Provide a **zero-maintenance, self-healing Linux host for the official DSH Web UI**: install/configure once, the official UI stays untouched, the platform silently follows DSH updates, falls back internally when a preview version is broken, and never requires the user to run commands, choose versions, or manage rollbacks.

## User-visible contract

- One platform, starts automatically at login.
- Official DSH Web UI loaded unmodified.
- No version picker, no `check:*` command, no manual rollback, no per-update user action.
- If the UI or DSH process crashes, the platform recovers automatically.
- If a newly installed DSH version fails, the platform automatically runs the last known-good DSH runtime against the same `~/.dsh` and keeps the UI usable.
- The only user-facing recovery is a tray/menu action if the platform itself is completely stuck; normal use requires none.

## Engineering invariants

1. **Official WebUI untouched** — no frontend patches, no injected scripts, no modified DSH assets.
2. **Lifecycle separation** — DSH server and Electron UI are independent children of one supervisor. UI restart must not interrupt DSH tasks; DSH restart must not kill the UI.
3. **External supervision** — a systemd user service restarts the supervisor; the supervisor restarts its children.
4. **Bounded recovery** — no infinite reload/restart loop; each restart class has a windowed budget and backoff.
5. **Internal known-good runtime fallback** — a successful DSH runtime is snapshotted locally; a failed new version falls back automatically; the user never sees it.
6. **No destructive data management** — `~/.dsh` remains the source of truth; the platform never moves, rewrites, or restores it.
7. **Small compatibility surface** — the platform only depends on `dsh web` CLI flags, its ready-URL line, URL-file handoff and the official HTTP/WebSocket UI.

## v0.2 acceptance

- `npm test` green, including new supervisor/fallback/attach tests.
- A real end-to-end smoke with a temporary `DSH_HOME` proves: supervisor starts DSH -> writes URL file -> launches Electron in attach mode -> official UI loads -> UI crash does not kill DSH -> DSH crash is restarted by supervisor.
- Known-good fallback: fake a broken system runtime, prove the supervisor automatically starts the previously snapshotted runtime and keeps serving the UI.
- systemd unit + autostart validated statically and enabled non-disruptively; the currently running `dsh-web.service` is left untouched until the user's next login.
- Independent verifier verdict ACCEPT for the above.
