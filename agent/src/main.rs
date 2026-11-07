#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod background;
mod cli;
mod collection;
mod config;
mod notifier;
mod queue;
mod quota;
mod reconcile;
mod scanner;
mod tracker;
mod uploader;
mod windows;

use cli::{Action, Options};
use std::{io::Write, process::ExitCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunningChoice {
    KeepRunning,
    EnableAutostart,
    DisableAutostart,
    StopOnly,
    Uninstall,
}

fn parse_running_choice(input: &str) -> Result<RunningChoice, &'static str> {
    match input.trim() {
        "" | "0" => Ok(RunningChoice::KeepRunning),
        "1" => Ok(RunningChoice::EnableAutostart),
        "2" => Ok(RunningChoice::DisableAutostart),
        "3" => Ok(RunningChoice::StopOnly),
        "4" => Ok(RunningChoice::Uninstall),
        _ => Err("无效选项，请输入 1、2、3、4 或直接按 Enter 退出。"),
    }
}

fn launch_collector(data_dir: &std::path::Path) -> Result<bool, &'static str> {
    windows::autostart::install(data_dir)?;
    windows::autostart::start(data_dir)?;
    println!(
        "后台采集已开启，下次登录会自动启动。\n你可以关闭此窗口，在家庭网站查看在线状态和用量。"
    );
    Ok(true)
}

async fn uninstall_client(data_dir: &std::path::Path) -> Result<bool, &'static str> {
    if std::fs::read_to_string(data_dir.join("agent.marker"))
        .ok()
        .as_deref()
        != Some("agy-family-monitor-v1")
    {
        return Err("此目录缺少客户端归属标记，未删除任何文件。");
    }
    windows::autostart::stop()?;
    let mut instance = None;
    for _ in 0..25 {
        if let Ok(guard) = windows::Instance::acquire(data_dir) {
            instance = Some(guard);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let _instance = match instance {
        Some(guard) => guard,
        None => windows::Instance::acquire(data_dir)?,
    };
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
    let _ = std::fs::remove_file(data_dir.join("AgyFamilyMonitor.exe"));
    println!("登录启动、通知快捷方式、凭据和本地队列已移除；退出后可删除 EXE。");
    Ok(true)
}

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
        Action::Enroll | Action::Launch => {
            if options.action == Action::Launch
                && local.credentials()?.is_some()
                && windows::autostart::needs_update(&data_dir)
            {
                windows::autostart::stop()?;
                for _ in 0..25 {
                    if windows::Instance::acquire(&data_dir).is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                return launch_collector(&data_dir);
            }
            let instance = match windows::Instance::acquire(&data_dir) {
                Ok(instance) => instance,
                Err(message)
                    if options.action == Action::Launch
                        && message.starts_with("此客户端已在运行") =>
                {
                    let autostart_status = if windows::autostart::installed() {
                        "已开启"
                    } else {
                        "已关闭"
                    };
                    println!(
                        "客户端已在后台采集运行中（当前开机登录自启：{autostart_status}）。\n请选择操作（直接按 Enter 保持现状并退出）：\n  [1] 开启开机登录自启\n  [2] 关闭开机登录自启（保持当前后台运行）\n  [3] 关闭软件（仅停止本次后台采集，保留绑定配置）\n  [4] 关闭软件并彻底卸载（移除开机自启、绑定凭据与本地队列）"
                    );
                    print!("请输入选项 [1-4，默认 Enter 退出]: ");
                    std::io::stdout().flush().map_err(|_| "无法显示输入提示")?;
                    let mut choice = String::new();
                    std::io::stdin()
                        .read_line(&mut choice)
                        .map_err(|_| "无法读取选项输入")?;
                    match parse_running_choice(&choice)? {
                        RunningChoice::KeepRunning => {
                            println!("保持后台采集运行，未做更改。");
                            return Ok(true);
                        }
                        RunningChoice::EnableAutostart => {
                            windows::autostart::install(&data_dir)?;
                            let stopped = windows::Instance::acquire(&data_dir).map(drop).is_ok();
                            if stopped {
                                windows::autostart::start(&data_dir)?;
                            }
                            println!("已开启开机登录自启，后台采集继续运行。");
                            return Ok(true);
                        }
                        RunningChoice::DisableAutostart => {
                            windows::autostart::disable_task()?;
                            let stopped = windows::Instance::acquire(&data_dir).map(drop).is_ok();
                            if stopped {
                                windows::autostart::start(&data_dir)?;
                            }
                            println!("已关闭开机登录自启，当前后台采集继续运行。");
                            return Ok(true);
                        }
                        RunningChoice::StopOnly => {
                            windows::autostart::stop()?;
                            println!("已关闭后台采集进程。下次可重新双击本程序开启。");
                            return Ok(true);
                        }
                        RunningChoice::Uninstall => {
                            return uninstall_client(&data_dir).await;
                        }
                    }
                }
                Err(message) => return Err(message),
            };
            if options.action == Action::Launch && local.credentials()?.is_some() {
                drop(instance);
                return launch_collector(&data_dir);
            }
            if local.protected_credentials.is_some() || data_dir.join("data.db").is_file() {
                return Err("此目录已有设备或队列，请使用原绑定或独立目录。");
            }
            if let Some(server) = &options.server {
                local.api_base_url = server.clone();
            }
            let api = uploader::Api::new(&local.api_base_url)?;
            // Verify credential protection before consuming a one-time enrollment code.
            windows::dpapi::protect(b"enrollment-preflight")?;
            if options.action == Action::Launch {
                println!("欢迎使用 Agy Family Monitor\n请向家庭管理员取得你的专属绑定码。\n仅采集用量元数据，不上传对话、提示词或 Google 凭据。\n输入绑定码后按 Enter，即绑定这台电脑并开启后台采集；直接按 Enter 取消。");
            }
            print!("一次性绑定码: ");
            std::io::stdout().flush().map_err(|_| "无法显示输入提示")?;
            let mut code = String::new();
            std::io::stdin()
                .read_line(&mut code)
                .map_err(|_| "无法读取绑定码")?;
            let code = code.trim();
            if code.is_empty() && options.action == Action::Launch {
                println!("已取消，没有绑定设备或开启采集。");
                return Ok(true);
            }
            if code.len() < 8 || code.len() > 256 {
                return Err("绑定码格式无效");
            }
            let credentials = api
                .enroll(code, "Windows PC")
                .await
                .map_err(|_| "注册失败，请检查服务器地址、绑定码有效期和网络。")?;
            local.set_credentials(&credentials)?;
            let discovery = options.discovery()?;
            local.discovery_home = Some(discovery.home.clone());
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
            if options.action == Action::Launch {
                drop(instance);
                launch_collector(&data_dir)
            } else {
                println!("设备已绑定，凭据已由 Windows 保护。运行 --install 开启登录启动。");
                Ok(true)
            }
        }
        Action::Install => {
            if local.credentials()?.is_none() {
                return Err("请先完成 --enroll 设备绑定。");
            }
            let was_running = windows::Instance::acquire(&data_dir).is_err();
            if was_running && windows::autostart::needs_update(&data_dir) {
                windows::autostart::stop()?;
                for _ in 0..25 {
                    if windows::Instance::acquire(&data_dir).is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
            windows::autostart::install(&data_dir)?;
            if was_running {
                windows::autostart::start(&data_dir)?;
            }
            println!("已创建当前用户的登录启动任务和通知应用身份。");
            Ok(true)
        }
        Action::Uninstall => uninstall_client(&data_dir).await,
        Action::Background => {
            let credentials = local.credentials()?.ok_or("请先完成设备绑定")?;
            let mut discovery = options.discovery()?;
            local.apply(&mut discovery, options.has_explicit_home());
            background::run(&local, &credentials, &discovery, &data_dir).await?;
            Ok(true)
        }
        Action::RunOnce | Action::Reconcile => {
            let mut config = options.discovery()?;
            local.apply(&mut config, options.has_explicit_home());
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
    let opened_console = windows::prepare_console(std::env::args().any(|a| a == "--background"));
    let result = match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(2),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    };
    if opened_console {
        println!("\n按 Enter 关闭此窗口。");
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_choice_accepts_menu_options_and_rejects_invalid_input() {
        assert_eq!(parse_running_choice(""), Ok(RunningChoice::KeepRunning));
        assert_eq!(
            parse_running_choice(" \r\n "),
            Ok(RunningChoice::KeepRunning)
        );
        assert_eq!(parse_running_choice("0"), Ok(RunningChoice::KeepRunning));
        assert_eq!(
            parse_running_choice(" 1\n"),
            Ok(RunningChoice::EnableAutostart)
        );
        assert_eq!(
            parse_running_choice("2"),
            Ok(RunningChoice::DisableAutostart)
        );
        assert_eq!(parse_running_choice("3"), Ok(RunningChoice::StopOnly));
        assert_eq!(parse_running_choice("4"), Ok(RunningChoice::Uninstall));
        assert!(parse_running_choice("5").is_err());
        assert!(parse_running_choice("abc").is_err());
    }
}
