# Changelog / 更新记录

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
