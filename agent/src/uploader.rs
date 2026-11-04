use crate::{config::Credentials, queue::Pending};
use reqwest::{redirect::Policy, Client, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    Network,
    AuthRejected,
    Rejected,
    InvalidResponse,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Network => "网络不可用，已保留本地队列",
            Self::AuthRejected => "设备认证被拒绝，已暂停上传并保留本地队列",
            Self::Rejected => "服务器拒绝请求，已保留本地队列",
            Self::InvalidResponse => "服务器回执无效，已保留本地队列",
        })
    }
}

pub struct Api {
    client: Client,
    base: Url,
}

#[derive(Serialize)]
struct Batch<'a> {
    batch_id: String,
    agent_version: &'static str,
    events: Vec<&'a agy_usage_core::normalizer::UploadEvent>,
}

#[derive(Deserialize)]
struct Receipt {
    success: bool,
    inserted: usize,
    updated: usize,
    unchanged: usize,
    server_time_ms: i64,
}

#[derive(Deserialize)]
pub struct Notification {
    pub id: String,
    pub message: String,
    pub created_at_ms: i64,
}
#[derive(Deserialize)]
pub struct Alerts {
    pub notifications: Vec<Notification>,
    pub next_cursor: String,
    #[serde(default = "enabled_by_default")]
    pub notifications_enabled: bool,
}
fn enabled_by_default() -> bool {
    true
}

impl Api {
    pub fn new(base: &str) -> Result<Self, &'static str> {
        let base = Url::parse(base).map_err(|_| "服务器地址无效")?;
        if base.scheme() != "https"
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err("服务器地址必须是没有路径、账号或查询参数的 HTTPS 域名");
        }
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("AgyFamilyMonitor/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "无法初始化 HTTPS 客户端")?;
        Ok(Self { client, base })
    }
    fn url(&self, path: &str) -> Result<Url, ApiError> {
        self.base.join(path).map_err(|_| ApiError::Rejected)
    }
    async fn decode<T: DeserializeOwned>(mut response: Response) -> Result<T, ApiError> {
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(ApiError::AuthRejected);
        }
        if !response.status().is_success() {
            return Err(ApiError::Rejected);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::Network)? {
            if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
                return Err(ApiError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidResponse)
    }
    pub async fn enroll(&self, code: &str, label: &str) -> Result<Credentials, ApiError> {
        let response=self.client.post(self.url("api/v1/agent/enroll")?).json(&serde_json::json!({"code":code,"device_label":label,"platform":"windows-x64","agent_version":env!("CARGO_PKG_VERSION")})).send().await.map_err(|_|ApiError::Network)?;
        let credentials: Credentials = Self::decode(response).await?;
        credentials.key().map_err(|_| ApiError::InvalidResponse)?;
        Ok(credentials)
    }
    pub async fn upload(
        &self,
        credentials: &Credentials,
        pending: &[Pending],
    ) -> Result<(), ApiError> {
        if pending.is_empty() || pending.len() > 100 {
            return Err(ApiError::Rejected);
        }
        let mut digest = Sha256::new();
        for entry in pending {
            digest.update(entry.hash.as_bytes());
        }
        let batch = Batch {
            batch_id: hex::encode(digest.finalize()),
            agent_version: env!("CARGO_PKG_VERSION"),
            events: pending.iter().map(|e| &e.event).collect(),
        };
        let response = self
            .client
            .post(self.url("api/v1/agent/events")?)
            .bearer_auth(&credentials.device_token)
            .json(&batch)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        let receipt: Receipt = Self::decode(response).await?;
        let count = receipt
            .inserted
            .checked_add(receipt.updated)
            .and_then(|n| n.checked_add(receipt.unchanged));
        if !receipt.success || count != Some(pending.len()) || receipt.server_time_ms < 0 {
            return Err(ApiError::InvalidResponse);
        }
        Ok(())
    }
    pub async fn heartbeat(
        &self,
        credentials: &Credentials,
        pending: u64,
        notifications: bool,
        health: &crate::tracker::Health,
        quota: &crate::quota::Poll,
    ) -> Result<(), ApiError> {
        let response=self.client.post(self.url("api/v1/agent/heartbeat")?).bearer_auth(&credentials.device_token)
            .json(&serde_json::json!({"agent_version":env!("CARGO_PKG_VERSION"),"pending_events":pending,"notifications_enabled":notifications,"collector":health,"quota_status":quota.status,"quota":quota.samples}))
            .send().await.map_err(|_|ApiError::Network)?;
        self.success(response).await
    }
    pub async fn alerts(
        &self,
        credentials: &Credentials,
        cursor: &str,
    ) -> Result<Alerts, ApiError> {
        let response = self
            .client
            .get(self.url("api/v1/agent/alerts")?)
            .bearer_auth(&credentials.device_token)
            .query(&[("after", cursor)])
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        let alerts: Alerts = Self::decode(response).await?;
        if alerts.next_cursor.len() > 512
            || alerts.notifications.len() > 100
            || alerts.notifications.iter().any(|n| {
                n.id.is_empty() || n.id.len() > 256 || n.message.len() > 4096 || n.created_at_ms < 0
            })
        {
            return Err(ApiError::InvalidResponse);
        }
        Ok(alerts)
    }
    pub async fn ack(&self, credentials: &Credentials, ids: &[String]) -> Result<(), ApiError> {
        let response = self
            .client
            .post(self.url("api/v1/agent/alerts/ack")?)
            .bearer_auth(&credentials.device_token)
            .json(&serde_json::json!({"notification_ids":ids}))
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        self.success(response).await
    }
    async fn success(&self, response: Response) -> Result<(), ApiError> {
        #[derive(Deserialize)]
        struct Success {
            success: bool,
        }
        if Self::decode::<Success>(response).await?.success {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse)
        }
    }
    #[cfg(test)]
    pub(crate) fn local(base: Url) -> Self {
        Self {
            client: Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            base,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn server(status: u16, body: &str) -> Api {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = vec![0; 16384];
            let _ = socket.read(&mut data).await;
            let response=format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        Api::local(Url::parse(&format!("http://{address}/")).unwrap())
    }
    fn credentials() -> Credentials {
        Credentials {
            device_id: "device".into(),
            device_token: "x".repeat(40),
            pseudonym_key: "01".repeat(32),
        }
    }
    #[test]
    fn production_never_accepts_plaintext_credentials_or_redirect_origins() {
        for url in [
            "http://example.com",
            "https://u:p@example.com",
            "https://example.com/path",
            "https://example.com/?secret=x",
        ] {
            assert!(Api::new(url).is_err());
        }
        assert!(Api::new("https://agent.example.com").is_ok());
    }
    #[tokio::test]
    async fn distinguishes_revocation_from_transient_failure() {
        let api = server(401, "{}").await;
        assert_eq!(
            api.heartbeat(
                &credentials(),
                0,
                true,
                &crate::tracker::Health::default(),
                &crate::quota::Poll::default()
            )
            .await,
            Err(ApiError::AuthRejected)
        );
        let api = server(500, "{}").await;
        assert_eq!(
            api.heartbeat(
                &credentials(),
                0,
                true,
                &crate::tracker::Health::default(),
                &crate::quota::Poll::default()
            )
            .await,
            Err(ApiError::Rejected)
        );
    }
    #[tokio::test]
    async fn redirects_and_invalid_success_json_are_not_acknowledgements() {
        let api = server(302, "{}").await;
        assert_eq!(
            api.heartbeat(
                &credentials(),
                0,
                true,
                &crate::tracker::Health::default(),
                &crate::quota::Poll::default()
            )
            .await,
            Err(ApiError::Rejected)
        );
        let api = server(200, r#"{"success":false}"#).await;
        assert_eq!(
            api.heartbeat(
                &credentials(),
                0,
                true,
                &crate::tracker::Health::default(),
                &crate::quota::Poll::default()
            )
            .await,
            Err(ApiError::InvalidResponse)
        );
    }

    #[tokio::test]
    async fn only_a_complete_batch_receipt_can_confirm_persisted_events() {
        use crate::queue::Queue;
        let temp = tempfile::tempdir().unwrap();
        let mut queue = Queue::open(&temp.path().join("q.db")).unwrap();
        let event=serde_json::from_value(serde_json::json!({"event_id":"opaque-event","session_key":"opaque-session","step_index":1,"model_id":"unknown","model_display":"unknown","occurred_at_ms":1,"tokens":{"input":10,"output":2,"cache_read":3,"cache_write":4},"source":"antigravity_cli"})).unwrap();
        queue.stage(vec![event], 0).unwrap();
        let pending = queue.pending(0).unwrap();
        let api = server(
            200,
            r#"{"success":true,"inserted":0,"updated":0,"unchanged":0,"server_time_ms":1}"#,
        )
        .await;
        assert_eq!(
            api.upload(&credentials(), &pending).await,
            Err(ApiError::InvalidResponse)
        );
        assert_eq!(queue.pending_count().unwrap(), 1);
        let api = server(
            200,
            r#"{"success":true,"inserted":1,"updated":0,"unchanged":0,"server_time_ms":1}"#,
        )
        .await;
        api.upload(&credentials(), &pending).await.unwrap();
        queue.confirm(&pending).unwrap();
        assert_eq!(queue.pending_count().unwrap(), 0);
    }
}
