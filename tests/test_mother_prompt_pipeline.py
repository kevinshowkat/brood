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
    assert str(compiled["positive_prompt"]).startswith("Intent summary:")
    assert str(compiled["positive_prompt"]).endswith("Transformation mode: hybridize.")
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


def test_mother_generate_request_v2_minimal_payload_uses_init_and_reference_paths() -> None:
    prompt, settings, source_images, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "minimal v2 prompt",
            "action_version": 27,
            "intent_id": "intent-27",
            "generation_params": {"seed_strategy": "random"},
            "init_image": "/tmp/one.png",
            "reference_images": ["/tmp/two.png"],
        },
        {},
        target_provider="gemini",
    )

    assert prompt == "minimal v2 prompt"
    assert source_images == ["/tmp/one.png", "/tmp/two.png"]
    assert action_meta["intent_id"] == "intent-27"
    assert action_meta["mother_action_version"] == 27
    assert "provider_options" not in settings or settings["provider_options"] == {}


def test_mother_generate_request_v2_carries_gemini_context_packet_in_action_meta() -> None:
    packet = {
        "schema": "brood.gemini.context_packet.v1",
        "proposal_lock": {
            "transformation_mode": "hybridize",
            "selected_ids": ["img_a", "img_b"],
        },
        "image_manifest": [{"id": "img_a", "weight": 0.7}, {"id": "img_b", "weight": 0.3}],
    }
    _, _, _, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "minimal v2 prompt",
            "action_version": 31,
            "intent_id": "intent-31",
            "init_image": "/tmp/one.png",
            "reference_images": ["/tmp/two.png"],
            "gemini_context_packet": packet,
        },
        {},
        target_provider="gemini",
    )

    assert action_meta["intent_id"] == "intent-31"
    assert action_meta["gemini_context_packet"] == packet
    assert action_meta["gemini_context_packet"] is not packet


def test_mother_generate_request_applies_model_context_envelope_for_non_gemini_provider() -> None:
    prompt, settings, _, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "minimal v2 prompt",
            "negative_prompt": "No text overlays",
            "action_version": 42,
            "intent_id": "intent-42",
            "init_image": "/tmp/one.png",
            "reference_images": ["/tmp/two.png"],
            "model_context_envelopes": {
                "openai": {
                    "provider": "openai",
                    "model": "gpt-image-1.5",
                    "transformation_mode": "hybridize",
                    "layout": "adjacent",
                    "goal": "Fuse references into one coherent frame.",
                    "creative_directive": "stunningly awe-inspiring and joyous",
                    "images": [
                        {"id": "img_a", "role": "target", "tier": "PRIMARY", "preserve": ["subject identity"]},
                        {"id": "img_b", "role": "reference", "tier": "SECONDARY", "preserve": ["material cues"]},
                    ],
                    "must_not": ["No text overlays", "No collage"],
                }
            },
        },
        {},
        target_provider="openai",
        target_model="gpt-image-1.5",
    )

    assert prompt.startswith("minimal v2 prompt\nAvoid: No text overlays")
    assert "BROOD_MODEL_CONTEXT_ENVELOPE:" in prompt
    assert "provider=openai" in prompt
    assert "model=gpt-image-1.5" in prompt
    assert action_meta["model_context_envelope"]["provider"] == "openai"
    assert settings["init_image"] == "/tmp/one.png"


def test_mother_generate_request_skips_model_context_envelope_for_gemini_provider() -> None:
    prompt, _, _, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "gemini prompt",
            "action_version": 43,
            "intent_id": "intent-43",
            "init_image": "/tmp/one.png",
            "reference_images": ["/tmp/two.png"],
            "model_context_envelopes": {
                "gemini": {
                    "provider": "gemini",
                    "goal": "Gemini should not use this text envelope.",
                }
            },
        },
        {},
        target_provider="gemini",
        target_model="gemini-3-pro-image-preview",
    )

    assert prompt == "gemini prompt"
    assert "BROOD_MODEL_CONTEXT_ENVELOPE:" not in prompt
    assert "model_context_envelope" not in action_meta


def test_mother_generate_request_accepts_sdxl_alias_when_target_provider_is_replicate() -> None:
    prompt, _, _, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "replicate prompt",
            "action_version": 44,
            "intent_id": "intent-44",
            "init_image": "/tmp/one.png",
            "reference_images": ["/tmp/two.png"],
            "model_context_envelopes": {
                "sdxl": {
                    "provider": "replicate",
                    "model": "sdxl",
                    "goal": "Carry SDXL-specific context.",
                    "must_not": ["No text overlays"],
                }
            },
        },
        {},
        target_provider="replicate",
        target_model="sdxl",
    )

    assert "BROOD_MODEL_CONTEXT_ENVELOPE:" in prompt
    assert "provider=replicate" in prompt
    assert action_meta["model_context_envelope"]["model"] == "sdxl"


def test_mother_generate_request_v1_payload_remains_supported() -> None:
    prompt, settings, source_images, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v1",
            "positive_prompt": "v1 positive",
            "negative_prompt": "v1 negative",
            "action_version": 4,
            "intent": {"intent_id": "legacy-intent-4", "transformation_mode": "hybridize"},
            "generation_params": {"seed": 42},
            "init_image": "/tmp/a.png",
            "reference_images": ["/tmp/b.png"],
        },
        {},
    )

    assert prompt == "v1 positive\nAvoid: v1 negative"
    assert settings["seed"] == 42
    assert source_images == ["/tmp/a.png", "/tmp/b.png"]
    assert action_meta["intent_id"] == "legacy-intent-4"
    assert action_meta["transformation_mode"] == "hybridize"


def test_mother_generate_request_drops_non_gemini_params_for_gemini_provider() -> None:
    prompt, settings, source_images, action_meta = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v1",
            "prompt": "gemini prompt",
            "generation_params": {
                "seed_strategy": "random",
                "guidance_scale": 7,
                "layout_hint": "adjacent",
                "transformation_mode": "hybridize",
                "aspect_ratio": "1:1",
                "image_size": "1K",
            },
            "init_image": "/tmp/a.png",
            "reference_images": ["/tmp/b.png"],
        },
        {
            "provider_options": {
                "guidance_scale": 9,
                "layout_hint": "grid",
                "transformation_mode": "alienate",
                "aspect_ratio": "3:4",
                "image_size": "2K",
            }
        },
        target_provider="gemini",
    )

    assert prompt == "gemini prompt"
    assert source_images == ["/tmp/a.png", "/tmp/b.png"]
    assert action_meta["action"] == "mother_generate"
    assert settings["provider_options"] == {
        "aspect_ratio": "1:1",
        "image_size": "1K",
    }


def test_mother_generate_request_keeps_imagen_only_options_for_imagen_provider() -> None:
    _, settings, _, _ = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v1",
            "prompt": "imagen prompt",
            "generation_params": {
                "guidance_scale": 7,
                "layout_hint": "adjacent",
                "add_watermark": False,
                "person_generation": "allow_adult",
                "image_size": "2K",
                "aspect_ratio": "4:5",
            },
            "init_image": "/tmp/a.png",
        },
        {"provider_options": {"guidance_scale": 9, "add_watermark": True}},
        target_provider="imagen",
    )

    assert settings["provider_options"] == {
        "add_watermark": False,
        "person_generation": "allow_adult",
        "image_size": "2K",
        "aspect_ratio": "4:5",
    }


def test_mother_generate_request_removes_unsupported_state_provider_options_for_gemini() -> None:
    _, settings, _, _ = _mother_generate_request(
        {
            "schema": "brood.mother.generate.v2",
            "prompt": "gemini prompt",
            "generation_params": {},
            "init_image": "/tmp/a.png",
        },
        {
            "provider_options": {
                "guidance_scale": 7,
                "layout_hint": "adjacent",
                "transformation_mode": "hybridize",
            }
        },
        target_provider="gemini",
    )

    assert "provider_options" not in settings
