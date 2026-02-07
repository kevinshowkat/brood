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
