# D1 migrations

0001_initial.sql 创建成员、设备、队列事件、计价、预警及相关索引。
0002_reference_prices.sql 保存固定 CC Switch SHA 来源的三条初始模型价格。
0003_monitoring.sql 增加六人共享额度、在线状态、校准样本和邮件重试队列。
0004_official_prices.sql 增加 2026-11-04 核验的官方价格及已公布的未来价格。
0005_collection_control.sql 增加全组采集策略、手动指令、幂等回执和离线过期。
按顺序应用迁移到独立 D1；管理员由 scripts/bootstrap.ps1 显式初始化。
后续结构变更新增迁移，不修改已应用的文件。

