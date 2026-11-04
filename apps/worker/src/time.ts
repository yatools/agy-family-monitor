export function dateKey(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function midnight(date: string, timezone: string): number {
  const desired = Date.parse(`${date}T00:00:00Z`);
  let candidate = desired;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate);
    const get = (type: string) => p.find((v) => v.type === type)!.value;
    const actual = Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
    );
    const delta = desired - actual;
    candidate += delta;
    if (delta === 0) break;
  }
  return candidate;
}
export function periodStart(now: number, period: string, timezone: string): number {
  if (period === 'rolling_24h') return now - 86400000;
  let date = dateKey(now, timezone);
  if (period === 'month') date = `${date.slice(0, 7)}-01`;
  if (period === 'week') {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    date = day.toISOString().slice(0, 10);
  }
  return midnight(date, timezone);
}
export async function timezone(db: D1Database): Promise<string> {
  return (
    (await db.prepare("SELECT value FROM settings WHERE key='timezone'").first<{ value: string }>())
      ?.value ?? 'Asia/Shanghai'
  );
}
