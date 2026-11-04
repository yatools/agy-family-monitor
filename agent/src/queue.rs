use agy_usage_core::normalizer::UploadEvent;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::Path;

pub struct Queue {
    conn: Connection,
}

#[derive(Clone)]
pub struct Pending {
    pub event: UploadEvent,
    pub hash: String,
}

pub fn backoff_seconds(attempt: u32) -> u64 {
    30u64
        .saturating_mul(
            1u64.checked_shl(attempt.saturating_sub(1).min(6))
                .unwrap_or(64),
        )
        .min(1800)
}

impl Queue {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS events_queue (
            event_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, payload TEXT NOT NULL,
            payload_hash TEXT NOT NULL, synced_hash TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS queue_pending ON events_queue(next_attempt_ms);
          CREATE TABLE IF NOT EXISTS scanner_state (session_key TEXT PRIMARY KEY,file_len INTEGER NOT NULL,modified_stamp TEXT NOT NULL,last_scan_ms INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,shown_at_ms INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS agent_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        Ok(Self { conn })
    }
    pub fn stage(&mut self, events: Vec<UploadEvent>, now: i64) -> Result<usize, &'static str> {
        let tx = self.conn.transaction().map_err(|_| "无法写入本地队列")?;
        let mut changed = 0;
        for mut event in events {
            // Preserve a historically recovered model during a temporary native DB failure.
            if event.model_id == "unknown" {
                let previous: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM events_queue WHERE event_id=?1",
                        [&event.event_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| "无法读取历史状态")?;
                if let Some(previous) = previous {
                    let old: UploadEvent =
                        serde_json::from_str(&previous).map_err(|_| "本地队列数据损坏")?;
                    if old.model_id != "unknown" {
                        event.model_id = old.model_id;
                        event.model_display = old.model_display;
                    }
                }
            }
            let payload = serde_json::to_string(&event).map_err(|_| "事件编码失败")?;
            let hash = hex::encode(Sha256::digest(payload.as_bytes()));
            changed+=tx.execute("INSERT INTO events_queue(event_id,session_key,payload,payload_hash,updated_at_ms) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload,payload_hash=excluded.payload_hash,retry_count=0,next_attempt_ms=0,updated_at_ms=excluded.updated_at_ms WHERE events_queue.payload_hash!=excluded.payload_hash",
                params![event.event_id,event.session_key,payload,hash,now]).map_err(|_|"无法写入本地队列")?;
        }
        tx.commit().map_err(|_| "无法提交本地队列")?;
        Ok(changed)
    }
    pub fn pending(&self, now: i64) -> Result<Vec<Pending>, &'static str> {
        let mut query=self.conn.prepare("SELECT payload,payload_hash FROM events_queue WHERE (synced_hash IS NULL OR synced_hash!=payload_hash) AND next_attempt_ms<=?1 ORDER BY updated_at_ms,event_id LIMIT 100").map_err(|_|"无法读取待上传队列")?;
        let rows = query
            .query_map([now], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|_| "无法读取待上传队列")?;
        rows.map(|row| {
            let (payload, hash) = row.map_err(|_| "无法读取队列事件")?;
            Ok(Pending {
                event: serde_json::from_str(&payload).map_err(|_| "本地队列数据损坏")?,
                hash,
            })
        })
        .collect()
    }
    pub fn confirm(&mut self, batch: &[Pending]) -> Result<(), &'static str> {
        let tx = self.conn.transaction().map_err(|_| "无法确认上传回执")?;
        for pending in batch {
            tx.execute("UPDATE events_queue SET synced_hash=?2,retry_count=0,next_attempt_ms=0 WHERE event_id=?1 AND payload_hash=?2",params![pending.event.event_id,pending.hash]).map_err(|_|"无法确认上传回执")?;
        }
        tx.commit().map_err(|_| "无法保存上传回执")
    }
    pub fn retry(&mut self, batch: &[Pending], now: i64) -> Result<(), &'static str> {
        let tx = self.conn.transaction().map_err(|_| "无法保存重试状态")?;
        for pending in batch {
            let attempt: u32 = tx
                .query_row(
                    "SELECT retry_count FROM events_queue WHERE event_id=?1",
                    [&pending.event.event_id],
                    |r| r.get(0),
                )
                .map_err(|_| "无法读取重试状态")?;
            let next_attempt = attempt.saturating_add(1).min(32);
            let next = now.saturating_add((backoff_seconds(next_attempt) * 1000) as i64);
            tx.execute("UPDATE events_queue SET retry_count=?3,next_attempt_ms=?4 WHERE event_id=?1 AND payload_hash=?2",params![pending.event.event_id,pending.hash,next_attempt,next]).map_err(|_|"无法保存重试状态")?;
        }
        tx.commit().map_err(|_| "无法保存重试状态")
    }
    pub fn pending_count(&self) -> Result<u64, &'static str> {
        let count=self.conn.query_row("SELECT count(*) FROM events_queue WHERE synced_hash IS NULL OR synced_hash!=payload_hash",[],|r|r.get::<_,i64>(0)).map_err(|_|"无法统计队列")?;
        u64::try_from(count).map_err(|_| "队列计数无效")
    }
    pub fn scanned(&self, key: &str, len: u64, stamp: &str, now: i64) -> Result<(), &'static str> {
        let len = i64::try_from(len).map_err(|_| "会话文件过大")?;
        self.conn.execute("INSERT INTO scanner_state VALUES(?1,?2,?3,?4) ON CONFLICT(session_key) DO UPDATE SET file_len=excluded.file_len,modified_stamp=excluded.modified_stamp,last_scan_ms=excluded.last_scan_ms",params![key,len,stamp,now]).map_err(|_|"无法保存扫描状态")?;
        Ok(())
    }
    pub fn seen_notification(&self, id: &str) -> Result<bool, &'static str> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM notifications WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "无法查询通知状态")
    }
    pub fn mark_notification(&self, id: &str, now: i64) -> Result<(), &'static str> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO notifications VALUES(?1,?2)",
                params![id, now],
            )
            .map_err(|_| "无法保存通知状态")?;
        Ok(())
    }
    pub fn state(&self, key: &str) -> Result<String, &'static str> {
        self.conn
            .query_row("SELECT value FROM agent_state WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map(|v| v.unwrap_or_default())
            .map_err(|_| "无法读取客户端状态")
    }
    pub fn set_state(&self, key: &str, value: &str) -> Result<(), &'static str> {
        self.conn.execute("INSERT INTO agent_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|_|"无法保存客户端状态")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agy_usage_core::normalizer::UploadTokens;
    fn event(input: u64) -> UploadEvent {
        UploadEvent {
            event_id: "event".into(),
            session_key: "session".into(),
            step_index: 1,
            model_id: "known".into(),
            model_display: "Known".into(),
            occurred_at_ms: 0,
            tokens: UploadTokens {
                input,
                output: 1,
                cache_read: 2,
                cache_write: 3,
            },
            source: agy_usage_core::Source::Ide,
        }
    }
    #[test]
    fn offline_queue_survives_restart_and_never_duplicates_same_step() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("queue.db");
        {
            let mut q = Queue::open(&path).unwrap();
            assert_eq!(q.stage(vec![event(10)], 0).unwrap(), 1);
            assert_eq!(q.stage(vec![event(10)], 0).unwrap(), 0);
        }
        let mut q = Queue::open(&path).unwrap();
        let pending = q.pending(0).unwrap();
        assert_eq!(pending.len(), 1);
        q.confirm(&pending).unwrap();
        assert_eq!(q.pending_count().unwrap(), 0);
        q.stage(vec![event(20)], 1).unwrap();
        assert_eq!(q.pending_count().unwrap(), 1);
        assert_eq!(q.pending(1).unwrap()[0].event.tokens.input, 20);
    }
    #[test]
    fn stale_ack_cannot_swallow_a_newer_correction() {
        let temp = tempfile::tempdir().unwrap();
        let mut q = Queue::open(&temp.path().join("q.db")).unwrap();
        q.stage(vec![event(10)], 0).unwrap();
        let pending = q.pending(0).unwrap();
        q.stage(vec![event(20)], 1).unwrap();
        q.confirm(&pending).unwrap();
        assert_eq!(q.pending_count().unwrap(), 1);
    }
    #[test]
    fn retry_is_persisted_and_exponential_with_thirty_minute_cap() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("q.db");
        let mut q = Queue::open(&path).unwrap();
        q.stage(vec![event(10)], 0).unwrap();
        let batch = q.pending(0).unwrap();
        q.retry(&batch, 0).unwrap();
        drop(q);
        let q = Queue::open(&path).unwrap();
        assert!(q.pending(29999).unwrap().is_empty());
        assert_eq!(q.pending(30000).unwrap().len(), 1);
        assert_eq!(
            [1, 2, 3, 10, 32].map(backoff_seconds),
            [30, 60, 120, 1800, 1800]
        );
    }
    #[test]
    fn native_failure_preserves_historical_model_and_updates_counters() {
        let temp = tempfile::tempdir().unwrap();
        let mut q = Queue::open(&temp.path().join("q.db")).unwrap();
        q.stage(vec![event(10)], 0).unwrap();
        let mut corrected = event(20);
        corrected.model_id = "unknown".into();
        corrected.model_display = "unknown".into();
        q.stage(vec![corrected], 1).unwrap();
        let batch = q.pending(1).unwrap();
        assert_eq!(batch[0].event.model_id, "known");
        assert_eq!(batch[0].event.tokens.input, 20);
    }
}
