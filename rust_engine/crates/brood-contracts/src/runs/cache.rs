use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct CacheStore {
    path: PathBuf,
    payload: Option<Map<String, Value>>,
    dirty: bool,
    dirty_keys: Vec<String>,
}

impl CacheStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            payload: None,
            dirty: false,
            dirty_keys: Vec::new(),
        }
    }

    pub fn get(&mut self, key: &str) -> Option<Map<String, Value>> {
        let payload = self.ensure_loaded(true);
        payload
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .map(|value| value.clone())
    }

    pub fn set(&mut self, key: &str, value: Map<String, Value>) -> anyhow::Result<()> {
        let payload = self.ensure_loaded(true);
        let snapshot = Value::Object(value.clone());
        if payload.get(key) == Some(&snapshot) {
            return Ok(());
        }
        payload.insert(key.to_string(), snapshot);
        self.dirty = true;
        if !self.dirty_keys.contains(&key.to_string()) {
            self.dirty_keys.push(key.to_string());
        }
        self.flush()
    }

    pub fn flush(&mut self) -> anyhow::Result<()> {
        if self.payload.is_none() || !self.dirty || self.dirty_keys.is_empty() {
            return Ok(());
        }

        let mut on_disk = read_json_object(&self.path).unwrap_or_default();
        if let Some(payload) = &self.payload {
            for key in &self.dirty_keys {
                if let Some(value) = payload.get(key) {
                    on_disk.insert(key.clone(), value.clone());
                }
            }
        }
        write_json_object(&self.path, &on_disk)?;
        self.payload = Some(on_disk);
        self.dirty = false;
        self.dirty_keys.clear();
        Ok(())
    }

    fn ensure_loaded(&mut self, refresh: bool) -> &mut Map<String, Value> {
        if refresh || self.payload.is_none() {
            self.payload = Some(read_json_object(&self.path).unwrap_or_default());
        }
        self.payload.as_mut().expect("cache payload initialized")
    }
}

fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.as_object().cloned()
}

fn write_json_object(path: &Path, payload: &Map<String, Value>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(&Value::Object(payload.clone()))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::CacheStore;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn cache_store_basic() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache = CacheStore::new(path);
        cache.set("key", obj(json!({"value": 1})))?;
        assert_eq!(cache.get("key"), Some(obj(json!({"value": 1}))));
        Ok(())
    }

    #[test]
    fn cache_get_returns_deep_copy() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache = CacheStore::new(path);
        cache.set("key", obj(json!({"items": [{"value": 1}]})))?;

        let mut fetched = cache.get("key").unwrap_or_default();
        fetched
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .and_then(|rows| rows.first_mut())
            .and_then(Value::as_object_mut)
            .map(|row| row.insert("value".to_string(), json!(99)));

        assert_eq!(
            cache.get("key"),
            Some(obj(json!({"items": [{"value": 1}]})))
        );
        Ok(())
    }

    #[test]
    fn cache_set_persists_mutated_reused_object() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache = CacheStore::new(&path);
        cache.set("key", obj(json!({"value": 1})))?;

        let mut payload = cache.get("key").unwrap_or_default();
        payload.insert("value".to_string(), json!(2));
        cache.set("key", payload)?;

        let mut reloaded = CacheStore::new(path);
        assert_eq!(reloaded.get("key"), Some(obj(json!({"value": 2}))));
        Ok(())
    }

    #[test]
    fn cache_set_merges_with_concurrent_writer() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache_a = CacheStore::new(&path);
        let mut cache_b = CacheStore::new(&path);

        cache_a.set("a", obj(json!({"value": 1})))?;
        cache_b.set("b", obj(json!({"value": 2})))?;
        cache_a.set("c", obj(json!({"value": 3})))?;

        let mut reloaded = CacheStore::new(path);
        assert_eq!(reloaded.get("a"), Some(obj(json!({"value": 1}))));
        assert_eq!(reloaded.get("b"), Some(obj(json!({"value": 2}))));
        assert_eq!(reloaded.get("c"), Some(obj(json!({"value": 3}))));
        Ok(())
    }

    #[test]
    fn cache_get_refreshes_between_instances() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache_a = CacheStore::new(&path);
        let mut cache_b = CacheStore::new(&path);

        cache_a.set("key", obj(json!({"value": 1})))?;
        assert_eq!(cache_b.get("key"), Some(obj(json!({"value": 1}))));

        cache_b.set("key", obj(json!({"value": 2})))?;
        assert_eq!(cache_a.get("key"), Some(obj(json!({"value": 2}))));
        Ok(())
    }

    #[test]
    fn cache_set_does_not_noop_on_stale_local_snapshot() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("cache.json");
        let mut cache_a = CacheStore::new(&path);
        let mut cache_b = CacheStore::new(&path);

        cache_a.set("key", obj(json!({"value": 1})))?;
        cache_b.set("key", obj(json!({"value": 2})))?;
        cache_a.set("key", obj(json!({"value": 1})))?;

        let mut reloaded = CacheStore::new(path);
        assert_eq!(reloaded.get("key"), Some(obj(json!({"value": 1}))));
        Ok(())
    }
}
