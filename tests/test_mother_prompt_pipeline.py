from brood_engine.cli import _compile_prompt, _infer_structured_intent, _mother_generate_request

DIRECTIVE = "stunningly awe-inspiring and joyous"
MODES = {
    "amplify",
    "transcend",
    "destabilize",
    "purify",
    "hybridize",
    "mythologize",
    "monumentalize",
    "fracture",
    "romanticize",
    "alienate",
}


def test_infer_structured_intent_includes_creative_directive_and_transformation_mode() -> None:
    intent = _infer_structured_intent(
        {
            "action_version": 12,
            "active_id": "img_1",
            "selected_ids": ["img_1"],
            "images": [
                {"id": "img_1", "vision_desc": "portrait photo", "file": "a.png"},
                {"id": "img_2", "vision_desc": "neon room", "file": "b.png"},
            ],
        }
    )

    assert intent["creative_directive"] == DIRECTIVE
    assert intent["transformation_mode"] in MODES


def test_compile_prompt_includes_directive_transformation_mode_and_constraints() -> None:
    compiled = _compile_prompt(
        {
            "action_version": 20,
            "intent": {
                "summary": "test summary",
                "placement_policy": "adjacent",
                "transformation_mode": "hybridize",
                "roles": {"subject": ["img_1"], "model": [], "mediator": [], "object": []},
            },
        }
    )

    assert compiled["creative_directive"] == DIRECTIVE
    assert compiled["transformation_mode"] == "hybridize"
    assert DIRECTIVE in str(compiled["positive_prompt"]).lower()
    assert "Transformation mode: hybridize." in str(compiled["positive_prompt"])
    assert "Anti-overlay constraints:" in str(compiled["positive_prompt"])
    assert "No unintended ghosted human overlays." in str(compiled["positive_prompt"])
    assert "No accidental double-exposure artifacts." in str(compiled["positive_prompt"])
    assert "no ghosted human overlays" in str(compiled["negative_prompt"]).lower()


def test_compile_prompt_adds_multi_image_fusion_rules_and_face_guardrail() -> None:
    compiled = _compile_prompt(
        {
            "action_version": 21,
            "intent": {
                "summary": "Fuse motion and comfort into something cinematic.",
                "placement_policy": "adjacent",
                "transformation_mode": "hybridize",
                "target_ids": ["img_boat"],
                "reference_ids": ["img_sofa"],
                "roles": {
                    "subject": ["img_boat"],
                    "model": ["img_sofa"],
                    "mediator": ["img_sofa"],
                    "object": ["img_boat"],
                },
            },
            "images": [
                {"id": "img_boat", "vision_desc": "speedboat on water", "file": "boat.png"},
                {"id": "img_sofa", "vision_desc": "black sectional sofa in room", "file": "sofa.png"},
            ],
        }
    )

    positive = str(compiled["positive_prompt"])
    negative = str(compiled["negative_prompt"]).lower()
    assert "Multi-image fusion rules:" in positive
    assert "single coherent scene (not a collage)" in positive
    assert "Preserve primary subject identity from img_boat" in positive
    assert "No extra humans or faces unless clearly present in the input references." in positive
    assert "no extra humans/faces unless present in inputs" in negative


def test_infer_structured_intent_uses_layout_prominence_and_realtime_mode_candidates() -> None:
    intent = _infer_structured_intent(
        {
            "action_version": 31,
            "selected_ids": [],
            "active_id": "",
            "ambient_intent": {
                "transformation_mode_candidates": [
                    {"mode": "monumentalize", "confidence": 0.42},
                    {"mode": "hybridize", "confidence": 0.88},
                    {"mode": "transcend", "confidence": 0.55},
                ]
            },
            "images": [
                {
                    "id": "img_small",
                    "vision_desc": "neutral studio object",
                    "file": "small.png",
                    "rect": {"x": 24, "y": 30, "w": 120, "h": 96},
                },
                {
                    "id": "img_large",
                    "vision_desc": "dynamic vessel silhouette",
                    "file": "large.png",
                    "rect": {"x": 180, "y": 50, "w": 420, "h": 280},
                },
            ],
        }
    )

    assert intent["target_ids"] == ["img_large"]
    assert intent["reference_ids"] == ["img_small"]
    assert intent["roles"]["subject"] == ["img_large"]
    assert intent["roles"]["object"] == ["img_large"]
    assert intent["transformation_mode"] == "hybridize"
    assert intent["confidence"] >= 0.8


def test_infer_structured_intent_defaults_mode_when_realtime_mode_missing() -> None:
    intent = _infer_structured_intent(
        {
            "action_version": 32,
            "selected_ids": [],
            "active_id": "",
            "images": [
                {
                    "id": "img_room",
                    "vision_desc": "minimal interior room",
                    "file": "room.png",
                    "rect": {"x": 30, "y": 40, "w": 280, "h": 220},
                },
                {
                    "id": "img_sofa",
                    "vision_desc": "black sectional sofa",
                    "file": "sofa.png",
                    "rect": {"x": 120, "y": 90, "w": 320, "h": 240},
                },
            ],
        }
    )

    # No realtime mode hint provided: keep stable default instead of lexical/branch heuristics.
    assert intent["transformation_mode"] == "hybridize"


def test_infer_structured_intent_ignores_ambient_branch_ids_for_mode_choice() -> None:
    intent = _infer_structured_intent(
        {
            "action_version": 33,
            "selected_ids": [],
            "active_id": "",
            "ambient_intent": {
                "branches": [
                    {"branch_id": "streaming_content", "confidence": 0.95, "evidence_image_ids": ["img_a"]},
                ]
            },
            "images": [
                {
                    "id": "img_a",
                    "vision_desc": "speedboat on water",
                    "file": "a.png",
                    "rect": {"x": 20, "y": 20, "w": 200, "h": 150},
                },
                {
                    "id": "img_b",
                    "vision_desc": "black sectional sofa in room",
                    "file": "b.png",
                    "rect": {"x": 260, "y": 22, "w": 220, "h": 160},
                },
            ],
        }
    )

    assert intent["transformation_mode"] == "hybridize"


def test_mother_generate_request_random_seed_strategy_sets_seed() -> None:
    prompt, settings, source_images, action_meta = _mother_generate_request(
        {
            "prompt": "test prompt",
            "generation_params": {"seed_strategy": "random"},
            "init_image": "/tmp/a.png",
            "reference_images": ["/tmp/b.png", "/tmp/c.png"],
        },
        {},
    )

    assert prompt == "test prompt"
    assert isinstance(settings.get("seed"), int)
    assert int(settings["seed"]) > 0
    assert source_images == ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]
    assert action_meta["action"] == "mother_generate"
