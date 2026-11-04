# Price catalog

初始三个模型价格通过 0002_reference_prices.sql 写入，来源固定于
CC Switch 51fce968bca807aeee93be9420c651afb582c2c8 的 database/schema.rs。
每条价格记录来源、effective_from、catalog_version；更新必须新增版本。
没有已核验价格的模型必须保持 unpriced，费用为 NULL。

0.2.0 的官方价格以 0004_official_prices.sql 新增版本，覆盖 Argon、Opus 5.5、
Sonnet 5.5、Flash 3.8 等模型；同一生效时间采用最后新增的版本。
已公布的未来调价按 UTC 生效时间切换；未公布的新价格仍需核验后新增。
具体来源和缓存计价口径见 docs/MONITORING.md。

