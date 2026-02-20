use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use similar::TextDiff;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionEntry {
    pub version_id: String,
    pub parent_version_id: Option<String>,
    pub intent: Map<String, Value>,
    pub settings: Map<String, Value>,
    pub prompt: String,
    pub prompt_diff: Option<Vec<String>>,
    pub settings_diff: Option<Map<String, Value>>,
    pub artifacts: Vec<Map<String, Value>>,
    pub selected_artifact_id: Option<String>,
    pub feedback: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextSummary {
    pub text: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreadManifest {
    pub path: PathBuf,
    pub schema_version: u64,
    pub thread_id: String,
    pub created_at: String,
    pub versions: Vec<VersionEntry>,
    pub context_summary: ContextSummary,
}

impl ThreadManifest {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            schema_version: 1,
            thread_id: Uuid::new_v4().to_string(),
            created_at: now_utc_iso(),
            versions: Vec::new(),
            context_summary: ContextSummary {
                text: String::new(),
                updated_at: None,
            },
        }
    }

    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut manifest = Self::new(path.clone());
        let payload = read_json(&path).unwrap_or(Value::Object(Map::new()));
        let Some(obj) = payload.as_object() else {
            return manifest;
        };

        manifest.schema_version = obj
            .get("schema_version")
            .and_then(Value::as_u64)
            .unwrap_or(manifest.schema_version);
        manifest.thread_id = obj
            .get("thread_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(manifest.thread_id);
        manifest.created_at = obj
            .get("created_at")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(manifest.created_at);

        if let Some(summary) = obj.get("context_summary").and_then(Value::as_object) {
            manifest.context_summary = ContextSummary {
                text: summary
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: summary
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
        }

        if let Some(versions) = obj.get("versions").and_then(Value::as_array) {
            for item in versions {
                if let Ok(parsed) = serde_json::from_value::<VersionEntry>(item.clone()) {
                    manifest.versions.push(parsed);
                }
            }
        }
        manifest
    }

    pub fn add_version(
        &mut self,
        intent: Map<String, Value>,
        settings: Map<String, Value>,
        prompt: String,
        parent_version_id: Option<String>,
    ) -> VersionEntry {
        let prev = self.get_version(parent_version_id.as_deref());
        let prompt_diff = prompt_diff(prev.map(|entry| entry.prompt.as_str()), &prompt);
        let settings_diff = settings_diff(prev.map(|entry| &entry.settings), &settings);
        let version = VersionEntry {
            version_id: self.next_version_id(),
            parent_version_id,
            intent,
            settings,
            prompt,
            prompt_diff,
            settings_diff,
            artifacts: Vec::new(),
            selected_artifact_id: None,
            feedback: Vec::new(),
        };
        self.versions.push(version.clone());
        version
    }

    pub fn add_artifact(&mut self, version_id: &str, artifact: Map<String, Value>) {
        if let Some(version) = self.get_version_mut(Some(version_id)) {
            version.artifacts.push(artifact);
        }
    }

    pub fn select_artifact(&mut self, version_id: &str, artifact_id: &str, reason: Option<&str>) {
        if let Some(version) = self.get_version_mut(Some(version_id)) {
            version.selected_artifact_id = Some(artifact_id.to_string());
            if let Some(reason) = reason {
                let mut feedback = Map::new();
                feedback.insert(
                    "artifact_id".to_string(),
                    Value::String(artifact_id.to_string()),
                );
                feedback.insert("rating".to_string(), Value::String("winner".to_string()));
                feedback.insert("reason".to_string(), Value::String(reason.to_string()));
                version.feedback.push(feedback);
            }
        }
    }

    pub fn record_feedback(&mut self, version_id: &str, payload: Map<String, Value>) {
        if let Some(version) = self.get_version_mut(Some(version_id)) {
            version.feedback.push(payload);
        }
    }

    pub fn update_context_summary(&mut self, text: &str) {
        self.context_summary = ContextSummary {
            text: text.to_string(),
            updated_at: Some(now_utc_iso()),
        };
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let mut payload = Map::new();
        payload.insert(
            "schema_version".to_string(),
            Value::Number(self.schema_version.into()),
        );
        payload.insert(
            "thread_id".to_string(),
            Value::String(self.thread_id.clone()),
        );
        payload.insert(
            "created_at".to_string(),
            Value::String(self.created_at.clone()),
        );
        payload.insert(
            "versions".to_string(),
            Value::Array(
                self.versions
                    .iter()
                    .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        payload.insert(
            "context_summary".to_string(),
            serde_json::to_value(&self.context_summary).unwrap_or(Value::Null),
        );

        write_json(&self.path, Value::Object(payload))
    }

    fn next_version_id(&self) -> String {
        format!("v{}", self.versions.len() + 1)
    }

    fn get_version(&self, version_id: Option<&str>) -> Option<&VersionEntry> {
        let id = version_id?;
        self.versions.iter().find(|entry| entry.version_id == id)
    }

    fn get_version_mut(&mut self, version_id: Option<&str>) -> Option<&mut VersionEntry> {
        let id = version_id?;
        self.versions
            .iter_mut()
            .find(|entry| entry.version_id == id)
    }
}

fn prompt_diff(prev: Option<&str>, curr: &str) -> Option<Vec<String>> {
    let prev = prev?;
    let diff = TextDiff::from_lines(prev, curr);
    let rendered = diff.unified_diff().header("prev", "curr").to_string();
    let lines = rendered
        .lines()
        .map(str::to_string)
        .collect::<Vec<String>>();
    Some(lines)
}

fn settings_diff(
    prev: Option<&Map<String, Value>>,
    curr: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let prev = prev?;
    let mut diff = Map::new();

    let mut keys: BTreeMap<String, ()> = BTreeMap::new();
    for key in prev.keys() {
        keys.insert(key.clone(), ());
    }
    for key in curr.keys() {
        keys.insert(key.clone(), ());
    }

    for key in keys.keys() {
        let left = prev.get(key);
        let right = curr.get(key);
        if left != right {
            let mut row = Map::new();
            row.insert("from".to_string(), left.cloned().unwrap_or(Value::Null));
            row.insert("to".to_string(), right.cloned().unwrap_or(Value::Null));
            diff.insert(key.clone(), Value::Object(row));
        }
    }

    Some(diff)
}

fn now_utc_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

fn read_json(path: &Path) -> anyhow::Result<Value> {
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

fn write_json(path: &Path, payload: Value) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::ThreadManifest;

    #[test]
    fn thread_manifest_versions_roundtrip() -> anyhow::Result<()> {
        let tmp = tempfile::tempdir()?;
        let path = tmp.path().join("thread.json");
        let mut manifest = ThreadManifest::new(&path);

        let mut v1_intent = Map::new();
        v1_intent.insert("action".to_string(), Value::String("generate".to_string()));
        let mut v1_settings = Map::new();
        v1_settings.insert("size".to_string(), Value::String("1024x1024".to_string()));
        let v1 = manifest.add_version(v1_intent, v1_settings, "A".to_string(), None);

        let mut v2_intent = Map::new();
        v2_intent.insert("action".to_string(), Value::String("generate".to_string()));
        let mut v2_settings = Map::new();
        v2_settings.insert("size".to_string(), Value::String("512x512".to_string()));
        let v2 = manifest.add_version(
            v2_intent,
            v2_settings,
            "B".to_string(),
            Some(v1.version_id.clone()),
        );

        let mut artifact = Map::new();
        artifact.insert("artifact_id".to_string(), Value::String("a1".to_string()));
        manifest.add_artifact(&v2.version_id, artifact);
        manifest.save()?;

        let loaded = ThreadManifest::load(&path);
        assert_eq!(loaded.versions.len(), 2);
        assert_eq!(
            loaded.versions[1].parent_version_id.as_deref(),
            Some(v1.version_id.as_str())
        );
        assert!(loaded.versions[1].prompt_diff.is_some());
        assert!(loaded.versions[1].settings_diff.is_some());
        assert_eq!(
            loaded.versions[1].artifacts[0].get("artifact_id"),
            Some(&json!("a1"))
        );
        Ok(())
    }
}
