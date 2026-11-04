#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod background;
mod cli;
mod config;
mod notifier;
mod queue;
mod quota;
mod reconcile;
mod scanner;
mod tracker;
mod uploader;
mod watcher;
mod windows;

use cli::{Action, Options};
use std::{io::Write, process::ExitCode};

async fn run() -> Result<bool, &'static str> {
    let options = Options::parse(std::env::args_os().skip(1))?;
    if options.action == Action::Help {
        println!("{}", cli::HELP);
        return Ok(true);
    }
    if options.action == Action::Licenses {
        println!(
            "{}\nCC Switch\n{}\n{}",
            include_str!("../../LICENSE"),
            include_str!("../../licenses/CC-Switch-MIT.txt"),
            include_str!("../../THIRD_PARTY_NOTICES.md")
        );
        return Ok(true);
    }
    let data_dir = options
        .data_dir
        .clone()
        .unwrap_or(config::default_data_dir()?);
    let mut local = config::Config::load(&data_dir)?;
    match options.action {
        Action::Help => {
            println!("{}", cli::HELP);
            Ok(true)
        }
        Action::Licenses => Ok(true),
        Action::Status => {
            let pending = if data_dir.join("data.db").is_file() {
                let connection = rusqlite::Connection::open_with_flags(
                    data_dir.join("data.db"),
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .map_err(|_| "无法读取队列状态")?;
                connection.query_row("SELECT count(*) FROM events_queue WHERE synced_hash IS NULL OR synced_hash!=payload_hash",[],|r|r.get::<_,i64>(0)).map_err(|_|"无法统计队列")?
            } else {
                0
            };
            println!("Agy Family Monitor {}\n已绑定: {}\n登录启动: {}\n待上传事件: {}\n本地通知: {}\n上游: {}",env!("CARGO_PKG_VERSION"),local.credentials()?.is_some(),windows::autostart::installed(),pending,local.notifications_enabled,agy_usage_core::UPSTREAM_COMMIT);
            Ok(true)
        }
        Action::CheckQuota => {
            let result = quota::poll(local.quota_enabled, local.quota_cli_path.as_deref()).await;
            println!(
                "{}",
                serde_json::json!({"status":result.status,"recognized_buckets":result.samples.len()})
            );
            Ok(result.status == quota::Status::Ok || result.status == quota::Status::Disabled)
        }
        Action::Enroll => {
            let _instance = windows::Instance::acquire(&data_dir)?;
            if local.protected_credentials.is_some() || data_dir.join("data.db").is_file() {
                return Err("此目录已有设备或队列，请使用原绑定或独立目录。");
            }
            if let Some(server) = &options.server {
                local.api_base_url = server.clone();
            }
            let api = uploader::Api::new(&local.api_base_url)?;
            // Verify credential protection before consuming a one-time enrollment code.
            windows::dpapi::protect(b"enrollment-preflight")?;
            print!("一次性绑定码: ");
            std::io::stdout().flush().map_err(|_| "无法显示输入提示")?;
            let mut code = String::new();
            std::io::stdin()
                .read_line(&mut code)
                .map_err(|_| "无法读取绑定码")?;
            let code = code.trim();
            if code.len() < 8 || code.len() > 256 {
                return Err("绑定码格式无效");
            }
            let credentials = api
                .enroll(code, "Windows PC")
                .await
                .map_err(|_| "注册失败，请检查服务器地址、绑定码有效期和网络。")?;
            local.set_credentials(&credentials)?;
            let discovery = options.discovery()?;
            local.extra_roots = discovery
                .extra_roots
                .into_iter()
                .map(|r| config::ExtraRoot {
                    path: r.path,
                    source: r.source,
                })
                .collect();
            local.cc_switch_dir = discovery.cc_switch_dir;
            local.save(&data_dir)?;
            std::fs::write(data_dir.join("agent.marker"), "agy-family-monitor-v1")
                .map_err(|_| "无法保存设备目录标记")?;
            println!("设备已绑定，凭据已由 Windows 保护。运行 --install 开启登录启动。");
            Ok(true)
        }
        Action::Install => {
            if local.credentials()?.is_none() {
                return Err("请先完成 --enroll 设备绑定。");
            }
            windows::autostart::install(&data_dir)?;
            println!("已创建当前用户的登录启动任务和通知应用身份。");
            Ok(true)
        }
        Action::Uninstall => {
            if std::fs::read_to_string(data_dir.join("agent.marker"))
                .ok()
                .as_deref()
                != Some("agy-family-monitor-v1")
            {
                return Err("此目录缺少客户端归属标记，未删除任何文件。");
            }
            windows::autostart::stop()?;
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _instance = windows::Instance::acquire(&data_dir)?;
            windows::autostart::remove()?;
            for name in [
                "config.json",
                "config.json.new",
                "data.db",
                "data.db-shm",
                "data.db-wal",
                "agent.marker",
            ] {
                match std::fs::remove_file(data_dir.join(name)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("部分客户端文件无法删除，请停止后台实例后重试。"),
                }
            }
            println!("登录启动、通知快捷方式、凭据和本地队列已移除；退出后可删除 EXE。");
            Ok(true)
        }
        Action::Background => {
            let credentials = local.credentials()?.ok_or("请先完成设备绑定")?;
            let mut discovery = options.discovery()?;
            local.apply(&mut discovery);
            background::run(&local, &credentials, &discovery, &data_dir).await?;
            Ok(true)
        }
        Action::RunOnce | Action::Reconcile => {
            let mut config = options.discovery()?;
            local.apply(&mut config);
            let scanned = scanner::scan(&config);
            if options.action == Action::Reconcile {
                let path = options.cc_switch_db.unwrap_or_else(|| {
                    config
                        .cc_switch_dir
                        .clone()
                        .unwrap_or_else(|| config.home.join(".cc-switch"))
                        .join("cc-switch.db")
                });
                let report = reconcile::compare(&scanned, &path).map_err(|_| {
                    "无法只读查询 CC Switch 用量表。请确认数据库位置、版本和读取权限。"
                })?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|_| "报告生成失败")?
                );
                Ok(report.accepted)
            } else {
                let summary = scanned.summary()?;
                if options.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).map_err(|_| "报告生成失败")?
                    );
                } else {
                    println!("本地扫描完成\n会话: {}  事件: {}  未知模型: {}\nInput: {}  Output: {}\nCache Read: {}  Cache Write: {}\nTotal: {}\n费用: 本地不计价，云端按价格版本计算\n读取失败: {}  原生库不可用: {}  不完整或损坏行: {}", summary.sessions, summary.events, summary.unknown_model_events, summary.tokens.input_tokens, summary.tokens.output_tokens, summary.tokens.cache_read_tokens, summary.tokens.cache_write_tokens, summary.total_tokens, summary.unreadable_sessions, summary.native_unavailable_sessions, summary.malformed_lines);
                }
                let uploaded = if let Some(credentials) = local.credentials()? {
                    background::once(&local, &credentials, &config, &data_dir).await?
                } else {
                    eprintln!("尚未绑定设备，本轮仅本地读取，没有上传。");
                    true
                };
                Ok(uploaded
                    && scanned.unreadable_sessions == 0
                    && scanned.discovery.rejected_paths == 0)
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    windows::prepare_console(std::env::args().any(|a| a == "--background"));
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(2),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
