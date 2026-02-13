from brood_engine.chat.intent_parser import parse_intent


def test_parse_intent_blend_basic():
    intent = parse_intent("/blend a.png b.png")
    assert intent.action == "blend"
    assert intent.command_args["paths"] == ["a.png", "b.png"]


def test_parse_intent_blend_quoted_paths():
    intent = parse_intent('/blend "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "blend"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_swap_dna_basic():
    intent = parse_intent("/swap_dna a.png b.png")
    assert intent.action == "swap_dna"
    assert intent.command_args["paths"] == ["a.png", "b.png"]


def test_parse_intent_swap_dna_quoted_paths():
    intent = parse_intent('/swap_dna "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "swap_dna"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_diagnose_basic():
    intent = parse_intent("/diagnose a.png")
    assert intent.action == "diagnose"
    assert intent.command_args["path"] == "a.png"


def test_parse_intent_diagnose_quoted_path():
    intent = parse_intent('/diagnose "/tmp/a b.png"')
    assert intent.action == "diagnose"
    assert intent.command_args["path"] == "/tmp/a b.png"


def test_parse_intent_recast_basic():
    intent = parse_intent("/recast a.png")
    assert intent.action == "recast"
    assert intent.command_args["path"] == "a.png"


def test_parse_intent_recast_quoted_path():
    intent = parse_intent('/recast "/tmp/a b.png"')
    assert intent.action == "recast"
    assert intent.command_args["path"] == "/tmp/a b.png"


def test_parse_intent_argue_basic():
    intent = parse_intent("/argue a.png b.png")
    assert intent.action == "argue"
    assert intent.command_args["paths"] == ["a.png", "b.png"]


def test_parse_intent_bridge_basic():
    intent = parse_intent("/bridge a.png b.png")
    assert intent.action == "bridge"
    assert intent.command_args["paths"] == ["a.png", "b.png"]


def test_parse_intent_argue_quoted_paths():
    intent = parse_intent('/argue "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "argue"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_bridge_quoted_paths():
    intent = parse_intent('/bridge "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "bridge"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_extract_dna_basic():
    intent = parse_intent("/extract_dna a.png b.png")
    assert intent.action == "extract_dna"
    assert intent.command_args["paths"] == ["a.png", "b.png"]


def test_parse_intent_extract_dna_quoted_paths():
    intent = parse_intent('/extract_dna "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "extract_dna"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_soul_leech_basic():
    intent = parse_intent("/soul_leech a.png")
    assert intent.action == "soul_leech"
    assert intent.command_args["paths"] == ["a.png"]


def test_parse_intent_soul_leech_quoted_paths():
    intent = parse_intent('/soul_leech "/tmp/a b.png" "/tmp/c d.png"')
    assert intent.action == "soul_leech"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png"]


def test_parse_intent_extract_rule_basic():
    intent = parse_intent("/extract_rule a.png b.png c.png")
    assert intent.action == "extract_rule"
    assert intent.command_args["paths"] == ["a.png", "b.png", "c.png"]


def test_parse_intent_odd_one_out_basic():
    intent = parse_intent("/odd_one_out a.png b.png c.png")
    assert intent.action == "odd_one_out"
    assert intent.command_args["paths"] == ["a.png", "b.png", "c.png"]


def test_parse_intent_triforce_basic():
    intent = parse_intent("/triforce a.png b.png c.png")
    assert intent.action == "triforce"
    assert intent.command_args["paths"] == ["a.png", "b.png", "c.png"]


def test_parse_intent_triforce_quoted_paths():
    intent = parse_intent('/triforce "/tmp/a b.png" "/tmp/c d.png" "/tmp/e f.png"')
    assert intent.action == "triforce"
    assert intent.command_args["paths"] == ["/tmp/a b.png", "/tmp/c d.png", "/tmp/e f.png"]


def test_parse_intent_canvas_context_rt_start():
    intent = parse_intent("/canvas_context_rt_start")
    assert intent.action == "canvas_context_rt_start"


def test_parse_intent_intent_infer_path():
    intent = parse_intent("/intent_infer a.json")
    assert intent.action == "intent_infer"
    assert intent.command_args["path"] == "a.json"


def test_parse_intent_intent_infer_quoted_path():
    intent = parse_intent('/intent_infer "/tmp/a b.json"')
    assert intent.action == "intent_infer"
    assert intent.command_args["path"] == "/tmp/a b.json"


def test_parse_intent_prompt_compile_path():
    intent = parse_intent("/prompt_compile a.json")
    assert intent.action == "prompt_compile"
    assert intent.command_args["path"] == "a.json"


def test_parse_intent_prompt_compile_quoted_path():
    intent = parse_intent('/prompt_compile "/tmp/a b.json"')
    assert intent.action == "prompt_compile"
    assert intent.command_args["path"] == "/tmp/a b.json"


def test_parse_intent_mother_generate_path():
    intent = parse_intent("/mother_generate a.json")
    assert intent.action == "mother_generate"
    assert intent.command_args["path"] == "a.json"


def test_parse_intent_mother_generate_quoted_path():
    intent = parse_intent('/mother_generate "/tmp/a b.json"')
    assert intent.action == "mother_generate"
    assert intent.command_args["path"] == "/tmp/a b.json"


def test_parse_intent_intent_infer_preserves_json_payload_spacing():
    intent = parse_intent("  /intent_infer   /tmp/mother payload.json  ")
    assert intent.action == "intent_infer"
    assert intent.command_args["path"] == "/tmp/mother payload.json"


def test_parse_intent_prompt_compile_preserves_json_payload_spacing():
    intent = parse_intent("  /prompt_compile   /tmp/mother compile.json  ")
    assert intent.action == "prompt_compile"
    assert intent.command_args["path"] == "/tmp/mother compile.json"


def test_parse_intent_canvas_context_rt_stop():
    intent = parse_intent("/canvas_context_rt_stop")
    assert intent.action == "canvas_context_rt_stop"


def test_parse_intent_canvas_context_rt_path():
    intent = parse_intent("/canvas_context_rt a.png")
    assert intent.action == "canvas_context_rt"
    assert intent.command_args["path"] == "a.png"


def test_parse_intent_canvas_context_rt_quoted_path():
    intent = parse_intent('/canvas_context_rt "/tmp/a b.png"')
    assert intent.action == "canvas_context_rt"
    assert intent.command_args["path"] == "/tmp/a b.png"


def test_parse_intent_intent_rt_start():
    intent = parse_intent("/intent_rt_start")
    assert intent.action == "intent_rt_start"


def test_parse_intent_intent_rt_stop():
    intent = parse_intent("/intent_rt_stop")
    assert intent.action == "intent_rt_stop"


def test_parse_intent_intent_rt_path():
    intent = parse_intent("/intent_rt a.png")
    assert intent.action == "intent_rt"
    assert intent.command_args["path"] == "a.png"


def test_parse_intent_intent_rt_quoted_path():
    intent = parse_intent('/intent_rt "/tmp/a b.png"')
    assert intent.action == "intent_rt"
    assert intent.command_args["path"] == "/tmp/a b.png"
