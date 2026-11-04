// Run with Node 24+ (or Node 22.13+). Only restores to an isolated in-memory DB.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const [path, expectedPath] = process.argv.slice(2);
if (!path)
  throw new Error('Usage: node scripts/verify-backup.mjs <export.sql> [expected-counts.json]');
const sql = readFileSync(path);
const sha256 = createHash('sha256').update(sql).digest('hex');
assert.equal(sha256, readFileSync(path + '.sha256', 'utf8').trim(), 'Backup checksum mismatch');
const db = new DatabaseSync(':memory:');
try {
  db.exec(sql.toString('utf8'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const tables = [
    'members',
    'devices',
    'usage_events',
    'model_prices',
    'alert_rules',
    'alert_notifications',
    'device_quota',
    'quota_intervals',
    'quota_calibration',
    'monitor_alerts',
    'email_outbox',
  ].filter((table) =>
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
  const counts = Object.fromEntries(
    tables.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]),
  );
  if (expectedPath) assert.deepEqual(counts, JSON.parse(readFileSync(expectedPath, 'utf8')));
  const report = {
    sha256,
    integrity: 'ok',
    foreign_keys: 'ok',
    counts,
    expected_counts_match: expectedPath ? true : null,
  };
  writeFileSync(path + '.verified.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
