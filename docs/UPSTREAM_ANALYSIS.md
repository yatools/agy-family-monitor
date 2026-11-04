# 固定上游分析

仓库：https://github.com/farion1231/cc-switch

Commit：`51fce968bca807aeee93be9420c651afb582c2c8`。许可证 MIT，完整文本已保存。
来源文件与本机 checkout 的 SHA-256 在 upstream-lock.json 中；代码中的版权头与第三方说明保留。

## 保留的行为

- `records()`：逐行 JSON，BTreeMap 按 step_index 排序，最后一条有效记录覆盖旧值。
- 只统计 PLANNER_RESPONSE / DONE，四类 Token 均为顶层数值字段。
- `reasoning_tokens` 不另加；input 不再减缓存。缺失、负数或超 i64 范围的单个计数按上游归零并诊断。
- 模型优先显式 model，再按有序历史设置继承，再查原生生成元数据，最后 unknown。
- `model_id_of()` 保持已有 ID，显示名转小写、去括号、以连字符连接。
- CLI 与 IDE/private profile 共用 Session 时，优先第一份可读 transcript，避免重复统计。
- 原生库临时不可读时，队列保留之前恢复过的历史模型，不用当前模型猜测历史。

## 本机已确认的 Windows 原生数据库结构

路径：`<antigravity-root>/conversations/<session>.db`，与 brain 是兄弟目录。
只读打开，包含 WAL，busy_timeout=0，读取失败不阻塞采集、不修改源数据库。

查询：

```sql
SELECT metadata FROM steps WHERE idx=? AND step_type=15;
SELECT data FROM gen_metadata WHERE idx=?;
```

Step metadata protobuf field 20 为 generation reference，其 field 3 是生成索引。
索引 0 在 protobuf 中可能省略标量，不可因此当作缺失引用。生成记录的 field 1 为
response，response field 21 优先（tiered model ID），field 19 为基础模型名。
两种模型字段单独解码，兼容其中一个字段的异常 wire type。不能按生成记录顺序推断 Step。

本机只读确认了这些表和字段，随后以实际日志和 CC Switch 已导入数据进行了全量对账。
没有复制任何真实内容到 Fixture。测试 SQLite/protobuf 由固定合成字节在临时目录生成。

## 有意的区别

- 解析器立即丢弃正文，降低内存和误序列化风险。
- 总计超过 D1 i64 上限时拒绝该事件并诊断，避免整数溢出。
- 未匹配价格显示 unpriced/NULL；不沿用上游价格缺失时返回 0 的行为。
- 不移植代理、Tauri、OAuth、订阅管理或当前模型配置。
