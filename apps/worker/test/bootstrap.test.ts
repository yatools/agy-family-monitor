import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
const app = createApp();

describe('P0 bootstrap', () => {
  it('serves health without disclosing configuration', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'agy-family-monitor',
      stage: 'P3',
      status: 'ok',
    });
  });
  it('keeps unimplemented business APIs closed', async () => {
    expect((await app.request('/api/v1/agent/events', { method: 'POST' })).status).toBe(503);
  });
});
