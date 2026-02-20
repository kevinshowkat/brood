use super::registry::{ModelRegistry, ModelSpec};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelection {
    pub model: ModelSpec,
    pub requested: Option<String>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModelSelector {
    pub registry: ModelRegistry,
}

impl ModelSelector {
    pub fn new(registry: Option<ModelRegistry>) -> Self {
        Self {
            registry: registry.unwrap_or_else(|| ModelRegistry::new(None)),
        }
    }

    pub fn select(
        &self,
        requested: Option<&str>,
        capability: &str,
    ) -> Result<ModelSelection, String> {
        let (fallback_reason, requested_text) = if let Some(requested_value) = requested {
            if let Some(model) = self.registry.ensure(requested_value, capability) {
                return Ok(ModelSelection {
                    model,
                    requested: Some(requested_value.to_string()),
                    fallback_reason: None,
                });
            }
            (
                Some(format!(
                    "Requested model '{requested_value}' unavailable for capability '{capability}'."
                )),
                Some(requested_value.to_string()),
            )
        } else {
            (Some("No model specified; using default.".to_string()), None)
        };

        let candidates = self.registry.by_capability(capability);
        let Some(model) = candidates.first().cloned() else {
            return Err(format!(
                "No models available for capability '{capability}'."
            ));
        };
        Ok(ModelSelection {
            model,
            requested: requested_text,
            fallback_reason,
        })
    }
}
