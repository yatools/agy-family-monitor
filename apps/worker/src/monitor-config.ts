import { z } from 'zod';
export const bucketIds = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'] as const;
export type BucketId = (typeof bucketIds)[number];
export const bucketNames: Record<BucketId, string> = {
  'gemini-5h': 'Gemini · 5 小时',
  'gemini-weekly': 'Gemini · 每周',
  '3p-5h': 'Claude / 第三方 · 5 小时',
  '3p-weekly': 'Claude / 第三方 · 每周',
};
export const monitorConfigSchema = z.strictObject({
  enabled: z.boolean(),
  expected_members: z.int().min(1).max(6),
  idle_minutes: z.int().min(15).max(1440),
  grace_minutes: z.int().min(5).max(60),
  cooldown_minutes: z.int().min(60).max(1440),
  gap_percent: z.int().min(10).max(90),
  min_gap_micro_usd: z.int().min(100000).max(10000000000),
  min_drop_ppm: z.int().min(1000).max(100000),
  calibration_samples: z.int().min(3).max(30),
  capacities: z.strictObject({
    'gemini-5h': z.int().min(1000000).max(10000000000),
    'gemini-weekly': z.int().min(1000000).max(10000000000),
    '3p-5h': z.int().min(1000000).max(10000000000),
    '3p-weekly': z.int().min(1000000).max(10000000000),
  }),
});
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;
export const defaultMonitorConfig: MonitorConfig = {
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
};
export async function monitorConfig(db: D1Database): Promise<MonitorConfig> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='monitor_config'")
    .first<{ value: string }>();
  return row
    ? monitorConfigSchema.parse(JSON.parse(row.value))
    : structuredClone(defaultMonitorConfig);
}
export function isOnline(
  device: {
    last_heartbeat_at_ms?: number | null;
    last_seen_at_ms?: number | null;
    agent_version?: string | null;
  },
  now: number,
) {
  const at = device.last_heartbeat_at_ms ?? device.last_seen_at_ms;
  const ttl = device.agent_version?.startsWith('0.1.') ? 600000 : 180000;
  return at != null && at <= now + 60000 && now - at < ttl;
}
