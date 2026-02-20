#[derive(Debug, Clone)]
pub struct ProviderRegistry<T: NamedProvider> {
    providers: Vec<T>,
}

pub trait NamedProvider {
    fn name(&self) -> &str;
}

impl<T: NamedProvider> ProviderRegistry<T> {
    pub fn new(providers: Vec<T>) -> Self {
        Self { providers }
    }

    pub fn get(&self, name: &str) -> Option<&T> {
        self.providers
            .iter()
            .find(|provider| provider.name() == name)
    }

    pub fn list(&self) -> Vec<String> {
        let mut names = self
            .providers
            .iter()
            .map(|provider| provider.name().to_string())
            .collect::<Vec<String>>();
        names.sort();
        names
    }

    pub fn providers(&self) -> &[T] {
        self.providers.as_slice()
    }
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use crate::models::{ModelRegistry, ModelSelector, ModelSpec};

    use super::{NamedProvider, ProviderRegistry};

    #[derive(Clone, Debug)]
    struct DummyProvider {
        name: String,
    }

    impl NamedProvider for DummyProvider {
        fn name(&self) -> &str {
            self.name.as_str()
        }
    }

    fn image_model(name: &str) -> ModelSpec {
        ModelSpec {
            name: name.to_string(),
            provider: "dryrun".to_string(),
            capabilities: vec!["image".to_string()],
            context_window: None,
            pricing_key: Some(name.to_string()),
            latency_key: Some(name.to_string()),
        }
    }

    #[test]
    fn model_selector_falls_back_when_requested_model_unavailable() {
        let mut models = IndexMap::new();
        models.insert(
            "gpt-image-fallback".to_string(),
            image_model("gpt-image-fallback"),
        );
        let selection = ModelSelector::new(Some(ModelRegistry::new(Some(models))))
            .select(Some("missing"), "image")
            .unwrap();
        assert_eq!(selection.model.name, "gpt-image-fallback");
        assert_eq!(selection.requested.as_deref(), Some("missing"));
        assert_eq!(
            selection.fallback_reason.as_deref(),
            Some("Requested model 'missing' unavailable for capability 'image'.")
        );
    }

    #[test]
    fn model_selector_no_request_uses_default_with_explanation() {
        let mut models = IndexMap::new();
        models.insert(
            "gpt-image-default".to_string(),
            image_model("gpt-image-default"),
        );
        let selection = ModelSelector::new(Some(ModelRegistry::new(Some(models))))
            .select(None, "image")
            .unwrap();
        assert_eq!(selection.model.name, "gpt-image-default");
        assert_eq!(
            selection.fallback_reason.as_deref(),
            Some("No model specified; using default.")
        );
    }

    #[test]
    fn model_selector_raises_when_no_models_for_capability() {
        let mut models = IndexMap::new();
        models.insert(
            "text-only".to_string(),
            ModelSpec {
                name: "text-only".to_string(),
                provider: "dryrun".to_string(),
                capabilities: vec!["text".to_string()],
                context_window: None,
                pricing_key: None,
                latency_key: None,
            },
        );
        let err = ModelSelector::new(Some(ModelRegistry::new(Some(models))))
            .select(Some("gpt-image-1"), "image")
            .err()
            .unwrap_or_default();
        assert_eq!(err, "No models available for capability 'image'.");
    }

    #[test]
    fn model_selector_respects_provider_registry_order() {
        let registry = ProviderRegistry::new(vec![
            DummyProvider {
                name: "z".to_string(),
            },
            DummyProvider {
                name: "a".to_string(),
            },
            DummyProvider {
                name: "m".to_string(),
            },
        ]);
        assert_eq!(registry.list(), vec!["a", "m", "z"]);
        assert_eq!(
            registry
                .providers()
                .iter()
                .map(|provider| provider.name().to_string())
                .collect::<Vec<String>>(),
            vec!["z", "a", "m"]
        );
    }
}
