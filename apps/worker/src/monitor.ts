import { hash } from './auth';
import {
  bucketIds,
  bucketNames,
  isOnline,
  monitorConfig,
  type BucketId,
  type MonitorConfig,
} from './monitor-config';
import { emailConfig, emailStatement, flushEmails } from './email';
import type { Env } from './types';
type Device = {
  id: string;
  member_id: string;
  display_name: string;
  last_seen_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
  agent_version: string | null;
  pending_events: number;
  collector_json: string | null;
};
type Quota = {
  device_id: string;
  bucket_id: BucketId;
  remaining_ppm: number;
  reset_at_ms: number;
  observed_at_ms: number;
  received_at_ms: number;
};
type Interval = {
  id: string;
  bucket_id: BucketId;
  device_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  drop_ppm: number;
  reset_at_ms: number;
};
type Baseline = Quota;
async function runtime<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM monitor_runtime WHERE key=?')
    .bind(key)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}
async function state(db: D1Database, key: string, value: unknown) {
  await db
    .prepare(
      'INSERT INTO monitor_runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .bind(key, JSON.stringify(value))
    .run();
}
async function family(db: D1Database, config: MonitorConfig, now: number) {
  const result = await db.batch([
    db.prepare("SELECT id,display_name FROM members WHERE status='active'"),
    db.prepare(
      "SELECT d.*,m.display_name FROM devices d JOIN members m ON m.id=d.member_id WHERE d.revoked_at_ms IS NULL AND m.status='active'",
    ),
  ]);
  const members = result[0] as D1Result<{ id: string; display_name: string }>,
    devices = result[1] as D1Result<Device>;
  const bound = members.results.filter((m) =>
    devices.results.some((d) => d.member_id === m.id),
  ).length;
  return {
    members: members.results,
    devices: devices.results,
    bound,
    ready:
      config.enabled &&
      members.results.length >= config.expected_members &&
      bound === members.results.length,
    online: devices.results.filter((d) => isOnline(d, now)),
  };
}
function healthy(devices: Device[], now: number) {
  return (
    devices.length > 0 &&
    devices.every((d) => {
      if (d.pending_events > 0 || !d.collector_json) return false;
      const c = JSON.parse(d.collector_json) as {
        last_scan_at_ms: number;
        read_errors: number;
        native_errors: number;
        malformed_lines: number;
      };
      return (
        c.last_scan_at_ms > now - 180000 &&
        c.read_errors === 0 &&
        c.native_errors === 0 &&
        c.malformed_lines === 0
      );
    })
  );
}
function dollars(value: number) {
  return `$${(value / 1e6).toFixed(2)}`;
}
async function condition(
  db: D1Database,
  key: string,
  bad: boolean,
  message: string,
  details: Record<string, unknown>,
  config: MonitorConfig,
  now: number,
) {
  if (!bad) {
    await db.batch([
      db.prepare('DELETE FROM monitor_conditions WHERE key=?').bind(key),
      db
        .prepare(
          'UPDATE monitor_alerts SET resolved_at_ms=? WHERE condition_key=? AND resolved_at_ms IS NULL',
        )
        .bind(now, key),
      db
        .prepare(
          "UPDATE email_outbox SET status='cancelled' WHERE alert_id IN(SELECT id FROM monitor_alerts WHERE condition_key=?) AND status IN('pending','sending') AND lease_until_ms<=?",
        )
        .bind(key, now),
    ]);
    return;
  }
  const row = await db
    .prepare(
      'INSERT INTO monitor_conditions VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET bad_count=bad_count+1 RETURNING first_bad_at_ms,bad_count',
    )
    .bind(key, now)
    .first<{ first_bad_at_ms: number; bad_count: number }>();
  if (!row || row.bad_count < 2) return;
  const id = await hash(`${key}:${row.first_bad_at_ms}`);
  const alertStatement = db
    .prepare(
      'INSERT INTO monitor_alerts(id,condition_key,kind,message,details_json,created_at_ms,last_seen_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms,details_json=excluded.details_json',
    )
    .bind(id, key, key.split(':')[0], message, JSON.stringify(details), now, now);
  const slot = Math.floor((now - row.first_bad_at_ms) / (config.cooldown_minutes * 60000));
  await db.batch([
    alertStatement,
    emailStatement(
      db,
      await hash(`${id}:${slot}`),
      id,
      `[Agy] ${message}`,
      `${message}\n\n${Object.entries(details)
        .map(([k, v]) => `${k}：${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(
          '\n',
        )}\n\n这是采集与估算对账提醒，不代表有人违规使用。API 等效费用不等于官方账单；5 小时和每周档位不能相加。\n查看：https://token.lupages.com/#alerts`,
      now,
    ),
  ]);
}
function calibrationStatement(db: D1Database, bucket: BucketId) {
  return db
    .prepare(
      "SELECT capacity_micro_usd FROM quota_calibration WHERE bucket_id=? AND created_at_ms>=COALESCE((SELECT CAST(value AS INTEGER) FROM monitor_runtime WHERE key='calibration_cutoff'),0) ORDER BY created_at_ms DESC LIMIT 30",
    )
    .bind(bucket);
}
function fromSamples(
  samples: { capacity_micro_usd: number }[],
  bucket: BucketId,
  config: MonitorConfig,
) {
  const sorted = samples.map((s) => s.capacity_micro_usd).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : config.capacities[bucket];
  return {
    capacity_micro_usd: median,
    samples: samples.length,
    calibrated: samples.length >= config.calibration_samples,
  };
}
export async function calibration(db: D1Database, bucket: BucketId, config: MonitorConfig) {
  return fromSamples(
    (await calibrationStatement(db, bucket).all<{ capacity_micro_usd: number }>()).results,
    bucket,
    config,
  );
}
export async function monitorStatus(env: Env, now = Date.now(), admin = false) {
  const config = await monitorConfig(env.DB);
  const f = await family(env.DB, config, now);
  const [quotas, alerts, mail, addresses] = await Promise.all([
    env.DB.prepare(
      'SELECT q.* FROM device_quota q JOIN devices d ON d.id=q.device_id WHERE d.revoked_at_ms IS NULL ORDER BY observed_at_ms DESC',
    ).all<Quota>(),
    env.DB.prepare(
      'SELECT id,kind,message,details_json,created_at_ms,last_seen_at_ms,resolved_at_ms FROM monitor_alerts ORDER BY created_at_ms DESC LIMIT 30',
    ).all(),
    env.DB.prepare(
      'SELECT status,COUNT(*) AS count,MAX(sent_at_ms) AS last_sent_at_ms FROM email_outbox GROUP BY status',
    ).all(),
    admin ? emailConfig(env.DB) : Promise.resolve(null),
  ]);
  const buckets = await Promise.all(
    bucketIds.map(async (id) => ({
      id,
      name: bucketNames[id],
      ...(await calibration(env.DB, id, config)),
      initial_capacity_micro_usd: config.capacities[id],
      latest:
        quotas.results.find((q) => q.bucket_id === id && q.observed_at_ms > now - 600000) ?? null,
    })),
  );
  return {
    config,
    shared_pool: true,
    ready: f.ready,
    bound_members: f.bound,
    total_members: f.members.length,
    online_members: [...new Set(f.online.map((d) => d.member_id))].length,
    armed_at_ms: await runtime<number>(env.DB, 'armed_at'),
    buckets,
    alerts: alerts.results,
    email: {
      configured: !!env.ALERT_EMAIL && (admin ? !!addresses : true),
      ...(admin ? { addresses, delivery: mail.results } : {}),
    },
  };
}
async function buildIntervals(env: Env, config: MonitorConfig, armedAt: number, now: number) {
  const conflicts = new Set<BucketId>();
  const rows = (
    await env.DB.prepare(
      "SELECT q.* FROM device_quota q JOIN devices d ON d.id=q.device_id JOIN members m ON m.id=d.member_id WHERE d.revoked_at_ms IS NULL AND m.status='active' AND q.observed_at_ms>? AND q.observed_at_ms<=? ORDER BY q.observed_at_ms DESC,q.device_id",
    )
      .bind(now - 600000, now + 60000)
      .all<Quota>()
  ).results;
  const baselines = (
    await env.DB.prepare("SELECT key,value FROM monitor_runtime WHERE key LIKE 'baseline:%'").all<{
      key: string;
      value: string;
    }>()
  ).results;
  for (const id of bucketIds) {
    const candidates = rows.filter((r) => r.bucket_id === id && r.reset_at_ms > r.observed_at_ms);
    const stored = baselines.find((r) => r.key === `baseline:${id}`);
    const previous = stored ? (JSON.parse(stored.value) as Baseline) : null;
    const current = candidates.find((r) => r.device_id === previous?.device_id) ?? candidates[0];
    if (!current) continue;
    const conflict = candidates.some(
      (r) =>
        r.reset_at_ms === current.reset_at_ms &&
        Math.abs(r.observed_at_ms - current.observed_at_ms) < 60000 &&
        Math.abs(r.remaining_ppm - current.remaining_ppm) > 100000,
    );
    await condition(
      env.DB,
      `quota_disagreement:${id}`,
      conflict,
      `${bucketNames[id]}的客户端额度读数不一致`,
      { 原因: '共享池读数相差超过 10 个百分点，已暂停该档对账和校准' },
      config,
      now,
    );
    if (conflict) {
      conflicts.add(id);
      await state(env.DB, `baseline:${id}`, current);
      continue;
    }
    if (
      !previous ||
      previous.device_id !== current.device_id ||
      previous.reset_at_ms !== current.reset_at_ms ||
      previous.observed_at_ms < armedAt ||
      current.remaining_ppm > previous.remaining_ppm ||
      current.observed_at_ms - previous.observed_at_ms > 3600000
    ) {
      await state(env.DB, `baseline:${id}`, current);
      continue;
    }
    if (current.observed_at_ms <= previous.observed_at_ms) continue;
    const drop = previous.remaining_ppm - current.remaining_ppm;
    // Accumulate small changes to avoid noisy sub-percent calibration.
    if (drop < config.min_drop_ppm) continue;
    const intervalId = await hash(
      `${id}:${current.device_id}:${previous.observed_at_ms}:${current.observed_at_ms}`,
    );
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        intervalId,
        id,
        current.device_id,
        previous.observed_at_ms,
        current.observed_at_ms,
        drop,
        current.reset_at_ms,
      ),
      env.DB.prepare(
        'INSERT INTO monitor_runtime VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).bind(`baseline:${id}`, JSON.stringify(current)),
    ]);
  }
  return conflicts;
}
async function evaluateIntervals(
  env: Env,
  config: MonitorConfig,
  devices: Device[],
  armedAt: number,
  now: number,
  conflicts: Set<BucketId>,
) {
  const intervals = (
    await env.DB.prepare(
      "SELECT * FROM quota_intervals WHERE status='pending' AND ended_at_ms<=? ORDER BY ended_at_ms,id LIMIT 4",
    )
      .bind(now - config.grace_minutes * 60000)
      .all<Interval>()
  ).results;
  for (const row of intervals) {
    if (conflicts.has(row.bucket_id)) continue;
    if (row.started_at_ms < armedAt) {
      await env.DB.prepare(
        "UPDATE quota_intervals SET status='skipped',reason='before_all_bound' WHERE id=?",
      )
        .bind(row.id)
        .run();
      continue;
    }
    const group = row.bucket_id.startsWith('gemini') ? 'gemini' : 'third_party';
    const sumStatement = env.DB.prepare(
      `SELECT COALESCE(SUM(cost_micro_usd),0) AS cost,COALESCE(SUM(total_tokens),0) AS tokens,COALESCE(SUM(CASE WHEN pricing_status='unpriced' THEN total_tokens ELSE 0 END),0) AS unpriced FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<? AND ${group === 'gemini' ? "model_id LIKE 'gemini-%'" : "(model_id LIKE 'claude-%' OR model_id LIKE 'gpt-%' OR model_id LIKE 'o3%')"}`,
    ).bind(row.started_at_ms, row.ended_at_ms);
    const unknownStatement = env.DB.prepare(
      "SELECT COUNT(*) AS n FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<? AND model_id='unknown'",
    ).bind(row.started_at_ms, row.ended_at_ms);
    const loaded = await env.DB.batch([
      sumStatement,
      unknownStatement,
      calibrationStatement(env.DB, row.bucket_id),
    ]);
    const sum = (loaded[0] as D1Result<{ cost: number; tokens: number; unpriced: number }>)
      .results[0];
    const unknown = (loaded[1] as D1Result<{ n: number }>).results[0];
    const fullyPriced = sum?.unpriced === 0 && unknown?.n === 0;
    const quality = healthy(devices, now) && fullyPriced;
    const learned = fromSamples(
      (loaded[2] as D1Result<{ capacity_micro_usd: number }>).results,
      row.bucket_id,
      config,
    );
    const expected = Number(
      (BigInt(learned.capacity_micro_usd) * BigInt(row.drop_ppm) + 500000n) / 1000000n,
    );
    const cost = sum?.cost ?? 0,
      gap = Math.max(0, expected - cost);
    const large = gap >= config.min_gap_micro_usd && gap * 100 >= expected * config.gap_percent;
    // A zero-token drain is useful even during warm-up. Other gap claims require calibration.
    const bad =
      fullyPriced && large && (learned.calibrated || (sum?.tokens === 0 && row.drop_ppm >= 20000));
    await condition(
      env.DB,
      `pricing_incomplete:${row.bucket_id}`,
      !fullyPriced,
      `${bucketNames[row.bucket_id]}缺少价格，暂无法对账`,
      { 提示: '请补齐未知模型的价格或模型识别后补算；本次不判定额度缺口' },
      config,
      now,
    );
    await condition(
      env.DB,
      `quota_gap:${row.bucket_id}`,
      bad,
      `${bucketNames[row.bucket_id]}额度下降与记录用量不符`,
      {
        官方额度下降: `${(row.drop_ppm / 10000).toFixed(2)} 个百分点`,
        窗口: `${new Date(row.started_at_ms).toISOString()} — ${new Date(row.ended_at_ms).toISOString()}`,
        记录费用: dollars(cost),
        推算费用: dollars(expected),
        估算缺口: dollars(gap),
        校准: learned.calibrated ? `${learned.samples} 个有效样本` : '初始金额估值，尚未完成校准',
        采集状态: quality
          ? '在线设备上报健康'
          : '存在离线、积压、读取错误或未计价记录，请先核查客户端',
      },
      config,
      now,
    );
    let reason = quality ? 'observed' : 'collector_or_pricing_incomplete';
    if (quality && cost >= 100000 && row.drop_ppm >= config.min_drop_ppm) {
      const candidate = Number((BigInt(cost) * 1000000n) / BigInt(row.drop_ppm));
      const seed = config.capacities[row.bucket_id];
      const acceptable =
        candidate >= seed / 4 &&
        candidate <= seed * 4 &&
        (!learned.calibrated ||
          Math.abs(candidate - learned.capacity_micro_usd) <= learned.capacity_micro_usd * 0.2);
      if (acceptable && !bad) {
        await env.DB.prepare('INSERT OR IGNORE INTO quota_calibration VALUES(?,?,?,?)')
          .bind(row.id, row.bucket_id, candidate, now)
          .run();
        reason = 'calibrated';
      } else reason = 'outlier_not_learned';
    }
    await env.DB.prepare(
      "UPDATE quota_intervals SET status='evaluated',observed_micro_usd=?,expected_micro_usd=?,gap_micro_usd=?,reason=? WHERE id=?",
    )
      .bind(cost, expected, gap, reason, row.id)
      .run();
  }
  return intervals.length;
}
async function resolveBackfill(env: Env, config: MonitorConfig, now: number) {
  const windows = (
    await env.DB.prepare(
      "SELECT q.* FROM quota_intervals q WHERE q.status='evaluated' AND q.ended_at_ms>? AND EXISTS(SELECT 1 FROM monitor_alerts a WHERE a.condition_key='quota_gap:'||q.bucket_id AND a.resolved_at_ms IS NULL) AND q.ended_at_ms=(SELECT MAX(n.ended_at_ms) FROM quota_intervals n WHERE n.bucket_id=q.bucket_id AND n.status='evaluated') LIMIT 4",
    )
      .bind(now - 86400000)
      .all<Interval & { expected_micro_usd: number }>()
  ).results;
  if (!windows.length) return;
  const sums = await env.DB.batch(
    windows.map((row) =>
      env.DB.prepare(
        `SELECT COALESCE(SUM(cost_micro_usd),0) AS cost,COUNT(CASE WHEN pricing_status='unpriced' THEN 1 END) AS unpriced FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<? AND ${row.bucket_id.startsWith('gemini') ? "(model_id LIKE 'gemini-%' OR model_id='unknown')" : "(model_id LIKE 'claude-%' OR model_id LIKE 'gpt-%' OR model_id='unknown')"}`,
      ).bind(row.started_at_ms, row.ended_at_ms),
    ),
  );
  for (let i = 0; i < windows.length; i++) {
    const row = windows[i],
      sum = sums[i].results[0] as { cost: number; unpriced: number };
    const gap = Math.max(0, row.expected_micro_usd - sum.cost);
    if (
      sum.unpriced === 0 &&
      (gap < config.min_gap_micro_usd || gap * 100 < row.expected_micro_usd * config.gap_percent)
    ) {
      await condition(
        env.DB,
        `quota_gap:${row.bucket_id}`,
        false,
        '补传后记录已补齐',
        {},
        config,
        now,
      );
      await env.DB.prepare(
        'UPDATE quota_intervals SET observed_micro_usd=?,gap_micro_usd=?,reason=? WHERE id=?',
      )
        .bind(sum.cost, gap, 'backfill_reconciled', row.id)
        .run();
    }
  }
}
export async function evaluateMonitor(env: Env, now = Date.now()) {
  const owner = crypto.randomUUID();
  const acquired = await env.DB.prepare(
    'UPDATE monitor_lock SET owner=?,until_ms=? WHERE id=1 AND until_ms<=? RETURNING id',
  )
    .bind(owner, now + 120000, now)
    .first();
  if (!acquired) return;
  try {
    const config = await monitorConfig(env.DB),
      f = await family(env.DB, config, now);
    if (!f.ready) {
      await state(env.DB, 'armed_at', null);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM monitor_conditions'),
        env.DB.prepare(
          'UPDATE monitor_alerts SET resolved_at_ms=? WHERE resolved_at_ms IS NULL',
        ).bind(now),
        env.DB.prepare(
          "UPDATE email_outbox SET status='cancelled' WHERE alert_id IS NOT NULL AND status='pending'",
        ),
      ]);
      await flushEmails(env, now);
      return;
    }
    let armedAt = await runtime<number>(env.DB, 'armed_at');
    if (!armedAt) {
      armedAt = now;
      await state(env.DB, 'armed_at', now);
      await env.DB.prepare("DELETE FROM monitor_runtime WHERE key LIKE 'baseline:%'").run();
    }
    const basis = await hash(
      JSON.stringify(
        (
          await env.DB.prepare('SELECT id FROM model_prices WHERE effective_from<=? ORDER BY id')
            .bind(now)
            .all()
        ).results,
      ),
    );
    const previousBasis = await runtime<string>(env.DB, 'pricing_basis');
    if (previousBasis && previousBasis !== basis) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO monitor_runtime VALUES('calibration_cutoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(String(now)),
        env.DB.prepare("DELETE FROM monitor_runtime WHERE key LIKE 'baseline:%'"),
        env.DB.prepare(
          "UPDATE quota_intervals SET status='skipped',reason='pricing_changed' WHERE status='pending'",
        ),
      ]);
    }
    if (previousBasis !== basis) await state(env.DB, 'pricing_basis', basis);
    const since = now - config.idle_minutes * 60000;
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<=?',
    )
      .bind(since, now)
      .first<{ n: number }>();
    const noUsage =
      now - armedAt >= config.idle_minutes * 60000 && f.online.length > 0 && recent?.n === 0;
    await condition(
      env.DB,
      'no_usage:family',
      noUsage,
      '有成员在线，但全组持续未采集到新用量',
      {
        在线成员: [...new Set(f.online.map((d) => d.display_name))].join('、'),
        无用量时长: `${config.idle_minutes} 分钟`,
        提示: '电脑在线也可能只是闲置，请检查模型是否正在使用及客户端采集状态',
      },
      config,
      now,
    );
    const conflicts = await buildIntervals(env, config, armedAt, now);
    const quotaFresh = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM device_quota q JOIN devices d ON d.id=q.device_id WHERE d.revoked_at_ms IS NULL AND q.observed_at_ms>?',
    )
      .bind(now - 600000)
      .first<{ n: number }>();
    await condition(
      env.DB,
      'quota_unavailable:family',
      f.online.length > 0 && now - armedAt >= config.idle_minutes * 60000 && quotaFresh?.n === 0,
      '在线客户端均未取得官方额度读数',
      {
        提示: '请确认至少一台成员电脑安装并登录官方 Antigravity CLI，启用额度查询。Token 采集仍可继续。',
      },
      config,
      now,
    );
    const evaluated = await evaluateIntervals(env, config, f.online, armedAt, now, conflicts);
    if (evaluated === 0 && conflicts.size === 0) await resolveBackfill(env, config, now);
    await state(env.DB, 'last_check_at', now);
    await env.DB.prepare(
      "DELETE FROM quota_intervals WHERE ended_at_ms<? AND status!='pending' AND id NOT IN(SELECT interval_id FROM quota_calibration)",
    )
      .bind(now - 30 * 86400000)
      .run();
  } finally {
    await env.DB.prepare('UPDATE monitor_lock SET until_ms=0 WHERE id=1 AND owner=?')
      .bind(owner)
      .run();
  }
  await flushEmails(env, now);
}
