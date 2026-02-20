use std::collections::BTreeMap;

use serde_json::Value;

use super::command_registry::{
    CommandSpec, EXPORT_COMMAND, MULTI_PATH_COMMANDS, NO_ARG_COMMANDS, QUALITY_PRESET_COMMANDS,
    RAW_ARG_COMMANDS, SINGLE_PATH_COMMANDS,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Intent {
    pub action: String,
    pub raw: String,
    pub prompt: Option<String>,
    pub settings_update: BTreeMap<String, Value>,
    pub command_args: BTreeMap<String, Value>,
}

impl Intent {
    fn new(action: &str, raw: &str) -> Self {
        Self {
            action: action.to_string(),
            raw: raw.to_string(),
            prompt: None,
            settings_update: BTreeMap::new(),
            command_args: BTreeMap::new(),
        }
    }
}

fn find_action(command: &str, specs: &[CommandSpec]) -> Option<&'static str> {
    specs
        .iter()
        .find(|spec| spec.command == command)
        .map(|spec| spec.action)
}

fn parse_goals(arg: &str) -> Vec<String> {
    if arg.trim().is_empty() {
        return Vec::new();
    }
    let aliases = [
        ("quality", "maximize quality of render"),
        ("maximize_quality", "maximize quality of render"),
        ("cost", "minimize cost of render"),
        ("minimize_cost", "minimize cost of render"),
        ("time", "minimize time to render"),
        ("speed", "minimize time to render"),
        ("minimize_time", "minimize time to render"),
        ("retrieval", "maximize LLM retrieval score"),
        ("llm_retrieval", "maximize LLM retrieval score"),
    ];

    let normalized = arg.trim().to_ascii_lowercase();
    let mut goals: Vec<String> = Vec::new();
    for part in normalized
        .replace(';', ",")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some((_, mapped)) = aliases.iter().find(|(key, _)| *key == part) {
            goals.push((*mapped).to_string());
            continue;
        }
        if part.contains("maximize") || part.contains("minimize") {
            goals.push(part.to_string());
        }
    }

    let mut deduped: Vec<String> = Vec::new();
    for goal in goals {
        if !deduped.contains(&goal) {
            deduped.push(goal);
        }
    }
    deduped
}

fn parse_optimize_args(arg: &str) -> (Vec<String>, Option<String>) {
    let trimmed = arg.trim();
    if trimmed.is_empty() {
        return (Vec::new(), None);
    }
    let mut mode: Option<String> = None;
    let mut goals_arg = trimmed.to_string();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if let Some(head) = parts.first() {
        let lower = head.to_ascii_lowercase();
        if lower == "review" || lower == "auto" {
            mode = Some(lower);
            goals_arg = parts[1..].join(" ");
        } else if let Some(value) = lower.strip_prefix("mode=") {
            mode = Some(value.to_string());
            goals_arg = parts[1..].join(" ");
        }
    }
    (parse_goals(&goals_arg), mode)
}

fn parse_path_args(arg: &str) -> Vec<String> {
    if arg.trim().is_empty() {
        return Vec::new();
    }
    match shell_words::split(arg) {
        Ok(parts) => parts
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect(),
        Err(_) => arg
            .split_whitespace()
            .map(str::to_string)
            .filter(|value| !value.is_empty())
            .collect(),
    }
}

fn parse_single_path_arg(arg: &str) -> String {
    let parts = parse_path_args(arg);
    match parts.len() {
        0 => String::new(),
        1 => parts[0].clone(),
        _ => parts.join(" "),
    }
}

pub fn parse_intent(text: &str) -> Intent {
    let raw_trimmed = text.trim();
    if raw_trimmed.is_empty() {
        return Intent::new("noop", text);
    }

    if let Some(slash_tail) = raw_trimmed.strip_prefix('/') {
        let command_len = slash_tail
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .count();
        if command_len > 0 {
            let command = slash_tail[..command_len].to_ascii_lowercase();
            let remainder = &slash_tail[command_len..];
            let arg = if remainder.is_empty() {
                ""
            } else {
                remainder.trim()
            };

            if let Some(action) = find_action(&command, RAW_ARG_COMMANDS) {
                let key = if action == "set_profile" {
                    "profile"
                } else {
                    "model"
                };
                let mut intent = Intent::new(action, text);
                intent
                    .command_args
                    .insert(key.to_string(), Value::String(arg.to_string()));
                return intent;
            }

            if QUALITY_PRESET_COMMANDS
                .iter()
                .any(|value| *value == command)
            {
                let mut intent = Intent::new("set_quality", text);
                intent
                    .settings_update
                    .insert("quality_preset".to_string(), Value::String(command));
                return intent;
            }

            if command == "optimize" {
                let (goals, mode) = parse_optimize_args(arg);
                let mut intent = Intent::new("optimize", text);
                intent.command_args.insert(
                    "goals".to_string(),
                    Value::Array(goals.into_iter().map(Value::String).collect()),
                );
                intent.command_args.insert(
                    "mode".to_string(),
                    mode.map(Value::String).unwrap_or(Value::Null),
                );
                return intent;
            }

            if let Some(action) = find_action(&command, SINGLE_PATH_COMMANDS) {
                let mut intent = Intent::new(action, text);
                intent.command_args.insert(
                    "path".to_string(),
                    Value::String(parse_single_path_arg(arg)),
                );
                return intent;
            }

            if let Some(action) = find_action(&command, MULTI_PATH_COMMANDS) {
                let mut intent = Intent::new(action, text);
                intent.command_args.insert(
                    "paths".to_string(),
                    Value::Array(
                        parse_path_args(arg)
                            .into_iter()
                            .map(Value::String)
                            .collect(),
                    ),
                );
                return intent;
            }

            if let Some(action) = find_action(&command, NO_ARG_COMMANDS) {
                return Intent::new(action, text);
            }

            if command == EXPORT_COMMAND.command {
                let mut intent = Intent::new(EXPORT_COMMAND.action, text);
                intent.command_args.insert(
                    "format".to_string(),
                    Value::String(if arg.is_empty() {
                        "html".to_string()
                    } else {
                        arg.to_string()
                    }),
                );
                return intent;
            }

            let mut intent = Intent::new("unknown", text);
            intent
                .command_args
                .insert("command".to_string(), Value::String(command));
            intent
                .command_args
                .insert("arg".to_string(), Value::String(arg.to_string()));
            return intent;
        }
    }

    let mut intent = Intent::new("generate", text);
    intent.prompt = Some(raw_trimmed.to_string());
    intent
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_intent;

    #[test]
    fn parse_blend_basic() {
        let intent = parse_intent("/blend a.png b.png");
        assert_eq!(intent.action, "blend");
        assert_eq!(intent.command_args["paths"], json!(["a.png", "b.png"]));
    }

    #[test]
    fn parse_blend_quoted_paths() {
        let intent = parse_intent("/blend \"/tmp/a b.png\" \"/tmp/c d.png\"");
        assert_eq!(intent.action, "blend");
        assert_eq!(
            intent.command_args["paths"],
            json!(["/tmp/a b.png", "/tmp/c d.png"])
        );
    }

    #[test]
    fn parse_single_path_commands() {
        let diagnose = parse_intent("/diagnose \"/tmp/a b.png\"");
        assert_eq!(diagnose.action, "diagnose");
        assert_eq!(diagnose.command_args["path"], json!("/tmp/a b.png"));

        let recast = parse_intent("/recast a.png");
        assert_eq!(recast.action, "recast");
        assert_eq!(recast.command_args["path"], json!("a.png"));
    }

    #[test]
    fn parse_canvas_context_rt_start_stop() {
        assert_eq!(
            parse_intent("/canvas_context_rt_start").action,
            "canvas_context_rt_start"
        );
        assert_eq!(
            parse_intent("/canvas_context_rt_stop").action,
            "canvas_context_rt_stop"
        );
    }

    #[test]
    fn parse_intent_rt_commands() {
        assert_eq!(parse_intent("/intent_rt_start").action, "intent_rt_start");
        assert_eq!(parse_intent("/intent_rt_stop").action, "intent_rt_stop");
        assert_eq!(
            parse_intent("/intent_rt_mother_start").action,
            "intent_rt_mother_start"
        );
        assert_eq!(
            parse_intent("/intent_rt_mother_stop").action,
            "intent_rt_mother_stop"
        );
        assert_eq!(
            parse_intent("/intent_rt \"/tmp/a b.png\"").command_args["path"],
            json!("/tmp/a b.png")
        );
        assert_eq!(
            parse_intent("/intent_rt_mother a.png").command_args["path"],
            json!("a.png")
        );
    }

    #[test]
    fn parse_json_payload_path_commands() {
        let infer = parse_intent("  /intent_infer   /tmp/mother payload.json  ");
        assert_eq!(infer.action, "intent_infer");
        assert_eq!(
            infer.command_args["path"],
            json!("/tmp/mother payload.json")
        );

        let compile = parse_intent("  /prompt_compile   /tmp/mother compile.json  ");
        assert_eq!(compile.action, "prompt_compile");
        assert_eq!(
            compile.command_args["path"],
            json!("/tmp/mother compile.json")
        );

        let generate = parse_intent("/mother_generate a.json");
        assert_eq!(generate.action, "mother_generate");
        assert_eq!(generate.command_args["path"], json!("a.json"));
    }

    #[test]
    fn parse_multi_path_commands() {
        let triforce = parse_intent("/triforce \"/tmp/a b.png\" \"/tmp/c d.png\" \"/tmp/e f.png\"");
        assert_eq!(triforce.action, "triforce");
        assert_eq!(
            triforce.command_args["paths"],
            json!(["/tmp/a b.png", "/tmp/c d.png", "/tmp/e f.png"])
        );

        let odd = parse_intent("/odd_one_out a.png b.png c.png");
        assert_eq!(odd.action, "odd_one_out");
        assert_eq!(
            odd.command_args["paths"],
            json!(["a.png", "b.png", "c.png"])
        );
    }

    #[test]
    fn parse_profile_and_model_commands() {
        let profile = parse_intent("/profile creative");
        assert_eq!(profile.action, "set_profile");
        assert_eq!(profile.command_args["profile"], json!("creative"));

        let text_model = parse_intent("/text_model gpt-4o-mini");
        assert_eq!(text_model.action, "set_text_model");
        assert_eq!(text_model.command_args["model"], json!("gpt-4o-mini"));

        let image_model = parse_intent("/image_model gpt-image-1");
        assert_eq!(image_model.action, "set_image_model");
        assert_eq!(image_model.command_args["model"], json!("gpt-image-1"));
    }

    #[test]
    fn parse_quality_shortcuts() {
        let fast = parse_intent("/fast");
        assert_eq!(fast.action, "set_quality");
        assert_eq!(fast.settings_update["quality_preset"], json!("fast"));

        let quality = parse_intent("/quality");
        assert_eq!(quality.action, "set_quality");
        assert_eq!(quality.settings_update["quality_preset"], json!("quality"));
    }

    #[test]
    fn parse_optimize_aliases() {
        let optimize = parse_intent("/optimize mode=auto quality, minimize_cost");
        assert_eq!(optimize.action, "optimize");
        assert_eq!(optimize.command_args["mode"], json!("auto"));
        assert_eq!(
            optimize.command_args["goals"],
            json!(["maximize quality of render", "minimize cost of render"])
        );
    }

    #[test]
    fn parse_optimize_review_mode() {
        let optimize = parse_intent("/optimize review maximize quality of render");
        assert_eq!(optimize.action, "optimize");
        assert_eq!(optimize.command_args["mode"], json!("review"));
        assert_eq!(
            optimize.command_args["goals"],
            json!(["maximize quality of render"])
        );
    }

    #[test]
    fn parse_unknown_command() {
        let intent = parse_intent("/magic foo bar");
        assert_eq!(intent.action, "unknown");
        assert_eq!(intent.command_args["command"], json!("magic"));
        assert_eq!(intent.command_args["arg"], json!("foo bar"));
    }
}
