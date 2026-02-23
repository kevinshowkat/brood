#!/usr/bin/env bash
set -euo pipefail

OUT_PATH="${1:-artifacts/install_funnel.json}"
BROOD_HOME_DIR="${BROOD_HOME_DIR:-$HOME/.brood}"
TELEMETRY_LOG_PATH="${BROOD_INSTALL_TELEMETRY_LOG:-$BROOD_HOME_DIR/install_events.jsonl}"
RUN_ROOT="${BROOD_RUN_ROOT:-$HOME/brood_runs}"

mkdir -p "$(dirname "$OUT_PATH")"

jsonl_to_array() {
  local path="$1"
  if [[ -f "$path" ]]; then
    jq -Rcs 'split("\n") | map(select(length > 0) | fromjson?) | map(select(type == "object"))' "$path"
  else
    printf '[]'
  fi
}

telemetry_log_exists=false
if [[ -f "$TELEMETRY_LOG_PATH" ]]; then
  telemetry_log_exists=true
fi
telemetry_json="$(jsonl_to_array "$TELEMETRY_LOG_PATH")"

latest_run_dir=""
if [[ -d "$RUN_ROOT" ]]; then
  latest_run_dir="$(
    find "$RUN_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'run-*' -print \
      | sort \
      | tail -n 1
  )"
fi

latest_run_events_path=""
run_events_json="[]"
if [[ -n "$latest_run_dir" && -f "$latest_run_dir/events.jsonl" ]]; then
  latest_run_events_path="$latest_run_dir/events.jsonl"
  run_events_json="$(jsonl_to_array "$latest_run_events_path")"
fi

jq -n \
  --arg generated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg telemetry_log_path "$TELEMETRY_LOG_PATH" \
  --arg latest_run_dir "$latest_run_dir" \
  --arg latest_run_events_path "$latest_run_events_path" \
  --argjson telemetry_log_exists "$telemetry_log_exists" \
  --argjson telemetry "$telemetry_json" \
  --argjson run_events "$run_events_json" \
  '
  def evt_count($name): [ $telemetry[] | select((.event // "") == $name) ] | length;
  def evt_first_ms($name):
    ([ $telemetry[] | select((.event // "") == $name) | (.at_ms // empty) ]
      | map(select(type == "number"))
      | min) // null;
  def latest_session_id:
    ([ $telemetry[] | (.session_id // empty) ] | map(select(length > 0)) | last) // null;
  def rows_for_session($sid):
    if $sid == null
    then []
    else [ $telemetry[] | select((.session_id // null) == $sid) ]
    end;
  def session_evt_count($rows; $name):
    [ $rows[] | select((.event // "") == $name) ] | length;
  def session_first_ms($rows; $name):
    ([ $rows[] | select((.event // "") == $name) | (.at_ms // empty) ]
      | map(select(type == "number"))
      | min) // null;
  def run_evt_count($name):
    [ $run_events[] | select((.type // "") == $name) ] | length;

  (latest_session_id) as $sid
  | (rows_for_session($sid)) as $session_rows
  | (session_first_ms($session_rows; "app_first_launch")) as $launch_ms
  | (session_first_ms($session_rows; "first_proposal_proposed")) as $first_proposal_ms
  | (session_first_ms($session_rows; "first_proposal_accepted")) as $first_proposal_accepted_ms
  | (session_first_ms($session_rows; "first_ability_success")) as $first_success_ms
  | {
      generated_at: $generated_at,
      telemetry_log_path: (if $telemetry_log_exists then $telemetry_log_path else null end),
      latest_run_dir: (if ($latest_run_dir | length) > 0 then $latest_run_dir else null end),
      latest_run_events_path: (if ($latest_run_events_path | length) > 0 then $latest_run_events_path else null end),
      telemetry_events_total: ($telemetry | length),
      run_events_total: ($run_events | length),
      latest_session_id: $sid,
      funnel: {
        app_first_launch: evt_count("app_first_launch"),
        onboarding_started: evt_count("onboarding_started"),
        onboarding_completed: evt_count("onboarding_completed"),
        onboarding_skipped: evt_count("onboarding_skipped"),
        provider_check_ok: evt_count("provider_check_ok"),
        provider_check_fail: evt_count("provider_check_fail"),
        new_run_created: evt_count("new_run_created"),
        first_proposal_proposed: evt_count("first_proposal_proposed"),
        first_proposal_accepted: evt_count("first_proposal_accepted"),
        first_import_ok: evt_count("first_import_ok"),
        first_ability_success: evt_count("first_ability_success"),
        first_ability_fail: evt_count("first_ability_fail")
      },
      latest_session_funnel: {
        app_first_launch: session_evt_count($session_rows; "app_first_launch"),
        onboarding_started: session_evt_count($session_rows; "onboarding_started"),
        onboarding_completed: session_evt_count($session_rows; "onboarding_completed"),
        onboarding_skipped: session_evt_count($session_rows; "onboarding_skipped"),
        provider_check_ok: session_evt_count($session_rows; "provider_check_ok"),
        provider_check_fail: session_evt_count($session_rows; "provider_check_fail"),
        new_run_created: session_evt_count($session_rows; "new_run_created"),
        first_proposal_proposed: session_evt_count($session_rows; "first_proposal_proposed"),
        first_proposal_accepted: session_evt_count($session_rows; "first_proposal_accepted"),
        first_import_ok: session_evt_count($session_rows; "first_import_ok"),
        first_ability_success: session_evt_count($session_rows; "first_ability_success"),
        first_ability_fail: session_evt_count($session_rows; "first_ability_fail"),
        time_to_first_proposal_proposed_ms:
          (if ($launch_ms != null and $first_proposal_ms != null and $first_proposal_ms >= $launch_ms)
            then ($first_proposal_ms - $launch_ms)
            else null
          end),
        time_to_first_proposal_accepted_ms:
          (if ($launch_ms != null and $first_proposal_accepted_ms != null and $first_proposal_accepted_ms >= $launch_ms)
            then ($first_proposal_accepted_ms - $launch_ms)
            else null
          end),
        time_to_first_ability_success_ms:
          (if ($launch_ms != null and $first_success_ms != null and $first_success_ms >= $launch_ms)
            then ($first_success_ms - $launch_ms)
            else null
          end)
      },
      latest_run_event_counts: {
        artifact_created: run_evt_count("artifact_created"),
        generation_failed: run_evt_count("generation_failed")
      },
      synthetic_setup_completion_rate:
        (if evt_count("app_first_launch") > 0
          then ((evt_count("first_ability_success") / evt_count("app_first_launch")) * 1.0)
          else null
        end)
    }
  ' > "$OUT_PATH"

echo "wrote install funnel JSON: $OUT_PATH"
