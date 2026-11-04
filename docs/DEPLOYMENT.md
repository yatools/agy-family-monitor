# Cloudflare 部署与运维

单个 Worker 提供静态网站和 API，D1 独立存储。公开仓库提供 wrangler.example.jsonc，
每个部署的真实配置保存为忽略的 apps/worker/wrangler.jsonc，不影响既有实例。

| 资源        | 自行部署时填写                                      |
| ----------- | --------------------------------------------------- |
| Worker      | agy-family-monitor                                  |
| D1          | 自己创建的 agy-family-monitor 数据库 ID             |
| 网站        | 如 monitor.example.com，Access 保护所有路径         |
| Agent API   | 如 agent-monitor.example.com，独立设备 Bearer Token |
| Access 应用 | 自己的应用 AUD，写入 ACCESS_AUD                     |
| Access 团队 | 自己的 your-team.cloudflareaccess.com               |
| 预警补扫    | 每五分钟 Cron，上传也触发                           |

每个部署使用自己的资源。资源 ID、团队域名和 AUD 不是密钥，仍不随仓库公开实际配置。
OAuth、绑定码、设备凭据、真实邮箱和备份不能提交 Git。

## 首次配置

```powershell
npm ci
Copy-Item apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc
node scripts/wrangler.mjs login
node scripts/wrangler.mjs d1 create agy-family-monitor
```

把返回的 database_id 写入本地 wrangler.jsonc，配置自己的两个域名及 Access team/AUD。
先在 Cloudflare Zero Trust 为网站域名创建 Access 应用与 Allow 策略，再发布网站。
保留 workers_dev=false、preview_urls=false；不要把 Dashboard 放到未受保护的其他域名。
Agent 域名不加交互式 Access；后台 API 自行验证设备 Token，Dashboard API 始终验证 JWT。

本地演示无需 Cloudflare 登录：npm run dev:web 后访问 http://localhost:5173/?demo=1。
真实 API 本地开发需先以 --local 应用迁移和初始化管理员。

## 构建与发布

```powershell
npm ci
./scripts/check.ps1
./scripts/build-agent.ps1
node scripts/wrangler.mjs d1 migrations apply agy-family-monitor --config apps/worker/wrangler.jsonc --remote
./scripts/bootstrap.ps1 -AdminEmail admin@example.com -Remote
./scripts/deploy.ps1
```

本机 Rust 下载兼容模式可加 -RegistryFallback。先构建当前 EXE，再发布网页，保证下载和代码一致。
stage-download.mjs 复制 EXE、许可、安装说明和含 SHA-256 的 release.json 至静态下载目录。
npm run build 只预演；deploy.ps1 才发布代码、静态文件和两个自定义域名。

迁移 0001 创建结构索引，0002 提供三条有固定 CC Switch SHA 来源的初始价格。
迁移 0003、0004 增加六人共享额度监控、邮件队列以及官方价格版本。
迁移 0005 增加管理员采集开关、频率和一次性手动指令。
管理员脚本必须显式传邮箱，只在没有管理员时初始化，不覆盖既有成员。
生产初始仅管理员，不写入六名演示成员。

## Access

推荐在网站专属 Access 应用的 Allow 策略中添加“登录方法 → One-time PIN”包含规则，
以邮箱验证码验证身份。Worker 再验证签名 JWT 与 D1 活动成员：没有成员账号的邮箱仍返回 403。
不要使用 Bypass；该策略只关联本网站，不用于其他应用。这样管理员只在网站添加普通成员即可，
无需重复维护 Cloudflare 邮箱名单。更严格的部署也可保留双重邮箱名单，但每次新增成员需同步更新。

Agent 域名不经过交互登录，否则后台上传会收到 HTML。它的 Dashboard API 仍检查 JWT 和成员。
Worker 禁用 workers.dev 和预览 URL。JWT 验证签名、issuer、audience 和时效，不能伪造邮箱头绕过。
普通成员只能查全组统计、在线、模型、明细和预警；所有设置读取与变更均须管理员身份。
自行部署的客户端绑定请显式传 --server https://agent-monitor.example.com。
源代码中的维护者网站链接（通知/邮件正文和默认 API 地址）可按自己的域名调整。

发布后核验：网站未登录跳转 Access；Agent health=200；无密钥上传=401；无 JWT 的 Dashboard API=401；
客户端文件哈希与 release.json 一致。真实成员浏览器登录需完成邮箱验证，不能用测试 JWT 代替验收。

## 备份恢复

```powershell
./scripts/backup.ps1
```

远程导出 D1 到 .local/backups 并保存 SHA-256。备份包含家庭统计和设备密钥哈希，
应另存于用户控制的加密存储，不提交 Git，不作为网站下载文件。

本地恢复校验（Node 24+，或 Node 22.13+）可运行：

```powershell
node scripts/verify-backup.mjs .local/backups/备份.sql
```

工具在独立内存数据库导入，核对哈希、SQLite 完整性、外键并输出现有表行数，0.3.0 覆盖 12 类表。
可传第二个参数 expected-counts.json，与线上同一备份时点的表行数进行严格比较。

先校验哈希，再导入新建的隔离数据库，对比成员、设备、事件、价格、规则和通知行数。
恢复测试不得覆盖生产 D1。核对后才切换 DB binding，保留旧库以便回退。
本地 SQLite 导入能证明导出可读和结构数据完整，不能代替真实云端灾备切换演练。

## 发布边界

0.3.0 已实现功能，自动化和合成联调不能代替两台 Windows、六人真实登录及 72 小时运行。
证据和待验收项见 ACCEPTANCE.md，不把未验证项标为通过。

邮件绑定通过 scripts/configure-email.ps1 配置；邮箱存于忽略目录和 D1，scripts/wrangler.mjs 发布时生成私有绑定配置。新增 0003_monitoring、0004_official_prices 两个迁移。两条 Cron 分别运行阈值预警和共享额度对账，避免单次免费 D1 查询预算超限。
