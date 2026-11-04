import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { JWTVerifyGetKey } from 'jose';
import { accessEmail } from './auth';
import { agent } from './agent';
import { dashboard } from './dashboard';
import { evaluateAlerts } from './alerts';
import { evaluateMonitor } from './monitor';
import type { AppEnv, Member } from './types';

export function createApp(resolver?: JWTVerifyGetKey) {
  const app = new Hono<AppEnv>();
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.get('/api/health', (c) =>
    c.json({ service: 'agy-family-monitor', stage: 'P3', status: 'ok' }),
  );
  app.use('/api/v1/*', async (c, next) => {
    if (!c.env?.DB) return c.json({ error: 'database_not_configured' }, 503);
    await next();
  });
  app.use('/api/v1/dashboard/*', async (c, next) => {
    if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD)
      return c.json({ error: 'access_not_configured' }, 503);
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) return c.json({ error: 'access_unauthorized' }, 401);
    let email: string;
    try {
      email = await accessEmail(token, c.env, resolver);
    } catch {
      return c.json({ error: 'access_unauthorized' }, 401);
    }
    const member = await c.env.DB.prepare(
      "SELECT id,email,display_name,role,status,notifications_enabled FROM members WHERE email=? COLLATE NOCASE AND status='active'",
    )
      .bind(email)
      .first<Member>();
    if (!member) return c.json({ error: 'not_a_member' }, 403);
    if (member.role !== 'admin') {
      const viewPaths = new Set([
        '/me',
        '/summary',
        '/members',
        '/usage',
        '/models',
        '/trends',
        '/alerts',
        '/monitor/overview',
      ]);
      const path = new URL(c.req.url).pathname.slice('/api/v1/dashboard'.length);
      if (!['GET', 'HEAD'].includes(c.req.method) || !viewPaths.has(path))
        return c.json({ error: 'read_only_member' }, 403);
    }
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = c.req.header('Origin');
      if (
        (origin && origin !== new URL(c.req.url).origin) ||
        c.req.header('Sec-Fetch-Site') === 'cross-site'
      )
        return c.json({ error: 'invalid_origin' }, 403);
    }
    c.set('member', member);
    await next();
  });
  app.route('/api/v1/agent', agent);
  app.route('/api/v1/dashboard', dashboard);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
  app.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: 'invalid_request' }, 400);
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error.message.includes('UNIQUE constraint')) return c.json({ error: 'conflict' }, 409);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
const app = createApp();
export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: AppEnv['Bindings']) => {
    // Separate invocations keep each job below the Workers Free D1 query budget.
    if (event.cron === '2-59/5 * * * *') await evaluateMonitor(env);
    else await evaluateAlerts(env.DB);
  },
};
