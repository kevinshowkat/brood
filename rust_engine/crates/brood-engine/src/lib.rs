use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use brood_contracts::events::{EventPayload, EventWriter};
use brood_contracts::models::{ModelSelector, ModelSpec};
use brood_contracts::runs::cache::CacheStore;
use brood_contracts::runs::receipts::{
    build_receipt, write_receipt, ImageInputs, ImageRequest, ResolvedRequest,
};
use brood_contracts::runs::summary::{write_summary, RunSummary};
use brood_contracts::runs::thread_manifest::ThreadManifest;
use image::{Rgb, RgbImage};
use reqwest::blocking::multipart::{Form as MultipartForm, Part as MultipartPart};
use reqwest::blocking::{Client as HttpClient, Response as HttpResponse};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const DEFAULT_PRICING_TABLES_JSON: &str = include_str!("../resources/default_pricing.json");

#[derive(Debug, Clone)]
pub struct PlanPreview {
    pub images: u64,
    pub model: String,
    pub provider: String,
    pub size: String,
    pub cached: bool,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub max_tokens: u64,
    pub pct: f64,
    pub alert_level: String,
}

#[derive(Debug, Clone)]
pub struct CostLatencyMetrics {
    pub provider: String,
    pub model: String,
    pub cost_total_usd: f64,
    pub cost_per_1k_images_usd: f64,
    pub latency_per_image_s: f64,
}

#[derive(Debug, Clone, Copy)]
struct ImageCostEstimate {
    cost_per_image_usd: Option<f64>,
    cost_per_1k_images_usd: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ProviderImageResult {
    pub image_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub seed: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ProviderGenerateRequest {
    pub run_dir: PathBuf,
    pub prompt: String,
    pub size: String,
    pub n: u64,
    pub seed: Option<i64>,
    pub output_format: String,
    pub background: Option<String>,
    pub inputs: ImageInputs,
    pub model: String,
    pub provider_options: Map<String, Value>,
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct ProviderGenerateResponse {
    pub provider_request: Map<String, Value>,
    pub provider_response: Map<String, Value>,
    pub warnings: Vec<String>,
    pub results: Vec<ProviderImageResult>,
}

pub trait ImageProvider: Send + Sync {
    fn name(&self) -> &str;
    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse>;
}

#[derive(Default)]
pub struct ImageProviderRegistry {
    providers: BTreeMap<String, Box<dyn ImageProvider>>,
}

impl ImageProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<P: ImageProvider + 'static>(&mut self, provider: P) {
        self.providers
            .insert(provider.name().to_string(), Box::new(provider));
    }

    pub fn get(&self, name: &str) -> Option<&dyn ImageProvider> {
        self.providers.get(name).map(|provider| provider.as_ref())
    }

    pub fn names(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }
}

struct DryrunProvider;

impl ImageProvider for DryrunProvider {
    fn name(&self) -> &str {
        "dryrun"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let (width, height) = parse_dims(&request.size);
        let mut results = Vec::new();
        let stamp = chrono::Utc::now().timestamp_millis();
        let ext = normalize_output_extension(&request.output_format);

        for idx in 0..request.n {
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            write_dryrun_image(&image_path, width, height, &request.prompt, request.seed)?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": "dryrun-native",
                "payload": {
                    "prompt": request.prompt,
                    "size": request.size,
                    "n": request.n,
                    "seed": request.seed,
                    "output_format": request.output_format,
                    "background": request.background,
                    "inputs": request.inputs,
                }
            })),
            provider_response: map_object(json!({
                "status": "ok",
                "count": results.len(),
                "model": request.model,
            })),
            warnings: Vec::new(),
            results,
        })
    }
}

struct ReplicateProvider {
    api_base: String,
    http: HttpClient,
}

impl ReplicateProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("REPLICATE_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://api.replicate.com/v1".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("REPLICATE_API_TOKEN").or_else(|| non_empty_env("REPLICATE_API_KEY"))
    }

    fn resolve_model(request: &ProviderGenerateRequest) -> String {
        if let Some(model) = request
            .provider_options
            .get("replicate_model")
            .or_else(|| request.provider_options.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return model.to_string();
        }
        let normalized = request.model.trim().to_ascii_lowercase();
        if normalized == "sdxl" {
            return "stability-ai/sdxl".to_string();
        }
        request.model.trim().to_string()
    }

    fn poll_interval_seconds(request: &ProviderGenerateRequest) -> f64 {
        request
            .provider_options
            .get("poll_interval")
            .and_then(Value::as_f64)
            .unwrap_or(1.0)
            .clamp(0.2, 5.0)
    }

    fn poll_timeout_seconds(request: &ProviderGenerateRequest) -> f64 {
        request
            .provider_options
            .get("poll_timeout")
            .and_then(Value::as_f64)
            .unwrap_or(120.0)
            .clamp(10.0, 600.0)
    }

    fn predictions_endpoint(&self) -> String {
        format!("{}/predictions", self.api_base)
    }

    fn poll_prediction(
        &self,
        poll_url: &str,
        api_key: &str,
        poll_interval_s: f64,
        poll_timeout_s: f64,
    ) -> Result<Value> {
        let started = Instant::now();
        loop {
            let response = self
                .http
                .get(poll_url)
                .bearer_auth(api_key)
                .send()
                .with_context(|| format!("Replicate poll request failed ({poll_url})"))?;
            let payload = response_json_or_error("Replicate poll", response)?;
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if status == "succeeded" {
                return Ok(payload);
            }
            if matches!(status.as_str(), "failed" | "canceled") {
                bail!("Replicate prediction failed: {}", payload);
            }
            if started.elapsed().as_secs_f64() >= poll_timeout_s {
                bail!("Replicate polling timed out after {:.1}s", poll_timeout_s);
            }
            thread::sleep(Duration::from_secs_f64(poll_interval_s));
        }
    }

    fn extract_output_urls(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(url) => {
                let trimmed = url.trim();
                if !trimmed.is_empty()
                    && trimmed.starts_with("http")
                    && !out.iter().any(|existing| existing == trimmed)
                {
                    out.push(trimmed.to_string());
                }
            }
            Value::Array(rows) => {
                for row in rows {
                    Self::extract_output_urls(row, out);
                }
            }
            Value::Object(obj) => {
                if let Some(url) = obj.get("url") {
                    Self::extract_output_urls(url, out);
                }
                if let Some(urls) = obj.get("urls") {
                    Self::extract_output_urls(urls, out);
                }
                if let Some(output) = obj.get("output") {
                    Self::extract_output_urls(output, out);
                }
            }
            _ => {}
        }
    }

    fn download_image(&self, url: &str) -> Result<ImageBytes> {
        let response = self
            .http
            .get(url)
            .send()
            .with_context(|| format!("failed downloading Replicate image ({url})"))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            bail!(
                "Replicate image download failed ({code}): {}",
                truncate_text(&body, 512)
            );
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .context("failed reading Replicate image bytes")?
            .to_vec();
        Ok(ImageBytes { bytes, mime_type })
    }
}

impl ImageProvider for ReplicateProvider {
    fn name(&self) -> &str {
        "replicate"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let Some(api_key) = Self::api_key() else {
            bail!("REPLICATE_API_TOKEN not set");
        };
        if request.inputs.init_image.is_some()
            || !request.inputs.reference_images.is_empty()
            || request.inputs.mask.is_some()
        {
            bail!("Replicate provider currently supports text-to-image only.");
        }

        let endpoint = self.predictions_endpoint();
        let model = Self::resolve_model(request);
        let (width, height) = parse_dims(&request.size);
        let poll_interval_s = Self::poll_interval_seconds(request);
        let poll_timeout_s = Self::poll_timeout_seconds(request);
        let mut warnings = Vec::new();
        let output_format = normalize_output_extension(&request.output_format).to_string();

        let mut provider_payloads: Vec<Value> = Vec::new();
        let mut prediction_ids: Vec<String> = Vec::new();
        let mut results: Vec<ProviderImageResult> = Vec::new();
        let mut last_status = Value::Null;
        let stamp = timestamp_millis();

        for idx in 0..request.n.max(1) {
            let mut input = map_object(json!({
                "prompt": request.prompt,
                "width": width,
                "height": height,
                "output_format": output_format,
            }));
            if let Some(seed) = request.seed {
                let variant_seed = seed.saturating_add(idx as i64);
                input.insert("seed".to_string(), Value::Number(variant_seed.into()));
            }
            for (key, value) in &request.provider_options {
                let normalized = key.trim().to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "replicate_model" | "model" | "poll_interval" | "poll_timeout"
                ) {
                    continue;
                }
                if input.contains_key(key) {
                    continue;
                }
                input.insert(key.clone(), value.clone());
            }

            let payload = map_object(json!({
                "model": model,
                "input": input,
            }));
            let response = self
                .http
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Prefer", "wait")
                .json(&Value::Object(payload.clone()))
                .send()
                .with_context(|| format!("Replicate request failed ({endpoint})"))?;
            let mut prediction = response_json_or_error("Replicate", response)?;
            let status = prediction
                .get("status")
                .and_then(Value::as_str)
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if status != "succeeded" {
                if matches!(status.as_str(), "starting" | "processing") {
                    let poll_url = prediction
                        .get("urls")
                        .and_then(Value::as_object)
                        .and_then(|obj| obj.get("get"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| anyhow::anyhow!("Replicate prediction missing poll URL"))?;
                    prediction =
                        self.poll_prediction(poll_url, &api_key, poll_interval_s, poll_timeout_s)?;
                } else {
                    bail!("Replicate prediction failed: {}", prediction);
                }
            }

            let mut urls = Vec::new();
            if let Some(output) = prediction.get("output") {
                Self::extract_output_urls(output, &mut urls);
            }
            if urls.is_empty() {
                bail!("Replicate response returned no image URLs");
            }

            if let Some(prediction_id) = prediction
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                prediction_ids.push(prediction_id.to_string());
            }
            last_status = prediction
                .get("status")
                .cloned()
                .unwrap_or_else(|| Value::String("succeeded".to_string()));

            for url in urls {
                let image = self.download_image(&url)?;
                let ext = output_extension_from_mime_or_format(
                    image.mime_type.as_deref(),
                    &request.output_format,
                );
                let file_index = results.len();
                let image_path = request
                    .run_dir
                    .join(format!("artifact-{}-{:02}.{}", stamp, file_index, ext));
                fs::write(&image_path, image.bytes)
                    .with_context(|| format!("failed to write {}", image_path.display()))?;
                results.push(ProviderImageResult {
                    image_path,
                    width,
                    height,
                    seed: request.seed.map(|seed| seed.saturating_add(idx as i64)),
                });
            }
            provider_payloads.push(Value::Object(payload));
        }

        if results.is_empty() {
            bail!("Replicate returned no images");
        }

        if request.n > 1 && prediction_ids.len() != request.n as usize {
            push_unique_warning(
                &mut warnings,
                "Replicate returned fewer prediction receipts than requested.".to_string(),
            );
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": if provider_payloads.len() == 1 {
                    provider_payloads.first().cloned().unwrap_or(Value::Null)
                } else {
                    Value::Array(provider_payloads)
                },
            })),
            provider_response: map_object(json!({
                "prediction_ids": prediction_ids,
                "status": last_status,
            })),
            warnings,
            results,
        })
    }
}

struct StabilityProvider {
    api_base: String,
    http: HttpClient,
}

impl StabilityProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("STABILITY_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://api.stability.ai".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("STABILITY_API_KEY")
    }

    fn endpoint_for_request(&self, request: &ProviderGenerateRequest) -> String {
        let override_endpoint = request
            .provider_options
            .get("stability_endpoint")
            .or_else(|| request.provider_options.get("endpoint"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(endpoint) = override_endpoint {
            if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
                return endpoint.to_string();
            }
            return format!("{}/{}", self.api_base, endpoint.trim_start_matches('/'));
        }
        format!("{}/v2beta/stable-image/generate/core", self.api_base)
    }

    fn aspect_ratio_from_size(size: &str) -> String {
        let (width, height) = parse_dims(size);
        if width == 0 || height == 0 {
            return "1:1".to_string();
        }
        let ratio = width as f64 / height as f64;
        let candidates = [
            ("1:1", 1.0),
            ("16:9", 16.0 / 9.0),
            ("9:16", 9.0 / 16.0),
            ("3:2", 3.0 / 2.0),
            ("2:3", 2.0 / 3.0),
            ("4:5", 4.0 / 5.0),
            ("5:4", 5.0 / 4.0),
        ];
        let mut best = "1:1";
        let mut best_delta = f64::MAX;
        for (name, value) in candidates {
            let delta = (ratio - value).abs();
            if delta < best_delta {
                best_delta = delta;
                best = name;
            }
        }
        best.to_string()
    }

    fn decode_json_image(payload: &Value) -> Result<ImageBytes> {
        let image_b64 = payload
            .get("image")
            .or_else(|| payload.get("base64"))
            .or_else(|| {
                payload
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .and_then(|rows| rows.first())
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("base64"))
            })
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Stability JSON response missing image bytes"))?;
        let bytes = BASE64
            .decode(image_b64.as_bytes())
            .context("Stability image base64 decode failed")?;
        Ok(ImageBytes {
            bytes,
            mime_type: Some("image/png".to_string()),
        })
    }
}

impl ImageProvider for StabilityProvider {
    fn name(&self) -> &str {
        "stability"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let Some(api_key) = Self::api_key() else {
            bail!("STABILITY_API_KEY not set");
        };
        if request.inputs.init_image.is_some()
            || !request.inputs.reference_images.is_empty()
            || request.inputs.mask.is_some()
        {
            bail!("Stability provider currently supports text-to-image only.");
        }

        let endpoint = self.endpoint_for_request(request);
        let ext = normalize_output_extension(&request.output_format);
        let aspect_ratio = Self::aspect_ratio_from_size(&request.size);
        let (width, height) = parse_dims(&request.size);
        let sample_count = request.n.max(1);
        let stamp = timestamp_millis();
        let mut payload_manifest: Vec<Value> = Vec::new();
        let mut response_codes: Vec<u16> = Vec::new();
        let mut results: Vec<ProviderImageResult> = Vec::new();

        for idx in 0..sample_count {
            let mut form = MultipartForm::new()
                .text("prompt", request.prompt.clone())
                .text("aspect_ratio", aspect_ratio.clone())
                .text("output_format", ext.to_string());
            let mut manifest = map_object(json!({
                "prompt": request.prompt,
                "aspect_ratio": aspect_ratio,
                "output_format": ext,
            }));

            if let Some(seed) = request.seed {
                let value = seed.saturating_add(idx as i64);
                form = form.text("seed", value.to_string());
                manifest.insert("seed".to_string(), Value::Number(value.into()));
            }
            if let Some(negative_prompt) = request
                .provider_options
                .get("negative_prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                form = form.text("negative_prompt", negative_prompt.to_string());
                manifest.insert(
                    "negative_prompt".to_string(),
                    Value::String(negative_prompt.to_string()),
                );
            }
            if let Some(style_preset) = request
                .provider_options
                .get("style_preset")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                form = form.text("style_preset", style_preset.to_string());
                manifest.insert(
                    "style_preset".to_string(),
                    Value::String(style_preset.to_string()),
                );
            }

            let response = self
                .http
                .post(&endpoint)
                .bearer_auth(&api_key)
                .header("Accept", "image/*")
                .multipart(form)
                .send()
                .with_context(|| format!("Stability request failed ({endpoint})"))?;
            let status_code = response.status().as_u16();
            response_codes.push(status_code);
            if !response.status().is_success() {
                let body = response.text().unwrap_or_default();
                bail!(
                    "Stability request failed ({status_code}): {}",
                    truncate_text(&body, 512)
                );
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            let image = if content_type.starts_with("image/") {
                ImageBytes {
                    bytes: response
                        .bytes()
                        .context("failed reading Stability image bytes")?
                        .to_vec(),
                    mime_type: Some(content_type),
                }
            } else {
                let payload: Value = response
                    .json()
                    .context("failed parsing Stability JSON response")?;
                Self::decode_json_image(&payload)?
            };

            let file_idx = results.len();
            let output_ext = output_extension_from_mime_or_format(
                image.mime_type.as_deref(),
                &request.output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, file_idx, output_ext));
            fs::write(&image_path, image.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed.map(|seed| seed.saturating_add(idx as i64)),
            });
            payload_manifest.push(Value::Object(manifest));
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": if payload_manifest.len() == 1 {
                    payload_manifest.first().cloned().unwrap_or(Value::Null)
                } else {
                    Value::Array(payload_manifest)
                },
            })),
            provider_response: map_object(json!({
                "status_codes": response_codes,
                "count": results.len(),
            })),
            warnings: Vec::new(),
            results,
        })
    }
}

struct FalProvider {
    api_base: String,
    http: HttpClient,
}

impl FalProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("FAL_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://fal.run".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("FAL_KEY").or_else(|| non_empty_env("FAL_API_KEY"))
    }

    fn resolve_endpoint(&self, request: &ProviderGenerateRequest) -> String {
        let raw = request
            .provider_options
            .get("endpoint")
            .or_else(|| request.provider_options.get("fal_model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if request.model.trim().eq_ignore_ascii_case("sdxl") {
                    "fal-ai/fast-sdxl".to_string()
                } else {
                    request.model.trim().to_string()
                }
            });
        if raw.starts_with("http://") || raw.starts_with("https://") {
            return raw;
        }
        format!("{}/{}", self.api_base, raw.trim_start_matches('/'))
    }

    fn path_to_data_url(path: &Path) -> Result<String> {
        let bytes = fs::read(path).with_context(|| format!("failed reading {}", path.display()))?;
        let mime = mime_for_path(path).unwrap_or("image/png");
        Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
    }

    fn extract_urls(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(url) => {
                let trimmed = url.trim();
                if !trimmed.is_empty()
                    && trimmed.starts_with("http")
                    && !out.iter().any(|existing| existing == trimmed)
                {
                    out.push(trimmed.to_string());
                }
            }
            Value::Array(rows) => {
                for row in rows {
                    Self::extract_urls(row, out);
                }
            }
            Value::Object(obj) => {
                if let Some(url) = obj.get("url") {
                    Self::extract_urls(url, out);
                }
                if let Some(images) = obj.get("images") {
                    Self::extract_urls(images, out);
                }
                if let Some(image) = obj.get("image") {
                    Self::extract_urls(image, out);
                }
                if let Some(output) = obj.get("output") {
                    Self::extract_urls(output, out);
                }
            }
            _ => {}
        }
    }

    fn download_image(&self, url: &str) -> Result<ImageBytes> {
        let response = self
            .http
            .get(url)
            .send()
            .with_context(|| format!("failed downloading Fal image ({url})"))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            bail!(
                "Fal image download failed ({code}): {}",
                truncate_text(&body, 512)
            );
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .context("failed reading Fal image bytes")?
            .to_vec();
        Ok(ImageBytes { bytes, mime_type })
    }
}

impl ImageProvider for FalProvider {
    fn name(&self) -> &str {
        "fal"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let Some(api_key) = Self::api_key() else {
            bail!("FAL_KEY (or FAL_API_KEY) not set");
        };

        let endpoint = self.resolve_endpoint(request);
        let mut payload = map_object(json!({
            "prompt": request.prompt,
            "num_images": request.n.max(1),
        }));
        if let Some(seed) = request.seed {
            payload.insert("seed".to_string(), Value::Number(seed.into()));
        }
        if let Some(path) = request.inputs.init_image.as_ref() {
            let data_url = Self::path_to_data_url(Path::new(path))?;
            payload.insert("image_url".to_string(), Value::String(data_url));
        }
        if !request.inputs.reference_images.is_empty() {
            let mut refs = Vec::new();
            for path in &request.inputs.reference_images {
                let data_url = Self::path_to_data_url(Path::new(path))?;
                refs.push(Value::String(data_url));
            }
            payload.insert("reference_image_urls".to_string(), Value::Array(refs));
        }
        if let Some(mask) = request.inputs.mask.as_ref() {
            let data_url = Self::path_to_data_url(Path::new(mask))?;
            payload.insert("mask_url".to_string(), Value::String(data_url));
        }
        for (key, value) in &request.provider_options {
            let normalized = key.trim().to_ascii_lowercase();
            if matches!(normalized.as_str(), "endpoint" | "fal_model") {
                continue;
            }
            if payload.contains_key(key) {
                continue;
            }
            payload.insert(key.clone(), value.clone());
        }

        let response = self
            .http
            .post(&endpoint)
            .header(AUTHORIZATION, format!("Key {api_key}"))
            .json(&Value::Object(payload.clone()))
            .send()
            .with_context(|| format!("Fal request failed ({endpoint})"))?;
        let response_payload = response_json_or_error("Fal", response)?;
        let mut urls = Vec::new();
        Self::extract_urls(&response_payload, &mut urls);
        if urls.is_empty() {
            bail!("Fal response returned no image URLs");
        }

        let (width, height) = parse_dims(&request.size);
        let stamp = timestamp_millis();
        let mut results = Vec::new();
        for (idx, url) in urls.into_iter().take(request.n.max(1) as usize).enumerate() {
            let image = self.download_image(&url)?;
            let ext = output_extension_from_mime_or_format(
                image.mime_type.as_deref(),
                &request.output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, image.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": payload,
            })),
            provider_response: map_object(json!({
                "request_id": response_payload
                    .get("request_id")
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": response_payload
                    .get("status")
                    .cloned()
                    .unwrap_or(Value::String("ok".to_string())),
            })),
            warnings: Vec::new(),
            results,
        })
    }
}

struct OpenAiProvider {
    api_base: String,
    http: HttpClient,
}

impl OpenAiProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("OPENAI_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("OPENAI_API_KEY").or_else(|| non_empty_env("OPENAI_API_KEY_BACKUP"))
    }

    fn has_edit_inputs(request: &ProviderGenerateRequest) -> bool {
        request.inputs.init_image.is_some()
            || !request.inputs.reference_images.is_empty()
            || request.inputs.mask.is_some()
    }

    fn generate_images(
        &self,
        request: &ProviderGenerateRequest,
        api_key: &str,
    ) -> Result<ProviderGenerateResponse> {
        let endpoint = format!("{}/images/generations", self.api_base);
        let mut warnings = Vec::new();
        let normalized_size = normalize_openai_size(&request.size, &mut warnings);
        let mut payload = map_object(json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": request.n.max(1),
            "size": normalized_size,
        }));
        if should_send_openai_seed(&request.provider_options) {
            if let Some(seed) = request.seed {
                payload.insert("seed".to_string(), Value::Number(seed.into()));
            }
        }
        if let Some(output_format) =
            normalize_openai_output_format(&request.output_format, &mut warnings)
        {
            payload.insert(
                "output_format".to_string(),
                Value::String(output_format.to_string()),
            );
        }
        if let Some(background) = normalize_openai_background(
            request.background.as_deref().unwrap_or_default(),
            &mut warnings,
        ) {
            payload.insert(
                "background".to_string(),
                Value::String(background.to_string()),
            );
        }
        merge_openai_provider_options(
            &mut payload,
            &request.provider_options,
            &["quality", "moderation", "output_compression"],
            &mut warnings,
        );
        if is_openai_gpt_image_model(&request.model) && !payload.contains_key("moderation") {
            payload.insert("moderation".to_string(), Value::String("low".to_string()));
        }

        let (status_code, response_payload) =
            self.post_json(&endpoint, api_key, &Value::Object(payload.clone()))?;
        let image_items = self.extract_image_items(&response_payload)?;
        let (width, height) = parse_dims(
            payload
                .get("size")
                .and_then(Value::as_str)
                .unwrap_or(&request.size),
        );
        let mut results = Vec::new();
        let stamp = timestamp_millis();
        let requested_output_format = payload
            .get("output_format")
            .and_then(Value::as_str)
            .unwrap_or(request.output_format.as_str())
            .to_string();

        for (idx, item) in image_items
            .into_iter()
            .take(request.n.max(1) as usize)
            .enumerate()
        {
            let ext = output_extension_from_mime_or_format(
                item.mime_type.as_deref(),
                &requested_output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, item.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });
        }

        if results.is_empty() {
            bail!("OpenAI response returned no images");
        }

        let mut provider_response = map_object(json!({
            "status_code": status_code,
            "created": response_payload.get("created").cloned().unwrap_or(Value::Null),
            "data_count": results.len(),
        }));
        if let Some(id) = response_payload.get("id").cloned() {
            provider_response.insert("id".to_string(), id);
        }
        if let Some(usage) = response_payload.get("usage").cloned() {
            provider_response.insert("usage".to_string(), usage);
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": payload,
            })),
            provider_response,
            warnings,
            results,
        })
    }

    fn edit_images(
        &self,
        request: &ProviderGenerateRequest,
        api_key: &str,
    ) -> Result<ProviderGenerateResponse> {
        let endpoint = format!("{}/images/edits", self.api_base);
        let mut warnings = Vec::new();
        let normalized_size = normalize_openai_size(&request.size, &mut warnings);
        let mut form = MultipartForm::new()
            .text("model", request.model.clone())
            .text("prompt", request.prompt.clone())
            .text("n", request.n.max(1).to_string())
            .text("size", normalized_size.clone());

        let mut payload_manifest = map_object(json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": request.n.max(1),
            "size": normalized_size,
        }));

        if let Some(output_format) =
            normalize_openai_output_format(&request.output_format, &mut warnings)
        {
            form = form.text("output_format", output_format.to_string());
            payload_manifest.insert(
                "output_format".to_string(),
                Value::String(output_format.to_string()),
            );
        }
        if let Some(background) = normalize_openai_background(
            request.background.as_deref().unwrap_or_default(),
            &mut warnings,
        ) {
            form = form.text("background", background.to_string());
            payload_manifest.insert(
                "background".to_string(),
                Value::String(background.to_string()),
            );
        }

        let normalized_options = merge_openai_options_for_form(
            &payload_manifest,
            &request.provider_options,
            &[
                "quality",
                "moderation",
                "output_compression",
                "input_fidelity",
            ],
            &mut warnings,
        );
        for (key, value) in normalized_options {
            let text = json_value_to_form_text(&value);
            form = form.text(key.to_string(), text);
            payload_manifest.insert(key.to_string(), value);
        }
        if is_openai_gpt_image_model(&request.model) && !payload_manifest.contains_key("moderation")
        {
            form = form.text("moderation", "low".to_string());
            payload_manifest.insert("moderation".to_string(), Value::String("low".to_string()));
        }

        let mut files_manifest: Vec<Value> = Vec::new();
        let mut image_paths: Vec<PathBuf> = Vec::new();
        if let Some(init) = request.inputs.init_image.as_ref() {
            image_paths.push(PathBuf::from(init));
        }
        for reference in &request.inputs.reference_images {
            image_paths.push(PathBuf::from(reference));
        }
        if image_paths.is_empty() {
            bail!("OpenAI image edits require at least one input image");
        }

        for image_path in image_paths {
            let bytes = fs::read(&image_path)
                .with_context(|| format!("failed reading {}", image_path.display()))?;
            let file_name = image_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("image.png")
                .to_string();
            let mut part = MultipartPart::bytes(bytes).file_name(file_name.clone());
            if let Some(mime) = mime_for_path(&image_path) {
                part = part.mime_str(mime).with_context(|| {
                    format!("invalid mime '{mime}' for {}", image_path.display())
                })?;
            }
            form = form.part("image[]", part);
            files_manifest.push(json!({
                "field": "image[]",
                "path": image_path.to_string_lossy().to_string(),
                "file_name": file_name,
            }));
        }

        if let Some(mask) = request.inputs.mask.as_ref() {
            let mask_path = PathBuf::from(mask);
            let bytes = fs::read(&mask_path)
                .with_context(|| format!("failed reading {}", mask_path.display()))?;
            let file_name = mask_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("mask.png")
                .to_string();
            let mut part = MultipartPart::bytes(bytes).file_name(file_name.clone());
            if let Some(mime) = mime_for_path(&mask_path) {
                part = part.mime_str(mime).with_context(|| {
                    format!("invalid mime '{mime}' for {}", mask_path.display())
                })?;
            }
            form = form.part("mask", part);
            files_manifest.push(json!({
                "field": "mask",
                "path": mask_path.to_string_lossy().to_string(),
                "file_name": file_name,
            }));
        }

        payload_manifest.insert("files".to_string(), Value::Array(files_manifest));
        let response = self
            .http
            .post(&endpoint)
            .bearer_auth(api_key)
            .multipart(form)
            .send()
            .context("OpenAI edits request failed")?;
        let status_code = response.status().as_u16();
        let response_payload = response_json_or_error("OpenAI edits", response)?;
        let image_items = self.extract_image_items(&response_payload)?;
        let (width, height) = parse_dims(
            payload_manifest
                .get("size")
                .and_then(Value::as_str)
                .unwrap_or(&request.size),
        );
        let stamp = timestamp_millis();
        let requested_output_format = payload_manifest
            .get("output_format")
            .and_then(Value::as_str)
            .unwrap_or(request.output_format.as_str())
            .to_string();
        let mut results = Vec::new();

        for (idx, item) in image_items
            .into_iter()
            .take(request.n.max(1) as usize)
            .enumerate()
        {
            let ext = output_extension_from_mime_or_format(
                item.mime_type.as_deref(),
                &requested_output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, item.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });
        }

        if results.is_empty() {
            bail!("OpenAI edits response returned no images");
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": payload_manifest,
            })),
            provider_response: map_object(json!({
                "status_code": status_code,
                "id": response_payload.get("id").cloned().unwrap_or(Value::Null),
                "created": response_payload.get("created").cloned().unwrap_or(Value::Null),
            })),
            warnings,
            results,
        })
    }

    fn post_json(&self, endpoint: &str, api_key: &str, payload: &Value) -> Result<(u16, Value)> {
        let response = self
            .http
            .post(endpoint)
            .bearer_auth(api_key)
            .json(payload)
            .send()
            .with_context(|| format!("OpenAI request failed ({endpoint})"))?;
        let status_code = response.status().as_u16();
        let parsed = response_json_or_error("OpenAI", response)?;
        Ok((status_code, parsed))
    }

    fn extract_image_items(&self, response_payload: &Value) -> Result<Vec<ImageBytes>> {
        let rows = response_payload
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();

        for row in rows {
            let Some(obj) = row.as_object() else {
                continue;
            };

            if let Some(b64) = obj.get("b64_json").and_then(Value::as_str) {
                let bytes = BASE64
                    .decode(b64.as_bytes())
                    .context("OpenAI image base64 decode failed")?;
                out.push(ImageBytes {
                    bytes,
                    mime_type: None,
                });
                continue;
            }

            if let Some(url) = obj.get("url").and_then(Value::as_str) {
                let downloaded = self.download_image(url)?;
                out.push(downloaded);
            }
        }

        Ok(out)
    }

    fn download_image(&self, url: &str) -> Result<ImageBytes> {
        let response = self
            .http
            .get(url)
            .send()
            .with_context(|| format!("failed downloading provider image ({url})"))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            bail!(
                "provider image download failed ({code}): {}",
                truncate_text(&body, 512)
            );
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .context("failed reading provider image bytes")?
            .to_vec();
        Ok(ImageBytes { bytes, mime_type })
    }
}

impl ImageProvider for OpenAiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        if let Some(api_key) = Self::api_key() {
            if Self::has_edit_inputs(request) {
                return self.edit_images(request, &api_key);
            }
            return self.generate_images(request, &api_key);
        }

        if let Some(openrouter_key) = FluxProvider::openrouter_api_key() {
            let mut openrouter_request = request.clone();
            openrouter_request.model = normalize_openrouter_model_for_image_transport(
                &openrouter_request.model,
                "openai/gpt-image-1",
            );
            let mut response = FluxProvider::new()
                .generate_via_openrouter(&openrouter_request, &openrouter_key)
                .context("OpenAI OpenRouter fallback failed")?;
            response.warnings.insert(
                0,
                "OpenAI API key missing; used OpenRouter image transport.".to_string(),
            );
            return Ok(response);
        }

        bail!("OPENAI_API_KEY or OPENAI_API_KEY_BACKUP or OPENROUTER_API_KEY not set");
    }
}

struct GeminiProvider {
    api_base: String,
    http: HttpClient,
}

impl GeminiProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("GEMINI_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("GEMINI_API_KEY").or_else(|| non_empty_env("GOOGLE_API_KEY"))
    }

    fn endpoint_for_model(&self, model: &str) -> String {
        let trimmed = model.trim();
        let model_path = if trimmed.starts_with("models/") {
            trimmed.to_string()
        } else {
            format!("models/{trimmed}")
        };
        format!("{}/{}:generateContent", self.api_base, model_path)
    }

    fn build_contents(&self, request: &ProviderGenerateRequest) -> Result<Vec<Value>> {
        let mut parts = Vec::new();
        if let Some(init_image) = request.inputs.init_image.as_ref() {
            parts.push(image_part_from_path(Path::new(init_image))?);
        }
        for reference in &request.inputs.reference_images {
            parts.push(image_part_from_path(Path::new(reference))?);
        }
        if let Some(packet) = request
            .metadata
            .get("gemini_context_packet")
            .and_then(Value::as_object)
        {
            parts.push(json!({
                "text": format_gemini_context_packet(packet),
            }));
        }
        parts.push(json!({ "text": request.prompt }));
        Ok(parts)
    }

    fn nearest_ratio_from_size(size: &str, warnings: &mut Vec<String>) -> Option<String> {
        let normalized = size.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return None;
        }
        if normalized == "portrait" || normalized == "tall" {
            return Some("9:16".to_string());
        }
        if normalized == "landscape" || normalized == "wide" {
            return Some("16:9".to_string());
        }
        if normalized == "square" || normalized == "1:1" {
            return Some("1:1".to_string());
        }

        let ratio_candidates = [
            ("1:1", 1.0f64),
            ("2:3", 2.0 / 3.0),
            ("3:2", 3.0 / 2.0),
            ("3:4", 3.0 / 4.0),
            ("4:3", 4.0 / 3.0),
            ("4:5", 4.0 / 5.0),
            ("5:4", 5.0 / 4.0),
            ("9:16", 9.0 / 16.0),
            ("16:9", 16.0 / 9.0),
            ("21:9", 21.0 / 9.0),
        ];

        let target_ratio = if let Some((left, right)) = parse_openai_ratio(&normalized) {
            let direct = format!("{left}:{right}");
            if ratio_candidates
                .iter()
                .any(|(candidate, _)| *candidate == direct)
            {
                return Some(direct);
            }
            left as f64 / right as f64
        } else if let Some((width, height)) = parse_openai_dims(&normalized) {
            width as f64 / height as f64
        } else {
            return None;
        };

        let mut best_key = "1:1";
        let mut best_delta = f64::MAX;
        for (key, ratio) in ratio_candidates {
            let delta = (ratio - target_ratio).abs();
            if delta < best_delta {
                best_key = key;
                best_delta = delta;
            }
        }
        if best_key != normalized {
            push_unique_warning(
                warnings,
                format!("Gemini aspect ratio snapped to {best_key}."),
            );
        }
        Some(best_key.to_string())
    }

    fn resolve_image_size_hint(size: &str) -> String {
        let normalized = size.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return "2K".to_string();
        }
        if matches!(normalized.as_str(), "1k" | "2k" | "4k") {
            return normalized.to_ascii_uppercase();
        }
        if let Some((width, height)) = parse_openai_dims(&normalized) {
            let longest = width.max(height);
            if longest >= 3600 {
                return "4K".to_string();
            }
            if longest >= 1800 {
                return "2K".to_string();
            }
            return "1K".to_string();
        }
        "2K".to_string()
    }

    fn default_safety_settings() -> Vec<Value> {
        [
            "HARM_CATEGORY_HARASSMENT",
            "HARM_CATEGORY_HATE_SPEECH",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "HARM_CATEGORY_DANGEROUS_CONTENT",
        ]
        .into_iter()
        .map(|category| {
            json!({
                "category": category,
                "threshold": "OFF",
            })
        })
        .collect()
    }

    fn request_timeout_seconds(request: &ProviderGenerateRequest) -> f64 {
        value_as_f64(
            request.provider_options.get("request_timeout"),
            90.0,
            15.0,
            300.0,
        )
    }

    fn transport_retry_count(request: &ProviderGenerateRequest) -> usize {
        let retries_value = request
            .provider_options
            .get("transport_retries")
            .or_else(|| request.provider_options.get("request_retries"));
        value_as_f64(retries_value, 2.0, 0.0, 4.0).round() as usize
    }

    fn retry_backoff_seconds(request: &ProviderGenerateRequest) -> f64 {
        value_as_f64(
            request.provider_options.get("retry_backoff"),
            1.2,
            0.1,
            10.0,
        )
    }

    fn post_with_transport_retries(
        &self,
        endpoint: &str,
        api_key: &str,
        payload: &Value,
        timeout_s: f64,
        max_retries: usize,
        retry_backoff_s: f64,
        warnings: &mut Vec<String>,
    ) -> Result<HttpResponse> {
        for attempt in 0..=max_retries {
            let response = self
                .http
                .post(endpoint)
                .query(&[("key", api_key)])
                .timeout(Duration::from_secs_f64(timeout_s))
                .json(payload)
                .send();

            match response {
                Ok(ok) => return Ok(ok),
                Err(raw) => {
                    let err = anyhow::Error::new(raw)
                        .context(format!("Gemini request failed ({endpoint})"));
                    if !is_retryable_transport_error(&err) || attempt >= max_retries {
                        return Err(err);
                    }
                    push_unique_warning(
                        warnings,
                        format!(
                            "Gemini transport retry {}/{} after transient request failure.",
                            attempt + 1,
                            max_retries
                        ),
                    );
                    let delay_s = retry_backoff_s * (attempt as f64 + 1.0);
                    thread::sleep(Duration::from_secs_f64(delay_s));
                }
            }
        }

        unreachable!("Gemini transport retry loop should always return a response or error")
    }

    fn extract_image_items(response_payload: &Value) -> Result<Vec<ImageBytes>> {
        let candidates = response_payload
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::new();

        for candidate in candidates {
            let parts = candidate
                .get("content")
                .and_then(Value::as_object)
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for part in parts {
                let inline = part
                    .get("inlineData")
                    .or_else(|| part.get("inline_data"))
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let data = inline
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if data.is_empty() {
                    continue;
                }
                let bytes = BASE64
                    .decode(data.as_bytes())
                    .context("Gemini image base64 decode failed")?;
                let mime_type = inline
                    .get("mimeType")
                    .or_else(|| inline.get("mime_type"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                out.push(ImageBytes { bytes, mime_type });
            }
        }

        Ok(out)
    }
}

impl ImageProvider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let Some(api_key) = Self::api_key() else {
            if let Some(openrouter_key) = FluxProvider::openrouter_api_key() {
                let mut openrouter_request = request.clone();
                openrouter_request.model = normalize_openrouter_model_for_image_transport(
                    &openrouter_request.model,
                    "google/gemini-3-pro-image-preview",
                );
                let mut response = FluxProvider::new()
                    .generate_via_openrouter(&openrouter_request, &openrouter_key)
                    .context("Gemini OpenRouter fallback failed")?;
                response.warnings.insert(
                    0,
                    "Gemini API key missing; used OpenRouter image transport.".to_string(),
                );
                return Ok(response);
            }
            bail!("GEMINI_API_KEY or GOOGLE_API_KEY or OPENROUTER_API_KEY not set");
        };
        let endpoint = self.endpoint_for_model(&request.model);
        let mut warnings = Vec::new();
        let mut payload = Map::new();
        payload.insert(
            "contents".to_string(),
            Value::Array(vec![json!({
                "role": "user",
                "parts": self.build_contents(request)?,
            })]),
        );

        let mut generation_config = Map::new();
        generation_config.insert(
            "candidateCount".to_string(),
            Value::Number(request.n.max(1).into()),
        );
        generation_config.insert(
            "responseModalities".to_string(),
            Value::Array(vec![Value::String("IMAGE".to_string())]),
        );

        let aspect_ratio = request
            .provider_options
            .get("aspect_ratio")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| Self::nearest_ratio_from_size(&request.size, &mut warnings));
        let image_size_source = request
            .provider_options
            .get("image_size")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(request.size.as_str());
        let image_size = Self::resolve_image_size_hint(image_size_source);
        let mut image_config = Map::new();
        if let Some(aspect_ratio) = aspect_ratio {
            image_config.insert("aspectRatio".to_string(), Value::String(aspect_ratio));
        }
        image_config.insert("imageSize".to_string(), Value::String(image_size));
        generation_config.insert("imageConfig".to_string(), Value::Object(image_config));
        payload.insert(
            "generationConfig".to_string(),
            Value::Object(generation_config),
        );
        if let Some(safety_settings) = request
            .provider_options
            .get("safety_settings")
            .and_then(Value::as_array)
            .cloned()
        {
            payload.insert("safetySettings".to_string(), Value::Array(safety_settings));
        } else {
            payload.insert(
                "safetySettings".to_string(),
                Value::Array(Self::default_safety_settings()),
            );
        }

        let request_timeout_s = Self::request_timeout_seconds(request);
        let transport_retries = Self::transport_retry_count(request);
        let retry_backoff_s = Self::retry_backoff_seconds(request);
        let payload_value = Value::Object(payload.clone());

        let response = self.post_with_transport_retries(
            &endpoint,
            &api_key,
            &payload_value,
            request_timeout_s,
            transport_retries,
            retry_backoff_s,
            &mut warnings,
        )?;
        let response_payload = response_json_or_error("Gemini", response)?;
        let image_items = Self::extract_image_items(&response_payload)?;
        let (width, height) = parse_dims(&request.size);
        let stamp = timestamp_millis();
        let mut results = Vec::new();

        for (idx, item) in image_items
            .into_iter()
            .take(request.n.max(1) as usize)
            .enumerate()
        {
            let ext = output_extension_from_mime_or_format(
                item.mime_type.as_deref(),
                &request.output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, item.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });
        }

        if results.is_empty() {
            bail!("Gemini returned no images");
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": payload,
            })),
            provider_response: map_object(json!({
                "candidates": response_payload
                    .get("candidates")
                    .and_then(Value::as_array)
                    .map(|rows| rows.len())
                    .unwrap_or(0),
                "usage_metadata": response_payload.get("usageMetadata").cloned().unwrap_or(Value::Null),
            })),
            warnings,
            results,
        })
    }
}

struct FluxProvider {
    api_base: String,
    http: HttpClient,
}

impl FluxProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("FLUX_API_BASE")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://api.bfl.ai/v1".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("BFL_API_KEY").or_else(|| non_empty_env("FLUX_API_KEY"))
    }

    fn openrouter_api_key() -> Option<String> {
        non_empty_env("OPENROUTER_API_KEY")
    }

    fn openrouter_api_base() -> String {
        let raw = non_empty_env("OPENROUTER_API_BASE")
            .or_else(|| non_empty_env("OPENROUTER_BASE_URL"))
            .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string());
        let mut base = raw.trim().trim_end_matches('/').to_string();
        if let Ok(parsed) = reqwest::Url::parse(&base) {
            if parsed.path().trim().is_empty() || parsed.path() == "/" {
                base = format!("{base}/api/v1");
            }
        }
        base.trim_end_matches('/').to_string()
    }

    fn endpoint_for_request(&self, request: &ProviderGenerateRequest) -> (String, String) {
        let explicit = request
            .provider_options
            .get("endpoint")
            .or_else(|| request.provider_options.get("url"))
            .or_else(|| request.provider_options.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut suffix = explicit.unwrap_or_else(|| request.model.clone());
        if suffix.starts_with("http://") || suffix.starts_with("https://") {
            let label = suffix
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            return (suffix, label);
        }
        let label = suffix.trim_start_matches('/').to_string();
        if suffix.eq_ignore_ascii_case("flux-2") {
            suffix = "flux-2-flex".to_string();
        }
        (
            format!("{}/{}", self.api_base, suffix.trim_start_matches('/')),
            label,
        )
    }

    fn request_timeouts(request: &ProviderGenerateRequest) -> (f64, f64, f64, f64) {
        let poll_interval = value_as_f64(
            request.provider_options.get("poll_interval"),
            0.5,
            0.1,
            10.0,
        );
        let poll_timeout = value_as_f64(
            request.provider_options.get("poll_timeout"),
            120.0,
            5.0,
            600.0,
        );
        let request_timeout = value_as_f64(
            request.provider_options.get("request_timeout"),
            30.0,
            2.0,
            300.0,
        );
        let download_timeout = value_as_f64(
            request.provider_options.get("download_timeout"),
            60.0,
            2.0,
            300.0,
        );
        (
            poll_interval,
            poll_timeout,
            request_timeout,
            download_timeout,
        )
    }

    fn normalize_output_format(
        request: &ProviderGenerateRequest,
        sanitized_options: &Map<String, Value>,
        warnings: &mut Vec<String>,
    ) -> String {
        let mut output_format = match normalize_flux_output_format_option(&request.output_format) {
            Some(value) => value.to_string(),
            None => {
                if !request.output_format.trim().is_empty() {
                    push_unique_warning(
                        warnings,
                        format!(
                            "FLUX output_format '{}' unsupported; using jpeg.",
                            request.output_format
                        ),
                    );
                }
                "jpeg".to_string()
            }
        };
        if let Some(option_output_format) = sanitized_options
            .get("output_format")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            output_format = option_output_format.to_string();
        }
        output_format
    }

    fn normalize_dims(size: &str, warnings: &mut Vec<String>) -> (u32, u32) {
        let (base_width, base_height) = parse_dims(size);
        let mut width = base_width.max(64);
        let mut height = base_height.max(64);
        let snapped_width = snap_multiple(width, 16);
        let snapped_height = snap_multiple(height, 16);
        if snapped_width != width || snapped_height != height {
            push_unique_warning(
                warnings,
                format!(
                    "FLUX size snapped to {}x{} (multiples of 16).",
                    snapped_width, snapped_height
                ),
            );
        }
        width = snapped_width;
        height = snapped_height;
        let max_area = 4_000_000u64;
        let pre_scale_width = width;
        let pre_scale_height = height;
        while (width as u64) * (height as u64) > max_area {
            if width >= height && width > 64 {
                width = width.saturating_sub(16).max(64);
            } else if height > 64 {
                height = height.saturating_sub(16).max(64);
            } else {
                break;
            }
        }
        if width != pre_scale_width || height != pre_scale_height {
            push_unique_warning(
                warnings,
                format!(
                    "FLUX size scaled down to {}x{} (max 4000000 pixels).",
                    width, height
                ),
            );
        }
        (width, height)
    }

    fn sanitize_provider_options(
        options: &Map<String, Value>,
        endpoint_label: &str,
        warnings: &mut Vec<String>,
    ) -> Map<String, Value> {
        let mut out = Map::new();
        let is_flex_endpoint = endpoint_label.to_ascii_lowercase().contains("flex");
        for (raw_key, raw_value) in options {
            let key = raw_key.trim().to_ascii_lowercase();
            if key.is_empty() {
                continue;
            }
            if matches!(
                key.as_str(),
                "endpoint"
                    | "url"
                    | "model"
                    | "poll_interval"
                    | "poll_timeout"
                    | "request_timeout"
                    | "download_timeout"
            ) {
                continue;
            }
            if !matches!(
                key.as_str(),
                "output_format" | "safety_tolerance" | "steps" | "guidance" | "prompt_upsampling"
            ) {
                push_unique_warning(
                    warnings,
                    format!("FLUX ignored unsupported provider option '{}'.", key),
                );
                continue;
            }
            if raw_value.is_null() {
                continue;
            }
            if key == "output_format" {
                let Some(value) = raw_value.as_str() else {
                    push_unique_warning(
                        warnings,
                        format!("FLUX output_format '{}' unsupported; ignoring.", raw_value),
                    );
                    continue;
                };
                let Some(normalized) = normalize_flux_output_format_option(value) else {
                    push_unique_warning(
                        warnings,
                        format!("FLUX output_format '{}' unsupported; ignoring.", value),
                    );
                    continue;
                };
                out.insert(
                    "output_format".to_string(),
                    Value::String(normalized.to_string()),
                );
                continue;
            }
            if key == "safety_tolerance" {
                let Some(number) = parse_value_to_i64(raw_value) else {
                    push_unique_warning(
                        warnings,
                        format!(
                            "FLUX safety_tolerance '{}' unsupported; ignoring.",
                            raw_value
                        ),
                    );
                    continue;
                };
                let clamped = number.clamp(0, 5);
                if clamped != number {
                    push_unique_warning(
                        warnings,
                        format!("FLUX safety_tolerance clamped to {clamped}."),
                    );
                }
                out.insert(
                    "safety_tolerance".to_string(),
                    Value::Number(clamped.into()),
                );
                continue;
            }
            if key == "steps" {
                if !is_flex_endpoint {
                    push_unique_warning(
                        warnings,
                        "FLUX ignored steps for non-flex endpoint.".to_string(),
                    );
                    continue;
                }
                let Some(number) = parse_value_to_i64(raw_value) else {
                    push_unique_warning(
                        warnings,
                        format!("FLUX steps '{}' unsupported; ignoring.", raw_value),
                    );
                    continue;
                };
                let clamped = number.clamp(1, 50);
                if clamped != number {
                    push_unique_warning(warnings, format!("FLUX steps clamped to {clamped}."));
                }
                out.insert("steps".to_string(), Value::Number(clamped.into()));
                continue;
            }
            if key == "guidance" {
                if !is_flex_endpoint {
                    push_unique_warning(
                        warnings,
                        "FLUX ignored guidance for non-flex endpoint.".to_string(),
                    );
                    continue;
                }
                let Some(number) = parse_value_to_f64(raw_value) else {
                    push_unique_warning(
                        warnings,
                        format!("FLUX guidance '{}' unsupported; ignoring.", raw_value),
                    );
                    continue;
                };
                let clamped = number.clamp(1.5, 10.0);
                if (clamped - number).abs() > f64::EPSILON {
                    push_unique_warning(
                        warnings,
                        format!("FLUX guidance clamped to {}.", trim_float(clamped)),
                    );
                }
                if let Some(number) = serde_json::Number::from_f64(clamped) {
                    out.insert("guidance".to_string(), Value::Number(number));
                }
                continue;
            }
            if key == "prompt_upsampling" {
                let Some(value) = value_as_bool(raw_value) else {
                    push_unique_warning(
                        warnings,
                        format!(
                            "FLUX prompt_upsampling '{}' unsupported; ignoring.",
                            raw_value
                        ),
                    );
                    continue;
                };
                out.insert("prompt_upsampling".to_string(), Value::Bool(value));
            }
        }
        out
    }

    fn collect_input_images(
        request: &ProviderGenerateRequest,
        endpoint_label: &str,
        warnings: &mut Vec<String>,
    ) -> Result<(Map<String, Value>, Vec<Value>)> {
        let mut out = Map::new();
        let mut manifest = Vec::new();
        let mut all_inputs: Vec<(String, String)> = Vec::new();
        if let Some(init) = request.inputs.init_image.as_ref() {
            all_inputs.push(("init_image".to_string(), init.clone()));
        }
        for (idx, reference) in request.inputs.reference_images.iter().enumerate() {
            all_inputs.push((format!("reference_images[{idx}]"), reference.clone()));
        }
        let max_inputs = if endpoint_label.to_ascii_lowercase().contains("klein") {
            4
        } else {
            8
        };
        if all_inputs.len() > max_inputs {
            push_unique_warning(
                warnings,
                format!(
                    "FLUX accepted first {} input images; dropped {} extra references.",
                    max_inputs,
                    all_inputs.len() - max_inputs
                ),
            );
        }
        for (idx, (role, value)) in all_inputs.into_iter().take(max_inputs).enumerate() {
            let key = if idx == 0 {
                "input_image".to_string()
            } else {
                format!("input_image_{}", idx + 1)
            };
            let encoded = coerce_flux_input_image_value(&value)?;
            manifest.push(json!({
                "key": key,
                "role": role,
                "source": flux_input_source_label(&value),
            }));
            out.insert(key, Value::String(encoded));
        }
        Ok((out, manifest))
    }

    fn map_flux_model_to_openrouter(model: &str) -> Option<&'static str> {
        match model.trim().to_ascii_lowercase().as_str() {
            "flux-2" | "flux-2-flex" | "flux-2-pro" | "flux-2-max" | "flux-klein"
            | "flux-klein-pro" | "flux-klein-max" => Some("black-forest-labs/flux-1.1-pro"),
            _ => None,
        }
    }

    fn openrouter_model_candidates(
        request: &ProviderGenerateRequest,
        warnings: &mut Vec<String>,
    ) -> Vec<String> {
        let mut candidates: Vec<String> = Vec::new();
        let push_model = |value: &str, out: &mut Vec<String>| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return;
            }
            if out.iter().any(|existing| existing == trimmed) {
                return;
            }
            out.push(trimmed.to_string());
        };
        if let Some(explicit) = request
            .provider_options
            .get("openrouter_model")
            .or_else(|| request.provider_options.get("responses_model"))
            .or_else(|| request.provider_options.get("openai_responses_model"))
            .and_then(Value::as_str)
        {
            let normalized = normalize_openrouter_model_for_image_transport(explicit, explicit);
            push_model(&normalized, &mut candidates);
            for alias in openrouter_image_model_aliases(&normalized) {
                push_model(&alias, &mut candidates);
            }
            push_model(explicit, &mut candidates);
            if normalized != explicit.trim() {
                push_unique_warning(
                    warnings,
                    format!(
                        "OpenRouter model '{}' normalized to '{}'.",
                        explicit.trim(),
                        normalized
                    ),
                );
            }
        }
        let normalized_request_model =
            normalize_openrouter_model_for_image_transport(&request.model, "openai/gpt-image-1");
        if normalized_request_model != request.model.trim() {
            push_unique_warning(
                warnings,
                format!(
                    "Model '{}' normalized to '{}' for OpenRouter transport.",
                    request.model.trim(),
                    normalized_request_model
                ),
            );
        }
        push_model(&normalized_request_model, &mut candidates);
        for alias in openrouter_image_model_aliases(&normalized_request_model) {
            push_model(&alias, &mut candidates);
        }
        push_model(&request.model, &mut candidates);
        if let Some(mapped) = Self::map_flux_model_to_openrouter(&request.model) {
            if !candidates.iter().any(|existing| existing == mapped) {
                push_unique_warning(
                    warnings,
                    format!(
                        "Flux model '{}' mapped to OpenRouter model '{}' for OpenRouter transport.",
                        request.model, mapped
                    ),
                );
                candidates.push(mapped.to_string());
            }
        }
        if candidates.is_empty() {
            candidates.push("black-forest-labs/flux-1.1-pro".to_string());
        }
        candidates
    }

    fn openrouter_aspect_ratio(size: &str) -> String {
        let (width, height) = parse_dims(size);
        if width == 0 || height == 0 {
            return "1:1".to_string();
        }
        let ratio = width as f64 / height as f64;
        let candidates = [
            ("1:1", 1.0),
            ("16:9", 16.0 / 9.0),
            ("9:16", 9.0 / 16.0),
            ("4:3", 4.0 / 3.0),
            ("3:4", 3.0 / 4.0),
            ("3:2", 3.0 / 2.0),
            ("2:3", 2.0 / 3.0),
            ("5:4", 5.0 / 4.0),
            ("4:5", 4.0 / 5.0),
            ("21:9", 21.0 / 9.0),
        ];
        let mut best = "1:1";
        let mut best_delta = f64::MAX;
        for (label, value) in candidates {
            let delta = (ratio - value).abs();
            if delta < best_delta {
                best_delta = delta;
                best = label;
            }
        }
        best.to_string()
    }

    fn openrouter_supports_image_size(model: &str) -> bool {
        let normalized = model.trim().to_ascii_lowercase();
        normalized.contains("gemini") || normalized.contains("imagen")
    }

    fn openrouter_image_size_hint(request: &ProviderGenerateRequest) -> String {
        let from_options = request
            .provider_options
            .get("image_size")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_uppercase);
        if let Some(value) = from_options {
            if value == "1K" || value == "2K" || value == "4K" {
                return value;
            }
        }
        GeminiProvider::resolve_image_size_hint(&request.size)
    }

    fn flux_input_to_openrouter_image_url(value: &str) -> Result<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            bail!("OpenRouter image input value is empty");
        }
        let lowered = trimmed.to_ascii_lowercase();
        if lowered.starts_with("http://")
            || lowered.starts_with("https://")
            || lowered.starts_with("data:image/")
        {
            return Ok(trimmed.to_string());
        }
        let path = PathBuf::from(trimmed);
        if path.exists() && path.is_file() {
            let bytes =
                fs::read(&path).with_context(|| format!("failed reading {}", path.display()))?;
            let mime = mime_for_path(&path).unwrap_or("image/png");
            return Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)));
        }
        if BASE64.decode(trimmed.as_bytes()).is_ok() {
            return Ok(format!("data:image/png;base64,{trimmed}"));
        }
        bail!(
            "OpenRouter image input '{}' must be a URL, data URL, local file path, or base64 image bytes",
            truncate_text(trimmed, 80)
        );
    }

    fn build_openrouter_input_content(
        request: &ProviderGenerateRequest,
        warnings: &mut Vec<String>,
    ) -> Result<Vec<Value>> {
        let mut content = vec![json!({
            "type": "input_text",
            "text": request.prompt,
        })];
        if let Some(init_image) = request.inputs.init_image.as_ref() {
            match Self::flux_input_to_openrouter_image_url(init_image) {
                Ok(image_url) => {
                    content.push(json!({
                        "type": "input_image",
                        "image_url": image_url,
                    }));
                }
                Err(err) => push_unique_warning(
                    warnings,
                    format!(
                        "OpenRouter dropped init_image input: {}",
                        truncate_text(&err.to_string(), 220)
                    ),
                ),
            }
        }
        for (idx, reference) in request.inputs.reference_images.iter().enumerate() {
            match Self::flux_input_to_openrouter_image_url(reference) {
                Ok(image_url) => {
                    content.push(json!({
                        "type": "input_image",
                        "image_url": image_url,
                    }));
                }
                Err(err) => push_unique_warning(
                    warnings,
                    format!(
                        "OpenRouter dropped reference_images[{}]: {}",
                        idx,
                        truncate_text(&err.to_string(), 220)
                    ),
                ),
            }
        }
        if request.inputs.mask.is_some() {
            push_unique_warning(
                warnings,
                "OpenRouter image generation currently ignores mask input for Flux fallback."
                    .to_string(),
            );
        }
        Ok(content)
    }

    fn apply_openrouter_request_headers(
        mut request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        if let Some(referer) = non_empty_env("OPENROUTER_HTTP_REFERER")
            .or_else(|| non_empty_env("BROOD_OPENROUTER_HTTP_REFERER"))
        {
            request = request.header("HTTP-Referer", referer);
        }
        if let Some(title) = non_empty_env("OPENROUTER_X_TITLE")
            .or_else(|| non_empty_env("BROOD_OPENROUTER_X_TITLE"))
        {
            request = request.header("X-Title", title);
        }
        request
    }

    fn should_fallback_openrouter_responses(status_code: u16, body: &str) -> bool {
        if matches!(status_code, 404 | 405 | 415 | 501) {
            return true;
        }
        if matches!(status_code, 400 | 422) {
            let lowered = body.to_ascii_lowercase();
            return lowered.contains("response")
                && (lowered.contains("unsupported")
                    || lowered.contains("not supported")
                    || lowered.contains("not found")
                    || lowered.contains("unknown")
                    || lowered.contains("does not exist")
                    || lowered.contains("unavailable"));
        }
        false
    }

    fn should_fallback_openrouter_responses_decode_error(err: &anyhow::Error) -> bool {
        if is_retryable_transport_error(err) {
            return true;
        }
        let lowered = error_chain_text(err, 480).to_ascii_lowercase();
        lowered.contains("response body read failed")
            || lowered.contains("returned invalid json payload")
    }

    fn openrouter_transport_retry_count(request: &ProviderGenerateRequest) -> usize {
        let retries_value = request
            .provider_options
            .get("transport_retries")
            .or_else(|| request.provider_options.get("request_retries"));
        value_as_f64(retries_value, 2.0, 0.0, 4.0).round() as usize
    }

    fn openrouter_retry_backoff_seconds(request: &ProviderGenerateRequest) -> f64 {
        value_as_f64(
            request.provider_options.get("retry_backoff"),
            1.0,
            0.1,
            10.0,
        )
    }

    fn extract_openrouter_chat_finish_reason(payload: &Value) -> Option<String> {
        payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(Value::as_object)
            .and_then(|row| row.get("finish_reason").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn extract_openrouter_generated_images(
        &self,
        payload: &Value,
        download_timeout_s: f64,
    ) -> Result<Vec<ImageBytes>> {
        fn collect(value: &Value, key_hint: Option<&str>, out: &mut Vec<String>) {
            match value {
                Value::Object(obj) => {
                    for (key, nested) in obj {
                        collect(nested, Some(key), out);
                    }
                }
                Value::Array(items) => {
                    for item in items {
                        collect(item, key_hint, out);
                    }
                }
                Value::String(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        return;
                    }
                    let key = key_hint
                        .map(|value| value.trim().to_ascii_lowercase())
                        .unwrap_or_default();
                    let looks_http =
                        trimmed.starts_with("http://") || trimmed.starts_with("https://");
                    let looks_data_url = trimmed.starts_with("data:image/");
                    let looks_b64_key =
                        key.contains("b64") || key.contains("base64") || key == "result";
                    let looks_url_key = key == "url"
                        || key.ends_with("_url")
                        || key.ends_with("url")
                        || key.contains("image_url");
                    if looks_data_url || (looks_http && looks_url_key) || looks_b64_key {
                        if !out.iter().any(|existing| existing == trimmed) {
                            out.push(trimmed.to_string());
                        }
                    }
                }
                _ => {}
            }
        }

        fn decode_data_url(value: &str) -> Result<ImageBytes> {
            let (meta, payload) = value
                .split_once(',')
                .ok_or_else(|| anyhow::anyhow!("invalid data URL image payload"))?;
            let mime = meta
                .trim()
                .strip_prefix("data:")
                .and_then(|rest| rest.split(';').next())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .unwrap_or("image/png")
                .to_string();
            let bytes = BASE64
                .decode(payload.trim().as_bytes())
                .context("OpenRouter image data URL base64 decode failed")?;
            Ok(ImageBytes {
                bytes,
                mime_type: Some(mime),
            })
        }

        let mut candidates: Vec<String> = Vec::new();
        collect(payload, None, &mut candidates);
        let mut out: Vec<ImageBytes> = Vec::new();
        for candidate in candidates {
            let trimmed = candidate.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("data:image/") {
                if let Ok(image) = decode_data_url(trimmed) {
                    out.push(image);
                }
                continue;
            }
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                if let Ok(image) = self.download_openrouter_image(trimmed, download_timeout_s) {
                    out.push(image);
                }
                continue;
            }
            if let Ok(bytes) = BASE64.decode(trimmed.as_bytes()) {
                out.push(ImageBytes {
                    bytes,
                    mime_type: None,
                });
            }
        }
        Ok(out)
    }

    fn download_openrouter_image(&self, url: &str, timeout_s: f64) -> Result<ImageBytes> {
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs_f64(timeout_s))
            .send()
            .with_context(|| format!("OpenRouter image download failed ({url})"))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            bail!(
                "OpenRouter image download failed ({code}): {}",
                truncate_text(&body, 512)
            );
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .context("OpenRouter image bytes read failed")?
            .to_vec();
        Ok(ImageBytes { bytes, mime_type })
    }

    fn request_openrouter_image_generation(
        &self,
        request: &ProviderGenerateRequest,
        model: &str,
        input_content: &[Value],
        seed: Option<i64>,
        aspect_ratio: &str,
        api_key: &str,
        request_timeout: f64,
        download_timeout: f64,
        warnings: &mut Vec<String>,
    ) -> Result<(String, Value, Value, Vec<ImageBytes>)> {
        let max_retries = Self::openrouter_transport_retry_count(request);
        let retry_backoff_s = Self::openrouter_retry_backoff_seconds(request);
        let base = Self::openrouter_api_base();
        let responses_endpoint = format!("{base}/responses");
        let responses_payload = {
            let mut image_config = map_object(json!({
                "aspect_ratio": aspect_ratio,
            }));
            if Self::openrouter_supports_image_size(model) {
                image_config.insert(
                    "image_size".to_string(),
                    Value::String(Self::openrouter_image_size_hint(request)),
                );
            }
            let mut payload = map_object(json!({
                "model": model,
                "input": [{
                    "role": "user",
                    "content": input_content,
                }],
                "modalities": ["text", "image"],
                "stream": false,
                "image_config": image_config,
            }));
            if let Some(seed_value) = seed {
                payload.insert("seed".to_string(), Value::Number(seed_value.into()));
            }
            Value::Object(payload)
        };
        for attempt in 0..=max_retries {
            let responses_request = self
                .http
                .post(&responses_endpoint)
                .bearer_auth(api_key)
                .header("accept", "application/json")
                .header(CONTENT_TYPE, "application/json")
                .timeout(Duration::from_secs_f64(request_timeout));
            let responses_response = match Self::apply_openrouter_request_headers(responses_request)
                .json(&responses_payload)
                .send()
            {
                Ok(response) => response,
                Err(raw) => {
                    let err = anyhow::Error::new(raw).context(format!(
                        "OpenRouter responses request failed ({responses_endpoint})"
                    ));
                    if !is_retryable_transport_error(&err) {
                        return Err(err);
                    }
                    if attempt < max_retries {
                        push_unique_warning(
                            warnings,
                            format!(
                                "OpenRouter responses transport retry {}/{} after transient request failure.",
                                attempt + 1,
                                max_retries
                            ),
                        );
                        let delay_s = retry_backoff_s * (attempt as f64 + 1.0);
                        thread::sleep(Duration::from_secs_f64(delay_s));
                        continue;
                    }
                    push_unique_warning(
                        warnings,
                        format!(
                            "OpenRouter responses transport failed after retries; falling back to chat/completions ({})",
                            truncate_text(&error_chain_text(&err, 220), 220)
                        ),
                    );
                    break;
                }
            };
            if responses_response.status().is_success() {
                match response_json_or_error("OpenRouter responses", responses_response) {
                    Ok(response_payload) => {
                        let images = self.extract_openrouter_generated_images(
                            &response_payload,
                            download_timeout,
                        )?;
                        if !images.is_empty() {
                            return Ok((
                                "openrouter_responses".to_string(),
                                responses_payload,
                                response_payload,
                                images,
                            ));
                        }
                        break;
                    }
                    Err(err) => {
                        if !Self::should_fallback_openrouter_responses_decode_error(&err) {
                            return Err(err);
                        }
                        if is_retryable_transport_error(&err) && attempt < max_retries {
                            push_unique_warning(
                                warnings,
                                format!(
                                    "OpenRouter responses decode retry {}/{} after transient body failure.",
                                    attempt + 1,
                                    max_retries
                                ),
                            );
                            let delay_s = retry_backoff_s * (attempt as f64 + 1.0);
                            thread::sleep(Duration::from_secs_f64(delay_s));
                            continue;
                        }
                        push_unique_warning(
                            warnings,
                            format!(
                                "OpenRouter responses payload decode failed; falling back to chat/completions ({})",
                                truncate_text(&error_chain_text(&err, 220), 220)
                            ),
                        );
                        break;
                    }
                }
            } else {
                let code = responses_response.status().as_u16();
                let body = responses_response.text().unwrap_or_default();
                if !Self::should_fallback_openrouter_responses(code, &body) {
                    bail!(
                        "OpenRouter responses request failed ({code}): {}",
                        truncate_text(&body, 512)
                    );
                }
                break;
            }
        }

        let chat_endpoint = format!("{base}/chat/completions");
        let mut chat_content = Vec::new();
        for item in input_content {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let kind = obj
                .get("type")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if kind == "input_text" {
                if let Some(text) = obj
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    chat_content.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            } else if kind == "input_image" {
                let maybe_url = obj
                    .get("image_url")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        obj.get("image_url")
                            .and_then(Value::as_object)
                            .and_then(|row| row.get("url"))
                            .and_then(Value::as_str)
                    })
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                if let Some(url) = maybe_url {
                    chat_content.push(json!({
                        "type": "image_url",
                        "image_url": { "url": url }
                    }));
                }
            }
        }
        let chat_payload = {
            let mut image_config = map_object(json!({
                "aspect_ratio": aspect_ratio,
            }));
            if Self::openrouter_supports_image_size(model) {
                image_config.insert(
                    "image_size".to_string(),
                    Value::String(Self::openrouter_image_size_hint(request)),
                );
            }
            let mut payload = map_object(json!({
                "model": model,
                "messages": [{
                    "role": "user",
                    "content": chat_content,
                }],
                "modalities": ["text", "image"],
                "stream": false,
                "image_config": image_config,
            }));
            if let Some(seed_value) = seed {
                payload.insert("seed".to_string(), Value::Number(seed_value.into()));
            }
            Value::Object(payload)
        };
        for attempt in 0..=max_retries {
            let chat_request = self
                .http
                .post(&chat_endpoint)
                .bearer_auth(api_key)
                .header("accept", "application/json")
                .header(CONTENT_TYPE, "application/json")
                .timeout(Duration::from_secs_f64(request_timeout));
            let chat_response = match Self::apply_openrouter_request_headers(chat_request)
                .json(&chat_payload)
                .send()
            {
                Ok(response) => response,
                Err(raw) => {
                    let err = anyhow::Error::new(raw)
                        .context(format!("OpenRouter chat request failed ({chat_endpoint})"));
                    if is_retryable_transport_error(&err) && attempt < max_retries {
                        push_unique_warning(
                            warnings,
                            format!(
                                "OpenRouter chat transport retry {}/{} after transient request failure.",
                                attempt + 1,
                                max_retries
                            ),
                        );
                        let delay_s = retry_backoff_s * (attempt as f64 + 1.0);
                        thread::sleep(Duration::from_secs_f64(delay_s));
                        continue;
                    }
                    return Err(err);
                }
            };
            let chat_payload_response =
                match response_json_or_error("OpenRouter chat", chat_response) {
                    Ok(payload) => payload,
                    Err(err) => {
                        if Self::should_fallback_openrouter_responses_decode_error(&err)
                            && attempt < max_retries
                        {
                            push_unique_warning(
                                warnings,
                                format!(
                                "OpenRouter chat decode retry {}/{} after transient body failure.",
                                attempt + 1,
                                max_retries
                            ),
                            );
                            let delay_s = retry_backoff_s * (attempt as f64 + 1.0);
                            thread::sleep(Duration::from_secs_f64(delay_s));
                            continue;
                        }
                        return Err(err);
                    }
                };
            let images =
                self.extract_openrouter_generated_images(&chat_payload_response, download_timeout)?;
            if images.is_empty() {
                let finish = Self::extract_openrouter_chat_finish_reason(&chat_payload_response)
                    .unwrap_or_else(|| "unknown".to_string());
                bail!(
                    "OpenRouter chat image response returned no image payload (finish_reason={finish})"
                );
            }
            return Ok((
                "openrouter_chat_completions".to_string(),
                chat_payload,
                chat_payload_response,
                images,
            ));
        }
        unreachable!("OpenRouter chat retry loop should always return a response or error")
    }

    fn generate_via_openrouter(
        &self,
        request: &ProviderGenerateRequest,
        api_key: &str,
    ) -> Result<ProviderGenerateResponse> {
        let (_poll_interval, _poll_timeout, request_timeout, download_timeout) =
            Self::request_timeouts(request);
        let mut warnings = Vec::new();
        let candidates = Self::openrouter_model_candidates(request, &mut warnings);
        let (width, height) = parse_dims(&request.size);
        let stamp = timestamp_millis();
        let aspect_ratio = Self::openrouter_aspect_ratio(&request.size);
        let input_content = Self::build_openrouter_input_content(request, &mut warnings)?;

        let mut request_manifests: Vec<Value> = Vec::new();
        let mut response_manifests: Vec<Value> = Vec::new();
        let mut results = Vec::new();

        for idx in 0..request.n.max(1) {
            let seed = request.seed.map(|value| value.saturating_add(idx as i64));
            let mut last_error: Option<anyhow::Error> = None;
            let mut generated: Option<(String, Value, Value, Vec<ImageBytes>)> = None;
            for model in &candidates {
                match self.request_openrouter_image_generation(
                    request,
                    model,
                    &input_content,
                    seed,
                    &aspect_ratio,
                    api_key,
                    request_timeout,
                    download_timeout,
                    &mut warnings,
                ) {
                    Ok(tuple) => {
                        generated = Some(tuple);
                        break;
                    }
                    Err(err) => {
                        last_error = Some(err);
                    }
                }
            }
            let Some((transport, request_payload, response_payload, images)) = generated else {
                let message = last_error
                    .as_ref()
                    .map(|err| err.to_string())
                    .unwrap_or_else(|| "OpenRouter request failed".to_string());
                bail!("OpenRouter image fallback failed: {message}");
            };
            let first = images
                .into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("OpenRouter returned no image bytes"))?;
            let ext = output_extension_from_mime_or_format(
                first.mime_type.as_deref(),
                &request.output_format,
            );
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, first.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed,
            });
            request_manifests.push(json!({
                "transport": transport,
                "payload": request_payload,
            }));
            response_manifests.push(json!({
                "transport": transport,
                "response_id": response_payload.get("id").cloned().unwrap_or(Value::Null),
                "status": response_payload.get("status").cloned().unwrap_or(Value::Null),
                "usage": response_payload.get("usage").cloned().unwrap_or(Value::Null),
            }));
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": format!("{}/responses", Self::openrouter_api_base()),
                "payload": if request_manifests.len() == 1 {
                    request_manifests.first().cloned().unwrap_or(Value::Null)
                } else {
                    Value::Array(request_manifests)
                },
            })),
            provider_response: map_object(json!({
                "responses": response_manifests,
            })),
            warnings,
            results,
        })
    }

    fn post_flux_json(
        &self,
        endpoint: &str,
        api_key: &str,
        payload: &Map<String, Value>,
        timeout_s: f64,
    ) -> Result<Value> {
        let response = self
            .http
            .post(endpoint)
            .header("accept", "application/json")
            .header("x-key", api_key)
            .json(&Value::Object(payload.clone()))
            .timeout(Duration::from_secs_f64(timeout_s))
            .send()
            .with_context(|| format!("Flux request failed ({endpoint})"))?;
        response_json_or_error("Flux", response)
    }

    fn get_flux_json(&self, url: &str, api_key: &str, timeout_s: f64) -> Result<Value> {
        let response = self
            .http
            .get(url)
            .header("accept", "application/json")
            .header("x-key", api_key)
            .timeout(Duration::from_secs_f64(timeout_s))
            .send()
            .with_context(|| format!("Flux poll failed ({url})"))?;
        response_json_or_error("Flux poll", response)
    }

    fn download_flux_image(&self, url: &str, api_key: &str, timeout_s: f64) -> Result<Vec<u8>> {
        let response = self
            .http
            .get(url)
            .header("x-key", api_key)
            .timeout(Duration::from_secs_f64(timeout_s))
            .send()
            .with_context(|| format!("Flux image download failed ({url})"))?;
        if !response.status().is_success() {
            let code = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            bail!(
                "Flux image download failed ({code}): {}",
                truncate_text(&body, 512)
            );
        }
        let bytes = response
            .bytes()
            .context("Flux image bytes read failed")?
            .to_vec();
        Ok(bytes)
    }
}

impl ImageProvider for FluxProvider {
    fn name(&self) -> &str {
        "flux"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let api_key = Self::api_key();
        if api_key.is_none() {
            if let Some(openrouter_key) = Self::openrouter_api_key() {
                return self.generate_via_openrouter(request, &openrouter_key);
            }
            bail!("BFL_API_KEY or FLUX_API_KEY or OPENROUTER_API_KEY not set");
        }
        let api_key = api_key.unwrap_or_default();
        let (endpoint, endpoint_label) = self.endpoint_for_request(request);
        let (poll_interval, poll_timeout, request_timeout, download_timeout) =
            Self::request_timeouts(request);
        let mut warnings = Vec::new();
        if endpoint_label.eq_ignore_ascii_case("flux-2") {
            push_unique_warning(
                &mut warnings,
                "Flux model flux-2 is deprecated; using flux-2-flex.".to_string(),
            );
        }
        let filtered_options = Self::sanitize_provider_options(
            &request.provider_options,
            &endpoint_label,
            &mut warnings,
        );
        let output_format =
            Self::normalize_output_format(request, &filtered_options, &mut warnings);
        let ext = normalize_output_extension(&output_format);
        let (width, height) = Self::normalize_dims(&request.size, &mut warnings);
        let (input_fields, input_manifest) =
            Self::collect_input_images(request, &endpoint_label, &mut warnings)?;
        if request.inputs.mask.is_some() {
            push_unique_warning(
                &mut warnings,
                "FLUX mask inputs are not supported; ignoring mask.".to_string(),
            );
        }

        let mut payloads = Vec::new();
        let mut results = Vec::new();
        let stamp = timestamp_millis();
        let mut last_poll_payload = Value::Null;
        let mut request_ids: Vec<Value> = Vec::new();

        for idx in 0..request.n.max(1) {
            let mut payload = map_object(json!({
                "prompt": request.prompt,
                "width": width,
                "height": height,
                "output_format": output_format,
            }));
            if let Some(seed) = request.seed {
                payload.insert("seed".to_string(), Value::Number(seed.into()));
            }
            for (key, value) in filtered_options.clone() {
                payload.insert(key, value);
            }
            for (key, value) in input_fields.clone() {
                payload.insert(key, value);
            }

            let submitted = self.post_flux_json(&endpoint, &api_key, &payload, request_timeout)?;
            let request_id = submitted.get("id").cloned().unwrap_or(Value::Null);
            let polling_url = submitted
                .get("polling_url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("Flux response missing polling_url"))?;

            request_ids.push(request_id.clone());
            let started = Instant::now();
            let image_url = loop {
                let poll_payload = self.get_flux_json(&polling_url, &api_key, request_timeout)?;
                last_poll_payload = poll_payload.clone();
                let status = poll_payload
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                if status == "ready" {
                    let maybe_url = poll_payload
                        .get("result")
                        .and_then(Value::as_object)
                        .and_then(|row| {
                            row.get("sample")
                                .or_else(|| row.get("output"))
                                .or_else(|| row.get("url"))
                        })
                        .or_else(|| poll_payload.get("sample"))
                        .or_else(|| poll_payload.get("output"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    let Some(url) = maybe_url else {
                        bail!("Flux ready response missing output URL");
                    };
                    break url;
                }
                if matches!(
                    status.as_str(),
                    "error"
                        | "failed"
                        | "request moderated"
                        | "content moderated"
                        | "task not found"
                ) {
                    bail!("Flux generation failed: {}", poll_payload);
                }
                if started.elapsed().as_secs_f64() >= poll_timeout {
                    bail!("Flux polling timed out after {:.1}s", poll_timeout);
                }
                thread::sleep(Duration::from_secs_f64(poll_interval));
            };

            let image_bytes = self.download_flux_image(&image_url, &api_key, download_timeout)?;
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, image_bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: request.seed,
            });

            let mut manifest_payload = payload.clone();
            for key in manifest_payload
                .keys()
                .filter(|key| key.starts_with("input_image"))
                .cloned()
                .collect::<Vec<String>>()
            {
                manifest_payload.remove(&key);
            }
            if !input_manifest.is_empty() {
                manifest_payload.insert(
                    "input_images".to_string(),
                    Value::Array(input_manifest.clone()),
                );
            }
            payloads.push(Value::Object(manifest_payload));
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": if payloads.len() == 1 {
                    payloads.first().cloned().unwrap_or(Value::Null)
                } else {
                    Value::Array(payloads)
                },
            })),
            provider_response: map_object(json!({
                "request_ids": request_ids,
                "last_poll_payload": last_poll_payload,
            })),
            warnings,
            results,
        })
    }
}

struct ImagenProvider {
    api_base: String,
    http: HttpClient,
}

impl ImagenProvider {
    fn new() -> Self {
        Self {
            api_base: env::var("IMAGEN_API_BASE")
                .ok()
                .or_else(|| env::var("GEMINI_API_BASE").ok())
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".to_string()),
            http: HttpClient::new(),
        }
    }

    fn api_key() -> Option<String> {
        non_empty_env("IMAGEN_API_KEY")
            .or_else(|| non_empty_env("GEMINI_API_KEY"))
            .or_else(|| non_empty_env("GOOGLE_API_KEY"))
    }

    fn resolve_model_name(raw_model: &str) -> String {
        let trimmed = raw_model.trim().trim_start_matches("models/").to_string();
        let lower = trimmed.to_ascii_lowercase();
        match lower.as_str() {
            "imagen-4.0-ultra" | "imagen-4-ultra" => "imagen-4.0-ultra-generate-001".to_string(),
            "imagen-4" | "imagen-4.0" => "imagen-4.0-generate-001".to_string(),
            _ => trimmed,
        }
    }

    fn normalize_output_format(output_format: &str, warnings: &mut Vec<String>) -> String {
        let normalized = normalize_output_extension(output_format);
        match normalized {
            "jpg" => "jpeg".to_string(),
            "png" => "png".to_string(),
            _ => {
                if !output_format.trim().is_empty() {
                    push_unique_warning(
                        warnings,
                        format!(
                            "Imagen output format '{}' unsupported; using png.",
                            output_format
                        ),
                    );
                }
                "png".to_string()
            }
        }
    }

    fn aspect_ratio_from_size(size: &str) -> String {
        let (w, h) = parse_dims(size);
        if w == 0 || h == 0 {
            return "1:1".to_string();
        }
        let ratio = w as f64 / h as f64;
        let candidates = [
            ("1:1", 1.0f64),
            ("3:4", 3.0 / 4.0),
            ("4:3", 4.0 / 3.0),
            ("9:16", 9.0 / 16.0),
            ("16:9", 16.0 / 9.0),
        ];
        let mut best = "1:1";
        let mut delta = f64::MAX;
        for (name, value) in candidates {
            let current = (ratio - value).abs();
            if current < delta {
                delta = current;
                best = name;
            }
        }
        best.to_string()
    }

    fn image_size_from_dims(size: &str) -> String {
        GeminiProvider::resolve_image_size_hint(size)
    }

    fn normalize_aspect_ratio(raw: &str, warnings: &mut Vec<String>) -> Option<String> {
        let value = raw.trim().replace('/', ":");
        if value.is_empty() {
            return None;
        }
        let allowed = ["1:1", "3:4", "4:3", "9:16", "16:9"];
        if allowed.iter().any(|candidate| *candidate == value) {
            return Some(value);
        }
        let (left_raw, right_raw) = if let Some(parts) = value.split_once(':') {
            parts
        } else {
            push_unique_warning(
                warnings,
                format!(
                    "Imagen aspect_ratio '{}' unsupported; using provider default.",
                    raw
                ),
            );
            return None;
        };
        let left = left_raw.trim().parse::<f64>().ok().unwrap_or(0.0);
        let right = right_raw.trim().parse::<f64>().ok().unwrap_or(0.0);
        if left <= 0.0 || right <= 0.0 {
            push_unique_warning(
                warnings,
                format!(
                    "Imagen aspect_ratio '{}' unsupported; using provider default.",
                    raw
                ),
            );
            return None;
        }
        let target = left / right;
        let mut best = "1:1";
        let mut best_delta = f64::MAX;
        for candidate in allowed {
            let (a, b) = candidate.split_once(':').unwrap_or(("1", "1"));
            let ratio = a.parse::<f64>().ok().unwrap_or(1.0) / b.parse::<f64>().ok().unwrap_or(1.0);
            let delta = (ratio - target).abs();
            if delta < best_delta {
                best = candidate;
                best_delta = delta;
            }
        }
        push_unique_warning(
            warnings,
            format!("Imagen aspect_ratio snapped to {}.", best),
        );
        Some(best.to_string())
    }

    fn normalize_image_size(raw: &str, model: &str, warnings: &mut Vec<String>) -> Option<String> {
        let model_name = model.trim().to_ascii_lowercase();
        if model_name.starts_with("imagen-3") {
            return None;
        }
        let normalized = raw.trim().to_ascii_uppercase();
        if normalized.is_empty() {
            return Some("2K".to_string());
        }
        if normalized == "1K" || normalized == "2K" {
            return Some(normalized);
        }
        if normalized == "4K" {
            push_unique_warning(
                warnings,
                "Imagen image_size 4K unsupported; using 2K.".to_string(),
            );
            return Some("2K".to_string());
        }
        let inferred = GeminiProvider::resolve_image_size_hint(raw);
        if inferred == "4K" {
            push_unique_warning(
                warnings,
                "Imagen image_size 4K unsupported; using 2K.".to_string(),
            );
            return Some("2K".to_string());
        }
        if inferred == "1K" || inferred == "2K" {
            return Some(inferred);
        }
        push_unique_warning(
            warnings,
            format!("Imagen image_size '{}' unsupported; using 2K.", raw),
        );
        Some("2K".to_string())
    }

    fn normalize_number_of_images(raw: u64, warnings: &mut Vec<String>) -> u64 {
        let clamped = raw.clamp(1, 4);
        if clamped != raw {
            push_unique_warning(
                warnings,
                format!("Imagen number_of_images clamped to {}.", clamped),
            );
        }
        clamped
    }

    fn normalize_person_generation(raw: &str, warnings: &mut Vec<String>) -> Option<String> {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return None;
        }
        if matches!(
            normalized.as_str(),
            "dont_allow" | "allow_adult" | "allow_all"
        ) {
            return Some(normalized);
        }
        push_unique_warning(
            warnings,
            format!("Imagen person_generation '{}' unsupported; ignoring.", raw),
        );
        None
    }

    fn extract_predictions(response_payload: &Value) -> Result<Vec<ImageBytes>> {
        let mut out = Vec::new();
        let predictions = response_payload
            .get("predictions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for row in predictions {
            let Some(obj) = row.as_object() else {
                continue;
            };
            if let Some(encoded) = obj
                .get("bytesBase64Encoded")
                .or_else(|| obj.get("bytes_base64_encoded"))
                .and_then(Value::as_str)
            {
                let bytes = BASE64
                    .decode(encoded.as_bytes())
                    .context("Imagen image base64 decode failed")?;
                out.push(ImageBytes {
                    bytes,
                    mime_type: obj
                        .get("mimeType")
                        .or_else(|| obj.get("mime_type"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
                continue;
            }

            let generated = obj
                .get("image")
                .and_then(Value::as_object)
                .or_else(|| obj.get("generatedImage").and_then(Value::as_object))
                .cloned()
                .unwrap_or_default();
            if let Some(encoded) = generated
                .get("imageBytes")
                .or_else(|| generated.get("bytesBase64Encoded"))
                .and_then(Value::as_str)
            {
                let bytes = BASE64
                    .decode(encoded.as_bytes())
                    .context("Imagen generated image base64 decode failed")?;
                out.push(ImageBytes {
                    bytes,
                    mime_type: generated
                        .get("mimeType")
                        .or_else(|| generated.get("mime_type"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
        }
        Ok(out)
    }
}

impl ImageProvider for ImagenProvider {
    fn name(&self) -> &str {
        "imagen"
    }

    fn generate(&self, request: &ProviderGenerateRequest) -> Result<ProviderGenerateResponse> {
        let Some(api_key) = Self::api_key() else {
            if let Some(openrouter_key) = FluxProvider::openrouter_api_key() {
                let mut openrouter_request = request.clone();
                openrouter_request.model = normalize_openrouter_model_for_image_transport(
                    &openrouter_request.model,
                    "google/imagen-4.0-ultra",
                );
                let mut response = FluxProvider::new()
                    .generate_via_openrouter(&openrouter_request, &openrouter_key)
                    .context("Imagen OpenRouter fallback failed")?;
                response.warnings.insert(
                    0,
                    "Imagen API key missing; used OpenRouter image transport.".to_string(),
                );
                return Ok(response);
            }
            bail!("IMAGEN_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, or OPENROUTER_API_KEY not set");
        };

        let mut warnings = Vec::new();
        let model = Self::resolve_model_name(&request.model);
        let endpoint = format!("{}/models/{}:predict", self.api_base, model);
        let output_format = Self::normalize_output_format(&request.output_format, &mut warnings);
        let ext = if output_format == "jpeg" {
            "jpg"
        } else {
            "png"
        };
        let mut parameters = Map::new();
        let sample_count = Self::normalize_number_of_images(request.n.max(1), &mut warnings);
        parameters.insert(
            "sampleCount".to_string(),
            Value::Number(sample_count.into()),
        );
        let ratio_raw = request
            .provider_options
            .get("aspect_ratio")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| GeminiProvider::nearest_ratio_from_size(&request.size, &mut warnings))
            .unwrap_or_else(|| Self::aspect_ratio_from_size(&request.size));
        let ratio = Self::normalize_aspect_ratio(&ratio_raw, &mut warnings)
            .unwrap_or_else(|| Self::aspect_ratio_from_size(&request.size));
        parameters.insert("aspectRatio".to_string(), Value::String(ratio));
        let image_size_raw = request
            .provider_options
            .get("image_size")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Self::image_size_from_dims(&request.size));
        let image_size = Self::normalize_image_size(&image_size_raw, &request.model, &mut warnings);
        parameters.insert(
            "imageSize".to_string(),
            Value::String(image_size.unwrap_or_else(|| "2K".to_string())),
        );
        let add_watermark = request
            .provider_options
            .get("add_watermark")
            .and_then(value_as_bool)
            .unwrap_or(true);
        if request.provider_options.get("add_watermark").is_some() {
            parameters.insert("addWatermark".to_string(), Value::Bool(add_watermark));
        }
        if request.seed.is_some() && add_watermark {
            push_unique_warning(
                &mut warnings,
                "Imagen seed ignored because add_watermark=true.".to_string(),
            );
        }
        if let Some(seed) = request.seed.filter(|_| !add_watermark) {
            parameters.insert("seed".to_string(), Value::Number(seed.into()));
        }
        if let Some(person_generation) = request
            .provider_options
            .get("person_generation")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|value| Self::normalize_person_generation(value, &mut warnings))
        {
            parameters.insert(
                "personGeneration".to_string(),
                Value::String(person_generation),
            );
        }

        let payload = map_object(json!({
            "instances": [{
                "prompt": request.prompt,
            }],
            "parameters": parameters,
        }));
        let response = self
            .http
            .post(&endpoint)
            .query(&[("key", api_key)])
            .json(&Value::Object(payload.clone()))
            .send()
            .with_context(|| format!("Imagen request failed ({endpoint})"))?;
        let response_payload = response_json_or_error("Imagen", response)?;
        let images = Self::extract_predictions(&response_payload)?;
        if images.is_empty() {
            bail!("Imagen returned no images");
        }

        let (width, height) = parse_dims(&request.size);
        let stamp = timestamp_millis();
        let mut results = Vec::new();
        for (idx, image) in images.into_iter().take(sample_count as usize).enumerate() {
            let image_path = request
                .run_dir
                .join(format!("artifact-{}-{:02}.{}", stamp, idx, ext));
            fs::write(&image_path, image.bytes)
                .with_context(|| format!("failed to write {}", image_path.display()))?;
            results.push(ProviderImageResult {
                image_path,
                width,
                height,
                seed: if add_watermark { None } else { request.seed },
            });
        }

        Ok(ProviderGenerateResponse {
            provider_request: map_object(json!({
                "endpoint": endpoint,
                "payload": payload,
            })),
            provider_response: map_object(json!({
                "predictions": response_payload
                    .get("predictions")
                    .and_then(Value::as_array)
                    .map(|rows| rows.len())
                    .unwrap_or(0),
            })),
            warnings,
            results,
        })
    }
}

#[derive(Debug, Clone)]
struct ImageBytes {
    bytes: Vec<u8>,
    mime_type: Option<String>,
}

fn default_provider_registry() -> ImageProviderRegistry {
    let mut providers = ImageProviderRegistry::new();
    providers.register(DryrunProvider);
    providers.register(OpenAiProvider::new());
    providers.register(ReplicateProvider::new());
    providers.register(StabilityProvider::new());
    providers.register(FalProvider::new());
    providers.register(GeminiProvider::new());
    providers.register(ImagenProvider::new());
    providers.register(FluxProvider::new());
    providers
}

pub struct NativeEngine {
    run_dir: PathBuf,
    run_id: String,
    events: EventWriter,
    thread: ThreadManifest,
    cache: CacheStore,
    summary_path: PathBuf,
    started_at: String,
    model_selector: ModelSelector,
    text_model: Option<String>,
    image_model: Option<String>,
    providers: ImageProviderRegistry,
    pricing_tables: BTreeMap<String, Map<String, Value>>,
    last_fallback_reason: Option<String>,
    last_cost_latency: Option<CostLatencyMetrics>,
}

#[derive(Debug, Clone)]
struct EffectiveImageSelection {
    model: ModelSpec,
    fallback_reason: Option<String>,
}

impl NativeEngine {
    pub fn new(
        run_dir: impl Into<PathBuf>,
        events_path: impl Into<PathBuf>,
        text_model: Option<String>,
        image_model: Option<String>,
    ) -> Result<Self> {
        let run_dir = run_dir.into();
        std::fs::create_dir_all(&run_dir)?;
        let run_id = run_dir
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("run-rs")
            .to_string();
        let events = EventWriter::new(events_path.into(), run_id.clone());
        let thread_path = run_dir.join("thread.json");
        let thread = if thread_path.exists() {
            ThreadManifest::load(&thread_path)
        } else {
            ThreadManifest::new(&thread_path)
        };
        let cache = CacheStore::new(run_dir.join("cache.json"));
        let summary_path = run_dir.join("summary.json");
        let started_at = now_utc_iso();

        events.emit(
            "run_started",
            map_object(json!({
                "out_dir": run_dir.to_string_lossy().to_string(),
            })),
        )?;

        Ok(Self {
            run_dir,
            run_id,
            events,
            thread,
            cache,
            summary_path,
            started_at,
            model_selector: ModelSelector::new(None),
            text_model,
            image_model,
            providers: default_provider_registry(),
            pricing_tables: load_pricing_tables(),
            last_fallback_reason: None,
            last_cost_latency: None,
        })
    }

    pub fn set_text_model(&mut self, model: Option<String>) {
        self.text_model = model;
    }

    pub fn text_model(&self) -> Option<&str> {
        self.text_model.as_deref()
    }

    pub fn set_image_model(&mut self, model: Option<String>) {
        self.image_model = model;
    }

    pub fn image_model(&self) -> Option<&str> {
        self.image_model.as_deref()
    }

    pub fn last_fallback_reason(&self) -> Option<&str> {
        self.last_fallback_reason.as_deref()
    }

    pub fn last_cost_latency(&self) -> Option<&CostLatencyMetrics> {
        self.last_cost_latency.as_ref()
    }

    pub fn emit_event(&self, event_type: &str, payload: EventPayload) -> Result<Value> {
        self.events.emit(event_type, payload)
    }

    pub fn event_writer(&self) -> EventWriter {
        self.events.clone()
    }

    pub fn track_context(&self, text_in: &str, text_out: &str) -> Result<ContextUsage> {
        let used_tokens = estimate_tokens(text_in) + estimate_tokens(text_out);
        let max_tokens = self
            .text_model
            .as_deref()
            .and_then(|model| {
                self.model_selector
                    .registry
                    .get(model)
                    .and_then(|spec| spec.context_window)
            })
            .unwrap_or(8192);
        let pct = if max_tokens == 0 {
            0.0
        } else {
            used_tokens as f64 / max_tokens as f64
        }
        .clamp(0.0, 1.0);
        let alert_level = if pct >= 0.95 {
            "critical"
        } else if pct >= 0.9 {
            "high"
        } else if pct >= 0.75 {
            "medium"
        } else {
            "none"
        }
        .to_string();

        self.events.emit(
            "context_window_update",
            map_object(json!({
                "model": self.text_model.as_deref().unwrap_or("unknown"),
                "used_tokens": used_tokens,
                "max_tokens": max_tokens,
                "pct": pct,
                "alert_level": alert_level,
            })),
        )?;

        Ok(ContextUsage {
            used_tokens,
            max_tokens,
            pct,
            alert_level,
        })
    }

    pub fn preview_plan(
        &mut self,
        prompt: &str,
        settings: &Map<String, Value>,
        intent: &Map<String, Value>,
    ) -> Result<PlanPreview> {
        let selection = self.resolve_image_selection()?;
        let effective_settings = apply_quality_preset(settings, &selection.model);
        let size = effective_settings
            .get("size")
            .and_then(Value::as_str)
            .unwrap_or("1024x1024")
            .to_string();
        let n = effective_settings
            .get("n")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let cache_key = stable_hash(&json!({
            "prompt": prompt,
            "size": size,
            "n": n,
            "model": selection.model.name,
            "options": effective_settings,
            "intent": intent,
        }));
        let cached = self.cache.get(&cache_key).is_some();

        Ok(PlanPreview {
            images: n,
            model: selection.model.name,
            provider: selection.model.provider,
            size,
            cached,
            fallback_reason: selection.fallback_reason,
        })
    }

    pub fn generate(
        &mut self,
        prompt: &str,
        settings: Map<String, Value>,
        mut intent: Map<String, Value>,
    ) -> Result<Vec<Map<String, Value>>> {
        let selection = self.resolve_image_selection()?;
        let fallback_reason = selection.fallback_reason.clone();
        let model_spec = selection.model;
        let settings = apply_quality_preset(&settings, &model_spec);
        self.last_fallback_reason = fallback_reason.clone();
        if let Some(reason) = fallback_reason.clone() {
            intent.insert("model_fallback".to_string(), Value::String(reason));
        }

        let size = settings
            .get("size")
            .and_then(Value::as_str)
            .unwrap_or("1024x1024")
            .to_string();
        let n = settings
            .get("n")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let output_format = settings
            .get("output_format")
            .and_then(Value::as_str)
            .unwrap_or("png")
            .to_string();
        let background = settings
            .get("background")
            .and_then(Value::as_str)
            .map(str::to_string);
        let seed = settings.get("seed").and_then(Value::as_i64);
        let provider_options = settings
            .get("provider_options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let request_metadata = request_metadata_from_intent(&intent);
        let inputs = image_inputs_from_settings(&settings);

        let cache_key = stable_hash(&json!({
            "prompt": prompt,
            "size": size,
            "n": n,
            "model": model_spec.name,
            "options": settings,
            "intent": intent,
        }));
        let cached = self.cache.get(&cache_key);
        self.events.emit(
            "plan_preview",
            map_object(json!({
                "plan": {
                    "images": n,
                    "model": model_spec.name,
                    "provider": model_spec.provider,
                    "size": size,
                    "cached": cached.is_some(),
                    "fallback_reason": fallback_reason,
                }
            })),
        )?;

        let parent_version_id = intent
            .get("parent_version_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let version = self.thread.add_version(
            intent.clone(),
            settings.clone(),
            prompt.to_string(),
            parent_version_id.clone(),
        );
        self.thread.save()?;
        self.events.emit(
            "version_created",
            map_object(json!({
                "version_id": version.version_id,
                "parent_version_id": parent_version_id,
                "settings": settings,
                "prompt": prompt,
            })),
        )?;

        if let Some(cached_value) = cached {
            let cached_cost_metrics = self.build_cost_latency_metrics(
                &model_spec,
                n,
                0.0,
                true,
                &size,
                &provider_options,
            );
            let mut artifacts: Vec<Map<String, Value>> = Vec::new();
            if let Some(rows) = cached_value.get("artifacts").and_then(Value::as_array) {
                for row in rows {
                    if let Some(artifact) = row.as_object() {
                        let snapshot = artifact.clone();
                        self.thread
                            .add_artifact(&version.version_id, snapshot.clone());
                        self.events.emit(
                            "artifact_created",
                            map_object(json!({
                                "version_id": version.version_id,
                                "artifact_id": snapshot.get("artifact_id"),
                                "image_path": snapshot.get("image_path"),
                                "receipt_path": snapshot.get("receipt_path"),
                                "metrics": snapshot.get("metrics").cloned().unwrap_or(Value::Object(Map::new())),
                            })),
                        )?;
                        artifacts.push(snapshot);
                    }
                }
            }
            self.thread.save()?;
            self.emit_cost_latency_event(&cached_cost_metrics)?;
            return Ok(artifacts);
        }

        let provider = if let Some(provider) = self.providers.get(&model_spec.provider) {
            provider
        } else {
            let available = self.providers.names().join(", ");
            let error = format!(
                "native provider '{}' not registered (available: [{}])",
                model_spec.provider, available
            );
            let missing_provider_metrics = self.build_cost_latency_metrics(
                &model_spec,
                n,
                0.0,
                false,
                &size,
                &provider_options,
            );
            self.emit_cost_latency_event(&missing_provider_metrics)?;
            self.events.emit(
                "generation_failed",
                map_object(json!({
                    "version_id": version.version_id,
                    "provider": model_spec.provider,
                    "model": model_spec.name,
                    "error": error,
                })),
            )?;
            bail!("{error}");
        };

        let started = Instant::now();
        let provider_request = ProviderGenerateRequest {
            run_dir: self.run_dir.clone(),
            prompt: prompt.to_string(),
            size: size.clone(),
            n,
            seed,
            output_format: output_format.clone(),
            background: background.clone(),
            inputs: inputs.clone(),
            model: model_spec.name.clone(),
            provider_options: provider_options.clone(),
            metadata: request_metadata.clone(),
        };

        let response = match provider.generate(&provider_request) {
            Ok(response) => response,
            Err(err) => {
                let latency_s = (started.elapsed().as_secs_f64() / n as f64).max(0.0);
                let error_text = error_chain_text(&err, 2048);
                let failed_cost_metrics = self.build_cost_latency_metrics(
                    &model_spec,
                    n,
                    latency_s,
                    false,
                    &size,
                    &provider_options,
                );
                self.emit_cost_latency_event(&failed_cost_metrics)?;
                self.events.emit(
                    "generation_failed",
                    map_object(json!({
                        "version_id": version.version_id,
                        "provider": model_spec.provider,
                        "model": model_spec.name,
                        "error": error_text,
                    })),
                )?;
                return Err(err).context("native provider generation failed");
            }
        };

        let latency_s = (started.elapsed().as_secs_f64() / n as f64).max(0.0);
        let success_cost_metrics = self.build_cost_latency_metrics(
            &model_spec,
            n,
            latency_s,
            false,
            &size,
            &provider_options,
        );

        let mut artifacts: Vec<Map<String, Value>> = Vec::new();
        for (idx, result) in response.results.iter().enumerate() {
            let artifact_id = format!(
                "{}-{:02}-{}",
                version.version_id,
                idx + 1,
                short_id(prompt, idx as u64)
            );
            let receipt_path = self.run_dir.join(format!("receipt-{}.json", artifact_id));

            let request = ImageRequest {
                prompt: prompt.to_string(),
                mode: "generate".to_string(),
                size: size.clone(),
                n,
                seed,
                output_format: Some(output_format.clone()),
                background: background.clone(),
                inputs: inputs.clone(),
                provider: Some(model_spec.provider.clone()),
                provider_options: provider_options.clone(),
                user: None,
                out_dir: Some(self.run_dir.to_string_lossy().to_string()),
                stream: false,
                partial_images: None,
                model: Some(model_spec.name.clone()),
                metadata: request_metadata.clone(),
            };
            let resolved = ResolvedRequest {
                provider: model_spec.provider.clone(),
                model: Some(model_spec.name.clone()),
                size: size.clone(),
                width: Some(result.width as u64),
                height: Some(result.height as u64),
                output_format: output_format.clone(),
                background: background.clone(),
                seed: result.seed,
                n,
                user: None,
                prompt: prompt.to_string(),
                inputs: inputs.clone(),
                stream: false,
                partial_images: None,
                provider_params: provider_options.clone(),
                warnings: response.warnings.clone(),
            };
            let result_metadata = map_object(json!({
                "cost_total_usd": success_cost_metrics.cost_total_usd,
                "cost_per_1k_images_usd": success_cost_metrics.cost_per_1k_images_usd,
                "latency_per_image_s": success_cost_metrics.latency_per_image_s,
            }));
            let receipt = build_receipt(
                &request,
                &resolved,
                &response.provider_request,
                &response.provider_response,
                &response.warnings,
                &result.image_path,
                &receipt_path,
                &result_metadata,
            );
            write_receipt(&receipt_path, &receipt)?;

            let artifact = map_object(json!({
                "artifact_id": artifact_id,
                "image_path": result.image_path.to_string_lossy().to_string(),
                "receipt_path": receipt_path.to_string_lossy().to_string(),
                "metrics": result_metadata,
            }));
            artifacts.push(artifact.clone());
            self.thread
                .add_artifact(&version.version_id, artifact.clone());
            self.events.emit(
                "artifact_created",
                map_object(json!({
                    "version_id": version.version_id,
                    "artifact_id": artifact.get("artifact_id"),
                    "image_path": artifact.get("image_path"),
                    "receipt_path": artifact.get("receipt_path"),
                    "metrics": artifact.get("metrics").cloned().unwrap_or(Value::Object(Map::new())),
                })),
            )?;
        }

        self.thread.save()?;
        self.cache.set(
            &cache_key,
            map_object(json!({ "artifacts": artifacts.clone() })),
        )?;
        self.emit_cost_latency_event(&success_cost_metrics)?;

        Ok(artifacts)
    }

    pub fn finish(&mut self) -> Result<()> {
        let total_versions = self.thread.versions.len() as u64;
        let mut total_artifacts = 0u64;
        let mut winners: Vec<Map<String, Value>> = Vec::new();
        for version in &self.thread.versions {
            total_artifacts += version.artifacts.len() as u64;
            if let Some(artifact_id) = &version.selected_artifact_id {
                winners.push(map_object(json!({
                    "version_id": version.version_id,
                    "artifact_id": artifact_id,
                })));
            }
        }
        let summary = RunSummary {
            run_id: self.run_id.clone(),
            started_at: self.started_at.clone(),
            finished_at: now_utc_iso(),
            total_versions,
            total_artifacts,
            winners,
        };
        write_summary(&self.summary_path, &summary, None)?;
        self.events.emit(
            "run_finished",
            map_object(json!({
                "summary_path": self.summary_path.to_string_lossy().to_string()
            })),
        )?;
        Ok(())
    }

    fn build_cost_latency_metrics(
        &self,
        model_spec: &ModelSpec,
        n: u64,
        measured_latency: f64,
        cached: bool,
        size: &str,
        provider_options: &Map<String, Value>,
    ) -> CostLatencyMetrics {
        let estimate = estimate_image_cost_with_params(
            &self.pricing_tables,
            model_spec.pricing_key.as_deref(),
            size,
            provider_options,
        );
        let latency_per_image_s = estimate_image_latency_per_image(
            &self.pricing_tables,
            model_spec.latency_key.as_deref(),
            measured_latency,
        );
        let cost_total_usd = estimate
            .cost_per_image_usd
            .map(|value| if cached { 0.0 } else { value * n as f64 })
            .unwrap_or(0.0);
        let cost_per_1k_images_usd = estimate.cost_per_1k_images_usd.unwrap_or(0.0);
        CostLatencyMetrics {
            provider: model_spec.provider.clone(),
            model: model_spec.name.clone(),
            cost_total_usd,
            cost_per_1k_images_usd,
            latency_per_image_s,
        }
    }

    fn emit_cost_latency_event(&mut self, metrics: &CostLatencyMetrics) -> Result<()> {
        self.last_cost_latency = Some(metrics.clone());
        self.events.emit(
            "cost_latency_update",
            map_object(json!({
                "provider": metrics.provider,
                "model": metrics.model,
                "cost_total_usd": metrics.cost_total_usd,
                "cost_per_1k_images_usd": metrics.cost_per_1k_images_usd,
                "latency_per_image_s": metrics.latency_per_image_s,
            })),
        )?;
        Ok(())
    }

    fn resolve_image_selection(&self) -> Result<EffectiveImageSelection> {
        let selection = self
            .model_selector
            .select(self.image_model.as_deref(), "image")
            .map_err(anyhow::Error::msg)?;
        let mut model = selection.model;
        let mut fallback_reason = selection.fallback_reason;
        let requested = selection
            .requested
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let requested_dryrun = requested.starts_with("dryrun");

        let best_non_dryrun = self
            .model_selector
            .registry
            .by_capability("image")
            .into_iter()
            .find(|candidate| {
                candidate.provider != "dryrun" && self.providers.get(&candidate.provider).is_some()
            });

        if self.providers.get(&model.provider).is_some() {
            if model.provider == "dryrun" && !requested_dryrun {
                if let Some(preferred) = best_non_dryrun.clone() {
                    let reason = format!(
                        "Requested model resolved to dryrun; using '{}' with native provider '{}'.",
                        preferred.name, preferred.provider
                    );
                    model = preferred;
                    fallback_reason = append_fallback_reason(fallback_reason, reason);
                }
            }
            return Ok(EffectiveImageSelection {
                model,
                fallback_reason,
            });
        }

        let fallback_model = self
            .model_selector
            .registry
            .by_capability("image")
            .into_iter()
            .find(|candidate| {
                candidate.provider != "dryrun" && self.providers.get(&candidate.provider).is_some()
            })
            .or_else(|| {
                self.model_selector
                    .registry
                    .by_capability("image")
                    .into_iter()
                    .find(|candidate| self.providers.get(&candidate.provider).is_some())
            });
        let Some(fallback_model) = fallback_model else {
            let available = self.providers.names().join(", ");
            bail!(
                "no native image providers registered (available: [{}])",
                available
            );
        };

        let reason = format!(
            "Provider '{}' for model '{}' unavailable in native runtime; using '{}'.",
            model.provider, model.name, fallback_model.name
        );
        model = fallback_model;
        fallback_reason = append_fallback_reason(fallback_reason, reason);

        Ok(EffectiveImageSelection {
            model,
            fallback_reason,
        })
    }
}

fn append_fallback_reason(existing: Option<String>, reason: String) -> Option<String> {
    if reason.trim().is_empty() {
        return existing;
    }
    match existing {
        Some(previous) if !previous.trim().is_empty() => Some(format!("{previous} {reason}")),
        _ => Some(reason),
    }
}

fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    ((text.chars().count() as f64) / 4.0).ceil() as u64
}

fn apply_quality_preset(settings: &Map<String, Value>, model: &ModelSpec) -> Map<String, Value> {
    let mut updated = settings.clone();
    let preset = updated
        .get("quality_preset")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if preset.is_empty() {
        return updated;
    }
    if model.provider != "openai" || !model.name.starts_with("gpt-image") {
        return updated;
    }

    let quality = match preset.as_str() {
        "fast" | "cheaper" => Some("low"),
        "quality" | "better" => Some("high"),
        "standard" | "medium" => Some("medium"),
        "auto" => Some("auto"),
        _ => None,
    };
    if let Some(quality) = quality {
        let mut provider_options = updated
            .get("provider_options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        provider_options.insert("quality".to_string(), Value::String(quality.to_string()));
        updated.insert(
            "provider_options".to_string(),
            Value::Object(provider_options),
        );
    }
    updated
}

fn parse_dims(size: &str) -> (u32, u32) {
    let raw = size.trim().to_ascii_lowercase();
    if let Some((w, h)) = raw.split_once('x') {
        let width = w.trim().parse::<u32>().unwrap_or(1024);
        let height = h.trim().parse::<u32>().unwrap_or(1024);
        return (width.max(1), height.max(1));
    }
    (1024, 1024)
}

fn load_pricing_tables() -> BTreeMap<String, Map<String, Value>> {
    let mut merged = parse_pricing_table_rows(DEFAULT_PRICING_TABLES_JSON);
    if let Some(path) = pricing_override_path() {
        if let Ok(raw) = fs::read_to_string(path) {
            merge_pricing_table_rows(&mut merged, &raw);
        }
    }
    merged
}

fn pricing_override_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".brood").join("pricing_overrides.json"))
}

fn parse_pricing_table_rows(raw: &str) -> BTreeMap<String, Map<String, Value>> {
    let mut rows = BTreeMap::new();
    merge_pricing_table_rows(&mut rows, raw);
    rows
}

fn merge_pricing_table_rows(rows: &mut BTreeMap<String, Map<String, Value>>, raw: &str) {
    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let Some(table) = payload.as_object() else {
        return;
    };
    for (pricing_key, row_value) in table {
        let Some(row) = row_value.as_object() else {
            continue;
        };
        let entry = rows.entry(pricing_key.to_string()).or_default();
        for (field, field_value) in row {
            entry.insert(field.to_string(), field_value.clone());
        }
    }
}

fn estimate_image_cost_with_params(
    pricing_tables: &BTreeMap<String, Map<String, Value>>,
    pricing_key: Option<&str>,
    size: &str,
    provider_options: &Map<String, Value>,
) -> ImageCostEstimate {
    let Some(pricing_key) = pricing_key.map(str::trim).filter(|value| !value.is_empty()) else {
        return ImageCostEstimate {
            cost_per_image_usd: None,
            cost_per_1k_images_usd: None,
        };
    };
    let Some(row) = pricing_tables.get(pricing_key) else {
        return ImageCostEstimate {
            cost_per_image_usd: None,
            cost_per_1k_images_usd: None,
        };
    };
    let Some(base_cost) = row.get("cost_per_image_usd").and_then(parse_value_to_f64) else {
        return ImageCostEstimate {
            cost_per_image_usd: None,
            cost_per_1k_images_usd: None,
        };
    };

    let mut resolved = ImageCostEstimate {
        cost_per_image_usd: Some(base_cost),
        cost_per_1k_images_usd: Some(base_cost * 1000.0),
    };

    let Some(tier) = resolve_image_size_tier(size, provider_options) else {
        return resolved;
    };

    if let Some(abs_map) = row
        .get("cost_per_image_usd_by_image_size")
        .and_then(Value::as_object)
    {
        if let Some(cost) = abs_map.get(&tier).and_then(parse_value_to_f64) {
            resolved.cost_per_image_usd = Some(cost);
            resolved.cost_per_1k_images_usd = Some(cost * 1000.0);
            return resolved;
        }
    }

    if let Some(mult_map) = row
        .get("cost_multipliers_by_image_size")
        .and_then(Value::as_object)
    {
        if let Some(multiplier) = mult_map.get(&tier).and_then(parse_value_to_f64) {
            let cost = base_cost * multiplier;
            resolved.cost_per_image_usd = Some(cost);
            resolved.cost_per_1k_images_usd = Some(cost * 1000.0);
        }
    }

    resolved
}

fn estimate_image_latency_per_image(
    pricing_tables: &BTreeMap<String, Map<String, Value>>,
    latency_key: Option<&str>,
    measured_latency: f64,
) -> f64 {
    let Some(latency_key) = latency_key.map(str::trim).filter(|value| !value.is_empty()) else {
        return measured_latency;
    };
    let Some(row) = pricing_tables.get(latency_key) else {
        return measured_latency;
    };
    row.get("latency_per_image_s")
        .and_then(parse_value_to_f64)
        .unwrap_or(measured_latency)
}

fn resolve_image_size_tier(size: &str, provider_options: &Map<String, Value>) -> Option<String> {
    if let Some(raw) = provider_options.get("image_size").and_then(Value::as_str) {
        let normalized = raw.trim().to_ascii_uppercase();
        if matches!(normalized.as_str(), "1K" | "2K" | "4K") {
            return Some(normalized);
        }
    }

    let normalized = size.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if matches!(normalized.as_str(), "1k" | "2k" | "4k") {
        return Some(normalized.to_ascii_uppercase());
    }

    let (width, height) = parse_size_dims_for_pricing_tier(&normalized)?;
    let longest = width.max(height);
    if longest >= 3600 {
        return Some("4K".to_string());
    }
    if longest >= 1800 {
        return Some("2K".to_string());
    }
    None
}

fn parse_size_dims_for_pricing_tier(raw: &str) -> Option<(u32, u32)> {
    let (left, right) = raw.split_once('x')?;
    let width = left.trim().parse::<u32>().ok()?;
    let height = right.trim().parse::<u32>().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

fn snap_multiple(value: u32, multiple: u32) -> u32 {
    if multiple <= 1 {
        return value.max(1);
    }
    let rounded = ((value as f64 / multiple as f64).round() as u32) * multiple;
    rounded.max(multiple)
}

fn normalize_output_extension(output_format: &str) -> &'static str {
    let mut lowered = output_format.trim().to_ascii_lowercase();
    if let Some(value) = lowered.strip_prefix("image/") {
        lowered = value.to_string();
    }
    match lowered.as_str() {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "png" => "png",
        _ => "png",
    }
}

fn normalize_flux_output_format_option(raw: &str) -> Option<&'static str> {
    let mut lowered = raw.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    if let Some(value) = lowered.strip_prefix("image/") {
        lowered = value.to_string();
    }
    match lowered.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpeg"),
        _ => None,
    }
}

fn parse_value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(raw) => raw
            .as_i64()
            .or_else(|| raw.as_f64().map(|number| number.round() as i64)),
        Value::String(raw) => raw.trim().parse::<f64>().ok().map(|v| v.round() as i64),
        _ => None,
    }
}

fn parse_value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(raw) => raw.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn trim_float(value: f64) -> String {
    let text = format!("{value:.6}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn coerce_flux_input_image_value(raw: &str) -> Result<String> {
    let value = raw.trim();
    if value.is_empty() {
        bail!("FLUX input image value is empty");
    }
    let lowered = value.to_ascii_lowercase();
    if lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("data:image/")
    {
        return Ok(value.to_string());
    }
    let path = PathBuf::from(value);
    if path.exists() && path.is_file() {
        let bytes =
            fs::read(&path).with_context(|| format!("failed reading {}", path.display()))?;
        return Ok(BASE64.encode(bytes));
    }
    Ok(value.to_string())
}

fn flux_input_source_label(raw: &str) -> &'static str {
    let value = raw.trim();
    if value.is_empty() {
        return "empty";
    }
    let lowered = value.to_ascii_lowercase();
    if lowered.starts_with("http://") || lowered.starts_with("https://") {
        return "url";
    }
    if lowered.starts_with("data:image/") {
        return "data_url";
    }
    let path = PathBuf::from(value);
    if path.exists() && path.is_file() {
        return "path";
    }
    "base64_or_remote_id"
}

fn value_as_f64(value: Option<&Value>, default: f64, min: f64, max: f64) -> f64 {
    let parsed = value.and_then(|row| match row {
        Value::Number(num) => num.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    });
    parsed.unwrap_or(default).clamp(min, max)
}

fn value_as_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(raw) => Some(*raw),
        Value::Number(raw) => raw.as_i64().map(|value| value != 0),
        Value::String(raw) => {
            let lowered = raw.trim().to_ascii_lowercase();
            if matches!(lowered.as_str(), "1" | "true" | "yes" | "on") {
                Some(true)
            } else if matches!(lowered.as_str(), "0" | "false" | "no" | "off") {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn image_inputs_from_settings(settings: &Map<String, Value>) -> ImageInputs {
    let init_image = settings
        .get("init_image")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mask = settings
        .get("mask")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reference_images = settings
        .get("reference_images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_str().map(str::trim).map(str::to_string))
        .filter(|row| !row.is_empty())
        .collect::<Vec<String>>();
    ImageInputs {
        init_image,
        mask,
        reference_images,
    }
}

fn request_metadata_from_intent(intent: &Map<String, Value>) -> Map<String, Value> {
    let mut metadata = Map::new();
    if let Some(raw) = intent.get("request_metadata").and_then(Value::as_object) {
        for (key, value) in raw {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    if let Some(packet) = intent
        .get("gemini_context_packet")
        .and_then(Value::as_object)
    {
        metadata.insert(
            "gemini_context_packet".to_string(),
            Value::Object(packet.clone()),
        );
    }
    if let Some(envelope) = intent
        .get("model_context_envelope")
        .and_then(Value::as_object)
    {
        metadata.insert(
            "model_context_envelope".to_string(),
            Value::Object(envelope.clone()),
        );
    }
    metadata
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn merge_openai_provider_options(
    payload: &mut Map<String, Value>,
    options: &Map<String, Value>,
    allowed_keys: &[&str],
    warnings: &mut Vec<String>,
) {
    for (raw_key, value) in options {
        let key = raw_key.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        if matches!(
            key.as_str(),
            "allow_seed"
                | "openai_allow_seed"
                | "seed"
                | "use_responses"
                | "openai_use_responses"
                | "responses_model"
                | "openai_responses_model"
        ) {
            continue;
        }
        if !allowed_keys.iter().any(|allowed| *allowed == key.as_str()) {
            continue;
        }
        if payload.contains_key(&key) {
            continue;
        }
        if let Some(normalized) = normalize_openai_option_value(&key, value, warnings) {
            payload.insert(key, normalized);
        }
    }
}

fn merge_openai_options_for_form(
    payload_manifest: &Map<String, Value>,
    options: &Map<String, Value>,
    allowed_keys: &[&str],
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (raw_key, value) in options {
        let key = raw_key.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        if matches!(
            key.as_str(),
            "allow_seed"
                | "openai_allow_seed"
                | "seed"
                | "use_responses"
                | "openai_use_responses"
                | "responses_model"
                | "openai_responses_model"
        ) {
            continue;
        }
        if !allowed_keys.iter().any(|allowed| *allowed == key.as_str()) {
            continue;
        }
        if payload_manifest.contains_key(&key) {
            continue;
        }
        if let Some(normalized) = normalize_openai_option_value(&key, value, warnings) {
            out.insert(key, normalized);
        }
    }
    out
}

fn json_value_to_form_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(raw) => raw.to_string(),
        Value::Number(raw) => raw.to_string(),
        Value::String(raw) => raw.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn mime_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn should_send_openai_seed(options: &Map<String, Value>) -> bool {
    for key in ["openai_allow_seed", "allow_seed"] {
        let Some(raw) = options.get(key) else {
            continue;
        };
        return match raw {
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_i64().map(|number| number != 0).unwrap_or(false),
            Value::String(value) => {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            }
            _ => false,
        };
    }
    false
}

fn is_openai_gpt_image_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("gpt-image")
}

fn normalize_openrouter_model_for_image_transport(raw: &str, default_model: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default_model.to_string();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains('/') {
        return match lowered.as_str() {
            "google/gemini-3.0-flash" => "google/gemini-3-flash-preview".to_string(),
            "google/gemini-2.0-flash" => "google/gemini-2.0-flash-001".to_string(),
            "google/gemini-2.5-flash-image" => "google/gemini-2.5-flash-image-preview".to_string(),
            _ => trimmed.to_string(),
        };
    }

    if lowered.starts_with("gpt-")
        || lowered.starts_with("o1")
        || lowered.starts_with("o3")
        || lowered.starts_with("o4")
    {
        return format!("openai/{trimmed}");
    }

    if lowered.starts_with("gemini-") {
        let normalized = match lowered.as_str() {
            "gemini-3.0-flash" => "gemini-3-flash-preview".to_string(),
            "gemini-2.0-flash" => "gemini-2.0-flash-001".to_string(),
            "gemini-2.5-flash-image" => "gemini-2.5-flash-image-preview".to_string(),
            _ => trimmed.to_string(),
        };
        return format!("google/{normalized}");
    }

    if lowered.starts_with("imagen-") {
        return format!("google/{trimmed}");
    }

    if lowered.starts_with("flux-") {
        if let Some(mapped) = FluxProvider::map_flux_model_to_openrouter(trimmed) {
            return mapped.to_string();
        }
    }

    if lowered.starts_with("bfl/") {
        if let Some((_, suffix)) = trimmed.split_once('/') {
            return format!("black-forest-labs/{suffix}");
        }
    }

    trimmed.to_string()
}

fn openrouter_image_model_aliases(raw: &str) -> Vec<String> {
    let normalized = normalize_openrouter_model_for_image_transport(raw, raw);
    let lowered = normalized.to_ascii_lowercase();
    let canonical = lowered.strip_prefix("google/").unwrap_or(lowered.as_str());
    let mut out = Vec::new();
    match canonical {
        "imagen-4.0-ultra" | "imagen-4-ultra" => {
            out.push("google/imagen-4.0-ultra-generate-001".to_string());
        }
        "imagen-4" | "imagen-4.0" => {
            out.push("google/imagen-4.0-generate-001".to_string());
        }
        "gemini-2.5-flash-image" => {
            out.push("google/gemini-2.5-flash-image-preview".to_string());
        }
        _ => {}
    }
    out.retain(|candidate| candidate != &normalized);
    out
}

fn normalize_openai_size(raw: &str, warnings: &mut Vec<String>) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "1024x1024".to_string();
    }
    if normalized == "auto" || normalized == "default" {
        return "auto".to_string();
    }
    if normalized == "portrait" || normalized == "tall" {
        return "1024x1536".to_string();
    }
    if normalized == "landscape" || normalized == "wide" {
        return "1536x1024".to_string();
    }
    if normalized == "square" || normalized == "1:1" {
        return "1024x1024".to_string();
    }

    let mut ratio: Option<f64> = None;
    if let Some((left, right)) = parse_openai_dims(&normalized) {
        let key = format!("{left}x{right}");
        if matches!(key.as_str(), "1024x1024" | "1024x1536" | "1536x1024") {
            return key;
        }
        ratio = Some(left as f64 / right as f64);
    } else if let Some((left, right)) = parse_openai_ratio(&normalized) {
        ratio = Some(left as f64 / right as f64);
    }

    let Some(target_ratio) = ratio else {
        push_unique_warning(
            warnings,
            "OpenAI size unsupported; using 1024x1024.".to_string(),
        );
        return "1024x1024".to_string();
    };
    let candidates = [
        ("1024x1024", 1024f64 / 1024f64),
        ("1024x1536", 1024f64 / 1536f64),
        ("1536x1024", 1536f64 / 1024f64),
    ];
    let mut best_key = "1024x1024";
    let mut best_delta = f64::MAX;
    for (key, value) in candidates {
        let delta = (value - target_ratio).abs();
        if delta < best_delta {
            best_key = key;
            best_delta = delta;
        }
    }
    push_unique_warning(warnings, format!("OpenAI size snapped to {best_key}."));
    best_key.to_string()
}

fn parse_openai_dims(raw: &str) -> Option<(u32, u32)> {
    let (left, right) = raw.split_once('x')?;
    let width = left.trim().parse::<u32>().ok()?;
    let height = right.trim().parse::<u32>().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

fn parse_openai_ratio(raw: &str) -> Option<(u32, u32)> {
    let (left, right) = if let Some(parts) = raw.split_once(':') {
        parts
    } else {
        raw.split_once('/')?
    };
    let first = left.trim().parse::<u32>().ok()?;
    let second = right.trim().parse::<u32>().ok()?;
    if first == 0 || second == 0 {
        return None;
    }
    Some((first, second))
}

fn normalize_openai_output_format(raw: &str, warnings: &mut Vec<String>) -> Option<&'static str> {
    let mut normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if let Some(value) = normalized.strip_prefix("image/") {
        normalized = value.to_string();
    }
    let value = match normalized.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpeg"),
        "webp" => Some("webp"),
        _ => None,
    };
    if value.is_none() {
        push_unique_warning(
            warnings,
            format!(
                "OpenAI output_format '{}' unsupported; using provider default.",
                raw
            ),
        );
    }
    value
}

fn normalize_openai_background(raw: &str, warnings: &mut Vec<String>) -> Option<&'static str> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "auto" => Some("auto"),
        "transparent" => Some("transparent"),
        "opaque" => Some("opaque"),
        _ => {
            push_unique_warning(
                warnings,
                format!("OpenAI background '{}' unsupported; omitting.", raw),
            );
            None
        }
    }
}

fn normalize_openai_option_value(
    key: &str,
    value: &Value,
    warnings: &mut Vec<String>,
) -> Option<Value> {
    match key {
        "quality" => {
            let normalized = value
                .as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_ascii_lowercase);
            let mapped = match normalized.as_deref() {
                Some("low" | "fast" | "cheaper") => Some("low"),
                Some("medium" | "standard") => Some("medium"),
                Some("high" | "hd" | "quality" | "better") => Some("high"),
                Some("auto") => Some("auto"),
                Some(other) => {
                    push_unique_warning(
                        warnings,
                        format!("OpenAI quality '{}' unsupported; using auto.", other),
                    );
                    Some("auto")
                }
                None => None,
            }?;
            Some(Value::String(mapped.to_string()))
        }
        "moderation" => {
            let normalized = value
                .as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_ascii_lowercase);
            let mapped = match normalized.as_deref() {
                Some("auto" | "low") => normalized.unwrap_or_default(),
                Some(other) => {
                    push_unique_warning(
                        warnings,
                        format!("OpenAI moderation '{}' unsupported; using auto.", other),
                    );
                    "auto".to_string()
                }
                None => return None,
            };
            Some(Value::String(mapped))
        }
        "output_compression" => {
            let number = match value {
                Value::Number(raw) => raw.as_f64(),
                Value::String(raw) => raw.trim().parse::<f64>().ok(),
                _ => None,
            };
            let Some(number) = number else {
                push_unique_warning(
                    warnings,
                    format!(
                        "OpenAI output_compression '{}' unsupported; ignoring.",
                        value
                    ),
                );
                return None;
            };
            let original = number.round() as i64;
            let clamped = original.clamp(0, 100);
            if clamped != original {
                push_unique_warning(
                    warnings,
                    format!("OpenAI output_compression clamped to {clamped}."),
                );
            }
            Some(Value::Number(clamped.into()))
        }
        "input_fidelity" => {
            let normalized = value
                .as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_ascii_lowercase);
            match normalized.as_deref() {
                Some("low" | "high") => Some(Value::String(normalized.unwrap_or_default())),
                Some(other) => {
                    push_unique_warning(
                        warnings,
                        format!("OpenAI input_fidelity '{}' unsupported; ignoring.", other),
                    );
                    None
                }
                None => None,
            }
        }
        _ => Some(value.clone()),
    }
}

fn output_extension_from_mime_or_format(mime: Option<&str>, output_format: &str) -> &'static str {
    if let Some(mime) = mime {
        let lowered = mime.to_ascii_lowercase();
        if lowered.contains("jpeg") || lowered.contains("jpg") {
            return "jpg";
        }
        if lowered.contains("webp") {
            return "webp";
        }
        if lowered.contains("png") {
            return "png";
        }
    }
    normalize_output_extension(output_format)
}

fn response_json_or_error(provider: &str, response: HttpResponse) -> Result<Value> {
    let status = response.status();
    let code = status.as_u16();
    let body = response
        .text()
        .with_context(|| format!("{provider} response body read failed"))?;
    if !status.is_success() {
        bail!(
            "{provider} request failed ({code}): {}",
            truncate_text(&body, 512)
        );
    }
    let parsed: Value = serde_json::from_str(&body)
        .with_context(|| format!("{provider} returned invalid JSON payload"))?;
    Ok(parsed)
}

fn is_retryable_transport_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .map(|reqwest_err| {
                reqwest_err.is_timeout() || reqwest_err.is_connect() || reqwest_err.is_request()
            })
            .unwrap_or(false)
    })
}

fn error_chain_text(err: &anyhow::Error, max_chars: usize) -> String {
    let mut parts = Vec::new();
    for cause in err.chain() {
        let text = cause.to_string();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if parts
            .last()
            .map(|existing| existing == trimmed)
            .unwrap_or(false)
        {
            continue;
        }
        parts.push(trimmed.to_string());
    }
    if parts.is_empty() {
        return truncate_text(&err.to_string(), max_chars);
    }
    truncate_text(&parts.join(" | caused by: "), max_chars)
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "…"
}

fn push_unique_warning(warnings: &mut Vec<String>, message: String) {
    if message.trim().is_empty() {
        return;
    }
    if warnings.iter().any(|existing| existing == &message) {
        return;
    }
    warnings.push(message);
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn image_part_from_path(path: &Path) -> Result<Value> {
    let bytes = fs::read(path).with_context(|| format!("failed reading {}", path.display()))?;
    let mime = mime_for_path(path).unwrap_or("image/png");
    Ok(json!({
        "inlineData": {
            "mimeType": mime,
            "data": BASE64.encode(bytes),
        }
    }))
}

fn write_dryrun_image(
    path: &Path,
    width: u32,
    height: u32,
    prompt: &str,
    seed: Option<i64>,
) -> Result<()> {
    let (r, g, b) = color_from_prompt(prompt, seed.unwrap_or_default() as u64);
    let mut image = RgbImage::new(width, height);
    for pixel in image.pixels_mut() {
        *pixel = Rgb([r, g, b]);
    }
    image
        .save(path)
        .with_context(|| format!("failed to save {}", path.display()))?;
    Ok(())
}

fn color_from_prompt(prompt: &str, seed: u64) -> (u8, u8, u8) {
    let mut hasher = Sha256::new();
    hasher.update(prompt.as_bytes());
    hasher.update(seed.to_be_bytes());
    let digest = hasher.finalize();
    (digest[0], digest[1], digest[2])
}

fn short_id(prompt: &str, idx: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prompt.as_bytes());
    hasher.update(idx.to_be_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..4])
}

fn stable_hash(payload: &Value) -> String {
    let bytes = serde_json::to_vec(payload).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn map_object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn now_utc_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}

fn format_gemini_context_packet(packet: &Map<String, Value>) -> String {
    let packet_json = serde_json::to_string(packet).unwrap_or_else(|_| "{}".to_string());
    format!("BROOD_CONTEXT_PACKET_JSON:\n{packet_json}")
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use std::fs;
    use std::path::Path;

    use brood_contracts::runs::receipts::ImageInputs;
    use serde_json::{json, Map, Value};

    use brood_contracts::models::ModelSpec;

    use super::BASE64;
    use super::{
        apply_quality_preset, default_provider_registry, error_chain_text,
        estimate_image_cost_with_params, image_inputs_from_settings, merge_openai_options_for_form,
        merge_openai_provider_options, normalize_openai_output_format, normalize_openai_size,
        parse_pricing_table_rows, request_metadata_from_intent, resolve_image_size_tier,
        FluxProvider, GeminiProvider, ImagenProvider, NativeEngine, OpenAiProvider,
        ProviderGenerateRequest,
    };

    #[test]
    fn native_engine_generates_artifacts_and_events() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            Some("dryrun-image-1".to_string()),
        )?;
        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("256x256"));
        settings.insert("n".to_string(), json!(1));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));
        let artifacts = engine.generate("boat", settings, intent)?;
        assert_eq!(artifacts.len(), 1);
        engine.finish()?;

        let raw = std::fs::read_to_string(events_path)?;
        let types: Vec<String> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|row| row.get("type").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert!(types.contains(&"plan_preview".to_string()));
        assert!(types.contains(&"version_created".to_string()));
        assert!(types.contains(&"artifact_created".to_string()));
        assert!(types.contains(&"cost_latency_update".to_string()));
        assert!(types.contains(&"run_finished".to_string()));
        Ok(())
    }

    #[test]
    fn native_engine_generation_event_order_contract() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            Some("dryrun-image-1".to_string()),
        )?;
        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("256x256"));
        settings.insert("n".to_string(), json!(1));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));
        let _ = engine.generate("boat", settings, intent)?;

        let raw = fs::read_to_string(events_path)?;
        let types: Vec<String> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|row| row.get("type").and_then(Value::as_str).map(str::to_string))
            .collect();

        let plan_idx = types
            .iter()
            .position(|value| value == "plan_preview")
            .expect("missing plan_preview");
        let version_idx = types
            .iter()
            .position(|value| value == "version_created")
            .expect("missing version_created");
        let artifact_idx = types
            .iter()
            .position(|value| value == "artifact_created")
            .expect("missing artifact_created");
        let cost_idx = types
            .iter()
            .position(|value| value == "cost_latency_update")
            .expect("missing cost_latency_update");

        assert!(plan_idx < version_idx);
        assert!(version_idx < artifact_idx);
        assert!(artifact_idx < cost_idx);
        Ok(())
    }

    #[test]
    fn preview_plan_reports_cache_hit_after_generation() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            Some("dryrun-image-1".to_string()),
        )?;

        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("128x128"));
        settings.insert("n".to_string(), json!(1));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));

        let plan_before = engine.preview_plan("boat", &settings, &intent)?;
        assert!(!plan_before.cached);

        let _ = engine.generate("boat", settings.clone(), intent.clone())?;

        let plan_after = engine.preview_plan("boat", &settings, &intent)?;
        assert!(plan_after.cached);
        Ok(())
    }

    #[test]
    fn preview_plan_prefers_real_provider_when_dryrun_not_requested() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            None,
        )?;
        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("256x256"));
        settings.insert("n".to_string(), json!(1));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));

        let plan = engine.preview_plan("boat", &settings, &intent)?;
        assert_ne!(plan.provider, "dryrun");
        Ok(())
    }

    #[test]
    fn preview_plan_honors_explicit_dryrun_model() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            Some("dryrun-image-1".to_string()),
        )?;
        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("256x256"));
        settings.insert("n".to_string(), json!(1));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));

        let plan = engine.preview_plan("boat", &settings, &intent)?;
        assert_eq!(plan.provider, "dryrun");
        Ok(())
    }

    #[test]
    fn quality_preset_maps_to_openai_provider_quality() {
        let model = ModelSpec {
            name: "gpt-image-1".to_string(),
            provider: "openai".to_string(),
            capabilities: vec!["image".to_string()],
            context_window: None,
            pricing_key: None,
            latency_key: None,
        };
        let mut settings = Map::new();
        settings.insert("quality_preset".to_string(), json!("cheaper"));

        let mapped = apply_quality_preset(&settings, &model);
        assert_eq!(mapped["provider_options"]["quality"], json!("low"));
    }

    #[test]
    fn quality_preset_does_not_mutate_non_openai_models() {
        let model = ModelSpec {
            name: "gemini-3-pro-image-preview".to_string(),
            provider: "gemini".to_string(),
            capabilities: vec!["image".to_string()],
            context_window: None,
            pricing_key: None,
            latency_key: None,
        };
        let mut settings = Map::new();
        settings.insert("quality_preset".to_string(), json!("better"));

        let mapped = apply_quality_preset(&settings, &model);
        assert!(mapped.get("provider_options").is_none());
    }

    #[test]
    fn pricing_size_tier_matches_python_contract() {
        let provider_options = Map::new();
        assert_eq!(
            resolve_image_size_tier("1536x1024", &provider_options),
            None
        );
        assert_eq!(
            resolve_image_size_tier("2048x1024", &provider_options),
            Some("2K".to_string())
        );
        assert_eq!(
            resolve_image_size_tier("4096x2048", &provider_options),
            Some("4K".to_string())
        );

        let mut explicit = Map::new();
        explicit.insert("image_size".to_string(), json!("1K"));
        assert_eq!(
            resolve_image_size_tier("4096x2048", &explicit),
            Some("1K".to_string())
        );
    }

    #[test]
    fn pricing_estimator_applies_size_tier_multiplier() {
        let tables = parse_pricing_table_rows(
            r#"{
                "google-gemini-3-pro-image-preview": {
                    "cost_per_image_usd": 0.134,
                    "cost_multipliers_by_image_size": { "1K": 0.75, "2K": 1.0, "4K": 2.0 }
                }
            }"#,
        );
        let mut provider_options = Map::new();
        provider_options.insert("image_size".to_string(), json!("4K"));
        let estimate = estimate_image_cost_with_params(
            &tables,
            Some("google-gemini-3-pro-image-preview"),
            "1024x1024",
            &provider_options,
        );
        assert!(estimate
            .cost_per_image_usd
            .map(|value| (value - 0.268).abs() < 1e-9)
            .unwrap_or(false));
        assert!(estimate
            .cost_per_1k_images_usd
            .map(|value| (value - 268.0).abs() < 1e-9)
            .unwrap_or(false));
    }

    #[test]
    fn native_engine_emits_estimated_cost_for_receipts_and_events() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let run_dir = temp.path().join("run");
        let events_path = run_dir.join("events.jsonl");
        let mut engine = NativeEngine::new(
            &run_dir,
            &events_path,
            Some("dryrun-text-1".to_string()),
            Some("dryrun-image-1".to_string()),
        )?;
        engine.pricing_tables = parse_pricing_table_rows(
            r#"{
                "dryrun-image": {
                    "cost_per_image_usd": 0.25,
                    "latency_per_image_s": 1.5
                }
            }"#,
        );

        let mut settings = Map::new();
        settings.insert("size".to_string(), json!("1024x1024"));
        settings.insert("n".to_string(), json!(2));
        let mut intent = Map::new();
        intent.insert("action".to_string(), json!("generate"));

        let artifacts = engine.generate("priced dryrun", settings.clone(), intent.clone())?;
        assert_eq!(artifacts.len(), 2);
        let metrics = engine.last_cost_latency().expect("missing cost metrics");
        assert!((metrics.cost_total_usd - 0.5).abs() < 1e-9);
        assert!((metrics.cost_per_1k_images_usd - 250.0).abs() < 1e-9);
        assert!((metrics.latency_per_image_s - 1.5).abs() < 1e-9);

        let receipt_path = artifacts[0]
            .get("receipt_path")
            .and_then(Value::as_str)
            .map(Path::new)
            .expect("missing receipt path");
        let receipt: Value = serde_json::from_str(&fs::read_to_string(receipt_path)?)?;
        assert_eq!(receipt["result_metadata"]["cost_total_usd"], json!(0.5));
        assert_eq!(
            receipt["result_metadata"]["cost_per_1k_images_usd"],
            json!(250.0)
        );

        let raw = fs::read_to_string(events_path)?;
        let cost_event = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|row| row.get("type").and_then(Value::as_str) == Some("cost_latency_update"))
            .expect("missing cost_latency_update event");
        assert_eq!(cost_event.get("cost_total_usd"), Some(&json!(0.5)));
        assert_eq!(
            cost_event.get("cost_per_1k_images_usd"),
            Some(&json!(250.0))
        );

        let _ = engine.generate("priced dryrun", settings, intent)?;
        let cached_metrics = engine.last_cost_latency().expect("missing cached metrics");
        assert!((cached_metrics.cost_total_usd - 0.0).abs() < 1e-9);
        assert!((cached_metrics.cost_per_1k_images_usd - 250.0).abs() < 1e-9);
        Ok(())
    }

    #[test]
    fn openai_payload_normalizes_size_and_quality() {
        let mut warnings = Vec::new();
        let normalized_size = normalize_openai_size("512x512", &mut warnings);
        assert_eq!(normalized_size, "1024x1024");
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("size snapped")));

        let mut payload = Map::new();
        let options = map_object_for_test(json!({
            "quality": "hd",
            "aspect_ratio": "16:9",
            "responses_model": "gpt-4.1-mini",
        }));
        merge_openai_provider_options(
            &mut payload,
            &options,
            &["quality", "moderation", "output_compression"],
            &mut warnings,
        );
        assert_eq!(payload.get("quality"), Some(&json!("high")));
        assert!(!payload.contains_key("aspect_ratio"));
        assert!(!payload.contains_key("responses_model"));
    }

    #[test]
    fn openai_output_format_supports_image_mime_aliases() {
        let mut warnings = Vec::new();
        let normalized = normalize_openai_output_format("image/jpeg", &mut warnings);
        assert_eq!(normalized, Some("jpeg"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn openai_edit_options_normalize_like_python_contract() {
        let payload_manifest = map_object_for_test(json!({
            "model": "gpt-image-1",
            "prompt": "studio product shot",
            "n": 1,
            "size": "1024x1024",
        }));
        let options = map_object_for_test(json!({
            "quality": "hd",
            "moderation": "strict",
            "output_compression": "101",
            "input_fidelity": "ultra",
            "openai_allow_seed": true,
            "responses_model": "gpt-4.1-mini",
        }));
        let mut warnings = Vec::new();
        let normalized = merge_openai_options_for_form(
            &payload_manifest,
            &options,
            &[
                "quality",
                "moderation",
                "output_compression",
                "input_fidelity",
            ],
            &mut warnings,
        );

        assert_eq!(normalized.get("quality"), Some(&json!("high")));
        assert_eq!(normalized.get("moderation"), Some(&json!("auto")));
        assert_eq!(normalized.get("output_compression"), Some(&json!(100)));
        assert!(!normalized.contains_key("input_fidelity"));
        assert!(!normalized.contains_key("openai_allow_seed"));
        assert!(!normalized.contains_key("responses_model"));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("moderation 'strict' unsupported")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("output_compression clamped to 100")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("input_fidelity 'ultra' unsupported")));
    }

    #[test]
    fn openai_edit_input_detection_matches_python_contract() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut request = provider_request_for_test(temp.path());
        assert!(!OpenAiProvider::has_edit_inputs(&request));

        request.inputs.init_image = Some("/tmp/init.png".to_string());
        assert!(OpenAiProvider::has_edit_inputs(&request));

        request.inputs.init_image = None;
        request.inputs.reference_images = vec!["/tmp/ref-a.png".to_string()];
        assert!(OpenAiProvider::has_edit_inputs(&request));

        request.inputs.reference_images.clear();
        request.inputs.mask = Some("/tmp/mask.png".to_string());
        assert!(OpenAiProvider::has_edit_inputs(&request));
    }

    #[test]
    fn flux_ignores_non_flex_steps_and_guidance() {
        let options = map_object_for_test(json!({
            "steps": 12,
            "guidance": 3.0,
            "quality": "high",
            "output_format": "jpg",
        }));
        let mut warnings = Vec::new();
        let sanitized =
            FluxProvider::sanitize_provider_options(&options, "flux-2-pro", &mut warnings);
        assert_eq!(sanitized.get("output_format"), Some(&json!("jpeg")));
        assert!(!sanitized.contains_key("steps"));
        assert!(!sanitized.contains_key("guidance"));
        assert!(!sanitized.contains_key("quality"));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("non-flex endpoint")));
    }

    #[test]
    fn flux_collect_input_images_matches_python_manifest_and_limits() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let init_path = temp.path().join("init.png");
        let ref_path = temp.path().join("ref.jpg");
        fs::write(&init_path, b"init-bytes")?;
        fs::write(&ref_path, b"ref-bytes")?;

        let mut request = provider_request_for_test(temp.path());
        request.model = "flux-2-flex".to_string();
        request.inputs.init_image = Some(init_path.to_string_lossy().to_string());
        request.inputs.reference_images = vec![
            "https://example.com/ref-a.png".to_string(),
            "data:image/png;base64,AAAA".to_string(),
            ref_path.to_string_lossy().to_string(),
            "cmVtb3RlX2lkXzEyMw==".to_string(),
            "remote-id-1".to_string(),
            "remote-id-2".to_string(),
            "remote-id-3".to_string(),
            "remote-id-4".to_string(),
        ];

        let mut warnings = Vec::new();
        let (fields, manifest) =
            FluxProvider::collect_input_images(&request, "flux-2-flex", &mut warnings)?;

        assert_eq!(fields.len(), 8);
        assert!(fields.contains_key("input_image_8"));
        assert!(!fields.contains_key("input_image_9"));
        assert_eq!(manifest.len(), 8);
        let expected_init = super::coerce_flux_input_image_value(
            request.inputs.init_image.as_deref().unwrap_or_default(),
        )?;
        assert_eq!(fields.get("input_image"), Some(&json!(expected_init)));
        assert_eq!(manifest[0].get("source"), Some(&json!("path")));
        assert_eq!(manifest[1].get("source"), Some(&json!("url")));
        assert_eq!(manifest[2].get("source"), Some(&json!("data_url")));
        assert_eq!(manifest[3].get("source"), Some(&json!("path")));
        assert_eq!(
            manifest[4].get("source"),
            Some(&json!("base64_or_remote_id"))
        );
        assert!(warnings
            .iter()
            .any(|warning| warning
                .contains("accepted first 8 input images; dropped 1 extra references")));
        Ok(())
    }

    #[test]
    fn flux_collect_input_images_respects_klein_limit() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let mut request = provider_request_for_test(temp.path());
        request.model = "flux-klein".to_string();
        request.inputs.init_image = Some("https://example.com/init.png".to_string());
        request.inputs.reference_images = vec![
            "https://example.com/ref-1.png".to_string(),
            "https://example.com/ref-2.png".to_string(),
            "https://example.com/ref-3.png".to_string(),
            "https://example.com/ref-4.png".to_string(),
        ];

        let mut warnings = Vec::new();
        let (fields, manifest) =
            FluxProvider::collect_input_images(&request, "flux-klein-pro", &mut warnings)?;
        assert_eq!(fields.len(), 4);
        assert_eq!(manifest.len(), 4);
        assert!(warnings
            .iter()
            .any(|warning| warning
                .contains("accepted first 4 input images; dropped 1 extra references")));
        Ok(())
    }

    #[test]
    fn flux_openrouter_model_candidates_include_mapped_fallback() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut request = provider_request_for_test(temp.path());
        request.model = "flux-2-flex".to_string();
        let mut warnings = Vec::new();
        let candidates = FluxProvider::openrouter_model_candidates(&request, &mut warnings);
        assert!(!candidates.is_empty());
        assert!(candidates.iter().any(|value| value == "flux-2-flex"));
        assert!(candidates
            .iter()
            .any(|value| value == "black-forest-labs/flux-1.1-pro"));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("mapped to OpenRouter model")
                || warning.contains("normalized")));
    }

    #[test]
    fn openrouter_model_normalization_prefixes_common_provider_models() {
        assert_eq!(
            super::normalize_openrouter_model_for_image_transport(
                "gpt-image-1.5",
                "openai/gpt-image-1",
            ),
            "openai/gpt-image-1.5"
        );
        assert_eq!(
            super::normalize_openrouter_model_for_image_transport(
                "gemini-3-pro-image-preview",
                "google/gemini-3-pro-image-preview",
            ),
            "google/gemini-3-pro-image-preview"
        );
        assert_eq!(
            super::normalize_openrouter_model_for_image_transport(
                "gemini-2.5-flash-image",
                "google/gemini-3-pro-image-preview",
            ),
            "google/gemini-2.5-flash-image-preview"
        );
    }

    #[test]
    fn openrouter_model_candidates_include_normalized_gemini_and_imagen_aliases() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut request = provider_request_for_test(temp.path());
        request.model = "gemini-3-pro-image-preview".to_string();
        let mut warnings = Vec::new();
        let candidates = FluxProvider::openrouter_model_candidates(&request, &mut warnings);
        assert!(candidates
            .iter()
            .any(|value| value == "google/gemini-3-pro-image-preview"));

        request.model = "imagen-4.0-ultra".to_string();
        let candidates_imagen = FluxProvider::openrouter_model_candidates(&request, &mut warnings);
        assert!(candidates_imagen
            .iter()
            .any(|value| value == "google/imagen-4.0-ultra"));
        assert!(candidates_imagen
            .iter()
            .any(|value| value == "google/imagen-4.0-ultra-generate-001"));
    }

    #[test]
    fn openrouter_responses_decode_failures_fall_back_to_chat() {
        let body_read_error =
            anyhow::anyhow!("OpenRouter responses response body read failed: connection closed");
        assert!(FluxProvider::should_fallback_openrouter_responses_decode_error(&body_read_error));

        let invalid_json_error = anyhow::anyhow!(
            "OpenRouter responses returned invalid JSON payload: EOF while parsing"
        );
        assert!(
            FluxProvider::should_fallback_openrouter_responses_decode_error(&invalid_json_error)
        );

        let hard_auth_error =
            anyhow::anyhow!("OpenRouter responses request failed (401): unauthorized");
        assert!(!FluxProvider::should_fallback_openrouter_responses_decode_error(&hard_auth_error));
    }

    #[test]
    fn flux_openrouter_extracts_base64_image_from_responses_output() -> anyhow::Result<()> {
        let provider = FluxProvider::new();
        let raw = b"not-real-image-but-bytes";
        let payload = json!({
            "output": [{
                "type": "image_generation_call",
                "status": "completed",
                "result": BASE64.encode(raw),
            }]
        });
        let images = provider.extract_openrouter_generated_images(&payload, 1.0)?;
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].bytes, raw);
        Ok(())
    }

    #[test]
    fn gemini_defaults_match_python_contract() {
        let mut warnings = Vec::new();
        let ratio = GeminiProvider::nearest_ratio_from_size("1536x1024", &mut warnings);
        assert_eq!(ratio.as_deref(), Some("3:2"));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("Gemini aspect ratio snapped to 3:2")));

        let mut keyword_warnings = Vec::new();
        let portrait = GeminiProvider::nearest_ratio_from_size("portrait", &mut keyword_warnings);
        assert_eq!(portrait.as_deref(), Some("9:16"));
        assert!(keyword_warnings.is_empty());

        assert_eq!(GeminiProvider::resolve_image_size_hint("landscape"), "2K");
        assert_eq!(GeminiProvider::resolve_image_size_hint("1200x800"), "1K");
        assert_eq!(GeminiProvider::resolve_image_size_hint("2048x1024"), "2K");
        assert_eq!(GeminiProvider::resolve_image_size_hint("4096x2048"), "4K");

        let safety = GeminiProvider::default_safety_settings();
        assert_eq!(safety.len(), 4);
        assert!(safety.iter().all(|entry| {
            entry
                .get("threshold")
                .and_then(Value::as_str)
                .map(|value| value == "OFF")
                .unwrap_or(false)
        }));
    }

    #[test]
    fn gemini_build_contents_includes_inputs_and_context_packet() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let init_path = temp.path().join("init.png");
        let ref_path = temp.path().join("ref.jpg");
        fs::write(&init_path, b"init-bytes")?;
        fs::write(&ref_path, b"ref-bytes")?;

        let mut request = provider_request_for_test(temp.path());
        request.model = "gemini-2.5-flash-image-preview".to_string();
        request.prompt = "studio still life".to_string();
        request.inputs.init_image = Some(init_path.to_string_lossy().to_string());
        request.inputs.reference_images = vec![ref_path.to_string_lossy().to_string()];
        request.metadata = map_object_for_test(json!({
            "gemini_context_packet": {
                "subject": "chair",
                "goal": "layout",
            }
        }));

        let provider = GeminiProvider::new();
        let parts = provider.build_contents(&request)?;
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0]["inlineData"]["mimeType"], json!("image/png"));
        assert_eq!(parts[1]["inlineData"]["mimeType"], json!("image/jpeg"));
        let packet_text = parts[2]
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(packet_text.starts_with("BROOD_CONTEXT_PACKET_JSON:\n"));
        assert!(packet_text.contains("\"subject\":\"chair\""));
        assert_eq!(parts[3].get("text"), Some(&json!("studio still life")));
        Ok(())
    }

    #[test]
    fn imagen_normalization_matches_python_contract() {
        let mut warnings = Vec::new();
        let ratio = ImagenProvider::normalize_aspect_ratio("2:3", &mut warnings);
        let size = ImagenProvider::normalize_image_size("4K", "imagen-4.0-ultra", &mut warnings);
        let landscape =
            ImagenProvider::normalize_image_size("landscape", "imagen-4.0-ultra", &mut warnings);
        let count = ImagenProvider::normalize_number_of_images(8, &mut warnings);
        let person = ImagenProvider::normalize_person_generation("all_people", &mut warnings);
        assert_eq!(ratio.as_deref(), Some("3:4"));
        assert_eq!(size.as_deref(), Some("2K"));
        assert_eq!(landscape.as_deref(), Some("2K"));
        assert_eq!(count, 4);
        assert!(person.is_none());
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("aspect_ratio snapped")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("image_size 4K unsupported")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("number_of_images clamped")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("person_generation")));
    }

    #[test]
    fn request_metadata_copies_context_packets() {
        let intent = map_object_for_test(json!({
            "request_metadata": {"foo": "bar"},
            "gemini_context_packet": {"subject": "chair"},
            "model_context_envelope": {"provider": "replicate"},
        }));
        let metadata = request_metadata_from_intent(&intent);
        assert_eq!(metadata.get("foo"), Some(&json!("bar")));
        assert_eq!(
            metadata.get("gemini_context_packet"),
            Some(&json!({"subject": "chair"}))
        );
        assert_eq!(
            metadata.get("model_context_envelope"),
            Some(&json!({"provider": "replicate"}))
        );
    }

    #[test]
    fn image_inputs_from_settings_includes_edit_inputs() {
        let settings = map_object_for_test(json!({
            "init_image": "/tmp/init.png",
            "mask": "/tmp/mask.png",
            "reference_images": ["/tmp/ref-a.png", "/tmp/ref-b.png", ""],
        }));
        let inputs = image_inputs_from_settings(&settings);
        assert_eq!(inputs.init_image.as_deref(), Some("/tmp/init.png"));
        assert_eq!(inputs.mask.as_deref(), Some("/tmp/mask.png"));
        assert_eq!(
            inputs.reference_images,
            vec!["/tmp/ref-a.png".to_string(), "/tmp/ref-b.png".to_string()]
        );
    }

    #[test]
    fn default_registry_includes_replicate_stability_and_fal() {
        let providers = default_provider_registry().names();
        assert!(providers.iter().any(|name| name == "replicate"));
        assert!(providers.iter().any(|name| name == "stability"));
        assert!(providers.iter().any(|name| name == "fal"));
    }

    #[test]
    fn gemini_transport_settings_have_safe_defaults_and_clamps() {
        let temp = tempfile::tempdir().expect("tempdir");
        let run_dir = temp.path().join("run");
        let mut request = provider_request_for_test(&run_dir);
        request.model = "gemini-3-pro-image-preview".to_string();

        assert_eq!(GeminiProvider::request_timeout_seconds(&request), 90.0);
        assert_eq!(GeminiProvider::transport_retry_count(&request), 2);
        assert_eq!(GeminiProvider::retry_backoff_seconds(&request), 1.2);

        request
            .provider_options
            .insert("request_timeout".to_string(), json!("120"));
        request
            .provider_options
            .insert("transport_retries".to_string(), json!(8));
        request
            .provider_options
            .insert("retry_backoff".to_string(), json!("0.05"));

        assert_eq!(GeminiProvider::request_timeout_seconds(&request), 120.0);
        assert_eq!(GeminiProvider::transport_retry_count(&request), 4);
        assert_eq!(GeminiProvider::retry_backoff_seconds(&request), 0.1);
    }

    #[test]
    fn error_chain_text_preserves_nested_contexts() {
        let err = anyhow::anyhow!("socket closed")
            .context("Gemini request failed (https://example.test)")
            .context("native provider generation failed");
        let rendered = error_chain_text(&err, 400);
        assert!(rendered.contains("native provider generation failed"));
        assert!(rendered.contains("Gemini request failed"));
        assert!(rendered.contains("socket closed"));
    }

    fn map_object_for_test(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn provider_request_for_test(run_dir: &Path) -> ProviderGenerateRequest {
        ProviderGenerateRequest {
            run_dir: run_dir.to_path_buf(),
            prompt: "test prompt".to_string(),
            size: "1024x1024".to_string(),
            n: 1,
            seed: Some(7),
            output_format: "png".to_string(),
            background: None,
            inputs: ImageInputs::default(),
            model: "gpt-image-1".to_string(),
            provider_options: Map::new(),
            metadata: Map::new(),
        }
    }
}
