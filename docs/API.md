# API

JSON 请求与响应；错误为 `{ "error": "稳定错误代码" }`，不输出内部堆栈。
GET /api/health 公开。请求体上限 512 KiB，业务响应禁止缓存。

## 设备接口

基址 https://agent-token.lupages.com/api/v1/agent。
除一次性绑定外均验证 Bearer device_token 的 SHA-256，成员从设备认证取得，不能由请求指定。
无效/撤销凭据返回 401/403。

| 方法和路径 | 用途 |
| --- | --- |
| POST /enroll | {code,device_label,platform,agent_version}，兑换设备凭据 |
| POST /events | {batch_id,agent_version,events}，每批 1–100 条，返回 inserted/updated/unchanged |
| POST /heartbeat | {agent_version,pending_events,notifications_enabled} |
| GET /alerts?after=… | 稳定游标，最多 100 条，包含远程通知偏好 |
| POST /alerts/ack | {notification_ids:[…]}，幂等确认 |

绑定码、device_token、pseudonym_key 均为 32 字节随机值的 64 位十六进制编码。
绑定码 15 分钟有效、一次使用，同一 IP 每分钟最多五次绑定尝试。
服务器只保留 Token 和绑定码哈希。

事件白名单：

```json
{
  "event_id": "64位十六进制HMAC",
  "session_key": "64位十六进制HMAC",
  "step_index": 0,
  "model_display": "Gemini 3.8 Flash (High)",
  "model_id": "gemini-3.8-flash-high",
  "occurred_at_ms": 1793700000000,
  "tokens": {"input": 100, "output": 50, "cache_read": 20, "cache_write": 10},
  "source": "antigravity_cli"
}
```

嵌套 tokens 也拒绝额外字段。source 只允许 antigravity_cli/antigravity_ide。
每类 Token 为 0–10^12 的安全整数；时间不能超前五分钟。总量为四类之和，reasoning 不重复计入。
中央计价，不接受客户端费用。以 (device_id,event_id) 唯一，修正更新原行，并发重试不多记。

成功回执 inserted+updated+unchanged 必须覆盖整批，客户端才确认队列。
失败、HTML、重定向、不完整回执均保留队列。batch_id 是有效载荷哈希。
通知游标编码 (created_at_ms,id)，非法游标返回 400；ACK 成功后才推进游标。

HMAC-SHA256：Session 输入 `agy-session-v1\0` + 原始 Session ID。
Event 输入 `agy-event-v1\0` + Session ID 字节长度（大端 u64）+ Session ID 字节 + Step（大端 u64）。
密钥按设备独立，队列和云端不保留原始 ID。

## 网站接口

基址 /api/v1/dashboard。验证 Access JWT 签名、issuer、audience、时效、身份字段和 D1 active 成员。
邮箱请求头不构成身份。变更接口拒绝跨站 Origin/Sec-Fetch-Site。

| 方法和路径 | 权限与用途 |
| --- | --- |
| GET /me | 当前成员 |
| GET /summary | 今日/本周/本月汇总及时区 |
| GET /members | 全体成员和周期汇总；普通成员不返回邮箱与通知偏好 |
| GET /usage | 明细筛选与分页 |
| GET /models | 模型和成员汇总 |
| GET /trends | 家庭时区每日趋势 |
| GET /alerts | 全组预警与当前成员已读状态 |
| POST /alerts/:id/ack | 仅管理员标记已读 |
| GET /rules | 仅管理员查看规则列表 |
| PUT /rules | 管理员保存，最多 50 条 |
| GET /settings | 仅管理员；时区、价格、通知、全部设备与采集控制 |
| PUT /settings | 管理员修改有效 IANA 时区 |
| PUT /preferences | 仅管理员修改自己的 notifications_enabled |
| POST /members | 管理员添加成员，活动成员最多六名 |
| PATCH /members/:id | 管理员修改显示名称 |
| POST /enrollments | 管理员为指定成员创建绑定码 |
| DELETE /devices/:id | 管理员撤销设备，保留历史 |
| POST /prices | 管理员新增不可变价格版本 |
| POST /reprice | 管理员补算待计价历史，每页 100 条并返回游标 |

日期 from_date/to_date 使用 YYYY-MM-DD，含首尾；可加 member_id/model_id/source。
明细 page/page_size 分页。家庭日期转换 UTC 边界，持久时间为 UTC 毫秒。
价格为每百万 Token 的整数微美元；费用为整数微美元，四类乘积求和后四舍五入。
事件保留 price_id，无价格时 pricing_status=unpriced、cost_micro_usd=NULL。
无事件时费用为 0；部分未计价时单列 unpriced_tokens，不把未知费用显示为免费。


## 0.2.0 扩展

成员上限改为六人；members 响应包含 online、device_count。心跳可附 collector 采集健康状态、quota_status 和最多四个 quota 桶，只允许 bucket_id、remaining_ppm、reset_at_ms、observed_at_ms。旧心跳仍兼容。
GET /monitor 仅管理员查看共享额度配置与状态；普通成员使用脱敏的 GET /monitor/overview；PUT /monitor/settings、POST /monitor/reset-calibration、POST /monitor/test-email、POST /monitor/retry-email 仅管理员可调用。邮箱配置只返回管理员。详情见 MONITORING.md。


## 0.3.0：只读成员与采集控制

普通成员只允许 GET/HEAD `/me`、`/summary`、`/members`、`/usage`、`/models`、`/trends`、
`/alerts`、`/monitor/overview`，其他网站接口或所有写操作均 403 `read_only_member`。
概览只含 ready、collection_active、expected_members、bound_members、total_members、online_members、alerts。

| 方法和路径 | 仅管理员 |
| --- | --- |
| GET /collection | 全组采集策略、设备生效策略、采集时间、在线及最近指令状态 |
| PUT /collection/settings | `{enabled:boolean,interval_seconds:integer}`，60–3600 秒，默认 true/300 |
| POST /collection/run | `{}` 全员，或 `{device_id:string}` 单设备，202；无可用新版设备 409 |

心跳响应增加 `collection:{enabled,interval_seconds}` 和 `collection_request:{id,requested_at_ms}|null`。
客户端心跳可附 `collector.collection_enabled`、`collector.collection_interval_seconds` 及
`collection_ack:{request_id:UUID,status:"completed"|"failed"}`。回执只更新认证设备自己的未过期指令。
旧客户端忽略新字段；手动指令仅发给 0.3.0+，单设备一条待执行，15 分钟过期。
暂停不阻止既有事件补传。改配置重建对账基线、跳过待评估窗口、解除旧条件并取消未发送的异常邮件。
