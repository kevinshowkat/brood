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


def test_parse_intent_recast_basic():
    intent = parse_intent("/recast a.png")
    assert intent.action == "recast"
    assert intent.command_args["path"] == "a.png"


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
