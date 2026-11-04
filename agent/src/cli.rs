use agy_usage_core::{
    discovery::{DiscoveryConfig, SessionRoot},
    Source,
};
use std::{ffi::OsString, path::PathBuf};

pub const HELP: &str = "Agy Family Monitor · Windows 客户端

直接双击运行：首次输入管理员提供的绑定码，随后自动开启后台采集。

用法：
  AgyFamilyMonitor.exe --run-once [--json]
  AgyFamilyMonitor.exe --reconcile [--cc-switch-db <文件>]
  AgyFamilyMonitor.exe --status
  AgyFamilyMonitor.exe --check-quota
  AgyFamilyMonitor.exe --enroll
  AgyFamilyMonitor.exe --install
  AgyFamilyMonitor.exe --uninstall
  AgyFamilyMonitor.exe --background

可选：
  --root <brain目录>            增加 CLI 会话根目录，可重复
  --ide-root <brain目录>        增加 IDE 会话根目录，可重复
  --cc-switch-dir <目录>        CC Switch 自定义配置目录
  --home <目录>                 显式主目录，用于隔离测试
  --json                        输出元数据汇总 JSON
  --data-dir <目录>             客户端数据目录，默认 LocalAppData/AgyFamilyMonitor
  --server <HTTPS域名>          绑定时指定服务器，默认 https://agent-token.lupages.com
  --help                        显示本说明
  --licenses                    显示内嵌项目及上游 MIT 许可证

--run-once 未绑定时仅本地读取；绑定后脱敏入队并尝试上传。
--reconcile 只读对比 CC Switch，完全匹配退出 0，不匹配退出 2。
--uninstall 停止登录任务并删除本客户端配置和队列；程序退出后可删除 EXE。";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Launch,
    Help,
    Licenses,
    Status,
    CheckQuota,
    RunOnce,
    Reconcile,
    Enroll,
    Install,
    Uninstall,
    Background,
}

pub struct Options {
    pub action: Action,
    pub json: bool,
    pub cc_switch_db: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub server: Option<String>,
    home: Option<PathBuf>,
    cc_switch_dir: Option<PathBuf>,
    extra: Vec<SessionRoot>,
}

impl Options {
    pub fn parse(args: impl Iterator<Item = OsString>) -> Result<Self, &'static str> {
        let mut options = Self {
            action: Action::Launch,
            json: false,
            cc_switch_db: None,
            data_dir: None,
            server: None,
            home: None,
            cc_switch_dir: None,
            extra: vec![],
        };
        let mut action_set = false;
        let mut args = args;
        while let Some(arg) = args.next() {
            let text = arg
                .to_str()
                .ok_or("参数名称必须是有效文本；路径可以包含中文。")?;
            let action = match text {
                "--help" | "-h" => Some(Action::Help),
                "--licenses" => Some(Action::Licenses),
                "--status" => Some(Action::Status),
                "--check-quota" => Some(Action::CheckQuota),
                "--run-once" => Some(Action::RunOnce),
                "--reconcile" => Some(Action::Reconcile),
                "--enroll" => Some(Action::Enroll),
                "--install" => Some(Action::Install),
                "--uninstall" => Some(Action::Uninstall),
                "--background" => Some(Action::Background),
                _ => None,
            };
            if let Some(action) = action {
                if action_set {
                    return Err("每次只能选择一个操作。使用 --help 查看用法。");
                }
                options.action = action;
                action_set = true;
                continue;
            }
            match text {
                "--json" => options.json = true,
                "--root" | "--ide-root" | "--home" | "--cc-switch-dir" | "--cc-switch-db"
                | "--data-dir" => {
                    let value = args
                        .next()
                        .filter(|v| !v.is_empty() && !v.to_string_lossy().starts_with("--"))
                        .map(PathBuf::from)
                        .ok_or("路径参数缺少值。")
                        .and_then(|v| {
                            if v.is_dir() || matches!(text, "--cc-switch-db" | "--data-dir") {
                                Ok(v)
                            } else {
                                Err("指定目录不存在或无法读取。")
                            }
                        })?;
                    match text {
                        "--home" => options.home = Some(value),
                        "--cc-switch-dir" => options.cc_switch_dir = Some(value),
                        "--cc-switch-db" => options.cc_switch_db = Some(value),
                        "--data-dir" => options.data_dir = Some(value),
                        _ => options.extra.push(SessionRoot {
                            path: value,
                            source: if text == "--ide-root" {
                                Source::Ide
                            } else {
                                Source::Cli
                            },
                        }),
                    }
                }
                "--server" => {
                    options.server = Some(
                        args.next()
                            .and_then(|v| v.into_string().ok())
                            .filter(|v| !v.starts_with("--"))
                            .ok_or("服务器参数缺少值")?,
                    )
                }
                _ => return Err("未知参数。使用 --help 查看用法。"),
            }
        }
        Ok(options)
    }

    pub fn has_explicit_home(&self) -> bool {
        self.home.is_some()
    }
    pub fn discovery(&self) -> Result<DiscoveryConfig, &'static str> {
        let mut config = if let Some(home) = &self.home {
            DiscoveryConfig {
                home: home.clone(),
                cc_switch_dir: None,
                extra_roots: vec![],
            }
        } else {
            DiscoveryConfig::for_current_user()
                .map_err(|_| "无法定位用户主目录，请指定 --home。")?
        };
        config.cc_switch_dir = self.cc_switch_dir.clone();
        config.extra_roots = self.extra.clone();
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> impl Iterator<Item = OsString> {
        values
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
            .into_iter()
    }
    #[test]
    fn rejects_conflicting_or_incomplete_commands() {
        assert!(Options::parse(args(&["--run-once", "--status"])).is_err());
        assert!(Options::parse(args(&["--root"])).is_err());
        assert!(Options::parse(args(&["--root", "--status"])).is_err());
    }
    #[test]
    fn accepts_explicit_actions_and_never_reads_secrets_from_command_arguments() {
        assert_eq!(Options::parse(args(&[])).unwrap().action, Action::Launch);
        assert_eq!(
            Options::parse(args(&["--background"])).unwrap().action,
            Action::Background
        );
        assert!(Options::parse(args(&["--token", "secret"])).is_err());
        assert!(Options::parse(args(&["--server"])).is_err());
    }
}
