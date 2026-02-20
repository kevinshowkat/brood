use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const RECEIPT_SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ImageInputs {
    pub init_image: Option<String>,
    pub mask: Option<String>,
    #[serde(default)]
    pub reference_images: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageRequest {
    pub prompt: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_size")]
    pub size: String,
    #[serde(default = "default_n")]
    pub n: u64,
    pub seed: Option<i64>,
    pub output_format: Option<String>,
    pub background: Option<String>,
    #[serde(default)]
    pub inputs: ImageInputs,
    pub provider: Option<String>,
    #[serde(default)]
    pub provider_options: Map<String, Value>,
    pub user: Option<String>,
    pub out_dir: Option<String>,
    #[serde(default)]
    pub stream: bool,
    pub partial_images: Option<u64>,
    pub model: Option<String>,
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedRequest {
    pub provider: String,
    pub model: Option<String>,
    pub size: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub output_format: String,
    pub background: Option<String>,
    pub seed: Option<i64>,
    pub n: u64,
    pub user: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub inputs: ImageInputs,
    #[serde(default)]
    pub stream: bool,
    pub partial_images: Option<u64>,
    #[serde(default)]
    pub provider_params: Map<String, Value>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

pub fn build_receipt(
    request: &ImageRequest,
    resolved: &ResolvedRequest,
    provider_request: &Map<String, Value>,
    provider_response: &Map<String, Value>,
    warnings: &[String],
    image_path: &Path,
    receipt_path: &Path,
    result_metadata: &Map<String, Value>,
) -> Value {
    let mut root = Map::new();
    root.insert(
        "schema_version".to_string(),
        Value::Number(RECEIPT_SCHEMA_VERSION.into()),
    );
    root.insert(
        "request".to_string(),
        sanitize_payload(&serde_json::to_value(request).unwrap_or(Value::Null)),
    );
    root.insert(
        "resolved".to_string(),
        sanitize_payload(&serde_json::to_value(resolved).unwrap_or(Value::Null)),
    );
    root.insert(
        "provider_request".to_string(),
        sanitize_payload(&Value::Object(provider_request.clone())),
    );
    root.insert(
        "provider_response".to_string(),
        sanitize_payload(&Value::Object(provider_response.clone())),
    );
    root.insert(
        "warnings".to_string(),
        Value::Array(warnings.iter().cloned().map(Value::String).collect()),
    );

    let mut artifacts = Map::new();
    artifacts.insert(
        "image_path".to_string(),
        Value::String(image_path.to_string_lossy().to_string()),
    );
    artifacts.insert(
        "receipt_path".to_string(),
        Value::String(receipt_path.to_string_lossy().to_string()),
    );
    root.insert("artifacts".to_string(), Value::Object(artifacts));
    root.insert(
        "result_metadata".to_string(),
        sanitize_payload(&Value::Object(result_metadata.clone())),
    );
    Value::Object(root)
}

pub fn write_receipt(path: &Path, payload: &Value) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(payload)?)?;
    Ok(())
}

fn sanitize_payload(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) | Value::Number(_) | Value::String(_) => value.clone(),
        Value::Array(rows) => Value::Array(rows.iter().map(sanitize_payload).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, row) in map {
                let lowered = key.to_ascii_lowercase();
                if matches!(
                    lowered.as_str(),
                    "b64_json" | "image" | "image_bytes" | "data"
                ) {
                    out.insert(key.clone(), Value::String("<omitted>".to_string()));
                    continue;
                }
                out.insert(key.clone(), sanitize_payload(row));
            }
            Value::Object(out)
        }
    }
}

fn default_mode() -> String {
    "generate".to_string()
}

fn default_size() -> String {
    "1024x1024".to_string()
}

fn default_n() -> u64 {
    1
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::{
        build_receipt, write_receipt, ImageInputs, ImageRequest, ResolvedRequest,
        RECEIPT_SCHEMA_VERSION,
    };

    #[test]
    fn receipt_builder_writes_expected_shape() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let receipt_path = temp.path().join("receipt-1.json");
        let image_path = temp.path().join("image.png");
        std::fs::write(&image_path, b"png")?;

        let request = ImageRequest {
            prompt: "hello".to_string(),
            mode: "generate".to_string(),
            size: "1024x1024".to_string(),
            n: 1,
            seed: Some(7),
            output_format: Some("png".to_string()),
            background: None,
            inputs: ImageInputs::default(),
            provider: Some("dryrun".to_string()),
            provider_options: Map::new(),
            user: None,
            out_dir: Some(temp.path().to_string_lossy().to_string()),
            stream: false,
            partial_images: None,
            model: Some("dryrun-image-1".to_string()),
            metadata: Map::new(),
        };
        let resolved = ResolvedRequest {
            provider: "dryrun".to_string(),
            model: Some("dryrun-image-1".to_string()),
            size: "1024x1024".to_string(),
            width: Some(1024),
            height: Some(1024),
            output_format: "png".to_string(),
            background: None,
            seed: Some(7),
            n: 1,
            user: None,
            prompt: "hello".to_string(),
            inputs: ImageInputs::default(),
            stream: false,
            partial_images: None,
            provider_params: Map::new(),
            warnings: Vec::new(),
        };
        let mut provider_request = Map::new();
        provider_request.insert("endpoint".to_string(), json!("dryrun"));
        let mut provider_response = Map::new();
        provider_response.insert("status".to_string(), json!("ok"));
        let warnings = vec!["note".to_string()];
        let mut result_metadata = Map::new();
        result_metadata.insert("cost_total_usd".to_string(), Value::Null);
        result_metadata.insert("latency_per_image_s".to_string(), json!(0.01));

        let payload = build_receipt(
            &request,
            &resolved,
            &provider_request,
            &provider_response,
            &warnings,
            &image_path,
            &receipt_path,
            &result_metadata,
        );
        write_receipt(&receipt_path, &payload)?;

        let raw = std::fs::read_to_string(&receipt_path)?;
        let parsed: Value = serde_json::from_str(&raw)?;
        assert_eq!(parsed["schema_version"], json!(RECEIPT_SCHEMA_VERSION));
        assert_eq!(parsed["request"]["prompt"], json!("hello"));
        assert_eq!(parsed["resolved"]["provider"], json!("dryrun"));
        assert_eq!(
            parsed["artifacts"]["image_path"],
            json!(image_path.to_string_lossy())
        );
        assert_eq!(
            parsed["result_metadata"]["latency_per_image_s"],
            json!(0.01)
        );
        Ok(())
    }
}
