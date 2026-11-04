# Windows 客户端安装与使用

支持 Windows 10/11 x64，运行只需要 AgyFamilyMonitor.exe。网站：<https://token.lupages.com>。
已实现全部业务流程；两台 Windows 和连续 72 小时实机验收仍待完成。

## 首次绑定

1. 用被允许的成员邮箱登录网站，管理员在设置中添加成员，再生成绑定码。
2. 管理员同时把新成员邮箱加入 Cloudflare Access 的 Agy Family Members 允许策略。
3. 下载 EXE，在 PowerShell 进入其所在目录，执行命令并按提示输入绑定码。

```powershell
.\AgyFamilyMonitor.exe --enroll
.\AgyFamilyMonitor.exe --install
.\AgyFamilyMonitor.exe --background
```

绑定码 15 分钟有效、一次使用。默认连接 https://agent-token.lupages.com。
其他自托管服务可加 --server https://你的Agent域名。凭据用当前用户 DPAPI 加密，每台电脑单独绑定。
--install 复制程序到当前用户数据目录，建立通知快捷方式和登录任务，无需管理员权限。
下次登录自动启动；--background 可立即启动，同一数据目录只运行一份。
当前 EXE 未做商业代码签名；随附许可证和第三方说明应保留。

## 状态和本地对账

```powershell
.\AgyFamilyMonitor.exe --status
.\AgyFamilyMonitor.exe --run-once
.\AgyFamilyMonitor.exe --reconcile
.\AgyFamilyMonitor.exe --licenses
```

未绑定的 --run-once 只本地统计，不上传；绑定后会入队并上传，因此绑定前应确认这台电脑的采集范围。
本地汇总可加 --json。--reconcile 只读对比 CC Switch，accepted=true 且退出 0 才是全量匹配。
先刷新 CC Switch Usage 并暂停新会话；仍有文件变化时刷新两端重跑，不忽略差异。
对账只输出计数，不含原始 Session ID 或对话。

自动发现 CLI、IDE 和 CC Switch 独立配置目录，缺失目录跳过。
额外 brain 目录用 --root <目录> / --ide-root <目录>，允许重复。
可选 --cc-switch-dir <目录>、--cc-switch-db <文件>、--home <隔离测试主目录>。

## 配置与通知

默认数据目录 %LOCALAPPDATA%/AgyFamilyMonitor，含配置、加密凭据、SQLite 元数据队列、程序及日志。
--data-dir <目录> 可隔离测试，每次需保持一致；不要复制或共用其他设备的队列。

关闭程序后可编辑 config.json，保留 protected_credentials 原值：

```json
{
  "api_base_url": "https://agent-token.lupages.com",
  "protected_credentials": "保留程序生成的原值",
  "extra_roots": [
    {"path": "D:/custom-antigravity/brain", "source": "antigravity_ide"}
  ],
  "cc_switch_dir": null,
  "notifications_enabled": true
}
```

通知同时受本地配置、网站个人偏好和 Windows 系统设置影响；关闭弹窗不删除站内预警。
文件变化触发扫描，每 60 秒补扫；每 15 秒合批上传、每分钟心跳、60 秒查预警。
网络失败保留队列，30 秒起指数退避，最长 30 分钟。401/403 暂停上传等待重新绑定。
Step 修正使用同一 event_id，云端更新原行。

## 卸载

```powershell
.\AgyFamilyMonitor.exe --uninstall
```

移除本客户端登录任务、通知快捷方式、配置和队列，仅处理有本客户端归属标记的目录。
退出后可手动删除下载的 EXE；管理员在网站撤销设备，统计历史保留。
每份会话应只由一台设备采集，跨电脑复制日志无法自动跨设备去重。
不上传对话、提示词、Google Token、路径、原始 Session ID。费用是 API 等效估算，未知价格显示待计价。


## 0.2.0 共享额度功能

目标为管理员加五名成员，共六人。请全员升级到 0.2.0，并在至少一台电脑安装、登录官方 Antigravity CLI。配置新增 quota_enabled（默认 true）和 quota_cli_path（默认自动发现）。升级不要卸载现有数据，具体步骤见 MONITORING.md。心跳已改为每分钟。

