import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, ApiError } from '../src/api/client';
import { total, demoRows, snapshot } from '../src/api/demo';
afterEach(() => vi.unstubAllGlobals());
describe('dashboard access handling', () => {
  it('handles Access redirects as a login requirement without parsing HTML', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ type: 'opaqueredirect', status: 0, json }));
    await expect(request('/me')).rejects.toMatchObject({ status: 401 });
    expect(json).not.toHaveBeenCalled();
  });
  it('does not replace permission failures with synthetic user data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 403, ok: false });
    vi.stubGlobal('fetch', fetcher);
    await expect(request('/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends same-origin requests and handles JSON success', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      type: 'basic',
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await request('/preferences', 'PUT', { notifications_enabled: false })).toEqual({
      success: true,
    });
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'same-origin',
      redirect: 'manual',
      method: 'PUT',
    });
  });
});
describe('cost and filter presentation contract', () => {
  it('distinguishes no usage from unknown prices and keeps unpriced tokens visible', () => {
    expect(total([]).cost_micro_usd).toBe(0);
    const row = { ...demoRows[0], pricing_status: 'unpriced', cost_micro_usd: null };
    expect(total([row]).cost_micro_usd).toBeNull();
    expect(total([row]).unpriced_tokens).toBe(row.total_tokens);
  });
  it('shows all six members and honors combined date/member/model/source filters', () => {
    const row = demoRows[0];
    const day = new Date(row.occurred_at_ms + 28800000).toISOString().slice(0, 10);
    const data = snapshot({
      from_date: day,
      to_date: day,
      member_id: row.member_id,
      model_id: row.model_id,
      source: row.source,
    });
    expect(data.members).toHaveLength(6);
    expect(data.usage.total).toBeGreaterThan(0);
    expect(
      data.usage.items.every(
        (r) =>
          r.member_id === row.member_id && r.model_id === row.model_id && r.source === row.source,
      ),
    ).toBe(true);
  });
});
