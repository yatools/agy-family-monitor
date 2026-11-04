import { Hono } from 'hono';
import { z } from 'zod';
import { hash, secret } from './auth';
import { batchSchema, enrollSchema } from './schema';
import { priced } from './pricing';
import { evaluateAlerts } from './alerts';
import { bucketIds } from './monitor-config';
import { collectionConfig } from './collection';
import type { AppEnv, Price } from './types';

export const agent = new Hono<AppEnv>();
agent.post('/enroll', async (c) => {
  const body = enrollSchema.parse(await c.req.json());
  const now = Date.now();
  const bucket = await hash(
    `${c.req.header('CF-Connecting-IP') ?? 'local'}:${Math.floor(now / 60000)}`,
  );
  const limit = await c.env.DB.prepare(
    'INSERT INTO enrollment_rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts',
  )
    .bind(bucket, now + 120000)
    .first<{ attempts: number }>();
  if ((limit?.attempts ?? 99) > 5) return c.json({ error: 'rate_limited' }, 429);
  await c.env.DB.prepare('DELETE FROM enrollment_rate_limits WHERE expires_at_ms<?')
    .bind(now)
    .run();
  const codeHash = await hash(body.code);
  const deviceId = crypto.randomUUID();
  const token = secret();
  const tokenHash = await hash(token);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO devices(id,member_id,device_label,token_hash,platform,agent_version,created_at_ms) SELECT ?,e.member_id,?,?,?,?,? FROM enrollment_codes e JOIN members m ON m.id=e.member_id WHERE e.code_hash=? AND e.used_at_ms IS NULL AND e.expires_at_ms>? AND m.status='active'`,
    ).bind(
      deviceId,
      body.device_label,
      tokenHash,
      body.platform,
      body.agent_version,
      now,
      codeHash,
      now,
    ),
    c.env.DB.prepare(
      'UPDATE enrollment_codes SET used_at_ms=? WHERE code_hash=? AND EXISTS(SELECT 1 FROM devices WHERE id=?)',
    ).bind(now, codeHash, deviceId),
  ]);
  if (result[0].meta.changes !== 1) return c.json({ error: 'invalid_or_expired_code' }, 400);
  return c.json({ device_id: deviceId, device_token: token, pseudonym_key: secret() }, 201);
});
agent.use('*', async (c, next) => {
  const authorization = c.req.header('Authorization') ?? '';
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization))
    return c.json({ error: 'device_unauthorized' }, 401);
  const device = await c.env.DB.prepare(
    "SELECT d.id,d.member_id FROM devices d JOIN members m ON m.id=d.member_id WHERE d.token_hash=? AND d.revoked_at_ms IS NULL AND m.status='active'",
  )
    .bind(await hash(authorization.slice(7)))
    .first<{ id: string; member_id: string }>();
  if (!device) return c.json({ error: 'device_unauthorized' }, 401);
  c.set('device', device);
  await next();
});
agent.post('/heartbeat', async (c) => {
  const body = z
    .strictObject({
      agent_version: z.string().max(40),
      pending_events: z.int().nonnegative(),
      notifications_enabled: z.boolean(),
      collector: z
        .strictObject({
          last_scan_at_ms: z.int().nonnegative(),
          sessions: z.int().nonnegative().max(1000000),
          read_errors: z.int().nonnegative(),
          native_errors: z.int().nonnegative(),
          malformed_lines: z.int().nonnegative(),
          collection_enabled: z.boolean().optional(),
          collection_interval_seconds: z.int().min(60).max(3600).optional(),
        })
        .optional(),
      quota_status: z.enum(['ok', 'not_installed', 'error', 'disabled']).optional(),
      collection_ack: z
        .strictObject({ request_id: z.uuid(), status: z.enum(['completed', 'failed']) })
        .optional(),
      quota: z
        .array(
          z.strictObject({
            bucket_id: z.enum(bucketIds),
            remaining_ppm: z.int().min(0).max(1000000),
            reset_at_ms: z.int().positive(),
            observed_at_ms: z.int().positive(),
          }),
        )
        .max(4)
        .optional(),
    })
    .parse(await c.req.json());
  const now = Date.now();
  if (body.collector && body.collector.last_scan_at_ms > now + 60000)
    return c.json({ error: 'future_collector' }, 400);
  if (new Set(body.quota?.map((q) => q.bucket_id)).size !== (body.quota?.length ?? 0))
    return c.json({ error: 'duplicate_quota' }, 400);
  if (
    body.quota?.some(
      (q) =>
        q.observed_at_ms > now + 60000 ||
        q.observed_at_ms < now - 900000 ||
        q.reset_at_ms <= q.observed_at_ms,
    )
  )
    return c.json({ error: 'invalid_quota_time' }, 400);
  const statements = [
    c.env.DB.prepare(
      'UPDATE devices SET last_seen_at_ms=?,last_heartbeat_at_ms=?,agent_version=?,pending_events=?,collector_json=? WHERE id=? AND revoked_at_ms IS NULL',
    ).bind(
      now,
      now,
      body.agent_version,
      body.pending_events,
      body.collector
        ? JSON.stringify({ ...body.collector, quota_status: body.quota_status ?? 'error' })
        : null,
      c.get('device').id,
    ),
  ];
  for (const q of body.quota ?? [])
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO device_quota VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,bucket_id) DO UPDATE SET remaining_ppm=excluded.remaining_ppm,reset_at_ms=excluded.reset_at_ms,observed_at_ms=excluded.observed_at_ms,received_at_ms=excluded.received_at_ms WHERE excluded.observed_at_ms>device_quota.observed_at_ms',
      ).bind(
        c.get('device').id,
        q.bucket_id,
        q.remaining_ppm,
        q.reset_at_ms,
        q.observed_at_ms,
        now,
      ),
    );
  await c.env.DB.batch(statements);
  if (body.collection_ack)
    await c.env.DB.prepare(
      "UPDATE collection_requests SET status=?,acknowledged_at_ms=? WHERE id=? AND device_id=? AND status='pending' AND expires_at_ms>?",
    )
      .bind(
        body.collection_ack.status,
        now,
        body.collection_ack.request_id,
        c.get('device').id,
        now,
      )
      .run();
  await c.env.DB.prepare(
    "UPDATE collection_requests SET status='expired' WHERE device_id=? AND status='pending' AND expires_at_ms<=?",
  )
    .bind(c.get('device').id, now)
    .run();
  const request = await c.env.DB.prepare(
    "SELECT id,requested_at_ms FROM collection_requests WHERE device_id=? AND status='pending' ORDER BY requested_at_ms,id LIMIT 1",
  )
    .bind(c.get('device').id)
    .first();
  return c.json({
    success: true,
    collection: await collectionConfig(c.env.DB),
    collection_request: request,
  });
});
agent.post('/events', async (c) => {
  const body = batchSchema.parse(await c.req.json());
  if (new Set(body.events.map((e) => e.event_id)).size !== body.events.length)
    return c.json({ error: 'duplicate_batch_ids' }, 400);
  const device = c.get('device');
  const now = Date.now();
  if (body.events.some((e) => e.occurred_at_ms > now + 300000))
    return c.json({ error: 'future_event' }, 400);
  const prices = (
    await c.env.DB.prepare('SELECT rowid AS catalog_revision,* FROM model_prices').all<Price>()
  ).results;
  let inserted = 0,
    updated = 0,
    unchanged = 0;
  const statements: D1PreparedStatement[] = [];
  for (const event of body.events) {
    const digest = await hash(JSON.stringify(event));
    const price = priced(event, prices);
    const t = event.tokens;
    const total = t.input + t.output + t.cache_read + t.cache_write;
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO usage_events(id,device_id,member_id,session_key,step_index,model_id,model_display,source,occurred_at_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,pricing_status,cost_micro_usd,price_id,updated_at_ms,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,id) DO NOTHING`,
      ).bind(
        event.event_id,
        device.id,
        device.member_id,
        event.session_key,
        event.step_index,
        event.model_id,
        event.model_display,
        event.source,
        event.occurred_at_ms,
        t.input,
        t.output,
        t.cache_read,
        t.cache_write,
        total,
        price.pricing_status,
        price.cost_micro_usd,
        price.price_id,
        now,
        digest,
      ),
    );
    statements.push(
      c.env.DB.prepare(
        'UPDATE usage_events SET model_id=?,model_display=?,source=?,occurred_at_ms=?,input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,total_tokens=?,pricing_status=?,cost_micro_usd=?,price_id=?,updated_at_ms=?,payload_hash=? WHERE device_id=? AND id=? AND payload_hash!=?',
      ).bind(
        event.model_id,
        event.model_display,
        event.source,
        event.occurred_at_ms,
        t.input,
        t.output,
        t.cache_read,
        t.cache_write,
        total,
        price.pricing_status,
        price.cost_micro_usd,
        price.price_id,
        now,
        digest,
        device.id,
        event.event_id,
        digest,
      ),
    );
  }
  statements.push(
    c.env.DB.prepare('UPDATE devices SET last_seen_at_ms=? WHERE id=?').bind(now, device.id),
  );
  const results = await c.env.DB.batch(statements);
  for (let i = 0; i < body.events.length; i++) {
    inserted += results[i * 2].meta.changes;
    updated += results[i * 2 + 1].meta.changes;
  }
  unchanged = body.events.length - inserted - updated;
  await evaluateAlerts(c.env.DB, now);
  return c.json({ success: true, inserted, updated, unchanged, server_time_ms: now });
});
agent.get('/alerts', async (c) => {
  const cursor = c.req.query('after') ?? '';
  let after = 0;
  let id = '';
  if (cursor) {
    try {
      if (cursor.length > 512) throw new Error();
      const parsed = z
        .tuple([z.int().nonnegative(), z.string().max(100)])
        .safeParse(JSON.parse(atob(cursor)));
      if (!parsed.success) throw new Error();
      [after, id] = parsed.data;
    } catch {
      return c.json({ error: 'invalid_cursor' }, 400);
    }
  }
  const notifications = (
    await c.env.DB.prepare(
      'SELECT id,message,created_at_ms FROM alert_notifications WHERE created_at_ms>? OR (created_at_ms=? AND id>?) ORDER BY created_at_ms,id LIMIT 100',
    )
      .bind(after, after, id)
      .all<{ id: string; message: string; created_at_ms: number }>()
  ).results;
  const last = notifications.at(-1);
  const preference = await c.env.DB.prepare('SELECT notifications_enabled FROM members WHERE id=?')
    .bind(c.get('device').member_id)
    .first<{ notifications_enabled: number }>();
  return c.json({
    notifications,
    next_cursor: last ? btoa(JSON.stringify([last.created_at_ms, last.id])) : cursor,
    notifications_enabled: preference?.notifications_enabled !== 0,
  });
});
agent.post('/alerts/ack', async (c) => {
  const body = z
    .strictObject({ notification_ids: z.array(z.string().max(100)).max(100) })
    .parse(await c.req.json());
  if (body.notification_ids.length)
    await c.env.DB.batch(
      body.notification_ids.map((id) =>
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO alert_acks SELECT ?,id,? FROM alert_notifications WHERE id=?',
        ).bind(c.get('device').id, Date.now(), id),
      ),
    );
  return c.json({ success: true });
});
