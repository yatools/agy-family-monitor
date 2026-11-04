// Directory layout and duplicate precedence adapted from CC Switch (MIT).
// Copyright (c) 2025 Jason Young. See THIRD_PARTY_NOTICES.md.
use crate::Source;
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct SessionRoot {
    pub path: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub transcript: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone)]
pub struct DiscoveryConfig {
    pub home: PathBuf,
    pub cc_switch_dir: Option<PathBuf>,
    pub extra_roots: Vec<SessionRoot>,
}

impl DiscoveryConfig {
    pub fn for_current_user() -> io::Result<Self> {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "User home unavailable"))?;
        Ok(Self {
            home,
            cc_switch_dir: None,
            extra_roots: Vec::new(),
        })
    }

    pub fn roots(&self) -> Vec<SessionRoot> {
        let mut roots = vec![
            SessionRoot {
                path: self.home.join(".gemini/antigravity-cli/brain"),
                source: Source::Cli,
            },
            SessionRoot {
                path: self.home.join(".gemini/antigravity/brain"),
                source: Source::Ide,
            },
        ];
        let private = self
            .cc_switch_dir
            .clone()
            .unwrap_or_else(|| self.home.join(".cc-switch"))
            .join("agy");
        let mut profiles: Vec<PathBuf> = fs::read_dir(private)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .map(|entry| entry.path())
            .collect();
        profiles.sort();
        roots.extend(profiles.into_iter().map(|path| SessionRoot {
            path: path.join("antigravity-cli/brain"),
            source: Source::Cli,
        }));
        roots.extend(self.extra_roots.clone());
        roots
    }
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub sessions: Vec<Session>,
    pub unreadable_roots: usize,
    pub rejected_paths: usize,
    pub duplicate_sessions: usize,
}

pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn discover(roots: &[SessionRoot]) -> Discovery {
    let mut result = Discovery::default();
    let mut seen_roots = HashSet::new();
    let mut seen_sessions = HashSet::new();
    for root in roots {
        let canonical_root = match root.path.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    result.unreadable_roots += 1;
                }
                continue;
            }
        };
        if !seen_roots.insert(canonical_root.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&canonical_root) {
            Ok(entries) => entries,
            Err(_) => {
                result.unreadable_roots += 1;
                continue;
            }
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Some(id) = entry
                .file_name()
                .to_str()
                .filter(|id| valid_session_id(id))
                .map(str::to_string)
            else {
                continue;
            };
            let transcript = entry
                .path()
                .join(".system_generated/logs/transcript_full.jsonl");
            if !transcript.is_file() {
                continue;
            }
            if !transcript
                .canonicalize()
                .is_ok_and(|path| path.starts_with(&canonical_root))
            {
                result.rejected_paths += 1;
                continue;
            }
            if fs::File::open(&transcript).is_err() {
                result.rejected_paths += 1;
                continue;
            }
            if !seen_sessions.insert(id.clone()) {
                result.duplicate_sessions += 1;
                continue;
            }
            result.sessions.push(Session {
                id,
                transcript,
                source: root.source,
            });
        }
    }
    result
}

pub fn native_database_path(transcript: &Path) -> Option<PathBuf> {
    let session = transcript.parent()?.parent()?.parent()?;
    let brain = session.parent()?.file_name()?;
    if brain != "brain" {
        return None;
    }
    let root = session.parent()?.parent()?;
    Some(
        root.join("conversations")
            .join(session.file_name()?)
            .with_extension("db"),
    )
}
