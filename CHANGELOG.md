# Changelog / 更新记录

## 0.4.0 — 2026-11-07

- Complete member management lifecycle: update member email and display name, soft-deactivate/reactivate members (freeing the 6-active-member cap while revoking active devices, expiring unused enrollment codes and pending collection requests, and retaining historical usage).
- Ordinary member experience: independent per-member alert read acknowledgment (`POST /alerts/:id/ack`), personal notification preference toggle (`PUT /preferences`), read-only alert rules view (`GET /rules`), and direct Windows client download entry.
- Alert rule lifecycle: inline rule editing and permanent deletion (`DELETE /rules/:id` and omission cleanup in `PUT /rules`).
- Reconciliation and alert auto-recovery: `POST /reprice` clears resolved `pricing_incomplete` alerts, `o3` model family backfill reconciliation, and automatic stale condition/alert/email cleanup when resetting or disabling monitor settings.
- Dynamic model display name mapping across usage and model views, smooth in-place Windows client binary upgrade, and removal of unused `watcher.rs` / `notify` dependency.

支持成员修改邮箱与软停用/重新启用（释放 6 人活跃名额并保留历史统计）、普通成员独立标记预警已读与开关个人通知、只读查看预警规则与下载客户端；支持预警规则编辑与删除、补算价格自动解除待计价告警、客户端平滑覆盖升级。

## 0.3.0 — 2026-11-04

- Administrator-only settings; ordinary members have a strictly read-only family dashboard.
- Add named members in the website and automatically select them for device enrollment.
- Double-click enrollment installs and starts the Windows collector for the current user.
- Website collection controls: five-minute default, 1–60 minute cadence, pause/resume and one-shot capture.
- Durable per-device commands, idempotent acknowledgments and 15-minute offline expiration.
- Pauses retain presence and queued uploads; anomaly baselines and grace periods follow collection settings.

管理员自行添加普通成员、成员网站只读、EXE 双击绑定启动；网页调频、启停与手动采集。
暂停仍可看在线，采集间隔与异常监控等待时间联动。

## 0.2.0 — 2026-11-04

- Six members, including the administrator, share one pool; local usage is aggregated once.
- Presence, official CLI quota readings, four-bucket calibration and sustained anomaly alerts.
- Cloudflare email with a fixed sender/verified destination, leases, digests and durable retries.
- Official Argon, Opus 5.5, Sonnet 5.5, Flash 3.8 and other model prices, with scheduled effective dates.
- Bilingual README, synthetic preview assets, deployment template and contribution documentation.
- Local validation: 53 Rust, 33 Worker and 5 web tests. Real multi-device acceptance remains pending.

六人共享额度、在线状态、额度校准、异常邮件与版本化价格。公开源码包含中英文 README、
合成截图及部署模板，真实数据和部署配置不公开。

## 0.1.0 — 2026-11-04

- Rust parser and Windows collector with DPAPI-protected credentials and an offline queue.
- Workers/D1 API, Access authorization, integer pricing and threshold alerts.
- Six-page Vue dashboard, Windows notifications, enrollment/revocation and backup tools.
- Real local CC Switch reconciliation passed; multi-PC and continuous family acceptance remained pending.
