import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { secret, hash } from './auth';
import { memberPatchSchema, memberSchema, priceSchema, ruleSchema } from './schema';
import { dateKey, midnight, periodStart, timezone } from './time';
import { priced } from './pricing';
import type { AppEnv, Member, Price } from './types';
import { monitorConfigSchema, isOnline } from './monitor-config';
import { monitorStatus, reconcileRepriced } from './monitor';
import { emailConfig, enqueueEmail, flushEmails } from './email';
import { collectionSchema, collectionStatus, supportsControl } from './collection';

function deleteRuleStatements(db: D1Database, id: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'DELETE FROM alert_acks WHERE notification_id IN (SELECT id FROM alert_notifications WHERE rule_id=?)',
      )
      .bind(id),
    db
      .prepare(
        'DELETE FROM dashboard_alert_acks WHERE notification_id IN (SELECT id FROM alert_notifications WHERE rule_id=?)',
      )
      .bind(id),
    db.prepare('DELETE FROM alert_state WHERE rule_id=?').bind(id),
    db.prepare('DELETE FROM alert_notifications WHERE rule_id=?').bind(id),
    db.prepare('DELETE FROM alert_rules WHERE id=?').bind(id),
  ];
}

const admin = (c: Context<AppEnv>) => {
  if (c.get('member').role !== 'admin') throw new HTTPException(403, { message: 'admin_required' });
};
async function filter(c: Context<AppEnv>) {
  const tz = await timezone(c.env.DB);
  const now = Date.now();
  const calendar = (value: string) => {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 10) !== value
    )
      throw new HTTPException(400, { message: 'invalid_date' });
    return midnight(value, tz);
  };
  const from = c.req.query('from_date')
    ? calendar(c.req.query('from_date')!)
    : c.req.query('from')
      ? Number(c.req.query('from'))
      : periodStart(now, 'month', tz);
  const endDate = c.req.query('to_date');
  if (endDate) calendar(endDate);
  const next = endDate
    ? new Date(Date.parse(`${endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    : '';
  const to = endDate ? calendar(next) : c.req.query('to') ? Number(c.req.query('to')) : now + 1;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > 3660 * 86400000
  )
    throw new HTTPException(400, { message: 'invalid_range' });
  const args: (string | number)[] = [from, to];
  let sql = 'u.occurred_at_ms>=? AND u.occurred_at_ms<?';
  for (const [query, column] of [
    ['member_id', 'member_id'],
    ['model_id', 'model_id'],
    ['source', 'source'],
  ] as const) {
    const value = c.req.query(query);
    if (value) {
      if (value.length > 160) throw new HTTPException(400, { message: 'invalid_filter' });
      sql += ` AND u.${column}=?`;
      args.push(value);
    }
  }
  return { sql, args, from, to, tz };
}
const totals = `COALESCE(SUM(total_tokens),0) AS total_tokens,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,CASE WHEN COUNT(*)=0 THEN 0 ELSE SUM(cost_micro_usd) END AS cost_micro_usd,COALESCE(SUM(CASE WHEN pricing_status='unpriced' THEN total_tokens ELSE 0 END),0) AS unpriced_tokens,COUNT(*) AS events`;
const emptyTotals = {
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_micro_usd: 0,
  unpriced_tokens: 0,
  events: 0,
};
export const dashboard = new Hono<AppEnv>();
dashboard.get('/me', (c) => c.json({ member: c.get('member') }));
dashboard.get('/summary', async (c) => {
  const f = await filter(c);
  const now = Date.now();
  const query = (start: number) =>
    c.env.DB.prepare(
      `SELECT ${totals} FROM usage_events u WHERE u.occurred_at_ms>=? AND u.occurred_at_ms<=?`,
    ).bind(start, now);
  const result = await c.env.DB.batch<Record<string, unknown>>([
    query(periodStart(now, 'day', f.tz)),
    query(periodStart(now, 'week', f.tz)),
    query(periodStart(now, 'month', f.tz)),
    c.env.DB.prepare(`SELECT ${totals} FROM usage_events u WHERE ${f.sql}`).bind(...f.args),
    c.env.DB.prepare(
      'SELECT MAX(last_seen_at_ms) AS last_report_ms FROM devices WHERE revoked_at_ms IS NULL',
    ),
  ]);
  return c.json({
    today: result[0].results[0],
    week: result[1].results[0],
    month: result[2].results[0],
    selected: result[3].results[0],
    ...result[4].results[0],
    timezone: f.tz,
  });
});
dashboard.get('/members', async (c) => {
  const now = Date.now();
  const tz = await timezone(c.env.DB);
  const members = (
    await c.env.DB.prepare(
      'SELECT id,display_name,email,role,status,notifications_enabled FROM members ORDER BY created_at_ms',
    ).all()
  ).results;
  const rows = await c.env.DB.batch<Record<string, unknown>>(
    ['day', 'week', 'month'].map((p) =>
      c.env.DB.prepare(
        `SELECT member_id,${totals} FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<=? GROUP BY member_id`,
      ).bind(periodStart(now, p, tz), now),
    ),
  );
  const devices = (
    await c.env.DB.prepare(
      'SELECT member_id,MAX(last_seen_at_ms) AS last_report_ms FROM devices WHERE revoked_at_ms IS NULL GROUP BY member_id',
    ).all()
  ).results;
  const presence = (
    await c.env.DB.prepare(
      'SELECT member_id,last_seen_at_ms,last_heartbeat_at_ms,agent_version FROM devices WHERE revoked_at_ms IS NULL',
    ).all<{
      member_id: string;
      last_seen_at_ms: number | null;
      last_heartbeat_at_ms: number | null;
      agent_version: string | null;
    }>()
  ).results;
  return c.json({
    items: members.map((m) => ({
      ...m,
      email: c.get('member').role === 'admin' ? m.email : null,
      notifications_enabled: c.get('member').role === 'admin' ? m.notifications_enabled : undefined,
      online: presence.some((d) => d.member_id === m.id && isOnline(d, now)),
      device_count: presence.filter((d) => d.member_id === m.id).length,
      today: rows[0].results.find((r) => r.member_id === m.id) ?? emptyTotals,
      week: rows[1].results.find((r) => r.member_id === m.id) ?? emptyTotals,
      month: rows[2].results.find((r) => r.member_id === m.id) ?? emptyTotals,
      last_report_ms: devices.find((d) => d.member_id === m.id)?.last_report_ms ?? null,
    })),
  });
});
dashboard.get('/usage', async (c) => {
  const f = await filter(c);
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(c.req.query('page') ?? 1);
  const size = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(c.req.query('page_size') ?? 25);
  const result = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT u.id,u.member_id,m.display_name,u.model_id,u.model_display,u.source,u.occurred_at_ms,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,u.total_tokens,u.cost_micro_usd,u.pricing_status,p.catalog_version FROM usage_events u JOIN members m ON m.id=u.member_id LEFT JOIN model_prices p ON p.id=u.price_id WHERE ${f.sql} ORDER BY u.occurred_at_ms DESC,u.device_id,u.id LIMIT ? OFFSET ?`,
    ).bind(...f.args, size, (page - 1) * size),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM usage_events u WHERE ${f.sql}`).bind(...f.args),
  ]);
  return c.json({
    items: result[0].results,
    total: result[1].results[0].total,
    page,
    page_size: size,
  });
});
dashboard.get('/models', async (c) => {
  const f = await filter(c);
  const rows = await c.env.DB.prepare(
    `SELECT model_id,MAX(model_display) AS model_display,member_id,${totals} FROM usage_events u WHERE ${f.sql} GROUP BY model_id,member_id ORDER BY total_tokens DESC`,
  )
    .bind(...f.args)
    .all();
  return c.json({ items: rows.results });
});
dashboard.get('/trends', async (c) => {
  const f = await filter(c);
  const rows = await c.env.DB.prepare(
    `SELECT occurred_at_ms,total_tokens,cost_micro_usd,pricing_status FROM usage_events u WHERE ${f.sql} ORDER BY occurred_at_ms`,
  )
    .bind(...f.args)
    .all<{
      occurred_at_ms: number;
      total_tokens: number;
      cost_micro_usd: number | null;
      pricing_status: string;
    }>();
  const days = new Map<
    string,
    { date: string; total_tokens: number; cost_micro_usd: number | null; unpriced_tokens: number }
  >();
  for (const row of rows.results) {
    const key = dateKey(row.occurred_at_ms, f.tz);
    const value = days.get(key) ?? {
      date: key,
      total_tokens: 0,
      cost_micro_usd: null,
      unpriced_tokens: 0,
    };
    value.total_tokens += row.total_tokens;
    if (row.cost_micro_usd !== null)
      value.cost_micro_usd = (value.cost_micro_usd ?? 0) + row.cost_micro_usd;
    if (row.pricing_status === 'unpriced') value.unpriced_tokens += row.total_tokens;
    days.set(key, value);
  }
  return c.json({ items: [...days.values()], timezone: f.tz });
});
dashboard.get('/alerts', async (c) => {
  const member = c.get('member');
  const rows = await c.env.DB.prepare(
    'SELECT n.*,r.metric,m.display_name,EXISTS(SELECT 1 FROM dashboard_alert_acks a WHERE a.notification_id=n.id AND a.member_id=?) AS acknowledged FROM alert_notifications n JOIN alert_rules r ON r.id=n.rule_id LEFT JOIN members m ON m.id=n.member_id ORDER BY created_at_ms DESC LIMIT 200',
  )
    .bind(member.id)
    .all();
  return c.json({ items: rows.results });
});
dashboard.post('/alerts/:id/ack', async (c) => {
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO dashboard_alert_acks SELECT ?,id,? FROM alert_notifications WHERE id=?',
  )
    .bind(c.get('member').id, Date.now(), c.req.param('id'))
    .run();
  return c.json({ success: true });
});
dashboard.get('/rules', async (c) =>
  c.json({
    items: (await c.env.DB.prepare('SELECT * FROM alert_rules ORDER BY id').all()).results,
  }),
);
dashboard.put('/rules', async (c) => {
  admin(c);
  const rules = z
    .array(ruleSchema)
    .max(50)
    .parse(await c.req.json())
    .map((rule) => ({ ...rule, id: rule.id ?? crypto.randomUUID() }));
  const existing = (await c.env.DB.prepare('SELECT id FROM alert_rules').all<{ id: string }>())
    .results;
  const keep = new Set(rules.map((r) => r.id));
  const statements: D1PreparedStatement[] = [];
  for (const old of existing) {
    if (!keep.has(old.id)) statements.push(...deleteRuleStatements(c.env.DB, old.id));
  }
  for (const rule of rules)
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO alert_rules VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,member_id=excluded.member_id,metric=excluded.metric,period=excluded.period,threshold_value=excluded.threshold_value,enabled=excluded.enabled',
      ).bind(
        rule.id,
        rule.scope,
        rule.scope === 'family' ? null : rule.member_id,
        rule.metric,
        rule.period,
        rule.threshold_value,
        Number(rule.enabled),
      ),
    );
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ success: true });
});
dashboard.delete('/rules/:id', async (c) => {
  admin(c);
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM alert_rules WHERE id=?')
    .bind(id)
    .first();
  if (!existing) return c.json({ error: 'rule_not_found' }, 404);
  await c.env.DB.batch(deleteRuleStatements(c.env.DB, id));
  return c.json({ success: true });
});
dashboard.post('/members', async (c) => {
  admin(c);
  const member = memberSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const result = await c.env.DB.prepare(
    "INSERT INTO members(id,email,display_name,role,created_at_ms) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM members WHERE status='active')<6",
  )
    .bind(id, member.email, member.display_name, member.role, Date.now())
    .run();
  if (result.meta.changes !== 1) return c.json({ error: 'family_limit_reached' }, 409);
  return c.json({ id }, 201);
});
dashboard.patch('/members/:id', async (c) => {
  const actor = c.get('member');
  const id = c.req.param('id');
  const body = memberPatchSchema.parse(await c.req.json());
  if (actor.role !== 'admin') {
    if (
      id !== actor.id ||
      body.notifications_enabled === undefined ||
      body.display_name !== undefined ||
      body.email !== undefined ||
      body.status !== undefined
    )
      throw new HTTPException(403, { message: 'read_only_member' });
    await c.env.DB.prepare('UPDATE members SET notifications_enabled=? WHERE id=?')
      .bind(Number(body.notifications_enabled), actor.id)
      .run();
    return c.json({ success: true });
  }
  const target = await c.env.DB.prepare(
    'SELECT id,email,display_name,role,status,notifications_enabled FROM members WHERE id=?',
  )
    .bind(id)
    .first<Member>();
  if (!target) return c.json({ error: 'member_not_found' }, 404);
  if (body.status === 'inactive' && (target.role === 'admin' || target.id === actor.id))
    return c.json({ error: 'cannot_deactivate_admin' }, 400);
  if (body.status === 'active' && target.status !== 'active') {
    const active = await c.env.DB.prepare(
      "SELECT count(*) AS n FROM members WHERE status='active' AND id!=?",
    )
      .bind(id)
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= 6) return c.json({ error: 'family_limit_reached' }, 409);
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'UPDATE members SET display_name=?,email=?,status=?,notifications_enabled=? WHERE id=?',
    ).bind(
      body.display_name ?? target.display_name,
      body.email ?? target.email,
      body.status ?? target.status,
      body.notifications_enabled === undefined
        ? target.notifications_enabled
        : Number(body.notifications_enabled),
      id,
    ),
  ];
  if (body.status === 'inactive' && target.status !== 'inactive') {
    statements.push(
      c.env.DB.prepare(
        'UPDATE devices SET revoked_at_ms=? WHERE member_id=? AND revoked_at_ms IS NULL',
      ).bind(now, id),
      c.env.DB.prepare(
        'UPDATE enrollment_codes SET expires_at_ms=? WHERE member_id=? AND used_at_ms IS NULL AND expires_at_ms>?',
      ).bind(now, id, now),
      c.env.DB.prepare(
        "UPDATE collection_requests SET status='expired' WHERE status='pending' AND device_id IN (SELECT id FROM devices WHERE member_id=?)",
      ).bind(id),
    );
  }
  await c.env.DB.batch(statements);
  return c.json({ success: true });
});
dashboard.put('/preferences', async (c) => {
  const body = z.strictObject({ notifications_enabled: z.boolean() }).parse(await c.req.json());
  await c.env.DB.prepare('UPDATE members SET notifications_enabled=? WHERE id=?')
    .bind(Number(body.notifications_enabled), c.get('member').id)
    .run();
  return c.json({ success: true });
});
dashboard.post('/enrollments', async (c) => {
  admin(c);
  const { member_id } = z
    .strictObject({ member_id: z.string().min(1).max(80) })
    .parse(await c.req.json());
  if (
    !(await c.env.DB.prepare("SELECT id FROM members WHERE id=? AND status='active'")
      .bind(member_id)
      .first())
  )
    return c.json({ error: 'member_not_found' }, 404);
  const code = secret();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO enrollment_codes VALUES(?,?,?,NULL,?)')
    .bind(await hash(code), member_id, now + 900000, now)
    .run();
  return c.json({ code, expires_at_ms: now + 900000 }, 201);
});
dashboard.delete('/devices/:id', async (c) => {
  admin(c);
  await c.env.DB.prepare('UPDATE devices SET revoked_at_ms=? WHERE id=?')
    .bind(Date.now(), c.req.param('id'))
    .run();
  return c.json({ success: true });
});
dashboard.get('/settings', async (c) => {
  const member = c.get('member');
  return c.json({
    timezone: await timezone(c.env.DB),
    notifications_enabled: !!member.notifications_enabled,
    collection: await collectionStatus(c.env.DB),
    monitor: await monitorStatus(c.env, Date.now(), member.role === 'admin'),
    prices: (
      await c.env.DB.prepare(
        'SELECT rowid AS catalog_revision,* FROM model_prices ORDER BY effective_from DESC,model_id',
      ).all()
    ).results,
    devices: (
      await c.env.DB.prepare(
        `SELECT d.id,d.member_id,d.device_label,d.last_seen_at_ms,d.last_heartbeat_at_ms,d.agent_version,d.pending_events,d.revoked_at_ms,m.display_name FROM devices d JOIN members m ON m.id=d.member_id ${member.role === 'admin' ? '' : 'WHERE d.member_id=?'} ORDER BY d.created_at_ms`,
      )
        .bind(...(member.role === 'admin' ? [] : [member.id]))
        .all()
    ).results,
  });
});
dashboard.put('/settings', async (c) => {
  admin(c);
  const body = z.strictObject({ timezone: z.string().max(100) }).parse(await c.req.json());
  try {
    new Intl.DateTimeFormat('en', { timeZone: body.timezone }).format();
  } catch {
    return c.json({ error: 'invalid_timezone' }, 400);
  }
  await c.env.DB.prepare("UPDATE settings SET value=? WHERE key='timezone'")
    .bind(body.timezone)
    .run();
  return c.json({ success: true });
});
dashboard.post('/prices', async (c) => {
  admin(c);
  const price = priceSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO model_prices VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(
      id,
      price.model_id,
      price.input_price,
      price.output_price,
      price.cache_read_price,
      price.cache_write_price,
      price.effective_from,
      price.catalog_version,
      price.source,
    )
    .run();
  return c.json({ id }, 201);
});
dashboard.get('/collection', async (c) => {
  admin(c);
  return c.json(await collectionStatus(c.env.DB));
});
dashboard.put('/collection/settings', async (c) => {
  admin(c);
  const body = collectionSchema.parse(await c.req.json());
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings VALUES('collection_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(JSON.stringify(body)),
    c.env.DB.prepare("DELETE FROM monitor_runtime WHERE key='armed_at' OR key LIKE 'baseline:%'"),
    c.env.DB.prepare(
      "INSERT INTO monitor_runtime VALUES('calibration_cutoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(String(now)),
    c.env.DB.prepare(
      "UPDATE quota_intervals SET status='skipped',reason='collection_configuration_changed' WHERE status='pending'",
    ),
    c.env.DB.prepare('DELETE FROM monitor_conditions'),
    c.env.DB.prepare(
      'UPDATE monitor_alerts SET resolved_at_ms=? WHERE resolved_at_ms IS NULL',
    ).bind(now),
    c.env.DB.prepare(
      "UPDATE email_outbox SET status='cancelled' WHERE alert_id IS NOT NULL AND status='pending'",
    ),
  ]);
  return c.json({ success: true });
});
dashboard.post('/collection/run', async (c) => {
  admin(c);
  const body = z
    .strictObject({ device_id: z.string().min(1).max(80).optional() })
    .parse(await c.req.json());
  const now = Date.now();
  const devices = (
    await c.env.DB.prepare(
      "SELECT d.id,d.agent_version FROM devices d JOIN members m ON m.id=d.member_id WHERE d.revoked_at_ms IS NULL AND m.status='active'" +
        (body.device_id ? ' AND d.id=?' : ''),
    )
      .bind(...(body.device_id ? [body.device_id] : []))
      .all<{ id: string; agent_version: string | null }>()
  ).results.filter((d) => supportsControl(d.agent_version));
  if (!devices.length) return c.json({ error: 'no_supported_devices' }, 409);
  await c.env.DB.prepare(
    "UPDATE collection_requests SET status='expired' WHERE status='pending' AND expires_at_ms<=?",
  )
    .bind(now)
    .run();
  await c.env.DB.batch(
    devices.map((d) =>
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO collection_requests(id,device_id,requested_at_ms,expires_at_ms) VALUES(?,?,?,?)',
      ).bind(crypto.randomUUID(), d.id, now, now + 900000),
    ),
  );
  return c.json({ success: true, devices: devices.length, expires_at_ms: now + 900000 }, 202);
});
dashboard.get('/monitor/overview', async (c) => {
  const status = await monitorStatus(c.env);
  return c.json({
    ready: status.ready,
    collection_active: status.collection_active,
    expected_members: status.config.expected_members,
    bound_members: status.bound_members,
    total_members: status.total_members,
    online_members: status.online_members,
    alerts: status.alerts,
  });
});
dashboard.get('/monitor', (c) =>
  monitorStatus(c.env, Date.now(), c.get('member').role === 'admin').then((result) =>
    c.json(result),
  ),
);
dashboard.put('/monitor/settings', async (c) => {
  admin(c);
  const config = monitorConfigSchema.parse(await c.req.json());
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO settings VALUES('monitor_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(JSON.stringify(config)),
    c.env.DB.prepare(
      "INSERT INTO monitor_runtime VALUES('calibration_cutoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(String(now)),
    c.env.DB.prepare("DELETE FROM monitor_runtime WHERE key='armed_at' OR key LIKE 'baseline:%'"),
    c.env.DB.prepare(
      "UPDATE quota_intervals SET status='skipped',reason='configuration_changed' WHERE status='pending'",
    ),
    c.env.DB.prepare('DELETE FROM monitor_conditions'),
    c.env.DB.prepare(
      'UPDATE monitor_alerts SET resolved_at_ms=? WHERE resolved_at_ms IS NULL',
    ).bind(now),
    c.env.DB.prepare(
      "UPDATE email_outbox SET status='cancelled' WHERE alert_id IS NOT NULL AND status='pending'",
    ),
  ]);
  return c.json({ success: true });
});
dashboard.post('/monitor/reset-calibration', async (c) => {
  admin(c);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO monitor_runtime VALUES('calibration_cutoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(String(now)),
    c.env.DB.prepare("DELETE FROM monitor_runtime WHERE key='armed_at' OR key LIKE 'baseline:%'"),
    c.env.DB.prepare(
      "UPDATE quota_intervals SET status='skipped',reason='calibration_reset' WHERE status='pending'",
    ),
    c.env.DB.prepare('DELETE FROM monitor_conditions'),
    c.env.DB.prepare(
      'UPDATE monitor_alerts SET resolved_at_ms=? WHERE resolved_at_ms IS NULL',
    ).bind(now),
    c.env.DB.prepare(
      "UPDATE email_outbox SET status='cancelled' WHERE alert_id IS NOT NULL AND status='pending'",
    ),
  ]);
  return c.json({ success: true });
});
dashboard.post('/monitor/test-email', async (c) => {
  admin(c);
  if (!c.env.ALERT_EMAIL || !(await emailConfig(c.env.DB)))
    return c.json({ error: 'email_not_configured' }, 503);
  const now = Date.now(),
    id = `test:${Math.floor(now / 300000)}`;
  await enqueueEmail(
    c.env.DB,
    id,
    null,
    '[Agy] 告警邮件发送测试',
    '这是一封由管理员触发的测试邮件，不代表真实用量异常。\n查看网站：https://token.lupages.com/#settings',
    now,
  );
  await flushEmails(c.env, now, id);
  const result = await c.env.DB.prepare('SELECT status,last_error FROM email_outbox WHERE id=?')
    .bind(id)
    .first();
  return c.json(result);
});
dashboard.post('/monitor/retry-email', async (c) => {
  admin(c);
  await c.env.DB.prepare(
    "UPDATE email_outbox SET status='pending',attempts=0,available_at_ms=?,lease_until_ms=0 WHERE status='failed'",
  )
    .bind(Date.now())
    .run();
  await flushEmails(c.env);
  return c.json({ success: true });
});
dashboard.post('/reprice', async (c) => {
  admin(c);
  const body = z.strictObject({ after: z.string().max(300).default('') }).parse(await c.req.json());
  const rows = (
    await c.env.DB.prepare(
      "SELECT * FROM usage_events WHERE pricing_status='unpriced' AND (device_id||':'||id)>? ORDER BY device_id,id LIMIT 100",
    )
      .bind(body.after)
      .all<Record<string, any>>()
  ).results;
  const prices = (
    await c.env.DB.prepare('SELECT rowid AS catalog_revision,* FROM model_prices').all<Price>()
  ).results;
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const result = priced(
      {
        event_id: row.id,
        session_key: row.session_key,
        step_index: row.step_index,
        source: row.source,
        model_id: row.model_id,
        model_display: row.model_display,
        occurred_at_ms: row.occurred_at_ms,
        tokens: {
          input: row.input_tokens,
          output: row.output_tokens,
          cache_read: row.cache_read_tokens,
          cache_write: row.cache_write_tokens,
        },
      },
      prices,
    );
    if (result.price_id)
      updates.push(
        c.env.DB.prepare(
          "UPDATE usage_events SET cost_micro_usd=?,price_id=?,pricing_status='priced' WHERE device_id=? AND id=? AND pricing_status='unpriced'",
        ).bind(result.cost_micro_usd, result.price_id, row.device_id, row.id),
      );
  }
  if (updates.length) await c.env.DB.batch(updates);
  if (updates.length || rows.length < 100) await reconcileRepriced(c.env, Date.now());
  const last = rows.at(-1);
  return c.json({
    updated: updates.length,
    next_cursor: last ? `${last.device_id}:${last.id}` : body.after,
    has_more: rows.length === 100,
  });
});
