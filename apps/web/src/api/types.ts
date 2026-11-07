export type Totals = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro_usd: number | null;
  unpriced_tokens: number;
  events: number;
};
export type Member = {
  id: string;
  email: string | null;
  display_name: string;
  role: 'admin' | 'member';
  status: string;
  notifications_enabled?: number;
  today: Totals;
  week: Totals;
  month: Totals;
  last_report_ms: number | null;
  online: boolean;
  device_count: number;
};
export type Usage = {
  id: string;
  member_id: string;
  display_name: string;
  model_id: string;
  model_display: string;
  source: string;
  occurred_at_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_micro_usd: number | null;
  pricing_status: string;
  catalog_version: string | null;
};
export type Model = Totals & { model_id: string; model_display?: string; member_id: string };
export type Alert = {
  id: string;
  rule_id: string;
  member_id: string | null;
  display_name: string | null;
  message: string;
  value: number;
  threshold_value: number;
  created_at_ms: number;
  acknowledged: number;
  metric?: 'tokens' | 'cost_micro_usd';
};
export type Rule = {
  id?: string;
  scope: 'family' | 'member';
  member_id: string | null;
  metric: 'tokens' | 'cost_micro_usd';
  period: 'day' | 'week' | 'month' | 'rolling_24h';
  threshold_value: number;
  enabled: boolean | number;
};
export type Price = {
  catalog_revision?: number;
  id: string;
  model_id: string;
  input_price: number;
  output_price: number;
  cache_read_price: number;
  cache_write_price: number;
  effective_from: number;
  catalog_version: string;
  source: string;
};
export type Device = {
  id: string;
  member_id: string;
  device_label: string;
  display_name: string;
  last_seen_at_ms: number | null;
  revoked_at_ms: number | null;
  last_heartbeat_at_ms?: number | null;
  agent_version?: string | null;
  pending_events?: number;
};
export type MonitorConfig = {
  enabled: boolean;
  expected_members: number;
  idle_minutes: number;
  grace_minutes: number;
  cooldown_minutes: number;
  gap_percent: number;
  min_gap_micro_usd: number;
  min_drop_ppm: number;
  calibration_samples: number;
  capacities: Record<string, number>;
};
export type MonitorAlert = {
  id: string;
  kind: string;
  message: string;
  details_json: string;
  created_at_ms: number;
  last_seen_at_ms: number;
  resolved_at_ms: number | null;
};
export type MonitorStatus = {
  collection_active: boolean;
  config: MonitorConfig;
  shared_pool: boolean;
  ready: boolean;
  bound_members: number;
  total_members: number;
  online_members: number;
  armed_at_ms: number | null;
  buckets: {
    id: string;
    name: string;
    capacity_micro_usd: number;
    initial_capacity_micro_usd: number;
    samples: number;
    calibrated: boolean;
    latest: { remaining_ppm: number; observed_at_ms: number; reset_at_ms: number } | null;
  }[];
  alerts: MonitorAlert[];
  email: {
    configured: boolean;
    addresses?: { from: string; to: string } | null;
    delivery?: { status: string; count: number; last_sent_at_ms: number | null }[];
  };
};
export type Filters = {
  from_date: string;
  to_date: string;
  member_id: string;
  model_id: string;
  source: string;
};
export type MonitorOverview = Pick<
  MonitorStatus,
  'ready' | 'bound_members' | 'total_members' | 'online_members' | 'alerts' | 'collection_active'
> & { expected_members: number };
export type Snapshot = {
  me: {
    id: string;
    email: string;
    display_name: string;
    role: 'admin' | 'member';
    notifications_enabled: number;
  };
  summary: {
    today: Totals;
    week: Totals;
    month: Totals;
    selected: Totals;
    last_report_ms: number | null;
    timezone: string;
  };
  members: Member[];
  usage: { items: Usage[]; total: number; page: number; page_size: number };
  models: Model[];
  trends: {
    date: string;
    total_tokens: number;
    cost_micro_usd: number | null;
    unpriced_tokens: number;
  }[];
  alerts: Alert[];
  rules: Rule[];
  monitor: MonitorOverview;
  settings: {
    collection: CollectionStatus;
    timezone: string;
    notifications_enabled: boolean;
    prices: Price[];
    devices: Device[];
    monitor: MonitorStatus;
  } | null;
};
export type AdminSnapshot = Snapshot & { settings: NonNullable<Snapshot['settings']> };
export type CollectionConfig = { enabled: boolean; interval_seconds: number };
export type CollectionStatus = {
  config: CollectionConfig;
  devices: {
    id: string;
    device_label: string;
    display_name: string;
    supported: boolean;
    online: boolean;
    last_scan_at_ms: number | null;
    effective_enabled: boolean | null;
    effective_interval_seconds: number | null;
    pending_events: number;
    last_request: {
      id: string;
      status: 'pending' | 'completed' | 'failed' | 'expired';
      requested_at_ms: number;
      acknowledged_at_ms: number | null;
    } | null;
  }[];
};
