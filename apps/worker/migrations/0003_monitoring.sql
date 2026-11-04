ALTER TABLE devices ADD COLUMN last_heartbeat_at_ms INTEGER;
ALTER TABLE devices ADD COLUMN collector_json TEXT;
ALTER TABLE devices ADD COLUMN pending_events INTEGER NOT NULL DEFAULT 0;
CREATE TABLE device_quota(device_id TEXT NOT NULL REFERENCES devices(id),bucket_id TEXT NOT NULL,remaining_ppm INTEGER NOT NULL CHECK(remaining_ppm BETWEEN 0 AND 1000000),reset_at_ms INTEGER NOT NULL,observed_at_ms INTEGER NOT NULL,received_at_ms INTEGER NOT NULL,PRIMARY KEY(device_id,bucket_id));
CREATE INDEX device_quota_observed ON device_quota(observed_at_ms);
CREATE TABLE monitor_runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE monitor_lock(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,until_ms INTEGER NOT NULL);
INSERT INTO monitor_lock VALUES(1,'',0);
CREATE TABLE quota_intervals(id TEXT PRIMARY KEY,bucket_id TEXT NOT NULL,device_id TEXT NOT NULL,started_at_ms INTEGER NOT NULL,ended_at_ms INTEGER NOT NULL,drop_ppm INTEGER NOT NULL,reset_at_ms INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',observed_micro_usd INTEGER,expected_micro_usd INTEGER,gap_micro_usd INTEGER,reason TEXT);
CREATE INDEX quota_intervals_pending ON quota_intervals(status,ended_at_ms);
CREATE TABLE quota_calibration(interval_id TEXT PRIMARY KEY REFERENCES quota_intervals(id),bucket_id TEXT NOT NULL,capacity_micro_usd INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
CREATE INDEX quota_calibration_bucket ON quota_calibration(bucket_id,created_at_ms);
CREATE TABLE monitor_conditions(key TEXT PRIMARY KEY,first_bad_at_ms INTEGER NOT NULL,bad_count INTEGER NOT NULL);
CREATE TABLE monitor_alerts(id TEXT PRIMARY KEY,condition_key TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,details_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,last_seen_at_ms INTEGER NOT NULL,resolved_at_ms INTEGER);
CREATE INDEX monitor_alerts_time ON monitor_alerts(created_at_ms);
CREATE TABLE email_outbox(id TEXT PRIMARY KEY,alert_id TEXT REFERENCES monitor_alerts(id),subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at_ms INTEGER NOT NULL,lease_until_ms INTEGER NOT NULL DEFAULT 0,lease_token TEXT,created_at_ms INTEGER NOT NULL,sent_at_ms INTEGER,message_id TEXT,last_error TEXT);
CREATE INDEX email_outbox_pending ON email_outbox(status,available_at_ms);
INSERT INTO settings VALUES('monitor_config','{"enabled":true,"expected_members":6,"idle_minutes":30,"grace_minutes":10,"cooldown_minutes":360,"gap_percent":30,"min_gap_micro_usd":5000000,"min_drop_ppm":5000,"calibration_samples":6,"capacities":{"gemini-5h":200000000,"gemini-weekly":800000000,"3p-5h":50000000,"3p-weekly":100000000}}');

