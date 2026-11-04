我把它整理成一份面向 Codex 的工程开发规格。重点不是单纯写需求，而是让 Codex 能按阶段建仓库、写代码、跑测试、部署 Cloudflare，并且每个阶段都有验收标准。



开发规格 v1.0

&#x20;Rust Agent + Cloudflare Workers + D1 + Vue 3



# Agy Family Monitor

## 完整开发规格与 Codex 实施指南

**版本：** v1.0\
**项目类型：** 自托管家庭组 Antigravity 用量监控\
**目标用户：** 5 名家庭组成员\
**首发平台：** Windows 10/11 x64\
**客户端：** Rust 单文件 EXE\
**服务端：** Cloudflare Workers + D1\
**前端：** Vue 3 + TypeScript\
**通知：** Web 通知 + Windows 本地通知\
**暂不实现：** Telegram Bot、AI API 代理、订阅额度共享、Google 官方额度百分比监控

---

# 1. 项目目标

开发一套轻量级 Antigravity 家庭组用量监控系统。

五名成员分别在自己的 Windows 电脑上运行同一个轻量级 Agent.exe。

客户端自动读取 Antigravity CLI 和 IDE 生成的本地会话日志，提取真实 Token 用量，进行去重和增量上传。

所有数据统一存储在 Cloudflare D1，由 Web Dashboard 展示。

所有家庭组成员登录后均可以查看完整的家庭组数据。

## 1.1 核心需求

1. 自动采集 Antigravity CLI 和 IDE 使用记录。
2. 统计每个成员的 Input、Output、Cache Read、Cache Write Token。
3. 统计每个成员的模型使用量。
4. 根据模型 API 定价计算美元等效费用。
5. 支持按日、周、月及自定义时间范围统计。
6. 支持成员之间相互查看用量。
7. 支持按照绝对 Token 数量和美元成本设置阈值。
8. 达到阈值后产生 Web 预警和 Windows 通知。
9. 网络中断时本地缓存，恢复后自动补传。
10. 客户端不上传提示词、对话内容、Google OAuth Token。

## 1.2 不属于本项目的功能

- Google 家庭组管理。
- Google AI 官方额度百分比查询。
- AI 请求代理和 API Key 分发。
- AI 订阅拼车交易。
- 远程限制成员使用 Antigravity。
- 读取成员的 Google 账号密码。
- 上传完整会话记录。

本项目只负责统计和提醒，不负责控制成员的模型使用权限。

---

# 2. 技术架构

采用 Cloudflare 全托管方案，第一版不需要 LXC。

```
             Windows PC
  +-----------------------------+
  | Member A                    |
  | AgyFamilyMonitor.exe        |
  |                             |
  | Antigravity CLI Logs        |
  | Antigravity IDE Logs        |
  |          |                  |
  |          v                  |
  | Rust Parser                 |
  | Token Tracker               |
  | Local SQLite Queue          |
  |          |                  |
  |          v                  |
  | HTTPS Upload                |
  +-----------------------------+
                 |
                 |
       +---------+---------+
       |                   |
       v                   v
  Member B             Member C
  Agent.exe            Agent.exe
       |                   |
       +---------+---------+
                 |
                 v
       Cloudflare Workers
       +----------------------+
       | Device Authentication|
       | Usage API             |
       | Statistics           |
       | Cost Calculation      |
       | Alert Engine          |
       +----------------------+
                 |
                 v
           Cloudflare D1
       +----------------------+
       | Members              |
       | Devices              |
       | Usage Events         |
       | Model Prices         |
       | Alert Rules          |
       +----------------------+
                 |
                 v
       Workers Static Assets
       +----------------------+
       | Vue 3 Dashboard      |
       | Overview             |
       | Members              |
       | Usage                |
       | Alerts               |
       | Settings             |
       +----------------------+
```

## 2.1 技术选型

| 模块         | 技术                 |
| ---------- | ------------------ |
| 客户端        | Rust               |
| 异步运行       | Tokio              |
| JSON 解析    | Serde / Serde JSON |
| 文件监听       | notify             |
| 本地数据库      | SQLite             |
| HTTPS      | Reqwest + rustls   |
| Windows 通知 | Windows Toast API  |
| 本地密钥保护     | Windows DPAPI      |
| 服务端        | Cloudflare Workers |
| API 框架     | Hono               |
| 数据库        | Cloudflare D1      |
| 前端         | Vue 3 + TypeScript |
| 图表         | ECharts            |
| 构建工具       | Vite               |
| 部署         | Wrangler           |
| 网站认证       | Cloudflare Access  |

## 2.2 域名规划

建议使用两个子域名：

- `monitor.example.com`：Web Dashboard，接入 Cloudflare Access。
- `agent-api.example.com`：客户端上传 API，使用独立设备密钥认证。

两个域名可以路由到同一个 Worker 服务。

这样可以避免 Cloudflare Access 阻止 Agent.exe 的自动上传请求。

---

# 3. GitHub 项目结构

建议采用 Monorepo。

```
agy-family-monitor/
│
├── README.md
├── LICENSE
├── AGENTS.md
├── .gitignore
│
├── docs/
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── PRIVACY.md
│   ├── DEPLOYMENT.md
│   └── ACCEPTANCE.md
│
├── crates/
│   └── agy-usage-core/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── discovery.rs
│           ├── records.rs
│           ├── parser.rs
│           ├── model_resolver.rs
│           ├── native_models.rs
│           ├── normalizer.rs
│           └── types.rs
│
├── agent/
│   ├── Cargo.toml
│   ├── build.rs
│   └── src/
│       ├── main.rs
│       ├── cli.rs
│       ├── config.rs
│       ├── scanner.rs
│       ├── watcher.rs
│       ├── tracker.rs
│       ├── uploader.rs
│       ├── queue.rs
│       ├── heartbeat.rs
│       ├── notifier.rs
│       └── windows/
│           ├── autostart.rs
│           ├── toast.rs
│           └── dpapi.rs
│
├── apps/
│   ├── worker/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── auth/
│   │   │   ├── routes/
│   │   │   ├── services/
│   │   │   ├── middleware/
│   │   │   └── utils/
│   │   ├── migrations/
│   │   ├── seeds/
│   │   ├── test/
│   │   ├── package.json
│   │   └── wrangler.jsonc
│   │
│   └── web/
│       ├── src/
│       │   ├── api/
│       │   ├── components/
│       │   ├── layouts/
│       │   ├── pages/
│       │   ├── stores/
│       │   ├── router/
│       │   └── main.ts
│       ├── package.json
│       └── vite.config.ts
│
├── fixtures/
│   └── antigravity/
│       ├── sample_transcript.jsonl
│       └── README.md
│
└── scripts/
    ├── build-agent.ps1
    ├── build-web.ps1
    ├── deploy.ps1
    └── sanitize-fixture.ps1
```

核心设计：

`agy-usage-core` 是整个项目的核心 Rust 库。

Agent 和测试程序共同调用它，避免把解析逻辑直接写在主程序里。

后续如果需要 Linux/macOS 客户端，也可以直接复用该库。

---

# 4. CC Switch 源码复用规范

这是整个项目最重要的部分。

上游项目：

[https://github.com/farion1231/cc-switch](https://github.com/farion1231/cc-switch)

许可证：MIT。

需要重点研究和抽取以下文件：

| 上游文件                                                        | 复用内容                        |
| ----------------------------------------------------------- | --------------------------- |
| `src-tauri/src/services/session_usage_agy.rs`               | Token 提取、去重、模型识别、费用统计逻辑     |
| `src-tauri/src/session_manager/providers/agy.rs`            | Antigravity 会话目录发现、JSONL 读取 |
| `src-tauri/src/services/subscription_agy.rs`                | Token 字段归一化的参考              |
| `src-tauri/src/services/usage_stats.rs`                     | 模型定价查询思路                    |
| `src-tauri/src/proxy/usage/calculator.rs`                   | 费用计算逻辑                      |
| `src-tauri/src/services/session_usage_agy/native_models.rs` | 子代理模型恢复逻辑                   |

## 4.1 复用原则

不要直接复制整个 CC Switch 项目。

应该把与 Tauri、UI、代理服务、主数据库有关的依赖剥离，只留下 Antigravity 用量采集所需要的逻辑。

重点抽取：

- `records()`
- `model_from_settings_change()`
- `model_id_of()`
- `known_model()`
- `import_records()` 中的核心解析部分
- 原生数据库模型恢复逻辑

重构为独立 Rust crate。

所有复制或改造的代码必须保留 MIT License 要求的版权声明和许可证文本。

在 `THIRD_PARTY_NOTICES.md` 记录来源文件、上游仓库、采用的代码范围和许可证。

实施前必须确定并记录 CC Switch 的具体 Git Commit SHA，不能直接依赖持续变化的 main 分支。

---

# 5. Agent.exe 设计

## 5.1 客户端目标

- Windows 10/11 x64。
- 单文件 EXE 分发。
- 无需安装 Python、Node.js、Java。
- 不需要 Docker。
- 不需要管理员权限即可正常采集和上传。
- 后台运行。
- 支持开机或登录自动启动。
- 支持离线缓存。
- 支持本地 Windows 通知。

第一版只支持 Windows x64。

暂时不考虑 ARM Windows、macOS、Linux。

## 5.2 程序启动参数

```
AgyFamilyMonitor.exe --enroll
AgyFamilyMonitor.exe --install
AgyFamilyMonitor.exe --uninstall
AgyFamilyMonitor.exe --status
AgyFamilyMonitor.exe --run-once
AgyFamilyMonitor.exe --background
```

含义：

| 参数             | 功能                         |
| -------------- | -------------------------- |
| `--enroll`     | 输入绑定码，注册设备                 |
| `--install`    | 安装到 LocalAppData 并创建登录启动任务 |
| `--uninstall`  | 删除自动启动任务及程序配置              |
| `--status`     | 显示客户端状态                    |
| `--run-once`   | 手动运行一轮采集                   |
| `--background` | 后台运行模式                     |

首次注册采用简单命令行交互即可。

注册完成后，将程序复制到：

```
%LOCALAPPDATA%\AgyFamilyMonitor\
    AgyFamilyMonitor.exe
    config.json
    data.db
    logs\
```

然后通过 Windows Task Scheduler 创建当前用户登录时启动的任务。

不需要 Windows Service，也不需要管理员权限。

## 5.3 Antigravity 目录发现

优先参考 CC Switch 的：

`agy_config::agy_dir()`

以及：

`session_manager/providers/agy.rs`

重点支持：

```
%USERPROFILE%\.gemini\antigravity-cli\brain\

%USERPROFILE%\.gemini\antigravity\brain\
```

同时支持 CC Switch 独立配置目录中的 Antigravity 会话。

注意：

- 不要把路径永久写死。
- 使用 Windows 用户主目录动态解析。
- 支持配置文件手动增加额外目录。
- 支持目录不存在。
- 支持文件被占用。
- 支持多个目录同时扫描。
- 防止重复扫描同一个 Session。
- 只读访问会话数据。

## 5.4 数据文件

每个 Session 主要读取：

```
<session_id>\
    .system_generated\
        logs\
            transcript_full.jsonl
```

使用 Rust BufReader 逐行读取。

CC Switch 当前逻辑会按照 `step_index` 建立有序映射，同一个 Step 出现多条记录时，以最后一条记录为准。

必须保留此行为。

## 5.5 Token 提取规则

只处理：

```
type == "PLANNER_RESPONSE"
status == "DONE"
```

提取：

```
{
  "input_tokens": 10000,
  "output_tokens": 5000,
  "cache_read_tokens": 3000,
  "cache_write_tokens": 1000
}
```

注意：

- Input Token 已经排除了缓存。
- Output Token 已经包含思考部分。
- 不允许重复计算 reasoning_tokens。
- Cache Read 和 Cache Write 单独统计。

总 Token：

```
total_tokens =
    input_tokens
  + output_tokens
  + cache_read_tokens
  + cache_write_tokens
```

每次调用必须保留四个原始分类，不允许只上传一个 total_tokens。

## 5.6 模型识别

按照优先级处理：

1. 直接读取响应记录中的 `model`。
2. 如果没有，则从之前的 Model Selection 设置变更记录中恢复。
3. 如果仍然无法确定，则读取对应 Session 的本地原生数据库，参考 CC Switch `native_models.rs` 中的 `gen_metadata` 查询逻辑。
4. 依然无法确定时，标记为 `unknown`。

禁止根据当前正在使用的模型推断历史记录中的模型。

模型名称需要同时保留：

```
model_display
model_id
```

例如：

```
Gemini 3.8 Flash (High)
```

归一化后：

```
gemini-3.8-flash-high
```

模型名称归一化规则应当保留上游 CC Switch 的行为，并增加单元测试。

## 5.7 增量扫描和去重

不能简单地把每次扫描都作为新数据上传。

建议：

- 使用 `notify` 监听目录变化。
- 每 60 秒执行一次补充扫描。
- 文件变化时重新解析对应 Session。
- 记录每个 Session 的 Step。
- 相同 Step 不重复计入。
- 同一个 Step 的 Token 数据发生修正时，更新原记录。
- 多个根目录出现同一 Session 时去重。
- JSONL 最后一行不完整时暂不导入。
- 文件被重写或缩小时重新完整扫描。

第一版可以采用：

**变化文件全量解析 + SQLite Step 状态去重。**

不要一开始就实现复杂的文件偏移量增量读取。Antigravity 可能重写已经存在的 Step，单纯依赖 offset 会漏掉修正。

## 5.8 隐私过滤

客户端可以在本地读取完整 JSONL，但上传前必须进行字段白名单过滤。

允许上传：

- 匿名 Session ID。
- Step ID。
- 模型名称。
- 时间戳。
- 四类 Token 数量。
- 数据来源类型。

禁止上传：

- USER_INPUT 原文。
- PLANNER_RESPONSE 原文。
- 系统提示词。
- 文件路径。
- 工作目录。
- Google OAuth Token。
- 原始 Session ID。

使用设备专属 HMAC 密钥生成稳定的 Session Hash 和 Event ID。

示例：

```
session_key =
HMAC(device_event_key, session_id)

event_id =
HMAC(device_event_key, session_id + ":" + step_index)
```

## 5.9 本地 SQLite

本地至少建立两张表。

### events_queue

保存尚未成功上传的数据。

### scanner_state

保存每个 Session 最近扫描时间、文件状态和 Step Hash。

上传成功后再标记对应事件为已同步。

不能在上传请求发出后立即删除缓存。

网络失败时：

- 30 秒后重试。
- 之后采用指数退避。
- 最大重试间隔 30 分钟。
- 成功后恢复正常。
- 支持程序重启后恢复上传队列。

## 5.10 上传频率

建议：

| 操作     | 频率                  |
| ------ | ------------------- |
| 文件变更监听 | 实时触发                |
| 完整补充扫描 | 60 秒                |
| 数据上传   | 有新数据时，最多等待 15 秒合并批次 |
| 心跳     | 5 分钟                |
| 预警查询   | 60 秒                |

上传接口使用批量模式，默认每批最多 100 条事件。

## 5.11 Agent 安全

注册时由服务器签发：

- device_id
- device_token
- pseudonym_key

其中：

- device_token 用于 HTTPS API 身份认证。
- pseudonym_key 用于本地 Session/Event 匿名化。

设备 Token 只在注册时返回一次。

服务器仅保存 Token 的 SHA-256 哈希。

Windows 客户端通过 DPAPI 保护本地凭据。

撤销设备后，服务器立即拒绝该设备的上传请求。

---

# 6. 费用计算模块

费用是估算值，不是 Google 官方账单。

需要复用 CC Switch 的模型计价思想，但将价格表放在中央服务器，保证五个成员使用同一份价格。

## 6.1 价格表

建立模型价格表：

```
model_id
input_price
output_price
cache_read_price
cache_write_price
effective_from
catalog_version
source
```

建议以每百万 Token 的美元价格存储。

为避免浮点精度误差，价格以整数 micro-USD 表示。

例如：

```
$0.10 / 1M tokens
=
100000 micro-USD / 1M tokens
```

## 6.2 计算公式

```
cost_micro_usd =
round(
    (
      input_tokens * input_price
    + output_tokens * output_price
    + cache_read_tokens * cache_read_price
    + cache_write_tokens * cache_write_price
    ) / 1000000
)
```

其中各价格均为 micro-USD / 1M tokens。

最终显示：

```
cost_usd = cost_micro_usd / 1000000
```

价格数据必须来源明确，优先从固定版本的 CC Switch 定价表提取。

必须支持后续更新模型价格。

## 6.3 未知模型

特别要求：

如果模型没有匹配到价格：

```
pricing_status = "unpriced"
cost_micro_usd = NULL
```

不能将其当作免费模型。

Token 仍然正常计入总量。

Web Dashboard 单独显示未计价 Token。

当管理员补充价格后，允许对历史未计价记录重新计算费用。

保留价格版本，避免价格更新导致历史统计无法追溯。

---

# 7. Cloudflare Workers API

采用 TypeScript + Hono。

所有 Agent API 必须验证设备 Token。

所有 Dashboard API 必须验证 Cloudflare Access JWT，并检查成员身份。

## 7.1 API 列表

### Agent API

| 方法   | 路径                         | 功能    |
| ---- | -------------------------- | ----- |
| POST | `/api/v1/agent/enroll`     | 注册设备  |
| POST | `/api/v1/agent/heartbeat`  | 心跳    |
| POST | `/api/v1/agent/events`     | 上传事件  |
| GET  | `/api/v1/agent/alerts`     | 获取新预警 |
| POST | `/api/v1/agent/alerts/ack` | 确认通知  |

### Dashboard API

| 方法     | 路径                              | 功能     |
| ------ | ------------------------------- | ------ |
| GET    | `/api/v1/dashboard/summary`     | 家庭总览   |
| GET    | `/api/v1/dashboard/members`     | 成员列表   |
| GET    | `/api/v1/dashboard/usage`       | 用量明细   |
| GET    | `/api/v1/dashboard/trends`      | 趋势数据   |
| GET    | `/api/v1/dashboard/models`      | 模型统计   |
| GET    | `/api/v1/dashboard/alerts`      | 预警列表   |
| GET    | `/api/v1/dashboard/rules`       | 预警规则   |
| PUT    | `/api/v1/dashboard/rules`       | 修改预警规则 |
| POST   | `/api/v1/dashboard/enrollments` | 创建绑定码  |
| DELETE | `/api/v1/dashboard/devices/:id` | 撤销设备   |

## 7.2 设备注册

管理员在网站创建绑定码。

绑定码：

- 随机生成。
- 有效期 15 分钟。
- 只能使用一次。
- 与指定 member_id 绑定。
- 服务端只保存绑定码哈希。

Agent 注册请求：

```
{
  "code": "ONE_TIME_CODE",
  "device_label": "Windows PC",
  "platform": "windows-x64",
  "agent_version": "0.1.0"
}
```

返回：

```
{
  "device_id": "device_001",
  "device_token": "RANDOM_SECRET",
  "pseudonym_key": "RANDOM_EVENT_KEY"
}
```

客户端保存凭据，之后不需要再次输入绑定码。

## 7.3 上传接口

```
POST /api/v1/agent/events
Authorization: Bearer DEVICE_TOKEN
Content-Type: application/json
```

请求：

```
{
  "batch_id": "batch_001",
  "agent_version": "0.1.0",
  "events": [
    {
      "event_id": "opaque_event_hash",
      "session_key": "opaque_session_hash",
      "step_index": 23,
      "source": "antigravity_ide",
      "model_id": "gemini-3.8-flash",
      "model_display": "Gemini 3.8 Flash",
      "occurred_at_ms": 1793779200000,
      "tokens": {
        "input": 12000,
        "output": 3500,
        "cache_read": 8000,
        "cache_write": 1200
      }
    }
  ]
}
```

服务器不接受客户端传入 member_id 作为身份依据。

member_id 必须从经过认证的 device_id 关联得到。

服务器负责：

1. 校验请求。
2. 验证设备是否有效。
3. 校验 Token 字段。
4. 计算 total_tokens。
5. 匹配模型价格。
6. 计算费用。
7. 执行 UPSERT。
8. 更新统计。
9. 检查预警规则。

返回：

```
{
  "success": true,
  "inserted": 1,
  "updated": 0,
  "unchanged": 0,
  "server_time_ms": 1793779200000
}
```

同一 Event 重复上传不得重复计数。

如果原始 Step 后续被修正，必须更新已有记录，而不是新增第二条。

---

# 8. Cloudflare D1 数据库

至少建立以下表。

## 8.1 members

```
CREATE TABLE members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    created_at_ms INTEGER NOT NULL
);
```

角色：

- admin
- member

所有成员可以查看全组用量。

只有 admin 可以管理成员、设备和全局配置。

## 8.2 devices

```
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    device_label TEXT,
    platform TEXT NOT NULL,
    agent_version TEXT,
    token_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER,
    revoked_at_ms INTEGER,
    FOREIGN KEY(member_id) REFERENCES members(id)
);
```

## 8.3 enrollment_codes

```
CREATE TABLE enrollment_codes (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);
```

## 8.4 usage_events

```
CREATE TABLE usage_events (
    device_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    source TEXT NOT NULL,

    model_id TEXT,
    model_display TEXT,

    occurred_at_ms INTEGER NOT NULL,

    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,

    cost_micro_usd INTEGER,
    pricing_status TEXT NOT NULL DEFAULT 'unpriced',
    pricing_version TEXT,

    event_hash TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,

    PRIMARY KEY(device_id, event_id),
    FOREIGN KEY(device_id) REFERENCES devices(id),
    FOREIGN KEY(member_id) REFERENCES members(id)
);
```

## 8.5 model_prices

```
CREATE TABLE model_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    effective_from_ms INTEGER NOT NULL,

    input_price_micro INTEGER NOT NULL,
    output_price_micro INTEGER NOT NULL,
    cache_read_price_micro INTEGER,
    cache_write_price_micro INTEGER,

    catalog_version TEXT NOT NULL,
    source TEXT,

    UNIQUE(model_id, effective_from_ms)
);
```

价格字段的单位为 micro-USD / 1M tokens。

## 8.6 alert_rules

```
CREATE TABLE alert_rules (
    id TEXT PRIMARY KEY,

    scope TEXT NOT NULL,
    member_id TEXT,

    metric TEXT NOT NULL,
    period TEXT NOT NULL,
    threshold_value INTEGER NOT NULL,

    enabled INTEGER NOT NULL DEFAULT 1,
    notify_all INTEGER NOT NULL DEFAULT 1,

    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

metric：

- total_tokens
- input_tokens
- output_tokens
- cache_read_tokens
- cache_write_tokens
- cost_micro_usd

period：

- day
- rolling_24h
- week
- month

scope：

- group
- member

## 8.7 alert_notifications

```
CREATE TABLE alert_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    member_id TEXT,
    message TEXT NOT NULL,
    value INTEGER NOT NULL,
    threshold_value INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);
```

## 8.8 alert_state

用于防止同一统计周期反复触发。

需要通过：

```
rule_id + subject_id + period_start_ms
```

保证一个规则在一个统计周期内只触发一次。

## 8.9 索引

必须为以下字段建立索引：

- usage_events.member_id
- usage_events.occurred_at_ms
- usage_events.model_id
- usage_events.member_id + occurred_at_ms
- devices.member_id
- alert_notifications.created_at_ms

第一版五人规模不需要额外 Redis，也不需要复杂消息队列。

---

# 9. 预警系统

第一版不接 Telegram。

实现：

1. Dashboard 站内预警。
2. Windows 本地通知。

## 9.1 预警指标

全部使用绝对值。

不使用 Google 家庭组共享百分比。

示例：

| 规则         | 阈值         |
| ---------- | ---------- |
| 单人每日 Token | 1,000,000  |
| 单人每周 Token | 5,000,000  |
| 单人每月 Token | 15,000,000 |
| 单人每月成本     | $10        |
| 全家庭每周成本    | $30        |

这些数字仅作为默认配置示例，管理员可以自行修改。

## 9.2 周期计算

统一使用家庭组配置的时区。

默认：

```
Asia/Shanghai
```

日、周、月按该时区的自然周期计算。

rolling_24h 使用当前时间向前滚动 24 小时。

所有数据库时间戳统一保存为 UTC Unix 毫秒。

## 9.3 预警触发

示例：

```
Member B
Daily Token = 1,200,000

Rule:
Daily Token > 1,000,000

Result:
Trigger Alert
```

一个周期内同一规则只通知一次。

新周期开始后重新计算。

## 9.4 Windows 通知

Agent 每 60 秒查询一次服务器预警。

如果有新预警：

- 通过 Windows Toast 显示。
- 本地保存通知 ID。
- 确认后推进通知游标。
- 避免同一预警反复通知。

默认通知所有成员，成员可以在设置里选择是否开启本地通知。

---

# 10. Web Dashboard

建议使用 Vue 3 + TypeScript + ECharts。

设计参考 CC Switch Usage 页面。

整体采用简洁的深浅色自适应 UI。

## 10.1 Overview

首页展示：

- 今日总 Token。
- 今日估算美元成本。
- 本周 Token。
- 本月估算费用。
- 五名成员用量排名。
- 家庭每日 Token 趋势。
- 家庭每日费用趋势。
- 模型使用分布。
- 当前未计价 Token。
- 最近一次 Agent 上报时间。

## 10.2 Members

成员列表：

| 字段       | 内容       |
| -------- | -------- |
| 成员名称     | Member A |
| 今日 Token | 数值       |
| 本周 Token | 数值       |
| 本月 Token | 数值       |
| 今日费用     | 美元       |
| 本月费用     | 美元       |
| Agent 状态 | 在线/离线    |
| 最近上报     | 时间       |

点击成员可以进入详情页。

## 10.3 Usage

功能：

- 日期筛选。
- 成员筛选。
- 模型筛选。
- CLI / IDE 来源筛选。
- Input Token。
- Output Token。
- Cache Read。
- Cache Write。
- Total Token。
- Estimated Cost。

支持分页。

不展示提示词、对话内容和原始 Session ID。

## 10.4 Models

展示：

- 各模型总 Token。
- 各模型估算费用。
- 各成员的模型使用情况。
- 未计价模型。

## 10.5 Alerts

展示：

- 预警规则。
- 触发成员。
- 触发时间。
- 当前值。
- 阈值。
- 处理状态。

## 10.6 Settings

管理员可以：

- 添加成员。
- 生成一次性绑定码。
- 撤销设备。
- 修改成员名称。
- 设置家庭组时区。
- 管理模型价格。
- 修改预警规则。

普通成员只能查看和修改自己的通知偏好。

---

# 11. Cloudflare 部署

## 11.1 建立资源

需要：

1. Cloudflare Workers。
2. Cloudflare D1。
3. Workers Static Assets。
4. 自定义域名。
5. Cloudflare Access。

第一版不需要：

- R2。
- Durable Objects。
- KV。
- Queues。
- Cloudflare Workers AI。

## 11.2 Wrangler 配置

建议采用：

```
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "agy-family-monitor",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-04",

  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "agy-family-monitor",
      "database_id": "YOUR_DATABASE_ID",
      "migrations_dir": "migrations"
    }
  ]
}
```

具体配置需要根据当前 Wrangler 版本验证。

## 11.3 部署流程

```
npm install

npm run build

npx wrangler d1 create agy-family-monitor

npx wrangler d1 migrations apply agy-family-monitor --remote

npx wrangler deploy
```

前端构建产物由 Workers Static Assets 提供。

API 通过 Worker 处理。

## 11.4 数据安全

- Access 保护 Dashboard。
- Worker 验证 Access JWT。
- Agent API 使用独立 Bearer Token。
- Token 仅保存哈希。
- D1 不存储 Google OAuth Token。
- 不开放 D1 直接访问。
- HTTPS 全程加密。
- 设备可以单独撤销。
- 定期导出 D1 数据备份。

---

# 12. 测试规范

测试不能只验证程序能启动。

必须验证统计结果与 CC Switch 一致。

## 12.1 Rust 单元测试

覆盖：

1. JSONL 正常解析。
2. JSONL 最后一行不完整。
3. 同一 Step 多次出现。
4. Step 被后续重写。
5. CLI 和 IDE 同一 Session 去重。
6. 模型切换记录识别。
7. 子代理模型恢复。
8. 未知模型处理。
9. 四类 Token 提取。
10. 文件截断和重写。
11. 多个日志目录。
12. 本地离线缓存。

## 12.2 后端测试

覆盖：

1. 绑定码注册。
2. 绑定码过期。
3. 绑定码重复使用。
4. 无效 Token。
5. 已撤销设备。
6. 重复 Event 上传。
7. 修正 Event 上传。
8. 未知模型费用。
9. 价格更新后历史补算。
10. 成员数据隔离和共享权限。
11. 预警阈值触发。
12. 周期重置。
13. 重复通知防护。

## 12.3 前端测试

覆盖：

- 五名成员展示。
- 日期筛选。
- 成员筛选。
- 模型筛选。
- 历史趋势。
- 预警展示。
- 手机端适配。
- Access 未授权跳转。

---

# 13. P1 核心验收标准

P1 是整个项目的第一道关卡。

必须先证明 Agent 的统计准确性，再开发完整的网站。

## 13.1 对比 CC Switch

使用同一台 Windows 电脑：

1. 打开 Antigravity。
2. 正常使用若干模型。
3. 运行 CC Switch。
4. 运行 Agy Family Monitor Agent。
5. 对比 Usage 页面统计结果。

检查：

| 验收项          | 要求        |
| ------------ | --------- |
| Input Token  | 一致        |
| Output Token | 一致        |
| Cache Read   | 一致        |
| Cache Write  | 一致        |
| Total Token  | 一致        |
| 模型分类         | 已识别记录一致   |
| 去重           | 不产生重复记录   |
| Step 修正      | 能更新已有数据   |
| 未知模型         | 不错误归入当前模型 |
| 未知价格         | 不按免费处理    |

费用允许存在由价格目录版本造成的差异，但必须能追溯具体价格版本。

## 13.2 隐私验收

检查 Agent 实际上传的数据包：

- 不包含 USER_INPUT。
- 不包含 PLANNER_RESPONSE 原文。
- 不包含 prompt。
- 不包含 Google OAuth Token。
- 不包含原始 Session ID。
- 不包含本地绝对路径。

必须增加自动化测试，确保序列化的数据结构只有白名单字段。

## 13.3 性能验收

目标：

- 后台常驻内存尽可能低，目标不超过 50MB。
- 不持续占用 CPU。
- 不影响 Antigravity 正常运行。
- 日志监听不能造成无限循环。
- 网络故障不能导致 Agent 崩溃。
- 重启后能够恢复本地上传队列。

50MB 是开发目标，不是未经实测的性能保证。

---

# 14. 开发里程碑

不要让 Codex 一次性生成整个项目。

必须按以下顺序实施。

## P0：源码分析与项目初始化

任务：

- 克隆 CC Switch。
- 确认 MIT License。
- 固定上游 Commit SHA。
- 研究 Antigravity 文件目录。
- 初始化 Rust Workspace。
- 创建 Monorepo。
- 建立 AGENTS.md。
- 建立测试 Fixture。

验收：

项目结构正确，依赖关系明确，能运行最基础的 Rust 测试。

## P1：Rust 采集核心

任务：

- 实现目录自动发现。
- 实现 JSONL Parser。
- 实现 Step 去重。
- 实现模型识别。
- 实现原生模型恢复。
- 实现 Token 归一化。
- 实现未知模型处理。

验收：

与 CC Switch 对比通过。

没有通过之前不进入 P2。

## P2：Agent.exe

任务：

- 实现 CLI 参数。
- 实现本地 SQLite。
- 实现文件监听。
- 实现定时补充扫描。
- 实现离线缓存。
- 实现 HTTPS 上传。
- 实现设备绑定。
- 实现 DPAPI。
- 实现 Windows 登录启动。
- 实现 Windows Toast。

验收：

在两台不同 Windows 电脑上可以独立采集、上传、重启恢复。

## P3：Cloudflare 后端

任务：

- 初始化 Worker。
- 初始化 D1。
- 编写 SQL Migration。
- 实现设备注册。
- 实现设备鉴权。
- 实现批量事件上传。
- 实现 UPSERT。
- 实现模型费用计算。
- 实现 Dashboard API。
- 实现预警引擎。

验收：

至少三台模拟客户端可以同时上传数据，统计不重复。

## P4：Web Dashboard

任务：

- Vue 3 项目初始化。
- Access 登录。
- Overview。
- Members。
- Usage。
- Models。
- Alerts。
- Settings。

验收：

五名成员可以登录并查看全组统计。

## P5：整体验收和发布

任务：

- 完成 Windows x64 Release。
- 完成 Cloudflare 部署。
- 完成五人绑定。
- 完成预警测试。
- 完成隐私测试。
- 完成备份恢复测试。
- 编写安装说明。

验收：

五个成员真实使用，连续运行至少 72 小时无重复统计和数据丢失。

---

# 15. Codex 执行规则

请在项目根目录建立 `AGENTS.md`。

建议内容：

```
# AGENTS.md

## Project Goal

Build Agy Family Monitor.

This project collects local Antigravity usage metadata
and uploads sanitized token statistics to Cloudflare.

## Mandatory Rules

1. Do not build an AI proxy.
2. Do not collect Google OAuth tokens.
3. Do not upload prompts or conversation content.
4. Do not use Google shared quota percentages.
5. Do not count an event twice.
6. Do not treat unknown models as free.
7. Do not guess historical model names.
8. Preserve the CC Switch MIT attribution.
9. Keep the Agent lightweight.
10. Do not introduce unnecessary services.

## Development Rules

- Work milestone by milestone.
- Write tests before moving to the next milestone.
- Keep the Rust parser independent of Tauri.
- Use typed API contracts.
- Use D1 migrations.
- Use UTC timestamps in storage.
- Use group timezone for calendar reports.
- Keep secrets out of Git.
- Never commit real member usage data.

## Required Checks

Rust:
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings

Worker:
npm run test
npm run typecheck

Frontend:
npm run build

Do not claim a milestone is complete
unless its acceptance checks pass.
```

## Codex 每个阶段的执行提示词

### 第一条：P0

```
请先阅读项目开发规格和 AGENTS.md。

只执行 P0：

1. 创建 Monorepo。
2. 初始化 Rust Workspace。
3. 创建 agy-usage-core。
4. 初始化 Agent。
5. 初始化 Cloudflare Worker。
6. 初始化 Vue 3 前端。
7. 固定 CC Switch 上游 Commit。
8. 建立许可证和第三方来源记录。
9. 建立测试目录和 Fixture。

暂时不要实现完整业务逻辑。

完成后输出项目结构、依赖关系、
构建命令和 P0 验收结果。
```

### 第二条：P1

```
执行 P1：Rust Antigravity Usage Core。

重点研究 CC Switch：

session_usage_agy.rs
session_manager/providers/agy.rs
native_models.rs

抽取必要的逻辑，不依赖 Tauri。

实现：

1. Antigravity CLI/IDE 路径发现。
2. JSONL 读取。
3. Step 去重。
4. Token 解析。
5. 模型识别。
6. 原生数据库模型恢复。
7. 数据归一化。
8. 未知模型处理。

创建真实结构的匿名化测试 Fixture。

不要上传提示词或对话内容。

必须先完成单元测试，
再与 CC Switch 的统计结果对比。

如果 Windows 原生数据库结构无法确认，
停止相关实现并报告需要的匿名化样本，
不要猜测字段。
```

### 第三条：P2

```
执行 P2：Windows Rust Agent。

要求：

1. 单文件 EXE。
2. 本地 SQLite。
3. 文件变化监听。
4. 60 秒补充扫描。
5. 增量事件队列。
6. HTTPS 批量上传。
7. DPAPI 凭据保护。
8. Windows 登录启动。
9. Windows Toast。
10. 离线重试。

不要引入 Tauri、Electron、Python 或 Node.js。

先完成 Agent 的 run-once 模式，
再实现后台运行。

必须验证重复上传不会造成重复统计。
```

### 第四条：P3

```
执行 P3：Cloudflare Worker + D1。

先建立 D1 Migration。

然后实现：

1. 绑定码。
2. 设备注册。
3. 设备 Token 验证。
4. Heartbeat。
5. 批量 Usage API。
6. Event UPSERT。
7. 模型价格匹配。
8. Cost 计算。
9. Dashboard API。
10. Alert Engine。

所有身份信息从认证结果中获取，
不能信任客户端提交的 member_id。

所有数据接口都需要权限验证和参数校验。
```

### 第五条：P4

```
执行 P4：Vue 3 Dashboard。

设计参考 CC Switch Usage 页面。

实现：

Overview
Members
Usage
Models
Alerts
Settings

五个成员均可查看全组数据。

管理员拥有成员、设备和预警规则管理权限。

完成桌面端和移动端适配。
```

### 第六条：P5

```
执行 P5：整体验收和部署。

1. 编译 Windows x64 EXE。
2. 创建 Cloudflare D1。
3. 执行远程 Migration。
4. 部署 Workers。
5. 部署 Workers Static Assets。
6. 配置两个域名。
7. 配置 Cloudflare Access。
8. 注册五个成员。
9. 测试五台电脑上传。
10. 验证统计、费用和预警。
11. 验证离线恢复。
12. 完成备份和恢复说明。

最终生成：

README.md
DEPLOYMENT.md
PRIVACY.md
ACCEPTANCE.md

未通过的验收项目必须明确列出，
不允许标记为完成。
```

---

# 16. 风险与待确认事项

以下问题必须在开发时处理，不允许直接假设：

1. Antigravity 不同版本可能改变 transcript 格式。
2. Windows 下 Antigravity IDE 与 CLI 的目录可能存在自定义路径。
3. `gen_metadata` 原生数据库结构可能随版本改变。
4. 某些历史记录可能没有可识别模型。
5. 模型定价会发生变化。
6. Agent 离线期间可能累积大量待上传数据。
7. Cloudflare D1 的查询和写入需要合理批量化。
8. Windows Toast 需要处理应用身份和通知权限。
9. 多设备重复采集同一会话需要额外去重策略。
10. Cloudflare Access 必须正确验证身份，不能仅相信请求头中的邮箱。

如果实际日志格式与上游代码不同，优先收集脱敏 Fixture，更新 Parser，而不是通过猜测字段来适配。

---

# 17. 最终交付清单

## 客户端

- AgyFamilyMonitor.exe
- 自动注册
- 自动启动
- CLI/IDE 自动发现
- Token 统计
- 模型识别
- 本地去重
- 离线缓存
- 自动上传
- Windows 通知
- 设备撤销

## 服务端

- Cloudflare Worker
- D1 Migration
- 设备注册 API
- 设备认证
- 批量上传 API
- Token 统计
- 费用计算
- 预警引擎
- Access 身份验证

## 网站

- Overview
- Members
- Usage
- Models
- Alerts
- Settings
- 成员共享查看
- 管理员权限
- 响应式布局

## 暂缓功能

- Telegram Bot
- macOS Agent
- Linux Agent
- 自动更新
- 高级报表导出

---

# 18. 项目完成定义

Agy Family Monitor v1.0 的完成标准：

五名成员各自下载同一个 EXE，完成一次性绑定后，不需要日常手动操作。

他们正常使用 Antigravity。

Agent 自动采集真实 Token 使用记录，并将脱敏后的数据上传至 Cloudflare。

任何成员登录网站，都能查看五个人的：

- 今日 Token。
- 本周 Token。
- 本月 Token。
- 模型使用分布。
- Input / Output / Cache Token。
- API 等效美元成本。
- 历史趋势。
- 预警记录。

超过管理员设定的绝对 Token 或美元阈值时，网站产生预警，成员电脑收到通知。

数据可以去重、修正、离线补传，未知模型不会被错误计为免费。

**最终产品应该是一个轻量、稳定、低维护成本的家庭组 Antigravity 用量监控工具，而不是一个复杂的 AI 服务平台。**

## 实施时，我特别建议注意三件事

1. 先不要让 Codex 一次性生成整个项目。 按文档中的 P0 到 P5 逐阶段推进。
2. P1 必须拿真实 Windows Antigravity 日志与 CC Switch 对账，尤其是子代理模型识别和 Step 修正。
3. 第一版先不引入 LXC，也不引入 Telegram。把五个 EXE 到 Cloudflare D1 的数据链路跑通，才是最重要的里程碑。

这份规格可以直接作为 Codex 的项目主说明文档，建议保存为仓库根目录的 `SPEC.md`，再把其中的 Codex 执行规则单独保存为 `AGENTS.md`。