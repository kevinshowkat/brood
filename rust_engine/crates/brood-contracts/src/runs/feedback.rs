use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct FeedbackWriter {
    path: PathBuf,
    run_id: String,
}

impl FeedbackWriter {
    pub fn new(path: impl Into<PathBuf>, run_id: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            run_id: run_id.into(),
        }
    }

    pub fn record(
        &self,
        version_id: &str,
        artifact_id: &str,
        rating: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<Map<String, Value>> {
        let mut payload = Map::new();
        payload.insert("ts".to_string(), Value::String(now_utc_iso()));
        payload.insert("run_id".to_string(), Value::String(self.run_id.clone()));
        payload.insert(
            "version_id".to_string(),
            Value::String(version_id.to_string()),
        );
        payload.insert(
            "artifact_id".to_string(),
            Value::String(artifact_id.to_string()),
        );
        payload.insert("rating".to_string(), Value::String(rating.to_string()));
        payload.insert(
            "reason".to_string(),
            reason
                .map(|value| Value::String(value.to_string()))
                .unwrap_or(Value::Null),
        );

        append_jsonl(&self.path, &payload)?;
        Ok(payload)
    }
}

fn append_jsonl(path: &Path, payload: &Map<String, Value>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    use std::io::Write;
    file.write_all(serde_json::to_string(payload)?.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

fn now_utc_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::FeedbackWriter;

    #[test]
    fn feedback_writer_appends_jsonl_record() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("feedback.jsonl");
        let writer = FeedbackWriter::new(&path, "run-123");

        let payload = writer.record("v1", "a1", "winner", Some("best contrast"))?;
        assert_eq!(payload["run_id"], Value::String("run-123".to_string()));
        assert_eq!(payload["version_id"], Value::String("v1".to_string()));
        assert_eq!(payload["artifact_id"], Value::String("a1".to_string()));
        assert_eq!(payload["rating"], Value::String("winner".to_string()));
        assert_eq!(
            payload["reason"],
            Value::String("best contrast".to_string())
        );

        let raw = std::fs::read_to_string(path)?;
        let line = raw.lines().next().unwrap_or("");
        let parsed: Value = serde_json::from_str(line)?;
        assert_eq!(parsed["run_id"], Value::String("run-123".to_string()));
        assert!(parsed.get("ts").and_then(Value::as_str).is_some());
        Ok(())
    }
}
