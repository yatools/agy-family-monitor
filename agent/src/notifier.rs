use crate::{
    config::Credentials,
    queue::Queue,
    uploader::{Api, ApiError},
};

pub async fn poll(
    api: &Api,
    credentials: &Credentials,
    queue: &Queue,
    enabled: bool,
    now: i64,
) -> Result<(), &'static str> {
    let cursor = queue.state("notification_cursor")?;
    let alerts = api
        .alerts(credentials, &cursor)
        .await
        .map_err(api_message)?;
    deliver(
        &alerts,
        queue,
        enabled && alerts.notifications_enabled,
        now,
        crate::windows::toast::show,
    )?;
    if !alerts.notifications.is_empty() {
        let ids = alerts
            .notifications
            .iter()
            .map(|n| n.id.clone())
            .collect::<Vec<_>>();
        api.ack(credentials, &ids).await.map_err(api_message)?;
    }
    queue.set_state("notification_cursor", &alerts.next_cursor)
}

fn deliver(
    alerts: &crate::uploader::Alerts,
    queue: &Queue,
    enabled: bool,
    now: i64,
    mut show: impl FnMut(&str, &str) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    for notification in &alerts.notifications {
        if !queue.seen_notification(&notification.id)? {
            if enabled {
                show(&notification.id, &notification.message)?;
            }
            queue.mark_notification(&notification.id, now)?;
        }
    }
    Ok(())
}

fn api_message(error: ApiError) -> &'static str {
    match error {
        ApiError::AuthRejected => "设备认证被拒绝，无法获取通知",
        _ => "通知服务暂不可用，保留当前游标",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alerts() -> crate::uploader::Alerts {
        crate::uploader::Alerts {
            notifications: vec![crate::uploader::Notification {
                id: "id-1".into(),
                message: "Threshold reached".into(),
                created_at_ms: 0,
            }],
            next_cursor: "cursor-1".into(),
            notifications_enabled: true,
        }
    }
    #[test]
    fn toast_is_not_repeated_and_cursor_is_not_advanced_before_ack() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("q.db");
        let queue = Queue::open(&path).unwrap();
        let mut shown = 0;
        deliver(&alerts(), &queue, true, 0, |_, _| {
            shown += 1;
            Ok(())
        })
        .unwrap();
        drop(queue);
        let queue = Queue::open(&path).unwrap();
        deliver(&alerts(), &queue, true, 1, |_, _| {
            shown += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(shown, 1);
        assert_eq!(queue.state("notification_cursor").unwrap(), "");
    }
    #[test]
    fn failed_or_disabled_toast_respects_delivery_state() {
        let temp = tempfile::tempdir().unwrap();
        let queue = Queue::open(&temp.path().join("q.db")).unwrap();
        assert!(deliver(&alerts(), &queue, true, 0, |_, _| Err(
            "disabled by Windows"
        ))
        .is_err());
        assert!(!queue.seen_notification("id-1").unwrap());
        deliver(&alerts(), &queue, false, 0, |_, _| {
            panic!("notification preference ignored")
        })
        .unwrap();
        assert!(queue.seen_notification("id-1").unwrap());
    }
}
