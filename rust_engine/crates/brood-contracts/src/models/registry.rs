use indexmap::IndexMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSpec {
    pub name: String,
    pub provider: String,
    pub capabilities: Vec<String>,
    pub context_window: Option<u64>,
    pub pricing_key: Option<String>,
    pub latency_key: Option<String>,
}

impl ModelSpec {
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|item| item == capability)
    }
}

#[derive(Debug, Clone)]
pub struct ModelRegistry {
    models: IndexMap<String, ModelSpec>,
}

impl ModelRegistry {
    pub fn new(models: Option<IndexMap<String, ModelSpec>>) -> Self {
        Self {
            models: models.unwrap_or_else(default_models),
        }
    }

    pub fn get(&self, name: &str) -> Option<&ModelSpec> {
        self.models.get(name)
    }

    pub fn list(&self) -> impl Iterator<Item = &ModelSpec> {
        self.models.values()
    }

    pub fn by_capability(&self, capability: &str) -> Vec<ModelSpec> {
        self.models
            .values()
            .filter(|model| model.supports(capability))
            .cloned()
            .collect()
    }

    pub fn ensure(&self, name: &str, capability: &str) -> Option<ModelSpec> {
        let model = self.get(name)?;
        if model.supports(capability) {
            return Some(model.clone());
        }
        None
    }
}

fn default_models() -> IndexMap<String, ModelSpec> {
    let mut map = IndexMap::new();

    let mut insert = |name: &str,
                      provider: &str,
                      capabilities: &[&str],
                      context_window: Option<u64>,
                      pricing_key: Option<&str>,
                      latency_key: Option<&str>| {
        map.insert(
            name.to_string(),
            ModelSpec {
                name: name.to_string(),
                provider: provider.to_string(),
                capabilities: capabilities
                    .iter()
                    .map(|item| (*item).to_string())
                    .collect(),
                context_window,
                pricing_key: pricing_key.map(str::to_string),
                latency_key: latency_key.map(str::to_string),
            },
        );
    };

    insert(
        "dryrun-text-1",
        "dryrun",
        &["text"],
        Some(8192),
        Some("dryrun-text"),
        Some("dryrun-text"),
    );
    insert(
        "dryrun-image-1",
        "dryrun",
        &["image", "edit"],
        None,
        Some("dryrun-image"),
        Some("dryrun-image"),
    );
    insert(
        "gpt-image-1.5",
        "openai",
        &["image"],
        None,
        Some("openai-gpt-image-1.5"),
        Some("openai-gpt-image-1.5"),
    );
    insert(
        "gpt-image-1-mini",
        "openai",
        &["image"],
        None,
        Some("openai-gpt-image-1-mini"),
        Some("openai-gpt-image-1-mini"),
    );
    insert(
        "gpt-image-1",
        "openai",
        &["image"],
        None,
        Some("openai-gpt-image-1"),
        Some("openai-gpt-image-1"),
    );
    insert(
        "gpt-4o-mini",
        "openai",
        &["text", "vision"],
        Some(128000),
        Some("openai-gpt-4o-mini"),
        Some("openai-gpt-4o-mini"),
    );
    insert(
        "gpt-5.2",
        "openai",
        &["text"],
        Some(128000),
        Some("openai-gpt-5.2"),
        Some("openai-gpt-5.2"),
    );
    insert(
        "gpt-5.1-codex-max",
        "openai",
        &["text", "vision"],
        None,
        Some("openai-gpt-5.1-codex-max"),
        Some("openai-gpt-5.1-codex-max"),
    );
    insert(
        "claude-opus-4-5-20251101",
        "anthropic",
        &["text"],
        Some(200000),
        Some("anthropic-claude-opus-4-5-20251101"),
        Some("anthropic-claude-opus-4-5-20251101"),
    );
    insert(
        "gemini-3-pro-preview",
        "gemini",
        &["text", "vision"],
        Some(128000),
        Some("google-gemini-3-pro-preview"),
        Some("google-gemini-3-pro-preview"),
    );
    insert(
        "gemini-2.5-flash-image",
        "gemini",
        &["image"],
        None,
        Some("google-gemini-2.5-flash-image"),
        Some("google-gemini-2.5-flash-image"),
    );
    insert(
        "gemini-3-pro-image-preview",
        "gemini",
        &["image"],
        None,
        Some("google-gemini-3-pro-image-preview"),
        Some("google-gemini-3-pro-image-preview"),
    );
    insert(
        "imagen-4.0-ultra",
        "imagen",
        &["image"],
        None,
        Some("google-imagen-4.0-ultra"),
        Some("google-imagen-4.0-ultra"),
    );
    insert(
        "imagen-4",
        "imagen",
        &["image"],
        None,
        Some("google-imagen-4"),
        Some("google-imagen-4"),
    );
    insert(
        "flux-2-flex",
        "flux",
        &["image", "edit"],
        None,
        Some("flux-2-flex"),
        Some("flux-2-flex"),
    );
    insert(
        "flux-2-pro",
        "flux",
        &["image", "edit"],
        None,
        Some("flux-2-pro"),
        Some("flux-2-pro"),
    );
    insert(
        "flux-2-max",
        "flux",
        &["image", "edit"],
        None,
        Some("flux-2-max"),
        Some("flux-2-max"),
    );
    insert(
        "flux-2",
        "flux",
        &["image", "edit"],
        None,
        Some("flux-2"),
        Some("flux-2"),
    );
    insert(
        "sdxl",
        "replicate",
        &["image"],
        None,
        Some("replicate-sdxl"),
        Some("replicate-sdxl"),
    );
    insert(
        "sd3-large",
        "stability",
        &["image"],
        None,
        Some("stability-sd3-large"),
        Some("stability-sd3-large"),
    );
    insert(
        "fal-ai/fast-sdxl",
        "fal",
        &["image"],
        None,
        Some("fal-fast-sdxl"),
        Some("fal-fast-sdxl"),
    );

    map
}
