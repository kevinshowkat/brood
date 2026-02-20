use std::path::Path;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub total_versions: u64,
    pub total_artifacts: u64,
    pub winners: Vec<Map<String, Value>>,
}

pub fn write_summary(
    path: &Path,
    summary: &RunSummary,
    extra: Option<&Map<String, Value>>,
) -> anyhow::Result<()> {
    let mut payload = Map::new();
    payload.insert("run_id".to_string(), Value::String(summary.run_id.clone()));
    payload.insert(
        "started_at".to_string(),
        Value::String(summary.started_at.clone()),
    );
    payload.insert(
        "finished_at".to_string(),
        Value::String(summary.finished_at.clone()),
    );
    payload.insert(
        "total_versions".to_string(),
        Value::Number(summary.total_versions.into()),
    );
    payload.insert(
        "total_artifacts".to_string(),
        Value::Number(summary.total_artifacts.into()),
    );
    payload.insert(
        "winners".to_string(),
        Value::Array(summary.winners.iter().cloned().map(Value::Object).collect()),
    );
    payload.insert("ts".to_string(), Value::String(now_utc_iso()));
    if let Some(extra) = extra {
        for (key, value) in extra {
            payload.insert(key.clone(), value.clone());
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&Value::Object(payload))?)?;
    Ok(())
}

fn now_utc_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::{write_summary, RunSummary};

    #[test]
    fn write_summary_generates_expected_payload() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("summary.json");

        let mut winner = Map::new();
        winner.insert("version_id".to_string(), json!("v2"));
        winner.insert("artifact_id".to_string(), json!("a-1"));
        let summary = RunSummary {
            run_id: "run-123".to_string(),
            started_at: "2026-02-19T00:00:00+00:00".to_string(),
            finished_at: "2026-02-19T00:10:00+00:00".to_string(),
            total_versions: 2,
            total_artifacts: 4,
            winners: vec![winner],
        };
        let mut extra = Map::new();
        extra.insert("extra_key".to_string(), Value::String("extra".to_string()));
        write_summary(&path, &summary, Some(&extra))?;

        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        assert_eq!(parsed["run_id"], json!("run-123"));
        assert_eq!(parsed["total_versions"], json!(2));
        assert_eq!(parsed["winners"][0]["artifact_id"], json!("a-1"));
        assert_eq!(parsed["extra_key"], json!("extra"));
        assert!(parsed.get("ts").and_then(Value::as_str).is_some());
        Ok(())
    }
}
