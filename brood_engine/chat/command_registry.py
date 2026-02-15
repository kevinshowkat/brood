"""Shared slash-command metadata for parse + chat handling."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CommandSpec:
    command: str
    action: str
    arg_kind: str


RAW_ARG_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("profile", "set_profile", "raw"),
    CommandSpec("text_model", "set_text_model", "raw"),
    CommandSpec("image_model", "set_image_model", "raw"),
)

QUALITY_PRESET_COMMANDS = {"fast", "quality", "cheaper", "better"}

SINGLE_PATH_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("recreate", "recreate", "single_path"),
    CommandSpec("describe", "describe", "single_path"),
    CommandSpec("canvas_context", "canvas_context", "single_path"),
    CommandSpec("intent_infer", "intent_infer", "single_path"),
    CommandSpec("prompt_compile", "prompt_compile", "single_path"),
    CommandSpec("mother_generate", "mother_generate", "single_path"),
    CommandSpec("canvas_context_rt", "canvas_context_rt", "single_path"),
    CommandSpec("intent_rt", "intent_rt", "single_path"),
    CommandSpec("intent_rt_mother", "intent_rt_mother", "single_path"),
    CommandSpec("diagnose", "diagnose", "single_path"),
    CommandSpec("recast", "recast", "single_path"),
    CommandSpec("use", "set_active_image", "single_path"),
)

MULTI_PATH_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("blend", "blend", "multi_path"),
    CommandSpec("swap_dna", "swap_dna", "multi_path"),
    CommandSpec("argue", "argue", "multi_path"),
    CommandSpec("bridge", "bridge", "multi_path"),
    CommandSpec("extract_dna", "extract_dna", "multi_path"),
    CommandSpec("soul_leech", "soul_leech", "multi_path"),
    CommandSpec("extract_rule", "extract_rule", "multi_path"),
    CommandSpec("odd_one_out", "odd_one_out", "multi_path"),
    CommandSpec("triforce", "triforce", "multi_path"),
)

NO_ARG_COMMANDS: tuple[CommandSpec, ...] = (
    CommandSpec("canvas_context_rt_start", "canvas_context_rt_start", "none"),
    CommandSpec("canvas_context_rt_stop", "canvas_context_rt_stop", "none"),
    CommandSpec("intent_rt_start", "intent_rt_start", "none"),
    CommandSpec("intent_rt_stop", "intent_rt_stop", "none"),
    CommandSpec("intent_rt_mother_start", "intent_rt_mother_start", "none"),
    CommandSpec("intent_rt_mother_stop", "intent_rt_mother_stop", "none"),
    CommandSpec("help", "help", "none"),
)

EXPORT_COMMAND = CommandSpec("export", "export", "raw_default_html")

RAW_ARG_COMMAND_MAP = {spec.command: spec.action for spec in RAW_ARG_COMMANDS}
SINGLE_PATH_COMMAND_MAP = {spec.command: spec.action for spec in SINGLE_PATH_COMMANDS}
MULTI_PATH_COMMAND_MAP = {spec.command: spec.action for spec in MULTI_PATH_COMMANDS}
NO_ARG_COMMAND_MAP = {spec.command: spec.action for spec in NO_ARG_COMMANDS}

CHAT_HELP_COMMANDS: tuple[str, ...] = (
    "/profile",
    "/text_model",
    "/image_model",
    "/fast",
    "/quality",
    "/cheaper",
    "/better",
    "/optimize",
    "/recreate",
    "/describe",
    "/canvas_context",
    "/intent_infer",
    "/prompt_compile",
    "/mother_generate",
    "/diagnose",
    "/recast",
    "/use",
    "/canvas_context_rt_start",
    "/canvas_context_rt_stop",
    "/canvas_context_rt",
    "/intent_rt_start",
    "/intent_rt_stop",
    "/intent_rt",
    "/intent_rt_mother_start",
    "/intent_rt_mother_stop",
    "/intent_rt_mother",
    "/blend",
    "/swap_dna",
    "/argue",
    "/bridge",
    "/extract_dna",
    "/soul_leech",
    "/extract_rule",
    "/odd_one_out",
    "/triforce",
    "/export",
)

