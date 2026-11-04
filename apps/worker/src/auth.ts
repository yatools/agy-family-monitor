import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './types';
const keysets = new Map<string, JWTVerifyGetKey>();
export async function accessEmail(
  token: string,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>,
  resolver?: JWTVerifyGetKey,
): Promise<string> {
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !env.ACCESS_AUD)
    throw new Error('access_configuration_missing');
  if (!resolver) {
    if (!keysets.has(domain))
      keysets.set(domain, createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`)));
    resolver = keysets.get(domain)!;
  }
  const { payload } = await jwtVerify(token, resolver, {
    issuer: `https://${domain}`,
    audience: env.ACCESS_AUD,
    algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'sub', 'email'],
  });
  if (typeof payload.email !== 'string') throw new Error('invalid_identity');
  return payload.email.toLowerCase();
}
export async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
