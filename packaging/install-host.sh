#!/usr/bin/env bash
# install-host.sh — non-destructive user-level installer for dsh-host.service (v0.2).
#
# Default mode is --dry-run: it prints the plan and touches nothing.
#   --deploy    install the unit, daemon-reload, enable dsh-host (NOT start it),
#               disable dsh-web (NOT stop it), back up + edit niri config.
#   --rollback  restore the previous deployment from the install manifest.
#
# No sudo, no root. systemctl is only called in --deploy / --rollback modes.
# --skip-systemctl is a test/CI-only switch that skips every systemctl call.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/packaging/dsh-host.service"
WINDOW_RULE="$REPO_ROOT/packaging/niri-window-rule.kdl"

HOME_DIR="${HOME:?HOME must be set}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME_DIR/.local/state}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_PATH="$UNIT_DIR/dsh-host.service"
NIRI_CONFIG="$CONFIG_HOME/niri/config.kdl"
STATE_ROOT="$STATE_HOME/dsh-host"
MANIFEST="$STATE_ROOT/install-manifest.env"
BACKUP_ROOT="$STATE_ROOT/install-backups"

ACTION="deploy"
EXECUTE=0
APP_ROOT=""
FORCE_DEV=0
SKIP_NIRI=0
SKIP_SYSTEMCTL=0

log()  { printf '[install-host] %s\n' "$*"; }
warn() { printf '[install-host] WARNING: %s\n' "$*" >&2; }
die()  { printf '[install-host] ERROR: %s\n' "$*" >&2; exit 1; }
is_executing() { [ "$EXECUTE" -eq 1 ]; }
plan() { printf '  [dry-run] %s\n' "$*"; }

# Read one field from an existing manifest without leaking its variables into
# this shell. Values are written with printf %q, so sourcing is lossless.
read_manifest_field() {
  [ -f "$MANIFEST" ] || return 0
  (
    set +u
    # shellcheck disable=SC1090
    . "$MANIFEST" 2>/dev/null || exit 0
    eval "printf '%s' \"\${$1:-}\""
  )
}

usage() {
  cat <<'EOF'
Usage: install-host.sh [--dry-run] [--deploy] [--rollback] [options]

Modes (default: --dry-run):
  --dry-run            print the plan and change nothing (default)
  --deploy             apply the user-level install
  --rollback           undo the last --deploy using its install manifest

Options:
  --app-root=<dir>     app root (packaged: <dir>/resources/host/supervisor.js,
                       dev: <dir>/src/host/supervisor.js)
  --dev                force the dev layout (repo checkout + scripts/run-dsh-host.js)
  --skip-niri          do not back up/edit the niri config
  --skip-systemctl     test/CI only: skip every systemctl call
  -h, --help           this help

What --deploy does (user-level, no sudo):
  * installs the rendered unit into $XDG_CONFIG_HOME/systemd/user/dsh-host.service
  * systemctl --user daemon-reload
  * enables dsh-host.service (does NOT start it)
  * disables dsh-web.service (does NOT stop it)
  * backs up and edits $XDG_CONFIG_HOME/niri/config.kdl:
      - comments old DSH/PWA spawn-at-startup / spawn-sh-at-startup lines
        with a '// dsh-host-disabled: ...' marker (idempotent)
      - appends packaging/niri-window-rule.kdl if the app-id rule is missing
      - validates with `niri validate` when niri is available

Starting dsh-host.service is a separate, user-approved action: its
Conflicts=dsh-web.service stops the currently running dsh-web service.
EOF
}

run_cmd() {
  if is_executing; then
    "$@"
  else
    plan "$(printf '%q ' "$@")"
  fi
}

run_systemctl() {
  if [ "$SKIP_SYSTEMCTL" -eq 1 ]; then
    printf '  [skip-systemctl] systemctl --user %s\n' "$*"
    return 0
  fi
  run_cmd systemctl --user "$@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) EXECUTE=0 ;;
    --deploy) ACTION="deploy"; EXECUTE=1 ;;
    --rollback) ACTION="rollback"; EXECUTE=1 ;;
    --dev) FORCE_DEV=1 ;;
    --skip-niri) SKIP_NIRI=1 ;;
    --skip-systemctl) SKIP_SYSTEMCTL=1 ;;
    --app-root) shift; [ $# -gt 0 ] || die "--app-root needs a value"; APP_ROOT="$1" ;;
    --app-root=*) APP_ROOT="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

resolve_layout() {
  local root="${APP_ROOT:-}"
  if [ -z "$root" ]; then
    if [ -f "/opt/DSH Electron/resources/host/supervisor.js" ]; then
      root="/opt/DSH Electron"
    elif [ -f "$REPO_ROOT/src/host/supervisor.js" ]; then
      root="$REPO_ROOT"
    else
      die "cannot find a host app root (pass --app-root=<dir>); T11/T12 must land before installing"
    fi
  fi
  [ -d "$root" ] || die "app root is not a directory: $root"
  APP_ROOT="$(cd "$root" && pwd)"

  if [ "$FORCE_DEV" -eq 1 ]; then
    LAYOUT="dev"
    SUPERVISOR="$APP_ROOT/src/host/supervisor.js"
    LAUNCHER="$APP_ROOT/scripts/run-dsh-host.js"
    [ -f "$SUPERVISOR" ] || die "dev supervisor not found: $SUPERVISOR"
    [ -f "$LAUNCHER" ] || die "dev launcher not found: $LAUNCHER"
    EXEC_START="/usr/bin/node \"$LAUNCHER\""
  elif [ -f "$APP_ROOT/resources/host/supervisor.js" ]; then
    LAYOUT="packaged"
    SUPERVISOR="$APP_ROOT/resources/host/supervisor.js"
    EXEC_START="/usr/bin/node \"$SUPERVISOR\""
  elif [ -f "$APP_ROOT/src/host/supervisor.js" ]; then
    LAYOUT="dev"
    SUPERVISOR="$APP_ROOT/src/host/supervisor.js"
    LAUNCHER="$APP_ROOT/scripts/run-dsh-host.js"
    [ -f "$LAUNCHER" ] || die "dev launcher not found: $LAUNCHER"
    EXEC_START="/usr/bin/node \"$LAUNCHER\""
  else
    die "no supervisor found under $APP_ROOT (looked for resources/host/supervisor.js and src/host/supervisor.js)"
  fi

  [ -x /usr/bin/node ] || die "/usr/bin/node is required by the unit"
  [ -f "$TEMPLATE" ] || die "unit template not found: $TEMPLATE"
}

render_unit() {
  local env_lines
  env_lines="Environment=\"DSH_HOST_APP_ROOT=$APP_ROOT\""$'\n'
  if [ "$LAYOUT" = "dev" ]; then
    env_lines="${env_lines}Environment=DSH_HOST_DEV_APP=1"$'\n'
  elif [ -x "$APP_ROOT/dsh-electron" ]; then
    env_lines="${env_lines}Environment=\"DSH_HOST_ELECTRON=$APP_ROOT/dsh-electron\""$'\n'
  fi
  awk -v exec_start="$EXEC_START" -v env_lines="$env_lines" -v layout="$LAYOUT" '
    /^\[Service\]/ {
      print;
      print "# --- rendered by packaging/install-host.sh (" layout ") ---";
      print "ExecStart=" exec_start;
      printf "%s", env_lines;
      next;
    }
    /^ExecStart=/ { next }
    { print }
  ' "$TEMPLATE"
}

apply_niri() {
  if [ ! -f "$NIRI_CONFIG" ]; then
    warn "no niri config at $NIRI_CONFIG; skipping startup-line and window-rule edits"
    return 0
  fi

  local matches
  matches="$(grep -nE '^[[:space:]]*spawn(-sh)?-at-startup.*(dsh|DeepSeek|hgiemfgfjhalibdoboikeiepnnjapnpc)' "$NIRI_CONFIG" | grep -vE '^[0-9]+:[[:space:]]*//' || true)"
  log "niri startup lines matching old DSH/PWA (spawn(-sh)?-at-startup):"
  if [ -n "$matches" ]; then printf '%s\n' "$matches" | sed 's/^/    /'; else log "    (none)"; fi

  local has_rule=0
  if grep -q 'dsh-electron' "$NIRI_CONFIG"; then has_rule=1; fi

  if is_executing; then
    if [ -z "${NIRI_BACKUP:-}" ]; then
      mkdir -p "$BACKUP_DIR"
      NIRI_BACKUP="$BACKUP_DIR/niri-config.kdl"
      cp -a "$NIRI_CONFIG" "$NIRI_BACKUP"
      log "backed up niri config to $NIRI_BACKUP"
    else
      log "keeping original niri backup for rollback: $NIRI_BACKUP"
    fi

    local tmp
    # Validate in a sibling temp file so niri resolves relative `include`
    # paths against the real config directory, then atomically install it.
    tmp="${NIRI_CONFIG}.dsh-host-tmp.$$"
    awk '
      {
        raw = $0
        trimmed = raw
        sub(/^[ \t]+/, "", trimmed)
        if (trimmed !~ /^\/\// && raw ~ /spawn(-sh)?-at-startup/ && raw ~ /(dsh|DeepSeek|hgiemfgfjhalibdoboikeiepnnjapnpc)/) {
          print "// dsh-host-disabled: " raw
          next
        }
        print raw
      }
    ' "$NIRI_CONFIG" > "$tmp"
    if [ "$has_rule" -eq 0 ]; then
      {
        printf '\n// >>> dsh-host install-host.sh: DSH Electron window rule (v0.2) >>>\n'
        cat "$WINDOW_RULE"
        printf '// <<< dsh-electron install-host.sh window rule <<<\n'
      } >> "$tmp"
    fi

    if cmp -s "$tmp" "$NIRI_CONFIG"; then
      rm -f "$tmp"
      log "niri config already up to date; no changes made"
    else
      if command -v niri >/dev/null 2>&1; then
        if ! niri validate -c "$tmp" >/dev/null 2>&1; then
          rm -f "$tmp"
          die "niri validate rejected the edited config; original untouched (backup: $NIRI_BACKUP)"
        fi
      else
        warn "niri not installed; editing config without validation (backup: $NIRI_BACKUP)"
      fi
      install -m 0644 "$tmp" "$NIRI_CONFIG"
      rm -f "$tmp"
      NIRI_TOUCHED=1
      log "niri config updated and validated: $NIRI_CONFIG (backup: $NIRI_BACKUP)"
    fi
  else
    NIRI_BACKUP="${NIRI_BACKUP:-$BACKUP_DIR/niri-config.kdl}"
    plan "cp -a $NIRI_CONFIG $NIRI_BACKUP   # keep the original backup on redeploy"
    if [ "$has_rule" -eq 1 ]; then
      plan "keep existing dsh-electron window rule (already present)"
    else
      plan "append packaging/niri-window-rule.kdl window rule"
    fi
    plan "comment spawn-at-startup / spawn-sh-at-startup lines with a '// dsh-host-disabled: ...' marker (idempotent)"
    if command -v niri >/dev/null 2>&1; then plan "niri validate -c <edited config>"; else plan "niri not installed; validation would be skipped"; fi
  fi
}

write_manifest() {
  mkdir -p "$STATE_ROOT"
  chmod 700 "$STATE_ROOT" 2>/dev/null || true
  local tmp="$MANIFEST.$$"
  {
    printf 'M_SERVICE=%q\n' 'dsh-host.service'
    printf 'M_DEPLOYED_AT=%q\n' "$(date -Is)"
    printf 'M_LAYOUT=%q\n' "$LAYOUT"
    printf 'M_APP_ROOT=%q\n' "$APP_ROOT"
    printf 'M_EXEC_START=%q\n' "$EXEC_START"
    printf 'M_UNIT_PATH=%q\n' "$UNIT_PATH"
    printf 'M_UNIT_PREEXISTING=%q\n' "${UNIT_PREEXISTING:-0}"
    printf 'M_UNIT_BACKUP=%q\n' "${UNIT_BACKUP:-}"
    printf 'M_NIRI_CONFIG=%q\n' "$NIRI_CONFIG"
    printf 'M_NIRI_BACKUP=%q\n' "${NIRI_BACKUP:-}"
    printf 'M_NIRI_TOUCHED=%q\n' "${NIRI_TOUCHED:-0}"
    printf 'M_DSH_WEB_WAS_ENABLED=%q\n' "${DSH_WEB_WAS_ENABLED:-unknown}"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$MANIFEST"
}

print_summary() {
  cat <<EOF

[install-host] deployment $(if is_executing; then echo applied; else echo 'plan only (dry-run)'; fi)
  unit:          $UNIT_PATH
  ExecStart:     $EXEC_START
  backup dir:    $BACKUP_DIR
  dsh-host:      enabled, NOT started
  dsh-web:       disabled, NOT stopped
  niri config:   $([ "${NIRI_TOUCHED:-0}" = 1 ] && echo "edited (backup ${NIRI_BACKUP:-?})" || echo "not touched")

NEXT STEPS (user-approved only):
  * Nothing has been started now. On the next login dsh-host.service starts
    automatically (WantedBy=default.target).
  * To switch immediately: systemctl --user start dsh-host.service
    WARNING: Conflicts=dsh-web.service means this STOPS the currently running
    dsh-web service (the old session) immediately.
  * Rollback: packaging/install-host.sh --rollback
EOF
}

deploy() {
  resolve_layout
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUP_ROOT/$ts"
  UNIT_PREEXISTING=0
  UNIT_BACKUP=""
  NIRI_BACKUP=""
  NIRI_TOUCHED=0
  DSH_WEB_WAS_ENABLED=""

  log "mode: $(if is_executing; then echo deploy; else echo dry-run; fi)"
  log "layout=$LAYOUT app_root=$APP_ROOT"
  log "ExecStart=$EXEC_START"
  if [ "$SKIP_SYSTEMCTL" -eq 1 ]; then warn "--skip-systemctl is set: systemctl calls will not run"; fi

  # Idempotent redeploy: carry the ORIGINAL rollback state forward instead of
  # snapshotting our own installed unit / already-edited niri config.
  PREV_MANIFEST_EXISTS=0
  PREV_NIRI_BACKUP=""
  PREV_NIRI_TOUCHED=""
  PREV_UNIT_PREEXISTING=""
  PREV_UNIT_BACKUP=""
  PREV_DSH_WEB_WAS_ENABLED=""
  if [ -f "$MANIFEST" ]; then
    PREV_MANIFEST_EXISTS=1
    PREV_NIRI_BACKUP="$(read_manifest_field M_NIRI_BACKUP)"
    PREV_NIRI_TOUCHED="$(read_manifest_field M_NIRI_TOUCHED)"
    PREV_UNIT_PREEXISTING="$(read_manifest_field M_UNIT_PREEXISTING)"
    PREV_UNIT_BACKUP="$(read_manifest_field M_UNIT_BACKUP)"
    PREV_DSH_WEB_WAS_ENABLED="$(read_manifest_field M_DSH_WEB_WAS_ENABLED)"
    if is_executing; then
      mv "$MANIFEST" "$MANIFEST.prev-$(date +%Y%m%d-%H%M%S)"
      warn "existing manifest moved aside; previous rollback point preserved"
    else
      plan "move existing manifest aside (previous rollback point preserved)"
    fi
  fi

  if [ "$PREV_MANIFEST_EXISTS" -eq 1 ] && [ "${PREV_NIRI_TOUCHED:-0}" = 1 ] && [ -n "$PREV_NIRI_BACKUP" ] && [ -f "$PREV_NIRI_BACKUP" ]; then
    NIRI_BACKUP="$PREV_NIRI_BACKUP"
    NIRI_TOUCHED=1
    log "redeploy: keeping original niri backup for rollback: $NIRI_BACKUP"
  fi

  if [ "$PREV_MANIFEST_EXISTS" -eq 1 ]; then
    if [ "${PREV_UNIT_PREEXISTING:-0}" = 1 ] && [ -n "$PREV_UNIT_BACKUP" ] && [ -f "$PREV_UNIT_BACKUP" ]; then
      UNIT_PREEXISTING=1
      UNIT_BACKUP="$PREV_UNIT_BACKUP"
      log "redeploy: keeping original unit backup for rollback: $UNIT_BACKUP"
    else
      log "redeploy: original deployment had no pre-existing unit; rollback will remove it"
    fi
  elif [ -f "$UNIT_PATH" ]; then
    UNIT_PREEXISTING=1
    UNIT_BACKUP="$BACKUP_DIR/dsh-host.service"
    if is_executing; then
      mkdir -p "$BACKUP_DIR"
      cp -a "$UNIT_PATH" "$UNIT_BACKUP"
      log "backed up existing unit to $UNIT_BACKUP"
    else
      plan "mkdir -p $BACKUP_DIR && cp -a $UNIT_PATH $UNIT_BACKUP"
    fi
  fi

  if is_executing; then
    mkdir -p "$UNIT_DIR"
    local tmp
    tmp="$(mktemp)"
    render_unit > "$tmp"
    install -m 0644 "$tmp" "$UNIT_PATH"
    rm -f "$tmp"
    log "installed unit: $UNIT_PATH"
  else
    plan "install -Dm644 <rendered unit> $UNIT_PATH"
    printf '%s\n' "----- rendered unit preview -----"
    render_unit | sed 's/^/    /'
    printf '%s\n' "----- end preview -----"
  fi

  if is_executing; then
    # Checkpoint: if a later step fails, rollback still has a manifest to use.
    write_manifest
    log "install manifest checkpoint written: $MANIFEST"
  fi

  run_systemctl daemon-reload
  run_systemctl enable dsh-host.service

  if is_executing && [ "$SKIP_SYSTEMCTL" -eq 0 ]; then
    DSH_WEB_WAS_ENABLED="$(systemctl --user is-enabled dsh-web.service 2>/dev/null || true)"
  fi
  if [ "$PREV_MANIFEST_EXISTS" -eq 1 ] && { [ "${PREV_DSH_WEB_WAS_ENABLED:-}" = "enabled" ] || [ "${PREV_DSH_WEB_WAS_ENABLED:-}" = "enabled-runtime" ]; }; then
    DSH_WEB_WAS_ENABLED="$PREV_DSH_WEB_WAS_ENABLED"
    log "redeploy: carrying forward original dsh-web enabled state for rollback: $DSH_WEB_WAS_ENABLED"
  fi
  if [ -n "$DSH_WEB_WAS_ENABLED" ]; then
    log "dsh-web.service current enabled state: $DSH_WEB_WAS_ENABLED"
    if [ "$DSH_WEB_WAS_ENABLED" = "enabled" ] || [ "$DSH_WEB_WAS_ENABLED" = "enabled-runtime" ]; then
      run_systemctl disable dsh-web.service
    else
      log "dsh-web.service is not enabled; leaving it alone (it is never stopped)"
    fi
  elif [ "$SKIP_SYSTEMCTL" -eq 1 ]; then
    warn "skipped: recording dsh-web enabled state and disabling it (test mode)"
  else
    plan "systemctl --user is-enabled dsh-web.service   # record state for rollback"
    plan "systemctl --user disable dsh-web.service      # only if currently enabled; never stopped"
  fi

  if [ "$SKIP_NIRI" -eq 1 ]; then
    log "niri edits skipped (--skip-niri)"
  else
    apply_niri
  fi

  if is_executing; then
    write_manifest
    log "install manifest written: $MANIFEST"
  else
    plan "write install manifest: $MANIFEST"
  fi

  print_summary
}

# Restore the niri config from the manifest backup and remove exactly the
# comments this installer added (marker: '// dsh-host-disabled: ').
restore_niri() {
  local target="${M_NIRI_CONFIG:-$NIRI_CONFIG}"
  local backup="${M_NIRI_BACKUP:-}"

  if [ -n "$backup" ] && [ -f "$backup" ]; then
    if is_executing; then
      cp -a "$backup" "$target"
      log "restored niri config from backup: $backup"
    else
      plan "restore $backup -> $target"
    fi
  elif [ "${M_NIRI_TOUCHED:-0}" = 1 ]; then
    warn "no niri backup found at '${backup:-<none>}'; uncommenting in place"
  fi

  if [ "${M_NIRI_TOUCHED:-0}" = 1 ]; then
    if is_executing; then
      local tmp
      tmp="$(mktemp)"
      awk '
        {
          raw = $0
          if (raw ~ /^\/\/ dsh-host-disabled: /) {
            sub(/^\/\/ dsh-host-disabled: /, "", raw)
          }
          print raw
        }
      ' "$target" > "$tmp"
      if ! cmp -s "$tmp" "$target"; then
        install -m 0644 "$tmp" "$target"
        log "uncommented exactly the dsh-host-disabled startup lines"
      fi
      rm -f "$tmp"
      if command -v niri >/dev/null 2>&1 && ! niri validate -c "$target" >/dev/null 2>&1; then
        die "restored niri config failed validation; backup kept at ${backup:-<none>}"
      fi
    else
      plan "strip '// dsh-host-disabled: ' from exactly the lines this installer commented"
      if command -v niri >/dev/null 2>&1; then plan "niri validate -c $target"; fi
    fi
  fi
}

rollback() {
  [ -f "$MANIFEST" ] || die "no deployment manifest at $MANIFEST; nothing to roll back"
  # shellcheck disable=SC1090
  . "$MANIFEST"
  log "mode: $(if is_executing; then echo rollback; else echo rollback-dry-run; fi)"
  log "rolling back deployment from ${M_DEPLOYED_AT:-unknown}"

  run_systemctl disable "${M_SERVICE:-dsh-host.service}"

  if [ "${M_UNIT_PREEXISTING:-0}" = 1 ] && [ -n "${M_UNIT_BACKUP:-}" ] && [ -f "${M_UNIT_BACKUP}" ]; then
    if is_executing; then install -m 0644 "$M_UNIT_BACKUP" "${M_UNIT_PATH:-$UNIT_PATH}"; else plan "restore $M_UNIT_BACKUP -> ${M_UNIT_PATH:-$UNIT_PATH}"; fi
  else
    if is_executing; then rm -f "${M_UNIT_PATH:-$UNIT_PATH}"; else plan "rm -f ${M_UNIT_PATH:-$UNIT_PATH}"; fi
  fi
  run_systemctl daemon-reload

  if [ "${M_NIRI_TOUCHED:-0}" = 1 ]; then
    restore_niri
  fi

  if [ "${M_DSH_WEB_WAS_ENABLED:-}" = "enabled" ] || [ "${M_DSH_WEB_WAS_ENABLED:-}" = "enabled-runtime" ]; then
    run_systemctl enable dsh-web.service
  fi

  if is_executing; then
    mv "$MANIFEST" "$MANIFEST.rolledback-$(date +%Y%m%d-%H%M%S)"
    log "manifest marked rolled back"
  else
    plan "mark manifest as rolled back"
  fi

  cat <<'EOF'

[install-host] rollback plan complete.
  * dsh-host.service is disabled (NOT stopped). If it is currently running,
    stop it manually before starting the old dsh-web.service.
  * dsh-web.service was re-enabled only if it had been enabled before deploy.
  * The next login follows the restored state.
EOF
}

case "$ACTION" in
  rollback) rollback ;;
  *) deploy ;;
esac
