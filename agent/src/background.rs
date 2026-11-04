use crate::{
    config::{Config, Credentials},
    queue::Queue,
    tracker::Tracker,
    uploader::{Api, ApiError},
};
use agy_usage_core::{discovery::DiscoveryConfig, normalizer::Pseudonymizer};
use std::{
    io::Write,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}

fn log(data_dir: &Path, message: &str) {
    let directory = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join("agent.log");
    if path.metadata().is_ok_and(|m| m.len() > 1024 * 1024) {
        let _ = std::fs::remove_file(directory.join("agent.previous.log"));
        let _ = std::fs::rename(&path, directory.join("agent.previous.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{} {message}", now_ms());
    }
}

fn queue(data_dir: &Path, credentials: &Credentials) -> Result<Queue, &'static str> {
    std::fs::create_dir_all(data_dir).map_err(|_| "无法创建客户端目录")?;
    let queue = Queue::open(&data_dir.join("data.db")).map_err(|_| "无法打开本地队列")?;
    let bound = queue.state("device_id")?;
    if !bound.is_empty() && bound != credentials.device_id {
        return Err("本地队列属于其他设备，请使用独立数据目录。");
    }
    queue.set_state("device_id", &credentials.device_id)?;
    Ok(queue)
}

async fn upload(
    api: &Api,
    credentials: &Credentials,
    queue: &mut Queue,
) -> Result<usize, ApiError> {
    let retry_after = queue
        .state("upload_retry_after_ms")
        .map_err(|_| ApiError::InvalidResponse)?
        .parse::<i64>()
        .unwrap_or(0);
    if retry_after > now_ms() {
        return Ok(0);
    }
    let pending = queue
        .pending(now_ms())
        .map_err(|_| ApiError::InvalidResponse)?;
    if pending.is_empty() {
        return Ok(0);
    }
    match api.upload(credentials, &pending).await {
        Ok(()) => {
            queue
                .confirm(&pending)
                .map_err(|_| ApiError::InvalidResponse)?;
            queue
                .set_state("upload_retry_after_ms", "0")
                .map_err(|_| ApiError::InvalidResponse)?;
            queue
                .set_state("upload_retry_count", "0")
                .map_err(|_| ApiError::InvalidResponse)?;
            Ok(pending.len())
        }
        Err(error) => {
            queue
                .retry(&pending, now_ms())
                .map_err(|_| ApiError::InvalidResponse)?;
            let attempt = queue
                .state("upload_retry_count")
                .map_err(|_| ApiError::InvalidResponse)?
                .parse::<u32>()
                .unwrap_or(0)
                .saturating_add(1)
                .min(32);
            let after =
                now_ms().saturating_add((crate::queue::backoff_seconds(attempt) * 1000) as i64);
            queue
                .set_state("upload_retry_count", &attempt.to_string())
                .map_err(|_| ApiError::InvalidResponse)?;
            queue
                .set_state("upload_retry_after_ms", &after.to_string())
                .map_err(|_| ApiError::InvalidResponse)?;
            Err(error)
        }
    }
}

pub async fn once(
    config: &Config,
    credentials: &Credentials,
    discovery: &DiscoveryConfig,
    data_dir: &Path,
) -> Result<bool, &'static str> {
    let _instance = crate::windows::Instance::acquire(data_dir)?;
    let api = Api::new(&config.api_base_url)?;
    let mut queue = queue(data_dir, credentials)?;
    let pseudonyms = Pseudonymizer::new(&credentials.key()?)?;
    Tracker::default().collect(discovery, &mut queue, &pseudonyms, now_ms())?;
    for _ in 0..100 {
        match upload(&api, credentials, &mut queue).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                queue.set_state("last_error", &error.to_string())?;
                eprintln!("{error}");
                return Ok(false);
            }
        }
    }
    let pending = queue.pending_count()?;
    eprintln!("待上传事件: {pending}");
    Ok(pending == 0)
}

pub async fn run(
    config: &Config,
    credentials: &Credentials,
    discovery: &DiscoveryConfig,
    data_dir: &Path,
) -> Result<(), &'static str> {
    let _instance = crate::windows::Instance::acquire(data_dir)?;
    let api = Api::new(&config.api_base_url)?;
    let mut queue = queue(data_dir, credentials)?;
    let pseudonyms = Pseudonymizer::new(&credentials.key()?)?;
    let mut tracker = Tracker::default();
    let mut control = crate::collection::Controller::load(&queue)?;
    // File changes do not bypass the administrator's interval. Polling reparses changed snapshots.
    let mut work = tokio::time::interval(Duration::from_secs(15));
    let mut heartbeats = tokio::time::interval(Duration::from_secs(60));
    let mut alerts = tokio::time::interval(Duration::from_secs(60));
    for timer in [&mut work, &mut heartbeats, &mut alerts] {
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    }
    let (quota_tx, mut quota_rx) = tokio::sync::mpsc::channel(1);
    let mut quota_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut quota_reading = crate::quota::Poll::default();
    let mut last_quota_at = 0;
    let mut auth_blocked = false;
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    log(data_dir, "客户端已启动，按管理员设置的频率采集");
    loop {
        tokio::select! {
            _=&mut shutdown=>break,
            _=work.tick()=>{
                let now=now_ms();
                if !auth_blocked && control.due(now) {
                    let manual=control.request.is_some();
                    let success=match tracker.collect(discovery,&mut queue,&pseudonyms,now){Ok(_)=>tracker.health.read_errors==0&&tracker.health.native_errors==0&&tracker.health.malformed_lines==0,Err(message)=>{log(data_dir,message);false}};
                    control.finish(&queue,now,success)?;
                    if (now-last_quota_at>=300000 || manual)
                        && quota_task.as_ref().is_none_or(|task|task.is_finished()) {
                            last_quota_at=now;
                            let tx=quota_tx.clone();let enabled=config.quota_enabled;let path=config.quota_cli_path.clone();
                            quota_task=Some(tokio::spawn(async move{let reading=crate::quota::poll(enabled,path.as_deref()).await;let _=tx.send(reading).await;}));
                    }
                    if manual { heartbeats.reset_immediately(); }
                }
                if !auth_blocked {
                    match upload(&api,credentials,&mut queue).await {
                        Ok(n)=>{if n>0{let _=queue.set_state("last_upload_ms",&now_ms().to_string());let _=queue.set_state("last_error","");}}
                        Err(error)=>{auth_blocked=error==ApiError::AuthRejected;let _=queue.set_state("last_error",&error.to_string());log(data_dir,&error.to_string());}
                    }
                }
            }
            _=heartbeats.tick()=>{
                if !auth_blocked {
                    let now=now_ms();
                    tracker.health.collection_enabled=Some(control.policy.enabled);
                    tracker.health.collection_interval_seconds=Some(control.policy.interval_seconds);
                    quota_reading.samples.retain(|q|q.observed_at_ms>=now-900000&&q.reset_at_ms>now);
                    match api.heartbeat(credentials,queue.pending_count()?,config.notifications_enabled,&tracker.health,&quota_reading,control.ack.as_ref()).await {
                        Ok(response)=>{
                            if let Err(message)=control.accept(response,&queue){log(data_dir,message);}
                            if control.due(now){work.reset_immediately();}
                        }
                        Err(error)=>{auth_blocked=error==ApiError::AuthRejected;log(data_dir,&error.to_string());}
                    }
                }
            }
            Some(reading)=quota_rx.recv()=>{quota_reading=reading;}
            _=alerts.tick()=>{
                if !auth_blocked {if let Err(message)=crate::notifier::poll(&api,credentials,&queue,config.notifications_enabled,now_ms()).await{log(data_dir,message);}}
            }
        }
    }
    if let Some(task) = quota_task {
        task.abort();
    }
    log(data_dir, "客户端已停止，未上传事件已保留");
    Ok(())
}
