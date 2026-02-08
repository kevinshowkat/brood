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
