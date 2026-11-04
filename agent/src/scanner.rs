use agy_usage_core::{
    discovery::{discover, Discovery, DiscoveryConfig},
    parse_transcript, Tokens, UsageEvent,
};
use serde::Serialize;
use std::collections::BTreeMap;

pub struct Scan {
    pub discovery: Discovery,
    pub events: Vec<UsageEvent>,
    pub unreadable_sessions: usize,
    pub native_unavailable_sessions: usize,
    pub malformed_lines: usize,
    pub invalid_counters: usize,
    pub invalid_timestamps: usize,
    pub overflowing_events: usize,
}

pub fn scan(config: &DiscoveryConfig) -> Scan {
    let discovery = discover(&config.roots());
    let mut result = Scan {
        discovery,
        events: vec![],
        unreadable_sessions: 0,
        native_unavailable_sessions: 0,
        malformed_lines: 0,
        invalid_counters: 0,
        invalid_timestamps: 0,
        overflowing_events: 0,
    };
    for session in &result.discovery.sessions {
        match parse_transcript(session) {
            Ok(parsed) => {
                result.native_unavailable_sessions += usize::from(parsed.native_unavailable);
                result.malformed_lines += parsed.malformed_lines;
                result.invalid_counters += parsed.invalid_counters;
                result.invalid_timestamps += parsed.invalid_timestamps;
                result.overflowing_events += parsed.overflowing_events;
                result.events.extend(parsed.events);
            }
            Err(_) => result.unreadable_sessions += 1,
        }
    }
    result
}

#[derive(Serialize)]
pub struct Summary {
    pub sessions: usize,
    pub events: usize,
    pub tokens: Tokens,
    pub total_tokens: u64,
    pub unknown_model_events: usize,
    pub model_tokens: BTreeMap<String, Tokens>,
    pub unpriced_tokens: u64,
    pub pricing_status: &'static str,
    pub cost_micro_usd: Option<u64>,
    pub unreadable_sessions: usize,
    pub native_unavailable_sessions: usize,
    pub malformed_lines: usize,
    pub invalid_counters: usize,
    pub invalid_timestamps: usize,
    pub overflowing_events: usize,
}

impl Scan {
    pub fn summary(&self) -> Result<Summary, &'static str> {
        let mut tokens = Tokens::default();
        let mut model_tokens = BTreeMap::<String, Tokens>::new();
        for event in &self.events {
            tokens = tokens.checked_add(event.tokens).ok_or("汇总 Token 溢出")?;
            let model = model_tokens.entry(event.model_id.clone()).or_default();
            *model = model.checked_add(event.tokens).ok_or("模型 Token 溢出")?;
        }
        let total_tokens = tokens.total().ok_or("总 Token 溢出")?;
        Ok(Summary {
            sessions: self.discovery.sessions.len(),
            events: self.events.len(),
            tokens,
            total_tokens,
            unknown_model_events: self
                .events
                .iter()
                .filter(|e| e.model_id == "unknown")
                .count(),
            model_tokens,
            unpriced_tokens: total_tokens,
            pricing_status: "unpriced",
            cost_micro_usd: None,
            unreadable_sessions: self.unreadable_sessions,
            native_unavailable_sessions: self.native_unavailable_sessions,
            malformed_lines: self.malformed_lines,
            invalid_counters: self.invalid_counters,
            invalid_timestamps: self.invalid_timestamps,
            overflowing_events: self.overflowing_events,
        })
    }
}
