// Four-counter and historical model semantics adapted from CC Switch (MIT).
// Copyright (c) 2025 Jason Young. See THIRD_PARTY_NOTICES.md.
use crate::{
    discovery::Session,
    model_resolver::{known_model, model_id_of},
    native_models,
    records::{self, RecordKind, Records},
    Source, UsageEvent,
};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufReader},
};

#[derive(Debug, Default)]
pub struct ParseResult {
    pub events: Vec<UsageEvent>,
    pub malformed_lines: usize,
    pub rewritten_steps: usize,
    pub invalid_counters: usize,
    pub invalid_timestamps: usize,
    pub overflowing_events: usize,
    pub native_unavailable: bool,
}

fn inherited_models(records: &Records) -> BTreeMap<u64, String> {
    let mut result = BTreeMap::new();
    let mut current = None;
    for row in records.steps.values() {
        if row.kind == RecordKind::UserInput {
            if let Some(model) = &row.settings_model {
                current = Some(model.clone());
            }
        } else if row.kind == RecordKind::PlannerResponse {
            if let Some(model) = &current {
                result.insert(row.step_index, model.clone());
            }
        }
    }
    result
}

pub fn normalize_records(
    session_id: &str,
    source: Source,
    records: Records,
    native: &BTreeMap<u64, String>,
) -> ParseResult {
    let inherited = inherited_models(&records);
    let mut result = ParseResult {
        malformed_lines: records.malformed_lines,
        rewritten_steps: records.rewritten_steps,
        invalid_counters: records.invalid_counters,
        ..ParseResult::default()
    };
    for row in records.steps.values() {
        if row.kind != RecordKind::PlannerResponse || !row.done {
            continue;
        }
        match row.tokens.total() {
            Some(0) => continue,
            None => {
                result.overflowing_events += 1;
                continue;
            }
            _ => {}
        }
        let display = known_model(row.model.as_deref())
            .map(str::to_string)
            .or_else(|| inherited.get(&row.step_index).cloned())
            .or_else(|| native.get(&row.step_index).cloned())
            .unwrap_or_else(|| "unknown".to_string());
        if row.occurred_at_ms.is_none() {
            result.invalid_timestamps += 1;
        }
        result.events.push(UsageEvent {
            session_id: session_id.to_string(),
            step_index: row.step_index,
            model_id: model_id_of(&display),
            model_display: display,
            occurred_at_ms: row.occurred_at_ms.unwrap_or(0),
            tokens: row.tokens,
            source,
        });
    }
    result
}

pub fn parse_transcript(session: &Session) -> io::Result<ParseResult> {
    let records = records::records(BufReader::new(File::open(&session.transcript)?))?;
    let inherited = inherited_models(&records);
    let wanted: Vec<_> = records
        .steps
        .values()
        .filter(|r| {
            r.kind == RecordKind::PlannerResponse
                && r.done
                && known_model(r.model.as_deref()).is_none()
                && !inherited.contains_key(&r.step_index)
        })
        .map(|r| r.step_index)
        .collect();
    let native = native_models::models_for_transcript(&session.transcript, &wanted);
    let native_unavailable = native.is_err();
    let mut result = normalize_records(
        &session.id,
        session.source,
        records,
        &native.unwrap_or_default(),
    );
    result.native_unavailable = native_unavailable;
    Ok(result)
}
