use agy_usage_core::{
    discovery::Session,
    native_models::{models_for_transcript, read_models},
    parse_transcript, Source,
};
use rusqlite::{params, Connection};
use std::{fs, path::Path};

fn database(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);").unwrap();
    conn
}

// Literal protobuf wire tags from the audited schema; no parser types are reused.
fn generation(base: &str, tiered: Option<&str>) -> Vec<u8> {
    let mut response = vec![0x9a, 0x01, base.len() as u8];
    response.extend(base.as_bytes());
    if let Some(id) = tiered {
        response.extend([0xaa, 0x01, id.len() as u8]);
        response.extend(id.as_bytes());
    }
    let mut outer = vec![0x0a, response.len() as u8];
    outer.extend(response);
    outer
}

fn insert(conn: &Connection, step: i64, generation_idx: u8, model: &str, tiered: Option<&str>) {
    let reference = if generation_idx == 0 {
        vec![0xa2, 0x01, 0]
    } else {
        vec![0xa2, 0x01, 2, 0x18, generation_idx]
    };
    conn.execute(
        "INSERT INTO steps VALUES(?1,15,?2)",
        params![step, reference],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO gen_metadata VALUES(?1,?2)",
        params![generation_idx, generation(model, tiered)],
    )
    .unwrap();
}

#[test]
fn step_reference_including_zero_wins_over_generation_order() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("s.db");
    let conn = database(&path);
    insert(&conn, 1, 0, "gemini-base", None);
    insert(&conn, 3, 7, "gemini-tiered", None);
    insert(&conn, 8, 2, "claude-base", None);
    let models = read_models(&path, &[8, 1, 3, 99]).unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[&1], "gemini-base");
    assert_eq!(models[&3], "gemini-tiered");
    assert_eq!(models[&8], "claude-base");
}

#[test]
fn tiered_model_id_precedes_base_display_name() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("s.db");
    let conn = database(&path);
    insert(&conn, 1, 0, "Gemini Base", Some("gemini-high"));
    assert_eq!(read_models(&path, &[1]).unwrap()[&1], "gemini-high");
}

#[test]
fn malformed_tier_does_not_hide_base_model() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("s.db");
    let conn = database(&path);
    insert(&conn, 1, 0, "gemini-base", None);
    let mut data = generation("gemini-base", None);
    // Field 21 with wrong wire type. Only its independent decoder should fail.
    data.extend([0x0a, 3, 0xa8, 0x01, 1]);
    conn.execute("UPDATE gen_metadata SET data=?1", [data])
        .unwrap();
    assert_eq!(read_models(&path, &[1]).unwrap()[&1], "gemini-base");
}

#[test]
fn blank_unknown_and_malformed_metadata_stay_unknown() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("s.db");
    let conn = database(&path);
    insert(&conn, 1, 0, "unknown", Some("  "));
    conn.execute_batch("INSERT INTO steps VALUES(2,15,X'80');INSERT INTO steps VALUES(3,15,NULL);INSERT INTO steps VALUES(4,15,X'');INSERT INTO steps VALUES(5,99,X'A20100');").unwrap();
    assert!(read_models(&path, &[1, 2, 3, 4, 5]).unwrap().is_empty());
    conn.execute("UPDATE gen_metadata SET data=X'80'", [])
        .unwrap();
    assert!(read_models(&path, &[1]).unwrap().is_empty());
}

#[test]
fn normal_read_only_connection_sees_live_wal() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("s.db");
    let conn = database(&path);
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    insert(&conn, 1, 0, "wal-model", None);
    assert_eq!(read_models(&path, &[1]).unwrap()[&1], "wal-model");
}

#[test]
fn missing_or_unrecognized_database_is_never_created_or_guessed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("absent.db");
    assert!(read_models(&path, &[1]).is_err());
    assert!(!path.exists());
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE unrelated(secret TEXT)")
        .unwrap();
    assert!(read_models(&path, &[1]).is_err());
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('steps','gen_metadata')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn end_to_end_subagent_model_recovery_uses_matching_database() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("antigravity");
    let transcript = root.join("brain/session-a/.system_generated/logs/transcript_full.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    fs::create_dir_all(root.join("conversations")).unwrap();
    fs::write(
        &transcript,
        r#"{"step_index":8,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":42}"#,
    )
    .unwrap();
    let conn = database(&root.join("conversations/session-a.db"));
    insert(&conn, 8, 2, "Claude Sonnet 4.5", None);
    let session = Session {
        id: "session-a".into(),
        transcript,
        source: Source::Ide,
    };
    let result = parse_transcript(&session).unwrap();
    assert_eq!(result.events[0].model_display, "Claude Sonnet 4.5");
    assert_eq!(result.events[0].model_id, "claude-sonnet-4.5");
    assert_eq!(result.events[0].tokens.input_tokens, 42);
    assert!(!result.native_unavailable);
    drop(conn);
}

#[test]
fn missing_native_file_is_normal_for_sessions_with_no_native_export() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp
        .path()
        .join("antigravity/brain/session-a/.system_generated/logs/transcript_full.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "").unwrap();
    assert!(models_for_transcript(&path, &[1]).unwrap().is_empty());
}
