import { z } from 'zod';
export const collectionSchema = z.strictObject({
  enabled: z.boolean(),
  interval_seconds: z.int().min(60).max(3600),
});
export type CollectionConfig = z.infer<typeof collectionSchema>;
export async function collectionConfig(db: D1Database): Promise<CollectionConfig> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='collection_config'")
    .first<{ value: string }>();
  return row
    ? collectionSchema.parse(JSON.parse(row.value))
    : { enabled: true, interval_seconds: 300 };
}
export function supportsControl(version: string | null) {
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '');
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 3);
}
export async function collectionStatus(db: D1Database) {
  const [config, devices] = await Promise.all([
    collectionConfig(db),
    db
      .prepare(
        "SELECT d.id,d.device_label,d.agent_version,d.last_heartbeat_at_ms,d.collector_json,d.pending_events,m.display_name,(SELECT json_object('id',r.id,'status',CASE WHEN r.status='pending' AND r.expires_at_ms<=? THEN 'expired' ELSE r.status END,'requested_at_ms',r.requested_at_ms,'acknowledged_at_ms',r.acknowledged_at_ms) FROM collection_requests r WHERE r.device_id=d.id ORDER BY r.requested_at_ms DESC,r.rowid DESC LIMIT 1) AS last_request_json FROM devices d JOIN members m ON m.id=d.member_id WHERE d.revoked_at_ms IS NULL AND m.status='active' ORDER BY d.created_at_ms",
      )
      .bind(Date.now())
      .all<{
        id: string;
        device_label: string;
        agent_version: string | null;
        last_heartbeat_at_ms: number | null;
        collector_json: string | null;
        pending_events: number;
        display_name: string;
        last_request_json: string | null;
      }>(),
  ]);
  return {
    config,
    devices: devices.results.map((d) => {
      const c = d.collector_json ? JSON.parse(d.collector_json) : null;
      return {
        id: d.id,
        device_label: d.device_label,
        display_name: d.display_name,
        supported: supportsControl(d.agent_version),
        online: d.last_heartbeat_at_ms != null && d.last_heartbeat_at_ms > Date.now() - 180000,
        last_scan_at_ms: c?.last_scan_at_ms ?? null,
        effective_enabled: c?.collection_enabled ?? null,
        effective_interval_seconds: c?.collection_interval_seconds ?? null,
        pending_events: d.pending_events,
        last_request: d.last_request_json ? JSON.parse(d.last_request_json) : null,
      };
    }),
  };
}
