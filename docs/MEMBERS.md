# 成员与采集控制 / Members and collection

## 管理员

1. 网站 → 设置 → 家庭成员 → 新增普通成员，填写本人姓名和登录邮箱。
2. 在设备绑定处选择该成员，生成其专属绑定码；15 分钟有效，只可用一次。
3. 将同一份 AgyFamilyMonitor.exe 和该成员的绑定码发给对方。
4. 在“采集频率与开关”调整全组采集间隔，或暂停/恢复自动采集。

绑定下拉框显示实际账号：初始只有管理员，新增普通成员后会自动选中该成员。
切换成员会清除上一个绑定码的显示，避免发错人。每台电脑单独绑定。

默认每 5 分钟读取本机新用量，可设 1–60 分钟。网站设置约一分钟内同步到在线客户端；
正在执行的一轮会完成。暂停后仍有每分钟轻量心跳，显示在线状态并接收新设置，已入队数据继续补传。
文件变化不会绕过管理员的采集间隔。

“全员手动采集一次”和设备旁的“手动采集一次”在暂停时也可用。
同一设备只保留一条待执行指令；离线保留 15 分钟，过期后需重试。
完成后显示回执，重连不会重复执行已完成的指令。0.2.x 客户端须升级后才能接收控制。

采集设置变化会重建对账起点。异常监控等待至少两轮采集；暂停期间不因无新用量发异常邮件。
间隔越长，统计和额度校准越晚更新。

## 普通成员

双击 EXE，按提示输入管理员给的绑定码。程序保存加密凭据、设置当前用户登录启动并开始后台运行。
不需要命令行或管理员权限。输入为空可取消，未绑定前不会开始后台上传。

网站使用添加的邮箱验证身份。可查看全组总览、成员用量/在线状态、模型分析、明细、只读预警规则与预警记录，
并可在“家庭成员”或“预警中心”直接下载 Windows 客户端、独立标记自己的预警已读、开关个人预警通知偏好。
普通成员没有设置页，也不能通过接口改成员资料、绑定设备、调采集、价格、邮件或新增/删除预警规则。
内部配置和其他成员邮箱不返回普通成员。网站访问需通过部署方的 Access 策略与活动成员校验。

## English

The administrator creates named member accounts in Settings, can update member display names and emails,
soft-deactivate/reactivate members (freeing the 6-active-member cap while preserving historical usage),
and generates a separate one-time code for each computer.
Send the same EXE to each member. Double-click it, enter the assigned code, and the collector installs
for the current Windows user and starts in the background. No elevated permissions are required.

Members can view family usage, presence, models, records, read-only alert rules, and alerts, download the
Windows client, acknowledge their own alerts, and toggle their personal notification preference. Only the
administrator can access settings or change members, enrollment, collection, prices, mail and rules.

Collection defaults to every five minutes and is adjustable from 1 to 60 minutes on the website.
Pause/resume automatic collection, or request one capture for all supported clients or one device.
Paused clients retain a light 60-second heartbeat and continue uploading already queued events.
Settings and manual requests normally reach online clients within about one minute. Offline requests
expire after 15 minutes; completed requests are not replayed after restart. Upgrade all clients to 0.4.0.

Anomaly monitoring waits at least two collection cycles. Pausing or changing cadence resets comparison
baselines, so intentionally paused collection does not produce missing-usage alerts.
