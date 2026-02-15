import json

from brood_engine.realtime.openai_realtime import (
    _intent_snapshot_metadata,
    _resolve_streamed_response_text,
)


def test_resolve_streamed_response_text_recovers_from_truncated_buffer() -> None:
    # Reproduced from real run logs: payload was cut at `"checkpoint": {"icons`.
    truncated_from_log = (
        "{\n"
        "  \"frame_id\": \"mother-intent-a0-1771156098794-a00\",\n"
        "  \"schema\": \"brood.intent_icons\",\n"
        "  \"schema_version\": 1,\n"
        "  \"intent_icons\": [\n"
        "    {\"icon_id\": \"IMAGE_GENERATION\", \"confidence\": 0.9, \"position_hint\": \"primary\"}\n"
        "  ],\n"
        "  \"branches\": [\n"
        "    {\n"
        "      \"branch_id\": \"content_engine\",\n"
        "      \"confidence\": 0.7,\n"
        "      \"icons\": [\"CONTENT_ENGINE\"],\n"
        "      \"lane_position\": \"left\",\n"
        "      \"evidence_image_ids\": [\"input-1\"]\n"
        "    }\n"
        "  ],\n"
        "  \"checkpoint\": {\n"
        "    \"icons"
    )
    completed = (
        truncated_from_log
        + "\": [\"YES_TOKEN\", \"NO_TOKEN\", \"MAYBE_TOKEN\"],\n"
        + "    \"applies_to\": \"content_engine\"\n"
        + "  }\n"
        + "}"
    )

    response = {
        "id": "resp_123",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": completed,
                    }
                ],
            }
        ],
    }

    cleaned, meta = _resolve_streamed_response_text(truncated_from_log, response)

    assert cleaned == completed
    assert json.loads(cleaned)["schema"] == "brood.intent_icons"
    assert meta.get("response_id") == "resp_123"
    assert meta.get("response_status") == "completed"
    assert meta.get("response_truncated") is None


def test_resolve_streamed_response_text_marks_truncated_responses() -> None:
    truncated = '{"schema":"brood.intent_icons","intent_icons":[{"icon_id":"IMAGE_GENERATION"}]'
    response = {
        "id": "resp_456",
        "status": "incomplete",
        "status_details": {"reason": "max_output_tokens"},
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": truncated,
                    }
                ],
            }
        ],
    }

    cleaned, meta = _resolve_streamed_response_text(truncated, response)

    assert cleaned == truncated
    assert meta.get("response_status") == "incomplete"
    assert meta.get("response_status_reason") == "max_output_tokens"
    assert meta.get("response_truncated") is True


def test_intent_snapshot_metadata_extracts_scope_frame_and_action_version(tmp_path) -> None:
    image_path = tmp_path / "mother-intent-1771155370146-a137.png"
    image_path.write_bytes(b"png")
    sidecar = image_path.with_suffix(".ctx.json")
    sidecar.write_text(
        json.dumps({"frame_id": "mother-intent-a137-1771155370146-a137"}),
        encoding="utf-8",
    )

    meta = _intent_snapshot_metadata(str(image_path))

    assert meta["intent_scope"] == "mother"
    assert meta["frame_id"] == "mother-intent-a137-1771155370146-a137"
    assert meta["action_version"] == 137
