import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { createApp } from '../src/index';
import { accessEmail, hash } from '../src/auth';
import { evaluateAlerts } from '../src/alerts';
import { midnight, periodStart } from '../src/time';
import { priced } from '../src/pricing';
import { evaluateMonitor, calibration, monitorStatus } from '../src/monitor';
import { defaultMonitorConfig, bucketIds, isOnline } from '../src/monitor-config';
import { enqueueEmail, flushEmails } from '../src/email';
import type { Env } from '../src/types';

let mf: Miniflare;
let db: D1Database;
let env: Env;
let privateKey: CryptoKey;
let app: ReturnType<typeof createApp>;
const email = (id: string) => `${id}@example.test`;
async function jwt(id = 'admin', aud = 'test-aud', expires = '1h') {
  return new SignJWT({ email: email(id) })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject(id)
    .setIssuer('https://test-team.cloudflareaccess.com')
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(privateKey);
}
async function dashboard(path: string, method = 'GET', body?: unknown, id = 'admin') {
  return app.request(
    `/api/v1/dashboard${path}`,
    {
      method,
      headers: { 'Cf-Access-Jwt-Assertion': await jwt(id), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}
async function device(id = 'd1', member = 'member') {
  const token = await hash(id);
  await db
    .prepare(
      'INSERT INTO devices(id,member_id,device_label,token_hash,platform,created_at_ms) VALUES(?,?,?,?,?,?)',
    )
    .bind(id, member, id, await hash(token), 'windows-x64', Date.now())
    .run();
  return token;
}
function event(id = 'a', input = 10, model = 'custom-model') {
  return {
    event_id: id.repeat(64),
    session_key: 'f'.repeat(64),
    step_index: 1,
    source: 'antigravity_cli' as const,
    model_id: model,
    model_display: model,
    occurred_at_ms: Date.now(),
    tokens: { input, output: 2, cache_read: 3, cache_write: 4 },
  };
}
async function upload(token: string, events = [event()]) {
  return app.request(
    '/api/v1/agent/events',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id: 'e'.repeat(64), agent_version: '0.1.0', events }),
    },
    env,
  );
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: '2026-11-04',
      d1Databases: { DB: 'integration' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const file of [
    '0001_initial.sql',
    '0002_reference_prices.sql',
    '0003_monitoring.sql',
    '0004_official_prices.sql',
    '0005_collection_control.sql',
  ]) {
    const sql = readFileSync(
      fileURLToPath(new NodeURL(`../migrations/${file}`, import.meta.url)),
      'utf8',
    );
    for (const statement of sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  const key = await exportJWK(keys.publicKey);
  key.kid = 'test';
  app = createApp(createLocalJWKSet({ keys: [key] }));
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('assets') } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
    ACCESS_AUD: 'test-aud',
  };
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  for (const table of [
    'collection_requests',
    'email_outbox',
    'monitor_alerts',
    'monitor_conditions',
    'quota_calibration',
    'quota_intervals',
    'device_quota',
    'monitor_runtime',
    'alert_acks',
    'dashboard_alert_acks',
    'alert_state',
    'alert_notifications',
    'alert_rules',
    'usage_events',
    'enrollment_codes',
    'devices',
    'members',
    'enrollment_rate_limits',
    'model_prices',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare('UPDATE monitor_lock SET until_ms=0,owner=?').bind('').run();
  await db
    .prepare("UPDATE settings SET value=? WHERE key='monitor_config'")
    .bind(JSON.stringify(defaultMonitorConfig))
    .run();
  await db.prepare("DELETE FROM settings WHERE key='monitor_email'").run();
  env.ALERT_EMAIL = undefined;
  await db
    .prepare("UPDATE settings SET value=? WHERE key='collection_config'")
    .bind(JSON.stringify({ enabled: true, interval_seconds: 300 }))
    .run();
  for (const id of ['admin', 'member', 'third', 'fourth', 'fifth'])
    await db
      .prepare('INSERT INTO members(id,email,display_name,role,created_at_ms) VALUES(?,?,?,?,?)')
      .bind(id, email(id), id, id === 'admin' ? 'admin' : 'member', Date.now())
      .run();
});
describe('device lifecycle and authorization', () => {
  it('consumes an enrollment code exactly once under concurrent requests', async () => {
    const created = await dashboard('/enrollments', 'POST', { member_id: 'member' });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    const request = () =>
      app.request(
        '/api/v1/agent/enroll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            device_label: 'Test PC',
            platform: 'windows-x64',
            agent_version: '0.1.0',
          }),
        },
        env,
      );
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    const credentials = (await responses.find((r) => r.status === 201)!.json()) as {
      device_id: string;
      device_token: string;
      pseudonym_key: string;
    };
    expect(credentials.pseudonym_key).toHaveLength(64);
    const stored = await db
      .prepare('SELECT token_hash FROM devices WHERE id=?')
      .bind(credentials.device_id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(await hash(credentials.device_token));
    expect(stored?.token_hash).not.toBe(credentials.device_token);
  });
  it('rejects expired codes', async () => {
    const code = 'x'.repeat(64);
    await db
      .prepare('INSERT INTO enrollment_codes VALUES(?,?,?,NULL,?)')
      .bind(await hash(code), 'member', Date.now() - 1, 0)
      .run();
    const response = await app.request(
      '/api/v1/agent/enroll',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          device_label: 'PC',
          platform: 'windows-x64',
          agent_version: '0.1.0',
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
  });
  it('rejects invalid and revoked device tokens immediately', async () => {
    expect((await upload('bad')).status).toBe(401);
    const token = await device();
    expect((await upload(token)).status).toBe(200);
    expect((await dashboard('/devices/d1', 'DELETE')).status).toBe(200);
    expect((await upload(token)).status).toBe(401);
  });
  it('requires a signed member JWT and never trusts email headers', async () => {
    expect(
      (
        await app.request(
          '/api/v1/dashboard/members',
          { headers: { 'Cf-Access-Authenticated-User-Email': email('admin') } },
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/v1/dashboard/members',
          { headers: { 'Cf-Access-Jwt-Assertion': await jwt('admin', 'wrong-aud') } },
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/v1/dashboard/members',
          { headers: { 'Cf-Access-Jwt-Assertion': await jwt('admin', 'test-aud', '-1h') } },
          env,
        )
      ).status,
    ).toBe(401);
    expect((await dashboard('/members', 'GET', undefined, 'outsider')).status).toBe(403);
  });
  it('shares the entire family with members while reserving management for admins', async () => {
    const response = await dashboard('/members', 'GET', undefined, 'member');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(5);
    expect(
      (await dashboard('/enrollments', 'POST', { member_id: 'member' }, 'member')).status,
    ).toBe(403);
    expect(
      (await dashboard('/members', 'POST', { email: 'sixth@example.test', display_name: 'Sixth' }))
        .status,
    ).toBe(201);
    expect(
      (
        await dashboard('/members', 'POST', {
          email: 'seventh@example.test',
          display_name: 'Seventh',
        })
      ).status,
    ).toBe(409);
  });
  it('allows ordinary members to view rules, acknowledge their own alerts, and toggle personal notifications while reserving management for admins', async () => {
    for (const path of [
      '/summary',
      '/members',
      '/usage',
      '/models',
      '/trends',
      '/alerts',
      '/rules',
      '/monitor/overview',
    ])
      expect((await dashboard(path, 'GET', undefined, 'member')).status, path).toBe(200);
    const members = (await (await dashboard('/members', 'GET', undefined, 'member')).json()) as {
      items: { email: unknown; notifications_enabled?: unknown }[];
    };
    expect(
      members.items.every((m) => m.email === null && m.notifications_enabled === undefined),
    ).toBe(true);
    const overview = (await (
      await dashboard('/monitor/overview', 'GET', undefined, 'member')
    ).json()) as Record<string, unknown>;
    expect(Object.keys(overview).sort()).toEqual([
      'alerts',
      'bound_members',
      'collection_active',
      'expected_members',
      'online_members',
      'ready',
      'total_members',
    ]);
    expect(
      (await dashboard('/preferences', 'PUT', { notifications_enabled: false }, 'member')).status,
    ).toBe(200);
    expect(
      (await dashboard('/members/member', 'PATCH', { notifications_enabled: true }, 'member'))
        .status,
    ).toBe(200);
    expect(
      (await dashboard('/members/member', 'PATCH', { display_name: 'Renamed' }, 'member')).status,
    ).toBe(403);
    expect(
      (await dashboard('/members/member', 'PATCH', { email: 'new@example.test' }, 'member')).status,
    ).toBe(403);
    expect(
      (await dashboard('/members/member', 'PATCH', { status: 'inactive' }, 'member')).status,
    ).toBe(403);
    await dashboard('/rules', 'PUT', [
      { scope: 'family', metric: 'tokens', period: 'day', threshold_value: 1, enabled: true },
    ]);
    await upload(await device(), [event()]);
    const memberAlertsBefore = (await (
      await dashboard('/alerts', 'GET', undefined, 'member')
    ).json()) as { items: { id: string; acknowledged: number }[] };
    expect(memberAlertsBefore.items).toHaveLength(1);
    expect(memberAlertsBefore.items[0].acknowledged).toBe(0);
    expect(
      (await dashboard(`/alerts/${memberAlertsBefore.items[0].id}/ack`, 'POST', {}, 'member'))
        .status,
    ).toBe(200);
    const memberAlertsAfter = (await (
      await dashboard('/alerts', 'GET', undefined, 'member')
    ).json()) as { items: { id: string; acknowledged: number }[] };
    expect(memberAlertsAfter.items[0].acknowledged).toBe(1);
    const adminAlerts = (await (await dashboard('/alerts', 'GET', undefined, 'admin')).json()) as {
      items: { id: string; acknowledged: number }[];
    };
    expect(adminAlerts.items[0].acknowledged).toBe(0);
    for (const path of ['/settings', '/monitor', '/collection'])
      expect((await dashboard(path, 'GET', undefined, 'member')).status, path).toBe(403);
    for (const [path, method] of [
      ['/members', 'POST'],
      ['/members/admin', 'PATCH'],
      ['/enrollments', 'POST'],
      ['/devices/d1', 'DELETE'],
      ['/settings', 'PUT'],
      ['/rules', 'PUT'],
      ['/rules/any-id', 'DELETE'],
      ['/monitor/settings', 'PUT'],
      ['/collection/settings', 'PUT'],
      ['/collection/run', 'POST'],
      ['/monitor/test-email', 'POST'],
      ['/prices', 'POST'],
      ['/reprice', 'POST'],
    ])
      expect((await dashboard(path, method, {}, 'member')).status, `${method} ${path}`).toBe(403);
    expect((await dashboard('/settings', 'GET')).status).toBe(200);
  });
  it('supports editing member email, soft-deactivating to free the 6-member cap, and reactivating while preserving usage history', async () => {
    expect(
      (
        await dashboard('/members/member', 'PATCH', {
          display_name: 'Member Updated',
          email: 'member.new@example.test',
        })
      ).status,
    ).toBe(200);
    expect(
      (await dashboard('/members/member', 'PATCH', { email: email('admin') })).status,
    ).toBe(409);
    expect(
      (await dashboard('/members/admin', 'PATCH', { status: 'inactive' })).status,
    ).toBe(400);
    const sixth = await dashboard('/members', 'POST', {
      email: 'sixth@example.test',
      display_name: 'Sixth',
    });
    expect(sixth.status).toBe(201);
    const sixthId = ((await sixth.json()) as { id: string }).id;
    const sixthToken = await device('d-sixth', sixthId);
    await db
      .prepare(
        "UPDATE devices SET agent_version='0.3.0',last_seen_at_ms=?,last_heartbeat_at_ms=? WHERE id='d-sixth'",
      )
      .bind(Date.now(), Date.now())
      .run();
    expect((await upload(sixthToken, [event('1', 25, 'claude-sonnet-4-6')])).status).toBe(200);
    expect((await dashboard('/enrollments', 'POST', { member_id: sixthId })).status).toBe(201);
    expect((await dashboard('/collection/run', 'POST', { device_id: 'd-sixth' })).status).toBe(
      202,
    );
    expect(
      (
        await dashboard('/members', 'POST', {
          email: 'seventh@example.test',
          display_name: 'Seventh',
        })
      ).status,
    ).toBe(409);
    expect((await dashboard(`/members/${sixthId}`, 'PATCH', { status: 'inactive' })).status).toBe(
      200,
    );
    expect((await upload(sixthToken, [event('2', 10)])).status).toBe(401);
    expect(
      (
        await db
          .prepare("SELECT status FROM collection_requests WHERE device_id='d-sixth'")
          .first<{ status: string }>()
      )?.status,
    ).toBe('expired');
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE member_id=?')
          .bind(sixthId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await dashboard('/members', 'POST', {
          email: 'seventh@example.test',
          display_name: 'Seventh',
        })
      ).status,
    ).toBe(201);
    expect((await dashboard(`/members/${sixthId}`, 'PATCH', { status: 'active' })).status).toBe(
      409,
    );
  });
  it('supports editing and permanently deleting alert rules with dependent notifications', async () => {
    const ruleId = '11111111-1111-4111-8111-111111111111';
    expect(
      (
        await dashboard('/rules', 'PUT', [
          {
            id: ruleId,
            scope: 'family',
            metric: 'tokens',
            period: 'day',
            threshold_value: 1,
            enabled: true,
          },
        ])
      ).status,
    ).toBe(200);
    await upload(await device(), [event()]);
    const alerts = (await (await dashboard('/alerts')).json()) as { items: { id: string }[] };
    expect(alerts.items).toHaveLength(1);
    expect((await dashboard(`/alerts/${alerts.items[0].id}/ack`, 'POST')).status).toBe(200);
    expect((await dashboard(`/rules/${ruleId}`, 'DELETE')).status).toBe(200);
    const rulesAfter = (await (await dashboard('/rules')).json()) as { items: unknown[] };
    expect(rulesAfter.items).toHaveLength(0);
  });
});
describe('administrator collection controls', () => {
  async function heartbeat(token: string, extra: Record<string, unknown> = {}) {
    return app.request(
      '/api/v1/agent/heartbeat',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_version: '0.3.0',
          pending_events: 0,
          notifications_enabled: true,
          ...extra,
        }),
      },
      env,
    );
  }
  it('synchronizes cadence and pause through authenticated heartbeats and rejects invalid settings', async () => {
    const token = await device();
    const initial = (await (await heartbeat(token)).json()) as any;
    expect(initial.collection).toEqual({ enabled: true, interval_seconds: 300 });
    expect(initial.collection_request).toBeNull();
    expect(
      (await dashboard('/collection/settings', 'PUT', { enabled: false, interval_seconds: 1800 }))
        .status,
    ).toBe(200);
    expect(((await (await heartbeat(token)).json()) as any).collection).toEqual({
      enabled: false,
      interval_seconds: 1800,
    });
    for (const interval_seconds of [0, 59, 3601, 60.5])
      expect(
        (await dashboard('/collection/settings', 'PUT', { enabled: true, interval_seconds }))
          .status,
      ).toBe(400);
    expect(
      (
        await dashboard('/collection/settings', 'PUT', {
          enabled: true,
          interval_seconds: 300,
          path: 'private',
        })
      ).status,
    ).toBe(400);
    expect((await dashboard('/collection', 'GET', undefined, 'member')).status).toBe(403);
  });
  it('delivers one pending manual command per device, isolates acknowledgments and expires offline commands', async () => {
    const first = await device('control-1'),
      second = await device('control-2', 'third');
    await heartbeat(first);
    await heartbeat(second);
    await dashboard('/collection/settings', 'PUT', { enabled: false, interval_seconds: 300 });
    const responses = await Promise.all([
      dashboard('/collection/run', 'POST', {}),
      dashboard('/collection/run', 'POST', {}),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM collection_requests WHERE status='pending'")
          .first<any>()
      ).n,
    ).toBe(2);
    const command1 = ((await (await heartbeat(first)).json()) as any).collection_request;
    const command2 = ((await (await heartbeat(second)).json()) as any).collection_request;
    expect(command1.id).not.toBe(command2.id);
    await heartbeat(second, { collection_ack: { request_id: command1.id, status: 'completed' } });
    expect(
      (
        await db
          .prepare('SELECT status FROM collection_requests WHERE id=?')
          .bind(command1.id)
          .first<any>()
      ).status,
    ).toBe('pending');
    for (let i = 0; i < 2; i++)
      expect(
        (
          (await (
            await heartbeat(first, {
              collection_ack: { request_id: command1.id, status: 'completed' },
            })
          ).json()) as any
        ).collection_request,
      ).toBeNull();
    await db
      .prepare('UPDATE collection_requests SET expires_at_ms=? WHERE id=?')
      .bind(Date.now() - 1, command2.id)
      .run();
    expect(((await (await heartbeat(second)).json()) as any).collection_request).toBeNull();
    expect(
      (
        await db
          .prepare('SELECT status FROM collection_requests WHERE id=?')
          .bind(command2.id)
          .first<any>()
      ).status,
    ).toBe('expired');
    expect((await dashboard('/collection/run', 'POST', { device_id: 'control-2' })).status).toBe(
      202,
    );
    const status = (await (await dashboard('/collection')).json()) as any;
    expect(status.devices.find((d: any) => d.id === 'control-1').last_request.status).toBe(
      'completed',
    );
    expect(status.devices.find((d: any) => d.id === 'control-2').last_request.status).toBe(
      'pending',
    );
  });
  it('requires an active, non-revoked client supporting controls', async () => {
    await device('legacy');
    await db.prepare("UPDATE devices SET agent_version='0.2.0'").run();
    expect((await dashboard('/collection/run', 'POST', {})).status).toBe(409);
    const token = await device('revoked');
    await heartbeat(token);
    await db
      .prepare("UPDATE devices SET revoked_at_ms=? WHERE id='revoked'")
      .bind(Date.now())
      .run();
    expect((await dashboard('/collection/run', 'POST', { device_id: 'revoked' })).status).toBe(409);
    expect((await dashboard('/collection/run', 'POST', { device_id: 'missing' })).status).toBe(409);
  });
});

describe('usage, pricing and shared reports', () => {
  it('distinguishes a member with no usage from usage awaiting prices', async () => {
    const before = (await (await dashboard('/members')).json()) as any;
    const empty = before.items.find((m: any) => m.id === 'member');
    expect(empty.today.cost_micro_usd).toBe(0);
    expect(empty.month.events).toBe(0);
    const token = await device();
    expect((await upload(token)).status).toBe(200);
    const after = (await (await dashboard('/members')).json()) as any;
    const used = after.items.find((m: any) => m.id === 'member');
    expect(used.today.cost_micro_usd).toBeNull();
    expect(used.today.unpriced_tokens).toBe(19);
  });
  it('accepts a full 100-event batch and classifies concurrent retries correctly', async () => {
    const token = await device();
    const events = Array.from({ length: 100 }, (_, i) => ({
      ...event(),
      event_id: i.toString(16).padStart(64, '0'),
      step_index: i,
    }));
    const responses = await Promise.all([upload(token, events), upload(token, events)]);
    const receipts = (await Promise.all(responses.map((r) => r.json()))) as {
      inserted: number;
      unchanged: number;
    }[];
    expect(receipts.reduce((n, r) => n + r.inserted, 0)).toBe(100);
    expect(receipts.reduce((n, r) => n + r.unchanged, 0)).toBe(100);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM usage_events').first<{ n: number }>())?.n,
    ).toBe(100);
  });
  it('is idempotent and updates corrected counters without adding a second event', async () => {
    const token = await device();
    const row = event();
    expect((await upload(token, [row])).status).toBe(200);
    expect(await (await upload(token, [row])).json()).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    row.tokens.input = 30;
    expect(await (await upload(token, [row])).json()).toMatchObject({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    const stored = await db
      .prepare('SELECT count(*) AS count,SUM(total_tokens) AS total FROM usage_events')
      .first<{ count: number; total: number }>();
    expect(stored).toMatchObject({ count: 1, total: 39 });
  });
  it('accepts three concurrent devices without double-counting and derives their members from auth', async () => {
    const tokens = await Promise.all([
      device('d1', 'member'),
      device('d2', 'third'),
      device('d3', 'fourth'),
    ]);
    const row = event();
    const results = await Promise.all(tokens.map((t) => upload(t, [row])));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const total = await db
      .prepare(
        'SELECT count(*) AS count,SUM(total_tokens) AS total,COUNT(DISTINCT member_id) AS members FROM usage_events',
      )
      .first();
    expect(total).toMatchObject({ count: 3, total: 57, members: 3 });
    expect((await upload(tokens[0], [{ ...row, member_id: 'admin' }] as any)).status).toBe(400);
  });
  it('rejects private fields, negative counters and oversized batches', async () => {
    const token = await device();
    expect((await upload(token, [{ ...event(), prompt: 'CANARY' }] as any)).status).toBe(400);
    const row = event();
    row.tokens.input = -1;
    expect((await upload(token, [row])).status).toBe(400);
    expect(
      (
        await upload(
          token,
          Array.from({ length: 101 }, () => event()),
        )
      ).status,
    ).toBe(400);
  });
  it('keeps unknown models unpriced and reprices only the missing historical costs', async () => {
    const token = await device();
    const row = event();
    await upload(token, [row]);
    expect(
      await db.prepare('SELECT pricing_status,cost_micro_usd FROM usage_events').first(),
    ).toMatchObject({ pricing_status: 'unpriced', cost_micro_usd: null });
    const price = {
      model_id: 'custom-model',
      input_price: 1000000,
      output_price: 2000000,
      cache_read_price: 100000,
      cache_write_price: 100000,
      effective_from: 0,
      catalog_version: 'v1',
      source: 'https://example.test/pricing',
    };
    expect((await dashboard('/prices', 'POST', price)).status).toBe(201);
    expect(await (await dashboard('/reprice', 'POST', {})).json()).toMatchObject({ updated: 1 });
    expect(
      await db.prepare('SELECT pricing_status,cost_micro_usd FROM usage_events').first(),
    ).toMatchObject({ pricing_status: 'priced', cost_micro_usd: 15 });
    await dashboard('/prices', 'POST', {
      ...price,
      input_price: 10000000,
      catalog_version: 'v2',
      effective_from: Date.now() - 1,
    });
    await dashboard('/reprice', 'POST', {});
    expect(
      (
        await db
          .prepare('SELECT cost_micro_usd FROM usage_events')
          .first<{ cost_micro_usd: number }>()
      )?.cost_micro_usd,
    ).toBe(15);
  });
  it('filters usage by date, member, model and source and paginates', async () => {
    const token = await device();
    await upload(token, [event('a'), event('b', 20, 'other-model')]);
    const response = await dashboard(
      '/usage?member_id=member&model_id=custom-model&source=antigravity_cli&page_size=1',
    );
    const data = (await response.json()) as { items: any[]; total: number };
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).not.toHaveProperty('session_key');
    expect((await dashboard('/summary')).status).toBe(200);
    expect((await dashboard('/models')).status).toBe(200);
    expect((await dashboard('/trends')).status).toBe(200);
  });
});
describe('thresholds and timezone periods', () => {
  it('rejects cross-origin management and invalid dates', async () => {
    expect(
      (
        await app.request(
          '/api/v1/dashboard/settings',
          {
            method: 'PUT',
            headers: {
              'Cf-Access-Jwt-Assertion': await jwt(),
              'Content-Type': 'application/json',
              Origin: 'https://evil.example',
            },
            body: JSON.stringify({ timezone: 'UTC' }),
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect((await dashboard('/usage?to_date=not-a-date')).status).toBe(400);
    expect((await dashboard('/usage?from_date=2026-02-31')).status).toBe(400);
  });
  it('uses integer micro-USD rounding and leaves unknown prices nullable', () => {
    const e = event();
    e.tokens = { input: 1, output: 0, cache_read: 0, cache_write: 0 };
    expect(priced(e as any, []).cost_micro_usd).toBeNull();
    expect(
      priced(e as any, [
        {
          id: 'p',
          model_id: e.model_id,
          input_price: 500000,
          output_price: 0,
          cache_read_price: 0,
          cache_write_price: 0,
          effective_from: 0,
          catalog_version: 'test',
          source: 'https://example.test',
        },
      ]).cost_micro_usd,
    ).toBe(1);
  });
  it('acknowledges alerts idempotently and rejects malformed cursors', async () => {
    await dashboard('/rules', 'PUT', [
      { scope: 'family', metric: 'tokens', period: 'day', threshold_value: 1, enabled: true },
    ]);
    const token = await device();
    await upload(token, [event()]);
    const get = (after = '') =>
      app.request(
        `/api/v1/agent/alerts?after=${encodeURIComponent(after)}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
    const response = await get();
    const body = (await response.json()) as {
      notifications: { id: string }[];
      next_cursor: string;
    };
    expect(body.notifications).toHaveLength(1);
    const ack = () =>
      app.request(
        '/api/v1/agent/alerts/ack',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notification_ids: [body.notifications[0].id] }),
        },
        env,
      );
    expect((await ack()).status).toBe(200);
    expect((await ack()).status).toBe(200);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM alert_acks').first<{ n: number }>())?.n,
    ).toBe(1);
    expect(await (await get(body.next_cursor)).json()).toMatchObject({ notifications: [] });
    expect((await get('%bad')).status).toBe(400);
  });
  it('emits one alert per rule subject and natural period and resets in a new period', async () => {
    await dashboard('/rules', 'PUT', [
      {
        scope: 'member',
        metric: 'tokens',
        period: 'day',
        threshold_value: 10,
        member_id: 'member',
        enabled: true,
      },
    ]);
    await upload(await device(), [event()]);
    await Promise.all([evaluateAlerts(db), evaluateAlerts(db)]);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM alert_notifications').first<{ n: number }>())?.n,
    ).toBe(1);
    const tomorrow = Date.now() + 86400000;
    await db.prepare('UPDATE usage_events SET occurred_at_ms=?').bind(tomorrow).run();
    await evaluateAlerts(db, tomorrow);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM alert_notifications').first<{ n: number }>())?.n,
    ).toBe(2);
  });
  it('does not repeatedly alert while a rolling 24h threshold remains exceeded', async () => {
    await dashboard('/rules', 'PUT', [
      {
        scope: 'family',
        metric: 'tokens',
        period: 'rolling_24h',
        threshold_value: 1,
        enabled: true,
      },
    ]);
    await upload(await device(), [event()]);
    await evaluateAlerts(db, Date.now() + 60000);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM alert_notifications').first<{ n: number }>())?.n,
    ).toBe(1);
  });
  it('uses calendar timezone boundaries including DST and Monday week starts', () => {
    expect(midnight('2026-03-08', 'America/New_York')).toBe(Date.parse('2026-03-08T05:00:00Z'));
    expect(midnight('2026-03-09', 'America/New_York')).toBe(Date.parse('2026-03-09T04:00:00Z'));
    expect(periodStart(Date.parse('2026-11-04T03:00:00Z'), 'week', 'Asia/Shanghai')).toBe(
      Date.parse('2026-11-01T16:00:00Z'),
    );
  });
});

async function monitorFamily(now: number) {
  await db
    .prepare('INSERT INTO members(id,email,display_name,role,created_at_ms) VALUES(?,?,?,?,?)')
    .bind('sixth', 'sixth@example.test', 'sixth', 'member', now)
    .run();
  for (const member of ['admin', 'member', 'third', 'fourth', 'fifth', 'sixth'])
    await device(`mon-${member}`, member);
  await touchMonitor(now);
  await db
    .prepare("INSERT INTO monitor_runtime VALUES('armed_at',?)")
    .bind(String(now - 7200000))
    .run();
}
async function touchMonitor(now: number) {
  await db
    .prepare(
      'UPDATE devices SET agent_version=?,last_seen_at_ms=?,last_heartbeat_at_ms=?,collector_json=?',
    )
    .bind(
      '0.2.0',
      now,
      now,
      JSON.stringify({
        last_scan_at_ms: now,
        sessions: 2,
        read_errors: 0,
        native_errors: 0,
        malformed_lines: 0,
      }),
    )
    .run();
}
async function quotaReading(now: number, remaining = 900000, reset = now + 86400000, all = false) {
  const ids = all ? ['admin', 'member', 'third', 'fourth', 'fifth', 'sixth'] : ['admin'];
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          'INSERT INTO device_quota VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,bucket_id) DO UPDATE SET remaining_ppm=excluded.remaining_ppm,reset_at_ms=excluded.reset_at_ms,observed_at_ms=excluded.observed_at_ms,received_at_ms=excluded.received_at_ms',
        )
        .bind(`mon-${id}`, 'gemini-5h', remaining, reset, now, now),
    ),
  );
}
async function monitorCost(at: number, cost: number, member = 'admin', id = 'a') {
  const token = await hash(`mon-${member}`);
  expect(
    (await upload(token, [{ ...event(id, 1000, 'gemini-3.8-flash'), occurred_at_ms: at }])).status,
  ).toBe(200);
  await db
    .prepare(
      "UPDATE usage_events SET pricing_status='priced',cost_micro_usd=? WHERE device_id=? AND id=?",
    )
    .bind(cost, `mon-${member}`, id.repeat(64))
    .run();
}
async function fakeMail(send: NonNullable<Env['ALERT_EMAIL']>['send']) {
  await db
    .prepare("INSERT INTO settings VALUES('monitor_email',?)")
    .bind(JSON.stringify({ from: 'alerts@example.test', to: 'owner@example.test' }))
    .run();
  env.ALERT_EMAIL = { send };
}

describe('six-person shared quota monitoring and email', () => {
  it('silences anomaly emails while paused and waits two collection cycles after resuming', async () => {
    const now = Date.now();
    await monitorFamily(now);
    const sent: unknown[] = [];
    await fakeMail(async (m) => {
      sent.push(m);
    });
    await dashboard('/collection/settings', 'PUT', { enabled: false, interval_seconds: 3600 });
    await evaluateMonitor(env, now);
    const paused = await monitorStatus(env, now);
    expect(paused.collection_active).toBe(false);
    expect(paused.ready).toBe(false);
    expect(sent).toHaveLength(0);
    await dashboard('/collection/settings', 'PUT', { enabled: true, interval_seconds: 3600 });
    await evaluateMonitor(env, now);
    await touchMonitor(now + 3600000);
    await evaluateMonitor(env, now + 3600000);
    expect(sent).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM monitor_alerts').first<any>()).n).toBe(0);
    await touchMonitor(now + 7200000);
    await evaluateMonitor(env, now + 7200000);
    await touchMonitor(now + 7500000);
    await evaluateMonitor(env, now + 7500000);
    expect(sent).toHaveLength(1);
  });
  it('retries a manual test email even before all six members are bound', async () => {
    const now = Date.now();
    const sent: unknown[] = [];
    await fakeMail(async (message) => {
      sent.push(message);
    });
    await enqueueEmail(db, 'manual-before-binding', null, 'Test', 'Test only', now);
    await evaluateMonitor(env, now);
    expect(sent).toHaveLength(1);
    expect(
      (
        await db
          .prepare("SELECT status FROM email_outbox WHERE id='manual-before-binding'")
          .first<{ status: string }>()
      )?.status,
    ).toBe('sent');
    expect((await monitorStatus(env, now)).ready).toBe(false);
  });
  it('does not arm or email before every member is bound', async () => {
    const now = Date.now();
    await device('only', 'admin');
    await db
      .prepare("INSERT INTO monitor_runtime VALUES('armed_at',?)")
      .bind(String(now - 7200000))
      .run();
    await evaluateMonitor(env, now);
    expect((await monitorStatus(env, now)).ready).toBe(false);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM email_outbox').first<{ n: number }>())?.n,
    ).toBe(0);
    expect(isOnline({ last_heartbeat_at_ms: now - 179000, agent_version: '0.2.0' }, now)).toBe(
      true,
    );
    expect(isOnline({ last_heartbeat_at_ms: now - 181000, agent_version: '0.2.0' }, now)).toBe(
      false,
    );
    expect(isOnline({ last_seen_at_ms: now - 301000, agent_version: '0.1.0' }, now)).toBe(true);
  });
  it('alerts after sustained online silence and sends one digest within the cooldown', async () => {
    const now = Date.now() - 900000;
    await monitorFamily(now);
    const sent: unknown[] = [];
    await fakeMail(async (message) => {
      expect(message.headers).not.toHaveProperty('Message-ID');
      expect(message.headers?.['X-Agy-Message-Key']).toMatch(/^[a-f0-9]{64}$/);
      expect(message.headers?.['Auto-Submitted']).toBe('auto-generated');
      sent.push(message);
      return { messageId: 'test-message' };
    });
    await evaluateMonitor(env, now);
    expect(sent).toHaveLength(0);
    await touchMonitor(now + 300000);
    await evaluateMonitor(env, now + 300000);
    expect(sent).toHaveLength(1);
    await touchMonitor(now + 600000);
    await evaluateMonitor(env, now + 600000);
    expect(sent).toHaveLength(1);
    await monitorCost(now + 600000, 200000);
    await evaluateMonitor(env, now + 600001);
    const alert = await db
      .prepare("SELECT resolved_at_ms FROM monitor_alerts WHERE condition_key='no_usage:family'")
      .first<{ resolved_at_ms: number }>();
    expect(alert?.resolved_at_ms).toBeTruthy();
  });
  it('sums six independent usage logs but records one shared quota interval and one sample', async () => {
    const start = Date.now() - 1800000,
      reset = start + 86400000;
    await monitorFamily(start);
    await quotaReading(start, 900000, reset, true);
    await evaluateMonitor(env, start);
    for (const [i, member] of ['admin', 'member', 'third', 'fourth', 'fifth', 'sixth'].entries())
      await monitorCost(start + 300000, 4000000, member, 'abcdef'[i]);
    await touchMonitor(start + 600000);
    await quotaReading(start + 600000, 780000, reset, true);
    await evaluateMonitor(env, start + 600000);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM quota_intervals').first<{ n: number }>())?.n,
    ).toBe(1);
    await touchMonitor(start + 1200001);
    await evaluateMonitor(env, start + 1200001);
    const learned = await calibration(db, 'gemini-5h', defaultMonitorConfig);
    expect(learned.samples).toBe(1);
    expect(learned.capacity_micro_usd).toBe(200000000);
    await evaluateMonitor(env, start + 1200002);
    expect((await calibration(db, 'gemini-5h', defaultMonitorConfig)).samples).toBe(1);
  });
  it('rebaselines on a reset and does not compare a replacement reader with the old one', async () => {
    const start = Date.now() - 3600000;
    await monitorFamily(start);
    await quotaReading(start, 900000, start + 86400000);
    await evaluateMonitor(env, start);
    await touchMonitor(start + 300000);
    await quotaReading(start + 300000, 400000, start + 2 * 86400000);
    await evaluateMonitor(env, start + 300000);
    await touchMonitor(start + 1000000);
    await quotaReading(start + 1000000, 200000, start + 2 * 86400000, true);
    await db.prepare("DELETE FROM device_quota WHERE device_id='mon-admin'").run();
    await evaluateMonitor(env, start + 1000000);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM quota_intervals').first<{ n: number }>())?.n,
    ).toBe(0);
  });
  it('does not calibrate or issue a numeric gap claim for unpriced data', async () => {
    const now = Date.now();
    await monitorFamily(now);
    const token = await hash('mon-admin');
    await upload(token, [{ ...event('a', 1000, 'gemini-unknown'), occurred_at_ms: now - 1200000 }]);
    await db
      .prepare(
        'INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        'unpriced',
        'gemini-5h',
        'mon-admin',
        now - 1800000,
        now - 900000,
        500000,
        now + 86400000,
      )
      .run();
    await evaluateMonitor(env, now);
    expect((await calibration(db, 'gemini-5h', defaultMonitorConfig)).samples).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM monitor_alerts WHERE kind='quota_gap'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it('freezes calibration during a sustained large shortfall and clears the alert after backfill', async () => {
    const now = Date.now();
    await monitorFamily(now);
    for (let i = 0; i < 6; i++) {
      await db
        .prepare(
          "INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms,status) VALUES(?,?,?,?,?,?,?,'evaluated')",
        )
        .bind(
          `seed-${i}`,
          'gemini-5h',
          'mon-admin',
          now - 7200000,
          now - 7100000,
          10000,
          now + 86400000,
        )
        .run();
      await db
        .prepare('INSERT INTO quota_calibration VALUES(?,?,?,?)')
        .bind(`seed-${i}`, 'gemini-5h', 200000000, now - 3600000 + i)
        .run();
    }
    for (let i = 0; i < 2; i++) {
      const start = now - (50 - i * 20) * 60000;
      await monitorCost(start + 60000, 1000000, 'admin', i ? 'b' : 'a');
      await db
        .prepare(
          'INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(`gap-${i}`, 'gemini-5h', 'mon-admin', start, start + 600000, 100000, now + 86400000)
        .run();
    }
    await evaluateMonitor(env, now);
    expect((await calibration(db, 'gemini-5h', defaultMonitorConfig)).samples).toBe(6);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM monitor_alerts WHERE kind='quota_gap'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM email_outbox').first<{ n: number }>())?.n,
    ).toBe(1);
    await db.prepare('UPDATE usage_events SET cost_micro_usd=20000000').run();
    await evaluateMonitor(env, now + 1);
    const resolved = await db
      .prepare("SELECT resolved_at_ms FROM monitor_alerts WHERE kind='quota_gap'")
      .first<{ resolved_at_ms: number }>();
    expect(resolved?.resolved_at_ms).toBeTruthy();
  });
  it('pauses shared-pool calibration when simultaneous official readings disagree', async () => {
    const now = Date.now();
    await monitorFamily(now);
    await quotaReading(now, 900000, now + 86400000, true);
    await db
      .prepare("UPDATE device_quota SET remaining_ppm=300000 WHERE device_id='mon-member'")
      .run();
    await evaluateMonitor(env, now);
    await evaluateMonitor(env, now + 1);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM quota_intervals').first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM monitor_alerts WHERE kind='quota_disagreement'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it('persists email failures and leases concurrent sends without duplicate delivery', async () => {
    const now = Date.now();
    let calls = 0;
    await fakeMail(async () => {
      calls++;
      throw new Error('provider failed');
    });
    await enqueueEmail(db, 'mail-test', null, 'Test', 'Synthetic test only', now);
    await flushEmails(env, now);
    expect(calls).toBe(1);
    const pending = await db
      .prepare("SELECT status,attempts FROM email_outbox WHERE id='mail-test'")
      .first();
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    env.ALERT_EMAIL = {
      send: async () => {
        calls++;
        return { messageId: 'accepted' };
      },
    };
    await flushEmails(env, now + 1);
    expect(calls).toBe(1);
    await Promise.all([flushEmails(env, now + 300001), flushEmails(env, now + 300001)]);
    expect(calls).toBe(2);
    expect(
      await db.prepare("SELECT status FROM email_outbox WHERE id='mail-test'").first(),
    ).toMatchObject({ status: 'sent' });
  });
  it('validates quota heartbeats and reserves mail tests and settings for admins', async () => {
    const token = await device();
    const now = Date.now();
    const heartbeat = (body: unknown) =>
      app.request(
        '/api/v1/agent/heartbeat',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      );
    const body = {
      agent_version: '0.2.0',
      pending_events: 0,
      notifications_enabled: true,
      collector: {
        last_scan_at_ms: now,
        sessions: 1,
        read_errors: 0,
        native_errors: 0,
        malformed_lines: 0,
      },
      quota_status: 'ok',
      quota: [
        {
          bucket_id: 'gemini-5h',
          remaining_ppm: 500000,
          reset_at_ms: now + 86400000,
          observed_at_ms: now,
        },
      ],
    };
    expect((await heartbeat(body)).status).toBe(200);
    expect((await heartbeat({ ...body, google_oauth_token: 'canary' })).status).toBe(400);
    expect((await heartbeat({ ...body, quota: [...body.quota, ...body.quota] })).status).toBe(400);
    expect((await dashboard('/monitor/test-email', 'POST', undefined, 'member')).status).toBe(403);
    expect(
      (await dashboard('/monitor/settings', 'PUT', defaultMonitorConfig, 'member')).status,
    ).toBe(403);
    expect((await dashboard('/monitor/test-email', 'POST')).status).toBe(503);
    expect((await dashboard('/monitor', 'GET', undefined, 'member')).status).toBe(403);
    expect((await dashboard('/monitor/overview', 'GET', undefined, 'member')).status).toBe(200);
  });
  it('prices the requested current model names and switches published future prices by event time', async () => {
    const sql = readFileSync(
      fileURLToPath(new NodeURL('../migrations/0004_official_prices.sql', import.meta.url)),
      'utf8',
    );
    for (const statement of sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
    const prices = (await db.prepare('SELECT * FROM model_prices').all<any>()).results;
    expect(
      priced(
        {
          ...event('a', 10, 'claude-opus-5.5-thinking'),
          occurred_at_ms: Date.parse('2026-11-04T00:00:00Z'),
        },
        prices,
      ).cost_micro_usd,
    ).toBe(101);
    const price = (model: string, date: string) =>
      priced(
        {
          ...event('a', 1000000, model),
          occurred_at_ms: Date.parse(date),
          tokens: { input: 1000000, output: 0, cache_read: 0, cache_write: 0 },
        },
        prices,
      ).cost_micro_usd;
    expect(price('gemini-4-argon-high', '2026-11-04')).toBe(2000000);
    expect(price('gemini-4-argon-high', '2026-12-02')).toBe(4000000);
    expect(price('claude-sonnet-5-5', '2026-11-04')).toBe(2000000);
    expect(price('gemini-3.8-flash-high', '2027-01-02')).toBe(1500000);
  });
});

it('keeps a four-bucket alert digest within the free D1 invocation budget', async () => {
  const now = Date.now();
  await monitorFamily(now);
  await fakeMail(async () => ({ messageId: 'digest' }));
  const reset = now + 86400000;
  for (const bucket of bucketIds) {
    const before = {
      device_id: 'mon-admin',
      bucket_id: bucket,
      remaining_ppm: 900000,
      reset_at_ms: reset,
      observed_at_ms: now - 300000,
      received_at_ms: now - 300000,
    };
    await db
      .prepare('INSERT INTO monitor_runtime VALUES(?,?)')
      .bind(`baseline:${bucket}`, JSON.stringify(before))
      .run();
    await db
      .prepare('INSERT INTO device_quota VALUES(?,?,?,?,?,?)')
      .bind('mon-admin', bucket, 700000, reset, now, now)
      .run();
    await db
      .prepare(
        'INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(`budget-${bucket}`, bucket, 'mon-admin', now - 1800000, now - 900000, 100000, reset)
      .run();
    await db
      .prepare('INSERT INTO monitor_conditions VALUES(?,?,1)')
      .bind(`quota_gap:${bucket}`, now - 300000)
      .run();
  }
  let queries = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  function statement(raw: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(raw, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, key);
        if (typeof value === 'function')
          return (...values: unknown[]) => {
            if (['all', 'first', 'run', 'raw'].includes(String(key))) queries++;
            return value.apply(target, values);
          };
        return value;
      },
    });
    originals.set(wrapped, raw);
    return wrapped;
  }
  const counted = {
    ...env,
    DB: {
      prepare: (sql: string) => statement(db.prepare(sql)),
      batch: (items: D1PreparedStatement[]) => {
        queries++;
        return db.batch(items.map((s) => originals.get(s) ?? s));
      },
    },
  } as unknown as Env;
  await evaluateMonitor(counted, now);
  expect(queries).toBeLessThanOrEqual(50);
  expect(
    (
      await db
        .prepare("SELECT count(*) AS n FROM email_outbox WHERE status='sent'")
        .first<{ n: number }>()
    )?.n,
  ).toBe(4);
});

it('uses the newest inserted price when effective dates match, regardless of version label spelling', async () => {
  const price = {
    model_id: 'custom-tie',
    input_price: 1000000,
    output_price: 0,
    cache_read_price: 0,
    cache_write_price: 0,
    effective_from: 0,
    catalog_version: 'z-older',
    source: 'https://example.test/prices',
  };
  expect((await dashboard('/prices', 'POST', price)).status).toBe(201);
  expect(
    (
      await dashboard('/prices', 'POST', {
        ...price,
        input_price: 2000000,
        catalog_version: 'a-newer',
      })
    ).status,
  ).toBe(201);
  const token = await device();
  expect((await upload(token, [event('a', 10, 'custom-tie')])).status).toBe(200);
  expect(
    (
      await db
        .prepare('SELECT cost_micro_usd FROM usage_events')
        .first<{ cost_micro_usd: number }>()
    )?.cost_micro_usd,
  ).toBe(20);
});

it('clears pricing_incomplete alerts after repricing, resolves o3 backfill, and purges stale alerts on monitor reset', async () => {
  const now = Date.now();
  await monitorFamily(now);
  const token = await hash('mon-admin');
  expect(
    (
      await upload(token, [
        { ...event('7', 1000, 'gemini-unpriced'), occurred_at_ms: now - 1200000 },
      ])
    ).status,
  ).toBe(200);
  await db
    .prepare('INSERT INTO monitor_conditions VALUES(?,?,1)')
    .bind('pricing_incomplete:gemini-5h', now - 300000)
    .run();
  await db
    .prepare(
      'INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      'unpriced-int',
      'gemini-5h',
      'mon-admin',
      now - 1800000,
      now - 900000,
      500000,
      now + 86400000,
    )
    .run();
  await evaluateMonitor(env, now);
  expect(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM monitor_alerts WHERE condition_key='pricing_incomplete:gemini-5h' AND resolved_at_ms IS NULL",
        )
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    (
      await dashboard('/prices', 'POST', {
        model_id: 'gemini-unpriced',
        input_price: 1000000,
        output_price: 1000000,
        cache_read_price: 100000,
        cache_write_price: 100000,
        effective_from: 0,
        catalog_version: 'v-reprice',
        source: 'https://example.test/prices',
      })
    ).status,
  ).toBe(201);
  expect((await dashboard('/reprice', 'POST', {})).status).toBe(200);
  expect(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM monitor_alerts WHERE condition_key='pricing_incomplete:gemini-5h' AND resolved_at_ms IS NULL",
        )
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);

  // Verify o3 model backfill resolution for 3p-5h
  await db
    .prepare(
      "INSERT INTO quota_intervals(id,bucket_id,device_id,started_at_ms,ended_at_ms,drop_ppm,reset_at_ms,status) VALUES(?,?,?,?,?,?,?,'evaluated')",
    )
    .bind('o3-gap', '3p-5h', 'mon-admin', now - 1800000, now - 900000, 100000, now + 86400000)
    .run();
  await db
    .prepare('INSERT INTO monitor_conditions VALUES(?,?,2)')
    .bind('quota_gap:3p-5h', now - 600000)
    .run();
  await db
    .prepare(
      "INSERT INTO monitor_alerts(id,condition_key,kind,message,details_json,created_at_ms,last_seen_at_ms) VALUES('o3-alert','quota_gap:3p-5h','quota_gap','gap','{}',?,?)",
    )
    .bind(now - 600000, now - 600000)
    .run();
  expect(
    (await upload(token, [{ ...event('8', 1000, 'o3-mini'), occurred_at_ms: now - 1200000 }]))
      .status,
  ).toBe(200);
  await db
    .prepare(
      "UPDATE usage_events SET pricing_status='priced',cost_micro_usd=20000000 WHERE id=?",
    )
    .bind('8'.repeat(64))
    .run();
  await evaluateMonitor(env, now + 1000);
  expect(
    (
      await db
        .prepare("SELECT resolved_at_ms FROM monitor_alerts WHERE id='o3-alert'")
        .first<{ resolved_at_ms: number | null }>()
    )?.resolved_at_ms,
  ).toBeTruthy();

  // Verify reset-calibration clears stale conditions, alerts, and pending alert emails
  await db
    .prepare('INSERT INTO monitor_conditions VALUES(?,?,2)')
    .bind('no_usage:family', now)
    .run();
  await db
    .prepare(
      "INSERT INTO monitor_alerts(id,condition_key,kind,message,details_json,created_at_ms,last_seen_at_ms) VALUES('stale-alert','no_usage:family','no_usage','stale','{}',?,?)",
    )
    .bind(now, now)
    .run();
  await enqueueEmail(db, 'stale-mail', 'stale-alert', 'Stale', 'Stale body', now);
  expect((await dashboard('/monitor/reset-calibration', 'POST', {})).status).toBe(200);
  expect(
    (await db.prepare('SELECT count(*) AS n FROM monitor_conditions').first<{ n: number }>())?.n,
  ).toBe(0);
  expect(
    (
      await db
        .prepare("SELECT resolved_at_ms FROM monitor_alerts WHERE id='stale-alert'")
        .first<{ resolved_at_ms: number | null }>()
    )?.resolved_at_ms,
  ).toBeTruthy();
  expect(
    (
      await db
        .prepare("SELECT status FROM email_outbox WHERE id='stale-mail'")
        .first<{ status: string }>()
    )?.status,
  ).toBe('cancelled');
});

