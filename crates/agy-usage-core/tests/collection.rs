use agy_usage_core::{
    discovery::{
        discover, native_database_path, valid_session_id, DiscoveryConfig, Session, SessionRoot,
    },
    model_resolver::{known_model, model_from_settings_change, model_id_of},
    normalizer::{Pseudonymizer, UploadEvent},
    parse_transcript,
    parser::normalize_records,
    records::{records, timestamp_ms},
    Source, Tokens,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Cursor,
    path::Path,
};

fn parse(text: &str) -> agy_usage_core::ParseResult {
    normalize_records(
        "synthetic-session",
        Source::Cli,
        records(Cursor::new(text)).unwrap(),
        &BTreeMap::new(),
    )
}

fn response(step: u64, input: u64) -> Value {
    json!({"step_index":step,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":input,"created_at":1793491200})
}

fn lines(rows: &[Value]) -> String {
    rows.iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

fn write_session(root: &Path, id: &str, text: &str, source: Source) -> Session {
    let path = root
        .join(id)
        .join(".system_generated/logs/transcript_full.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    Session {
        id: id.into(),
        transcript: path,
        source,
    }
}

#[test]
fn fixture_preserves_four_counters_and_never_adds_reasoning() {
    let result = parse(include_str!(
        "../../../fixtures/antigravity/sample_transcript.jsonl"
    ));
    assert_eq!(result.events.len(), 3);
    assert_eq!(result.rewritten_steps, 1);
    let event = &result.events[0];
    assert_eq!(
        event.tokens,
        Tokens {
            input_tokens: 10000,
            output_tokens: 5000,
            cache_read_tokens: 3000,
            cache_write_tokens: 1000
        }
    );
    assert_eq!(event.tokens.total(), Some(19000));
    assert_eq!(event.model_id, "gemini-3.8-flash-high");
    assert_eq!(result.events[1].model_id, "gemini-3.8-pro");
    assert_eq!(result.events[2].model_id, "claude-sonnet-4.5");
}

#[test]
fn partial_last_line_waits_for_a_complete_json_object() {
    let first = response(1, 10).to_string();
    let partial = format!("{first}\n{{\"step_index\":2,\"type\":");
    let result = parse(&partial);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.malformed_lines, 1);
    assert_eq!(
        parse(&format!("{first}\n{}", response(2, 20))).events.len(),
        2
    );
}

#[test]
fn valid_final_line_does_not_require_newline() {
    assert_eq!(parse(&response(0, 1).to_string()).events.len(), 1);
}

#[test]
fn last_rewritten_step_wins_including_status_changes() {
    let mut pending = response(1, 30);
    pending["status"] = json!("RUNNING");
    assert!(parse(&lines(&[response(1, 10), pending])).events.is_empty());
    let result = parse(&lines(&[response(1, 10), response(1, 35), response(2, 4)]));
    assert_eq!(result.events.len(), 2);
    assert_eq!(result.events[0].tokens.input_tokens, 35);
}

#[test]
fn orders_steps_before_inheriting_settings_and_keeps_history_unknown() {
    let settings = json!({"step_index":2,"type":"USER_INPUT","content":"changed setting `Model Selection` from none to Gemini 3.8 Flash (High)."});
    let result = parse(&lines(&[response(3, 30), settings, response(1, 10)]));
    assert_eq!(result.events[0].model_id, "unknown");
    assert_eq!(result.events[1].model_id, "gemini-3.8-flash-high");
}

#[test]
fn rewritten_settings_replace_the_old_model() {
    let setting = |name| json!({"step_index":0,"type":"USER_INPUT","content":format!("changed setting `Model Selection` from none to {name}.")});
    let result = parse(&lines(&[
        setting("Old Model"),
        response(1, 10),
        setting("New Model"),
    ]));
    assert_eq!(result.events[0].model_id, "new-model");
}

#[test]
fn direct_then_historical_then_native_then_unknown() {
    let mut explicit = response(1, 10);
    explicit["model"] = json!("explicit-model");
    let settings = json!({"step_index":2,"type":"USER_INPUT","content":"changed setting `Model Selection` from none to Historical Model."});
    let raw = records(Cursor::new(lines(&[
        response(0, 10),
        explicit,
        settings,
        response(3, 10),
    ])))
    .unwrap();
    let native = BTreeMap::from([
        (0, "native-model".into()),
        (1, "wrong-native".into()),
        (3, "wrong-native".into()),
    ]);
    let result = normalize_records("s", Source::Cli, raw, &native);
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.model_id.as_str())
            .collect::<Vec<_>>(),
        ["native-model", "explicit-model", "historical-model"]
    );
    assert_eq!(
        parse(&response(0, 10).to_string()).events[0].model_id,
        "unknown"
    );
}

#[test]
fn ignores_non_completed_and_zero_usage_records() {
    let mut tool = response(0, 999);
    tool["type"] = json!("TOOL_RESPONSE");
    let mut running = response(1, 999);
    running["status"] = json!("RUNNING");
    assert!(parse(&lines(&[tool, running, response(2, 0)]))
        .events
        .is_empty());
}

#[test]
fn invalid_counters_follow_upstream_zero_fallback_without_wrapping() {
    let mut row = response(0, 1);
    row["input_tokens"] = json!(-7);
    row["output_tokens"] = json!("100");
    row["cache_read_tokens"] = json!(u64::MAX);
    row["cache_write_tokens"] = json!(5);
    let result = parse(&row.to_string());
    assert_eq!(result.invalid_counters, 3);
    assert_eq!(result.events[0].tokens.total(), Some(5));
}

#[test]
fn rejects_event_totals_outside_d1_integer_range() {
    let mut row = response(0, i64::MAX as u64);
    row["output_tokens"] = json!(1);
    let result = parse(&row.to_string());
    assert!(result.events.is_empty());
    assert_eq!(result.overflowing_events, 1);
}

#[test]
fn counts_corrupt_lines_without_retaining_contents() {
    let raw = b"not-json\n\xff\n{}\n";
    let result = records(Cursor::new(raw)).unwrap();
    assert_eq!(result.malformed_lines, 2);
    assert!(result.steps.is_empty());
}

#[test]
fn timestamp_formats_match_upstream_and_reject_overflow() {
    assert_eq!(timestamp_ms(&json!(1793491200)), Some(1793491200000));
    assert_eq!(timestamp_ms(&json!(1793491200001i64)), Some(1793491200001));
    assert_eq!(timestamp_ms(&json!(1793491200.9)), Some(1793491200000));
    assert_eq!(
        timestamp_ms(&json!("2026-11-01T08:00:00+08:00")),
        Some(1793491200000)
    );
    assert_eq!(timestamp_ms(&json!("broken")), None);
    assert_eq!(timestamp_ms(&json!(i64::MIN)), None);
}

#[test]
fn model_normalization_keeps_upstream_id_and_display_semantics() {
    for (display, id) in [
        ("Gemini 3.8 Flash (High)", "gemini-3.8-flash-high"),
        ("Claude Sonnet 4.5", "claude-sonnet-4.5"),
        ("already-an-ID", "already-an-ID"),
        ("unknown", "unknown"),
    ] {
        assert_eq!(model_id_of(display), id);
    }
    assert_eq!(known_model(Some("UNKNOWN")), None);
    assert_eq!(known_model(Some("  ")), None);
    assert_eq!(known_model(None), None);
}

#[test]
fn settings_change_handles_decimal_newlines_ticks_and_none() {
    for (text, expected) in [
        (
            "changed setting `Model Selection` from X to Gemini 3.8 Flash (High). More text",
            Some("Gemini 3.8 Flash (High)"),
        ),
        (
            "Model Selection from X to Claude Sonnet 4.5\ncontext",
            Some("Claude Sonnet 4.5"),
        ),
        ("Model Selection from X to Gemini 3.8`", Some("Gemini 3.8")),
        ("Model Selection from X to none.", None),
        ("No selection change", None),
    ] {
        assert_eq!(model_from_settings_change(text).as_deref(), expected);
    }
}

#[test]
fn missing_directories_are_normal() {
    let temp = tempfile::tempdir().unwrap();
    let config = DiscoveryConfig {
        home: temp.path().into(),
        cc_switch_dir: None,
        extra_roots: vec![],
    };
    let result = discover(&config.roots());
    assert!(result.sessions.is_empty());
    assert_eq!(result.unreadable_roots, 0);
}

#[test]
fn discovers_cli_ide_private_and_configured_roots() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let roots = [
        home.join(".gemini/antigravity-cli/brain"),
        home.join(".gemini/antigravity/brain"),
        home.join("custom-cc/agy/profile-a/antigravity-cli/brain"),
        home.join("custom-extra/brain"),
    ];
    for (i, root) in roots.iter().enumerate() {
        write_session(root, &format!("session-{i}"), "", Source::Cli);
    }
    let config = DiscoveryConfig {
        home: home.into(),
        cc_switch_dir: Some(home.join("custom-cc")),
        extra_roots: vec![SessionRoot {
            path: roots[3].clone(),
            source: Source::Ide,
        }],
    };
    let result = discover(&config.roots());
    assert_eq!(result.sessions.len(), 4);
    assert_eq!(
        result
            .sessions
            .iter()
            .filter(|s| s.source == Source::Ide)
            .count(),
        2
    );
}

#[test]
fn cli_and_ide_duplicate_sessions_use_first_transcript_once() {
    let temp = tempfile::tempdir().unwrap();
    let cli = temp.path().join("cli/brain");
    let ide = temp.path().join("ide/brain");
    let first = write_session(
        &cli,
        "same-session",
        &response(0, 10).to_string(),
        Source::Cli,
    );
    write_session(
        &ide,
        "same-session",
        &response(0, 999).to_string(),
        Source::Ide,
    );
    let roots = [
        SessionRoot {
            path: cli.clone(),
            source: Source::Cli,
        },
        SessionRoot {
            path: cli,
            source: Source::Cli,
        },
        SessionRoot {
            path: ide,
            source: Source::Ide,
        },
    ];
    let result = discover(&roots);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.duplicate_sessions, 1);
    assert_eq!(
        result.sessions[0].transcript,
        first.transcript.canonicalize().unwrap()
    );
    assert_eq!(
        parse_transcript(&result.sessions[0]).unwrap().events[0]
            .tokens
            .input_tokens,
        10
    );
}

#[test]
fn empty_index_directory_yields_to_a_later_transcript() {
    let temp = tempfile::tempdir().unwrap();
    let cli = temp.path().join("cli/brain");
    let ide = temp.path().join("ide/brain");
    fs::create_dir_all(cli.join("same-session")).unwrap();
    write_session(&ide, "same-session", "", Source::Ide);
    let result = discover(&[
        SessionRoot {
            path: cli,
            source: Source::Cli,
        },
        SessionRoot {
            path: ide,
            source: Source::Ide,
        },
    ]);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].source, Source::Ide);
}

#[test]
fn session_ids_cannot_escape_roots() {
    for id in ["", ".", "..", "../other", "a\\b", "a/b", "a_b"] {
        assert!(!valid_session_id(id));
    }
    assert!(valid_session_id("a0-ABC-123"));
}

#[test]
fn truncation_and_rewrite_are_fully_reparsed() {
    let temp = tempfile::tempdir().unwrap();
    let session = write_session(
        &temp.path().join("brain"),
        "session-a",
        &lines(&[response(0, 10), response(1, 20)]),
        Source::Ide,
    );
    assert_eq!(parse_transcript(&session).unwrap().events.len(), 2);
    fs::write(&session.transcript, response(0, 7).to_string()).unwrap();
    let next = parse_transcript(&session).unwrap();
    assert_eq!(next.events.len(), 1);
    assert_eq!(next.events[0].tokens.input_tokens, 7);
}

#[test]
fn native_database_uses_matching_cli_or_ide_root() {
    let path =
        Path::new("base/antigravity/brain/session-a/.system_generated/logs/transcript_full.jsonl");
    assert_eq!(
        native_database_path(path).unwrap(),
        Path::new("base/antigravity/conversations/session-a.db")
    );
    assert!(native_database_path(Path::new("wrong/session-a/transcript_full.jsonl")).is_none());
}

#[test]
fn serialization_is_exact_allowlist_and_drops_all_source_payload() {
    let mut row = response(3, 10);
    row["content"] = json!("SECRET_RESPONSE_CANARY");
    row["prompt"] = json!("SECRET_PROMPT_CANARY");
    row["oauth_token"] = json!("SECRET_TOKEN_CANARY");
    row["cwd"] = json!("C:\\private\\workspace");
    let parsed = parse(&row.to_string());
    let anonymous = Pseudonymizer::new(&[42; 32])
        .unwrap()
        .sanitize(&parsed.events[0]);
    let value = serde_json::to_value(&anonymous).unwrap();
    let keys: BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "event_id",
            "session_key",
            "step_index",
            "model_display",
            "model_id",
            "occurred_at_ms",
            "tokens",
            "source"
        ])
    );
    let text = value.to_string();
    assert_eq!(value["source"], "antigravity_cli");
    assert_eq!(
        value["tokens"],
        json!({"input":10,"output":0,"cache_read":0,"cache_write":0})
    );
    for forbidden in [
        "SECRET_",
        "synthetic-session",
        "private",
        "prompt",
        "oauth",
        "content",
        "PLANNER_RESPONSE",
    ] {
        assert!(!text.contains(forbidden), "privacy regression");
    }
    assert_eq!(anonymous.event_id.len(), 64);
    assert_eq!(anonymous.session_key.len(), 64);
    let mut injected = value;
    injected["prompt"] = json!("x");
    assert!(serde_json::from_value::<UploadEvent>(injected).is_err());
}

#[test]
fn hmac_is_stable_for_corrections_and_separates_devices_steps_and_sessions() {
    let mut event = parse(&response(0, 10).to_string()).events.remove(0);
    let key = Pseudonymizer::new(&[1; 32]).unwrap();
    let first = key.sanitize(&event);
    event.tokens.input_tokens = 20;
    assert_eq!(first.event_id, key.sanitize(&event).event_id);
    event.step_index = 1;
    let next = key.sanitize(&event);
    assert_ne!(first.event_id, next.event_id);
    assert_eq!(first.session_key, next.session_key);
    assert_ne!(
        next.event_id,
        Pseudonymizer::new(&[2; 32])
            .unwrap()
            .sanitize(&event)
            .event_id
    );
    event.session_id = "another".into();
    assert_ne!(next.session_key, key.sanitize(&event).session_key);
    assert!(Pseudonymizer::new(&[0; 31]).is_err());
}
