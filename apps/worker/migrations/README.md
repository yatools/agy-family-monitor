# D1 migrations

0001_initial.sql 创建成员、设备、队列事件、计价、预警及相关索引。
0002_reference_prices.sql 保存固定 CC Switch SHA 来源的三条初始模型价格。
0003_monitoring.sql 增加六人共享额度、在线状态、校准样本和邮件重试队列。
0004_official_prices.sql 增加 2026-11-04 核验的官方价格及已公布的未来价格。
迁移已应用到本项目独立 D1；管理员由 scripts/bootstrap.ps1 显式初始化。
后续结构变更新增迁移，不修改已应用的文件。

