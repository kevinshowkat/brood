#[derive(Clone, Copy, Debug)]
pub(crate) struct CommandSpec {
    pub command: &'static str,
    pub action: &'static str,
}

pub(crate) const RAW_ARG_COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        command: "profile",
        action: "set_profile",
    },
    CommandSpec {
        command: "text_model",
        action: "set_text_model",
    },
    CommandSpec {
        command: "image_model",
        action: "set_image_model",
    },
];

pub(crate) const QUALITY_PRESET_COMMANDS: &[&str] = &["fast", "quality", "cheaper", "better"];

pub(crate) const SINGLE_PATH_COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        command: "recreate",
        action: "recreate",
    },
    CommandSpec {
        command: "describe",
        action: "describe",
    },
    CommandSpec {
        command: "canvas_context",
        action: "canvas_context",
    },
    CommandSpec {
        command: "intent_infer",
        action: "intent_infer",
    },
    CommandSpec {
        command: "prompt_compile",
        action: "prompt_compile",
    },
    CommandSpec {
        command: "mother_generate",
        action: "mother_generate",
    },
    CommandSpec {
        command: "canvas_context_rt",
        action: "canvas_context_rt",
    },
    CommandSpec {
        command: "intent_rt",
        action: "intent_rt",
    },
    CommandSpec {
        command: "intent_rt_mother",
        action: "intent_rt_mother",
    },
    CommandSpec {
        command: "diagnose",
        action: "diagnose",
    },
    CommandSpec {
        command: "recast",
        action: "recast",
    },
    CommandSpec {
        command: "use",
        action: "set_active_image",
    },
];

pub(crate) const MULTI_PATH_COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        command: "blend",
        action: "blend",
    },
    CommandSpec {
        command: "swap_dna",
        action: "swap_dna",
    },
    CommandSpec {
        command: "argue",
        action: "argue",
    },
    CommandSpec {
        command: "bridge",
        action: "bridge",
    },
    CommandSpec {
        command: "extract_dna",
        action: "extract_dna",
    },
    CommandSpec {
        command: "soul_leech",
        action: "soul_leech",
    },
    CommandSpec {
        command: "extract_rule",
        action: "extract_rule",
    },
    CommandSpec {
        command: "odd_one_out",
        action: "odd_one_out",
    },
    CommandSpec {
        command: "triforce",
        action: "triforce",
    },
];

pub(crate) const NO_ARG_COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        command: "canvas_context_rt_start",
        action: "canvas_context_rt_start",
    },
    CommandSpec {
        command: "canvas_context_rt_stop",
        action: "canvas_context_rt_stop",
    },
    CommandSpec {
        command: "intent_rt_start",
        action: "intent_rt_start",
    },
    CommandSpec {
        command: "intent_rt_stop",
        action: "intent_rt_stop",
    },
    CommandSpec {
        command: "intent_rt_mother_start",
        action: "intent_rt_mother_start",
    },
    CommandSpec {
        command: "intent_rt_mother_stop",
        action: "intent_rt_mother_stop",
    },
    CommandSpec {
        command: "help",
        action: "help",
    },
];

pub(crate) const EXPORT_COMMAND: CommandSpec = CommandSpec {
    command: "export",
    action: "export",
};

pub const CHAT_HELP_COMMANDS: &[&str] = &[
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
];
