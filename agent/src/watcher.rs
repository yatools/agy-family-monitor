use agy_usage_core::discovery::DiscoveryConfig;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{collections::HashSet, path::PathBuf};

pub struct WatcherState {
    watcher: RecommendedWatcher,
    roots: HashSet<PathBuf>,
}

pub fn relevant(event: &Event) -> bool {
    (event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove())
        && event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == "transcript_full.jsonl"))
}

impl WatcherState {
    pub fn new(tx: tokio::sync::mpsc::Sender<()>) -> Result<Self, &'static str> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            if event.as_ref().map(relevant).unwrap_or(true) {
                let _ = tx.try_send(());
            }
        })
        .map_err(|_| "文件监听不可用，将使用定时扫描")?;
        Ok(Self {
            watcher,
            roots: HashSet::new(),
        })
    }
    pub fn refresh(&mut self, config: &DiscoveryConfig) {
        self.roots.retain(|path| {
            if path.is_dir() {
                true
            } else {
                let _ = self.watcher.unwatch(path);
                false
            }
        });
        for root in config.roots() {
            let Ok(path) = root.path.canonicalize() else {
                continue;
            };
            if !self.roots.contains(&path)
                && self.watcher.watch(&path, RecursiveMode::Recursive).is_ok()
            {
                self.roots.insert(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_and_own_queue_writes_do_not_cause_watcher_loops() {
        use notify::event::{AccessKind, CreateKind};
        let access = Event::new(notify::EventKind::Access(AccessKind::Read))
            .add_path("transcript_full.jsonl".into());
        assert!(!relevant(&access));
        let queue =
            Event::new(notify::EventKind::Create(CreateKind::File)).add_path("data.db".into());
        assert!(!relevant(&queue));
    }
}
