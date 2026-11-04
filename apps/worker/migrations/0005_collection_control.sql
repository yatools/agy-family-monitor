INSERT INTO settings(key,value) VALUES('collection_config','{"enabled":true,"interval_seconds":300}');
CREATE TABLE collection_requests(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','failed','expired')),requested_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,acknowledged_at_ms INTEGER);
CREATE UNIQUE INDEX collection_pending_device ON collection_requests(device_id) WHERE status='pending';
CREATE INDEX collection_requests_time ON collection_requests(requested_at_ms);
