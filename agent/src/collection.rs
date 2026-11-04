use crate::queue::Queue;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    pub enabled: bool,
    pub interval_seconds: u64,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: 300,
        }
    }
}
impl Policy {
    pub fn valid(&self) -> bool {
        (60..=3600).contains(&self.interval_seconds)
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub id: String,
    pub requested_at_ms: i64,
}
impl Request {
    pub fn valid(&self) -> bool {
        self.requested_at_ms > 0
            && self.id.len() == 36
            && self.id.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AckStatus {
    Completed,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ack {
    pub request_id: String,
    pub status: AckStatus,
}
impl Ack {
    fn valid(&self) -> bool {
        Request {
            id: self.request_id.clone(),
            requested_at_ms: 1,
        }
        .valid()
    }
}
#[derive(Deserialize)]
pub struct Heartbeat {
    pub success: bool,
    pub collection: Option<Policy>,
    pub collection_request: Option<Request>,
}
pub struct Controller {
    pub policy: Policy,
    pub ack: Option<Ack>,
    known: bool,
    last_scan: i64,
    last_request: String,
    pub request: Option<Request>,
}
impl Controller {
    pub fn load(queue: &Queue) -> Result<Self, &'static str> {
        let cached = serde_json::from_str::<Policy>(&queue.state("collection_policy")?)
            .ok()
            .filter(Policy::valid);
        let known = cached.is_some();
        Ok(Self {
            policy: cached.unwrap_or_default(),
            known,
            last_scan: queue.state("collection_last_scan")?.parse().unwrap_or(0),
            last_request: queue.state("collection_last_request")?,
            ack: serde_json::from_str::<Ack>(&queue.state("collection_ack")?)
                .ok()
                .filter(Ack::valid),
            request: None,
        })
    }
    pub fn accept(&mut self, response: Heartbeat, queue: &Queue) -> Result<(), &'static str> {
        let policy = response.collection.unwrap_or_default();
        if !response.success
            || !policy.valid()
            || response
                .collection_request
                .as_ref()
                .is_some_and(|r| !r.valid())
        {
            return Err("采集控制响应无效");
        }
        queue.set_state(
            "collection_policy",
            &serde_json::to_string(&policy).map_err(|_| "采集设置无效")?,
        )?;
        queue.set_state("collection_ack", "")?;
        self.ack = None;
        self.policy = policy;
        self.known = true;
        self.request = response
            .collection_request
            .filter(|r| r.id != self.last_request);
        Ok(())
    }
    pub fn due(&self, now: i64) -> bool {
        self.request.is_some()
            || (self.known
                && self.policy.enabled
                && now.saturating_sub(self.last_scan)
                    >= (self.policy.interval_seconds * 1000) as i64)
    }
    pub fn finish(&mut self, queue: &Queue, now: i64, succeeded: bool) -> Result<(), &'static str> {
        self.last_scan = now;
        queue.set_state("collection_last_scan", &now.to_string())?;
        if let Some(request) = self.request.take() {
            self.last_request = request.id.clone();
            let ack = Ack {
                request_id: request.id,
                status: if succeeded {
                    AckStatus::Completed
                } else {
                    AckStatus::Failed
                },
            };
            queue.set_state("collection_last_request", &self.last_request)?;
            queue.set_state(
                "collection_ack",
                &serde_json::to_string(&ack).map_err(|_| "采集回执无效")?,
            )?;
            self.ack = Some(ack);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response(enabled: bool, seconds: u64, request: Option<Request>) -> Heartbeat {
        Heartbeat {
            success: true,
            collection: Some(Policy {
                enabled,
                interval_seconds: seconds,
            }),
            collection_request: request,
        }
    }
    #[test]
    fn scheduled_collection_respects_interval_and_survives_restart() {
        let temp = tempfile::tempdir().unwrap();
        let queue = Queue::open(&temp.path().join("queue.db")).unwrap();
        let mut control = Controller::load(&queue).unwrap();
        let now = 1_800_000;
        assert!(!control.due(now));
        control.accept(response(true, 300, None), &queue).unwrap();
        assert!(control.due(now));
        control.finish(&queue, now, true).unwrap();
        assert!(!control.due(now + 60_000));
        assert!(control.due(now + 300_000));
        let mut restarted = Controller::load(&queue).unwrap();
        assert!(!restarted.due(now + 120_000));
        assert!(restarted.accept(response(true, 0, None), &queue).is_err());
        assert_eq!(restarted.policy.interval_seconds, 300);
    }
    #[test]
    fn pause_allows_only_explicit_manual_capture_and_never_replays_a_finished_request() {
        let temp = tempfile::tempdir().unwrap();
        let queue = Queue::open(&temp.path().join("queue.db")).unwrap();
        let mut control = Controller::load(&queue).unwrap();
        let now = 1_800_000;
        control.accept(response(false, 300, None), &queue).unwrap();
        assert!(!control.due(now + 86400000));
        let request = Request {
            id: "12345678-1234-4234-8234-123456789012".into(),
            requested_at_ms: now,
        };
        control
            .accept(response(false, 300, Some(request.clone())), &queue)
            .unwrap();
        assert!(control.due(now));
        control.finish(&queue, now, true).unwrap();
        assert!(control.ack.is_some());
        assert!(!control.due(now + 86400000));
        let mut restarted = Controller::load(&queue).unwrap();
        assert!(restarted.ack.is_some());
        restarted
            .accept(response(false, 300, Some(request)), &queue)
            .unwrap();
        assert!(restarted.ack.is_none());
        assert!(!restarted.due(now + 86400000));
    }
}
