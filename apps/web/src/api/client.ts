import type { Filters, Snapshot } from './types';
export class ApiError extends Error {
  constructor(public status: number) {
    super(
      status === 401
        ? '请先登录以查看家庭数据'
        : status === 403
          ? '当前账号没有此操作权限'
          : status === 409
            ? '记录已存在，或已达到家庭人数上限'
            : status === 503
              ? '服务尚未配置完成'
              : status === 400
                ? '请检查输入内容和日期范围'
                : '暂时无法连接服务，请稍后重试',
    );
  }
}
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/dashboard${path}`, {
    method,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.type === 'opaqueredirect' || response.status === 302 || response.status === 301)
    throw new ApiError(401);
  if (!response.ok) throw new ApiError(response.status);
  return response.json() as Promise<T>;
}
export async function load(filters: Filters, page = 1): Promise<Snapshot> {
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  const [me, summary, members, usage, models, trends, alerts, rules, settings] = await Promise.all([
    request<{ member: Snapshot['me'] }>('/me'),
    request<Snapshot['summary']>(`/summary?${query}`),
    request<{ items: Snapshot['members'] }>('/members'),
    request<Snapshot['usage']>(`/usage?${query}&page=${page}&page_size=15`),
    request<{ items: Snapshot['models'] }>(`/models?${query}`),
    request<{ items: Snapshot['trends'] }>(`/trends?${query}`),
    request<{ items: Snapshot['alerts'] }>('/alerts'),
    request<{ items: Snapshot['rules'] }>('/rules'),
    request<Snapshot['settings']>('/settings'),
  ]);
  return {
    me: me.member,
    summary,
    members: members.items,
    usage,
    models: models.items,
    trends: trends.items,
    alerts: alerts.items,
    rules: rules.items,
    settings,
  };
}
