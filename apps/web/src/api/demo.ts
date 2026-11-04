import type { Totals, Member, Usage, Filters, Snapshot, Rule, AdminSnapshot } from './types';
import { overview } from './client';
export const empty = (): Totals => ({
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_micro_usd: null,
  unpriced_tokens: 0,
  events: 0,
});
export function total(rows: Usage[]): Totals {
  if (!rows.length) return { ...empty(), cost_micro_usd: 0 };
  return rows.reduce(
    (a, e) => ({
      total_tokens: a.total_tokens + e.total_tokens,
      input_tokens: a.input_tokens + e.input_tokens,
      output_tokens: a.output_tokens + e.output_tokens,
      cache_read_tokens: a.cache_read_tokens + e.cache_read_tokens,
      cache_write_tokens: a.cache_write_tokens + e.cache_write_tokens,
      cost_micro_usd:
        e.cost_micro_usd === null ? a.cost_micro_usd : (a.cost_micro_usd ?? 0) + e.cost_micro_usd,
      unpriced_tokens: a.unpriced_tokens + (e.pricing_status === 'unpriced' ? e.total_tokens : 0),
      events: a.events + 1,
    }),
    empty(),
  );
}
const now = Date.now();
const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const day = 86400000;
const localDay = new Date(today + 'T00:00:00Z');
localDay.setUTCDate(localDay.getUTCDate() - ((localDay.getUTCDay() + 6) % 7));
const weekStart = Date.parse(localDay.toISOString().slice(0, 10) + 'T00:00:00+08:00');
const monthStart = Date.parse(today.slice(0, 7) + '-01T00:00:00+08:00');
const names = ['林亦安', '周予', '陈沐', '许知远', '沈宁', '顾然'];
export const demoRows: Usage[] = Array.from({ length: 300 }, (_, i) => {
  const member = i % names.length;
  const age = Math.floor(i / 10);
  const m = (i + Math.floor(i / 7)) % 11;
  const model =
    m < 5
      ? 'gemini-3.8-flash-high'
      : m < 8
        ? 'claude-opus-5-5'
        : m < 10
          ? 'gemini-4-argon'
          : 'unknown';
  const input = 18000 + ((i * 1913) % 160000),
    output = 2000 + ((i * 151) % 13000),
    read = 5000 + ((i * 3517) % 170000),
    write = (i * 157) % 8000;
  const price =
    model === 'unknown'
      ? null
      : Math.round(
          input * (m < 5 ? 0.75 : m < 8 ? 4 : 2) +
            output * (m < 5 ? 3.75 : m < 8 ? 20 : 10) +
            read * (m < 5 ? 0.075 : m < 8 ? 0.2 : 0.1) +
            write * (m < 5 ? 0.75 : m < 8 ? 5 : 2),
        );
  return {
    id: `demo-${i}`,
    member_id: `member-${member}`,
    display_name: names[member],
    model_id: model,
    model_display:
      model === 'gemini-3.8-flash-high'
        ? 'Gemini 3.8 Flash (High)'
        : model === 'claude-opus-5-5'
          ? 'Claude Opus 5.5'
          : model === 'unknown'
            ? '未识别模型'
            : 'Gemini 4 Argon',
    source: i % 3 === 0 ? 'antigravity_cli' : 'antigravity_ide',
    occurred_at_ms: Date.parse(`${today}T04:00:00Z`) - age * day + (i % 10) * 600000,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: read,
    cache_write_tokens: write,
    total_tokens: input + output + read + write,
    cost_micro_usd: price,
    pricing_status: price === null ? 'unpriced' : 'priced',
    catalog_version: price === null ? null : '演示目录',
  };
});
export const demoRules: Rule[] = [
  {
    id: 'demo-rule',
    scope: 'member',
    member_id: null,
    metric: 'tokens',
    period: 'day',
    threshold_value: 1000000,
    enabled: true,
  },
  {
    id: 'demo-cost',
    scope: 'family',
    member_id: null,
    metric: 'cost_micro_usd',
    period: 'week',
    threshold_value: 30000000,
    enabled: true,
  },
];
export function matches(row: Usage, filter: Filters): boolean {
  const date = new Date(row.occurred_at_ms + 8 * 3600000).toISOString().slice(0, 10);
  return (
    date >= filter.from_date &&
    date <= filter.to_date &&
    (!filter.member_id || row.member_id === filter.member_id) &&
    (!filter.model_id || row.model_id === filter.model_id) &&
    (!filter.source || row.source === filter.source)
  );
}
export function snapshot(
  filters: Filters,
  page = 1,
  options: { role?: 'admin' | 'member'; setup?: boolean } = {},
): Snapshot {
  const rows = demoRows.filter((r) => matches(r, filters));
  const todayRows = demoRows.filter(
    (r) => new Date(r.occurred_at_ms).toISOString().slice(0, 10) === today,
  );
  const members: Member[] = names.map((name, index) => ({
    id: `member-${index}`,
    email: `member${index + 1}@example.test`,
    display_name: name,
    role: index === 0 ? 'admin' : 'member',
    status: 'active',
    notifications_enabled: 1,
    online: index < 4,
    device_count: 1,
    today: total(todayRows.filter((r) => r.member_id === `member-${index}`)),
    week: total(
      demoRows.filter((r) => r.member_id === `member-${index}` && r.occurred_at_ms >= weekStart),
    ),
    month: total(
      demoRows.filter((r) => r.member_id === `member-${index}` && r.occurred_at_ms >= monthStart),
    ),
    last_report_ms: index >= 4 ? now - 2 * 3600000 : now - (index + 1) * 30000,
  }));
  const models = [...new Set(rows.map((r) => `${r.model_id}|${r.member_id}`))].map((key) => {
    const [model_id, member_id] = key.split('|');
    return {
      ...total(rows.filter((r) => r.model_id === model_id && r.member_id === member_id)),
      model_id,
      member_id,
    };
  });
  const trends = [
    ...new Set(
      rows.map((r) => new Date(r.occurred_at_ms + 8 * 3600000).toISOString().slice(0, 10)),
    ),
  ]
    .sort()
    .map((date) => ({
      date,
      ...total(
        rows.filter(
          (r) => new Date(r.occurred_at_ms + 8 * 3600000).toISOString().slice(0, 10) === date,
        ),
      ),
    }));
  const result: AdminSnapshot = {
    me: { ...members[0], email: members[0].email!, notifications_enabled: 1 },
    monitor: {
      collection_active: true,
      ready: true,
      expected_members: 6,
      bound_members: 6,
      total_members: 6,
      online_members: 4,
      alerts: [],
    },
    summary: {
      today: total(todayRows),
      week: total(demoRows.filter((r) => r.occurred_at_ms >= weekStart)),
      month: total(demoRows.filter((r) => r.occurred_at_ms >= monthStart)),
      selected: total(rows),
      last_report_ms: now - 60000,
      timezone: 'Asia/Shanghai',
    },
    members,
    usage: {
      items: [...rows]
        .sort((a, b) => b.occurred_at_ms - a.occurred_at_ms)
        .slice((page - 1) * 15, page * 15),
      total: rows.length,
      page,
      page_size: 15,
    },
    models,
    trends,
    alerts: [
      {
        id: 'demo-alert',
        rule_id: 'demo-rule',
        member_id: 'member-0',
        display_name: names[0],
        message: '林亦安的每日 Token 已达到预警阈值',
        value: 1230000,
        threshold_value: 1000000,
        created_at_ms: now - 35 * 60000,
        acknowledged: 0,
      },
      {
        id: 'demo-alert-2',
        rule_id: 'demo-rule',
        member_id: 'member-2',
        display_name: names[2],
        message: '陈沐的每日 Token 已达到预警阈值',
        value: 1040000,
        threshold_value: 1000000,
        created_at_ms: now - day - 600000,
        acknowledged: 1,
      },
    ],
    rules: demoRules.map((r) => ({ ...r })),
    settings: {
      collection: {
        config: { enabled: true, interval_seconds: 300 },
        devices: members.map((m) => ({
          id: `device-${m.id}`,
          device_label: `${m.display_name}的 Windows PC`,
          display_name: m.display_name,
          supported: true,
          online: m.online,
          last_scan_at_ms: m.last_report_ms,
          effective_enabled: true,
          effective_interval_seconds: 300,
          pending_events: 0,
          last_request: null,
        })),
      },
      timezone: 'Asia/Shanghai',
      notifications_enabled: true,
      prices: [],
      devices: members.map((m) => ({
        id: `device-${m.id}`,
        member_id: m.id,
        device_label: `${m.display_name}的 Windows PC`,
        display_name: m.display_name,
        last_seen_at_ms: m.last_report_ms,
        revoked_at_ms: null,
      })),
      monitor: {
        collection_active: true,
        config: {
          enabled: true,
          expected_members: 6,
          idle_minutes: 30,
          grace_minutes: 10,
          cooldown_minutes: 360,
          gap_percent: 30,
          min_gap_micro_usd: 5000000,
          min_drop_ppm: 5000,
          calibration_samples: 6,
          capacities: {
            'gemini-5h': 200000000,
            'gemini-weekly': 800000000,
            '3p-5h': 50000000,
            '3p-weekly': 100000000,
          },
        },
        shared_pool: true,
        ready: true,
        bound_members: 6,
        total_members: 6,
        online_members: 4,
        armed_at_ms: now - day,
        buckets: [
          ['gemini-5h', 'Gemini · 5 小时', 200000000],
          ['gemini-weekly', 'Gemini · 每周', 800000000],
          ['3p-5h', 'Claude / 第三方 · 5 小时', 50000000],
          ['3p-weekly', 'Claude / 第三方 · 每周', 100000000],
        ].map(([id, name, capacity], i) => ({
          id: String(id),
          name: String(name),
          capacity_micro_usd: Number(capacity) * 0.97,
          initial_capacity_micro_usd: Number(capacity),
          samples: 8 + i,
          calibrated: true,
          latest: {
            remaining_ppm: 750000 - i * 100000,
            observed_at_ms: now - 60000,
            reset_at_ms: now + day,
          },
        })),
        alerts: [],
        email: { configured: false, addresses: null, delivery: [] },
      },
    },
  };
  if (options.setup) {
    result.members = result.members.slice(0, 1);
    result.settings.devices = [];
    result.settings.collection.devices = [];
    Object.assign(result.settings.monitor, {
      ready: false,
      bound_members: 0,
      total_members: 1,
      online_members: 0,
    });
    for (const bucket of result.settings.monitor.buckets) {
      bucket.samples = 0;
      bucket.calibrated = false;
      bucket.capacity_micro_usd = bucket.initial_capacity_micro_usd;
      bucket.latest = null;
    }
  }
  result.monitor = overview(result.settings.monitor);
  if (options.role === 'member') {
    const member = members[1];
    return {
      ...result,
      me: { ...member, email: member.email!, notifications_enabled: 1 },
      settings: null,
      rules: [],
      members: members.map((m) => ({ ...m, email: null, notifications_enabled: undefined })),
    };
  }
  return result;
}
