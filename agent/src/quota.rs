// Read-only /usage schema adapted from CC Switch (MIT), Copyright (c) 2025 Jason Young.
// No Google credentials are read by this program. The official CLI uses its own sign-in.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub struct Sample {
    pub bucket_id: String,
    pub remaining_ppm: u32,
    pub reset_at_ms: i64,
    pub observed_at_ms: i64,
}
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    NotInstalled,
    Error,
    Disabled,
}
#[derive(Clone)]
pub struct Poll {
    pub status: Status,
    pub samples: Vec<Sample>,
}
impl Default for Poll {
    fn default() -> Self {
        Self {
            status: Status::NotInstalled,
            samples: vec![],
        }
    }
}
#[derive(Deserialize)]
struct Output {
    status: Option<String>,
    command: Option<Command>,
}
#[derive(Deserialize)]
struct Command {
    data: Option<Data>,
}
#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    groups: Vec<Group>,
}
#[derive(Deserialize)]
struct Group {
    #[serde(default)]
    buckets: Vec<Bucket>,
}
#[derive(Deserialize)]
struct Bucket {
    id: Option<String>,
    remaining_fraction: Option<f64>,
    reset_time: Option<String>,
}
fn parse(bytes: &[u8], now: i64) -> Option<Vec<Sample>> {
    let output: Output = serde_json::from_slice(bytes).ok()?;
    if output.status.as_deref() != Some("SUCCESS") {
        return None;
    }
    let mut samples = Vec::new();
    for bucket in output
        .command?
        .data?
        .groups
        .into_iter()
        .flat_map(|g| g.buckets)
    {
        let Some(id) = bucket.id else { continue };
        if !["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"].contains(&id.as_str()) {
            continue;
        }
        let remaining = bucket.remaining_fraction?;
        if !remaining.is_finite() || !(0.0..=1.0).contains(&remaining) {
            return None;
        }
        let reset = chrono::DateTime::parse_from_rfc3339(&bucket.reset_time?)
            .ok()?
            .timestamp_millis();
        if reset <= now || samples.iter().any(|s: &Sample| s.bucket_id == id) {
            return None;
        }
        samples.push(Sample {
            bucket_id: id,
            remaining_ppm: (remaining * 1000000.0).round() as u32,
            reset_at_ms: reset,
            observed_at_ms: now,
        });
    }
    (!samples.is_empty()).then_some(samples)
}
fn find_binary(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return path.is_file().then(|| path.to_path_buf());
    }
    let mut dirs: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|p| p.is_absolute())
        .collect();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("agy/bin"));
    }
    let name = if cfg!(windows) { "agy.exe" } else { "agy" };
    dirs.into_iter().map(|p| p.join(name)).find(|p| p.is_file())
}
pub async fn poll(enabled: bool, explicit: Option<&Path>) -> Poll {
    if !enabled {
        return Poll {
            status: Status::Disabled,
            samples: vec![],
        };
    }
    let Some(bin) = find_binary(explicit) else {
        return Poll::default();
    };
    let mut command = tokio::process::Command::new(bin);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .args(["--print", "/usage", "--output-format", "json"])
        .env_remove("GEMINI_API_KEY")
        .env_remove("GOOGLE_GEMINI_BASE_URL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let run = async {
        let mut child = command.spawn().ok()?;
        let mut out = child.stdout.take()?.take(262145);
        let mut bytes = Vec::new();
        out.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() > 262144 {
            return None;
        }
        if !child.wait().await.ok()?.success() {
            return None;
        }
        parse(&bytes, crate::background::now_ms())
    };
    match tokio::time::timeout(Duration::from_secs(30), run).await {
        Ok(Some(samples)) => Poll {
            status: Status::Ok,
            samples,
        },
        _ => Poll {
            status: Status::Error,
            samples: vec![],
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_only_known_numeric_quota_metadata() {
        let input=br#"{"status":"SUCCESS","google_oauth_token":"SECRET_CANARY","email":"private@example.test","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.75321,"reset_time":"2030-01-01T00:00:00Z","prompt":"CONTENT_CANARY"},{"id":"future-bucket","remaining_fraction":0.2}]}]}}}"#;
        let samples = parse(input, 1).unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].remaining_ppm, 753210);
        let json = serde_json::to_string(&samples).unwrap();
        for forbidden in [
            "SECRET_CANARY",
            "CONTENT_CANARY",
            "email",
            "future-bucket",
            "remaining_fraction",
        ] {
            assert!(!json.contains(forbidden));
        }
    }
    #[test]
    fn rejects_failed_invalid_duplicate_and_expired_readings() {
        for input in [
            r#"{"status":"ERROR"}"#,
            r#"{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":1.2,"reset_time":"2030-01-01T00:00:00Z"}]}]}}}"#,
            r#"{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.2,"reset_time":"1970-01-01T00:00:00Z"}]}]}}}"#,
        ] {
            assert!(parse(input.as_bytes(), 1).is_none());
        }
        let duplicate = r#"{"status":"SUCCESS","command":{"data":{"groups":[{"buckets":[{"id":"gemini-5h","remaining_fraction":0.5,"reset_time":"2030-01-01T00:00:00Z"},{"id":"gemini-5h","remaining_fraction":0.4,"reset_time":"2030-01-01T00:00:00Z"}]}]}}}"#;
        assert!(parse(duplicate.as_bytes(), 1).is_none());
    }
    #[tokio::test]
    async fn can_disable_without_launching_any_process() {
        assert_eq!(poll(false, None).await.status, Status::Disabled);
    }
}
