// Step ordering, token and timestamp semantics adapted from CC Switch (MIT).
// Copyright (c) 2025 Jason Young. See THIRD_PARTY_NOTICES.md.
use crate::{model_resolver::model_from_settings_change, Tokens};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{self, BufRead},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind {
    UserInput,
    PlannerResponse,
    Other,
}

/// Retains metadata only. Source text is discarded before inserting into the map.
#[derive(Debug, Clone)]
pub struct Record {
    pub step_index: u64,
    pub kind: RecordKind,
    pub done: bool,
    pub model: Option<String>,
    pub settings_model: Option<String>,
    pub tokens: Tokens,
    pub occurred_at_ms: Option<i64>,
}

#[derive(Debug, Default)]
pub struct Records {
    pub steps: BTreeMap<u64, Record>,
    pub malformed_lines: usize,
    pub rewritten_steps: usize,
    pub invalid_counters: usize,
}

pub fn timestamp_ms(value: &Value) -> Option<i64> {
    let integer = value
        .as_i64()
        .or_else(|| value.as_f64().filter(|n| n.is_finite()).map(|n| n as i64));
    if let Some(n) = integer {
        return if n > 1_000_000_000_000 {
            Some(n)
        } else {
            n.checked_mul(1000)
        };
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

pub fn records(mut reader: impl BufRead) -> io::Result<Records> {
    let mut result = Records::default();
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            result.malformed_lines += 1;
            continue;
        };
        let Some(step_index) = row["step_index"].as_u64() else {
            continue;
        };
        let mut counter = |name: &str| {
            let parsed = row[name].as_u64().filter(|n| *n <= i64::MAX as u64);
            if !row[name].is_null() && parsed.is_none() {
                result.invalid_counters += 1;
            }
            parsed.unwrap_or(0)
        };
        let tokens = Tokens {
            input_tokens: counter("input_tokens"),
            output_tokens: counter("output_tokens"),
            cache_read_tokens: counter("cache_read_tokens"),
            cache_write_tokens: counter("cache_write_tokens"),
        };
        let kind = match row["type"].as_str() {
            Some("USER_INPUT") => RecordKind::UserInput,
            Some("PLANNER_RESPONSE") => RecordKind::PlannerResponse,
            _ => RecordKind::Other,
        };
        let settings_model = if kind == RecordKind::UserInput {
            row["content"].as_str().and_then(model_from_settings_change)
        } else {
            None
        };
        let record = Record {
            step_index,
            kind,
            done: row["status"] == "DONE",
            model: row["model"].as_str().map(str::to_string),
            settings_model,
            tokens,
            occurred_at_ms: timestamp_ms(&row["created_at"]),
        };
        if result.steps.insert(step_index, record).is_some() {
            result.rewritten_steps += 1;
        }
    }
    Ok(result)
}
