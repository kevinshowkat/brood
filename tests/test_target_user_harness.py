from __future__ import annotations

import json
import pytest
from pathlib import Path

from brood_engine.harness import target_user


def _write_pack(
    tmp_path: Path,
    *,
    defaults: dict[str, object],
    scenario_overrides: dict[str, object],
) -> Path:
    pack_path = tmp_path / "pack.json"
    payload = {
        "defaults": defaults,
        "personas": [
            {
                "id": "persona_1",
                "role": "Product engineer",
                "traits": ["debuggable", "speed-focused"],
            }
        ],
        "scenarios": [
            {
                "id": "scenario_1",
                "persona_id": "persona_1",
                "goal": "Debug and ship image feature",
                "project_context": "Regression triage",
                "required_abilities": [],
                "policy": {"max_turns": 1, "max_runtime_s": 5, "max_cost_usd": 0.5},
                **scenario_overrides,
            }
        ],
    }
    pack_path.write_text(json.dumps(payload), encoding="utf-8")
    return pack_path


def test_desktop_ui_adapter_start_reports_missing_socket(tmp_path: Path) -> None:
    adapter = target_user.DesktopUIAdapter(
        bridge_socket=str(tmp_path / "missing.sock"),
        startup_timeout_s=1,
    )
    with pytest.raises(RuntimeError, match="Desktop bridge is not ready"):
        adapter.start()


def test_desktop_ui_adapter_start_rejects_non_socket_path(tmp_path: Path) -> None:
    invalid_socket = tmp_path / "bridge.txt"
    invalid_socket.write_text("stale", encoding="utf-8")
    adapter = target_user.DesktopUIAdapter(
        bridge_socket=str(invalid_socket),
        startup_timeout_s=1,
    )
    with pytest.raises(RuntimeError, match="not a unix socket|is not a unix socket"):
        adapter.start()


def test_expected_fail_event_names_for_non_command_turn_is_empty() -> None:
    assert target_user._expected_fail_event_names("diagnose this image") == set()
    assert target_user._expected_fail_event_names("   hello   ") == set()


def test_action_to_queue_item_supports_ui_kind() -> None:
    item = target_user._action_to_queue_item(
        {
            "kind": "ui",
            "ui": {"op": "click", "coord": "window_ratio", "x": 0.4, "y": 0.6},
        },
        [],
    )
    assert item is not None
    assert item["kind"] == "ui"
    assert item["ui"]["op"] == "click"


def test_action_to_queue_item_supports_mother_ui_ops() -> None:
    item = target_user._action_to_queue_item(
        {
            "kind": "ui",
            "ui": {"op": "mother_next_proposal"},
        },
        [],
    )
    assert item is not None
    assert item["kind"] == "ui"
    assert item["ui"]["op"] == "mother_next_proposal"


def test_action_to_queue_item_supports_canvas_automation_ui_ops() -> None:
    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "select_canvas_image", "image_index": 0}},
        [],
    )
    assert item is not None
    assert item["kind"] == "ui"
    assert item["ui"]["op"] == "select_canvas_image"

    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "set_canvas_mode", "mode": "single"}},
        [],
    )
    assert item is not None
    assert item["ui"]["op"] == "set_canvas_mode"

    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "canvas_pan", "dx": 20, "dy": -12}},
        [],
    )
    assert item is not None
    assert item["ui"]["op"] == "canvas_pan"

    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "canvas_zoom", "factor": 1.2}},
        [],
    )
    assert item is not None
    assert item["ui"]["op"] == "canvas_zoom"

    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "canvas_fit_all", "mode": "multi"}},
        [],
    )
    assert item is not None
    assert item["ui"]["op"] == "canvas_fit_all"

    item = target_user._action_to_queue_item(
        {"kind": "ui", "ui": {"op": "action_grid", "key": "diagnose"}},
        [],
    )
    assert item is not None
    assert item["ui"]["op"] == "action_grid"


def test_ui_action_label_renders_canvas_and_grid_ops() -> None:
    assert target_user._ui_action_label({"op": "select_canvas_image", "image_index": 2}) == "[ui:select_canvas_image] index=2"
    assert target_user._ui_action_label({"op": "set_canvas_mode", "mode": "single"}) == "[ui:set_canvas_mode] single"
    assert target_user._ui_action_label({"op": "canvas_pan", "dx": 12, "dy": -4}) == "[ui:canvas_pan] (12, -4)"
    assert target_user._ui_action_label({"op": "canvas_zoom", "scale": 1.35}) == "[ui:canvas_zoom] scale=1.35"
    assert target_user._ui_action_label({"op": "canvas_fit_all", "mode": "multi"}) == "[ui:canvas_fit_all] multi"
    assert target_user._ui_action_label({"op": "action_grid", "key": "diagnose"}) == "[ui:action_grid] diagnose"


def test_ui_automation_wait_plan_separates_markers_from_events() -> None:
    plan = target_user._ui_automation_wait_plan(
        "mother_next_proposal",
        {
            "wait_markers": ["custom_marker_done"],
            "wait_events": ["custom_event_done"],
            "wait_for_markers": ["phase_marker"],
            "wait_for_events": ["phase_event"],
            "pre_wait_markers": ["pre_marker"],
            "pre_wait_events": ["pre_event"],
            "pre_wait_for_markers": ["pre_marker_alias"],
            "pre_wait_for_events": ["pre_event_alias"],
        },
    )
    assert "custom_marker_done" in plan["wait_markers"]
    assert "phase_marker" in plan["wait_markers"]
    assert "custom_event_done" in plan["wait_events"]
    assert "phase_event" in plan["wait_events"]
    assert "custom_event_done" not in plan["wait_markers"]
    assert "pre_marker" in plan["pre_wait_markers"]
    assert "pre_marker_alias" in plan["pre_wait_markers"]
    assert "pre_event" in plan["pre_wait_events"]
    assert "pre_event_alias" in plan["pre_wait_events"]
    assert "custom_event_done" not in plan["pre_wait_markers"]


def test_desktop_ui_adapter_continues_after_pre_wait_timeout(tmp_path: Path) -> None:
    events_path = tmp_path / "automation_events.jsonl"
    adapter = target_user.DesktopUIAdapter(
        bridge_socket="/tmp/desktop-bridge.sock",
        events_path=events_path,
    )

    def _wait_for_pre_only(
        self: target_user.DesktopUIAdapter,  # pylint: disable=unused-argument
        *,
        wait_ms: int,
        state: dict[str, object],
        wait_markers: list[str],
        wait_events: list[str],
        expect_mother_phases: list[str],
        expect_canvas_mode: list[str],
    ) -> tuple[bool, list[dict[str, object]]]:
        if state:
            return True, []
        return False, []

    requests: list[dict[str, object]] = []

    adapter._wait_for_automation_state = _wait_for_pre_only.__get__(
        adapter,
        target_user.DesktopUIAdapter,
    )
    adapter._request = lambda request: requests.append(request) or {  # type: ignore[method-assign]
        "ok": True,
        "detail": "automation handled",
        "state": {
            "mother_phase": "offering",
            "canvas_mode": "single",
        },
        "events": [
            {"type": "mother_next_proposal", "marker": "mother_next_proposal_completed", "state": {"phase": "offering"}},
            {"type": "mother_state", "marker": "mother_state", "state": {"mother_phase": "offering"}},
        ],
        "markers": ["mother_next_proposal_completed", "mother_state"],
        }

    _, collected, _, prompt_returned, timed_out = adapter.run_ui_action({"op": "mother_next_proposal"})
    assert prompt_returned is True
    assert timed_out is False
    assert requests
    assert requests[0]["op"] == "automation"
    event_types = [event.get("type") for event in collected]
    assert "ui_action_performed" in event_types
    assert "ui_action_failed" not in event_types


def test_chat_cli_adapter_reports_ui_action_unsupported(tmp_path: Path) -> None:
    adapter = target_user.ChatCLIAdapter(
        run_dir=tmp_path / "run",
        text_model="gpt-5.2",
        image_model="gemini-2.5-flash-image",
        events_path=tmp_path / "run" / "events.jsonl",
    )
    _, events, _, prompt_returned, timed_out = adapter.run_ui_action({"op": "click", "x": 10, "y": 10})
    event_types = [event.get("type") for event in events]
    assert "ui_action_failed" in event_types
    assert prompt_returned is True
    assert timed_out is False


def test_ui_actions_do_not_consume_max_turns(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(target_user, "_report_llm_markdown", lambda **_: None)

    class FakeDesktopUIAdapter:
        def __init__(self, *args, **kwargs) -> None:
            del args, kwargs

        def start(self) -> None:
            return

        def stop(self) -> None:
            return

        def prepare_inputs(self, input_paths, *, base_dir=None):
            del input_paths, base_dir
            return []

        def run_ui_action(self, action):
            return [], [{"type": "ui_action_performed", "ui_op": action.get("op")}], 0.01, True, False

        def run_turn(self, user_input):
            del user_input
            return [], [{"type": "image_diagnosis"}], 0.01, True, False

    monkeypatch.setattr(target_user, "DesktopUIAdapter", FakeDesktopUIAdapter)

    image_path = tmp_path / "input.png"
    image_path.write_bytes(b"not-a-real-image")

    pack_path = _write_pack(
        tmp_path,
        defaults={
            "adapter": "desktop_ui",
            "screenshot_capture_mode": "synthetic",
        },
        scenario_overrides={
            "inputs": [{"id": "input_1", "path": str(image_path), "label": "Input"}],
            "bootstrap_actions": [
                {"kind": "ui", "ui": {"op": "focus_app"}},
                {"kind": "ui", "ui": {"op": "mother_next_proposal"}},
                {"kind": "command", "command": {"name": "diagnose", "paths": [str(image_path)]}},
            ],
            "policy": {"max_turns": 1, "max_runtime_s": 20, "max_cost_usd": 1.0},
        },
    )

    out_dir = tmp_path / "out_live"
    run_dir = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_dir,
        adapter="desktop_ui",
        panel_enabled=False,
        max_turns_override=1,
    )[0]
    scorecard = json.loads((run_dir / "scorecard.json").read_text(encoding="utf-8"))
    assert scorecard["turns_executed"] == 1
    assert scorecard["steps_executed"] == 3
    assert scorecard["ui_actions_executed"] == 2


def test_panel_model_precedence_cli_then_scenario_then_defaults(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(target_user, "_report_llm_markdown", lambda **_: None)

    pack_path = _write_pack(
        tmp_path,
        defaults={"panel_model": "default-model"},
        scenario_overrides={"panel_model": "scenario-model"},
    )

    out_scenario = tmp_path / "out_scenario"
    scenario_run = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_scenario,
        dry_run=True,
    )[0]
    scenario_session = json.loads((scenario_run / "session.json").read_text(encoding="utf-8"))
    assert scenario_session["defaults"]["panel_model"] == "scenario-model"

    out_cli = tmp_path / "out_cli"
    cli_run = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_cli,
        panel_model="cli-model",
        dry_run=True,
    )[0]
    cli_session = json.loads((cli_run / "session.json").read_text(encoding="utf-8"))
    assert cli_session["defaults"]["panel_model"] == "cli-model"


def test_desktop_paths_precedence_cli_then_scenario_then_defaults(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(target_user, "_report_llm_markdown", lambda **_: None)

    pack_path = _write_pack(
        tmp_path,
        defaults={
            "desktop_bridge_socket": "/tmp/default.sock",
            "desktop_events_path": "/tmp/default.events",
        },
        scenario_overrides={
            "desktop_bridge_socket": "/tmp/scenario.sock",
            "desktop_events_path": "/tmp/scenario.events",
        },
    )

    out_scenario = tmp_path / "out_scenario"
    scenario_run = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_scenario,
        dry_run=True,
    )[0]
    scenario_session = json.loads((scenario_run / "session.json").read_text(encoding="utf-8"))
    assert scenario_session["defaults"]["desktop_bridge_socket"] == "/tmp/scenario.sock"
    assert scenario_session["defaults"]["desktop_events_path"] == "/tmp/scenario.events"

    out_cli = tmp_path / "out_cli"
    cli_run = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_cli,
        desktop_bridge_socket="/tmp/cli.sock",
        desktop_events_path="/tmp/cli.events",
        dry_run=True,
    )[0]
    cli_session = json.loads((cli_run / "session.json").read_text(encoding="utf-8"))
    assert cli_session["defaults"]["desktop_bridge_socket"] == "/tmp/cli.sock"
    assert cli_session["defaults"]["desktop_events_path"] == "/tmp/cli.events"


def test_score_run_caps_total_score_at_one() -> None:
    reflections = [
        {
            "artifact_paths": [f"/tmp/artifact-{idx}.png"],
            "pain_points": [],
            "reaction": "looks good",
        }
        for idx in range(3)
    ]
    scorecard = target_user._score_run(
        reflections=reflections,
        required_abilities=["swap_dna", "bridge", "argue"],
        used_abilities={"swap_dna", "bridge", "argue"},
        run_cost=0.2,
        max_cost_usd=5.0,
        runtime_s=12.0,
        max_runtime_s=780.0,
    )
    assert scorecard["score_total"] <= 1.0
    assert scorecard["score_total"] == 1.0


def test_synthesis_fallback_reflection_reports_ui_state_change(tmp_path: Path) -> None:
    reflection = target_user._synthesis_fallback_reflection(
        turn=1,
        action="[ui:mother_confirm_suggestion]",
        assistant_lines=[],
        delta_events=[
            {"type": "mother_confirm", "before": "intent_hypothesizing", "after": "drafting"},
            {"type": "ui_action_performed", "ui_op": "mother_confirm_suggestion", "ui_detail": "mother_confirm_suggestion executed"},
        ],
        duration_s=0.8,
        screenshot_path=tmp_path / "shot.png",
        screenshot_phase="post_action",
        screenshot_summary=[],
        consecutive_failures=0,
        artifact_paths=[],
    )
    assert "Mother confirm executed" in reflection["what_worked"]
    assert reflection["what_worked"] != "No visible result from this turn."


def test_panel_normalize_review_includes_simulated_user_quotes() -> None:
    reviewer = target_user.PanelReviewer(model="gpt-5.2", panel_prompt="test prompt")
    normalized = reviewer._normalize_review(
        {
            "reaction": "I can't tell what changed.",
            "next_hypothesis": "Open proposal details before accepting.",
            "pain_points": [],
            "simulated_user_quotes": [
                {
                    "quote": "I don't know what ACCEPT will do.",
                    "sentiment": "negative",
                    "confidence": 0.84,
                    "evidence": ["No preview text", "Only button labels visible"],
                }
            ],
        }
    )
    assert normalized["simulated_user_quotes"]
    assert normalized["simulated_user_quotes"][0]["quote"] == "I don't know what ACCEPT will do."
    assert normalized["simulated_user_quotes"][0]["sentiment"] == "negative"


def test_assign_quote_ids_to_reflection_adds_ids() -> None:
    reflection = {
        "turn": 7,
        "simulated_user_quotes": [
            {
                "quote": "I can see ACCEPT but not the proposal details.",
                "sentiment": "negative",
                "confidence": 0.9,
                "evidence": ["Buttons visible", "No proposal summary text"],
            }
        ],
    }
    quotes = target_user._assign_quote_ids_to_reflection(reflection)
    assert quotes
    assert quotes[0]["quote_id"] == "q-t07-01"
    assert reflection["simulated_user_quotes"][0]["quote_id"] == "q-t07-01"


def test_build_ux_improvements_prompt_includes_quote_ids() -> None:
    prompt = target_user._build_ux_improvements_prompt(
        run_summaries=[
            {
                "scenario_id": "mother_three_photo_accept_flow",
                "persona_id": "creative_technologist_design_infra",
                "dry_run": False,
                "scorecard": {"status": "pass"},
                "panel_warnings": [],
                "reflections": [
                    {
                        "turn": 4,
                        "pain_points": [],
                        "simulated_user_quotes": [
                            {
                                "quote_id": "q-t04-01",
                                "quote": "I can't see what this proposal is.",
                                "sentiment": "negative",
                                "confidence": 0.81,
                                "evidence": ["No visible proposal text"],
                            }
                        ],
                    }
                ],
            }
        ],
        scenarios=[
            {
                "id": "mother_three_photo_accept_flow",
                "persona_id": "creative_technologist_design_infra",
                "goal": "Test proposal accept flow.",
                "project_context": "Desktop UI",
                "required_abilities": [],
                "success_criteria": [],
            }
        ],
    )
    assert "q-t04-01" in prompt
    assert "Simulated User Verbatims" in prompt


def test_no_llm_skips_report_llm_markdown_calls(tmp_path: Path, monkeypatch) -> None:
    call_counter = {"count": 0}

    def _unexpected_report_call(**_: object) -> str:
        call_counter["count"] += 1
        return "should-not-be-used"

    monkeypatch.setattr(target_user, "_report_llm_markdown", _unexpected_report_call)
    pack_path = _write_pack(
        tmp_path,
        defaults={},
        scenario_overrides={},
    )
    out_dir = tmp_path / "out_no_llm"
    target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=out_dir,
        panel_enabled=False,
        dry_run=True,
    )
    assert call_counter["count"] == 0


def test_scorecard_success_criteria_remains_array(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(target_user, "_report_llm_markdown", lambda **_: None)

    class FakeDesktopUIAdapter:
        def __init__(self, **kwargs):
            del kwargs

        def start(self) -> None:
            return

        def stop(self) -> None:
            return

        def prepare_inputs(self, input_paths, *, base_dir=None):
            del input_paths, base_dir
            return []

        def run_ui_action(self, action):
            return [], [{"type": "ui_action_performed", "ui_op": action.get("op")}], 0.01, True, False

        def run_turn(self, user_input):
            del user_input
            return [], [{"type": "image_diagnosis"}], 0.01, True, False

    monkeypatch.setattr(target_user, "DesktopUIAdapter", FakeDesktopUIAdapter)

    image_path = tmp_path / "input.png"
    image_path.write_bytes(b"not-a-real-image")
    pack_path = _write_pack(
        tmp_path,
        defaults={
            "adapter": "desktop_ui",
            "screenshot_capture_mode": "synthetic",
        },
        scenario_overrides={
            "inputs": [{"id": "input_1", "path": str(image_path), "label": "Input"}],
            "bootstrap_actions": [{"kind": "ui", "ui": {"op": "focus_app"}}],
            "success_criteria": ["criterion a", "criterion b"],
            "policy": {"max_turns": 1, "max_runtime_s": 20, "max_cost_usd": 1.0},
        },
    )

    run_dir = target_user.run_target_user_pack(
        pack_path=pack_path,
        out_dir=tmp_path / "out_scorecard_success_criteria",
        adapter="desktop_ui",
        panel_enabled=False,
        max_turns_override=1,
    )[0]
    scorecard = json.loads((run_dir / "scorecard.json").read_text(encoding="utf-8"))
    assert scorecard["success_criteria"] == ["criterion a", "criterion b"]
    assert isinstance(scorecard["success_criteria"], list)
