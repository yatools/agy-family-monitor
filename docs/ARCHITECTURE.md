# Architecture

依赖方向：`agent → agy-usage-core`；核心库不依赖 Agent、Tauri、网络或 UI。

P1 数据流：动态发现根目录 → 找到 transcript → 有序 Step 去重 → 四类 Token →
显式模型 / 历史设置 / 原生库恢复 / unknown → 仅本地聚合与验证。

P2/P3 数据流：白名单结构 + 设备专属 HMAC → 本地 SQLite 队列 → HTTPS 批量上传 →
设备 Token 验证 → 按认证结果绑定成员 → D1 UPSERT → 整数费用计算 → 预警。

P4：Dashboard 域名接入 Access，Worker 验证签名、issuer、audience、expiry 与成员身份；
Agent 域名用独立 Bearer Token。两者路由同一 Worker，Agent 不经过 Access 交互登录。

数据库统一 UTC 毫秒；自然日/周/月按家庭组时区（默认 Asia/Shanghai）。未知模型保留
Token，未知价格保留 NULL。每次价格变更保留版本和生效时间。

同一设备、多个根目录按原始 Session ID 去重，第一份可读 transcript 优先。跨设备复制的
会话使用不同设备密钥，不能自动跨设备去重；P2 必须明确每份会话只有一个采集设备。

