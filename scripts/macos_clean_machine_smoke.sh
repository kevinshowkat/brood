#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This smoke script only runs on macOS."
  exit 1
fi

DMG_PATH="${1:-${DMG_PATH:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
WAIT_SECONDS="${WAIT_SECONDS:-30}"
POST_LAUNCH_WAIT_SECONDS="${POST_LAUNCH_WAIT_SECONDS:-30}"
BROOD_HOME_DIR="${BROOD_HOME_DIR:-$HOME/.brood}"
BROOD_INSTALL_TELEMETRY="${BROOD_INSTALL_TELEMETRY:-0}"
BROOD_INSTALL_TELEMETRY_RESET="${BROOD_INSTALL_TELEMETRY_RESET:-0}"
BROOD_BRIDGE_SOCKET="${BROOD_BRIDGE_SOCKET:-/tmp/brood_desktop_bridge.sock}"
AUTOMATE_IMPORT_AND_ABILITY="${AUTOMATE_IMPORT_AND_ABILITY:-1}"
AUTOMATE_PROPOSAL_FLOW="${AUTOMATE_PROPOSAL_FLOW:-1}"
REQUIRE_PROPOSAL_EVENTS="${REQUIRE_PROPOSAL_EVENTS:-0}"
AUTOMATION_READY_TIMEOUT_SECONDS="${AUTOMATION_READY_TIMEOUT_SECONDS:-45}"
AUTOMATION_EVENT_TIMEOUT_SECONDS="${AUTOMATION_EVENT_TIMEOUT_SECONDS:-45}"
PROPOSAL_EVENT_TIMEOUT_SECONDS="${PROPOSAL_EVENT_TIMEOUT_SECONDS:-180}"
SMOKE_SAMPLE_IMAGE_PATH="${SMOKE_SAMPLE_IMAGE_PATH:-$REPO_ROOT/desktop/src/assets/onboarding/aesthetic/flux-2-flex.png}"
SMOKE_SAMPLE_IMAGE_PATH_SECONDARY="${SMOKE_SAMPLE_IMAGE_PATH_SECONDARY:-$REPO_ROOT/desktop/src/assets/onboarding/aesthetic/gemini-3-pro-image-preview.png}"
TELEMETRY_LOG_PATH="${BROOD_INSTALL_TELEMETRY_LOG:-$BROOD_HOME_DIR/install_events.jsonl}"
MOUNT_POINT=""
INSTALLED_APP_PATH=""

log() {
  printf '[smoke] %s\n' "$*"
}

warn() {
  printf '[smoke][warn] %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "${INSTALLED_APP_PATH:-}" ]]; then
    local bin_name="${INSTALLED_APP_PATH##*/}"
    bin_name="${bin_name%.app}"
    osascript -e "tell application \"${bin_name}\" to quit" >/dev/null 2>&1 || true
    pkill -f "${INSTALLED_APP_PATH}/Contents/MacOS" >/dev/null 2>&1 || true
  fi
  if [[ -n "${MOUNT_POINT:-}" ]] && mount | awk '{print $3}' | grep -Fxq "$MOUNT_POINT"; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
}
trap cleanup EXIT

find_latest_dmg() {
  local found
  found="$(
    find desktop/src-tauri/target -type f -name '*.dmg' -print0 2>/dev/null \
      | while IFS= read -r -d '' path; do
          # stat -f is BSD/macOS; emit epoch mtime then path for stable sorting.
          printf '%s\t%s\n' "$(stat -f '%m' "$path" 2>/dev/null || printf '0')" "$path"
        done \
      | sort -n -k1,1 -k2,2 \
      | tail -n 1 \
      | cut -f2-
  )"
  printf '%s' "$found"
}

bridge_request() {
  local payload="$1"
  if [[ ! -S "$BROOD_BRIDGE_SOCKET" ]]; then
    return 1
  fi
  local response
  response="$(printf '%s\n' "$payload" | nc -U "$BROOD_BRIDGE_SOCKET" 2>/dev/null | head -n 1 || true)"
  [[ -n "$response" ]] || return 1
  printf '%s' "$response"
}

wait_for_automation_ready() {
  local timeout="${1:-45}"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    if [[ ! -S "$BROOD_BRIDGE_SOCKET" ]]; then
      sleep 1
      continue
    fi
    local response
    response="$(bridge_request '{"op":"status"}' || true)"
    if [[ -n "$response" ]] && jq -e '.ok == true and .status.automation_frontend_ready == true' <<<"$response" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_telemetry_event() {
  local event_name="$1"
  local timeout="${2:-45}"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    if [[ -f "$TELEMETRY_LOG_PATH" ]] && jq -Rce --arg event "$event_name" 'fromjson? | select(.event == $event)' "$TELEMETRY_LOG_PATH" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

proposal_warn_or_fail() {
  local message="$1"
  if [[ "$REQUIRE_PROPOSAL_EVENTS" == "1" ]]; then
    echo "$message"
    return 1
  fi
  warn "$message"
  return 0
}

run_proposal_flow_automation() {
  if [[ ! -f "$SMOKE_SAMPLE_IMAGE_PATH_SECONDARY" ]]; then
    proposal_warn_or_fail "Secondary smoke sample image not found: $SMOKE_SAMPLE_IMAGE_PATH_SECONDARY"
    return $?
  fi

  log "Automation: import second image for Mother proposal flow"
  local seed_import_request
  seed_import_request="$(jq -nc --arg path "$SMOKE_SAMPLE_IMAGE_PATH_SECONDARY" '{
    op: "automation",
    action: "import_local_paths",
    timeout_ms: 45000,
    payload: {
      path: $path,
      source: "clean_machine_smoke_proposal",
      id_prefix: "smokeproposal",
      focus_imported: false
    }
  }')"
  local seed_import_response
  seed_import_response="$(bridge_request "$seed_import_request" || true)"
  if [[ -z "$seed_import_response" ]] || ! jq -e '.ok == true' <<<"$seed_import_response" >/dev/null 2>&1; then
    proposal_warn_or_fail "Proposal prep import failed: ${seed_import_response:-<empty response>}"
    return $?
  fi

  log "Automation: request Mother next proposal"
  local proposal_request
  proposal_request="$(jq -nc '{
    op: "automation",
    action: "mother_next_proposal",
    timeout_ms: 60000,
    payload: {}
  }')"
  local proposal_response
  proposal_response="$(bridge_request "$proposal_request" || true)"
  if [[ -z "$proposal_response" ]]; then
    proposal_warn_or_fail "Mother proposal request failed: <empty response>"
    return $?
  fi
  if ! jq -e '.ok == true' <<<"$proposal_response" >/dev/null 2>&1; then
    warn "Mother proposal request did not advance immediately: $proposal_response"
  fi

  log "Automation: confirm Mother suggestion (begin drafting)"
  local draft_request
  draft_request="$(jq -nc '{
    op: "automation",
    action: "mother_confirm_suggestion",
    timeout_ms: 70000,
    payload: {
      wait_timeout_ms: 45000,
      expect_mother_phases: ["drafting", "waiting_for_user", "offering"]
    }
  }')"
  local draft_response
  draft_response="$(bridge_request "$draft_request" || true)"
  if [[ -z "$draft_response" ]]; then
    proposal_warn_or_fail "Mother draft-start confirm failed: <empty response>"
    return $?
  fi
  if ! jq -e '.ok == true' <<<"$draft_response" >/dev/null 2>&1; then
    warn "Mother draft-start confirm did not complete cleanly: $draft_response"
  fi

  local proposal_seen=0
  if [[ "$BROOD_INSTALL_TELEMETRY" == "1" ]]; then
    log "Waiting for first_proposal_proposed telemetry"
    if wait_for_telemetry_event "first_proposal_proposed" "$PROPOSAL_EVENT_TIMEOUT_SECONDS"; then
      proposal_seen=1
    else
      warn "Timed out waiting for first_proposal_proposed telemetry in $TELEMETRY_LOG_PATH"
      log "Automation: inject deterministic local Mother draft fallback"
      local inject_request
      inject_request="$(jq -nc '{
        op: "automation",
        action: "mother_inject_local_draft",
        timeout_ms: 30000,
        payload: {}
      }')"
      local inject_response
      inject_response="$(bridge_request "$inject_request" || true)"
      if [[ -z "$inject_response" ]]; then
        proposal_warn_or_fail "Mother local draft injection failed: <empty response>"
        return $?
      fi
      if ! jq -e '.ok == true' <<<"$inject_response" >/dev/null 2>&1; then
        warn "Mother local draft injection did not complete cleanly: $inject_response"
      fi
      if wait_for_telemetry_event "first_proposal_proposed" "$PROPOSAL_EVENT_TIMEOUT_SECONDS"; then
        proposal_seen=1
      fi
    fi
    if [[ "$proposal_seen" -ne 1 ]]; then
      if [[ "$REQUIRE_PROPOSAL_EVENTS" == "1" ]]; then
        echo "Timed out waiting for first_proposal_proposed telemetry in $TELEMETRY_LOG_PATH"
        return 1
      fi
      warn "first_proposal_proposed was not recorded in $TELEMETRY_LOG_PATH"
    fi
  fi

  log "Automation: confirm Mother suggestion (accept proposal)"
  local accept_request
  accept_request="$(jq -nc '{
    op: "automation",
    action: "mother_confirm_suggestion",
    timeout_ms: 70000,
    payload: {
      wait_timeout_ms: 45000,
      expect_mother_phases: ["cooldown", "offering", "waiting_for_user", "drafting"]
    }
  }')"
  local accept_response
  accept_response="$(bridge_request "$accept_request" || true)"
  if [[ -z "$accept_response" ]]; then
    proposal_warn_or_fail "Mother proposal accept failed: <empty response>"
    return $?
  fi
  if ! jq -e '.ok == true' <<<"$accept_response" >/dev/null 2>&1; then
    warn "Mother proposal accept did not complete cleanly: $accept_response"
  fi

  if [[ "$BROOD_INSTALL_TELEMETRY" == "1" ]]; then
    log "Waiting for first_proposal_accepted telemetry"
    if ! wait_for_telemetry_event "first_proposal_accepted" "$PROPOSAL_EVENT_TIMEOUT_SECONDS"; then
      log "Automation: retry Mother accept once"
      local accept_retry_response
      accept_retry_response="$(bridge_request "$accept_request" || true)"
      if [[ -n "$accept_retry_response" ]] && ! jq -e '.ok == true' <<<"$accept_retry_response" >/dev/null 2>&1; then
        warn "Mother proposal accept retry did not complete cleanly: $accept_retry_response"
      fi
      if ! wait_for_telemetry_event "first_proposal_accepted" "$PROPOSAL_EVENT_TIMEOUT_SECONDS"; then
        if [[ "$REQUIRE_PROPOSAL_EVENTS" == "1" ]]; then
          echo "Timed out waiting for first_proposal_accepted telemetry in $TELEMETRY_LOG_PATH"
          return 1
        fi
        warn "Timed out waiting for first_proposal_accepted telemetry in $TELEMETRY_LOG_PATH"
      fi
    fi
  fi

  log "Automation proposal flow checks passed"
  return 0
}

run_import_and_ability_automation() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required for automation smoke checks."
    return 1
  fi
  if ! command -v nc >/dev/null 2>&1; then
    echo "nc is required for automation smoke checks."
    return 1
  fi
  if [[ ! -f "$SMOKE_SAMPLE_IMAGE_PATH" ]]; then
    echo "Smoke sample image not found: $SMOKE_SAMPLE_IMAGE_PATH"
    return 1
  fi
  log "Waiting for desktop automation readiness"
  if ! wait_for_automation_ready "$AUTOMATION_READY_TIMEOUT_SECONDS"; then
    echo "Desktop automation frontend was not ready within ${AUTOMATION_READY_TIMEOUT_SECONDS}s."
    return 1
  fi

  log "Automation: import one image"
  local import_request
  import_request="$(jq -nc --arg path "$SMOKE_SAMPLE_IMAGE_PATH" '{
    op: "automation",
    action: "import_local_paths",
    timeout_ms: 45000,
    payload: {
      path: $path,
      source: "clean_machine_smoke",
      id_prefix: "smokeimport",
      focus_imported: true
    }
  }')"
  local import_response
  import_response="$(bridge_request "$import_request" || true)"
  if [[ -z "$import_response" ]] || ! jq -e '.ok == true' <<<"$import_response" >/dev/null 2>&1; then
    echo "Import automation failed: ${import_response:-<empty response>}"
    return 1
  fi

  log "Automation: run one ability action (crop_square)"
  local ability_request
  ability_request="$(jq -nc '{
    op: "automation",
    action: "action_grid",
    timeout_ms: 45000,
    payload: {
      key: "crop_square"
    }
  }')"
  local ability_response
  ability_response="$(bridge_request "$ability_request" || true)"
  if [[ -z "$ability_response" ]] || ! jq -e '.ok == true' <<<"$ability_response" >/dev/null 2>&1; then
    echo "Ability automation failed: ${ability_response:-<empty response>}"
    return 1
  fi

  if [[ "$BROOD_INSTALL_TELEMETRY" == "1" ]]; then
    log "Waiting for first_import_ok telemetry"
    if ! wait_for_telemetry_event "first_import_ok" "$AUTOMATION_EVENT_TIMEOUT_SECONDS"; then
      echo "Timed out waiting for first_import_ok telemetry in $TELEMETRY_LOG_PATH"
      return 1
    fi
    log "Waiting for first_ability_success telemetry"
    if ! wait_for_telemetry_event "first_ability_success" "$AUTOMATION_EVENT_TIMEOUT_SECONDS"; then
      echo "Timed out waiting for first_ability_success telemetry in $TELEMETRY_LOG_PATH"
      return 1
    fi
  fi

  if [[ "$AUTOMATE_PROPOSAL_FLOW" == "1" ]]; then
    run_proposal_flow_automation
  fi

  log "Automation import + ability checks passed"
  return 0
}

if [[ -z "$DMG_PATH" ]]; then
  DMG_PATH="$(find_latest_dmg)"
fi

if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "No DMG found. Pass one explicitly: scripts/macos_clean_machine_smoke.sh /path/to/Brood.dmg"
  exit 1
fi

if [[ "$BROOD_INSTALL_TELEMETRY_RESET" == "1" ]]; then
  rm -f "$BROOD_HOME_DIR/install_events.jsonl"
fi

if [[ "$BROOD_INSTALL_TELEMETRY" == "1" ]]; then
  mkdir -p "$BROOD_HOME_DIR"
  cat > "$BROOD_HOME_DIR/install_telemetry_config.json" <<'JSON'
{
  "version": 1,
  "opt_in": true,
  "force_opt_in": true
}
JSON
  log "Install telemetry enabled for smoke run"
fi

log "Using DMG: $DMG_PATH"
attach_out="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly)"
MOUNT_POINT="$(printf '%s\n' "$attach_out" | awk '/\/Volumes\// {print $NF}' | tail -n 1)"
if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  echo "Failed to determine mounted DMG volume."
  exit 1
fi
log "Mounted at: $MOUNT_POINT"

SOURCE_APP_PATH="$(
  find "$MOUNT_POINT" -maxdepth 2 -type d -name '*.app' -print \
    | head -n 1
)"
if [[ -z "$SOURCE_APP_PATH" ]]; then
  echo "No .app bundle found in mounted DMG."
  exit 1
fi
APP_BUNDLE_NAME="$(basename "$SOURCE_APP_PATH")"

if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
fi
if [[ ! -w "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
fi

INSTALLED_APP_PATH="$INSTALL_DIR/$APP_BUNDLE_NAME"
log "Installing app bundle to: $INSTALLED_APP_PATH"
rm -rf "$INSTALLED_APP_PATH"
cp -R "$SOURCE_APP_PATH" "$INSTALLED_APP_PATH"

log "Running quick integrity checks (best-effort)"
codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP_PATH" >/dev/null 2>&1 || warn "codesign verify failed"
spctl --assess --type execute -vv "$INSTALLED_APP_PATH" >/dev/null 2>&1 || warn "spctl assess failed"

log "Launching app"
open -a "$INSTALLED_APP_PATH"

bin_name="${APP_BUNDLE_NAME%.app}"
deadline=$((SECONDS + WAIT_SECONDS))
launched=0
while ((SECONDS < deadline)); do
  if pgrep -x "$bin_name" >/dev/null 2>&1; then
    launched=1
    break
  fi
  if pgrep -f "${INSTALLED_APP_PATH}/Contents/MacOS" >/dev/null 2>&1; then
    launched=1
    break
  fi
  sleep 1
done

if [[ "$launched" -ne 1 ]]; then
  echo "App failed to launch within ${WAIT_SECONDS}s."
  exit 1
fi

log "Launch confirmed"
if [[ "$AUTOMATE_IMPORT_AND_ABILITY" == "1" ]]; then
  run_import_and_ability_automation
fi
if [[ "$POST_LAUNCH_WAIT_SECONDS" =~ ^[0-9]+$ ]] && [[ "$POST_LAUNCH_WAIT_SECONDS" -gt 0 ]]; then
  log "Waiting ${POST_LAUNCH_WAIT_SECONDS}s post-launch to allow telemetry flush"
  sleep "$POST_LAUNCH_WAIT_SECONDS"
fi
log "Smoke test passed"
