use crate::scanner::Scan;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Duration,
};

#[derive(Serialize, Default)]
pub struct Mismatches {
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub cache_read_tokens: usize,
    pub cache_write_tokens: usize,
    pub model_id: usize,
}

#[derive(Serialize)]
pub struct Report {
    pub upstream_commit: &'static str,
    pub sessions_scanned: usize,
    pub collected_events: usize,
    pub cc_switch_events: usize,
    pub matched_events: usize,
    pub missing_from_cc_switch: usize,
    pub cc_switch_only_events: usize,
    pub mismatches: Mismatches,
    pub unreadable_sessions: usize,
    pub native_unavailable_sessions: usize,
    pub malformed_lines: usize,
    pub rejected_paths: usize,
    pub accepted: bool,
}

struct Reference {
    model: String,
    tokens: [i64; 4],
}

/// No prompts, paths, raw IDs or token values are included in the report.
pub fn compare(scanned: &Scan, path: &Path) -> rusqlite::Result<Report> {
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(250))?;
    let tx = conn.transaction()?;
    let mut query=tx.prepare("SELECT request_id,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens FROM proxy_request_logs WHERE app_type='agy' AND data_source='agy_session'")?;
    let references: HashMap<String, Reference> = query
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                Reference {
                    model: r.get(1)?,
                    tokens: [r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?],
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut report = Report {
        upstream_commit: agy_usage_core::UPSTREAM_COMMIT,
        sessions_scanned: scanned.discovery.sessions.len(),
        collected_events: scanned.events.len(),
        cc_switch_events: references.len(),
        matched_events: 0,
        missing_from_cc_switch: 0,
        cc_switch_only_events: 0,
        mismatches: Mismatches::default(),
        unreadable_sessions: scanned.unreadable_sessions,
        native_unavailable_sessions: scanned.native_unavailable_sessions,
        malformed_lines: scanned.malformed_lines,
        rejected_paths: scanned.discovery.rejected_paths,
        accepted: false,
    };
    let mut seen = HashSet::new();
    for event in &scanned.events {
        let id = format!("agy:{}:{}", event.session_id, event.step_index);
        seen.insert(id.clone());
        let Some(reference) = references.get(&id) else {
            report.missing_from_cc_switch += 1;
            continue;
        };
        let tokens = event.tokens;
        let mismatches = [
            tokens.input_tokens,
            tokens.output_tokens,
            tokens.cache_read_tokens,
            tokens.cache_write_tokens,
        ]
        .iter()
        .zip(reference.tokens)
        .map(|(a, b)| i64::try_from(*a).ok() != Some(b))
        .collect::<Vec<_>>();
        report.mismatches.input_tokens += usize::from(mismatches[0]);
        report.mismatches.output_tokens += usize::from(mismatches[1]);
        report.mismatches.cache_read_tokens += usize::from(mismatches[2]);
        report.mismatches.cache_write_tokens += usize::from(mismatches[3]);
        let model_mismatch = event.model_id != reference.model;
        report.mismatches.model_id += usize::from(model_mismatch);
        if !mismatches.iter().any(|x| *x) && !model_mismatch {
            report.matched_events += 1;
        }
    }
    report.cc_switch_only_events = references.keys().filter(|id| !seen.contains(*id)).count();
    report.accepted = report.collected_events > 0
        && report.collected_events == report.matched_events
        && report.cc_switch_only_events == 0
        && report.unreadable_sessions == 0
        && report.native_unavailable_sessions == 0
        && report.rejected_paths == 0
        && scanned.discovery.unreadable_roots == 0
        && scanned.invalid_counters == 0
        && scanned.overflowing_events == 0;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agy_usage_core::{discovery::Discovery, Source, Tokens, UsageEvent};
    fn scan() -> Scan {
        Scan {
            discovery: Discovery::default(),
            events: vec![UsageEvent {
                session_id: "s".into(),
                step_index: 1,
                model_id: "model".into(),
                model_display: "model".into(),
                occurred_at_ms: 0,
                tokens: Tokens {
                    input_tokens: 10,
                    output_tokens: 2,
                    cache_read_tokens: 3,
                    cache_write_tokens: 4,
                },
                source: Source::Cli,
            }],
            unreadable_sessions: 0,
            native_unavailable_sessions: 0,
            malformed_lines: 0,
            invalid_counters: 0,
            invalid_timestamps: 0,
            overflowing_events: 0,
        }
    }
    #[test]
    fn detects_a_real_counter_difference_and_does_not_approve_empty_comparisons() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("reference.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE proxy_request_logs(request_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,app_type TEXT,data_source TEXT); INSERT INTO proxy_request_logs VALUES('agy:s:1','model',10,2,3,4,'agy','agy_session');").unwrap();
        let mut scanned = scan();
        assert!(compare(&scanned, &path).unwrap().accepted);
        scanned.events[0].tokens.cache_read_tokens = 33;
        let report = compare(&scanned, &path).unwrap();
        assert!(!report.accepted);
        assert_eq!(report.mismatches.cache_read_tokens, 1);
        scanned.events.clear();
        assert!(!compare(&scanned, &path).unwrap().accepted);
    }
}
