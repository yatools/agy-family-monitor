import { z } from 'zod';
import { hash } from './auth';
import type { Env } from './types';
const addressSchema = z.strictObject({ from: z.email(), to: z.email() });
export async function emailConfig(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='monitor_email'")
    .first<{ value: string }>();
  if (!row) return null;
  const parsed = addressSchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : null;
}
export async function enqueueEmail(
  db: D1Database,
  id: string,
  alertId: string | null,
  subject: string,
  body: string,
  now: number,
) {
  await emailStatement(db, id, alertId, subject, body, now).run();
}
export function emailStatement(
  db: D1Database,
  id: string,
  alertId: string | null,
  subject: string,
  body: string,
  now: number,
) {
  return db
    .prepare(
      'INSERT OR IGNORE INTO email_outbox(id,alert_id,subject,body,available_at_ms,created_at_ms) VALUES(?,?,?,?,?,?)',
    )
    .bind(id, alertId, subject, body, now, now);
}
type Outgoing = { id: string; subject: string; body: string; attempts: number };
const providerCodes = new Set([
  'E_HEADER_NOT_ALLOWED',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_ACCOUNT_SUSPENDED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_INTERNAL_SERVER_ERROR',
]);
export async function flushEmails(env: Env, now = Date.now(), onlyId?: string) {
  const addresses = await emailConfig(env.DB);
  if (!addresses || !env.ALERT_EMAIL) return { sent: 0, configured: false };
  const token = crypto.randomUUID();
  // Claim a whole digest atomically. Parallel cron/admin calls cannot send the same rows.
  const claimed = await env.DB.prepare(
    `UPDATE email_outbox SET status='sending',lease_token=?,lease_until_ms=? WHERE id IN (
    SELECT id FROM email_outbox WHERE status IN ('pending','sending') AND available_at_ms<=? AND lease_until_ms<=? AND attempts<8 AND (alert_id IS NULL OR EXISTS(SELECT 1 FROM monitor_alerts a WHERE a.id=email_outbox.alert_id AND a.resolved_at_ms IS NULL)) ${onlyId ? 'AND id=?' : ''} ORDER BY created_at_ms,id LIMIT 10
  ) RETURNING id,subject,body,attempts`,
  )
    .bind(token, now + 600000, now, now, ...(onlyId ? [onlyId] : []))
    .all<Outgoing>();
  const rows = claimed.results;
  if (!rows.length) return { sent: 0, configured: true };
  const key = await hash(
    rows
      .map((r) => r.id)
      .sort()
      .join(':'),
  );
  try {
    const result = await env.ALERT_EMAIL.send({
      from: addresses.from,
      to: addresses.to,
      subject: rows.length === 1 ? rows[0].subject : `[Agy] ${rows.length} 项用量异常提醒`,
      text: rows.map((r) => `${r.subject}\n${r.body}`).join('\n\n────────\n\n'),
      headers: { 'X-Agy-Message-Key': key, 'Auto-Submitted': 'auto-generated' },
    });
    await env.DB.prepare(
      "UPDATE email_outbox SET status='sent',sent_at_ms=?,message_id=?,last_error=NULL,lease_until_ms=0 WHERE lease_token=?",
    )
      .bind(now, result?.messageId ?? key, token)
      .run();
    return { sent: rows.length, configured: true };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    // Store only known provider codes, never exception messages or account details.
    const reason = typeof code === 'string' && providerCodes.has(code) ? code : 'email_send_failed';
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          "UPDATE email_outbox SET attempts=attempts+1,status=CASE WHEN attempts+1>=8 THEN 'failed' ELSE 'pending' END,available_at_ms=?,lease_until_ms=0,last_error=? WHERE id=? AND lease_token=?",
        ).bind(now + Math.min(21600000, 300000 * 2 ** row.attempts), reason, row.id, token),
      ),
    );
    return { sent: 0, configured: true };
  }
}
