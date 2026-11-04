# Windows 客户端安装与使用（0.3.0）

支持 Windows 10/11 x64，只需 AgyFamilyMonitor.exe。网站：<https://token.lupages.com>。
两台 Windows 和连续 72 小时实机验收仍待完成。

## 首次绑定

1. 管理员在网站“设置 → 家庭成员”新增普通成员，填写其姓名和登录邮箱。
2. 在设备绑定处选择该成员，生成绑定码，将同一份 EXE 与该成员的专属绑定码发给对方。
3. 成员双击 EXE，按提示输入绑定码。程序保存加密凭据、设置当前用户登录启动并开始后台运行。

无需命令行或管理员权限。绑定码 15 分钟有效、一次使用，每台电脑单独绑定。
输入为空可取消，未绑定前不会开始后台上传。已绑定时双击会启动后台，同目录避免重复运行。
成员在网站只能查看；采集开关、频率、成员、设备、价格、邮件与预警设置仅管理员可见。
网站还需符合部署方的 Access 登录策略。权限和采集控制见 [MEMBERS.md](MEMBERS.md)。

默认连接 https://agent-token.lupages.com。自行部署可使用：

```powershell
.\AgyFamilyMonitor.exe --enroll --server https://agent-monitor.example.com
.\AgyFamilyMonitor.exe --install
.\AgyFamilyMonitor.exe --background
```

凭据使用当前 Windows 用户的 DPAPI 加密。程序当前未做商业代码签名；保留随附许可与第三方说明。

## 采集频率、暂停与手动采集

默认每 5 分钟读取本机用量；管理员在网站可设 1–60 分钟，暂停/恢复自动采集，
或对全员/单台设备下发一次采集。在线客户端约一分钟内同步设置并执行手动指令，正在进行的一轮会完成。
离线指令保留 15 分钟；同设备不重复排队，重启不重做已完成指令。

暂停后不再定时读取新用量，仍保留 60 秒轻量心跳、通知查询及已采集数据补传。
文件变化不会绕过管理员间隔。官方额度随采集查询，自动查询至少间隔 5 分钟。
设置变更重建对账起点，暂停不因无新用量发异常邮件；恢复后等待至少两轮采集。

## 状态与本地对账

```powershell
.\AgyFamilyMonitor.exe --status
.\AgyFamilyMonitor.exe --run-once
.\AgyFamilyMonitor.exe --reconcile
.\AgyFamilyMonitor.exe --licenses
.\AgyFamilyMonitor.exe --check-quota
```

未绑定的 --run-once 只本地统计；绑定后是显式手动读取并上传，因此请先确认采集范围。
--reconcile 只读对比 CC Switch，accepted=true 且退出 0 才全量匹配；可加 --json。
先刷新 CC Switch Usage 并暂停新会话；文件仍有变化时刷新两端重跑。报告只含计数，不含原始会话或对话。

自动发现 CLI、IDE 和 CC Switch 独立配置目录，缺失目录跳过。
额外目录可使用 --root / --ide-root，可重复；另有 --cc-switch-dir / --cc-switch-db。
--home 可指定隔离主目录；首次绑定会保留该范围，后台重启继续使用，路径不会上传。

## 本地配置

默认数据目录 %LOCALAPPDATA%/AgyFamilyMonitor，含配置、DPAPI 凭据、脱敏 SQLite 队列、程序与日志。
--data-dir 可隔离测试；保持每次相同，不要复制或共用其他设备的队列。
停止客户端后可修改 config.json，保留 protected_credentials 原值。
支持 extra_roots、cc_switch_dir、notifications_enabled、quota_enabled 和 quota_cli_path。

至少一台电脑安装并登录官方 Antigravity CLI 才能读取官方额度。找不到时可设置 quota_cli_path 的绝对路径。
其他电脑可关闭 quota_enabled，不影响 Token 统计。程序不读取 Google 凭据，只保留额度比例和时间。
没有 CLI 时 Token 统计照常可用，真实额度校准等待读数。

网络失败保留队列，30 秒起指数退避，最长 30 分钟；401/403 停止采集上传，等待重新绑定。
Step 修正使用同一 event_id，云端更新原行。通知受本地、管理员偏好及 Windows 系统设置影响。

## 升级与卸载

升级先停止旧任务，再安装新 EXE；保留原凭据和队列，不要先卸载：

```powershell
schtasks.exe /End /TN AgyFamilyMonitor
.\AgyFamilyMonitor.exe --install
.\AgyFamilyMonitor.exe --background
```

卸载运行 `.\AgyFamilyMonitor.exe --uninstall`，只处理带本客户端归属标记的目录，
移除登录任务、快捷方式、配置和队列。管理员可撤销设备，云端统计历史保留。

每份会话只由一台设备采集；跨电脑复制日志无法跨设备去重。
不上传对话、提示词、Google Token、路径或原始 Session ID；费用是 API 等效估算，未知价格为待计价。
