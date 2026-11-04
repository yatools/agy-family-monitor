use crate::queue::Queue;
use agy_usage_core::{
    discovery::{discover, DiscoveryConfig},
    normalizer::Pseudonymizer,
    parse_transcript,
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::SystemTime,
};
#[derive(Default, Clone, serde::Serialize)]
pub struct Health {
    pub last_scan_at_ms: i64,
    pub sessions: usize,
    pub read_errors: usize,
    pub native_errors: usize,
    pub malformed_lines: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_interval_seconds: Option<u64>,
}

#[derive(Default)]
pub struct Tracker {
    files: HashMap<PathBuf, (u64, Option<SystemTime>)>,
    unknown: HashSet<PathBuf>,
    diagnostics: HashMap<PathBuf, (usize, usize)>,
    pub health: Health,
}

impl Tracker {
    pub fn collect(
        &mut self,
        config: &DiscoveryConfig,
        queue: &mut Queue,
        pseudonyms: &Pseudonymizer,
        now: i64,
    ) -> Result<usize, &'static str> {
        let discovery = discover(&config.roots());
        self.health = Health {
            last_scan_at_ms: now,
            sessions: discovery.sessions.len(),
            read_errors: discovery.rejected_paths,
            ..Health::default()
        };
        let active: HashSet<_> = discovery
            .sessions
            .iter()
            .map(|s| s.transcript.clone())
            .collect();
        self.diagnostics.retain(|p, _| active.contains(p));
        let mut changed = 0;
        for session in discovery.sessions {
            let Ok(meta) = std::fs::metadata(&session.transcript) else {
                self.health.read_errors += 1;
                continue;
            };
            let fingerprint = (meta.len(), meta.modified().ok());
            if self.files.get(&session.transcript) == Some(&fingerprint)
                && !self.unknown.contains(&session.transcript)
            {
                continue;
            }
            let Ok(parsed) = parse_transcript(&session) else {
                self.health.read_errors += 1;
                continue;
            };
            self.diagnostics.insert(
                session.transcript.clone(),
                (
                    usize::from(parsed.native_unavailable),
                    parsed.malformed_lines,
                ),
            );
            if parsed.native_unavailable || parsed.events.iter().any(|e| e.model_id == "unknown") {
                self.unknown.insert(session.transcript.clone());
            } else {
                self.unknown.remove(&session.transcript);
            }
            let sanitized: Vec<_> = parsed
                .events
                .iter()
                .map(|e| pseudonyms.sanitize(e))
                .collect();
            let key = sanitized.first().map(|e| e.session_key.clone());
            changed += queue.stage(sanitized, now)?;
            if let Some(key) = key {
                queue.scanned(
                    &key,
                    meta.len(),
                    &format!("{:?}", meta.modified().ok()),
                    now,
                )?;
            }
            self.files.insert(session.transcript, fingerprint);
        }
        self.health.native_errors = self.diagnostics.values().map(|d| d.0).sum();
        self.health.malformed_lines = self.diagnostics.values().map(|d| d.1).sum();
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agy_usage_core::{discovery::SessionRoot, Source};
    #[test]
    fn repeated_collection_restart_and_rewrite_keep_one_anonymous_event() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("brain");
        let transcript =
            root.join("private-session-canary/.system_generated/logs/transcript_full.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let row = |n| {
            format!(
                r#"{{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","model":"known","input_tokens":{n},"created_at":1793491200}}"#
            )
        };
        std::fs::write(&transcript, row(10)).unwrap();
        let config = DiscoveryConfig {
            home: temp.path().join("empty"),
            cc_switch_dir: None,
            extra_roots: vec![SessionRoot {
                path: root,
                source: Source::Ide,
            }],
        };
        let path = temp.path().join("queue.db");
        let mut queue = Queue::open(&path).unwrap();
        let key = Pseudonymizer::new(&[1; 32]).unwrap();
        let mut tracker = Tracker::default();
        assert_eq!(tracker.collect(&config, &mut queue, &key, 0).unwrap(), 1);
        assert_eq!(tracker.collect(&config, &mut queue, &key, 1).unwrap(), 0);
        let batch = queue.pending(1).unwrap();
        queue.confirm(&batch).unwrap();
        drop(queue);
        let mut queue = Queue::open(&path).unwrap();
        let mut tracker = Tracker::default();
        assert_eq!(tracker.collect(&config, &mut queue, &key, 2).unwrap(), 0);
        std::fs::write(&transcript, row(100)).unwrap();
        assert_eq!(tracker.collect(&config, &mut queue, &key, 3).unwrap(), 1);
        let pending = queue.pending(3).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].event.tokens.input, 100);
        assert_eq!(batch[0].event.event_id, pending[0].event.event_id);
        assert!(!serde_json::to_string(&pending[0].event)
            .unwrap()
            .contains("private-session-canary"));
    }
}
