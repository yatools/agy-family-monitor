import { hash } from './auth';
import { periodStart, timezone } from './time';
type Rule = {
  id: string;
  scope: string;
  member_id: string | null;
  metric: string;
  period: string;
  threshold_value: number;
};
type Aggregate = { member_id: string; tokens: number; cost: number };
export async function evaluateAlerts(db: D1Database, now = Date.now()): Promise<void> {
  const [rules, members, tz] = await Promise.all([
    db.prepare('SELECT * FROM alert_rules WHERE enabled=1').all<Rule>(),
    db
      .prepare("SELECT id,display_name FROM members WHERE status='active'")
      .all<{ id: string; display_name: string }>(),
    timezone(db),
  ]);
  if (!rules.results.length) return;
  const periods = [...new Set(rules.results.map((r) => r.period))];
  const starts = new Map(periods.map((period) => [period, periodStart(now, period, tz)]));
  // A bounded set of calendar-period rollups replaces one query per rule/member.
  const rollups = await db.batch<Aggregate>(
    periods.map((period) =>
      db
        .prepare(
          'SELECT member_id,SUM(total_tokens) AS tokens,COALESCE(SUM(cost_micro_usd),0) AS cost FROM usage_events WHERE occurred_at_ms>=? AND occurred_at_ms<=? GROUP BY member_id',
        )
        .bind(starts.get(period)!, now),
    ),
  );
  const statements: D1PreparedStatement[] = [];
  for (const rule of rules.results) {
    const subjects =
      rule.scope === 'family'
        ? [{ id: 'family', display_name: '全家庭' }]
        : members.results.filter((m) => !rule.member_id || m.id === rule.member_id);
    const rows = rollups[periods.indexOf(rule.period)].results;
    for (const subject of subjects) {
      const start = starts.get(rule.period)!;
      const relevant =
        rule.scope === 'family' ? rows : rows.filter((r) => r.member_id === subject.id);
      const value = relevant.reduce(
        (sum, r) => sum + (rule.metric === 'tokens' ? r.tokens : r.cost),
        0,
      );
      if (value < rule.threshold_value) continue;
      const id = await hash(`${rule.id}:${subject.id}:${start}`);
      const member = rule.scope === 'family' ? null : subject.id;
      const message = `${subject.display_name}的${rule.period === 'day' ? '每日' : rule.period === 'week' ? '每周' : rule.period === 'month' ? '每月' : '24 小时'}${rule.metric === 'tokens' ? ' Token' : '估算费用'}达到预警阈值`;
      const suppression = rule.period === 'rolling_24h' ? now - 86400000 : start;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO alert_notifications(id,rule_id,member_id,message,value,threshold_value,period_start_ms,created_at_ms) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM alert_notifications WHERE rule_id=? AND member_id IS ? AND created_at_ms>=?)`,
          )
          .bind(
            id,
            rule.id,
            member,
            message,
            value,
            rule.threshold_value,
            start,
            now,
            rule.id,
            member,
            suppression,
          ),
      );
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO alert_state SELECT ?,?,?,id FROM alert_notifications WHERE id=?',
          )
          .bind(rule.id, subject.id, start, id),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
}
