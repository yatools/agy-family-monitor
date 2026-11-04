export type Member = {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  status: string;
  notifications_enabled: number;
};
export type Device = { id: string; member_id: string };
export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALERT_EMAIL?: {
    send(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
      headers?: Record<string, string>;
    }): Promise<{ messageId?: string } | void>;
  };
};
export type AppEnv = { Bindings: Env; Variables: { member: Member; device: Device } };
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
