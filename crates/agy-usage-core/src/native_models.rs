// Adapted from CC Switch native_models.rs, MIT, Copyright (c) 2025 Jason Young.
// Immutable source and full license: THIRD_PARTY_NOTICES.md / licenses/CC-Switch-MIT.txt.
use crate::discovery::native_database_path;
use prost::Message;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::BTreeMap, path::Path, time::Duration};

#[derive(Clone, PartialEq, Message)]
struct StepMetadata {
    #[prost(message, optional, tag = "20")]
    generation: Option<GenerationReference>,
}
#[derive(Clone, PartialEq, Message)]
struct GenerationReference {
    #[prost(uint64, tag = "3")]
    index: u64,
}
#[derive(Clone, PartialEq, Message)]
struct GenerationMetadata {
    #[prost(message, optional, tag = "1")]
    response: Option<ResponseMetadata>,
}
#[derive(Clone, PartialEq, Message)]
struct ResponseMetadata {
    #[prost(string, tag = "19")]
    model: String,
}
// Decode separately: an incompatible field 21 must not hide field 19.
#[derive(Clone, PartialEq, Message)]
struct GenerationModelId {
    #[prost(message, optional, tag = "1")]
    response: Option<ResponseModelId>,
}
#[derive(Clone, PartialEq, Message)]
struct ResponseModelId {
    #[prost(string, tag = "21")]
    model_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeError {
    UnsupportedLayout,
    OutsideRoot,
    Unavailable,
}

pub fn models_for_transcript(
    transcript: &Path,
    steps: &[u64],
) -> Result<BTreeMap<u64, String>, NativeError> {
    if steps.is_empty() {
        return Ok(BTreeMap::new());
    }
    let path = native_database_path(transcript).ok_or(NativeError::UnsupportedLayout)?;
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    let root = transcript
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(|p| p.canonicalize().ok())
        .ok_or(NativeError::Unavailable)?;
    let canonical = path.canonicalize().map_err(|_| NativeError::Unavailable)?;
    if !canonical.starts_with(root) {
        return Err(NativeError::OutsideRoot);
    }
    read_models(&canonical, steps).map_err(|_| NativeError::Unavailable)
}

pub fn read_models(path: &Path, steps: &[u64]) -> rusqlite::Result<BTreeMap<u64, String>> {
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::ZERO)?;
    let tx = conn.transaction()?;
    let mut step_query = tx.prepare("SELECT metadata FROM steps WHERE idx=?1 AND step_type=15")?;
    let mut generation_query = tx.prepare("SELECT data FROM gen_metadata WHERE idx=?1")?;
    let mut models = BTreeMap::new();
    for &step in steps {
        let Ok(index) = i64::try_from(step) else {
            continue;
        };
        let metadata: Option<Vec<u8>> = step_query
            .query_row([index], |r| r.get(0))
            .optional()?
            .flatten();
        let Some(reference) = metadata
            .and_then(|b| StepMetadata::decode(b.as_slice()).ok())
            .and_then(|m| m.generation)
        else {
            continue;
        };
        let Ok(generation) = i64::try_from(reference.index) else {
            continue;
        };
        let data: Option<Vec<u8>> = generation_query
            .query_row([generation], |r| r.get(0))
            .optional()?;
        let Some(bytes) = data else {
            continue;
        };
        let tiered = GenerationModelId::decode(bytes.as_slice())
            .ok()
            .and_then(|m| m.response)
            .map(|r| r.model_id);
        let base = GenerationMetadata::decode(bytes.as_slice())
            .ok()
            .and_then(|m| m.response)
            .map(|r| r.model);
        if let Some(model) = [tiered, base]
            .into_iter()
            .flatten()
            .map(|s| s.trim().to_string())
            .find(|s| !s.is_empty() && !s.eq_ignore_ascii_case("unknown"))
        {
            models.insert(step, model);
        }
    }
    Ok(models)
}
